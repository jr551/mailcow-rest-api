'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { backoffFor } = require('../../src/webhook-forwarder');
const { createWebhookStore } = require('../../src/webhook-store');

// The forwarder deletes mail, so the rules that decide *when* it deletes
// are the ones worth pinning down.

test('webhook backoff grows then settles at a daily retry', () => {
    assert.equal(backoffFor(1), 60_000);
    assert.equal(backoffFor(2), 5 * 60_000);
    assert.equal(backoffFor(7), 12 * 60 * 60_000);
    // Past the ramp, retries stay daily rather than growing without bound.
    assert.equal(backoffFor(8), 24 * 60 * 60_000);
    assert.equal(backoffFor(50), 24 * 60 * 60_000);
});

test('webhook store: failures accumulate attempts and honour next_attempt_at', () => {
    const store = createWebhookStore({ filePath: ':memory:' });
    try {
        assert.equal(store.get('a@x.com', 1, 10), null);

        const now = Date.now();
        store.recordFailure('a@x.com', 1, 10, {
            attempts: 1, nextAttemptAt: now + 60_000, error: 'boom'
        });
        let row = store.get('a@x.com', 1, 10);
        assert.equal(row.attempts, 1);
        assert.equal(row.giving_up, 0);
        assert.ok(row.next_attempt_at > now);

        store.recordFailure('a@x.com', 1, 10, {
            attempts: 2, nextAttemptAt: now + 300_000, error: 'boom again'
        });
        row = store.get('a@x.com', 1, 10);
        assert.equal(row.attempts, 2);
        assert.equal(row.last_error, 'boom again');
    } finally { store.close(); }
});

test('webhook store: uid is scoped by uidvalidity', () => {
    const store = createWebhookStore({ filePath: ':memory:' });
    try {
        store.recordFailure('a@x.com', 1, 10, { attempts: 3, nextAttemptAt: 0, error: 'e' });
        // Same UID under a new validity generation is a different message
        // and must not inherit the old one's attempt count.
        assert.equal(store.get('a@x.com', 2, 10), null);
        assert.equal(store.get('a@x.com', 1, 10).attempts, 3);
    } finally { store.close(); }
});

test('webhook store: giving_up is recorded and clear() removes the row', () => {
    const store = createWebhookStore({ filePath: ':memory:' });
    try {
        store.recordFailure('a@x.com', 1, 10, {
            attempts: 14, nextAttemptAt: 0, error: 'dead', givingUp: true
        });
        assert.equal(store.get('a@x.com', 1, 10).giving_up, 1);
        // Given-up rows don't count as pending work.
        assert.equal(store.pendingCount(), 0);

        assert.equal(store.clear('a@x.com', 1, 10), 1);
        assert.equal(store.get('a@x.com', 1, 10), null);
    } finally { store.close(); }
});

