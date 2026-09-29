'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Fastify = require('fastify');

const outboundWebhookRoutes = require('../../src/routes/outbound-webhooks');
const { createOutboundWebhookStore } = require('../../src/outbound-webhook-store');
const { createSecretBox } = require('../../src/secret-box');

// Test send: the route that lets a user prove a subscriber works without
// waiting for real mail — and the route that must NOT become an unauthenticated
// POST proxy at a URL the caller picks.
//
// The properties worth pinning are the ones that make it trustworthy:
// it is the same delivery the worker performs (signature included), it hands
// back what the receiver actually said, it cannot leak the secret, it cannot
// consume mail, and it cannot be hammered.

const KEY = 'b'.repeat(64);

// Every store must be :memory: and closed, or these leak sqlite handles.
// The guard is stubbed because these URLs are deliberately unresolvable
// example.com hosts — without a real DNS answer the route correctly refuses
// them before it ever POSTs. The guard's own behaviour is covered by its
// tests; what matters here is that the route calls it at all, which the
// "refuses a private destination" test below proves by stubbing it to throw.
async function buildApp({ user = 'me@example.com', responder, assertDestination, timeoutMs = 5000 } = {}) {
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
        timeoutMs,
        // The seam: the route still runs deliveryHeaders, signing and the
        // reply cap — only the socket and the DNS lookup are faked.
        requestImpl: responder,
        assertPublicDestination: assertDestination || (async () => ({}))
    });
    return { app, store };
}


function fakeResponder({ status = 200, body = 'ok', chunks } = {}) {
    const seen = [];
    const fn = async (url, opts) => {
        seen.push({ url, opts });
        return {
            statusCode: status,
            body: (async function* () {
                for (const c of (chunks || [body])) yield Buffer.from(c, 'utf8');
            })()
        };
    };
    return { seen, fn };
}

function makeWebhook(store, over = {}) {
    return store.create({
        user: 'me@example.com',
        password: 'pw',
        label: 'Agent',
        url: 'https://receiver.example/hook',
        ...over
    });
}

test('test send: reports the receiver status and reply body verbatim', async () => {
    const http = fakeResponder({ status: 202, body: '{"accepted":true,"id":"abc"}' });
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const w = makeWebhook(store);
        const res = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.ok, true);
        assert.equal(body.status, 202, 'the receiver status is passed through, not flattened to 200');
        assert.equal(body.reply, '{"accepted":true,"id":"abc"}');
        assert.equal(body.truncated, false);
        assert.ok(typeof body.sentAt === 'string' && body.sentAt.endsWith('Z'));
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: a receiver error is a successful request reporting the failure', async () => {
    // 500 from the subscriber is the answer the user needs to see; turning it
    // into a route-level error would hide the only useful information.
    const http = fakeResponder({ status: 500, body: 'no route matched' });
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const w = makeWebhook(store);
        const res = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.ok, false);
        assert.equal(body.status, 500);
        assert.equal(body.reply, 'no route matched');
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: signs with the stored secret exactly as a real delivery does', async () => {
    const http = fakeResponder();
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const w = makeWebhook(store, { headers: { Authorization: 'Bearer stored-token' } });
        const res = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        assert.equal(res.statusCode, 200);

        const sent = http.seen[0];
        assert.equal(sent.opts.method, 'POST');
        // The name is preserved as the user typed it (sanitizeWebhookHeaders
        // keeps the original casing), so the receiver sees what it expects.
        assert.equal(sent.opts.headers.Authorization, 'Bearer stored-token',
            'the stored header value is used without the client ever holding it');
        const ts = sent.opts.headers['x-webhook-timestamp'];
        assert.ok(ts, 'a timestamp header is sent');
        const expected = crypto.createHmac('sha256', w.secret).update(`${ts}.${sent.opts.body}`).digest('hex');
        assert.equal(sent.opts.headers['x-webhook-signature-v2'], expected,
            'the signature covers the exact bytes sent, so a receiver validating it passes');
        const payload = JSON.parse(sent.opts.body);
        assert.equal(payload.test, true);
        assert.equal(payload.webhook.id, w.id);
        assert.match(payload.message, /test delivery/i);
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: the payload carries the configured preamble, like a real delivery', async () => {
    const http = fakeResponder();
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const w = makeWebhook(store, { prepend: 'This is a DM to the triage agent.' });
        await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        const payload = JSON.parse(http.seen[0].opts.body);
        assert.match(payload.message, /triage agent/);
        // A receiver that reads `message` sees the preamble first, which is
        // the entire point of the prepend field.
        assert.ok(payload.message.indexOf('triage agent') < payload.message.indexOf('test delivery'));
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: never returns the secret or the stored header values', async () => {
    const http = fakeResponder();
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const w = makeWebhook(store, { headers: { Authorization: 'Bearer super-secret-value' } });
        const res = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        assert.equal(res.statusCode, 200);
        assert.ok(!res.body.includes(w.secret), 'the signing secret must not cross to the browser');
        assert.ok(!res.body.includes('super-secret-value'), 'header values must not cross to the browser');
        assert.ok(!('secret' in JSON.parse(res.body)));
        assert.ok(!('headers' in JSON.parse(res.body)));
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: reads no mail and touches no delivery state', async () => {
    const http = fakeResponder();
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const w = makeWebhook(store);
        await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        const after = store.get({ id: w.id, user: 'me@example.com' });
        // touch() is how the worker records a delivery. If the test send
        // called it, the UI would claim this webhook has been used and the
        // user would lose the "never delivered yet" signal.
        assert.equal(after.lastUsedAt, null, 'a test send must not mark the webhook as used');
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: truncates a runaway reply body instead of buffering it', async () => {
    const huge = 'A'.repeat(50_000);
    const http = fakeResponder({ status: 200, body: huge, chunks: [huge] });
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const w = makeWebhook(store);
        const res = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        const body = JSON.parse(res.body);
        assert.equal(body.reply.length, 300);
        assert.equal(body.truncated, true);
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: refuses a destination the guard rejects, without posting', async () => {
    const http = fakeResponder();
    const blocked = Object.assign(new Error('Private IP addresses are blocked'), { permanent: true });
    const { app, store } = await buildApp({
        responder: http.fn,
        assertDestination: async () => { throw blocked; }
    });
    try {
        const w = makeWebhook(store);
        const res = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        assert.equal(res.statusCode, 400);
        assert.match(JSON.parse(res.body).detail, /not allowed/i);
        assert.equal(http.seen.length, 0, 'a blocked destination is never contacted');
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: another user\'s webhook id is a 404, not an outbound POST', async () => {
    const http = fakeResponder();
    // Authenticated as somebody else entirely.
    const { app, store } = await buildApp({ user: 'other@example.com', responder: http.fn });
    try {
        const w = makeWebhook(store);
        const res = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        assert.equal(res.statusCode, 404);
        assert.equal(http.seen.length, 0,
            "another mailbox's credential must never be used to POST anywhere");
    } finally {
        await app.close();
        store.close();
    }
});

