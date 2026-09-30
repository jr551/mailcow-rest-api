'use strict';

// Regression test: delivery state must be scoped to the MAILBOX it describes,
// not to the user. The outbound queue was keyed (user, uidvalidity, uid) while
// every webhook polls its own hidden mailbox (.wh-<id>) with its own UID
// space — so two webhooks for one user alias each other's state whenever their
// UIDVALIDITY values coincide (same-second folder creation, or the ?? 0
// fallback). Concretely, a leftover `delivered` row from webhook A made
// webhook B DELETE its own never-POSTed message ("already delivered, retry
// the mailbox action"), and a leftover `giving_up` row made webhook B skip
// its message forever — silent message loss in both directions.

const test = require('node:test');
const assert = require('node:assert');
const { createOutboundWebhookForwarder } = require('../../src/outbound-webhook-forwarder');
const { createOutboundWebhookStore } = require('../../src/outbound-webhook-store');
const { createWebhookStore } = require('../../src/webhook-store');

const fakeBox = {
    encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
    decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
};
const silentLog = { info() {}, warn() {}, error() {} };

function fakeImap() {
    const calls = { deleted: [], moved: [], appended: [] };
    const client = {
        mailbox: { uidValidity: 42, exists: 1 },
        on() {},
        async connect() {},
        async getMailboxLock() { return { release() {} }; },
        async search() { return [1]; },
        async fetchOne() {
            return {
                uid: 1,
                envelope: {
                    subject: 'hi',
                    from: [{ address: 'a@b.c', name: 'A' }],
                    to: [{ address: 'me@example.com' }]
                },
                internalDate: new Date('2026-09-27T10:00:00Z'),
                size: 10,
                flags: new Set(),
                bodyStructure: { part: '1', type: 'text/plain' },
                source: Buffer.from('Subject: hi\r\nFrom: a@b.c\r\n\r\nbody text\n')
            };
        },
        async download() {
            return { content: (async function* () { yield Buffer.from('body text\n'); })() };
        },
        async messageDelete(uid) { calls.deleted.push(uid); },
        async messageMove(uid, dest) { calls.moved.push({ uid, dest }); },
        async append(folder, buf, flags) { calls.appended.push({ folder, buf, flags }); },
        async logout() {},
        close() {}
    };
    return { client, calls };
}

function setup() {
    const store = createOutboundWebhookStore({ filePath: ':memory:', secretBox: fakeBox, maxPerUser: 5 });
    const queue = createWebhookStore({ filePath: ':memory:' });
    const created = store.create({
        user: 'me@example.com',
        password: 'pw',
        label: 'B',
        url: 'https://b.example/hook',
        keep: false
    });
    const { client, calls } = fakeImap();
    const http = { seen: [], fn: async (url, opts) => {
        http.seen.push({ url, opts });
        return { statusCode: 200, body: { text: async () => 'ok' } };
    } };
    const forwarder = createOutboundWebhookForwarder({
        config: {
            imap: { host: 'h', port: 993, secure: true, rejectUnauthorized: true, connectTimeoutMs: 1000 },
            outboundWebhooks: {
                pollIntervalMs: 60_000,
                timeoutMs: 5_000,
                maxAttempts: 3,
                maxMessageBytes: 1024 * 1024,
                includeAttachments: true,
                maxAttachmentBytes: 1024 * 1024,
                maxAttachmentsTotalBytes: 1024 * 1024
            }
        },
        store,
        queue,
        logger: silentLog,
        connect: async () => client,
        request: http.fn
    });
    return { store, queue, created, calls, http, forwarder };
}

test("a leftover delivered row from another webhook must not destroy this webhook's unPOSTed message", async () => {
    const { queue, created, calls, http, forwarder } = setup();

    // State webhook A left behind when its mailbox action failed after a
    // confirmed POST (same user, coincident UIDVALIDITY, same UID 1 in A's
    // own folder). It says nothing about webhook B's message.
    queue.recordDelivered('me@example.com', 42, 1);

    await forwarder.tick();

    assert.strictEqual(http.seen.length, 1,
        "webhook B's message must be POSTed to webhook B's endpoint");
    assert.ok(http.seen[0].url.startsWith('https://b.example/'));
    assert.deepStrictEqual(calls.deleted, ['1'], 'and then acted on after its own POST');
    // Its own state is cleaned up under its own key.
    assert.strictEqual(queue.get(created.mailbox, 42, 1), null);
});

test("a leftover giving-up row from another webhook must not suppress this webhook's message forever", async () => {
    const { queue, http, forwarder } = setup();

    queue.recordFailure('me@example.com', 42, 1, {
        attempts: 3,
        nextAttemptAt: 0,
        error: 'some other webhook gave up on its own message',
        givingUp: true
    });

    await forwarder.tick();

    assert.strictEqual(http.seen.length, 1,
        "webhook B's message must not inherit webhook A's permanent failure");
});

test('the same webhook still sees its own delivered-unfiled state (no re-POST, retry mailbox action only)', async () => {
    const { queue, created, calls, http, forwarder } = setup();

    queue.recordDelivered(created.mailbox, 42, 1);

    await forwarder.tick();

    assert.strictEqual(http.seen.length, 0, 'an already-POSTed message is never re-POSTed');
    assert.deepStrictEqual(calls.deleted, ['1'], 'only the mailbox action is retried');
    assert.strictEqual(queue.get(created.mailbox, 42, 1), null);
});
