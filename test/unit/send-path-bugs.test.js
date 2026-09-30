'use strict';

// Regression tests for real defects in src/routes/send.js's delivery paths.
// These do NOT touch the approval gate itself — approval-gate.test.js stays
// the contract test for that. Bugs covered here:
//
//  1. checkDeliveryStatus searched `{ header: ['In-Reply-To', value] }` —
//     imapflow's search compiler treats `header` as an OBJECT (it iterates
//     Object.keys), so the array compiled to `HEADER "0" ... HEADER "1" ...`,
//     matched nothing ever, and the endpoint reported 'pending' forever even
//     after a bounce arrived.
//  2. The status route ran decodeURIComponent on the ALREADY-decoded router
//     param, so a message id containing a literal '%' threw URIError → 500.
//  3. resolvePendingAndSend claimed the pending entry and then ran
//     trackingStore.create OUTSIDE the try/restore — a throw there destroyed
//     the user's approved draft permanently (the restore only covered
//     sendMessage).
//  4. appendToSent ran its cache invalidations INSIDE the append try block —
//     a cache write failure looked like a failed APPEND and the loop appended
//     the message AGAIN to the next candidate Sent folder (duplicate copies).
//  5. The approval-failure HTML interpolated the SMTP error text unescaped
//     (reflected markup from server-controlled-but-influenced text).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const smtpClientPath = require.resolve('../../src/smtp-client');
const sendRoutesPath = require.resolve('../../src/routes/send.js');

const TEST_USER = 'owner@example.com';
const TEST_PASS = 'mailbox-password';

// send.js destructures sendMessage at require time, so patch before loading it.
function installSendRecorder({ onSend } = {}) {
    const smtpClient = require(smtpClientPath);
    const original = smtpClient.sendMessage;
    const sent = [];
    smtpClient.sendMessage = async (msg) => {
        sent.push(msg);
        if (onSend) return onSend(msg, sent.length);
        return { messageId: `<captured-${sent.length}@example.com>`, response: '250 captured', raw: 'RAW-MESSAGE' };
    };
    delete require.cache[sendRoutesPath];
    return {
        sent,
        restore() {
            smtpClient.sendMessage = original;
            delete require.cache[sendRoutesPath];
        }
    };
}

// IMAP pool stand-in. `client` mimics just enough of imapflow — including the
// semantic that a `header` search query is an object keyed by header name
// (imapflow's search-compiler iterates Object.keys, so an array-shaped query
// searches for headers literally named "0"/"1" and matches nothing).
function makePool({ search, append } = {}) {
    const appends = [];
    const client = {
        authenticated: true,
        usable: true,
        async getMailboxLock() {
            return { release() {} };
        },
        search: search || (async () => []),
        async fetchOne() { return null; },
        async download() { return null; },
        append: append || (async (folder) => { appends.push(folder); })
    };
    return {
        appends,
        async acquire() { return client; },
        release() {},
        discard() {}
    };
}

async function buildApp({ pool, trackingStore, imapCache, getPublicBaseUrl, onSend } = {}) {
    const Fastify = require('fastify');
    const sensible = require('@fastify/sensible');
    const sendRoutes = require(sendRoutesPath);
    const app = Fastify();
    await app.register(sensible);
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
            getSendFromAddresses: async () => ({ addresses: [TEST_USER], wildcardDomains: ['example.com'] })
        },
        smtp: { host: '127.0.0.1', port: 1, secure: false },
        pool: pool || null,
        trackingStore: trackingStore || null,
        getPublicBaseUrl: getPublicBaseUrl || (() => 'https://mail.example.com'),
        imapCache: imapCache || null
    });
    return app;
}

const basic = () => `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString('base64')}`;

