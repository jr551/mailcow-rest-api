'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { perturb, perturbMessages, sendDecoys } = require('../../src/llm-decoys');

test('perturb replaces identifying detail but keeps the shape', () => {
    const out = perturb('Hi Bartholomew, invoice 88421 for alice@acme.co is due Friday.');
    assert.equal(out.includes('alice@acme.co'), false, 'address must not survive');
    assert.equal(out.includes('88421'), false, 'number must not survive');
    assert.equal(out.includes('Bartholomew'), false, 'name must not survive');
    // Still reads like the same kind of message, so decoys aren't
    // separable from the real one by shape alone.
    assert.match(out, /@/);
    assert.match(out, /\d{5}/);
    assert.match(out, /Friday/, 'ordinary words must survive');
    assert.match(out, /^Hi /, 'greeting must survive');
});

test('perturb gives already-redacted markers a plausible value', () => {
    // Otherwise every decoy carries the same tell and is trivially
    // separable from the real request.
    const out = perturb('password is [redacted]');
    assert.equal(out.includes('[redacted]'), false);
    assert.match(out, /password is \d+/);
});

test('perturbMessages leaves non-text parts alone and does not mutate input', () => {
    const original = [
        { role: 'system', content: 'You summarise mail.' },
        { role: 'user', content: [
            { type: 'text', text: 'call Bartholomew on 07700900123' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
        ] }
    ];
    const copy = JSON.parse(JSON.stringify(original));
    const out = perturbMessages(original);

    assert.deepEqual(original, copy, 'input must not be mutated');
    assert.equal(out[1].content[1].image_url.url, 'data:image/png;base64,AAA');
    assert.equal(out[1].content[0].text.includes('07700900123'), false);
});

test('sendDecoys is a no-op unless configured, and never throws', async () => {
    const calls = [];
    const fetcher = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { body: { dump() {} } }; };
    const resolved = { apiKey: 'k', baseUrl: 'https://p.test/v1', model: 'm' };
    const body = { messages: [{ role: 'user', content: 'hello Bartholomew' }] };

    sendDecoys({ config: { ai: { decoyCount: 0 } }, resolved, body, fetcher });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 0, 'must send nothing when disabled');

    sendDecoys({ config: { ai: { decoyCount: 2 } }, resolved, body, fetcher });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 2);
    for (const c of calls) {
        assert.equal(c.model, 'm');
        assert.equal(c.stream, undefined, 'decoys must never stream');
        assert.equal(c.messages[0].content.includes('Bartholomew'), false);
    }
});

test('a failing decoy cannot surface to the caller', async () => {
    const fetcher = async () => { throw new Error('provider down'); };
    // Returns synchronously and swallows the rejection — a decoy failing
    // has no user-visible meaning.
    assert.doesNotThrow(() => sendDecoys({
        config: { ai: { decoyCount: 1 } },
        resolved: { apiKey: 'k', baseUrl: 'https://p.test/v1', model: 'm' },
        body: { messages: [{ role: 'user', content: 'hi' }] },
        fetcher
    }));
    await new Promise((r) => setTimeout(r, 20));
});
