'use strict';

// Route tests for the "AI assistant takeover" surface (/v1/me/takeover*).
//
// The load-bearing guarantee under test: these routes NEVER send. "Resume
// with advice" stores John's answer as context for the next draft and
// nothing more — the next draft is the worker's business and still stops at
// the approval gate (src/routes/send.js:278 `if (isBasicAuth(req))`). The
// no-send test therefore wires the REAL worker with an injected `deliver`
// (the injected send function — the worker's only exit to a message) plus a
// fetch spy, and asserts neither is ever touched by the advice endpoint.
//
// The knob tests pin the two safety limits at the route boundary:
//   * minDelayMinutes floors at 5 — asking for less is REJECTED with 400
//     (chosen over silent clamping: a safety limit that quietly moves is a
//     limit nobody knows they have);
//   * maxRepliesPerHour is 0..24, where 0 means paused, never drafted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const takeoverRoutes = require('../../src/routes/takeover');
const { createTakeoverWorker } = require('../../src/takeover-worker');

const TEST_USER = 'john@example.com';
const AUTH = `Basic ${Buffer.from(`${TEST_USER}:password`).toString('base64')}`;
const SETTINGS_KEYS = ['enabled', 'maxRepliesPerHour', 'minDelayMinutes', 'lookbackHours', 'considerAttachments'];

// In-memory stand-in for src/takeover-store.js with the same contract.
// The routes are what is under test; this keeps the tests independent of
// sqlite while behaving exactly like the real store (merge-patch set(),
// unknown keys throw, resolve vs dismiss semantics).
function fakeStore() {
    const users = new Map();
    const calls = { set: [], resolve: [], dismiss: [] };
    function u(user) {
        if (!users.has(user)) {
            users.set(user, {
                state: { enabled: false, maxRepliesPerHour: 1, minDelayMinutes: 5, lookbackHours: 24, considerAttachments: false },
                items: [],
                decisions: []
            });
        }
        return users.get(user);
    }
    return {
        calls,
        seedItem(user, item) { u(user).items.push({ status: 'open', createdAt: Date.now(), resolvedAt: null, advice: '', ...item }); },
        seedDecision(user, d) { u(user).decisions.push(d); },
        state(user) { return u(user).state; },
        itemsOf(user) { return u(user).items; },
        get(user) { return { ...u(user).state }; },
        set(user, patch) {
            calls.set.push({ user, patch });
            for (const key of Object.keys(patch || {})) {
                if (!SETTINGS_KEYS.includes(key)) throw new Error(`Unknown takeover setting: ${key}`);
            }
            const s = u(user);
            s.state = { ...s.state, ...patch };
            return { ...s.state };
        },
        listNeedsInput(user) {
            return u(user).items.filter((i) => i.status === 'open').map((i) => ({ ...i }));
        },
        resolveNeedsInput(user, id, advice) {
            calls.resolve.push({ user, id, advice });
            const item = u(user).items.find((i) => i.id === id && i.status === 'open');
            if (!item) return null;
            item.status = 'resolved';
            item.advice = String(advice || '');
            item.resolvedAt = Date.now();
            return { ...item };
        },
        dismissNeedsInput(user, id, note) {
            calls.dismiss.push({ user, id, note });
            const item = u(user).items.find((i) => i.id === id && i.status === 'open');
            if (!item) return null;
            item.status = 'dismissed';
            return { ...item };
        },
        recentDecisions(user, limit) { return u(user).decisions.slice(0, limit); },
        hasEnabledUsers() { return [...users.values()].some((s) => s.state.enabled); }
    };
}

function fakeWorker() {
    const calls = { start: 0, stop: 0, wake: 0, tick: 0 };
    return {
        calls,
        enabled: true,
        start() { calls.start++; },
        stop() { calls.stop++; },
        tick() { calls.tick++; },
        wake() { calls.wake++; }
    };
}

async function buildApp({ store, worker = fakeWorker() } = {}) {
    const app = Fastify();
    await app.register(sensible);
    // Stand-in for the global auth hook in src/auth.js (which verifies
    // against IMAP). It only populates req.creds — it never rejects. That
    // makes "unauthenticated is rejected" a test of the routes' own guard,
    // not of this stand-in.
    app.addHook('onRequest', async (req) => {
        if (req.headers.authorization === AUTH) {
            req.creds = { user: TEST_USER, pass: 'password' };
        }
    });
    await app.register(takeoverRoutes, { store, worker });
    return app;
}

test('unauthenticated requests are rejected', async (t) => {
    const app = await buildApp({ store: fakeStore() });
    t.after(() => app.close());

    for (const req of [
        { method: 'GET', url: '/v1/me/takeover' },
        { method: 'PUT', url: '/v1/me/takeover', payload: { enabled: true } },
        { method: 'GET', url: '/v1/me/takeover/needs-input' },
        { method: 'POST', url: '/v1/me/takeover/needs-input/abc', payload: { advice: 'hi' } },
        { method: 'DELETE', url: '/v1/me/takeover/needs-input/abc' },
        { method: 'POST', url: '/v1/me/takeover/stop' }
    ]) {
        const res = await app.inject(req);
        assert.equal(res.statusCode, 401, `${req.method} ${req.url} must be rejected`);
    }
});

