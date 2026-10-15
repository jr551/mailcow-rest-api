'use strict';

// The UID manifest used to be all-or-nothing: any mismatch with EXISTS ran
// SEARCH ALL again, so a folder that received one message re-searched 100k
// UIDs on the next page load. The manifest is stored newest-first and keyed
// by uidvalidity, so everything above its highest UID is exactly what is
// new — a `UID <max+1>:*` search covers it. These tests pin the three
// branches (incremental, merge-mismatch fallback, expunge fallback) and the
// no-search path, plus the write-back of the merged manifest.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const messageRoutes = require('../../src/routes/messages');
const { createImapCache } = require('../../src/imap-cache');

// `searchResults` is consumed in call order: the incremental search first
// (when it runs), then the full SEARCH ALL (when it runs).
function makePool({ exists, searchResults }) {
    const calls = { searches: [], fetches: [] };
    const client = {
        authenticated: true,
        usable: true,
        mailbox: { exists, uidValidity: 1 },
        async getMailboxLock() { return { release() {} }; },
        async search(criteria, opts) {
            calls.searches.push({ criteria, opts });
            const result = searchResults[calls.searches.length - 1];
            return typeof result === 'function' ? result(criteria) : result;
        },
        async *fetch(uids, query, opts) {
            const list = Array.isArray(uids) ? uids : [uids];
            calls.fetches.push({ uids: list, query, opts });
            for (const uid of list) {
                yield {
                    uid,
                    seq: uid,
                    flags: new Set(),
                    size: 100,
                    internalDate: new Date('2026-01-01T00:00:00Z'),
                    envelope: { subject: `m${uid}`, from: [], to: [] }
                };
            }
        }
    };
    return {
        calls,
        async acquire() { return client; },
        release() {},
        discard() {}
    };
}

async function buildApp(pool, imapCache) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, req, reply) => {
        reply.code(err.statusCode || 500).send(err.problem || { title: err.message });
    });
    app.addHook('onRequest', async (req) => { req.creds = { user: 't@x.com', pass: 'p', hash: 'h' }; });
    await app.register(messageRoutes, { pool, imapCache });
    return app;
}

function withCache() {
    const cache = createImapCache({ filePath: ':memory:', pruneIntervalMs: 0 });
    return { cache, done: () => cache.close() };
}

test('a shorter cached manifest searches only the new tail and writes the merge back', async () => {
    const { cache, done } = withCache();
    cache.setUids('h', 'INBOX', 1, [10, 9, 8]);
    const pool = makePool({ exists: 5, searchResults: [[12, 11]] });
    const app = await buildApp(pool, cache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages' });
        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);

        assert.equal(pool.calls.searches.length, 1, 'no fallback search for a clean tail');
        assert.deepEqual(pool.calls.searches[0].criteria, { uid: '11:*' }, 'highest cached UID + 1');
        assert.equal(JSON.stringify(pool.calls.searches[0].criteria).includes('all'), false);

        assert.equal(body.total, 5);
        assert.deepEqual(body.messages.map((m) => m.uid), [12, 11, 10, 9, 8], 'newest first');
        assert.deepEqual(pool.calls.fetches[0].uids, [12, 11, 10, 9, 8]);

        // The merge is the new manifest — without this the next page load
        // would repeat the incremental search.
        assert.deepEqual(cache.getUids('h', 'INBOX', 1), [12, 11, 10, 9, 8]);
    } finally {
        await app.close();
        done();
    }
});

test('a merge that disagrees with EXISTS falls back to a full search', async () => {
    const { cache, done } = withCache();
    cache.setUids('h', 'INBOX', 1, [10, 9, 8]);
    // The tail search sees one new message, but EXISTS says six: something
    // was expunged below the tail, so only a full search is authoritative.
    const pool = makePool({ exists: 6, searchResults: [[12], [15, 14, 13, 12, 11, 10]] });
    const app = await buildApp(pool, cache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages' });
        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);

        assert.equal(pool.calls.searches.length, 2);
        assert.deepEqual(pool.calls.searches[0].criteria, { uid: '11:*' });
        assert.deepEqual(pool.calls.searches[1].criteria, { all: true });

        assert.equal(body.total, 6);
        assert.deepEqual(body.messages.map((m) => m.uid), [15, 14, 13, 12, 11, 10]);
        assert.deepEqual(cache.getUids('h', 'INBOX', 1), [15, 14, 13, 12, 11, 10]);
    } finally {
        await app.close();
        done();
    }
});

test('a manifest longer than EXISTS (expunges) runs the full search', async () => {
    const { cache, done } = withCache();
    cache.setUids('h', 'INBOX', 1, [10, 9, 8]);
    const pool = makePool({ exists: 2, searchResults: [[10, 9]] });
    const app = await buildApp(pool, cache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages' });
        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);

        assert.equal(pool.calls.searches.length, 1);
        assert.deepEqual(pool.calls.searches[0].criteria, { all: true });
        assert.equal(body.total, 2);
    } finally {
        await app.close();
        done();
    }
});

test('a manifest matching EXISTS is used without any search', async () => {
    const { cache, done } = withCache();
    cache.setUids('h', 'INBOX', 1, [10, 9]);
    const pool = makePool({ exists: 2, searchResults: [] });
    const app = await buildApp(pool, cache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages' });
        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);

        assert.equal(pool.calls.searches.length, 0, 'a quiet mailbox must not re-search');
        assert.equal(body.total, 2);
        assert.deepEqual(pool.calls.fetches[0].uids, [10, 9]);
    } finally {
        await app.close();
        done();
    }
});