test('delivery status: a bounce is found and reported as failed, not pending', async (t) => {
    const recorder = installSendRecorder();
    const pool = makePool({
        search: async (query) => {
            // The server-side semantics: a header search is keyed by header
            // name. The old array-shaped query compiled to headers named "0"
            // and "1" and could never match — model that faithfully.
            if (query && query.header && !Array.isArray(query.header)
                && query.header['In-Reply-To'] === '<mid-1@example.com>') {
                return [7];
            }
            return [];
        }
    });
    pool.acquire = async () => ({
        authenticated: true,
        usable: true,
        async getMailboxLock() { return { release() {} }; },
        async search(query) {
            if (query && query.header && !Array.isArray(query.header)
                && query.header['In-Reply-To'] === '<mid-1@example.com>') {
                return [7];
            }
            return [];
        },
        async fetchOne() {
            return {
                envelope: { inReplyTo: '<mid-1@example.com>' },
                bodyStructure: { type: 'message/delivery-status', part: '1' }
            };
        },
        async download() {
            const text = 'Action: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 no such user\r\n';
            return { content: (async function* () { yield Buffer.from(text); })() };
        }
    });
    const app = await buildApp({ pool });
    t.after(async () => { await app.close(); recorder.restore(); });

    const res = await app.inject({
        method: 'GET',
        url: '/v1/messages/send/mid-1%40example.com/status',
        headers: { authorization: basic() }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.status, 'failed', 'a bounce DSN must surface as failed');
    assert.match(body.details, /550 no such user/);
});

test('delivery status: a message id containing a literal % must not 500', async (t) => {
    const recorder = installSendRecorder();
    const pool = makePool();
    const app = await buildApp({ pool });
    t.after(async () => { await app.close(); recorder.restore(); });

    // Router decodes '100%25@x' to '100%@x'; the handler decoded AGAIN and
    // threw URIError. The id never matches anything here, so 'pending' is
    // the right answer — the point is that it answers at all.
    const res = await app.inject({
        method: 'GET',
        url: '/v1/messages/send/100%25@x/status',
        headers: { authorization: basic() }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'pending');
});

test('approval send: a tracking-store failure must not destroy the approved draft', async (t) => {
    let createCalls = 0;
    const trackingStore = {
        create() {
            createCalls++;
            if (createCalls === 1) throw new Error('SQLITE_FULL: database or disk is full');
            return 'ref-ok';
        }
    };
    const recorder = installSendRecorder();
    const app = await buildApp({ trackingStore });
    t.after(async () => { await app.close(); recorder.restore(); });

    const create = await app.inject({
        method: 'POST',
        url: '/v1/messages/send',
        headers: { authorization: basic() },
        payload: { to: ['c@example.com'], subject: 's', text: 't', trackOpens: true }
    });
    assert.equal(create.statusCode, 200, create.body);
    const { token } = create.json();

    const first = await app.inject({ method: 'POST', url: `/v1/messages/approve/${token}` });
    assert.equal(first.statusCode, 502, 'the failed attempt reports failure');

    const second = await app.inject({ method: 'POST', url: `/v1/messages/approve/${token}` });
    assert.equal(second.statusCode, 200,
        'the approved draft must survive the failed attempt so the same link can be retried');
    assert.match(second.body, /Email sent/);
});

test('approval send: SMTP error text is HTML-escaped in the failure page', async (t) => {
    const recorder = installSendRecorder({
        onSend: (msg, n) => {
            if (n > 1) { // let the approval email through, fail the real send
                const err = new Error('boom');
                err.response = '<img src=x onerror=alert(1)>';
                throw err;
            }
            return { messageId: `<approval@example.com>`, response: '250 ok', raw: 'RAW' };
        }
    });
    const app = await buildApp();
    t.after(async () => { await app.close(); recorder.restore(); });

    const create = await app.inject({
        method: 'POST',
        url: '/v1/messages/send',
        headers: { authorization: basic() },
        payload: { to: ['c@example.com'], subject: 's', text: 't' }
    });
    const { token } = create.json();
    const res = await app.inject({ method: 'POST', url: `/v1/messages/approve/${token}` });

    assert.equal(res.statusCode, 502);
    assert.ok(!res.body.includes('<img src=x'), 'raw markup from the SMTP response must not reach the page');
    assert.match(res.body, /&lt;img src=x/, 'the text should still be visible, escaped');
});

test('appendToSent: a cache-invalidation failure must not duplicate the Sent copy', async (t) => {
    const recorder = installSendRecorder();
    const pool = makePool();
    const imapCache = {
        invalidateFolderUid() { throw new Error('SQLITE_READONLY: attempt to write a readonly database'); },
        invalidateFolderStatus() { throw new Error('SQLITE_READONLY: attempt to write a readonly database'); }
    };
    const app = await buildApp({ pool, imapCache });
    t.after(async () => { await app.close(); recorder.restore(); });

    const create = await app.inject({
        method: 'POST',
        url: '/v1/messages/send',
        headers: { authorization: basic() },
        payload: { to: ['c@example.com'], subject: 's', text: 't' }
    });
    const { token } = create.json();
    const res = await app.inject({ method: 'POST', url: `/v1/messages/approve/${token}` });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(pool.appends.length, 1, `the message must be appended exactly once, got: ${pool.appends.join(', ')}`);
    assert.equal(pool.appends[0], 'Sent');
});
