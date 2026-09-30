'use strict';

// Regression test: the one-time plaintext-credential migration must run for
// EVERY store even when the session cache is unusable.
//
// The migration block used to read `cache.migratePlaintextSessions` unguarded.
// When createCache() failed (corrupt cache.db — the fail-open path), `cache`
// was null, the property access threw a TypeError *inside* the try block, and
// the catch logged the misleading "credential migration failed" — while
// tracking-store's migratePlaintextSenders() never ran at all. Mailbox
// passwords written before encryption existed then stayed plaintext at rest,
// silently, under a log line that blamed the migration rather than the null
// cache.

// Env must be set before src/config is required (it snapshots env at load).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-migration-'));
process.env.CACHE_PATH = path.join(dataDir, 'cache.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { build } = require('../../src/server');
const { createTrackingStore } = require('../../src/tracking-store');

test('build(): a dead session cache must not skip the plaintext sender migration', async () => {
    // Seed a tracking pixel the way pre-encryption versions wrote it:
    // sender_pass in plaintext (no secret box).
    const legacy = createTrackingStore({ filePath: path.join(dataDir, 'tracking.db'), pruneIntervalMs: 0 });
    legacy.create({ sender: 'me@example.com', senderPass: 'mailbox-password-123', recipient: 'you@example.com', subject: 'hi', now: Date.now() });
    legacy.close();

    // Corrupt cache.db so createCache() throws and build() proceeds with
    // cache = null (the documented fail-open behaviour).
    fs.writeFileSync(path.join(dataDir, 'cache.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192, 0x41)]));

    const app = await build({ cache: null });
    await app.close();

    const db = new Database(path.join(dataDir, 'tracking.db'), { readonly: true });
    const row = db.prepare('SELECT sender_pass FROM tracking_pixels LIMIT 1').get();
    db.close();
    assert.ok(row, 'seeded tracking row is still there');
    assert.notEqual(
        row.sender_pass,
        'mailbox-password-123',
        'the mailbox password must have been sealed even though the session cache was unusable'
    );
});

test('build(): a dead session cache must not break /health or shutdown', async () => {
    fs.writeFileSync(path.join(dataDir, 'cache.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192, 0x41)]));

    const app = await build({ cache: null });
    try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).ok, true);
    } finally {
        await app.close(); // must resolve: cleanup after this point must still run
    }
});
