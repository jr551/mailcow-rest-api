'use strict';

// A page past the end of a folder is a stale cursor: the client asked for
// page 621 of a folder that no longer holds that many messages. The old
// handler ran the full UID path anyway — a SEARCH plus a lock on a
// 100k-message folder — to render nothing. EXISTS (or the search total)
// already answers it, so these tests pin the short-circuit: no SEARCH and
// no FETCH for an out-of-range page, while an in-range page still fetches
// exactly its own slice.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const messageRoutes = require('../../src/routes/messages');

function makePool({ exists = 0, searchResult = () => [] } = {}) {
    const calls = { searches: [], fetches: [] };
    const client = {
        authenticated: true,
        usable: true,
        mailbox: { exists, uidValidity: 1 },
        async getMailboxLock() { return { release() {} }; },
        async search(criteria, opts) {
            calls.searches.push({ criteria, opts });
            return searchResult(criteria);
        },
        async *fetch(uids, query, opts) {
            calls.fetches.push({ uids: Array.isArray(uids) ? uids : [uids], query, opts });
            for (const uid of (Array.isArray(uids) ? uids : [uids])) {
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

async function buildApp(pool) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, req, reply) => {
        reply.code(err.statusCode || 500).send(err.problem || { title: err.message });
    });
    app.addHook('onRequest', async (req) => { req.creds = { user: 't@x.com', pass: 'p', hash: 'h' }; });
    await app.register(messageRoutes, { pool });
    return app;
}

// UIDs as a real server reports them for SEARCH ALL: every UID, newest first.
function descendingUids(count) {
    return Array.from({ length: count }, (_, i) => count - i);
}

test('a page past EXISTS returns an empty page without searching or fetching', async () => {
    const pool = makePool({ exists: 250 });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages?page=5&pageSize=100' });
        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.messages, []);
        assert.equal(body.total, 250, 'total is the folder EXISTS the SELECT already reported');
        assert.equal(body.page, 5);
        assert.equal(pool.calls.searches.length, 0, 'a page past the end must not run SEARCH');
        assert.equal(pool.calls.fetches.length, 0, 'a page past the end must not run FETCH');
    } finally {
        await app.close();
    }
});

test('a search page past the end returns an empty page after the search', async () => {
    const pool = makePool({ exists: 3, searchResult: () => [3, 2, 1] });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages?page=1&pageSize=20&search=from%3Abob' });
        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.messages, []);
        assert.equal(body.total, 3, 'the search total is what the empty page reports');
        // A search's total is only knowable by running the search, so exactly
        // one is expected — but the FETCH that would have rendered nothing
        // must not happen.
        assert.equal(pool.calls.searches.length, 1);
        assert.equal(pool.calls.fetches.length, 0);
    } finally {
        await app.close();
    }
});

test('a page inside the range still fetches exactly its own slice', async () => {
    const pool = makePool({ exists: 250, searchResult: () => descendingUids(250) });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages?page=1&pageSize=100' });
        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);
        assert.equal(body.total, 250);
        assert.equal(pool.calls.fetches.length, 1);
        const fetched = pool.calls.fetches[0].uids;
        assert.equal(fetched.length, 100, 'exactly one page is fetched');
        // Newest-first manifest: page 1 starts at index 100, i.e. UID 150.
        assert.equal(fetched[0], 150);
        assert.equal(fetched[99], 51);
        assert.equal(body.messages.length, 100);
        assert.equal(body.messages[0].uid, 150);
    } finally {
        await app.close();
    }
});

test('page 0 of an empty folder is an empty page with no IMAP work', async () => {
    const pool = makePool({ exists: 0 });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages?page=0' });
        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.messages, []);
        assert.equal(body.total, 0);
        assert.equal(pool.calls.searches.length, 0);
        assert.equal(pool.calls.fetches.length, 0);
    } finally {
        await app.close();
    }
});
