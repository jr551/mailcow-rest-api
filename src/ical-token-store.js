'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Persistent token store for public iCal feed URLs. Maps an opaque
// 32-byte hex token → { user, pass, calendar, createdAt, expiresAt }
// so that 3rd-party calendar apps can subscribe to a feed without the
// user having to share their mailcow password. Password is stored as-is
// because the CalDAV layer needs to replay it on every refresh; the
// file is mode 0600 in the same volume as the session cache, so this
// is no worse than the existing in-memory session vault.

const TOKEN_BYTES = 32;
// Tokens never expire by default — users complained about subscriptions
// silently breaking after 90 days. Pass a positive ttlMs explicitly to
// opt back in to expiry (we still honour it on read).
const DEFAULT_TTL_MS = 0;

class IcalTokenStore {
    constructor(filePath) {
        this.filePath = filePath;
        this._data = null;
        this._ensureFile();
        this._load();
    }

    _ensureFile() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, '{}', { mode: 0o600 });
        } else {
            try { fs.chmodSync(this.filePath, 0o600); } catch { /* */ }
        }
    }

    _load() {
        try {
            this._data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch {
            this._data = {};
        }
        this._migrateClearExpiry();
        this._migrateEditGrants();
    }

    // Per-event edit links used to carry the feed token itself, so every
    // attendee of a single event received a read+write credential for the
    // whole calendar. Give each record a public id and a separate signing
    // key: edit links now name the id and carry an HMAC over the one uid
    // they are for, and the feed token never leaves the .ics URL.
    _migrateEditGrants() {
        let changed = false;
        for (const v of Object.values(this._data)) {
            if (!v) continue;
            if (!v.id) { v.id = crypto.randomBytes(9).toString('base64url'); changed = true; }
            if (!v.editKey) { v.editKey = crypto.randomBytes(32).toString('hex'); changed = true; }
        }
        if (changed) this._save();
    }

    // One-shot upgrade: clears expiresAt on every existing record so
    // tokens minted under the old 90-day TTL stop dying on subscribers.
    _migrateClearExpiry() {
        let changed = false;
        for (const v of Object.values(this._data)) {
            if (v && v.expiresAt != null) {
                v.expiresAt = null;
                changed = true;
            }
        }
        if (changed) this._save();
    }

    _save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this._data), { mode: 0o600 });
        } catch (err) {
            console.warn('[ical-token-store] save failed:', err.message);
        }
    }

    _purgeExpired() {
        const now = Date.now();
        let changed = false;
        for (const [k, v] of Object.entries(this._data)) {
            if (v.expiresAt && v.expiresAt < now) {
                delete this._data[k];
                changed = true;
            }
        }
        if (changed) this._save();
    }

    // List a user's existing token for a given calendar (one per
    // (user, calendar) pair — issuing a new one rotates the old).
    findByUserCalendar(user, calendar) {
        const u = String(user).toLowerCase();
        for (const [token, v] of Object.entries(this._data)) {
            if (v.user === u && v.calendar === calendar) {
                return { token, ...v };
            }
        }
        return null;
    }

    /** Issue a fresh token, deleting any previous one for the same
     *  (user, calendar). Returns { token, expiresAt }. */
    issue({ user, pass, calendar, ttlMs = DEFAULT_TTL_MS }) {
        const u = String(user).toLowerCase();
        // Drop any existing token for this calendar so the old URL stops
        // working immediately (this is the rotate primitive).
        for (const [k, v] of Object.entries(this._data)) {
            if (v.user === u && v.calendar === calendar) delete this._data[k];
        }
        const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
        const now = Date.now();
        this._data[token] = {
            user: u,
            pass,
            calendar,
            // Public handle for per-event edit links, and the key those
            // links are signed with. Separate from the token so an edit
            // link never carries whole-calendar access.
            id: crypto.randomBytes(9).toString('base64url'),
            editKey: crypto.randomBytes(32).toString('hex'),
            createdAt: now,
            expiresAt: ttlMs > 0 ? now + ttlMs : null
        };
        this._save();
        return { token, expiresAt: this._data[token].expiresAt };
    }

    /** Look up a token. Returns null if missing or expired. */
    get(token) {
        if (!token) return null;
        const rec = this._data[token];
        if (!rec) return null;
        if (rec.expiresAt && rec.expiresAt < Date.now()) {
            delete this._data[token];
            this._save();
            return null;
        }
        return rec;
    }

    /** Look up a record by its public edit id. Returns null if missing or
     *  expired. Used by the per-event edit links, which never see the
     *  feed token. */
    getById(id) {
        if (!id) return null;
        for (const [token, rec] of Object.entries(this._data)) {
            if (rec && rec.id === id) {
                if (rec.expiresAt && rec.expiresAt < Date.now()) {
                    delete this._data[token];
                    this._save();
                    return null;
                }
                return rec;
            }
        }
        return null;
    }

    /** Revoke a user's token for a calendar. No-op if none exists. */
    revoke(user, calendar) {
        const u = String(user).toLowerCase();
        let removed = 0;
        for (const [k, v] of Object.entries(this._data)) {
            if (v.user === u && v.calendar === calendar) {
                delete this._data[k];
                removed++;
            }
        }
        if (removed) this._save();
        return removed > 0;
    }
}

module.exports = { IcalTokenStore, DEFAULT_TTL_MS };
