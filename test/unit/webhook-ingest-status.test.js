'use strict';

// The public ingest route advertises `response: { 202: { ok: boolean } }` in
// its Fastify schema — the contract third-party senders see in /docs — but
// the handler returned the implicit 200. The handler now answers 202
// Accepted to match the declared schema (and the "accepted into your
// mailbox" semantics); nothing in-repo consumed the ingest status.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const webhookInboxRoutes = require('../../src/routes/webhook-inbox');

function makeStore() {
    return {
        maxPerUser: 5,
        list: () => [],
        create: () => ({ id: 'ib1', token: 'tok', label: 'Monitor', createdAt: 1, lastUsedAt: null }),
        revoke: () => true,
        verify: ({ token }) => (token === 'goodtok'
            ? { ok: true, id: 'ib1', label: 'Monitor', user: 't@x.com', password: 'pw' }
            : { ok: false, reason: 'unknown' })
    };
}

function makePool(appendSeen) {
    const client = {
        authenticated: true,
        usable: true,
        async getMailboxLock() {
            return { release() {} };
        },
        async append(mailbox, message) {
            appendSeen.push([mailbox, message]);
            return { uid: 1 };
        }
    };
    return {
        async acquire() { return client; },
        release() {},
        discard() {}
    };
}

async function buildApp(store, pool) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(webhookInboxRoutes, { store, pool, getPublicBaseUrl: () => 'https://mail.example' });
    return app;
}

test('ingest answers the 202 its schema declares', async () => {
    const appendSeen = [];
    const app = await buildApp(makeStore(), makePool(appendSeen));
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/webhook-inbox/goodtok',
            payload: { hello: 'world' }
        });
        assert.equal(res.statusCode, 202, 'the handler must match the advertised response schema');
        assert.deepEqual(JSON.parse(res.body), { ok: true });
        assert.equal(appendSeen.length, 1);
        assert.equal(appendSeen[0][0], 'INBOX');
    } finally {
        await app.close();
    }
});

test('ingest still refuses an unknown token with 401', async () => {
    const appendSeen = [];
    const app = await buildApp(makeStore(), makePool(appendSeen));
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/webhook-inbox/badtok',
            payload: { hello: 'world' }
        });
        assert.equal(res.statusCode, 401);
        assert.equal(appendSeen.length, 0);
    } finally {
        await app.close();
    }
});
