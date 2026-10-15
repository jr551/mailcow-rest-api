'use strict';

// The folder UID manifest is keyed by uidvalidity and validated by comparing
// its length with the mailbox's live EXISTS — never by the clock — so a
// manifest that is "old" is still correct and simply saves a SEARCH. Giving
// it the generic 5-minute ttlMs meant any folder the user visited less often
// than that re-ran SEARCH ALL. uidsTtlMs (default 24 h) applies to the
// folder_uids table and its in-memory tier only; the mailbox tree and folder
// status keep ttlMs because those are read as authoritative for display.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createImapCache } = require('../../src/imap-cache');

test('a UID manifest outlives the generic ttlMs while the mailbox tree does not', async () => {
    const cache = createImapCache({ filePath: ':memory:', ttlMs: 1, uidsTtlMs: 60_000, pruneIntervalMs: 0 });
    try {
        cache.setTree('h', [{ path: 'INBOX' }]);
        cache.setUids('h', 'INBOX', 1, [3, 2, 1]);
        await new Promise((r) => setTimeout(r, 20));

        assert.equal(cache.getTree('h'), null, 'the tree carries the generic ttlMs');
        assert.deepEqual(cache.getUids('h', 'INBOX', 1), [3, 2, 1], 'the manifest carries uidsTtlMs');

        // prune() deletes expired rows and clears the in-memory tiers, so
        // this read can only come from the SQLite row — proving the stored
        // expiry is uidsTtlMs and not the 1 ms ttlMs.
        cache.prune();
        assert.deepEqual(cache.getUids('h', 'INBOX', 1), [3, 2, 1]);
        assert.equal(cache.getTree('h'), null);
    } finally {
        cache.close();
    }
});

test('the 24 h default applies when only ttlMs is configured (server.js passes no uidsTtlMs)', async () => {
    const cache = createImapCache({ filePath: ':memory:', ttlMs: 1, pruneIntervalMs: 0 });
    try {
        cache.setUids('h', 'INBOX', 1, [2, 1]);
        await new Promise((r) => setTimeout(r, 20));
        cache.prune();
        assert.deepEqual(cache.getUids('h', 'INBOX', 1), [2, 1]);
    } finally {
        cache.close();
    }
});
