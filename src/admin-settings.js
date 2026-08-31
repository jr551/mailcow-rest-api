'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// Operator settings that need to change without a container restart.
//
// config.js is frozen at boot from the environment, so toggling the webmail
// off used to mean editing .env and recreating the container. This store holds
// the small set of values an admin can flip at runtime; the environment still
// wins when it disables something, so an operator who ships WEBMAIL_ENABLED=false
// cannot have it re-enabled through the API.
function createAdminSettings({ filePath, envWebmailEnabled = true, cacheTtlMs = 2000 } = {}) {
    const resolvedPath = filePath || './data/admin-settings.db';
    if (resolvedPath !== ':memory:') {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);

    const getStmt = db.prepare('SELECT value, updated_at FROM settings WHERE key = ?');
    const setStmt = db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    // getWebmailEnabled() runs on every /webmail* request, including each
    // static asset, so the row is memoised for a beat rather than read per hit.
    let cached = null;

    function get(key) {
        const row = getStmt.get(key);
        return row ? row.value : null;
    }

    function set(key, value) {
        setStmt.run(key, String(value), Date.now());
        cached = null;
    }

    function getWebmailEnabled(now = Date.now()) {
        // The environment is a hard kill switch, not a default.
        if (!envWebmailEnabled) return false;
        if (cached && now - cached.at < cacheTtlMs) return cached.value;
        const raw = get('webmail.enabled');
        const value = raw === null ? true : raw === 'true';
        cached = { value, at: now };
        return value;
    }

    function setWebmailEnabled(enabled) {
        set('webmail.enabled', enabled ? 'true' : 'false');
    }

    // Where the effective value came from, so the admin UI can explain why a
    // PUT did not take effect.
    function webmailSource() {
        if (!envWebmailEnabled) return 'env-forced-off';
        return get('webmail.enabled') === null ? 'default' : 'db';
    }

    function close() {
        db.close();
    }

    return { get, set, getWebmailEnabled, setWebmailEnabled, webmailSource, close };
}

module.exports = { createAdminSettings };
