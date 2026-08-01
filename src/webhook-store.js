'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// Delivery state for the webhook forwarder.
//
// One row per (account, uidvalidity, uid). The row exists only while a
// message is undelivered — a successful POST deletes it, because the
// message itself is then removed from the mailbox and the pair can never
// recur. `uidvalidity` is part of the key because IMAP UIDs are only
// unique within a validity generation; if the mailbox is recreated,
// UID 1 is a genuinely different message.
//
// This lives on disk rather than in memory so a restart mid-backoff
// neither loses the attempt count nor re-POSTs a message immediately.

function createWebhookStore({ filePath }) {
    if (filePath !== ':memory:') {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_queue (
            address TEXT NOT NULL,
            uidvalidity INTEGER NOT NULL,
            uid INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            giving_up INTEGER NOT NULL DEFAULT 0,
            first_seen_at INTEGER NOT NULL,
            PRIMARY KEY (address, uidvalidity, uid)
        );
        CREATE INDEX IF NOT EXISTS idx_wq_next ON webhook_queue(next_attempt_at);
    `);

    const getStmt = db.prepare(
        'SELECT attempts, next_attempt_at, last_error, giving_up FROM webhook_queue ' +
        'WHERE address = ? AND uidvalidity = ? AND uid = ?'
    );
    const upsertStmt = db.prepare(
        'INSERT INTO webhook_queue (address, uidvalidity, uid, attempts, next_attempt_at, last_error, giving_up, first_seen_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(address, uidvalidity, uid) DO UPDATE SET ' +
        'attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at, ' +
        'last_error = excluded.last_error, giving_up = excluded.giving_up'
    );
    const deleteStmt = db.prepare(
        'DELETE FROM webhook_queue WHERE address = ? AND uidvalidity = ? AND uid = ?'
    );
    const pendingStmt = db.prepare(
        'SELECT address, uidvalidity, uid, attempts, next_attempt_at, last_error, giving_up ' +
        'FROM webhook_queue WHERE address = ? ORDER BY uid ASC'
    );
    const countStmt = db.prepare('SELECT COUNT(*) AS c FROM webhook_queue WHERE giving_up = 0');

    function get(address, uidvalidity, uid) {
        return getStmt.get(address, uidvalidity, uid) || null;
    }

    function recordFailure(address, uidvalidity, uid, { attempts, nextAttemptAt, error, givingUp = false }) {
        // first_seen_at is insert-only (the ON CONFLICT clause leaves it
        // alone), so passing "now" on every call is correct for both paths.
        upsertStmt.run(
            address, uidvalidity, uid, attempts, nextAttemptAt,
            String(error || '').slice(0, 500), givingUp ? 1 : 0,
            Date.now()
        );
    }

    function clear(address, uidvalidity, uid) {
        return deleteStmt.run(address, uidvalidity, uid).changes;
    }

    function listForAddress(address) {
        return pendingStmt.all(address);
    }

    function pendingCount() {
        return countStmt.get().c;
    }

    function close() {
        db.close();
    }

    return { get, recordFailure, clear, listForAddress, pendingCount, close };
}

module.exports = { createWebhookStore };
