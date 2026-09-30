'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

// Per-user state for the AI assistant takeover mode.
//
// The takeover worker looks at unread INBOX mail, decides which messages a
// real person is waiting on, drafts a reply in the owner's voice, and then
// STOPS: every draft is handed to /v1/messages/send over Basic auth, which
// creates a pending approval the owner has to click. Nothing is ever sent by
// this subsystem. The state that makes that safe to run unattended lives
// here:
//
//   * settings      — per-user opt-in and the tuning knobs. The rate limit
//                     and the minimum delay are enforced from this table by
//                     the worker, never by the prompt.
//   * processed     — every message that has reached a terminal outcome, so
//                     a restart or a second poll never re-drafts it.
//   * needs_input   — the "couldn't continue" queue: one row per message the
//                     assistant stopped on, with the specific fact(s) it
//                     needed or the reason it could not go on. A message with
//                     an open row is skipped entirely until the owner answers
//                     (resume with advice) or drops it (dismiss).
//   * decisions     — the audit ledger: what was considered, what was
//                     declined and why, what was rate limited, what was
//                     blocked, what was drafted. One row per
//                     (message, decision) so a block that repeats every poll
//                     stays a single readable row with a count.
//   * replies       — when a draft was actually submitted for approval, which
//                     is what the hourly rate limit counts.
//
// "Sent" in this file always means "handed to the approval gate", never "left
// this server". The owner's click is what sends mail.
//
// Encryption follows the outbound-webhook-store precedent exactly: anything
// that could carry a credential or private content is sealed through
// secretBox before it touches disk. Quoted message text is not a credential,
// but it routinely carries them — password resets, order numbers, one-time
// codes — and a leaked sqlite file is the realistic threat, so the free-text
// columns (reason, thread snippet, advice, decision detail) are encrypted
// and only the short structured fields (ids, outcome codes, missing-fact
// labels) are stored in the clear.

// Writable settings and their hard bounds.
//
// maxRepliesPerHour = 0 means paused: the worker never drafts for that user.
// minDelayMinutes floors at 5 — the delay is a hard server-side fact of this
// feature and no setting may weaken it below what the owner asked for.
const SETTINGS = {
    enabled: { column: 'enabled', type: 'boolean', def: false },
    maxRepliesPerHour: { column: 'max_replies_per_hour', type: 'int', def: 1, min: 0, max: 24 },
    minDelayMinutes: { column: 'min_delay_minutes', type: 'int', def: 5, min: 5, max: 1440 },
    lookbackHours: { column: 'lookback_hours', type: 'int', def: 24, min: 1, max: 720 },
    considerAttachments: { column: 'consider_attachments', type: 'boolean', def: false }
};

const MAX_MISSING = 20;
const MAX_TEXT = 20_000;
const MAX_REASON = 2000;
const MAX_OUTCOME = 40;
const MAX_DECISION = 40;

function clampInt(value, spec, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(spec.max, Math.max(spec.min, Math.round(n)));
}

// Build the state for a row, falling back to the configured default when the
// row is missing or a column is unreadable.
function toState(row, base) {
    const out = { ...base };
    if (!row) return out;
    for (const [key, spec] of Object.entries(SETTINGS)) {
        if (spec.type === 'boolean') out[key] = !!row[spec.column];
        else out[key] = clampInt(row[spec.column], spec, out[key]);
    }
    return out;
}

function toStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((v) => typeof v === 'string')
        .map((v) => v.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON))
        .filter(Boolean)
        .slice(0, MAX_MISSING);
}

// The `missing` column holds JSON as far as this module is concerned, but it
// is TEXT as far as sqlite is: a corrupt or hand-edited row must not take
// the whole needs-input queue down on one bad byte. An unreadable value
// degrades to an empty list — the same honest fallback the decrypted columns
// use — so the row still shows with its reason and thread instead of the
// route (or the worker's user pass) failing on it.
function parseMissing(value) {
    try {
        return toStringArray(JSON.parse(value || '[]'));
    } catch {
        return [];
    }
}