test('GET status reports settings, counts and blocked state', async (t) => {
    const store = fakeStore();
    store.seedDecision(TEST_USER, { messageId: 'm1', decision: 'drafted', reason: 'asked a question' });
    store.seedDecision(TEST_USER, { messageId: 'm2', decision: 'skipped-automated', reason: 'receipt' });
    store.seedItem(TEST_USER, {
        id: 'n1', messageId: 'm3', from: 'a@b.c', subject: 'Quote',
        missing: ['the price'], reason: 'You asked for a quote but the price was not in the thread, and I will not invent one. Nothing has been sent.',
        threadSnippet: 'How much is the blue one?'
    });
    const app = await buildApp({ store });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/v1/me/takeover', headers: { authorization: AUTH } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.enabled, false);
    assert.equal(body.maxRepliesPerHour, 1);
    assert.equal(body.minDelayMinutes, 5);
    assert.equal(body.lookbackHours, 24);
    assert.equal(body.considerAttachments, false);
    assert.deepEqual(body.counts, { processed: 2, needsInput: 1 });
    assert.equal(body.blocked, true);
});

test('minDelayMinutes below the floor of 5 is rejected, not clamped', async (t) => {
    const store = fakeStore();
    const app = await buildApp({ store });
    t.after(() => app.close());

    const low = await app.inject({
        method: 'PUT', url: '/v1/me/takeover',
        headers: { authorization: AUTH },
        payload: { minDelayMinutes: 1 }
    });
    assert.equal(low.statusCode, 400, '1 minute must be refused at the route boundary');
    assert.equal(store.calls.set.length, 0, 'a refused patch must never reach the store');

    const ok = await app.inject({
        method: 'PUT', url: '/v1/me/takeover',
        headers: { authorization: AUTH },
        payload: { minDelayMinutes: 5 }
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().minDelayMinutes, 5, 'the floor value itself is accepted');
});

test('maxRepliesPerHour bounds are validated (0..24, 0 = paused)', async (t) => {
    const store = fakeStore();
    const app = await buildApp({ store });
    t.after(() => app.close());

    for (const bad of [25, -1]) {
        const res = await app.inject({
            method: 'PUT', url: '/v1/me/takeover',
            headers: { authorization: AUTH },
            payload: { maxRepliesPerHour: bad }
        });
        assert.equal(res.statusCode, 400, `${bad} is out of range`);
    }
    assert.equal(store.calls.set.length, 0);

    for (const good of [0, 24]) {
        const res = await app.inject({
            method: 'PUT', url: '/v1/me/takeover',
            headers: { authorization: AUTH },
            payload: { maxRepliesPerHour: good }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().maxRepliesPerHour, good, '0 is a legal (paused) value');
    }
});

test('PUT rejects unknown settings and empty patches', async (t) => {
    const store = fakeStore();
    const app = await buildApp({ store });
    t.after(() => app.close());

    const unknown = await app.inject({
        method: 'PUT', url: '/v1/me/takeover',
        headers: { authorization: AUTH },
        payload: { maxReplies: 3 }
    });
    assert.equal(unknown.statusCode, 400);

    const empty = await app.inject({
        method: 'PUT', url: '/v1/me/takeover',
        headers: { authorization: AUTH },
        payload: {}
    });
    assert.equal(empty.statusCode, 400);
});

test('GET needs-input lists blocked items with reason and missing facts', async (t) => {
    const store = fakeStore();
    store.seedItem(TEST_USER, {
        id: 'n1', messageId: 'm1', from: 'boss@corp.example', subject: 'Deadline',
        missing: ['the delivery date'], reason: 'The thread has no delivery date and I will not guess one. Nothing has been sent.',
        threadSnippet: 'When can you deliver?'
    });
    const app = await buildApp({ store });
    t.after(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/v1/me/takeover/needs-input', headers: { authorization: AUTH } });
    assert.equal(res.statusCode, 200);
    const { items } = res.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'n1');
    assert.deepEqual(items[0].missing, ['the delivery date']);
    assert.match(items[0].reason, /will not guess/);
    assert.equal(items[0].threadSnippet, 'When can you deliver?');
});

test('POST needs-input/:id records advice and never sends', async (t) => {
    const store = fakeStore();
    store.seedItem(TEST_USER, {
        id: 'n1', messageId: 'm1', from: 'a@b.c', subject: 'S',
        missing: ['the date'], reason: 'Blocked. Nothing has been sent.', threadSnippet: 'When?'
    });

    // The real worker, with the injected SEND function (`deliver`) spying,
    // and a fetch spy for the loopback POST shape. No sessions exist, so a
    // tick is a no-op — anything recorded here is a rule violation by the
    // route under test.
    const deliverCalls = [];
    const fetchCalls = [];
    let sessionReads = 0;
    const worker = createTakeoverWorker({
        config: { takeover: { enabled: true, pollIntervalMs: 60_000 } },
        store,
        cache: { listActiveSessions() { sessionReads++; return []; } },
        pool: null,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        deliver: async (msg) => { deliverCalls.push(msg); }
    });

    const realFetch = global.fetch;
    global.fetch = async (...args) => {
        fetchCalls.push(args);
        return new Response('{}', { status: 200 });
    };
    t.after(() => { global.fetch = realFetch; });

    const app = await buildApp({ store, worker });
    t.after(() => app.close());

    const res = await app.inject({
        method: 'POST', url: '/v1/me/takeover/needs-input/n1',
        headers: { authorization: AUTH },
        payload: { advice: 'The appointment is 3 October at 2pm — confirm that and keep it short.' }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.equal(store.calls.resolve.length, 1);
    assert.match(store.calls.resolve[0].advice, /3 October/);

    // wake() fires tick() without awaiting it — let the microtasks settle.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sessionReads > 0, true, 'the worker was resumed (wake -> tick)');
    assert.equal(deliverCalls.length, 0, 'resume with advice must not hand anything to the send function');
    assert.equal(fetchCalls.length, 0, 'resume with advice must not submit anything anywhere');
});

test('POST needs-input/:id with an unknown id is 404 and sends nothing', async (t) => {
    const deliverCalls = [];
    const worker = fakeWorker();
    const store = fakeStore();
    const app = await buildApp({ store, worker });
    t.after(() => app.close());

    const res = await app.inject({
        method: 'POST', url: '/v1/me/takeover/needs-input/nope',
        headers: { authorization: AUTH },
        payload: { advice: 'hello' }
    });
    assert.equal(res.statusCode, 404);
    assert.equal(deliverCalls.length, 0);
    assert.equal(worker.calls.wake, 0, 'nothing was resumed');
});

test('DELETE needs-input/:id dismisses one item ("stop" on this one)', async (t) => {
    const store = fakeStore();
    store.seedItem(TEST_USER, { id: 'n1', messageId: 'm1', from: 'a@b.c', subject: 'S', missing: [], reason: 'Blocked.', threadSnippet: '' });
    store.seedItem(TEST_USER, { id: 'n2', messageId: 'm2', from: 'a@b.c', subject: 'T', missing: [], reason: 'Blocked.', threadSnippet: '' });
    const app = await buildApp({ store });
    t.after(() => app.close());

    const res = await app.inject({ method: 'DELETE', url: '/v1/me/takeover/needs-input/n1', headers: { authorization: AUTH } });
    assert.equal(res.statusCode, 204);
    assert.equal(store.calls.dismiss.length, 1);
    assert.equal(store.calls.dismiss[0].id, 'n1');
    assert.equal(store.listNeedsInput(TEST_USER).length, 1, 'only the named item is dismissed');

    const again = await app.inject({ method: 'DELETE', url: '/v1/me/takeover/needs-input/nope', headers: { authorization: AUTH } });
    assert.equal(again.statusCode, 404);
});

test('POST stop disables and clears blocked state', async (t) => {
    const store = fakeStore();
    store.state(TEST_USER).enabled = true;
    store.seedItem(TEST_USER, { id: 'n1', messageId: 'm1', from: 'a@b.c', subject: 'S', missing: [], reason: 'Blocked.', threadSnippet: '' });
    store.seedItem(TEST_USER, { id: 'n2', messageId: 'm2', from: 'a@b.c', subject: 'T', missing: [], reason: 'Blocked.', threadSnippet: '' });
    const worker = fakeWorker();
    const app = await buildApp({ store, worker });
    t.after(() => app.close());

    const res = await app.inject({ method: 'POST', url: '/v1/me/takeover/stop', headers: { authorization: AUTH } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { enabled: false, cleared: 2 });
    assert.equal(store.state(TEST_USER).enabled, false);
    assert.equal(store.listNeedsInput(TEST_USER).length, 0, 'the blocked queue is cleared');
    assert.equal(worker.calls.stop >= 1, true, 'the worker is stopped once no user is enabled');

    const after = await app.inject({ method: 'GET', url: '/v1/me/takeover', headers: { authorization: AUTH } });
    assert.equal(after.json().blocked, false);
    assert.equal(after.json().enabled, false);
});

test('PUT enabled:true starts and wakes the worker; disabling stops it', async (t) => {
    const store = fakeStore();
    const worker = fakeWorker();
    const app = await buildApp({ store, worker });
    t.after(() => app.close());

    const on = await app.inject({
        method: 'PUT', url: '/v1/me/takeover',
        headers: { authorization: AUTH },
        payload: { enabled: true }
    });
    assert.equal(on.statusCode, 200);
    assert.equal(on.json().enabled, true);
    assert.equal(worker.calls.start, 1);
    assert.equal(worker.calls.wake, 1);

    const off = await app.inject({
        method: 'PUT', url: '/v1/me/takeover',
        headers: { authorization: AUTH },
        payload: { enabled: false }
    });
    assert.equal(off.statusCode, 200);
    assert.equal(worker.calls.stop, 1, 'last user disabling stops the polling worker');
});
