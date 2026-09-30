'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Fastify = require('fastify');

const { sanitizeWebhookHeaders } = require('../../src/utils/webhook-headers');
const { deliveryHeaders } = require('../../src/outbound-webhook-deliver');
const outboundWebhookRoutes = require('../../src/routes/outbound-webhooks');
const { createOutboundWebhookStore } = require('../../src/outbound-webhook-store');
const { createSecretBox } = require('../../src/secret-box');

// Custom headers on outbound webhooks: the sanitizer is a request-forgery
// guard (CR/LF in a value is header injection, a reserved name is a framing
// or signature clobber), and the route contract is "names out, values in" —
// the API may show which headers exist but must never hand a value back.

const KEY = 'b'.repeat(64);

// Same wiring as the test-send suite: :memory: store, creds injected by a
// hook, the SSRF guard stubbed because example.com is deliberately
// unresolvable — what matters here is the body/response contract, not DNS.
async function buildApp({ user = 'me@example.com' } = {}) {
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    const store = createOutboundWebhookStore({ filePath: ':memory:', secretBox });
    const app = Fastify({ logger: false });
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        reply.code(status).type('application/problem+json')
            .send(err.problem || { type: 'about:blank', title: 'Error', status, detail: err.message });
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user, pass: 'pw', hash: 'h' };
    });
    await app.register(outboundWebhookRoutes, {
        store,
        assertPublicDestination: async () => ({})
    });
    return { app, store };
}

function okBody(headers) {
    return { label: 'Agent', url: 'https://receiver.example/hook', headers };
}

// ---------- sanitizeWebhookHeaders ----------

test('headers: Authorization and ordinary X- names are accepted', () => {
    const res = sanitizeWebhookHeaders({
        'Authorization': 'Bearer abc',
        'X-Api-Key': 'k1',
        'X-Tenant': 'ops'
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.headers, {
        'Authorization': 'Bearer abc',
        'X-Api-Key': 'k1',
        'X-Tenant': 'ops'
    });
});

test('headers: Content-Type and User-Agent may be overridden; x-webhook-foo is just a header', () => {
    // The reserved list protects framing and the signature — not cosmetics.
    // A receiver-facing Content-Type override is legitimate (some endpoints
    // want it spelled differently), and the blocklist is the two signature
    // names we emit, not the x-webhook-* prefix or x-* generally.
    const res = sanitizeWebhookHeaders({
        'Content-Type': 'application/vnd.api+json',
        'User-Agent': 'my-receiver/1.0',
        'X-Webhook-Token': 'shared-secret'
    });
    assert.equal(res.ok, true);
    assert.equal(res.headers['Content-Type'], 'application/vnd.api+json');
    assert.equal(res.headers['X-Webhook-Token'], 'shared-secret');
});

test('headers: CR, LF and control bytes in a value are refused', () => {
    for (const value of ['ok\r\nInjected: yes', 'ok\nInjected: yes', 'a\rb', 'bell\x07']) {
        const res = sanitizeWebhookHeaders({ 'X-Evil': value });
        assert.equal(res.ok, false, JSON.stringify(value));
        assert.match(res.error, /cannot go on the wire/);
    }
    // Tab and space are legal.
    assert.equal(sanitizeWebhookHeaders({ 'X-Ok': 'a\tb c' }).ok, true);
});

test('headers: more than 16 entries is refused', () => {
    const many = {};
    for (let i = 0; i < 17; i++) many[`X-H${i}`] = 'v';
    const res = sanitizeWebhookHeaders(many);
    assert.equal(res.ok, false);
    assert.match(res.error, /at most 16/);
    const sixteen = {};
    for (let i = 0; i < 16; i++) sixteen[`X-H${i}`] = 'v';
    assert.equal(sanitizeWebhookHeaders(sixteen).ok, true);
});

test('headers: names must be RFC tokens of at most 64 chars', () => {
    assert.equal(sanitizeWebhookHeaders({ 'Bad Name': 'x' }).ok, false);
    assert.equal(sanitizeWebhookHeaders({ 'Bad:Name': 'x' }).ok, false);
    assert.equal(sanitizeWebhookHeaders({ '': 'x' }).ok, false);
    assert.equal(sanitizeWebhookHeaders({ ['N'.repeat(65)]: 'x' }).ok, false);
    assert.equal(sanitizeWebhookHeaders({ ['N'.repeat(64)]: 'x' }).ok, true);
});

test('headers: values are printable ASCII of at most 1024 chars', () => {
    const res = sanitizeWebhookHeaders({ 'X-Long': 'v'.repeat(1025) });
    assert.equal(res.ok, false);
    assert.match(res.error, /1024/);
    assert.equal(sanitizeWebhookHeaders({ 'X-Long': 'v'.repeat(1024) }).ok, true);
    // Non-string and non-ASCII are both refused.
    assert.equal(sanitizeWebhookHeaders({ 'X-N': 5 }).ok, false);
    assert.equal(sanitizeWebhookHeaders({ 'X-U': 'bærer' }).ok, false);
    // And the input itself must be a plain object.
    assert.equal(sanitizeWebhookHeaders('Authorization: Bearer x').ok, false);
    assert.equal(sanitizeWebhookHeaders([['X-A', 'b']]).ok, false);
});

test('headers: reserved names are refused case-insensitively', () => {
    for (const name of [
        'Host', 'CONTENT-LENGTH', 'Connection', 'Transfer-Encoding',
        'Upgrade', 'TE', 'Trailer', 'Keep-Alive',
        'Proxy-Authenticate', 'Proxy-Authorization',
        'X-Webhook-Timestamp', 'x-webhook-signature-v2'
    ]) {
        const res = sanitizeWebhookHeaders({ [name]: 'x' });
        assert.equal(res.ok, false, name);
        assert.match(res.error, /reserved/);
    }
});

// ---------- route contract ----------

test('route: POST stores headers but returns only sorted names — values are write-only', async () => {
    const { app, store } = await buildApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/me/outbound-webhooks',
            payload: okBody({ 'X-Zeta': 'last', 'Authorization': 'Bearer top-secret' })
        });
        assert.equal(res.statusCode, 201);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.headerNames, ['Authorization', 'X-Zeta']);
        assert.equal(body.headers, undefined, 'no header map, masked or otherwise');
        assert.ok(!res.body.includes('top-secret'), 'a header value must never cross to the client');
        // The real values did land, encrypted, for the forwarder.
        assert.equal(store.listAllLive()[0].headers.Authorization, 'Bearer top-secret');
        // And the list view shows the same names-only shape.
        const list = JSON.parse((await app.inject({
            method: 'GET', url: '/v1/me/outbound-webhooks'
        })).body);
        assert.deepEqual(list.webhooks[0].headerNames, ['Authorization', 'X-Zeta']);
        assert.equal(list.webhooks[0].headers, undefined);
    } finally {
        await app.close();
        store.close();
    }
});