function createTakeoverStore({ filePath, secretBox, maxPerUser = 50, defaults = {} } = {}) {
    if (!secretBox) {
        throw new Error('createTakeoverStore: secretBox is required — quoted message text is encrypted at rest');
    }
    const resolvedPath = filePath || './data/takeover.db';
    if (resolvedPath !== ':memory:') {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS takeover_settings (
            user TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            max_replies_per_hour INTEGER NOT NULL DEFAULT 1,
            min_delay_minutes INTEGER NOT NULL DEFAULT 5,
            lookback_hours INTEGER NOT NULL DEFAULT 24,
            consider_attachments INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS takeover_processed (
            user TEXT NOT NULL,
            message_id TEXT NOT NULL,
            outcome TEXT NOT NULL,
            at INTEGER NOT NULL,
            PRIMARY KEY (user, message_id)
        );

        CREATE TABLE IF NOT EXISTS takeover_needs_input (
            id TEXT PRIMARY KEY,
            user TEXT NOT NULL,
            message_id TEXT NOT NULL,
            from_addr TEXT NOT NULL,
            subject TEXT NOT NULL,
            missing TEXT NOT NULL DEFAULT '[]',
            reason TEXT,
            thread_snippet TEXT,
            created_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            resolved_at INTEGER,
            advice TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_takeover_needs_input_user
            ON takeover_needs_input (user, status, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_takeover_needs_input_open
            ON takeover_needs_input (user, message_id) WHERE status = 'open';

        CREATE TABLE IF NOT EXISTS takeover_decisions (
            user TEXT NOT NULL,
            message_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            reason TEXT,
            detail TEXT,
            at INTEGER NOT NULL,
            seen_count INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (user, message_id, decision)
        );
        CREATE INDEX IF NOT EXISTS idx_takeover_decisions_user
            ON takeover_decisions (user, at);

        CREATE TABLE IF NOT EXISTS takeover_replies (
            user TEXT NOT NULL,
            message_id TEXT NOT NULL,
            at INTEGER NOT NULL,
            PRIMARY KEY (user, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_takeover_replies_user_at
            ON takeover_replies (user, at);
    `);

    const getSettingsStmt = db.prepare('SELECT * FROM takeover_settings WHERE user = ?');
    const upsertSettingsStmt = db.prepare(`
        INSERT INTO takeover_settings
            (user, enabled, max_replies_per_hour, min_delay_minutes, lookback_hours, consider_attachments, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user) DO UPDATE SET
            enabled = excluded.enabled,
            max_replies_per_hour = excluded.max_replies_per_hour,
            min_delay_minutes = excluded.min_delay_minutes,
            lookback_hours = excluded.lookback_hours,
            consider_attachments = excluded.consider_attachments,
            updated_at = excluded.updated_at
    `);
    const enabledUsersStmt = db.prepare('SELECT user FROM takeover_settings WHERE enabled = 1 ORDER BY user');

    const wasProcessedStmt = db.prepare(
        'SELECT 1 AS hit FROM takeover_processed WHERE user = ? AND message_id = ?'
    );
    const recordProcessedStmt = db.prepare(`
        INSERT INTO takeover_processed (user, message_id, outcome, at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user, message_id) DO UPDATE SET outcome = excluded.outcome, at = excluded.at
    `);

    const openNeedsForMessageStmt = db.prepare(
        'SELECT * FROM takeover_needs_input WHERE user = ? AND message_id = ? AND status = ?'
    );
    const openNeedsCountStmt = db.prepare(
        'SELECT COUNT(*) AS n FROM takeover_needs_input WHERE user = ? AND status = ?'
    );
    const insertNeedsStmt = db.prepare(`
        INSERT INTO takeover_needs_input
            (id, user, message_id, from_addr, subject, missing, reason, thread_snippet, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `);
    const updateNeedsStmt = db.prepare(`
        UPDATE takeover_needs_input
        SET from_addr = ?, subject = ?, missing = ?, reason = ?, thread_snippet = ?, created_at = ?
        WHERE id = ? AND status = 'open'
    `);
    const listNeedsStmt = db.prepare(
        'SELECT * FROM takeover_needs_input WHERE user = ? AND status = ? ORDER BY created_at ASC, id ASC'
    );
    const listAllNeedsStmt = db.prepare(
        'SELECT * FROM takeover_needs_input WHERE user = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    );
    const getNeedsStmt = db.prepare('SELECT * FROM takeover_needs_input WHERE id = ? AND user = ?');
    const resolveNeedsStmt = db.prepare(`
        UPDATE takeover_needs_input SET status = 'resolved', resolved_at = ?, advice = ?
        WHERE id = ? AND user = ? AND status = 'open'
    `);
    const dismissNeedsStmt = db.prepare(`
        UPDATE takeover_needs_input SET status = 'dismissed', resolved_at = ?, advice = ?
        WHERE id = ? AND user = ? AND status = 'open'
    `);

    const upsertDecisionStmt = db.prepare(`
        INSERT INTO takeover_decisions (user, message_id, decision, reason, detail, at, seen_count)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(user, message_id, decision) DO UPDATE SET
            reason = excluded.reason,
            detail = excluded.detail,
            at = excluded.at,
            seen_count = takeover_decisions.seen_count + 1
    `);
    const recentDecisionsStmt = db.prepare(`
        SELECT * FROM takeover_decisions WHERE user = ?
        ORDER BY at DESC, decision ASC LIMIT ?
    `);

    const repliesSinceStmt = db.prepare(
        'SELECT COUNT(*) AS n FROM takeover_replies WHERE user = ? AND at >= ?'
    );
    const markReplyStmt = db.prepare(`
        INSERT INTO takeover_replies (user, message_id, at) VALUES (?, ?, ?)
        ON CONFLICT(user, message_id) DO UPDATE SET at = excluded.at
    `);

    // Defaults for a user who has never touched the feature, so an
    // operator's TAKEOVER_* values are what actually applies. Every one is
    // clamped to the same hard bounds a user's own settings are.
    const baseState = {};
    for (const [key, spec] of Object.entries(SETTINGS)) {
        const raw = defaults[key];
        baseState[key] = spec.type === 'boolean'
            ? (typeof raw === 'boolean' ? raw : spec.def)
            : clampInt(raw, spec, spec.def);
    }
    // `enabled` is the user's own opt-in and never inherits from the
    // deployment config. The global switch decides whether the feature runs
    // at all; inheriting it here would turn the assistant on for everyone the
    // moment an operator set TAKEOVER_ENABLED=true, which is the one thing
    // this design must never do quietly.
    baseState.enabled = false;

    // --- settings -------------------------------------------------------

    // Always returns all five fields, for a user that has never touched the
    // feature as well. A route or the worker must never have to know whether
    // a row exists.
    function get(user) {
        return toState(getSettingsStmt.get(String(user)), baseState);
    }

    // Merge a partial patch over the current state. Unknown keys throw —
    // a typo'd knob must not be silently dropped, or the UI would show a
    // setting that is not in effect. Out-of-range numbers are clamped and the
    // clamped value is what comes back, so the caller always sees the state
    // that is actually in force.
    function set(user, patch = {}) {
        const u = String(user);
        if (!patch || typeof patch !== 'object') {
            throw new Error('takeover settings patch must be an object');
        }
        for (const key of Object.keys(patch)) {
            if (!SETTINGS[key]) throw new Error(`Unknown takeover setting: ${key}`);
        }

        const current = get(u);
        const next = { ...current };
        for (const [key, spec] of Object.entries(SETTINGS)) {
            if (!(key in patch)) continue;
            const value = patch[key];
            if (spec.type === 'boolean') {
                if (typeof value !== 'boolean') throw new Error(`takeover setting ${key} must be a boolean`);
                next[key] = value;
            } else {
                if (typeof value !== 'number' || !Number.isFinite(value)) {
                    throw new Error(`takeover setting ${key} must be a number`);
                }
                next[key] = clampInt(value, spec, spec.def);
            }
        }

        upsertSettingsStmt.run(
            u,
            next.enabled ? 1 : 0,
            next.maxRepliesPerHour,
            next.minDelayMinutes,
            next.lookbackHours,
            next.considerAttachments ? 1 : 0,
            Date.now()
        );
        return next;
    }

    // The wiring rule is "run the worker only while someone has it on", and
    // it has to hold for a user who enabled it and then logged out — so this
    // reads the settings table, not the session cache.
    function listEnabledUsers() {
        return enabledUsersStmt.all().map((row) => row.user);
    }

    function hasEnabledUsers() {
        return listEnabledUsers().length > 0;
    }

    // --- processed ------------------------------------------------------

    // `outcome` is a short terminal code: 'drafted', 'skipped-automated',
    // 'no-reply-needed', 'out-of-window', 'dismissed'. Call this only when
    // the message will never be looked at again — anything the worker may
    // retry (a delay, a rate limit, a failed delivery, a missing fact) must
    // leave the message unprocessed so the next poll picks it up.
    function wasProcessed(user, messageId) {
        return !!wasProcessedStmt.get(String(user), String(messageId));
    }

    function recordProcessed(user, messageId, outcome, at = Date.now()) {
        const code = String(outcome || '').trim().slice(0, MAX_OUTCOME);
        if (!code) throw new Error('recordProcessed: outcome is required');
        recordProcessedStmt.run(String(user), String(messageId), code, at);
    }

    // --- needs input ----------------------------------------------------

    function needsRowToEntry(row) {
        return {
            id: row.id,
            messageId: row.message_id,
            from: row.from_addr,
            subject: row.subject,
            missing: parseMissing(row.missing),
            // decrypt() returns null for a tampered or wrong-key payload;
            // an empty string is the honest fallback rather than leaking
            // ciphertext into the UI.
            reason: secretBox.decrypt(row.reason) || '',
            threadSnippet: secretBox.decrypt(row.thread_snippet) || '',
            createdAt: row.created_at,
            status: row.status,
            resolvedAt: row.resolved_at ?? null,
            advice: secretBox.decrypt(row.advice) || ''
        };
    }

    // Stop and ask the owner. One open row per message: if the assistant
    // blocks on the same message twice the row is refreshed in place rather
    // than duplicated, so the queue stays one item per thing that needs a
    // human.
    function enqueueNeedsInput(user, { messageId, from, subject, missing, reason, threadSnippet, createdAt } = {}) {
        const u = String(user);
        const mid = String(messageId || '');
        if (!mid) throw new Error('enqueueNeedsInput: messageId is required');

        const existing = openNeedsForMessageStmt.get(u, mid, 'open');
        const at = Number.isFinite(createdAt) ? createdAt : Date.now();
        const fromAddr = String(from || '').slice(0, MAX_REASON);
        const subj = String(subject || '').slice(0, MAX_REASON);
        const missingList = toStringArray(missing);
        const why = String(reason || '').slice(0, MAX_REASON);
        const snippet = String(threadSnippet || '').slice(0, MAX_TEXT);

        if (existing) {
            updateNeedsStmt.run(fromAddr, subj, JSON.stringify(missingList), secretBox.encrypt(why), secretBox.encrypt(snippet), at, existing.id);
            return existing.id;
        }

        const open = openNeedsCountStmt.get(u, 'open').n;
        if (open >= maxPerUser) {
            throw new Error(`Needs-input limit reached (${maxPerUser})`);
        }

        const id = crypto.randomBytes(6).toString('hex');
        insertNeedsStmt.run(
            id, u, mid, fromAddr, subj,
            JSON.stringify(missingList), secretBox.encrypt(why), secretBox.encrypt(snippet), at
        );
        return id;
    }

    // Open items only — this is the "couldn't continue" window.
    function listNeedsInput(user) {
        return listNeedsStmt.all(String(user), 'open').map(needsRowToEntry);
    }

    // Including resolved and dismissed ones, newest first. Additive to the
    // contract; the worker does not need it.
    function listNeedsInputAll(user, limit = 50) {
        const n = Math.min(500, Math.max(1, Math.round(Number(limit) || 50)));
        return listAllNeedsStmt.all(String(user), n).map(needsRowToEntry);
    }

    function getNeedsInput(user, id) {
        const row = getNeedsStmt.get(String(id), String(user));
        return row ? needsRowToEntry(row) : null;
    }

    // "Resume with advice": close the item and hand back the advice, which
    // the worker feeds into the next draft as the owner's own instruction.
    // The message stays unprocessed, so the next poll re-drafts it.
    function resolveNeedsInput(user, id, advice) {
        const u = String(user);
        const row = getNeedsStmt.get(String(id), u);
        if (!row || row.status !== 'open') return null;
        resolveNeedsStmt.run(Date.now(), secretBox.encrypt(String(advice || '')), String(id), u);
        return getNeedsInput(u, id);
    }

    // "Stop on this one": close the item and mark the message processed in
    // the same step, so it can never come back. The two writes run inside
    // one sqlite transaction: a message marked processed while its row is
    // still open is stranded — the owner could still "resume with advice" it
    // and the worker would never re-draft it — so an interrupted dismiss
    // must leave nothing half-done. The message is marked first so a
    // concurrent poll cannot re-draft it in between; the transaction is what
    // makes the pair all-or-nothing.
    const dismissTxn = db.transaction((u, messageId, at, note, id) => {
        recordProcessedStmt.run(u, messageId, 'dismissed', at);
        dismissNeedsStmt.run(at, secretBox.encrypt(String(note || '')), id, u);
    });

    function dismissNeedsInput(user, id, note) {
        const u = String(user);
        const row = getNeedsStmt.get(String(id), u);
        if (!row || row.status !== 'open') return null;
        dismissTxn(u, row.message_id, Date.now(), String(note || ''), String(id));
        return getNeedsInput(u, id);
    }

    // The owner's answer for a message, if he has given one. The worker
    // passes this into the next draft as verbatim instructions.
    function adviceFor(user, messageId) {
        const rows = listAllNeedsStmt.all(String(user), 50);
        for (const row of rows) {
            if (row.message_id !== String(messageId)) continue;
            if (row.status !== 'resolved') continue;
            const advice = secretBox.decrypt(row.advice) || '';
            if (!advice.trim()) continue;
            return { advice, resolvedAt: row.resolved_at ?? null };
        }
        return null;
    }

    // --- decisions ------------------------------------------------------

    // One row per (message, decision), upserted: a block that repeats every
    // poll updates its own row and bumps seen_count instead of filling the
    // ledger with copies. The reason is always a complete sentence — the UI
    // is expected to show it verbatim.
    function recordDecision(user, { messageId, decision, reason, detail, at } = {}) {
        const u = String(user);
        const mid = String(messageId || '');
        const code = String(decision || '').trim().slice(0, MAX_DECISION);
        if (!mid) throw new Error('recordDecision: messageId is required');
        if (!code) throw new Error('recordDecision: decision is required');
        upsertDecisionStmt.run(
            u,
            mid,
            code,
            secretBox.encrypt(String(reason || '').slice(0, MAX_REASON)),
            secretBox.encrypt(detail === undefined || detail === null ? '' : JSON.stringify(detail).slice(0, MAX_TEXT)),
            Number.isFinite(at) ? at : Date.now()
        );
    }

    function recentDecisions(user, limit = 50) {
        const n = Math.min(500, Math.max(1, Math.round(Number(limit) || 50)));
        return recentDecisionsStmt.all(String(user), n).map((row) => ({
            messageId: row.message_id,
            decision: row.decision,
            reason: secretBox.decrypt(row.reason) || '',
            at: row.at,
            // How many times this decision has been reached. A block seen 40
            // times is a different story from one seen once, and the row is
            // the same.
            count: row.seen_count
        }));
    }

    // --- replies --------------------------------------------------------

    // "Sent" here = a draft was handed to /v1/messages/send and therefore a
    // pending approval exists. It does not mean the recipient has anything:
    // the owner's click on the approval link is what actually sends.
    function repliesSince(user, sinceMs) {
        return repliesSinceStmt.get(String(user), Number(sinceMs) || 0).n;
    }

    function markReplySent(user, messageId, atMs = Date.now()) {
        markReplyStmt.run(String(user), String(messageId), Number(atMs) || Date.now());
    }

    function close() {
        db.close();
    }

    return {
        get,
        set,
        listEnabledUsers,
        hasEnabledUsers,
        wasProcessed,
        recordProcessed,
        enqueueNeedsInput,
        listNeedsInput,
        listNeedsInputAll,
        getNeedsInput,
        resolveNeedsInput,
        dismissNeedsInput,
        adviceFor,
        recordDecision,
        recentDecisions,
        repliesSince,
        markReplySent,
        close
    };
}

module.exports = {
    createTakeoverStore,
    SETTINGS
};
