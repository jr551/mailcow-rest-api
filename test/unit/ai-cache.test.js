'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiCache, stableStringify } = require('../../src/ai-cache');

const body = (content) => ({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content }],
    max_tokens: 200
});
const reply = (text) => ({ choices: [{ message: { role: 'assistant', content: text } }] });

test('ai-cache: identical requests hit, different ones miss', () => {
    const c = createAiCache({ filePath: ':memory:' });
    try {
        assert.equal(c.get('a@x.com', body('hello')), null);
        c.set('a@x.com', body('hello'), reply('hi there'));

        const hit = c.get('a@x.com', body('hello'));
        assert.equal(hit.body.choices[0].message.content, 'hi there');
        assert.equal(c.get('a@x.com', body('something else')), null);
    } finally { c.close(); }
});

test('ai-cache: one user never reads another user\'s answer', () => {
    const c = createAiCache({ filePath: ':memory:' });
    try {
        c.set('a@x.com', body('summarize my inbox'), reply('A private summary'));
        // Byte-identical request, different mailbox. The reply quotes the
        // first user's mail, so this must not be served across accounts.
        assert.equal(c.get('b@x.com', body('summarize my inbox')), null);
        assert.ok(c.get('a@x.com', body('summarize my inbox')));
    } finally { c.close(); }
});

test('ai-cache: entries expire at the TTL', () => {
    const c = createAiCache({ filePath: ':memory:', ttlMs: 1000 });
    try {
        const t0 = 1_000_000;
        c.set('a@x.com', body('q'), reply('answer'), t0);
        assert.ok(c.get('a@x.com', body('q'), t0 + 999));
        assert.equal(c.get('a@x.com', body('q'), t0 + 1001), null);
    } finally { c.close(); }
});

test('ai-cache: key ignores irrelevant fields but tracks meaningful ones', () => {
    const c = createAiCache({ filePath: ':memory:' });
    try {
        c.set('a@x.com', body('q'), reply('answer'));

        // `stream` isn't part of the answer's identity.
        assert.ok(c.get('a@x.com', { ...body('q'), stream: false }));
        // Temperature and max_tokens are.
        assert.equal(c.get('a@x.com', { ...body('q'), temperature: 0.9 }), null);
        assert.equal(c.get('a@x.com', { ...body('q'), max_tokens: 999 }), null);
    } finally { c.close(); }
});

test('ai-cache: key is independent of JSON key order', () => {
    const c = createAiCache({ filePath: ':memory:' });
    try {
        c.set('a@x.com', { model: 'm', messages: [{ role: 'user', content: 'q' }], max_tokens: 10 }, reply('a'));
        // Same request, serialized with the keys the other way round.
        const reordered = { max_tokens: 10, messages: [{ content: 'q', role: 'user' }], model: 'm' };
        assert.ok(c.get('a@x.com', reordered), 'reordered keys should still hit');
    } finally { c.close(); }
});

test('ai-cache: evicts oldest entries past maxEntries', () => {
    const c = createAiCache({ filePath: ':memory:', maxEntries: 3 });
    try {
        // Timestamps have to sit inside the TTL window, or the reads below
        // would miss because the rows expired rather than because they were
        // evicted — which is a different thing entirely.
        const t0 = Date.now();
        for (let i = 0; i < 6; i++) c.set('a@x.com', body(`q${i}`), reply(`a${i}`), t0 + i);
        assert.equal(c.count(), 3);
        // The earliest ones are the ones that went.
        assert.equal(c.get('a@x.com', body('q0'), t0 + 10), null);
        assert.ok(c.get('a@x.com', body('q5'), t0 + 10));
    } finally { c.close(); }
});

test('ai-cache: pruneExpired clears only stale rows; purgeUser scopes to one user', () => {
    const c = createAiCache({ filePath: ':memory:', ttlMs: 1000 });
    try {
        const t0 = 5_000_000;
        c.set('a@x.com', body('old'), reply('x'), t0 - 5000);
        c.set('a@x.com', body('new'), reply('y'), t0);
        c.set('b@x.com', body('theirs'), reply('z'), t0);

        assert.equal(c.pruneExpired(t0), 1);
        assert.equal(c.count(), 2);

        assert.equal(c.purgeUser('a@x.com'), 1);
        assert.ok(c.get('b@x.com', body('theirs'), t0));
    } finally { c.close(); }
});

test('ai-cache: stableStringify orders keys deterministically', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
    assert.equal(stableStringify([{ z: 1, a: 2 }]), '[{"a":2,"z":1}]');
});
