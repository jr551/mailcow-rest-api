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
function makeFakeImap({ uids, onDelete }) {
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
                source: Buffer.from(`Subject: msg-${uid}\r\n\r\nbody`)
            };
        },
        async messageDelete(uid) { onDelete(Number(uid)); return true; }
    };
}

async function runForwarder({ status, uids, maxAttempts = 14 }) {
    const http = require('node:http');
    const received = [];
    const deleted = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            received.push({ body: JSON.parse(body), signature: req.headers['x-webhook-signature'] });
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
            pollIntervalMs: 60_000, timeoutMs: 5000, maxAttempts, maxMessageBytes: 1024 * 1024
        }
    };

    const { createWebhookForwarder } = require('../../src/webhook-forwarder');
    const fake = makeFakeImap({ uids, onDelete: (u) => deleted.push(u) });
    const forwarder = createWebhookForwarder({
        config: cfg, store, logger: null, connect: () => fake
    });

    await forwarder.tick();
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
        assert.match(received[0].signature, /^sha256=[0-9a-f]{64}$/);
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

test('webhook: stops retrying after maxAttempts and leaves the message in place', async () => {
    const { deleted, store } = await runForwarder({ status: 500, uids: [13], maxAttempts: 1 });
    try {
        assert.deepEqual(deleted, []);
        assert.equal(store.get('f@x.com', 7, 13).giving_up, 1);
    } finally { store.close(); }
});
