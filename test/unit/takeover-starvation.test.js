'use strict';

// Regression tests for takeover candidate starvation.
//
// The worker scans UNSEEN mail and settles messages in its own ledger, but it
// holds the mailbox read-only — a settled message stays UNSEEN in IMAP
// forever. If the candidate window is simply "the first N unseen uids", a
// backlog of settled messages sits at the head of the window and a newly
// arrived message is never examined again: a permanent per-user kill of the
// feature. These tests pin the fix: settled messages must not consume
// candidate slots, the per-tick header scan must stay bounded, and a message
// behind a settled backlog must still be reached.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTakeoverStore } = require('../../src/takeover-store');
const {
    createTakeoverWorker,
    TAKEOVER_CLASSIFY_SYSTEM,
    TAKEOVER_REPLY_SYSTEM
} = require('../../src/takeover-worker');

const fakeBox = {
    encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
    decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
};

const USER = 'john@example.com';
const T0 = Date.parse('2026-09-30T12:00:00Z');
const MINUTE = 60 * 1000;

function textPartOf(text) {
    return {
        part: '1',
        type: 'text/plain',
        disposition: '',
        childNodes: [],
        size: text.length
    };
}

// A message the deterministic automated-sender check settles in its first
// look (no model call). It is never marked \Seen — that is the point.
function automatedMessage(uid) {
    return {
        uid,
        body: 'Your weekly report is ready.',
        msg: {
            uid,
            envelope: {
                from: [{ name: 'Build Bot', address: 'noreply@alerts.example' }],
                replyTo: [],
                to: [{ address: USER }],
                subject: 'Your weekly digest 2026-09-30',
                date: new Date(T0 - 10 * MINUTE),
                messageId: `<dead${uid}@alerts.example>`,
                inReplyTo: null
            },
            headers: '',
            bodyStructure: textPartOf('x')
        }
    };
}

// A message from a real person with a question: the assistant drafts a reply.
function humanMessage(uid) {
    return {
        uid,
        body: 'Hi John,\n\nCan you confirm the delivery date for order 4471?\n\nThanks,\nAlice',
        msg: {
            uid,
            envelope: {
                from: [{ name: 'Alice Smith', address: 'alice@vendor.example' }],
                replyTo: [{ name: 'Alice Smith', address: 'alice@vendor.example' }],
                to: [{ address: USER }],
                subject: 'Delivery date for order 4471',
                date: new Date(T0 - 10 * MINUTE),
                messageId: `<live${uid}@vendor.example>`,
                inReplyTo: null
            },
            headers: '',
            bodyStructure: textPartOf('x')
        }
    };
}

// A worker wired to fakes. `messages` is mutated between ticks to simulate
// arrivals. Header fetches (envelope fetches) are counted per tick so a test
// can assert the scan bound.
function makeEnv({ messages, config = {} } = {}) {
    const calls = { llm: [], deliver: [], headerFetchesPerTick: [] };
    const state = { now: T0 };
    let tickHeaders = 0;

    const imap = {
        async getMailboxLock() {
            return { release() {} };
        },
        async search() {
            return messages.map((m) => m.uid);
        },
        async fetchOne(uid, query) {
            if (query && query.envelope) tickHeaders++;
            const m = messages.find((x) => String(x.uid) === String(uid));
            return m ? m.msg : null;
        },
        async download(uid) {
            const m = messages.find((x) => String(x.uid) === String(uid));
            return {
                content: (async function* () { yield Buffer.from((m && m.body) || ''); })()
            };
        }
    };

    const store = createTakeoverStore({ filePath: ':memory:', secretBox: fakeBox });
    store.set(USER, { enabled: true });

    const worker = createTakeoverWorker({
        config: {
            takeover: {
                enabled: true,
                pollIntervalMs: 60 * MINUTE,
                maxCandidatesPerTick: 20,
                maxThreadChars: 12_000,
                ...config
            },
            ai: {}
        },
        store,
        cache: {
            listActiveSessions: () => [{ user: USER, pass: 'pw', hash: 'hash', expires_at: T0 + 3600_000 }]
        },
        pool: {},
        logger: null,
        clock: () => state.now,
        resolveProvider: () => ({ kind: 'openai', model: 'test', apiKey: 'k', timeoutMs: 5000, maxInputChars: 50_000 }),
        withClient: (pool, creds, fn) => fn(imap),
        llm: async (args) => {
            calls.llm.push(args);
            if (args.system === TAKEOVER_CLASSIFY_SYSTEM) {
                return { ok: true, content: JSON.stringify({ needsReply: true, reason: 'a question was asked' }) };
            }
            assert.strictEqual(args.system, TAKEOVER_REPLY_SYSTEM);
            return { ok: true, content: 'REPLY:\nYes, that is correct.' };
        },
        deliver: async (payload) => {
            calls.deliver.push(payload);
            return { pendingApproval: true, token: 'tok' };
        }
    });

    return {
        calls,
        state,
        store,
        async tick() {
            tickHeaders = 0;
            await worker.tick();
            calls.headerFetchesPerTick.push(tickHeaders);
        }
    };
}

