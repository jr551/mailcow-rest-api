'use strict';

// Regression tests for takeover-store robustness against bad rows and
// interrupted writes.
//
// 1. `needsRowToEntry` parses the `missing` column with JSON.parse. sqlite
//    stores that column as free text, and a corrupt or hand-edited row must
//    not take the whole needs-input queue (and with it, the worker's user
//    pass) down on one bad byte.
// 2. `dismissNeedsInput` marks the message processed and closes the queue
//    row in two separate statements. If anything fails between them the
//    message is dead while its row is still open — and "resume with advice"
//    promises a re-draft the worker will then never do.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createTakeoverStore } = require('../../src/takeover-store');

const fakeBox = {
    encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
    decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
};

const USER = 'john@example.com';
const KEY = 'm1@vendor.example';

function freshStore(secretBox = fakeBox) {
    return createTakeoverStore({ filePath: ':memory:', secretBox });
}

function enqueue(store) {
    store.enqueueNeedsInput(USER, {
        messageId: KEY,
        from: 'alice@vendor.example',
        subject: 'Delivery date?',
        missing: ['the delivery date for order 4471'],
        reason: 'The reply needs something the message thread does not contain.',
        threadSnippet: 'Hi John, can you confirm the delivery date?'
    });
}

// --------------------------------------------------------------------------
// Corrupt `missing` column.
// --------------------------------------------------------------------------

test('a corrupt missing column degrades to an empty list instead of breaking the queue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-store-'));
    const filePath = path.join(dir, 'takeover.db');
    const store = createTakeoverStore({ filePath, secretBox: fakeBox });
    enqueue(store);
    store.close();

    // Simulate corruption at rest: the column is TEXT as far as sqlite is
    // concerned, so anything can end up in it.
    const raw = new Database(filePath);
    raw.prepare('UPDATE takeover_needs_input SET missing = ? WHERE message_id = ?').run('{not json', KEY);
    raw.close();

    const reopened = createTakeoverStore({ filePath, secretBox: fakeBox });
    const items = reopened.listNeedsInput(USER);
    assert.strictEqual(items.length, 1, 'the queue must still be listable');
    assert.deepStrictEqual(items[0].missing, [], 'an unreadable missing list reads as empty');
    // The readable columns of the same row are unaffected.
    assert.strictEqual(items[0].from, 'alice@vendor.example');
    assert.strictEqual(items[0].reason, 'The reply needs something the message thread does not contain.');
    assert.strictEqual(items[0].threadSnippet, 'Hi John, can you confirm the delivery date?');

    assert.deepStrictEqual(reopened.getNeedsInput(USER, items[0].id).missing, []);
    assert.deepStrictEqual(reopened.listNeedsInputAll(USER)[0].missing, []);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing column holding valid JSON but not a list also reads as empty', () => {
    // JSON.parse succeeds here; only the type is wrong. enqueueNeedsInput
    // always writes a well-formed list, so this too is a corrupt row.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-store-'));
    const filePath = path.join(dir, 'takeover.db');
    const store = createTakeoverStore({ filePath, secretBox: fakeBox });
    enqueue(store);
    store.close();
    const raw = new Database(filePath);
    raw.prepare('UPDATE takeover_needs_input SET missing = ? WHERE message_id = ?').run('{"a":1}', KEY);
    raw.close();
    const reopened = createTakeoverStore({ filePath, secretBox: fakeBox });
    assert.deepStrictEqual(reopened.listNeedsInput(USER)[0].missing, []);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// Interrupted dismiss.
// --------------------------------------------------------------------------

// A secretBox that fails while sealing the dismiss note — a stand-in for any
// failure (throw, busy database, crash) between the two statements of
// dismissNeedsInput. The note is the last thing the second statement needs,
// so this lands exactly between them.
function flakyBox() {
    return {
        encrypt: (v) => {
            if (typeof v === 'string' && v.startsWith('NOTE-BOOM')) {
                throw new Error('simulated crash while writing the dismiss note');
            }
            return fakeBox.encrypt(v);
        },
        decrypt: fakeBox.decrypt
    };
}

test('dismissNeedsInput is all-or-nothing: a failure part way leaves nothing half-done', () => {
    const store = freshStore(flakyBox());
    enqueue(store);
    const id = store.listNeedsInput(USER)[0].id;

    assert.throws(() => store.dismissNeedsInput(USER, id, 'NOTE-BOOM'), /simulated crash/);

    // The whole point: no half-done state. The message is still live and the
    // row is still open, so a retry (or a resume with advice) does what it
    // says on the tin. Before the fix the message was already marked
    // processed here — dead forever while its queue row promised otherwise.
    assert.strictEqual(store.wasProcessed(USER, KEY), false, 'a failed dismiss must not mark the message processed');
    assert.strictEqual(store.listNeedsInput(USER).length, 1, 'a failed dismiss must leave the queue row open');

    // A retry does the whole job in one step.
    const done = store.dismissNeedsInput(USER, id, 'not needed after all');
    assert.ok(done, 'the retry must find the row still open');
    assert.strictEqual(done.status, 'dismissed');
    assert.strictEqual(done.advice, 'not needed after all');
    assert.strictEqual(store.wasProcessed(USER, KEY), true);
    assert.strictEqual(store.listNeedsInput(USER).length, 0);
    store.close();
});

test('dismissNeedsInput still settles a message and closes its row together', () => {
    const store = freshStore();
    enqueue(store);
    const id = store.listNeedsInput(USER)[0].id;

    const done = store.dismissNeedsInput(USER, id, 'answered it myself');
    assert.ok(done);
    assert.strictEqual(done.status, 'dismissed');
    assert.strictEqual(store.wasProcessed(USER, KEY), true);
    assert.strictEqual(store.listNeedsInput(USER).length, 0);
    // Idempotent: a second dismiss finds nothing to do.
    assert.strictEqual(store.dismissNeedsInput(USER, id, 'again'), null);
    store.close();
});