test('route: PATCH replaces the whole header map and {} clears it', async () => {
    const { app, store } = await buildApp();
    try {
        const created = JSON.parse((await app.inject({
            method: 'POST', url: '/v1/me/outbound-webhooks',
            payload: okBody({ 'Authorization': 'Bearer one' })
        })).body);
        const patch = (headers) => app.inject({
            method: 'PATCH', url: `/v1/me/outbound-webhooks/${created.id}`,
            payload: headers === undefined ? { label: 'Renamed' } : { headers }
        });

        // No headers key at all → untouched.
        let res = await patch(undefined);
        assert.equal(res.statusCode, 200);
        assert.equal(store.listAllLive()[0].headers.Authorization, 'Bearer one');

        // Supplied → full replace, and the response still shows names only.
        res = await patch({ 'X-Api-Key': 'k', 'Authorization': 'Bearer two' });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(JSON.parse(res.body).headerNames, ['Authorization', 'X-Api-Key']);
        assert.deepEqual(store.listAllLive()[0].headers,
            { 'Authorization': 'Bearer two', 'X-Api-Key': 'k' });

        // Empty object → cleared.
        res = await patch({});
        assert.equal(res.statusCode, 200);
        assert.deepEqual(JSON.parse(res.body).headerNames, []);
        assert.deepEqual(store.listAllLive()[0].headers, {});
    } finally {
        await app.close();
        store.close();
    }
});

test('route: invalid headers 400 and nothing is stored', async () => {
    const { app, store } = await buildApp();
    try {
        for (const headers of [
            { 'Host': 'evil.example' },
            { 'X-Bad': 'ok\r\nInjected: yes' },
            { 'Bad Name': 'x' }
        ]) {
            const res = await app.inject({
                method: 'POST', url: '/v1/me/outbound-webhooks', payload: okBody(headers)
            });
            assert.equal(res.statusCode, 400, JSON.stringify(headers));
            assert.match(res.headers['content-type'], /application\/problem\+json/);
        }
        assert.equal(store.listAllLive().length, 0);
        // PATCH is held to the same standard.
        const created = JSON.parse((await app.inject({
            method: 'POST', url: '/v1/me/outbound-webhooks',
            payload: okBody({ 'X-Ok': 'v' })
        })).body);
        const res = await app.inject({
            method: 'PATCH', url: `/v1/me/outbound-webhooks/${created.id}`,
            payload: { headers: { 'Connection': 'close' } }
        });
        assert.equal(res.statusCode, 400);
        // And the failed PATCH replaced nothing.
        assert.deepEqual(store.listAllLive()[0].headers, { 'X-Ok': 'v' });
    } finally {
        await app.close();
        store.close();
    }
});

// ---------- delivery merge ----------

test('deliver: custom headers merge after defaults; the signature always wins', () => {
    const payload = { hello: 'world' };
    const now = () => 1_700_000_000_000;
    const webhook = {
        headers: {
            'Authorization': 'Bearer abc',
            'Content-Type': 'application/vnd.api+json',
            // Even if a forged signature somehow reached this point —
            // env config, a bug upstream — it cannot out-vote the real one.
            'X-Webhook-Signature-V2': 'forged'
        }
    };
    const { body, headers } = deliveryHeaders(webhook, payload, { secret: 'shh', now });
    assert.equal(headers.Authorization, 'Bearer abc');
    // Case-insensitive replace: the default 'content-type' is gone, not
    // duplicated alongside the override.
    assert.equal(headers['Content-Type'], 'application/vnd.api+json');
    assert.equal(headers['content-type'], undefined);
    assert.equal(headers['user-agent'], 'mailcow-rest-api/outbound-webhook');
    const ts = headers['x-webhook-timestamp'];
    const expected = crypto.createHmac('sha256', 'shh')
        .update(`${ts}.${body}`).digest('hex');
    assert.equal(headers['x-webhook-signature-v2'], expected);
    assert.equal(headers['X-Webhook-Signature-V2'], undefined);
});
