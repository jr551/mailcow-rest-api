'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Pending email-send approvals (Basic-auth /v1/messages/send). With filePath,
// rows survive restarts; without it, the in-memory Map keeps unit tests fast.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Each held send can carry a multi-megabyte draft, so the live rows per user
// are bounded.
const MAX_LIVE_PER_USER = 25;

function pendingLimitError() {
    const err = new Error(`Too many sends are awaiting approval (max ${MAX_LIVE_PER_USER}). Approve or deny some, or wait for them to expire.`);
    err.code = 'PENDING_LIMIT';
    return err;
}

function payloadFromEntry(entry) {
    return JSON.stringify({
        from: entry.from,
        to: entry.to,
        cc: entry.cc,
        bcc: entry.bcc,
        subject: entry.subject,
        text: entry.text,
        html: entry.html,
        inReplyTo: entry.inReplyTo,
        attachments: entry.attachments,
        trackOpens: entry.trackOpens,
        unsureReason: entry.unsureReason
    });
}

function entryFromPayload(row, passPlain) {
    const payload = JSON.parse(row.payload);
    return {
        createdAt: row.created_at,
        user: row.user,
        pass: passPlain,
        ...payload
    };
}

function createMapStore({ ttlMs, secretBox, logger, resendApproval }) {
    const store = new Map();

    function sealPass(pass) {
        if (secretBox && secretBox.enabled) return secretBox.encrypt(pass);
        return pass;
    }

    function openPass(stored) {
        if (secretBox && secretBox.enabled) return secretBox.decrypt(stored);
        return stored;
    }

    function unpack(stored) {
        const { forwardedAt, forwardedTo, pass, ...rest } = stored;
        return { ...rest, pass: openPass(pass) };
    }

    function isExpired(entry) {
        return Date.now() - entry.createdAt > ttlMs;
    }

    function reKey(token, stored) {
        const freshToken = crypto.randomBytes(32).toString('hex');
        const passPlain = typeof stored.pass === 'string' && secretBox?.isEncrypted(stored.pass)
            ? openPass(stored.pass)
            : stored.pass;
        const entry = { ...stored, pass: passPlain };
        const wasForwarded = !!stored.forwardedAt;
        const shouldResend = !wasForwarded && typeof resendApproval === 'function';

        const next = {
            ...entry,
            pass: sealPass(entry.pass),
            createdAt: Date.now(),
            forwardedAt: wasForwarded ? stored.forwardedAt : null,
            forwardedTo: wasForwarded ? stored.forwardedTo : null
        };

        store.delete(token);
        store.set(freshToken, next);

        let resent = false;
        if (shouldResend) {
            try {
                const p = resendApproval({ token: freshToken, entry });
                if (p && typeof p.then === 'function') {
                    p.then(() => {
                        const row = store.get(freshToken);
                        if (row) {
                            row.forwardedAt = Date.now();
                            row.forwardedTo = entry.user;
                        }
                    }).catch((err) => {
                        logger?.warn?.({ err }, 'pending send approval resend failed');
                    });
                } else {
                    next.forwardedAt = Date.now();
                    next.forwardedTo = entry.user;
                    resent = true;
                }
            } catch (err) {
                logger?.warn?.({ err }, 'pending send approval resend failed');
            }
        }

        if (shouldResend && !resent) {
            // Async resend: report resent optimistically for the expired page path.
            resent = true;
        }

        return { freshToken, entry, resent };
    }

    function create(entry) {
        let live = 0;
        for (const stored of store.values()) {
            if (stored.user === entry.user && !isExpired(stored)) live++;
        }
        if (live >= MAX_LIVE_PER_USER) throw pendingLimitError();
        const token = crypto.randomBytes(32).toString('hex');
        store.set(token, {
            ...entry,
            pass: sealPass(entry.pass),
            createdAt: Date.now(),
            forwardedAt: null,
            forwardedTo: null
        });
        return token;
    }

    function get(token, onExpired) {
        const stored = store.get(token);
        if (!stored) return null;
        if (!isExpired(stored)) return unpack(stored);
        const info = reKey(token, stored);
        if (onExpired) onExpired({ freshToken: info.freshToken, resent: info.resent });
        return null;
    }

    function claim(token) {
        const stored = store.get(token);
        if (!stored) return null;
        if (isExpired(stored)) {
            reKey(token, stored);
            return null;
        }
        store.delete(token);
        return unpack(stored);
    }

    function remove(token) {
        return store.delete(token);
    }

    function restore(token, entry) {
        if (!token || !entry) return false;
        store.set(token, {
            ...entry,
            pass: sealPass(entry.pass),
            createdAt: entry.createdAt ?? Date.now(),
            forwardedAt: entry.forwardedAt ?? null,
            forwardedTo: entry.forwardedTo ?? null
        });
        return true;
    }

    function prune() {
        const ttlCutoff = Date.now() - ttlMs;
        const weekCutoff = Date.now() - SEVEN_DAYS_MS;
        for (const [token, entry] of store) {
            if (entry.createdAt < weekCutoff) {
                store.delete(token);
                continue;
            }
            if (entry.forwardedAt != null && entry.forwardedAt < ttlCutoff) {
                store.delete(token);
            }
        }
    }

    const timer = setInterval(prune, 5 * 60 * 1000);
    timer.unref && timer.unref();

    function close() {
        clearInterval(timer);
        store.clear();
    }

    return { create, get, claim, restore, remove, prune, close };
}

