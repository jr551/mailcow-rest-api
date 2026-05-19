'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
            fs.writeFileSync(this.filePath, '{}', 'utf8');
        }
    }

    _load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            this._data = JSON.parse(raw);
        } catch {
            this._data = {};
        }
    }

    _save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2), 'utf8');
        } catch (err) {
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
