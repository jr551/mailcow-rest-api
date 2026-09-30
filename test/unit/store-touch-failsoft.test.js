'use strict';

// Regression tests: the `last_used` touch that runs on every successful
// app-password / webhook-inbox verification is a maintenance write, not part
// of the credential check. When the database is full (SQLITE_FULL) or
// read-only (SQLITE_READONLY) the touch fails — and every authenticated
// request used to 500 even though the credential verified fine.
//
// Writes are made to fail while reads keep working by installing a BEFORE
// UPDATE trigger that RAISE(ABORT) — the closest deterministic stand-in for a
// full/read-only database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createAppPasswordStore } = require('../../src/app-password-store');
const { createWebhookInboxStore } = require('../../src/webhook-inbox-store');
const { createSecretBox } = require('../../src/secret-box');

const KEY = 'b'.repeat(64);

function tmpDb(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-touch-fail-'));
    return path.join(dir, name);
}

function failTouch(file, table) {
    const ext = new Database(file);
    ext.exec(`CREATE TRIGGER fail_touch BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    ext.close();
}

test('app-password verify: a failing last_used touch must not fail a valid credential', () => {
    const file = tmpDb('app-passwords.db');
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    const store = createAppPasswordStore({ filePath: file, secretBox });
    try {
        const created = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'mcp', ipRanges: ['203.0.113.0/24']
        });

        failTouch(file, 'app_passwords');

        const res = store.verify({ token: created.token, ip: '203.0.113.5' });
        assert.equal(res.ok, true);
        assert.equal(res.user, 'u@x.com');
        assert.equal(res.password, 'real-pw');
        assert.equal(res.id, created.id);
    } finally {
        store.close();
    }
});

test('app-password verify: a failing touch still rejects a bad secret (checks are not softened)', () => {
    const file = tmpDb('app-passwords.db');
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    const store = createAppPasswordStore({ filePath: file, secretBox });
    try {
        const created = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'mcp', ipRanges: ['203.0.113.0/24']
        });
        const parts = created.token.split('_');
        const forged = `map_${parts[1]}_${'A'.repeat(parts[2].length)}`;

        failTouch(file, 'app_passwords');

        assert.equal(store.verify({ token: forged, ip: '203.0.113.5' }).ok, false);
    } finally {
        store.close();
    }
});

test('app-password verify: the touch still records last_used when writes work', () => {
    const file = tmpDb('app-passwords.db');
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    const store = createAppPasswordStore({ filePath: file, secretBox });
    try {
        const created = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'mcp', ipRanges: ['203.0.113.0/24']
        });
        const res = store.verify({ token: created.token, ip: '203.0.113.5' }, 1_000_000);
        assert.equal(res.ok, true);
        const row = store.list({ user: 'u@x.com' }).find((r) => r.id === created.id);
        assert.equal(row.lastUsedAt, 1_000_000);
        assert.equal(row.lastUsedIp, '203.0.113.5');
    } finally {
        store.close();
    }
});

test('webhook-inbox verify: a failing last_used touch must not fail a valid token', () => {
    const file = tmpDb('webhook-inbox.db');
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    const store = createWebhookInboxStore({ filePath: file, secretBox });
    try {
        const created = store.create({ user: 'u@x.com', password: 'real-pw', label: 'stripe' });

        failTouch(file, 'webhook_inboxes');

        const res = store.verify({ token: created.token });
        assert.equal(res.ok, true);
        assert.equal(res.user, 'u@x.com');
        assert.equal(res.password, 'real-pw');
    } finally {
        store.close();
    }
});

test('webhook-inbox verify: the touch still records last_used when writes work', () => {
    const file = tmpDb('webhook-inbox.db');
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    const store = createWebhookInboxStore({ filePath: file, secretBox });
    try {
        const created = store.create({ user: 'u@x.com', password: 'real-pw', label: 'stripe' });
        const res = store.verify({ token: created.token }, 1_000_000);
        assert.equal(res.ok, true);
        const row = store.list({ user: 'u@x.com' }).find((r) => r.id === created.id);
        assert.equal(row.lastUsedAt, 1_000_000);
    } finally {
        store.close();
    }
});