test('a backlog of processed-but-unseen messages cannot starve a newly arrived message', async () => {
    // One tick with a full window of messages the assistant settles
    // immediately. They stay UNSEEN in IMAP — the worker never touches the
    // human's read state — so they keep their slots at the head of the
    // oldest-first unseen window.
    const messages = Array.from({ length: 20 }, (_, i) => automatedMessage(i + 1));
    const env = makeEnv({ messages });
    await env.tick();

    // A real person writes in behind the backlog.
    messages.push(humanMessage(21));

    // Give the worker several polls to notice. Before the fix this never
    // happened at any number of polls.
    for (let i = 0; i < 4; i++) await env.tick();

    assert.strictEqual(env.calls.deliver.length, 1, 'the newly arrived message must be drafted');
    assert.strictEqual(env.calls.deliver[0].messageId, 'live21@vendor.example');
});

test('a message parked in needs-input does not consume a candidate slot either', async () => {
    const messages = Array.from({ length: 19 }, (_, i) => automatedMessage(i + 1));
    const env = makeEnv({ messages });

    // A message the assistant previously stopped on: parked in needs-input,
    // still UNSEEN in IMAP, still occupying a uid in the unseen window.
    const parked = humanMessage(20);
    messages.push(parked);
    env.store.enqueueNeedsInput(USER, {
        messageId: 'live20@vendor.example',
        from: 'alice@vendor.example',
        subject: 'Delivery date for order 4471',
        missing: ['the delivery date for order 4471'],
        reason: 'The reply needs something the message thread does not contain.',
        threadSnippet: 'Hi John, ...'
    });

    messages.push(humanMessage(21)); // a new arrival behind the parked message

    for (let i = 0; i < 5; i++) await env.tick();

    assert.strictEqual(env.calls.deliver.length, 1, 'the new arrival must be drafted despite the parked message');
    assert.strictEqual(env.calls.deliver[0].messageId, 'live21@vendor.example');
    assert.strictEqual(env.store.listNeedsInput(USER).length, 1, 'the parked message keeps its needs-input row');
});

test('the header scan stays bounded while a backlog of settled mail drains', async () => {
    // 60 settled-unseen messages ahead of one live message, with an explicit
    // 20-header scan window: the live message must be reached (the scan
    // rotates) without any tick ever fetching more than the bound.
    const messages = Array.from({ length: 60 }, (_, i) => automatedMessage(i + 1));
    const env = makeEnv({ messages, config: { maxHeaderScanPerTick: 20 } });

    await env.tick();
    messages.push(humanMessage(61));

    for (let i = 0; i < 12; i++) await env.tick();

    assert.strictEqual(env.calls.deliver.length, 1, 'the message beyond the backlog must be reached');
    for (const n of env.calls.headerFetchesPerTick) {
        assert.ok(n <= 20, `per-tick header fetches must stay within maxHeaderScanPerTick, saw ${n}`);
    }
});

test('the bounded window still drafts oldest-first and settles everything it sees', async () => {
    // Guard on the ordinary path: the scan fix must not change what happens
    // when the backlog is small enough to fit in one window.
    const messages = Array.from({ length: 19 }, (_, i) => automatedMessage(i + 1));
    messages.push(humanMessage(20));
    const env = makeEnv({ messages });

    await env.tick();

    // Everything in the window was settled in a single pass and the one
    // draftable message was drafted.
    assert.strictEqual(env.calls.deliver.length, 1);
    assert.strictEqual(env.calls.deliver[0].messageId, 'live20@vendor.example');
    assert.strictEqual(env.calls.llm.filter((c) => c.system === TAKEOVER_CLASSIFY_SYSTEM).length, 1,
        'only the human message costs a model call');
});
