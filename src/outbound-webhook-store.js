'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { sanitizeWebhookHeaders } = require('./utils/webhook-headers');
const { webhookMailbox } = require('./sieve-client');

// User-created outbound webhooks ("email → webhook").
//
// The inverse of webhook-inbox-store: there, a third party POSTs to us and
// the body becomes mail. Here, mail that matches a Sieve rule is POSTed to a
// URL the user names.
//
// Sieve has no HTTP action, so the rule cannot do the POST itself. Instead
// the rule redirects the message into a hidden mailbox this store owns —
// `.wh-<id>` — and the forwarder polls it. That indirection is what makes the
// feature possible at all, and it is also why the mailbox name is derived
// from the id rather than stored: the two can never drift apart.
//
// The signing secret is a credential (it is what lets a receiver prove a POST
// came from us), so it is stored encrypted and only ever returned at creation
// — the same contract as app passwords and webhook-inbox tokens.

const ID_BYTES = 6;
const MAX_LABEL = 100;
const MAX_URL = 2000;
const MAX_PREPEND = 4000;

// The id ends up inside an IMAP mailbox name, so it must survive a folder
// round-trip untouched: lowercase hex only. A name containing a delimiter or
// a space would be re-encoded differently by each client and the forwarder
// would poll a mailbox that does not exist.
function generateId() {
    return crypto.randomBytes(ID_BYTES).toString('hex');
}

// Naming lives in sieve-client (it is part of the Sieve contract); re-exported
// here so callers of the store do not have to know that.
const mailboxFor = webhookMailbox;

// The prepend is free text the user writes once and every forwarded message
// carries. It is prepended to a message body, so it must not be able to
// forge a header or a MIME boundary: strip CR/LF entirely rather than
// escaping them, because there is no legitimate reason for a one-line
// preamble to contain a line break.
function normalizePrepend(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_PREPEND);
}

