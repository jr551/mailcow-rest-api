'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// User-created inbound webhooks ("webhook → email").
//
// Each row is a secret URL a user can hand to a third-party service
// (Stripe, GitHub, a monitor, a script). A POST to that URL lands in the
// owner's INBOX as a normal message. The mailbox password is captured at
// creation and kept encrypted — the API still has to APPEND over IMAP, so
// there is no way around retaining a working credential; the token itself
// is only ever stored as a hash.
//
// Token shape: whk_<id>_<secret> — same idea as app passwords: the id is
// public and indexed, the secret is 32 random bytes compared by SHA-256.
const TOKEN_PREFIX = 'whk_';
const ID_BYTES = 6;
const SECRET_BYTES = 32;

function looksLikeWebhookToken(value) {
    return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
}

function parseToken(token) {
    if (!looksLikeWebhookToken(token)) return null;
    const rest = token.slice(TOKEN_PREFIX.length);
    const sep = rest.indexOf('_');
    if (sep <= 0 || sep === rest.length - 1) return null;
    return { id: rest.slice(0, sep), secret: rest.slice(sep + 1) };
}

function hashSecret(id, secret) {
    return crypto.createHash('sha256').update(`${id}:${secret}`).digest('hex');
}

function createWebhookInboxStore({ filePath, secretBox, maxPerUser = 10 } = {}) {
    const resolvedPath = filePath || './data/webhook-inbox.db';
    if (resolvedPath !== ':memory:') {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_inboxes (
            id TEXT PRIMARY KEY,
            user TEXT NOT NULL,
            label TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            secret TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER,
            revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_webhook_inboxes_user ON webhook_inboxes(user);
    `);

    const insertStmt = db.prepare(`
        INSERT INTO webhook_inboxes (id, user, label, token_hash, secret, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const getStmt = db.prepare('SELECT * FROM webhook_inboxes WHERE id = ?');
    const listStmt = db.prepare(`
        SELECT id, label, created_at, last_used_at
        FROM webhook_inboxes WHERE user = ? AND revoked_at IS NULL
        ORDER BY created_at DESC
    `);
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM webhook_inboxes WHERE user = ? AND revoked_at IS NULL');
    const revokeStmt = db.prepare('UPDATE webhook_inboxes SET revoked_at = ? WHERE id = ? AND user = ? AND revoked_at IS NULL');
    const touchStmt = db.prepare('UPDATE webhook_inboxes SET last_used_at = ? WHERE id = ?');
    const rotateSecretStmt = db.prepare('UPDATE webhook_inboxes SET secret = ? WHERE user = ? AND revoked_at IS NULL');

    function toPublic(row) {
        return {
            id: row.id,
            label: row.label,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at
        };
    }

    // `password` is the caller's live mailbox password, taken from the
    // authenticated request that mints the webhook.
    function create({ user, password, label }, now = Date.now()) {
        const cleanLabel = String(label || '').trim();
        if (!cleanLabel) throw new Error('A label is required');
        if (cleanLabel.length > 100) throw new Error('Label must be 100 characters or fewer');
        if (countStmt.get(user).n >= maxPerUser) {
            throw new Error(`Too many webhook inboxes (limit ${maxPerUser}) — revoke one first`);
        }
        if (!password) throw new Error('Cannot create a webhook inbox without the mailbox password');
        if (!secretBox || !secretBox.enabled) {
            throw new Error('Webhook inboxes need credential encryption; set CREDENTIAL_ENCRYPTION_KEY');
        }

        const id = crypto.randomBytes(ID_BYTES).toString('hex');
        const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
        const token = `${TOKEN_PREFIX}${id}_${secret}`;

        insertStmt.run(id, user, cleanLabel, hashSecret(id, secret), secretBox.encrypt(password), now);
        return { token, ...toPublic(getStmt.get(id)) };
    }

    function list({ user }) {
        return listStmt.all(user).map(toPublic);
    }

    function revoke({ id, user }, now = Date.now()) {
        return revokeStmt.run(now, id, user).changes;
    }

    // Re-encrypt every live webhook's stored mailbox password on password
    // change — same contract as app passwords.
    function refreshSecrets({ user, password }) {
        if (!password || !secretBox || !secretBox.enabled) return 0;
        return rotateSecretStmt.run(secretBox.encrypt(password), user).changes;
    }

    // Returns { ok: true, user, password, id, label } or { ok: false }.
    function verify({ token }, now = Date.now()) {
        const parsed = parseToken(token);
        if (!parsed) return { ok: false, reason: 'malformed' };
        const row = getStmt.get(parsed.id);
        if (!row || row.revoked_at) return { ok: false, reason: 'unknown' };

        const expected = Buffer.from(row.token_hash, 'hex');
        const actual = Buffer.from(hashSecret(parsed.id, parsed.secret), 'hex');
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
            return { ok: false, reason: 'bad-secret' };
        }

        const password = secretBox ? secretBox.decrypt(row.secret) : null;
        if (!password) return { ok: false, reason: 'undecryptable' };

        touchStmt.run(now, row.id);
        return { ok: true, user: row.user, password, id: row.id, label: row.label };
    }

    function close() {
        db.close();
    }

    return { create, list, revoke, verify, refreshSecrets, close, maxPerUser };
}

module.exports = { createWebhookInboxStore, looksLikeWebhookToken, parseToken };
