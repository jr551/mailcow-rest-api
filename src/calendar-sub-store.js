'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

function createCalendarSubStore({ filePath } = {}) {
    const resolvedPath = filePath || './data/calendar-subs.db';
    if (resolvedPath !== ':memory:') {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_subs (
            id TEXT PRIMARY KEY,
            user TEXT NOT NULL,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#1a73e8',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_calendar_subs_user ON calendar_subs(user);
    `);

    const insert = db.prepare(`
        INSERT INTO calendar_subs (id, user, name, url, color, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const removeStmt = db.prepare('DELETE FROM calendar_subs WHERE id = ? AND user = ?');
    const listStmt = db.prepare('SELECT id, name, url, color FROM calendar_subs WHERE user = ?');
    const getStmt = db.prepare('SELECT id, name, url, color FROM calendar_subs WHERE id = ? AND user = ?');

    function create({ user, name, url, color }) {
        const id = crypto.randomUUID();
        insert.run(id, user, name, url, color || '#1a73e8', Date.now());
        return { id, name, url, color: color || '#1a73e8' };
    }

    function remove({ id, user }) {
        return removeStmt.run(id, user).changes;
    }

    function list({ user }) {
        return listStmt.all(user).map((r) => ({
            id: r.id,
            name: r.name,
            url: r.url,
            color: r.color
        }));
    }

    function get({ id, user }) {
        const r = getStmt.get(id, user);
        if (!r) return null;
        return { id: r.id, name: r.name, url: r.url, color: r.color };
    }

    function close() {
        db.close();
    }

    return { create, remove, list, get, close };
}

module.exports = { createCalendarSubStore };
