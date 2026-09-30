'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createTakeoverStore } = require('../../src/takeover-store');
const { createSecretBox } = require('../../src/secret-box');

// A stand-in for secret-box: these tests are about the store's behaviour, not
// about AES. A reversible marker keeps the assertions readable — and lets one
// test prove the free-text columns really do go through it.
const fakeBox = {
    encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
    decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
};

const USER = 'john@example.com';
const T0 = Date.parse('2026-09-30T12:00:00Z');

function freshStore(opts = {}) {
    return createTakeoverStore({ filePath: ':memory:', secretBox: fakeBox, ...opts });
}

// --------------------------------------------------------------------------
// Settings.
// --------------------------------------------------------------------------

test('a user who has never touched the feature gets the documented defaults', () => {
    const store = freshStore();
    assert.deepStrictEqual(store.get(USER), {
        enabled: false,
        maxRepliesPerHour: 1,
        minDelayMinutes: 5,
        lookbackHours: 24,
        considerAttachments: false
    });
    store.close();
});

test('operator defaults apply to a user who has never touched the feature', () => {
    const store = freshStore({ defaults: { maxRepliesPerHour: 3, lookbackHours: 48, considerAttachments: true } });
    assert.deepStrictEqual(store.get('never@seen.example'), {
        enabled: false, // opt-in is always the user's own
        maxRepliesPerHour: 3,
        minDelayMinutes: 5,
        lookbackHours: 48,
        considerAttachments: true
    });
    store.close();
});

test('the global switch never turns takeover on for a user', () => {
    const store = freshStore({ defaults: { enabled: true } });
    assert.strictEqual(store.get(USER).enabled, false, 'enabled is an opt-in, not a deployment setting');
    assert.strictEqual(store.hasEnabledUsers(), false);
    store.close();
});

test('set merges a patch and returns the state that is actually in force', () => {
    const store = freshStore();
    const state = store.set(USER, { enabled: true, minDelayMinutes: 30 });
    assert.deepStrictEqual(state, {
        enabled: true,
        maxRepliesPerHour: 1,
        minDelayMinutes: 30,
        lookbackHours: 24,
        considerAttachments: false
    });
    assert.deepStrictEqual(store.get(USER), state);
    store.close();
});

test('set clamps out-of-range values instead of accepting them', () => {
    const store = freshStore();
    // 24 is the ceiling.
    assert.strictEqual(store.set(USER, { maxRepliesPerHour: 999 }).maxRepliesPerHour, 24);
    // 0 means paused and is reachable.
    assert.strictEqual(store.set(USER, { maxRepliesPerHour: 0 }).maxRepliesPerHour, 0);
    // The delay floors at 5: no setting weakens the rule the feature is
    // built on.
    assert.strictEqual(store.set(USER, { minDelayMinutes: 1 }).minDelayMinutes, 5);
    assert.strictEqual(store.set(USER, { minDelayMinutes: 0 }).minDelayMinutes, 5);
    assert.strictEqual(store.set(USER, { minDelayMinutes: 99999 }).minDelayMinutes, 1440);
    assert.strictEqual(store.set(USER, { lookbackHours: 0 }).lookbackHours, 1);
    assert.strictEqual(store.set(USER, { lookbackHours: 100000 }).lookbackHours, 720);
    store.close();
});

test('set rejects a typo rather than silently ignoring it', () => {
    const store = freshStore();
    assert.throws(() => store.set(USER, { maxRepliesPerHours: 3 }), /Unknown takeover setting: maxRepliesPerHours/);
    assert.throws(() => store.set(USER, { minDelayMinutes: 'five' }), /must be a number/);
    assert.throws(() => store.set(USER, { enabled: 'yes' }), /must be a boolean/);
    assert.deepStrictEqual(store.get(USER), {
        enabled: false, maxRepliesPerHour: 1, minDelayMinutes: 5, lookbackHours: 24, considerAttachments: false
    }, 'a rejected patch changes nothing');
    store.close();
});

test('hasEnabledUsers sees a user who enabled takeover and logged out', () => {
    const store = freshStore();
    assert.strictEqual(store.hasEnabledUsers(), false);
    store.set(USER, { enabled: true });
    assert.strictEqual(store.hasEnabledUsers(), true);
    assert.deepStrictEqual(store.listEnabledUsers(), [USER]);
    store.set(USER, { enabled: false });
    assert.strictEqual(store.hasEnabledUsers(), false);
    store.close();
});

// --------------------------------------------------------------------------
// Processed messages.
// --------------------------------------------------------------------------

