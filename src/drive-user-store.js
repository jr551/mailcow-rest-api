'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Holds every user's B2 application key in plaintext, so the file is
// owner-only and written via a temp file + rename: a crash mid-write must
// not leave a truncated file that _load would read as "no users".
class DriveUserStore {
    constructor(filePath) {
        this.filePath = filePath;
        this._data = null;
        this._ensureFile();
        this._load();
    }

    _ensureFile() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, '{}', { encoding: 'utf8', mode: 0o600 });
        } else {
            try { fs.chmodSync(this.filePath, 0o600); } catch { /* */ }
        }
    }

    _load() {
        let raw;
        try {
            raw = fs.readFileSync(this.filePath, 'utf8');
        } catch (err) {
            console.warn('[drive-user-store] failed to read:', err.message);
            this._data = {};
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
            this._data = parsed;
        } catch (err) {
            // Keep the unreadable file for recovery rather than letting the
            // next save overwrite it with an empty book.
            const backup = `${this.filePath}.bak`;
            try { fs.renameSync(this.filePath, backup); } catch { /* */ }
            console.warn(`[drive-user-store] ${this.filePath} is corrupt (${err.message}); kept as ${backup}`);
            this._data = {};
        }
    }

    _save() {
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, this.filePath);
        } catch (err) {
            try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
            // Best-effort persistence
            console.warn('[drive-user-store] failed to save:', err.message);
        }
    }

    get(email) {
        return this._data[email.toLowerCase()] || null;
    }

    set(email, cfg) {
        this._data[email.toLowerCase()] = cfg;
        this._save();
    }

    has(email) {
        return !!this._data[email.toLowerCase()];
    }

    all() {
        return { ...this._data };
    }
}

module.exports = { DriveUserStore };