test('getLive hands the secret to its owner and nobody else', async () => {
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    const store = createOutboundWebhookStore({ filePath: ':memory:', secretBox });
    try {
        const w = store.create({
            user: 'me@example.com', password: 'pw', label: 'L', url: 'https://receiver.example/h'
        });
        assert.equal(store.getLive({ id: w.id, user: 'other@example.com' }), null);
        assert.ok(store.getLive({ id: w.id, user: 'me@example.com' }).secret, 'the owner can sign a delivery');
        // No mailbox password crosses this boundary: the test send has no
        // business holding one, and leaking it would be a credential leak.
        assert.equal(store.getLive({ id: w.id, user: 'me@example.com' }).password, undefined);
    } finally {
        store.close();
    }
});

test('test send: throttled after the per-minute budget, per webhook', async () => {
    const http = fakeResponder();
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const w = makeWebhook(store);
        const other = makeWebhook(store, { label: 'Second' });
        for (let i = 0; i < 10; i++) {
            const ok = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
            assert.equal(ok.statusCode, 200, `send ${i + 1} should be allowed`);
        }
        const blocked = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        assert.equal(blocked.statusCode, 429, 'the 11th send in the window is refused');
        assert.ok(blocked.headers['retry-after'], 'a Retry-After header tells the client when to come back');
        assert.equal(http.seen.length, 10, 'the refused send never reached the receiver');

        // Keyed per webhook, so testing a second one is not collateral damage.
        const otherRes = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${other.id}/test` });
        assert.equal(otherRes.statusCode, 200);
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: a receiver that never answers is a 502, not a hang', async () => {
    const responder = async () => { throw new Error('ECONNREFUSED 10.0.0.1:443'); };
    const { app, store } = await buildApp({ responder, timeoutMs: 500 });
    try {
        const w = makeWebhook(store);
        const res = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        assert.equal(res.statusCode, 502);
        assert.match(JSON.parse(res.body).detail, /before any reply/i);
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: an unknown id is a 404 and posts nothing', async () => {
    const http = fakeResponder();
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const res = await app.inject({ method: 'POST', url: '/v1/me/outbound-webhooks/deadbeef/test' });
        assert.equal(res.statusCode, 404);
        assert.equal(http.seen.length, 0);
    } finally {
        await app.close();
        store.close();
    }
});

test('test send: a revoked webhook cannot be tested', async () => {
    const http = fakeResponder();
    const { app, store } = await buildApp({ responder: http.fn });
    try {
        const w = makeWebhook(store);
        store.revoke({ id: w.id, user: 'me@example.com' });
        const res = await app.inject({ method: 'POST', url: `/v1/me/outbound-webhooks/${w.id}/test` });
        assert.equal(res.statusCode, 404);
        assert.equal(http.seen.length, 0, 'a revoked credential must never be used to POST anywhere');
    } finally {
        await app.close();
        store.close();
    }
});

test('the per-user webhook limit is 100 by default', async () => {
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    const store = createOutboundWebhookStore({ filePath: ':memory:', secretBox });
    try {
        assert.equal(store.maxPerUser, 100);
        for (let i = 0; i < 100; i++) {
            store.create({ user: 'me@example.com', password: 'pw', label: `L${i}`, url: 'https://receiver.example/h' });
        }
        assert.throws(
            () => store.create({ user: 'me@example.com', password: 'pw', label: 'L101', url: 'https://receiver.example/h' }),
            /limit reached/i
        );
        // Per user, not global: a second mailbox is unaffected.
        store.create({ user: 'other@example.com', password: 'pw', label: 'L', url: 'https://receiver.example/h' });
    } finally {
        store.close();
    }
});