test('a processed message is remembered as processed', () => {
    const store = freshStore();
    assert.strictEqual(store.wasProcessed(USER, 'm1'), false);
    store.recordProcessed(USER, 'm1', 'drafted', T0);
    assert.strictEqual(store.wasProcessed(USER, 'm1'), true);
    // Recording again keeps one row and updates the outcome.
    store.recordProcessed(USER, 'm1', 'dismissed', T0 + 1000);
    assert.strictEqual(store.wasProcessed(USER, 'm1'), true);
    // Another user is unaffected.
    assert.strictEqual(store.wasProcessed('other@example.com', 'm1'), false);
    store.close();
});

test('recordProcessed refuses an empty outcome', () => {
    const store = freshStore();
    assert.throws(() => store.recordProcessed(USER, 'm1', ''), /outcome is required/);
    store.close();
});

// --------------------------------------------------------------------------
// The needs-input queue.
// --------------------------------------------------------------------------

function item(overrides = {}) {
    return {
        messageId: 'm1',
        from: 'alice@vendor.example',
        subject: 'Order 4471',
        missing: ['the delivery date'],
        reason: 'The thread does not say when it arrives.',
        threadSnippet: 'When does order 4471 arrive?',
        createdAt: T0,
        ...overrides
    };
}

test('needs input: the queue round-trips what the assistant stopped on', () => {
    const store = freshStore();
    const id = store.enqueueNeedsInput(USER, item());
    const rows = store.listNeedsInput(USER);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0], {
        id,
        messageId: 'm1',
        from: 'alice@vendor.example',
        subject: 'Order 4471',
        missing: ['the delivery date'],
        reason: 'The thread does not say when it arrives.',
        threadSnippet: 'When does order 4471 arrive?',
        createdAt: T0,
        status: 'open',
        resolvedAt: null,
        advice: ''
    });
    store.close();
});

test('needs input: stopping twice on one message keeps one open item', () => {
    const store = freshStore();
    const first = store.enqueueNeedsInput(USER, item());
    const second = store.enqueueNeedsInput(USER, item({ missing: ['the price'], reason: 'Now it is the price.' }));
    assert.strictEqual(second, first, 'the same message keeps its one open item');
    const rows = store.listNeedsInput(USER);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].missing, ['the price'], 'and the newest reason is the one shown');
    store.close();
});

test('needs input: a resolved item leaves the open queue and hands back the advice', () => {
    const store = freshStore();
    const id = store.enqueueNeedsInput(USER, item());
    const resolved = store.resolveNeedsInput(USER, id, 'It arrives on 14 October');
    assert.strictEqual(resolved.status, 'resolved');
    assert.strictEqual(resolved.advice, 'It arrives on 14 October');
    assert.strictEqual(resolved.resolvedAt > 0, true);

    assert.deepStrictEqual(store.listNeedsInput(USER), [], 'the open queue is empty');
    assert.deepStrictEqual(store.adviceFor(USER, 'm1'), {
        advice: 'It arrives on 14 October',
        resolvedAt: resolved.resolvedAt
    });
    // Resolving twice does not resurrect it.
    assert.strictEqual(store.resolveNeedsInput(USER, id, 'again'), null);
    store.close();
});

test('needs input: dismissal ends the message for good', () => {
    const store = freshStore();
    const id = store.enqueueNeedsInput(USER, item());
    const dropped = store.dismissNeedsInput(USER, id, 'not worth a reply');
    assert.strictEqual(dropped.status, 'dismissed');
    assert.strictEqual(store.listNeedsInput(USER).length, 0);
    assert.strictEqual(store.wasProcessed(USER, 'm1'), true, 'the message is never looked at again');
    assert.strictEqual(store.adviceFor(USER, 'm1'), null, 'and a dismissal is not advice to draft from');
    store.close();
});

test('needs input: the open queue is bounded per user', () => {
    const store = freshStore({ maxPerUser: 2 });
    store.enqueueNeedsInput(USER, item({ messageId: 'm1' }));
    store.enqueueNeedsInput(USER, item({ messageId: 'm2' }));
    assert.throws(() => store.enqueueNeedsInput(USER, item({ messageId: 'm3' })), /Needs-input limit reached \(2\)/);
    // Dismissing one makes room again.
    const id = store.listNeedsInput(USER)[0].id;
    store.dismissNeedsInput(USER, id);
    assert.strictEqual(typeof store.enqueueNeedsInput(USER, item({ messageId: 'm3' })), 'string');
    store.close();
});

// --------------------------------------------------------------------------
// Decisions and replies.
// --------------------------------------------------------------------------

