'use strict';

// Regression tests for two request-parameter bugs in the message routes:
//
//  G. decodeMailboxPathParam ran decodeURIComponent on the ALREADY-decoded
//     router param (find-my-way percent-decodes params before handlers see
//     them). A mailbox literally named '100%' made the second decode throw
//     URIError → 500, and a mailbox named 'A%2FB' was addressed as 'A/B' —
//     a DELETE/MOVE silently acting on a DIFFERENT mailbox than the caller
//     named.
//
//  H. Number(req.params.uid) was unvalidated: a non-numeric uid became NaN,
//     was stringified to 'NaN', and the IMAP layer rejected it — a 502 with
//     an upstream-error shape for what is a client error. Malformed uids are
//     400s and must never reach IMAP.

const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');

const messageRoutes = require('../../src/routes/messages');
const config = require('../../src/config');

// Records the mailbox path handlers act on and every uid handed to IMAP.
// Non-numeric uids make the IMAP methods throw, the way imapflow rejects a
// `UID FETCH NaN` — so the 502 shape of bug H is reproducible.
function makePoolStub() {
    const calls = { lockPath: null, uids: [] };
    const guard = (uid) => {
        calls.uids.push(String(uid));
        if (!/^\d+$/.test(String(uid))) {
            throw new Error(`Invalid UID: ${uid}`);
        }
    };
    const client = {
        authenticated: true,
        usable: true,
        mailbox: { exists: 2, uidValidity: 1 },
        async getMailboxLock(path) {
            calls.lockPath = path;
            return { release() {} };
        },
        async search() { return []; },
        async fetchOne(uid) { guard(uid); return null; },
        async download(uid) { guard(uid); return null; },
        async messageFlagsSet(uid) { guard(uid); },
        async messageFlagsAdd(uid) { guard(uid); },
        async messageFlagsRemove(uid) { guard(uid); },
        async messageMove(uid) { guard(uid); return null; },
        async messageDelete(uid) { guard(uid); return true; }
    };
    return {
        calls,
        async acquire() { return client; },
        release() {},
        discard() {}
    };
}

async function buildApp() {
    const pool = makePoolStub();
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.addContentTypeParser('message/rfc822', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(messageRoutes, { pool, ocrCache: null });
    return { app, pool };
}

// ── G: the route param is used exactly once-decoded ──

test('G: a mailbox literally named "100%" is addressable (no URIError from a second decode)', async () => {
    const { app, pool } = await buildApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/100%25/messages' });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(pool.calls.lockPath, '100%');
    } finally {
        await app.close();
    }
});

test('G: DELETE acts on the mailbox the caller named, not a re-decoded one', async () => {
    const { app, pool } = await buildApp();
    try {
        // Client encodes the literal mailbox 'A%2FB' as 'A%252FB'.
        const res = await app.inject({ method: 'DELETE', url: '/v1/mailboxes/A%252FB/messages/5' });
        assert.equal(res.statusCode, 204, res.body);
        assert.equal(pool.calls.lockPath, 'A%2FB');
    } finally {
        await app.close();
    }
});

test('G: MOVE acts on the mailbox the caller named, not a re-decoded one', async () => {
    const { app, pool } = await buildApp();
    try {
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/mailboxes/A%252FB/messages/5/move',
            payload: { path: 'Archive' }
        });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(pool.calls.lockPath, 'A%2FB');
    } finally {
        await app.close();
    }
});

test('G: nested mailbox paths are still decoded once (guard against under-decoding)', async () => {
    const { app, pool } = await buildApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/parent%2Fchild/messages' });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(pool.calls.lockPath, 'parent/child');
    } finally {
        await app.close();
    }
});

test('G: malformed percent-encoding never leaks a URIError 500', async () => {
    const { app, pool } = await buildApp();
    try {
        for (const url of ['/v1/mailboxes/100%/messages', '/v1/mailboxes/%ZZ/messages']) {
            const res = await app.inject({ method: 'GET', url });
            assert.ok([400, 404].includes(res.statusCode),
                `${url} → ${res.statusCode} (want 400 or a clean 404): ${res.body}`);
            assert.ok(!res.body.includes('URIError'), res.body);
        }
    } finally {
        await app.close();
    }
});

// ── H: uid params are validated before IMAP sees them ──

test('H: non-numeric uids are 400s and never reach IMAP', async () => {
    const savedOcrKey = config.ocr.apiKey;
    config.ocr.apiKey = 'test-ocr-key'; // unmask the OCR route past its 501 check
    const { app, pool } = await buildApp();
    const bad = [
        { method: 'GET', url: '/v1/mailboxes/X/messages/abc' },
        { method: 'GET', url: '/v1/mailboxes/X/messages/abc/raw' },
        { method: 'GET', url: '/v1/mailboxes/X/messages/abc/attachments/2' },
        { method: 'GET', url: '/v1/mailboxes/X/messages/abc/attachments/2/text' },
        { method: 'PUT', url: '/v1/mailboxes/X/messages/abc/flags', payload: { add: ['\\Seen'] } },
        { method: 'PUT', url: '/v1/mailboxes/X/messages/abc/move', payload: { path: 'Archive' } },
        { method: 'DELETE', url: '/v1/mailboxes/X/messages/abc' }
    ];
    try {
        for (const req of bad) {
            const res = await app.inject(req);
            assert.equal(res.statusCode, 400, `${req.url} → ${res.statusCode}: ${res.body}`);
            assert.match(JSON.parse(res.body).detail, /uid/i);
        }
        assert.equal(pool.calls.uids.length, 0, 'a malformed uid must be rejected before IMAP');
    } finally {
        config.ocr.apiKey = savedOcrKey;
        await app.close();
    }
});

test('H: uids that look numeric but are not positive integers are 400s', async () => {
    const { app, pool } = await buildApp();
    try {
        for (const uid of ['0', '1.5', '1e3', '-1', '99999999999999999999']) {
            const res = await app.inject({ method: 'GET', url: `/v1/mailboxes/X/messages/${encodeURIComponent(uid)}` });
            assert.equal(res.statusCode, 400, `uid ${uid} → ${res.statusCode}: ${res.body}`);
        }
        assert.equal(pool.calls.uids.length, 0);
    } finally {
        await app.close();
    }
});

test('H: a valid uid still reaches IMAP untouched', async () => {
    const { app, pool } = await buildApp();
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/mailboxes/X/messages/5' });
        assert.equal(res.statusCode, 204, res.body);
        assert.deepEqual(pool.calls.uids, ['5']);
        assert.equal(pool.calls.lockPath, 'X');
    } finally {
        await app.close();
    }
});
