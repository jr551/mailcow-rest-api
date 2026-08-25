'use strict';

// The webmail SPA is served from webmail.delivering.email but calls the API on
// userapi.delivering.email, so every call is cross-origin. Two things have to
// hold or the whole SPA goes dark with opaque "Failed to fetch" errors:
//
//   1. the preflight must be answered *before* the auth hook — a browser
//      strips Authorization from a preflight, so authenticating one can only
//      401 and kill the real request behind it;
//   2. the real response must carry Allow-Origin too. A passed preflight only
//      buys the right to send the request; the browser checks the response
//      separately. Setting those headers from onResponse instead of onSend
//      looks correct in a curl -i but fires after the headers are on the wire,
//      so the browser never sees them.

process.env.API_CORS_ORIGINS = 'https://webmail.delivering.email,https://delivering.email';
process.env.API_CORS_WILDCARD_APEX = 'delivering.email';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../../src/server');
const { createCache } = require('../../src/cache');

function makeApp() {
    return build({
        cache: createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0 }),
        ocrCache: null
    });
}

const ORIGIN = 'https://webmail.delivering.email';

test('preflight is answered 204 with the full header set', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'OPTIONS',
            url: '/v1/me/mailbox',
            headers: {
                origin: ORIGIN,
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'Authorization'
            }
        });
        assert.equal(res.statusCode, 204);
        assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
        assert.equal(res.headers['access-control-allow-credentials'], 'true');
        assert.match(res.headers['access-control-allow-methods'], /GET/);
        assert.match(res.headers['access-control-allow-headers'], /Authorization/);
        assert.ok(Number(res.headers['access-control-max-age']) > 0);
    } finally {
        await app.close();
    }
});

test('preflight on a protected route is not challenged for credentials', async () => {
    const app = await makeApp();
    try {
        // No Authorization header, exactly as a browser sends it.
        const res = await app.inject({
            method: 'OPTIONS',
            url: '/v1/mailboxes',
            headers: { origin: ORIGIN, 'access-control-request-method': 'GET' }
        });
        assert.notEqual(res.statusCode, 401);
        assert.equal(res.statusCode, 204);
    } finally {
        await app.close();
    }
});

test('a real response carries Allow-Origin, not just the preflight', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: ORIGIN } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
        assert.equal(res.headers['access-control-allow-credentials'], 'true');
        assert.match(res.headers['vary'] || '', /Origin/);
    } finally {
        await app.close();
    }
});

test('an unlisted origin gets no CORS headers', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example.com' } });
        assert.equal(res.headers['access-control-allow-origin'], undefined);

        const pre = await app.inject({
            method: 'OPTIONS',
            url: '/v1/me/mailbox',
            headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' }
        });
        assert.equal(pre.headers['access-control-allow-origin'], undefined);
    } finally {
        await app.close();
    }
});

test('any https subdomain of the apex is allowed, plain http is not', async () => {
    const app = await makeApp();
    try {
        const ok = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://webmail2.delivering.email' } });
        assert.equal(ok.headers['access-control-allow-origin'], 'https://webmail2.delivering.email');

        // Credentialed CORS must not be handed to a downgraded origin.
        const insecure = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://webmail2.delivering.email' } });
        assert.equal(insecure.headers['access-control-allow-origin'], undefined);
    } finally {
        await app.close();
    }
});

test('same-origin requests (no Origin header) are untouched', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['access-control-allow-origin'], undefined);
    } finally {
        await app.close();
    }
});