test('webhook store: state survives reopening the same file', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-'));
    const file = path.join(dir, 'webhooks.db');
    try {
        const first = createWebhookStore({ filePath: file });
        first.recordFailure('a@x.com', 5, 42, {
            attempts: 3, nextAttemptAt: Date.now() + 900_000, error: 'upstream 500'
        });
        first.close();

        // A restart mid-backoff must not reset the attempt count, or a
        // crash-looping server would re-POST the same message forever.
        const second = createWebhookStore({ filePath: file });
        try {
            const row = second.get('a@x.com', 5, 42);
            assert.equal(row.attempts, 3);
            assert.equal(row.last_error, 'upstream 500');
        } finally { second.close(); }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('webhook config: only well-formed http(s) accounts are accepted', () => {
    const prev = process.env.WEBHOOK_ACCOUNTS;
    try {
        process.env.WEBHOOK_ACCOUNTS = JSON.stringify([
            { address: 'ok@x.com', password: 'p', url: 'https://hooks.example.com/in' },
            { address: 'no-url@x.com', password: 'p' },
            { address: 'bad-scheme@x.com', password: 'p', url: 'file:///etc/passwd' },
            { address: 'no-pass@x.com', url: 'https://hooks.example.com/in' },
            { address: 'custom@x.com', password: 'p', url: 'http://h.example.com/in', mailbox: 'Feeds', secret: 's' }
        ]);
        delete require.cache[require.resolve('../../src/config')];
        const cfg = require('../../src/config');
        const addrs = cfg.webhooks.accounts.map((a) => a.address);
        assert.deepEqual(addrs, ['ok@x.com', 'custom@x.com']);
        assert.equal(cfg.webhooks.accounts[0].mailbox, 'INBOX');
        assert.equal(cfg.webhooks.accounts[1].mailbox, 'Feeds');
        assert.equal(cfg.webhooks.accounts[1].secret, 's');
    } finally {
        if (prev === undefined) delete process.env.WEBHOOK_ACCOUNTS;
        else process.env.WEBHOOK_ACCOUNTS = prev;
        delete require.cache[require.resolve('../../src/config')];
    }
});

// End-to-end over a real HTTP listener with a stubbed IMAP client, so the
// ordering guarantee (never delete before a 2xx) is actually exercised.
function makeFakeImap({ uids, onDelete, opts }) {
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
                envelope: { subject: `msg-${uid}`, from: [{ name: 'A', address: 'a@x.com' }] },
                internalDate: new Date('2026-01-01T00:00:00Z'),
                size: 10,
                flags: new Set(['\\Seen']),
                bodyStructure: {
                    type: 'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain', part: '1' },
                        {
                            type: 'application/pdf', part: '2',
                            disposition: 'attachment',
                            dispositionParameters: { filename: 'invoice.pdf' },
                            size: 11
                        }
                    ]
                },
                source: Buffer.from(`Subject: msg-${uid}\r\n\r\nbody`)
            };
        },
        async download(uid, part) {
            const { Readable } = require('node:stream');
            const body = part === '2' ? Buffer.from('PDF-BYTES-1') : Buffer.from('the readable body text');
            return { content: Readable.from([body]) };
        },
        async messageDelete(uid) {
            onDelete(Number(uid));
            if (opts && opts.deleteFails) throw new Error('connection reset during delete');
            return true;
        }
    };
}