// 100, not 10: a webhook per consumer is the normal shape for this feature
// (one per model endpoint, per integration, per environment), and the cap
// exists to bound a runaway script, not to ration legitimate use. The
// delivery side costs nothing per idle webhook — the forwarder only opens an
// IMAP connection when there is parked mail — so a high cap costs the
// operator nothing and stops the UI from being a wall of clutter.
function createOutboundWebhookStore({ filePath, secretBox, maxPerUser = 100 } = {}) {
    const resolvedPath = filePath || './data/outbound-webhooks.db';
    if (resolvedPath !== ':memory:') {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS outbound_webhooks (
            id TEXT PRIMARY KEY,
            user TEXT NOT NULL,
            label TEXT NOT NULL,
            url TEXT NOT NULL,
            secret TEXT NOT NULL,
            keep INTEGER NOT NULL DEFAULT 0,
            prepend TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            last_used_at INTEGER,
            revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_outbound_webhooks_user
            ON outbound_webhooks (user, revoked_at);
    `);

    // The forwarder has to open the owner's hidden mailbox over IMAP, and
    // there is no way to do that without a working credential — the same
    // constraint webhook-inbox-store is under. It is kept encrypted, and
    // re-encrypted whenever the user changes their password (refreshSecrets).
    try {
        db.exec('ALTER TABLE outbound_webhooks ADD COLUMN password TEXT');
    } catch { /* fresh db already has it */ }

    // Custom request headers (Authorization and friends). These are
    // credentials — a bearer token in a header is exactly as sensitive as
    // the mailbox password — so the map is JSON-encoded and stored through
    // secretBox like `secret` and `password`, and the public shape only ever
    // shows the header names, never the values.
    try {
        db.exec('ALTER TABLE outbound_webhooks ADD COLUMN headers TEXT');
    } catch { /* fresh db already has it */ }

    const insertStmt = db.prepare(`
        INSERT INTO outbound_webhooks
            (id, user, label, url, secret, keep, prepend, created_at, password, headers)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getStmt = db.prepare('SELECT * FROM outbound_webhooks WHERE id = ?');
    const listStmt = db.prepare(
        'SELECT * FROM outbound_webhooks WHERE user = ? AND revoked_at IS NULL ORDER BY created_at DESC'
    );
    const listAllLiveStmt = db.prepare(
        'SELECT * FROM outbound_webhooks WHERE revoked_at IS NULL ORDER BY created_at ASC'
    );
    const countStmt = db.prepare(
        'SELECT COUNT(*) AS n FROM outbound_webhooks WHERE user = ? AND revoked_at IS NULL'
    );
    const revokeStmt = db.prepare(
        'UPDATE outbound_webhooks SET revoked_at = ? WHERE id = ? AND user = ? AND revoked_at IS NULL'
    );
    const touchStmt = db.prepare('UPDATE outbound_webhooks SET last_used_at = ? WHERE id = ?');
    const updateStmt = db.prepare(`
        UPDATE outbound_webhooks SET label = ?, keep = ?, prepend = ?, headers = ?
        WHERE id = ? AND user = ? AND revoked_at IS NULL
    `);

    // Stored form is `secretBox.encrypt(JSON.stringify(map))` or null.
    // Public responses get the sorted header names only; listAllLive (the
    // forwarder path) gets the real decrypted map.
    function encryptHeaders(headers) {
        if (headers === undefined || headers === null) return null;
        // The routes validate first, so a bad map here is a defensive
        // throw, not the user-facing error path.
        const res = sanitizeWebhookHeaders(headers);
        if (!res.ok) throw new Error(res.error);
        return Object.keys(res.headers).length ? secretBox.encrypt(JSON.stringify(res.headers)) : null;
    }
    function decryptHeaders(encoded) {
        if (!encoded) return {};
        try {
            return JSON.parse(secretBox.decrypt(encoded)) || {};
        } catch {
            return {};
        }
    }
    function headerNames(encoded) {
        return Object.keys(decryptHeaders(encoded)).sort();
    }

    // The secret never leaves the server after creation, so it is not part of
    // the public shape at all — not even as a hash.
    function toPublic(row) {
        return {
            id: row.id,
            label: row.label,
            url: row.url,
            keep: !!row.keep,
            prepend: row.prepend || '',
            mailbox: mailboxFor(row.id),
            createdAt: row.created_at ?? null,
            lastUsedAt: row.last_used_at ?? null,
            // Names only, sorted — the values are credentials and never
            // leave the server after the caller supplies them.
            headerNames: headerNames(row.headers)
        };
    }

    // `keep` defaults to TRUE: the destructive branch deletes the message
    // after delivery, and a caller that simply omits the field must not lose
    // mail. The webmail form already defaults to keeping.
    function create({ user, password, label, url, keep = true, prepend = '', headers }, now = Date.now()) {
        if (countStmt.get(user).n >= maxPerUser) {
            throw new Error(`Webhook limit reached (${maxPerUser})`);
        }
        const id = generateId();
        const secret = crypto.randomBytes(32).toString('hex');
        insertStmt.run(
            id,
            user,
            String(label).trim().slice(0, MAX_LABEL),
            String(url).trim().slice(0, MAX_URL),
            secretBox.encrypt(secret),
            keep ? 1 : 0,
            normalizePrepend(prepend),
            now,
            secretBox.encrypt(password),
            encryptHeaders(headers)
        );
        return { ...toPublic(getStmt.get(id)), secret };
    }

    function list({ user }) {
        return listStmt.all(user).map(toPublic);
    }

    // Every live webhook across all users — the forwarder needs to know which
    // hidden mailboxes to poll, and it has no per-user context of its own.
    // This is the only path that returns the decrypted mailbox password.
    function listAllLive() {
        return listAllLiveStmt.all().map((row) => ({
            ...toPublic(row),
            user: row.user,
            secret: secretBox.decrypt(row.secret),
            password: secretBox.decrypt(row.password),
            headers: decryptHeaders(row.headers)
        }));
    }

    // Re-encrypt every live webhook's stored mailbox password after the user
    // changes it. Without this the forwarder keeps authenticating with the
    // old password and every delivery fails with an auth error that looks
    // like a server fault. Same contract as webhook-inbox-store.
    function refreshSecrets({ user, password }) {
        const rows = listStmt.all(user);
        for (const row of rows) {
            db.prepare('UPDATE outbound_webhooks SET password = ? WHERE id = ?')
                .run(secretBox.encrypt(password), row.id);
        }
        return rows.length;
    }

    function get({ id, user }) {
        const row = getStmt.get(id);
        if (!row || row.revoked_at || (user && row.user !== user)) return null;
        return toPublic(row);
    }


    // One live webhook in delivery shape — the real signing secret and the
    // real header values — for the owner only.
    //
    // Deliberately NOT listAllLive: that path crosses users (the forwarder
    // polls every mailbox) and also hands back the mailbox password, which a
    // test send has no business holding. This one is scoped by user and
    // returns only what an HTTP POST to the subscriber needs, so the secret
    // can be signed with on the server without ever crossing to the browser
    // and without widening who can read it.
    function getLive({ id, user }) {
        const row = getStmt.get(id);
        if (!row || row.revoked_at || (user && row.user !== user)) return null;
        return {
            ...toPublic(row),
            secret: secretBox.decrypt(row.secret),
            headers: decryptHeaders(row.headers)
        };
    }
    function update({ id, user, label, keep, prepend, headers }) {
        const row = getStmt.get(id);
        if (!row || row.revoked_at || row.user !== user) return null;
        updateStmt.run(
            label === undefined ? row.label : String(label).trim().slice(0, MAX_LABEL),
            keep === undefined ? row.keep : (keep ? 1 : 0),
            prepend === undefined ? row.prepend : normalizePrepend(prepend),
            // undefined = leave unchanged; null or {} = clear; otherwise a
            // full replace. Sanitize rejects reserved/forged names before
            // anything is written.
            headers === undefined ? row.headers : encryptHeaders(headers),
            id,
            user
        );
        return toPublic(getStmt.get(id));
    }

    function revoke({ id, user }, now = Date.now()) {
        return revokeStmt.run(now, id, user).changes;
    }

    function touch(id, now = Date.now()) {
        touchStmt.run(now, id);
    }

    function close() {
        db.close();
    }

    return { create, list, listAllLive, getLive, get, update, revoke, touch, refreshSecrets, close, maxPerUser };
}

module.exports = {
    createOutboundWebhookStore,
    normalizePrepend
};
