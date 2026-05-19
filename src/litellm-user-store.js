'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Same shape as DriveUserStore: persistent json mapping
// `email -> { key, token, keyName, createdAt, expiresAt }`. Lives on the
// /data volume so per-user keys survive container recreates.
class LitellmUserStore {
    constructor(filePath) {
        this.filePath = filePath;
        this._data = null;
        this._ensureFile();
        this._load();
    }

    _ensureFile() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '{}', 'utf8');
    }

    _load() {
        try {
            this._data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch {
            this._data = {};
        }
    }

    _save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2), 'utf8');
        } catch (err) {
            console.warn('[litellm-user-store] failed to save:', err.message);
        }
    }

    get(email) {
        return this._data[email.toLowerCase()] || null;
    }

    set(email, cfg) {
        this._data[email.toLowerCase()] = cfg;
        this._save();
    }

    delete(email) {
        delete this._data[email.toLowerCase()];
        this._save();
    }
}

module.exports = { LitellmUserStore };
