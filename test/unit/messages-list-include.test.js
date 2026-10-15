'use strict';

// `include` is the list endpoint's opt-in for the two per-item extras that
// are expensive on a Gmail-synced folder: `attachments` (bodyStructure, which
// forces Google to pull the whole message) and `auth` (a second
// BODY[HEADER.FIELDS] round trip for the Authentication-Results header).
// The default fetch must ask for neither, and a caller that names one must
// not silently pay for the other. Unknown tokens are a client mistake, not a
// reason to guess — they are a 400 before any IMAP work happens.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const messageRoutes = require('../../src/routes/messages');

// A multipart message with one real attachment.
const WITH_PDF = {
    type: 'multipart/mixed',
    childNodes: [
        { type: 'text/plain' },
        { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } }
    ]
};

const AUTH_HEADERS = Buffer.from(
    'Authentication-Results: mx.example.org;\r\n\tspf=pass dkim=pass dmarc=pass\r\n',
    'utf8'
);

// The fake honours the fetch query the way a real IMAP server does: a
// bodyStructure or a header blob comes back only when it was asked for.
// That is what makes "the default asks for neither" observable in the
// response, not just in the recorded query.
function makePool() {
    const calls = { fetches: [] };
    const client = {
        authenticated: true,
        usable: true,
        mailbox: { exists: 1, uidValidity: 1 },
        async getMailboxLock() { return { release() {} }; },
        async search() { return [5]; },
        async *fetch(uids, query, opts) {
            const list = Array.isArray(uids) ? uids : [uids];
            calls.fetches.push({ uids: list, query, opts });
            for (const uid of list) {
                const msg = {
                    uid,
                    seq: uid,
                    flags: new Set(),
                    size: 100,
                    internalDate: new Date('2026-01-01T00:00:00Z'),
                    envelope: { subject: `m${uid}`, from: [], to: [] }
                };
                if (query.bodyStructure) msg.bodyStructure = WITH_PDF;
                if (query.headers) msg.headers = AUTH_HEADERS;
                yield msg;
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

async function list(pool, query = '') {
    const app = await buildApp(pool);
    try {
        const res = await app.inject({ method: 'GET', url: `/v1/mailboxes/INBOX/messages${query}` });
        return { status: res.statusCode, body: JSON.parse(res.body) };
    } finally {
        await app.close();
    }
}

test('the default list fetches envelope + flags only, no bodyStructure and no headers', async () => {
    const pool = makePool();
    const { status, body } = await list(pool);
    assert.equal(status, 200);
    assert.equal(pool.calls.fetches.length, 1);
    const query = pool.calls.fetches[0].query;
    assert.equal(query.bodyStructure, undefined, 'bodyStructure must be opt-in');
    assert.equal(query.headers, undefined, 'auth headers must be opt-in');
    assert.equal(query.envelope, true);
    assert.equal(query.flags, true);
    const [m] = body.messages;
    assert.equal('hasAttachments' in m, false);
    assert.equal('attachmentCount' in m, false);
    assert.equal('auth' in m, false);
});

test('include=attachments adds bodyStructure and the attachment fields, and nothing else', async () => {
    const pool = makePool();
    const { status, body } = await list(pool, '?include=attachments');
    assert.equal(status, 200);
    const query = pool.calls.fetches[0].query;
    assert.equal(query.bodyStructure, true);
    assert.equal(query.headers, undefined, 'auth must not ride along with attachments');
    const [m] = body.messages;
    assert.equal(m.hasAttachments, true);
    assert.equal(m.attachmentCount, 1);
    assert.equal('auth' in m, false);
});

test('include=auth adds the two authentication-results headers only', async () => {
    const pool = makePool();
    const { status, body } = await list(pool, '?include=auth');
    assert.equal(status, 200);
    const query = pool.calls.fetches[0].query;
    assert.equal(query.bodyStructure, undefined, 'attachments must not ride along with auth');
    assert.deepEqual(query.headers, ['authentication-results', 'arc-authentication-results']);
    const [m] = body.messages;
    assert.equal('hasAttachments' in m, false);
    assert.deepEqual(m.auth, { spf: 'pass', dkim: 'pass', dmarc: 'pass' });
});

test('include=attachments,auth adds both', async () => {
    const pool = makePool();
    const { status, body } = await list(pool, '?include=attachments%2Cauth');
    assert.equal(status, 200);
    const query = pool.calls.fetches[0].query;
    assert.equal(query.bodyStructure, true);
    assert.deepEqual(query.headers, ['authentication-results', 'arc-authentication-results']);
    const [m] = body.messages;
    assert.equal(m.hasAttachments, true);
    assert.equal(m.attachmentCount, 1);
    assert.equal(m.auth.spf, 'pass');
});

test('an unknown include value is a 400 and never reaches IMAP', async () => {
    const pool = makePool();
    const { status, body } = await list(pool, '?include=body');
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(body.detail, /Unknown include value "body"/);
    assert.match(body.detail, /attachments and\/or auth/);
    assert.equal(pool.calls.fetches.length, 0);
});

test('empty and whitespace tokens are ignored', async () => {
    const pool = makePool();
    const { status } = await list(pool, '?include=attachments%2C%20%2Cauth');
    assert.equal(status, 200);
    const query = pool.calls.fetches[0].query;
    assert.equal(query.bodyStructure, true);
    assert.deepEqual(query.headers, ['authentication-results', 'arc-authentication-results']);
});