function createSqliteStore({ ttlMs, filePath, secretBox, logger, resendApproval }) {
    const Database = require('better-sqlite3');
    const resolvedPath = filePath;
    if (resolvedPath !== ':memory:') {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const db = new Database(resolvedPath);
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS pending_sends (
            token TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            user TEXT NOT NULL,
            pass TEXT NOT NULL,
            payload TEXT NOT NULL,
            forwarded_at INTEGER,
            forwarded_to TEXT
        );
    `);

    const insertStmt = db.prepare(`
        INSERT INTO pending_sends (token, created_at, user, pass, payload, forwarded_at, forwarded_to)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertStmt = db.prepare(`
        INSERT OR REPLACE INTO pending_sends (token, created_at, user, pass, payload, forwarded_at, forwarded_to)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const selectStmt = db.prepare('SELECT * FROM pending_sends WHERE token = ?');
    const countLiveStmt = db.prepare('SELECT COUNT(*) AS n FROM pending_sends WHERE user = ? AND created_at >= ?');
    const deleteStmt = db.prepare('DELETE FROM pending_sends WHERE token = ?');
    const markForwardedStmt = db.prepare(`
        UPDATE pending_sends SET forwarded_at = ?, forwarded_to = ? WHERE token = ?
    `);
    const pruneStmt = db.prepare(`
        DELETE FROM pending_sends
        WHERE created_at < ?
           OR (forwarded_at IS NOT NULL AND forwarded_at < ?)
    `);

    function sealPass(pass) {
        if (secretBox && secretBox.enabled) return secretBox.encrypt(pass);
        return pass;
    }

    function openPass(stored) {
        if (secretBox && secretBox.enabled) return secretBox.decrypt(stored);
        return stored;
    }

    function isExpiredRow(row) {
        return Date.now() - row.created_at > ttlMs;
    }

    function rowToEntry(row) {
        return entryFromPayload(row, openPass(row.pass));
    }

    function reKeyRow(row) {
        const freshToken = crypto.randomBytes(32).toString('hex');
        const entry = rowToEntry(row);
        const now = Date.now();
        const wasForwarded = row.forwarded_at != null;
        const shouldResend = !wasForwarded && typeof resendApproval === 'function';

        const forwardedAt = wasForwarded ? row.forwarded_at : null;
        const forwardedTo = wasForwarded ? row.forwarded_to : null;

        const rekey = db.transaction(() => {
            deleteStmt.run(row.token);
            insertStmt.run(
                freshToken,
                now,
                row.user,
                row.pass,
                row.payload,
                forwardedAt,
                forwardedTo
            );
        });
        rekey();

        let resent = false;
        if (shouldResend) {
            try {
                const p = resendApproval({ token: freshToken, entry });
                if (p && typeof p.then === 'function') {
                    p.then(() => {
                        try {
                            markForwardedStmt.run(Date.now(), entry.user, freshToken);
                        } catch (err) {
                            logger?.warn?.({ err }, 'pending send mark forwarded failed');
                        }
                    }).catch((err) => {
                        logger?.warn?.({ err }, 'pending send approval resend failed');
                    });
                    resent = true;
                } else {
                    markForwardedStmt.run(Date.now(), entry.user, freshToken);
                    resent = true;
                }
            } catch (err) {
                logger?.warn?.({ err }, 'pending send approval resend failed');
            }
        }

        return { freshToken, entry, resent };
    }

    function create(entry) {
        const now = Date.now();
        if (countLiveStmt.get(entry.user, now - ttlMs).n >= MAX_LIVE_PER_USER) throw pendingLimitError();
        const token = crypto.randomBytes(32).toString('hex');
        insertStmt.run(token, now, entry.user, sealPass(entry.pass), payloadFromEntry(entry), null, null);
        return token;
    }

    function get(token, onExpired) {
        const row = selectStmt.get(token);
        if (!row) return null;
        if (!isExpiredRow(row)) return rowToEntry(row);
        const info = reKeyRow(row);
        if (onExpired) onExpired({ freshToken: info.freshToken, resent: info.resent });
        return null;
    }

    function claim(token) {
        const row = selectStmt.get(token);
        if (!row) return null;
        if (isExpiredRow(row)) {
            reKeyRow(row);
            return null;
        }
        deleteStmt.run(token);
        return rowToEntry(row);
    }

    function remove(token) {
        const result = deleteStmt.run(token);
        return result.changes > 0;
    }

    function restore(token, entry) {
        if (!token || !entry) return false;
        try {
            upsertStmt.run(
                token,
                entry.createdAt ?? Date.now(),
                entry.user,
                sealPass(entry.pass),
                payloadFromEntry(entry),
                entry.forwardedAt ?? null,
                entry.forwardedTo ?? null
            );
            return true;
        } catch (err) {
            logger?.warn?.({ err }, 'pending send restore failed');
            return false;
        }
    }

    function prune() {
        const now = Date.now();
        pruneStmt.run(now - SEVEN_DAYS_MS, now - ttlMs);
    }

    const timer = setInterval(prune, 5 * 60 * 1000);
    timer.unref && timer.unref();

    function close() {
        clearInterval(timer);
        db.close();
    }

    return { create, get, claim, restore, remove, prune, close };
}

function createPendingSendStore({
    ttlMs = DEFAULT_TTL_MS,
    filePath,
    secretBox,
    logger,
    resendApproval,
    baseUrl
} = {}) {
    if (filePath) {
        if (!(secretBox && secretBox.enabled)) {
            logger?.warn?.({ filePath }, 'pending sends are stored with the mailbox password in plaintext: credential encryption is disabled');
        }
        try {
            return createSqliteStore({ ttlMs, filePath, secretBox, logger, resendApproval, baseUrl });
        } catch (err) {
            logger?.error?.({ err, filePath }, 'pending send sqlite open failed; using in-memory store');
        }
    }
    return createMapStore({ ttlMs, secretBox, logger, resendApproval, baseUrl });
}

module.exports = { createPendingSendStore };
