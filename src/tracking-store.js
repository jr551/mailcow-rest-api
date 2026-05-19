'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// Email open tracking backed by SQLite in WAL mode.
// Stores a random ref → sender/recipient/subject and records when the
// tracking pixel is loaded.

function createTrackingStore(opts) {
    const { filePath, pruneIntervalMs } = opts;

    if (filePath !== ':memory:') {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS tracking_pixels (
            ref TEXT PRIMARY KEY,
            sender TEXT NOT NULL,
            sender_pass TEXT NOT NULL,
            recipient TEXT NOT NULL,
            subject TEXT NOT NULL,
            sent_at INTEGER NOT NULL,
            opened_at INTEGER,
            opener_ip TEXT,
            opener_ua TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tracking_sender ON tracking_pixels(sender);
        CREATE INDEX IF NOT EXISTS idx_tracking_sent_at ON tracking_pixels(sent_at);
    `);

    const createStmt = db.prepare(
        'INSERT INTO tracking_pixels (ref, sender, sender_pass, recipient, subject, sent_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
    );
    const recordOpenStmt = db.prepare(
        'UPDATE tracking_pixels SET opened_at = ?, opener_ip = ?, opener_ua = ? ' +
        'WHERE ref = ? AND opened_at IS NULL'
    );
    const getStmt = db.prepare(
        'SELECT ref, sender, sender_pass, recipient, subject, sent_at, opened_at, opener_ip, opener_ua ' +
        'FROM tracking_pixels WHERE ref = ?'
    );
    const listStmt = db.prepare(
        'SELECT ref, sender, recipient, subject, sent_at, opened_at, opener_ip, opener_ua ' +
        'FROM tracking_pixels WHERE sender = ? ORDER BY sent_at DESC'
    );
    const deleteStmt = db.prepare('DELETE FROM tracking_pixels WHERE ref = ? AND sender = ?');
    const pruneStmt = db.prepare('DELETE FROM tracking_pixels WHERE sent_at < ?');
    const countStmt = db.prepare('SELECT COUNT(*) AS c FROM tracking_pixels');

    function create({ sender, senderPass, recipient, subject, now = Date.now() }) {
        const ref = crypto.randomUUID();
        createStmt.run(ref, sender, senderPass, recipient, subject, now);
        return ref;
    }

    function recordOpen({ ref, ip, ua, now = Date.now() }) {
        const info = recordOpenStmt.run(now, ip || null, ua || null, ref);
        const row = getStmt.get(ref);
        if (!row) return null;
        return {
            ref: row.ref,
            sender: row.sender,
            senderPass: row.sender_pass,
            recipient: row.recipient,
            subject: row.subject,
            sentAt: row.sent_at,
            openedAt: row.opened_at,
            openerIp: row.opener_ip,
            openerUa: row.opener_ua,
            wasFirstOpen: info.changes > 0
        };
    }

    function get(ref) {
        const row = getStmt.get(ref);
        if (!row) return null;
        return {
            ref: row.ref,
            sender: row.sender,
            senderPass: row.sender_pass,
            recipient: row.recipient,
            subject: row.subject,
            sentAt: row.sent_at,
            openedAt: row.opened_at,
            openerIp: row.opener_ip,
            openerUa: row.opener_ua
        };
    }

    function listBySender(sender) {
        return listStmt.all(sender).map((row) => ({
            ref: row.ref,
            sender: row.sender,
            recipient: row.recipient,
            subject: row.subject,
            sentAt: row.sent_at,
            openedAt: row.opened_at,
            openerIp: row.opener_ip,
            openerUa: row.opener_ua
        }));
    }

    function remove({ ref, sender }) {
        return deleteStmt.run(ref, sender).changes;
    }

    function prune(beforeTimestamp) {
        return pruneStmt.run(beforeTimestamp).changes;
    }

    function count() {
        return countStmt.get().c;
    }

    let pruneTimer = null;
    if (pruneIntervalMs > 0) {
        pruneTimer = setInterval(() => {
            const cutoff = Date.now() - pruneIntervalMs;
            prune(cutoff);
        }, pruneIntervalMs);
        pruneTimer.unref();
    }

    function close() {
        if (pruneTimer) clearInterval(pruneTimer);
        db.close();
    }

    return { create, recordOpen, get, listBySender, remove, prune, count, close };
}

module.exports = { createTrackingStore };
