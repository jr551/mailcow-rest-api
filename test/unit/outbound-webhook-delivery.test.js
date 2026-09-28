'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createOutboundWebhookForwarder } = require('../../src/outbound-webhook-forwarder');
const { createOutboundWebhookStore } = require('../../src/outbound-webhook-store');
const { createWebhookStore } = require('../../src/webhook-store');

const fakeBox = {
    encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
    decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
};

const silentLog = { info() {}, warn() {}, error() {} };

// A minimal IMAP stand-in. The forwarder only uses a handful of calls, so the
// fake records what happened instead of pretending to be a server.
function fakeImap({ uids = [1], source = 'Subject: hi\r\nFrom: a@b.c\r\n\r\nbody text\n' } = {}) {
    const calls = { deleted: [], moved: [], appended: [], released: 0 };
    const client = {
        mailbox: { uidValidity: 42, exists: uids.length },
        on() {},
        async connect() {},
        async getMailboxLock() { return { release: () => { calls.released++; } }; },
        async search() { return uids; },
        async fetchOne() {
            return {
                uid: uids[0],
                envelope: {
                    subject: 'hi',
                    from: [{ address: 'a@b.c', name: 'A' }],
                    to: [{ address: 'me@example.com' }]
                },
                internalDate: new Date('2026-09-27T10:00:00Z'),
                size: source.length,
                flags: new Set(),
                bodyStructure: { part: '1', type: 'text/plain' },
                source: Buffer.from(source)
            };
        },
        async download(uid, part) {
            // The text part must come back as a stream, or body extraction
            // yields nothing and the payload has no readable content.
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

function makeConfig(overrides = {}) {
    return {
        imap: { host: 'h', port: 993, secure: true, rejectUnauthorized: true, connectTimeoutMs: 1000 },
        outboundWebhooks: {
            pollIntervalMs: 60_000,
            timeoutMs: 5_000,
            maxAttempts: 3,
            maxMessageBytes: 1024 * 1024,
            includeAttachments: true,
            maxAttachmentBytes: 1024 * 1024,
            maxAttachmentsTotalBytes: 1024 * 1024,
            ...overrides
        }
    };
}

// The forwarder takes an injectable `request` (same idea as its injectable
// `connect`), so the HTTP side is driven without a live endpoint.
function stubHttp(status, bodyText = 'ok') {
    const seen = [];
    const fn = async (url, opts) => {
        seen.push({ url, opts });
        return { statusCode: status, body: { text: async () => bodyText } };
    };
    return { seen, fn };
}

function setup({ httpStatus = 200, keep = false, prepend = '', headers, client: clientOverride } = {}) {
    const store = createOutboundWebhookStore({ filePath: ':memory:', secretBox: fakeBox, maxPerUser: 5 });
    const queue = createWebhookStore({ filePath: ':memory:' });
    const created = store.create({
        user: 'me@example.com',
        password: 'pw',
        label: 'Invoices',
        url: 'https://receiver.example/hook',
        keep,
        prepend,
        headers
    });
    const { client, calls } = clientOverride ? { client: clientOverride, calls: clientOverride.__calls } : fakeImap();
    const http = stubHttp(httpStatus);
    const forwarder = createOutboundWebhookForwarder({
        config: makeConfig(),
        store,
        queue,
        logger: silentLog,
        connect: async () => client,
        request: http.fn
    });
    return { store, queue, created, calls, http, forwarder };
}

test('delivery: a 2xx with keep=false deletes the message and writes a Sent record', async () => {
    const { calls, http, forwarder, queue } = setup({ httpStatus: 200, keep: false });
    await forwarder.tick();
    assert.strictEqual(http.seen.length, 1);
    assert.deepStrictEqual(calls.deleted, ['1'], 'message deleted after delivery');
    assert.deepStrictEqual(calls.moved, [], 'not moved when keep is false');
    assert.strictEqual(calls.appended.length, 1, 'one Sent record');
    assert.strictEqual(calls.appended[0].folder, 'Sent');
    const record = calls.appended[0].buf.toString('utf8');
    assert.match(record, /Sent to webhook Invoices/);
    assert.match(record, /reply was HTTP 200 in \d+\.\d seconds/);
    // Delivered and acted on, so no retry state is left behind.
    assert.strictEqual(queue.get('me@example.com', 42, 1), null);
});

test('delivery: a 2xx with keep=true files the message back to INBOX instead of deleting', async () => {
    const { calls, http, forwarder } = setup({ httpStatus: 200, keep: true });
    await forwarder.tick();
    assert.strictEqual(http.seen.length, 1);
    assert.deepStrictEqual(calls.moved, [{ uid: '1', dest: 'INBOX' }]);
    assert.deepStrictEqual(calls.deleted, [], 'kept message must not be deleted');
    assert.strictEqual(calls.appended.length, 1);
});

test('delivery: a non-2xx schedules a retry and does NOT act on the message', async () => {
    const { calls, http, forwarder, queue } = setup({ httpStatus: 500 });
    await forwarder.tick();
    assert.strictEqual(http.seen.length, 1);
    assert.deepStrictEqual(calls.deleted, [], 'must not delete an undelivered message');
    assert.deepStrictEqual(calls.moved, [], 'must not file an undelivered message');
    const state = queue.get('me@example.com', 42, 1);
    assert.ok(state, 'failure recorded');
    assert.strictEqual(state.attempts, 1);
    assert.ok(state.next_attempt_at > Date.now(), 'retry scheduled in the future');
    assert.strictEqual(state.giving_up, 0);
    // The user still gets told what the webhook said back.
    assert.strictEqual(calls.appended.length, 1);
    assert.match(calls.appended[0].buf.toString('utf8'), /reply was HTTP 500/);
});

test('delivery: a retry is not attempted before its backoff elapses', async () => {
    const { http, forwarder, queue } = setup({ httpStatus: 500 });
    await forwarder.tick();
    const first = queue.get('me@example.com', 42, 1).attempts;
    // Immediately again: still inside the backoff window.
    await forwarder.tick();
    assert.strictEqual(queue.get('me@example.com', 42, 1).attempts, first, 'no second attempt yet');
    assert.strictEqual(http.seen.length, 1, 'no second POST');
});

test('delivery: repeated failures eventually give up and leave the message alone', async () => {
    const { calls, forwarder, queue } = setup({ httpStatus: 503 });
    // maxAttempts is 3; clear the backoff each round so the loop can drive
    // past it without waiting.
    for (let i = 0; i < 4; i++) {
        await forwarder.tick();
        const st = queue.get('me@example.com', 42, 1);
        if (st) {
            queue.recordFailure('me@example.com', 42, 1, {
                attempts: st.attempts,
                nextAttemptAt: 0,
                error: st.last_error,
                givingUp: st.giving_up
            });
        }
    }
    const state = queue.get('me@example.com', 42, 1);
    assert.strictEqual(state.giving_up, 1, 'gave up after maxAttempts');
    assert.deepStrictEqual(calls.deleted, [], 'message left in the mailbox for a human');
});

test('delivery: a delivered-but-unfiled message retries the mailbox action only, never the POST', async () => {
    const { calls, http, forwarder, queue } = setup({ httpStatus: 200, keep: false });
    // Simulate: POST confirmed, then the delete failed.
    queue.recordDelivered('me@example.com', 42, 1);
    await forwarder.tick();
    assert.strictEqual(http.seen.length, 0, 'must not re-POST an already-delivered message');
    assert.deepStrictEqual(calls.deleted, ['1'], 'retries the delete');
    assert.strictEqual(queue.get('me@example.com', 42, 1), null, 'cleared once the delete succeeds');
});

test('payload: the composed message carries the prepend and quotes the original', async () => {
    const { http, forwarder, created } = setup({
        httpStatus: 200,
        prepend: 'You are an invoicing agent with no other context.'
    });
    await forwarder.tick();
    assert.strictEqual(http.seen.length, 1);
    const payload = JSON.parse(http.seen[0].opts.body);
    assert.strictEqual(payload.webhook.id, created.id);
    assert.strictEqual(payload.webhook.label, 'Invoices');
    // The human-readable field a receiver with no context should read.
    assert.match(payload.message, /^You are an invoicing agent with no other context\./);
    assert.match(payload.message, /> body text/);
    // The original is still there untouched, so a receiver that parses mail
    // itself does not have to strip our markers back out.
    assert.strictEqual(payload.text, 'body text\n');
    assert.doesNotMatch(payload.text, />/);
});

test('payload: with no prepend the composed message is the original, unquoted', async () => {
    const { http, forwarder } = setup({ httpStatus: 200, prepend: '' });
    await forwarder.tick();
    const payload = JSON.parse(http.seen[0].opts.body);
    assert.strictEqual(payload.message, payload.text);
    assert.doesNotMatch(payload.message, />/);
});

test('payload: headers are included and the signature covers the exact bytes sent', async () => {
    const { http, forwarder, created } = setup({ httpStatus: 200 });
    await forwarder.tick();
    const payload = JSON.parse(http.seen[0].opts.body);
    assert.strictEqual(payload.headers.subject, 'hi');
    assert.strictEqual(payload.headers.from, 'a@b.c');
    assert.strictEqual(payload.envelope.subject, 'hi');

    const ts = http.seen[0].opts.headers['x-webhook-timestamp'];
    const expected = crypto.createHmac('sha256', created.secret)
        .update(`${ts}.${http.seen[0].opts.body}`).digest('hex');
    assert.strictEqual(http.seen[0].opts.headers['x-webhook-signature-v2'], expected);
});

test('payload: attachments are base64-of-gzip and round-trip to the original bytes', async () => {
    const original = Buffer.from('name,amount\nwidget,12.50\n', 'utf8');
    const { client, calls } = fakeImap();
    client.fetchOne = async () => ({
        uid: 1,
        envelope: { subject: 'hi', from: [{ address: 'a@b.c' }] },
        internalDate: new Date(),
        size: 10,
        flags: new Set(),
        bodyStructure: {
            part: '1',
            type: 'multipart/mixed',
            childNodes: [
                { part: '1', type: 'text/plain' },
                {
                    part: '2',
                    type: 'application/pdf',
                    disposition: 'attachment',
                    dispositionParameters: { filename: 'inv.csv' },
                    size: original.length
                }
            ]
        },
        source: Buffer.from('Subject: hi\r\n\r\nbody')
    });
    client.download = async () => ({ content: (async function* () { yield original; })() });
    client.__calls = calls;

    const { http, forwarder } = setup({ httpStatus: 200, client });
    await forwarder.tick();
    const payload = JSON.parse(http.seen[0].opts.body);
    const att = payload.attachments.find((a) => a.included);
    assert.ok(att, 'attachment included');
    assert.strictEqual(att.encoding, 'base64+gzip');
    assert.strictEqual(att.bytes, original.length);
    assert.match(att.instructions, /gunzip/i);
    assert.match(payload.attachmentInstructions, /gunzip/i);
    // The documented recovery path must actually reproduce the file.
    assert.deepStrictEqual(zlib.gunzipSync(Buffer.from(att.content, 'base64')), original);
});

test('delivery: a webhook with no usable credential is skipped, not thrown', async () => {
    const store = createOutboundWebhookStore({ filePath: ':memory:', secretBox: fakeBox, maxPerUser: 5 });
    const queue = createWebhookStore({ filePath: ':memory:' });
    store.create({ user: 'me@example.com', password: 'pw', label: 'L', url: 'https://receiver.example/h' });
    // Simulate a key rotation: the stored password no longer decrypts.
    store.listAllLive = () => [{
        id: 'x', label: 'L', url: 'https://r.example/h', keep: false, prepend: '',
        user: 'me@example.com', secret: 's', password: null
    }];
    const http = stubHttp(200);
    const forwarder = createOutboundWebhookForwarder({
        config: makeConfig(),
        store,
        queue,
        logger: silentLog,
        connect: async () => { throw new Error('should not connect'); },
        request: http.fn
    });
    await forwarder.tick();
    assert.strictEqual(http.seen.length, 0);
});

test('delivery: configured custom headers ride on the POST', async () => {
    const { http, forwarder } = setup({
        headers: { 'Authorization': 'Bearer abc123', 'X-Tenant': 'billing' }
    });
    await forwarder.tick();
    assert.strictEqual(http.seen.length, 1);
    const sent = http.seen[0].opts.headers;
    assert.strictEqual(sent['Authorization'], 'Bearer abc123');
    assert.strictEqual(sent['X-Tenant'], 'billing');
    // The built-ins survive the merge, and the signature headers still land.
    assert.strictEqual(sent['content-type'], 'application/json');
    assert.match(sent['x-webhook-signature-v2'], /^[0-9a-f]{64}$/);
});

test('delivery: a reserved header name is rejected at creation', () => {
    assert.throws(
        () => setup({ headers: { 'Host': 'evil.example' } }),
        /reserved/i
    );
    assert.throws(
        () => setup({ headers: { 'X-Webhook-Signature-V2': 'forged' } }),
        /reserved/i
    );
});
