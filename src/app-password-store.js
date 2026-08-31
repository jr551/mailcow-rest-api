'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const { parseAllowlist, isAllowed } = require('./ip-allow');

// Scoped, revocable credentials for REST and MCP clients.
//
// A user who wants to point an MCP client or a script at their mailbox should
// not have to paste their actual mailbox password into a config file, where it
// grants IMAP, SMTP, and webmail access forever and can only be withdrawn by
// changing the password everywhere. An app password is issued per client, is
// pinned to the IP ranges that client actually calls from, and can be revoked
// on its own.
//
// The API still has to perform a real IMAP LOGIN to do anything, so the
// mailbox password is captured when the app password is minted and kept
// encrypted (same AES-256-GCM box as sessions and tracking). The app password
// itself is never stored — only a hash of it — so a stolen database yields no
// usable token.
//
// Token shape: map_<id>_<secret>
//   id     public, indexed, identifies the row (and so the mailbox) on its own,
//          which lets the token authenticate without an accompanying username.
//   secret 32 random bytes; compared against a stored SHA-256.
const TOKEN_PREFIX = 'map_';
const ID_BYTES = 6;
const SECRET_BYTES = 32;

function looksLikeAppPassword(value) {
    return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
}

function parseToken(token) {
    if (!looksLikeAppPassword(token)) return null;
    const rest = token.slice(TOKEN_PREFIX.length);
    const sep = rest.indexOf('_');
    if (sep <= 0) return null;
    const id = rest.slice(0, sep);
    const secret = rest.slice(sep + 1);
    if (!id || !secret) return null;
    return { id, secret };
}

function hashSecret(id, secret) {
    // The id salts the hash so two rows that somehow shared a secret still
    // get distinct digests.
    return crypto.createHash('sha256').update(`${id}:${secret}`).digest('hex');
}

// Reject a range that is syntactically fine but scopes nothing, and normalise
// what we store so the list shown back to the user matches what is enforced.
function normalizeCidrs(input) {
    const list = Array.isArray(input)
        ? input
        : String(input || '').split(',');
    const cleaned = list.map((s) => String(s).trim()).filter(Boolean);
    if (cleaned.length === 0) {
        throw new Error('At least one IP range is required');
    }
    // Throws on anything malformed, with the offending entry named.
    parseAllowlist(cleaned.join(','));
    return cleaned;
}