test('decisions: one row per message and decision kind, with a count', () => {
    const store = freshStore();
    store.recordDecision(USER, { messageId: 'm1', decision: 'rate-limited', reason: 'Held back: 1 of 1 per hour.', at: T0 });
    store.recordDecision(USER, { messageId: 'm1', decision: 'rate-limited', reason: 'Held back again.', at: T0 + 60_000 });
    store.recordDecision(USER, { messageId: 'm1', decision: 'drafted', reason: 'A reply is waiting for you.', at: T0 + 120_000 });

    const rows = store.recentDecisions(USER, 10);
    assert.strictEqual(rows.length, 2, 'a repeating block stays one readable row');
    assert.strictEqual(rows[0].decision, 'drafted');
    assert.strictEqual(rows[1].decision, 'rate-limited');
    assert.strictEqual(rows[1].reason, 'Held back again.', 'the latest reason wins');
    assert.strictEqual(rows[1].count, 2);
    store.close();
});

test('replies: the hourly window counts what was put up for approval', () => {
    const store = freshStore();
    assert.strictEqual(store.repliesSince(USER, T0 - 3600_000), 0);
    store.markReplySent(USER, 'm1', T0);
    assert.strictEqual(store.repliesSince(USER, T0 - 3600_000), 1);
    store.markReplySent(USER, 'm1', T0 + 1000);
    assert.strictEqual(store.repliesSince(USER, T0 - 3600_000), 1, 'the same reply is not counted twice');
    store.markReplySent(USER, 'm2', T0 + 2000);
    assert.strictEqual(store.repliesSince(USER, T0 - 3600_000), 2);
    // An hour later, the window is empty.
    assert.strictEqual(store.repliesSince(USER, T0 + 3600_001), 0);
    store.close();
});

// --------------------------------------------------------------------------
// Persistence and encryption.
// --------------------------------------------------------------------------

test('state survives closing the store and opening it again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-store-'));
    const filePath = path.join(dir, 'takeover.db');

    const first = createTakeoverStore({ filePath, secretBox: fakeBox });
    first.set(USER, { enabled: true, maxRepliesPerHour: 2 });
    first.recordProcessed(USER, 'm1', 'drafted', T0);
    first.markReplySent(USER, 'm1', T0);
    first.enqueueNeedsInput(USER, item({ messageId: 'm2', reason: 'It needs the price.' }));
    first.close();

    const second = createTakeoverStore({ filePath, secretBox: fakeBox });
    assert.strictEqual(second.get(USER).enabled, true);
    assert.strictEqual(second.get(USER).maxRepliesPerHour, 2);
    assert.strictEqual(second.wasProcessed(USER, 'm1'), true);
    assert.strictEqual(second.repliesSince(USER, T0 - 3600_000), 1);
    const rows = second.listNeedsInput(USER);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].reason, 'It needs the price.');
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('quoted message text is stored through the secret box, not in the clear', () => {
    // The real box, not the marker fake: a fake that mangles text would let
    // this pass while the store wrote plaintext.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-store-'));
    const filePath = path.join(dir, 'takeover.db');
    const box = createSecretBox({
        envValue: crypto.randomBytes(32).toString('hex'),
        dataDir: dir,
        logger: null
    });

    const store = createTakeoverStore({ filePath, secretBox: box });
    store.enqueueNeedsInput(USER, item({ reason: 'It needs the price of order 4471.', threadSnippet: 'What is the price?' }));
    store.recordDecision(USER, { messageId: 'm1', decision: 'drafted', reason: 'A reply is waiting.', at: T0 });

    // It comes back in the clear to the owner, who owns it.
    const row = store.listNeedsInput(USER)[0];
    assert.strictEqual(row.reason, 'It needs the price of order 4471.');
    assert.strictEqual(row.threadSnippet, 'What is the price?');
    assert.strictEqual(store.recentDecisions(USER, 5)[0].reason, 'A reply is waiting.');

    // WAL means the bytes can be anywhere in the set, so every file the
    // database produced has to be clean — checking only the main file would
    // pass while the text sits in plain sight in the -wal.
    const onDisk = fs.readdirSync(dir)
        .filter((name) => name !== 'credential-key')
        .map((name) => fs.readFileSync(path.join(dir, name)))
        .map((buf) => buf.toString('binary'));
    assert.ok(!onDisk.some((blob) => blob.includes('What is the price?')), 'the quoted text is not in the database files');
    assert.ok(!onDisk.some((blob) => blob.includes('price of order 4471')), 'nor is the reason');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the store will not run without a secret box', () => {
    assert.throws(() => createTakeoverStore({ filePath: ':memory:' }), /secretBox is required/);
});
