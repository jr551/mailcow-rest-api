'use strict';

const test = require('node:test');
const assert = require('node:assert');

// push-sender.js destructures its collaborators (createPinnedHttpsAgent,
// withClient) at module load, so the stubs must be installed before it is
// required. Each stub delegates to `state`, which every test rewires.
const state = {
    agentFor: async () => null,
    send: async () => {},
    unseen: 0
};
const ssrfGuard = require('../../src/utils/ssrf-guard');
ssrfGuard.createPinnedHttpsAgent = (endpoint) => state.agentFor(endpoint);
const webpush = require('web-push');
webpush.sendNotification = (sub, payload, opts) => state.send(sub, payload, opts);
const imapModule = require('../../src/imap');
imapModule.withClient = (pool, creds, fn) => fn({
    async status() { return { unseen: state.unseen }; }
});

const { createPushSender } = require('../../src/push-sender');

const vapid = webpush.generateVAPIDKeys();

function makeSender({ subs = [], sessions = [], cache, logger = null }) {
    const deleted = [];
    const pushStore = {
        listForUser: () => subs,
        delete: ({ endpoint }) => { deleted.push(endpoint); return 1; }
    };
    const effectiveCache = cache === null
        ? null
        : (cache || { hashCreds: () => 'h', listActiveSessions: () => sessions });
    const config = {
        push: {
            vapidPublicKey: vapid.publicKey,
            vapidPrivateKey: vapid.privateKey,
            vapidSubject: 'mailto:t@example.com',
            dbPath: ':memory:',
            pollIntervalMs: 60_000
        }
    };
    const sender = createPushSender({
        config, pushStore, pool: {}, cache: effectiveCache, logger
    });
    return { sender, deleted };
}

function sub(n) {
    return { endpoint: `https://push.example/${n}`, p256dh: `k${n}`, auth_key: `a${n}` };
}

test('push: a failed notification is retried next tick instead of dropped', async () => {
    const calls = [];
    state.unseen = 3;
    state.send = async (s, payload) => {
        calls.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
        if (calls.length === 1) throw new Error('push service hiccup');
    };
    const { sender } = makeSender({
        subs: [sub('a')], sessions: [{ user: 'u', pass: 'p' }]
    });
    await sender.tick();
    await sender.tick();
    sender.stop();
    assert.equal(calls.length, 2, 'the failed notification must be retried');
    assert.equal(calls[1].payload.unreadCount, 3);
    assert.equal(calls[1].payload.title, '3 new messages');
});

test('push: retry does not re-send to endpoints that already got the notification', async () => {
    const calls = [];
    state.unseen = 5;
    state.send = async (s) => {
        calls.push(s.endpoint);
        if (s.endpoint.endsWith('/b') && calls.filter((e) => e.endsWith('/b')).length === 1) {
            throw new Error('endpoint down');
        }
    };
    const { sender } = makeSender({
        subs: [sub('a'), sub('b')], sessions: [{ user: 'u', pass: 'p' }]
    });
    await sender.tick();
    await sender.tick();
    sender.stop();
    // 'a' is delivered on the first tick and must not be notified twice
    // while 'b' is being retried.
    assert.deepEqual(calls, [
        'https://push.example/a',
        'https://push.example/b',
        'https://push.example/b'
    ]);
});

test('push: the pinned agent is destroyed after every send, success or failure', async () => {
    let created = 0;
    let destroyed = 0;
    state.unseen = 2;
    state.agentFor = async () => {
        created += 1;
        return { destroy() { destroyed += 1; } };
    };
    state.send = async (s) => {
        if (s.endpoint.endsWith('/b')) throw new Error('boom');
    };
    const { sender } = makeSender({
        subs: [sub('a'), sub('b')], sessions: [{ user: 'u', pass: 'p' }]
    });
    await sender.tick();
    sender.stop();
    assert.equal(created, 2);
    assert.equal(destroyed, 2, 'each per-send agent must be destroyed');
});

test('push: a null cache is treated as no active sessions', async () => {
    const errors = [];
    state.unseen = 1;
    state.send = async () => { throw new Error('must not send'); };
    const { sender } = makeSender({
        cache: null,
        logger: { warn() {}, info() {}, error(e, msg) { errors.push(msg); } }
    });
    await sender.tick();
    sender.stop();
    assert.deepEqual(errors, [], 'no sessions means no work, not a poll failure');
});

test('push: a stale per-endpoint watermark does not suppress later mail', async () => {
    // Tick 1: unseen jumps to 5, 'b' fails so the user-level watermark stays
    // put. Between ticks the user reads everything down to 1 unread; a new
    // message then arrives (2 unread). Endpoint 'a' was notified at count 5,
    // but count 5 no longer describes the mailbox — 'a' must be told about
    // the new message too.
    const calls = [];
    let bFailures = 1;
    state.unseen = 5;
    state.send = async (s) => {
        calls.push(s.endpoint);
        if (s.endpoint.endsWith('/b') && bFailures > 0) {
            bFailures -= 1;
            throw new Error('endpoint down');
        }
    };
    const { sender } = makeSender({
        subs: [sub('a'), sub('b')], sessions: [{ user: 'u', pass: 'p' }]
    });
    await sender.tick();
    state.unseen = 1;
    await sender.tick();
    state.unseen = 2;
    await sender.tick();
    sender.stop();
    assert.deepEqual(calls, [
        'https://push.example/a',
        'https://push.example/b',
        'https://push.example/b',
        'https://push.example/a',
        'https://push.example/b'
    ]);
});

test('push: 410/404 drops the subscription and does not block the watermark', async () => {
    state.unseen = 4;
    state.send = async (s) => {
        if (s.endpoint.endsWith('/dead')) {
            const err = new Error('gone');
            err.statusCode = 410;
            throw err;
        }
    };
    const { sender, deleted } = makeSender({
        subs: [sub('dead')], sessions: [{ user: 'u', pass: 'p' }]
    });
    await sender.tick();
    await sender.tick();
    sender.stop();
    assert.deepEqual(deleted, ['https://push.example/dead'], 'expired sub removed exactly once');
});
