'use strict';

// Regression tests: stop() must not resolve while a poll is mid-flight.
//
// server.js's onClose stops the workers and then closes their sqlite stores
// and the IMAP pool. stop() used to return immediately even with a tick
// still running, so the store closed underneath it: a webhook POST that had
// just landed could not record 'delivered' and was re-sent after the restart
// — a duplicate on the receiver — and a push notification could not advance
// its watermark and was dropped. Every worker now hands stop() its in-flight
// poll so shutdown can wait for the bookkeeping.

const test = require('node:test');
const assert = require('node:assert/strict');

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

async function assertStopWaitsForTick({ startTick, stop, isBusy }) {
    const tickPromise = startTick();
    await isBusy(); // the poll is now inside its slow step
    const stopPromise = Promise.resolve(stop());
    let stoppedEarly = false;
    stopPromise.then(() => { stoppedEarly = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(stoppedEarly, false, 'stop() must not resolve while the poll is mid-flight');
    return { tickPromise, stopPromise };
}

// --- webhook forwarder ---------------------------------------------------

test('webhook forwarder: stop() waits for the in-flight poll', async () => {
    const { createWebhookForwarder } = require('../../src/webhook-forwarder');
    const { createWebhookStore } = require('../../src/webhook-store');
    const gate = deferred();
    let entered;
    const enteredPromise = new Promise((r) => { entered = r; });
    const client = {
        on() {},
        async connect() {},
        async getMailboxLock() { entered(); await gate.promise; return { release() {} }; },
        async search() { return []; },
        async logout() {}
    };
    const store = createWebhookStore({ filePath: ':memory:' });
    const fw = createWebhookForwarder({
        config: {
            imap: { host: 'h', port: 993, secure: true, rejectUnauthorized: true, connectTimeoutMs: 1000, tlsServername: '' },
            webhooks: {
                accounts: [{ address: 'a@x.com', password: 'p' }],
                pollIntervalMs: 60_000,
                maxAttempts: 3,
                maxMessageBytes: 1024,
                includeAttachments: false,
                maxAttachmentBytes: 1024,
                maxAttachmentsTotalBytes: 1024,
                timeoutMs: 1000
            }
        },
        store,
        logger: null,
        connect: async () => client
    });

    const { tickPromise, stopPromise } = await assertStopWaitsForTick({
        startTick: () => fw.tick(),
        stop: () => fw.stop(),
        isBusy: () => enteredPromise
    });
    gate.resolve();
    await stopPromise;
    await tickPromise;
    store.close();
});

// --- outbound webhook forwarder -----------------------------------------

test('outbound webhook forwarder: a confirmed POST records delivery before shutdown completes', async () => {
    const { createOutboundWebhookForwarder } = require('../../src/outbound-webhook-forwarder');
    const { createOutboundWebhookStore } = require('../../src/outbound-webhook-store');
    const { createWebhookStore } = require('../../src/webhook-store');
    const fakeBox = {
        encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
        decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
    };
    const store = createOutboundWebhookStore({ filePath: ':memory:', secretBox: fakeBox, maxPerUser: 5 });
    const queue = createWebhookStore({ filePath: ':memory:' });
    const created = store.create({
        user: 'me@example.com', password: 'pw', label: 'L',
        url: 'https://receiver.example/hook', keep: false
    });
    const deleted = [];
    const client = {
        mailbox: { uidValidity: 42, exists: 1 },
        on() {},
        async connect() {},
        async getMailboxLock() { return { release() {} }; },
        async search() { return [1]; },
        async fetchOne() {
            return {
                uid: 1,
                envelope: { subject: 's', from: [{ address: 'a@b.c' }], to: [{ address: 'me@example.com' }] },
                internalDate: new Date(), size: 5, flags: new Set(),
                bodyStructure: { part: '1', type: 'text/plain' },
                source: Buffer.from('Subject: s\r\nFrom: a@b.c\r\n\r\nhi\n')
            };
        },
        async download() { return { content: (async function* () { yield Buffer.from('hi'); })() }; },
        async messageDelete(uid) { deleted.push(uid); },
        async messageMove() {},
        async append() {},
        async logout() {},
        close() {}
    };
    const gate = deferred();
    let entered;
    const enteredPromise = new Promise((r) => { entered = r; });
    const logs = [];
    const log = { info() {}, warn: (o, m) => logs.push(m), error: (o, m) => logs.push(m) };
    const fw = createOutboundWebhookForwarder({
        config: {
            imap: { host: 'h', port: 993, secure: true, rejectUnauthorized: true, connectTimeoutMs: 1000 },
            outboundWebhooks: {
                pollIntervalMs: 60_000, timeoutMs: 5000, maxAttempts: 3,
                maxMessageBytes: 1024 * 1024, includeAttachments: true,
                maxAttachmentBytes: 1024, maxAttachmentsTotalBytes: 1024
            }
        },
        store,
        queue,
        logger: log,
        connect: async () => client,
        request: async () => {
            entered();
            await gate.promise;
            return { statusCode: 200, body: { text: async () => 'ok' } };
        }
    });

    const { tickPromise, stopPromise } = await assertStopWaitsForTick({
        startTick: () => fw.tick(),
        stop: () => fw.stop(),
        isBusy: () => enteredPromise
    });
    gate.resolve();
    await stopPromise;
    await tickPromise;

    assert.deepStrictEqual(deleted, ['1'], 'the delivered message was acted on before shutdown completed');
    assert.deepStrictEqual(logs, [], 'no bookkeeping failed during shutdown');
    assert.strictEqual(queue.get(created.mailbox, 42, 1), null, 'delivery state settled before stop() resolved');
    queue.close();
    store.close();
});

// --- push sender --------------------------------------------------------

test('push sender: stop() waits for the in-flight send and its watermark write', async () => {
    // push-sender destructures its collaborators at module load.
    const state = { send: async () => {}, unseen: 0 };
    const ssrfGuard = require('../../src/utils/ssrf-guard');
    ssrfGuard.createPinnedHttpsAgent = async () => null;
    const webpush = require('web-push');
    webpush.sendNotification = (sub, payload, opts) => state.send(sub, payload, opts);
    const imapModule = require('../../src/imap');
    imapModule.withClient = (pool, creds, fn) => fn({
        async status() { return { unseen: state.unseen }; }
    });
    const { createPushSender } = require('../../src/push-sender');
    const vapid = webpush.generateVAPIDKeys();

    state.unseen = 3;
    const gate = deferred();
    let entered;
    const enteredPromise = new Promise((r) => { entered = r; });
    state.send = async () => { entered(); await gate.promise; return { statusCode: 201 }; };

    const logs = [];
    const log = { info() {}, warn: (o, m) => logs.push(m), error: (o, m) => logs.push(m) };
    const sender = createPushSender({
        config: {
            push: {
                vapidPublicKey: vapid.publicKey,
                vapidPrivateKey: vapid.privateKey,
                vapidSubject: 'mailto:t@example.com',
                dbPath: ':memory:',
                pollIntervalMs: 60_000
            }
        },
        pushStore: {
            listForUser: () => [{ endpoint: 'https://push.example/a', p256dh: 'k', auth_key: 'a' }],
            delete: () => 1
        },
        pool: {},
        cache: { hashCreds: () => 'h', listActiveSessions: () => [{ user: 'u', pass: 'p' }] },
        logger: log
    });

    const { tickPromise, stopPromise } = await assertStopWaitsForTick({
        startTick: () => sender.tick(),
        stop: () => sender.stop(),
        isBusy: () => enteredPromise
    });
    gate.resolve();
    await stopPromise;
    await tickPromise;

    assert.deepStrictEqual(logs, [],
        'the watermark write after a confirmed send must not fail against a closed db');
});

// --- takeover worker ----------------------------------------------------

test('takeover worker: stop() waits for the in-flight pass', async () => {
    const { createTakeoverStore } = require('../../src/takeover-store');
    const { createTakeoverWorker } = require('../../src/takeover-worker');
    const fakeBox = {
        encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
        decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
    };
    const gate = deferred();
    let entered;
    const enteredPromise = new Promise((r) => { entered = r; });
    const imap = {
        async getMailboxLock() { entered(); await gate.promise; return { release() {} }; },
        async search() { return []; }
    };
    const store = createTakeoverStore({ filePath: ':memory:', secretBox: fakeBox });
    store.set('u@example.com', { enabled: true });
    const worker = createTakeoverWorker({
        config: {
            takeover: {
                enabled: true, pollIntervalMs: 60_000,
                maxCandidatesPerTick: 20, maxThreadChars: 12_000
            },
            ai: {}
        },
        store,
        cache: { listActiveSessions: () => [{ user: 'u@example.com', pass: 'pw', hash: 'h' }] },
        pool: {},
        logger: null,
        withClient: (pool, creds, fn) => fn(imap),
        deliver: async () => ({})
    });

    const { tickPromise, stopPromise } = await assertStopWaitsForTick({
        startTick: () => worker.tick(),
        stop: () => worker.stop(),
        isBusy: () => enteredPromise
    });
    gate.resolve();
    await stopPromise;
    await tickPromise;
    store.close();
});

test('takeover worker: a null session cache is a quiet no-op, not a failed pass every tick', async () => {
    const { createTakeoverStore } = require('../../src/takeover-store');
    const { createTakeoverWorker } = require('../../src/takeover-worker');
    const fakeBox = {
        encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
        decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
    };
    const logs = [];
    const store = createTakeoverStore({ filePath: ':memory:', secretBox: fakeBox });
    const worker = createTakeoverWorker({
        config: {
            takeover: {
                enabled: true, pollIntervalMs: 60_000,
                maxCandidatesPerTick: 20, maxThreadChars: 12_000
            },
            ai: {}
        },
        store,
        cache: null, // the documented fail-open state
        pool: {},
        logger: { info() {}, warn: (o, m) => logs.push(m), error: (o, m) => logs.push(m) },
        withClient: () => { throw new Error('should not connect'); },
        deliver: async () => ({})
    });
    await worker.tick();
    assert.deepStrictEqual(logs, [], 'no sessions to poll is not a poll failure');
    store.close();
});