async function runForwarder(opts) {
    const { status, uids, maxAttempts = 14 } = opts;
    const http = require('node:http');
    const received = [];
    const deleted = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            received.push({
                body: JSON.parse(body),
                rawBody: body,
                timestamp: req.headers['x-webhook-timestamp'],
                signature: req.headers['x-webhook-signature-v2'],
                legacySignature: req.headers['x-webhook-signature']
            });
            res.writeHead(status).end('{}');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/hook`;

    const store = createWebhookStore({ filePath: ':memory:' });
    const cfg = {
        imap: { host: 'x', port: 993, secure: true, rejectUnauthorized: false, tlsServername: '', connectTimeoutMs: 5000 },
        webhooks: {
            accounts: [{ address: 'f@x.com', password: 'p', url, mailbox: 'INBOX', secret: 'shh' }],
            pollIntervalMs: 60_000, timeoutMs: 5000, maxAttempts, maxMessageBytes: 1024 * 1024,
            includeAttachments: opts.includeAttachments !== false,
            maxAttachmentBytes: opts.maxAttachmentBytes ?? 1024 * 1024,
            maxAttachmentsTotalBytes: opts.maxAttachmentsTotalBytes ?? 1024 * 1024
        }
    };

    const { createWebhookForwarder } = require('../../src/webhook-forwarder');
    const fake = makeFakeImap({ uids, onDelete: (u) => deleted.push(u), opts });
    const forwarder = createWebhookForwarder({
        config: cfg, store, logger: null, connect: () => fake
    });

    await forwarder.tick();
    if (opts.secondTick) await forwarder.tick();
    await new Promise((r) => server.close(r));
    return { received, deleted, store };
}

test('webhook: message is POSTed with a signature and deleted only after 2xx', async () => {
    const { received, deleted, store } = await runForwarder({ status: 200, uids: [11] });
    try {
        assert.equal(received.length, 1);
        assert.equal(received[0].body.uid, 11);
        assert.equal(received[0].body.envelope.subject, 'msg-11');
        assert.equal(Buffer.from(received[0].body.raw.data, 'base64').toString().includes('msg-11'), true);
        // V2: hex HMAC over "<timestamp>.<raw body>", so the signature is
        // bound to a moment in time and a replay can be rejected on age.
        assert.match(received[0].timestamp, /^\d{10}$/);
        const expected = require('node:crypto')
            .createHmac('sha256', 'shh')
            .update(`${received[0].timestamp}.${received[0].rawBody}`)
            .digest('hex');
        assert.equal(received[0].signature, expected);
        // The legacy body-only header must be gone: leaving it in place
        // would let an attacker drop the V2 headers and replay freely.
        assert.equal(received[0].legacySignature, undefined);
        assert.deepEqual(deleted, [11]);
        // Delivered rows are cleared, not left pending.
        assert.equal(store.get('f@x.com', 7, 11), null);
    } finally { store.close(); }
});

test('webhook: a failing endpoint never deletes the message and schedules a retry', async () => {
    const { received, deleted, store } = await runForwarder({ status: 500, uids: [12] });
    try {
        assert.equal(received.length, 1);
        // The critical guarantee: the only copy of the mail still exists.
        assert.deepEqual(deleted, []);
        const row = store.get('f@x.com', 7, 12);
        assert.equal(row.attempts, 1);
        assert.equal(row.giving_up, 0);
        assert.ok(row.next_attempt_at > Date.now());
    } finally { store.close(); }
});

test('webhook: a delete failure after a successful POST does not re-POST', async () => {
    // The POST succeeded but the IMAP delete threw. The message is still in
    // the mailbox, so the next poll finds it again — and must NOT deliver it
    // a second time (which would be a duplicate ticket on the receiver). It
    // retries only the delete.
    const { received, deleted, store } = await runForwarder({
        status: 200, uids: [21], deleteFails: true, secondTick: true
    });
    try {
        // Delivered exactly once across both polls, delete attempted twice.
        assert.equal(received.length, 1, 'POSTed once, not re-POSTed');
        assert.deepEqual(deleted, [21, 21], 'delete retried on the second poll');
        // Still tracked as delivered-but-undeleted, not cleared.
        const row = store.get('f@x.com', 7, 21);
        assert.ok(row, 'still tracked');
        assert.equal(row.delivered, 1);
    } finally { store.close(); }
});

test('webhook: stops retrying after maxAttempts and leaves the message in place', async () => {
    const { deleted, store } = await runForwarder({ status: 500, uids: [13], maxAttempts: 1 });
    try {
        assert.deepEqual(deleted, []);
        assert.equal(store.get('f@x.com', 7, 13).giving_up, 1);
    } finally { store.close(); }
});

test('payload carries a decoded body, not just base64', async () => {
    // A receiver is usually a model or a script; neither can do anything
    // with base64. Shipping only `raw` meant the body was effectively
    // unreadable and inflated the payload by a third.
    const { received, store } = await runForwarder({ status: 200, uids: [14] });
    try {
        const body = received[0].body;
        assert.equal(body.text, 'the readable body text');
        assert.ok('html' in body, 'html key must be present even when null');
        assert.ok(Array.isArray(body.attachments));
        // Raw is still there for anything that wants to parse MIME itself.
        assert.equal(body.raw.encoding, 'base64');
        assert.ok(body.raw.data.length > 0);
    } finally { store.close(); }
});

test('attachment bytes are included, not just a manifest', async () => {
    // Telling a receiver an invoice exists without giving it the invoice
    // means it has to re-parse MIME out of the raw source — the work this
    // payload exists to avoid.
    const { received, store } = await runForwarder({ status: 200, uids: [15] });
    try {
        const att = received[0].body.attachments;
        assert.equal(att.length, 1);
        assert.equal(att[0].filename, 'invoice.pdf');
        assert.equal(att[0].contentType, 'application/pdf');
        assert.equal(att[0].included, true);
        assert.equal(att[0].encoding, 'base64');
        assert.equal(Buffer.from(att[0].content, 'base64').toString(), 'PDF-BYTES-1');
    } finally { store.close(); }
});

test('an oversized attachment is flagged, never silently dropped', async () => {
    const { received, store } = await runForwarder({ status: 200, uids: [16], maxAttachmentBytes: 4 });
    try {
        const att = received[0].body.attachments[0];
        // The receiver still learns something was attached and why it is
        // missing, rather than seeing an empty list.
        assert.equal(att.included, false);
        assert.equal(att.content, null);
        assert.equal(att.filename, 'invoice.pdf');
        assert.match(att.omittedReason, /limit/);
    } finally { store.close(); }
});

test('attachments can be turned off entirely', async () => {
    const { received, store } = await runForwarder({ status: 200, uids: [17], includeAttachments: false });
    try {
        const att = received[0].body.attachments[0];
        assert.equal(att.included, false);
        assert.equal(att.content, null);
        assert.match(att.omittedReason, /disabled/);
    } finally { store.close(); }
});
