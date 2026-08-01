'use strict';

// `has:attachment` is advertised in the search UI but matched nothing: it
// was translated to the IMAP keyword $HasAttachment, which Dovecot never
// sets. The query has to agree with the paperclip the list already shows,
// so it is now decided from the MIME structure with the same counter.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const messageRoutes = require('../../src/routes/messages');

// bodyStructure shapes as imapflow reports them.
const plainText = { type: 'text/plain' };
const withPdf = {
    type: 'multipart/mixed',
    childNodes: [
        { type: 'text/plain' },
        { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } }
    ]
};
const inlineImageOnly = {
    type: 'multipart/related',
    childNodes: [
        { type: 'text/html' },
        { type: 'image/png', disposition: 'inline', id: '<logo>' }
    ]
};

const MESSAGES = {
    10: plainText,
    11: withPdf,
    12: inlineImageOnly,
    13: withPdf
};

function makePool({ searchResult, onSearch }) {
    const client = {
        authenticated: true,
        usable: true,
        mailbox: { exists: Object.keys(MESSAGES).length, uidValidity: 1 },
        async getMailboxLock() { return { release() {} }; },
        async search(criteria) {
            onSearch?.(criteria);
            return searchResult;
        },
        async *fetch(uids, query) {
            const list = Array.isArray(uids) ? uids : [uids];
            for (const uid of list) {
                const bs = MESSAGES[uid];
                if (!bs) continue;
                const msg = { uid, seq: uid, flags: new Set(), size: 100, internalDate: new Date('2026-01-01'), bodyStructure: bs };
                if (query.envelope) msg.envelope = { subject: `m${uid}`, from: [], to: [] };
                yield msg;
            }
        }
    };
    return { async acquire() { return client; }, release() {}, discard() {} };
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

test('has:attachment returns only messages the UI marks as having attachments', async () => {
    const criteriaSeen = [];
    // The IMAP pre-filter narrows to multipart mail; 12 is multipart but
    // carries only an inline image, so it must still be excluded.
    const pool = makePool({ searchResult: [11, 12, 13], onSearch: (c) => criteriaSeen.push(c) });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/INBOX/messages?search=' + encodeURIComponent('has:attachment')
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);

        const uids = body.messages.map((m) => m.uid).sort((a, b) => a - b);
        assert.deepEqual(uids, [11, 13]);
        assert.equal(body.total, 2, 'total must count only real matches');

        // Every returned row also reports hasAttachments, so the query and
        // the paperclip agree.
        for (const m of body.messages) assert.equal(m.hasAttachments, true);

        // And it must not be asking for the keyword Dovecot never sets.
        assert.equal(JSON.stringify(criteriaSeen[0]).includes('$HasAttachment'), false);

        // imapflow compiles `header` by walking Object.keys(), so it must
        // be an object keyed by header name. An array compiled to
        // "HEADER 0 content-type" and silently matched nothing — which is
        // how this shipped broken the first time.
        const header = criteriaSeen[0].header;
        assert.equal(Array.isArray(header), false, 'header criteria must not be an array');
        assert.equal(typeof header, 'object');
        assert.deepEqual(Object.keys(header), ['content-type']);
        assert.match(header['content-type'], /^multipart\//);
    } finally { await app.close(); }
});

test('has:attachment combines with other tokens', async () => {
    const criteriaSeen = [];
    const pool = makePool({ searchResult: [11], onSearch: (c) => criteriaSeen.push(c) });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/INBOX/messages?search=' + encodeURIComponent('from:bob has:attachment')
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(JSON.parse(res.body).messages.map((m) => m.uid), [11]);
        assert.equal(criteriaSeen[0].from, 'bob', 'other tokens must survive');
    } finally { await app.close(); }
});

test('a search with no attachment token is unaffected', async () => {
    const pool = makePool({ searchResult: [10, 11] });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/INBOX/messages?search=' + encodeURIComponent('from:bob')
        });
        const uids = JSON.parse(res.body).messages.map((m) => m.uid).sort((a, b) => a - b);
        // Includes the plain-text message: no attachment filtering applied.
        assert.deepEqual(uids, [10, 11]);
    } finally { await app.close(); }
});