function createAppPasswordStore({ filePath, secretBox, maxPerUser = 25 } = {}) {
    const resolvedPath = filePath || './data/app-passwords.db';
    if (resolvedPath !== ':memory:') {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS app_passwords (
            id TEXT PRIMARY KEY,
            user TEXT NOT NULL,
            label TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            cidrs TEXT NOT NULL,
            secret TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            last_used_at INTEGER,
            last_used_ip TEXT,
            revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_app_passwords_user ON app_passwords(user);
    `);

    const insertStmt = db.prepare(`
        INSERT INTO app_passwords (id, user, label, token_hash, cidrs, secret, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getStmt = db.prepare('SELECT * FROM app_passwords WHERE id = ?');
    const listStmt = db.prepare(`
        SELECT id, label, cidrs, created_at, expires_at, last_used_at, last_used_ip
        FROM app_passwords WHERE user = ? AND revoked_at IS NULL
        ORDER BY created_at DESC
    `);
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM app_passwords WHERE user = ? AND revoked_at IS NULL');
    const countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM app_passwords WHERE revoked_at IS NULL');
    const revokeStmt = db.prepare('UPDATE app_passwords SET revoked_at = ? WHERE id = ? AND user = ? AND revoked_at IS NULL');
    const touchStmt = db.prepare('UPDATE app_passwords SET last_used_at = ?, last_used_ip = ? WHERE id = ?');
    const rotateSecretStmt = db.prepare('UPDATE app_passwords SET secret = ? WHERE user = ? AND revoked_at IS NULL');

    function toPublic(row) {
        return {
            id: row.id,
            label: row.label,
            ipRanges: row.cidrs.split(',').filter(Boolean),
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            lastUsedAt: row.last_used_at,
            lastUsedIp: row.last_used_ip
        };
    }

    // `password` is the caller's live mailbox password, taken from the
    // authenticated request that mints the token.
    function create({ user, password, label, ipRanges, expiresInDays }, now = Date.now()) {
        const cidrs = normalizeCidrs(ipRanges);
        const cleanLabel = String(label || '').trim();
        if (!cleanLabel) throw new Error('A label is required');
        if (cleanLabel.length > 100) throw new Error('Label must be 100 characters or fewer');
        if (countStmt.get(user).n >= maxPerUser) {
            throw new Error(`Too many app passwords (limit ${maxPerUser}) — revoke one first`);
        }
        if (!password) throw new Error('Cannot mint an app password without the mailbox password');
        if (!secretBox || !secretBox.enabled) {
            throw new Error('App passwords need credential encryption; set CREDENTIAL_ENCRYPTION_KEY');
        }

        const id = crypto.randomBytes(ID_BYTES).toString('hex');
        const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
        const token = `${TOKEN_PREFIX}${id}_${secret}`;
        const expiresAt = expiresInDays ? now + Number(expiresInDays) * 86_400_000 : null;

        insertStmt.run(
            id, user, cleanLabel, hashSecret(id, secret), cidrs.join(','),
            secretBox.encrypt(password), now, expiresAt
        );

        // The only time the token exists in cleartext.
        return { token, ...toPublic(getStmt.get(id)) };
    }

    function list({ user }) {
        return listStmt.all(user).map(toPublic);
    }

    function revoke({ id, user }, now = Date.now()) {
        return revokeStmt.run(now, id, user).changes;
    }

    function countAll() {
        return countAllStmt.get().n;
    }

    // Re-encrypt every live token's stored mailbox password. Called when the
    // user proves a new password, so a password change doesn't silently break
    // every client they have configured.
    function refreshSecrets({ user, password }) {
        if (!password || !secretBox || !secretBox.enabled) return 0;
        return rotateSecretStmt.run(secretBox.encrypt(password), user).changes;
    }

    // Returns { ok: true, user, password, id, label } or { ok: false, reason }.
    // `reason` is for the server log — callers must not echo it to the client,
    // since it distinguishes "wrong token" from "right token, wrong network".
    function verify({ token, ip }, now = Date.now()) {
        const parsed = parseToken(token);
        if (!parsed) return { ok: false, reason: 'malformed' };

        const row = getStmt.get(parsed.id);
        if (!row) return { ok: false, reason: 'unknown' };
        if (row.revoked_at) return { ok: false, reason: 'revoked' };
        if (row.expires_at && now > row.expires_at) return { ok: false, reason: 'expired' };

        const expected = Buffer.from(row.token_hash, 'hex');
        const actual = Buffer.from(hashSecret(parsed.id, parsed.secret), 'hex');
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
            return { ok: false, reason: 'bad-secret' };
        }

        // The IP scope is the whole point of an app password: a leaked token
        // is only usable from the networks its owner named.
        const rules = parseAllowlist(row.cidrs);
        if (!isAllowed(ip, rules)) return { ok: false, reason: 'ip-not-allowed' };

        const password = secretBox ? secretBox.decrypt(row.secret) : null;
        if (!password) return { ok: false, reason: 'undecryptable' };

        touchStmt.run(now, ip || null, row.id);
        return { ok: true, user: row.user, password, id: row.id, label: row.label };
    }

    function close() {
        db.close();
    }

    return {
        create, list, revoke, verify, countAll, refreshSecrets, close,
        maxPerUser
    };
}

module.exports = {
    createAppPasswordStore,
    looksLikeAppPassword,
    parseToken,
    normalizeCidrs,
    TOKEN_PREFIX
};
