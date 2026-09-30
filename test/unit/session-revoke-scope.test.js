'use strict';

// Regression test: `DELETE /v1/auth/session` with a Bearer token must revoke
// ONLY the presented token. The auth hook never stored the token on
// req.session (only expiresAt), so `req.session?.token` was always undefined
// and the route silently fell through to deleteSessionsByUser — a routine
// sign-out killed every session for the mailbox, contradicting the route's
// own documented contract ("Bearer authentication revokes the current
// token. Basic authentication revokes every token").

const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const { createCache } = require('../../src/cache');
const { createAuthHook } = require('../../src/auth');
const { createIpAllowHook } = require('../../src/ip-allow');
const sessionRoutes = require('../../src/routes/session');

async function buildMiniApp(cache) {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', createIpAllowHook({ allowlist: '' }));
    app.addHook('onRequest', createAuthHook({ cache, imap: {}, verifier: async () => ({ valid: true }) }));
    await app.register(sessionRoutes, { cache, imap: {}, sessionTtlMs: 60_000 });
    app.get('/v1/protected', async () => ({ ok: true }));
    return app;
}

test('Bearer sign-out revokes exactly the presented token', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 500, pruneIntervalMs: 0 });
    const app = await buildMiniApp(cache);
    try {
        const basic = 'Basic ' + Buffer.from('u@x.com:pw').toString('base64');
        const t1 = (await app.inject({ method: 'POST', url: '/v1/auth/session', headers: { authorization: basic } })).json().token;
        const t2 = (await app.inject({ method: 'POST', url: '/v1/auth/session', headers: { authorization: basic } })).json().token;

        const del = await app.inject({ method: 'DELETE', url: '/v1/auth/session', headers: { authorization: `Bearer ${t1}` } });
        assert.equal(del.statusCode, 204);

        const gone = await app.inject({ method: 'GET', url: '/v1/protected', headers: { authorization: `Bearer ${t1}` } });
        assert.equal(gone.statusCode, 401, 'the revoked token must be dead');

        const alive = await app.inject({ method: 'GET', url: '/v1/protected', headers: { authorization: `Bearer ${t2}` } });
        assert.equal(alive.statusCode, 200, 'the other session must survive a routine sign-out');
    } finally {
        await app.close();
        cache.close();
    }
});

test('Basic-authenticated DELETE still revokes every token for the mailbox', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 500, pruneIntervalMs: 0 });
    const app = await buildMiniApp(cache);
    try {
        const basic = 'Basic ' + Buffer.from('u@x.com:pw').toString('base64');
        const t1 = (await app.inject({ method: 'POST', url: '/v1/auth/session', headers: { authorization: basic } })).json().token;
        const t2 = (await app.inject({ method: 'POST', url: '/v1/auth/session', headers: { authorization: basic } })).json().token;

        const del = await app.inject({ method: 'DELETE', url: '/v1/auth/session', headers: { authorization: basic } });
        assert.equal(del.statusCode, 204);

        for (const t of [t1, t2]) {
            const res = await app.inject({ method: 'GET', url: '/v1/protected', headers: { authorization: `Bearer ${t}` } });
            assert.equal(res.statusCode, 401, 'password-change/incident response kills everything');
        }
    } finally {
        await app.close();
        cache.close();
    }
});
