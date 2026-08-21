'use strict';

// The approval link was a GET that sent the mail, with no atomic claim:
//  * two concurrent clicks both observed the entry and sent the mail twice
//  * mail scanners (SafeLinks, Proofpoint) fetch links in inbound mail, and
//    the approval email lands in the user's own INBOX — so a scanner could
//    approve the send before the user ever saw it

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPendingSendStore } = require('../../src/pending-send-store');

test('claim() hands the entry to exactly one caller', () => {
    const store = createPendingSendStore({});
    const token = store.create({ to: ['a@b.c'], subject: 'once' });

    const first = store.claim(token);
    const second = store.claim(token);

    assert.ok(first, 'the first claim wins');
    assert.equal(second, null, 'the second gets nothing — no double send');
    store.close();
});

test('claim() removes the entry before any await can interleave', async () => {
    const store = createPendingSendStore({});
    const token = store.create({ to: ['a@b.c'], subject: 'race' });

    // Simulate the real handler: claim, then do slow async work. Two of these
    // running concurrently must not both proceed to the send.
    let sends = 0;
    async function approve() {
        const entry = store.claim(token);
        if (!entry) return 'rejected';
        await new Promise((r) => setTimeout(r, 10)); // stands in for SMTP
        sends++;
        return 'sent';
    }

    const results = await Promise.all([approve(), approve(), approve()]);
    assert.equal(sends, 1, 'the message is sent exactly once');
    assert.deepEqual(results.filter((r) => r === 'sent').length, 1);
    store.close();
});

test('restore() puts a claimed entry back after a failed send', () => {
    const store = createPendingSendStore({});
    const token = store.create({ to: ['a@b.c'], subject: 'retry' });

    const entry = store.claim(token);
    assert.equal(store.claim(token), null, 'claimed, so gone');

    store.restore(token, entry);
    const again = store.claim(token);
    assert.ok(again, 'the user can retry the same link');
    assert.equal(again.subject, 'retry');
    store.close();
});

test('claim() refuses an expired entry and does not resurrect it', () => {
    const store = createPendingSendStore({ ttlMs: -1 }); // everything is already stale
    const token = store.create({ to: ['a@b.c'], subject: 'stale' });
    assert.equal(store.claim(token), null);
    assert.equal(store.get(token), null);
    store.close();
});

test('get() is side-effect free, so a link scanner changes nothing', () => {
    const store = createPendingSendStore({});
    const token = store.create({ to: ['a@b.c'], subject: 'peek' });

    // What the GET confirmation page does, three times over.
    assert.ok(store.get(token));
    assert.ok(store.get(token));
    assert.ok(store.get(token));

    // The entry is still there to be claimed by the user's POST.
    assert.ok(store.claim(token), 'still sendable after being read');
    store.close();
});
