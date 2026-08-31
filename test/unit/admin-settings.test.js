'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminSettings } = require('../../src/admin-settings');

test('admin-settings: webmail defaults to enabled with no stored row', () => {
    const s = createAdminSettings({ filePath: ':memory:' });
    try {
        assert.equal(s.getWebmailEnabled(), true);
        assert.equal(s.webmailSource(), 'default');
    } finally { s.close(); }
});

test('admin-settings: a stored value wins over the default', () => {
    const s = createAdminSettings({ filePath: ':memory:', cacheTtlMs: 0 });
    try {
        s.setWebmailEnabled(false);
        assert.equal(s.getWebmailEnabled(), false);
        assert.equal(s.webmailSource(), 'db');
        s.setWebmailEnabled(true);
        assert.equal(s.getWebmailEnabled(), true);
    } finally { s.close(); }
});

test('admin-settings: WEBMAIL_ENABLED=false cannot be overridden from the DB', () => {
    // The operator disabled the webmail at deploy time. An admin token holder
    // must not be able to switch it back on through the API.
    const s = createAdminSettings({ filePath: ':memory:', envWebmailEnabled: false, cacheTtlMs: 0 });
    try {
        assert.equal(s.getWebmailEnabled(), false);
        s.setWebmailEnabled(true);
        assert.equal(s.getWebmailEnabled(), false);
        assert.equal(s.webmailSource(), 'env-forced-off');
    } finally { s.close(); }
});

test('admin-settings: the read cache expires so a toggle lands without a restart', () => {
    const s = createAdminSettings({ filePath: ':memory:', cacheTtlMs: 2000 });
    try {
        assert.equal(s.getWebmailEnabled(1000), true);
        s.setWebmailEnabled(false);
        // set() invalidates, so even inside the TTL the next read is fresh.
        assert.equal(s.getWebmailEnabled(1500), false);
    } finally { s.close(); }
});

test('admin-settings: values persist across reopen', (t) => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-settings-'));
    const file = path.join(dir, 'admin-settings.db');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const a = createAdminSettings({ filePath: file });
    a.setWebmailEnabled(false);
    a.close();

    const b = createAdminSettings({ filePath: file });
    try {
        assert.equal(b.getWebmailEnabled(), false);
    } finally { b.close(); }
});
