'use strict';

// Security hardening for the public surface (assessment 2026-11-06):
//  - the OpenAPI contract and Swagger UI are no longer anonymous;
//  - /health no longer describes the private deployment;
//  - 401 responses share one generic body, with no admin-token oracle;
//  - every response carries baseline security headers and no anonymous
//    rate-limit budget;
//  - the public telemetry sink refuses foreign browser origins.

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.RATE_LIMIT_ENABLED = 'true';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../../src/server');
const { createCache } = require('../../src/cache');

async function makeApp() {
    const cache = createCache({
        filePath: ':memory:',
        ttlValidMs: 60_000,
        ttlInvalidMs: 10_000,
        pruneIntervalMs: 0
    });
    return { app: await build({ cache, ocrCache: null }), cache };
}

test('health: liveness only, no deployment inventory', async () => {
    const { app } = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.ok, true);
        assert.equal(typeof body.version, 'string');
        for (const leaked of ['cache', 'pool', 'capabilities', 'notificationSenders', 'smsSenders']) {
            assert.equal(body[leaked], undefined, `${leaked} must not be public`);
        }
    } finally {
        await app.close();
    }
});

test('security headers are on every response, including /health', async () => {
    const { app } = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['referrer-policy'], 'no-referrer');
        assert.match(res.headers['permissions-policy'], /camera=\(\)/);
        assert.match(res.headers['content-security-policy'], /frame-ancestors 'self'/);
        assert.match(res.headers['strict-transport-security'], /max-age=31536000/);
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        // An anonymous caller must not be handed the rate-limit budget.
        assert.equal(res.headers['x-ratelimit-limit'], undefined);
        assert.equal(res.headers['x-ratelimit-remaining'], undefined);
    } finally {
        await app.close();
    }
});

test('openapi.json and the Swagger UI require authentication', async () => {
    const { app, cache } = await makeApp();
    try {
        const unauth = await app.inject({ method: 'GET', url: '/openapi.json' });
        assert.equal(unauth.statusCode, 401);
        assert.equal(JSON.parse(unauth.body).detail, 'Invalid credentials');
        assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 401);

        const { token } = cache.createSession('reader@example.com', 'mailbox-pass', 'hash');
        const ok = await app.inject({
            method: 'GET',
            url: '/openapi.json',
            headers: { authorization: `Bearer ${token}` }
        });
        assert.equal(ok.statusCode, 200);
        assert.equal(JSON.parse(ok.body).openapi, '3.1.0');
    } finally {
        await app.close();
    }
});

test('401 bodies are generic — no missing-vs-invalid oracle', async () => {
    const { app } = await makeApp();
    try {
        const missing = await app.inject({ method: 'GET', url: '/v1/mailboxes' });
        const badBearer = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes',
            headers: { authorization: 'Bearer not-a-session' }
        });
        const adminMissing = await app.inject({ method: 'GET', url: '/v1/admin/status' });
        const adminBad = await app.inject({
            method: 'GET',
            url: '/v1/admin/status',
            headers: { authorization: 'Bearer not-the-token' }
        });
        for (const res of [missing, badBearer, adminMissing, adminBad]) {
            assert.equal(res.statusCode, 401);
            assert.equal(JSON.parse(res.body).detail, 'Invalid credentials');
        }
    } finally {
        await app.close();
    }
});

test('telemetry refuses a foreign browser origin but accepts its own', async () => {
    const { app } = await makeApp();
    try {
        const foreign = await app.inject({
            method: 'POST',
            url: '/v1/telemetry/error',
            headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
            payload: { message: 'probe' }
        });
        assert.equal(foreign.statusCode, 403);

        const own = await app.inject({
            method: 'POST',
            url: '/v1/telemetry/error',
            headers: { origin: 'https://userapi.delivering.email', host: 'userapi.delivering.email', 'content-type': 'application/json' },
            payload: { message: 'probe' }
        });
        assert.equal(own.statusCode, 204);
    } finally {
        await app.close();
    }
});
