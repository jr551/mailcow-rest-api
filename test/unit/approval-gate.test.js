'use strict';

// The one property the AI assistant takeover feature rests on: an API caller
// authenticated with HTTP Basic cannot get mail out without a human clicking
// approve first.
//
// The takeover worker drafts a reply and self-POSTs it to /v1/messages/send
// with Basic auth (src/server.js `takeoverDeliver`). That is deliberately the
// same door the MCP/API client uses, because src/routes/send.js holds every
// Basic-authenticated send for approval instead of dispatching it. If that
// gate ever stopped applying — a refactor, a reordering of the auth checks, a
// new "just send it" flag — the assistant would start emailing real people
// with no human in the loop.
//
// Nothing covered that. The pending-send tests prove the claim/restore race
// on an approval token; the takeover route tests prove the routes do not call
// the injected send function. Neither reaches src/routes/send.js. This does.
//
// The assertion is about WHICH message leaves, not whether any mail is sent:
// the gate legitimately sends one message — the approve/deny request to the
// owner. What must never appear in that outbox is the caller's own message.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const smtpClientPath = require.resolve('../../src/smtp-client');
const sendRoutesPath = require.resolve('../../src/routes/send.js');

const TEST_USER = 'owner@example.com';
const TEST_PASS = 'mailbox-password';

// Intercept the SMTP client before send.js is loaded, because send.js
// destructures `sendMessage` at require time.
function installSendRecorder() {
    const smtpClient = require(smtpClientPath);
    const original = smtpClient.sendMessage;
    const sent = [];
    smtpClient.sendMessage = async (msg) => {
        sent.push(msg);
        return { messageId: `<captured-${sent.length}@example.com>`, response: '250 captured' };
    };
    // Force send.js to pick up the patched export.
    delete require.cache[sendRoutesPath];
    return {
        sent,
        restore() {
            smtpClient.sendMessage = original;
            delete require.cache[sendRoutesPath];
        }
    };
}

async function buildApp() {
    const Fastify = require('fastify');
    const sensible = require('@fastify/sensible');
    const sendRoutes = require(sendRoutesPath);

    const app = Fastify();
    await app.register(sensible);

    // Stand-in for src/auth.js. It only populates req.creds; the route's own
    // `isBasicAuth` check is what is under test, so do not pre-empt it.
    app.addHook('onRequest', async (req) => {
        const auth = req.headers.authorization || '';
        if (auth.startsWith('Basic ')) {
            const decoded = Buffer.from(auth.slice(6), 'base64').toString();
            const idx = decoded.indexOf(':');
            req.creds = { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
        } else if (auth.startsWith('Bearer ')) {
            req.creds = { user: TEST_USER, pass: TEST_PASS };
        }
    });

    await app.register(sendRoutes, {
        db: {
            // The owner may send as themselves and as the wildcard domain,
            // so the from-address allow-list is not what this test is about.
            getSendFromAddresses: async () => ({
                addresses: [TEST_USER],
                wildcardDomains: ['example.com']
            })
        },
        smtp: { host: '127.0.0.1', port: 1, secure: false },
        pool: null,
        trackingStore: null,
        getPublicBaseUrl: () => 'https://mail.example.com',
        imapCache: null
    });

    return app;
}

const PAYLOAD = {
    to: ['customer@example.com'],
    subject: 'Your order',
    text: 'It shipped yesterday.'
};

test('a Basic-authenticated send is HELD for approval, not dispatched', async (t) => {
    const recorder = installSendRecorder();
    const app = await buildApp();
    t.after(async () => { await app.close(); recorder.restore(); });

    const res = await app.inject({
        method: 'POST',
        url: '/v1/messages/send',
        headers: {
            authorization: `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString('base64')}`
        },
        payload: PAYLOAD
    });

    assert.equal(res.statusCode, 200, `unexpected status: ${res.statusCode} ${res.body}`);
    const body = res.json();
    assert.equal(body.pendingApproval, true, 'a Basic-authenticated send must be held for approval');
    assert.ok(body.token, 'an approval token must be issued so the owner can act on it');

    // The caller's message must not have gone anywhere.
    const leakedToCustomer = recorder.sent.filter(
        (m) => Array.isArray(m.to) && m.to.join(',').includes('customer@example.com')
            && m.subject === 'Your order'
    );
    assert.deepEqual(
        leakedToCustomer,
        [],
        'the caller\'s own message was dispatched without human approval - the takeover '
        + 'assistant would have emailed a real customer'
    );

    // Sanity: the gate did do something, and it addressed the owner only.
    assert.equal(recorder.sent.length, 1, 'exactly one message should leave: the approval request to the owner');
    assert.deepEqual(recorder.sent[0].to, [TEST_USER], 'the approval request must go to the owner, not the customer');
    assert.match(recorder.sent[0].subject, /^Approve sending:/);
});

test('the same request with session (Bearer) auth sends immediately - proving the gate is specific', async (t) => {
    const recorder = installSendRecorder();
    const app = await buildApp();
    t.after(async () => { await app.close(); recorder.restore(); });

    const res = await app.inject({
        method: 'POST',
        url: '/v1/messages/send',
        headers: { authorization: 'Bearer session-token' },
        payload: PAYLOAD
    });

    // Without Basic auth the request is not held. This is the control case:
    // if BOTH branches were held, the first test would be passing for the
    // wrong reason and would not be evidence of anything.
    assert.equal(recorder.sent.length, 1, 'a session-authenticated send goes straight out');
    assert.equal(recorder.sent[0].subject, 'Your order', 'the caller\'s message is the one dispatched');
    assert.deepEqual(recorder.sent[0].to, ['customer@example.com']);
    const body = res.json();
    assert.equal(body.pendingApproval !== true, true, 'no approval should be pending for a session-authenticated send');
});

test('the gate is keyed on the scheme, not on credentials being present', async (t) => {
    const recorder = installSendRecorder();
    const app = await buildApp();
    t.after(async () => { await app.close(); recorder.restore(); });

    // A request that carries credentials but NOT as Basic must not be held.
    // This is what a future refactor could break by testing "are creds set?"
    // instead of "is this Basic auth?".
    await app.inject({
        method: 'POST',
        url: '/v1/messages/send',
        headers: { authorization: 'Bearer whatever' },
        payload: PAYLOAD
    });
    assert.equal(recorder.sent.length, 1);
    assert.equal(recorder.sent[0].subject, 'Your order');

    recorder.sent.length = 0;
    await app.inject({
        method: 'POST',
        url: '/v1/messages/send',
        headers: { authorization: 'Basic ' + Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString('base64') },
        payload: PAYLOAD
    });
    assert.equal(recorder.sent.length, 1, 'Basic auth still produces exactly one message');
    assert.match(recorder.sent[0].subject, /^Approve sending:/, 'and it is the approval request, not the message');
});
