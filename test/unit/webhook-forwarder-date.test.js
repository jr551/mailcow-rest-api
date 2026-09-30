'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Readable } = require('node:stream');

const { createWebhookStore } = require('../../src/webhook-store');
const { createWebhookForwarder } = require('../../src/webhook-forwarder');

// imapflow hands back the raw header text when it cannot parse a Date, so
// buildPayload() used to do `new Date(<garbage>).toISOString()` and throw a
// RangeError *before* the POST. The attempt was then recorded as a delivery
// failure and retried into giving_up — the message is stranded for a reason
// neither the receiver nor the operator can see, over a field that is pure
// metadata. Both date fields in the payload carry the same hazard.

function makeFakeImap({ uids, envelopeDate, internalDate, onDelete }) {
    return {
        mailbox: { exists: uids.length, uidValidity: 7 },
        on() {},
        async connect() {},
        async logout() {},
        close() {},
        async getMailboxLock() { return { release() {} }; },
        async search() { return uids.slice(); },
        async fetchOne(uid) {
            return {
                uid: Number(uid),
                envelope: {
                    subject: `msg-${uid}`,
                    date: envelopeDate,
                    from: [{ name: 'A', address: 'a@x.com' }]
                },
                internalDate,
                size: 10,
                flags: new Set(['\\Seen']),
                bodyStructure: {
                    type: 'multipart/mixed',
                    childNodes: [{ type: 'text/plain', part: '1' }]
                },
                source: Buffer.from(`Subject: msg-${uid}\r\n\r\nbody`)
            };
        },
        async download() {
            return { content: Readable.from([Buffer.from('the readable body text')]) };
        },
        async messageDelete(uid) {
            onDelete(Number(uid));
            return true;
        }
    };
}

async function runForwarder({ uids, envelopeDate, internalDate }) {
    const received = [];
    const deleted = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            received.push(JSON.parse(body));
            res.writeHead(200).end('{}');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/hook`;

    const store = createWebhookStore({ filePath: ':memory:' });
    const cfg = {
        imap: { host: 'x', port: 993, secure: true, rejectUnauthorized: false, tlsServername: '', connectTimeoutMs: 5000 },
        webhooks: {
            accounts: [{ address: 'f@x.com', password: 'p', url, mailbox: 'INBOX', secret: 'shh' }],
            pollIntervalMs: 60_000, timeoutMs: 5000, maxAttempts: 14, maxMessageBytes: 1024 * 1024,
            includeAttachments: true,
            maxAttachmentBytes: 1024 * 1024,
            maxAttachmentsTotalBytes: 1024 * 1024
        }
    };

    const fake = makeFakeImap({
        uids, envelopeDate, internalDate, onDelete: (u) => deleted.push(u)
    });
    const forwarder = createWebhookForwarder({
        config: cfg, store, logger: null, connect: () => fake
    });

    await forwarder.tick();
    await new Promise((r) => server.close(r));
    return { received, deleted, store };
}

test('webhook: unparseable envelope date is delivered as null, not stranded', async () => {
    const { received, deleted, store } = await runForwarder({
        uids: [31],
        // What imapflow hands back when the Date header is unparseable.
        envelopeDate: 'Thu, 31 Bad 2026 99:99:99 +0000',
        internalDate: new Date('2026-01-01T00:00:00Z')
    });
    try {
        assert.equal(received.length, 1, 'payload must still be POSTed');
        assert.equal(received[0].uid, 31);
        assert.equal(received[0].envelope.date, null, 'garbage date degrades to null');
        assert.equal(deleted.length, 1, 'delivered message is deleted after 2xx');
        // No retry row: the delivery succeeded, so nothing is stranded.
        assert.equal(store.get('f@x.com', 7, 31), null);
    } finally { store.close(); }
});

test('webhook: unparseable internalDate is delivered as null, not stranded', async () => {
    const { received, deleted, store } = await runForwarder({
        uids: [32],
        envelopeDate: new Date('2026-01-01T00:00:00Z'),
        internalDate: 'not-a-date-at-all'
    });
    try {
        assert.equal(received.length, 1, 'payload must still be POSTed');
        assert.equal(received[0].internalDate, null, 'garbage internalDate degrades to null');
        assert.equal(deleted.length, 1, 'delivered message is deleted after 2xx');
        assert.equal(store.get('f@x.com', 7, 32), null);
    } finally { store.close(); }
});

test('webhook: a garbage date does not burn an attempt on a failing endpoint', async () => {
    // Same garbage-date message but the receiver is down: the retry state
    // must be about the endpoint (1 attempt), never about the date parse.
    const received = [];
    const deleted = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            received.push(JSON.parse(body));
            res.writeHead(500).end('{}');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/hook`;
    const store = createWebhookStore({ filePath: ':memory:' });
    const cfg = {
        imap: { host: 'x', port: 993, secure: true, rejectUnauthorized: false, tlsServername: '', connectTimeoutMs: 5000 },
        webhooks: {
            accounts: [{ address: 'f@x.com', password: 'p', url, mailbox: 'INBOX' }],
            pollIntervalMs: 60_000, timeoutMs: 5000, maxAttempts: 14, maxMessageBytes: 1024 * 1024,
            includeAttachments: true, maxAttachmentBytes: 1024 * 1024, maxAttachmentsTotalBytes: 1024 * 1024
        }
    };
    const fake = makeFakeImap({
        uids: [33],
        envelopeDate: 'garbage',
        internalDate: new Date('2026-01-01T00:00:00Z'),
        onDelete: (u) => deleted.push(u)
    });
    const forwarder = createWebhookForwarder({ config: cfg, store, logger: null, connect: () => fake });
    try {
        await forwarder.tick();
        await new Promise((r) => server.close(r));
        assert.equal(received.length, 1, 'the POST is attempted despite the garbage date');
        const row = store.get('f@x.com', 7, 33);
        assert.equal(row.attempts, 1);
        assert.equal(row.giving_up, 0);
        assert.match(row.last_error, /Webhook returned 500/);
    } finally { store.close(); }
});
