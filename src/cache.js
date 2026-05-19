'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// Auth-verification cache backed by SQLite in WAL mode.
// Stores sha256(email:password) → {valid, expires_at}. Credentials are never
// stored in plaintext. Entries are pruned lazily on read and periodically.

function hashCreds(user, pass) {
    return crypto.createHash('sha256').update(`${user}:${pass}`).digest('hex');
}

function createCache(opts) {
    const { filePath, ttlValidMs, ttlInvalidMs, pruneIntervalMs } = opts;
    const maxLifetimeMs = opts.maxLifetimeMs || 24 * 3600 * 1000;
    const maxMemAuth = opts.maxMemAuth || 2000;
    const maxMemSessions = opts.maxMemSessions || 2000;

    if (filePath !== ':memory:') {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS auth_cache (
            hash TEXT PRIMARY KEY,
            valid INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_cache_expires ON auth_cache(expires_at);

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user TEXT NOT NULL,
            pass TEXT NOT NULL,
            hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);

    try {
        db.exec('ALTER TABLE sessions ADD COLUMN created_at INTEGER');
    } catch {
        // Column already exists — migration is idempotent.
    }
    // Backfill rows from before the migration so the lifetime cap applies.
    db.prepare('UPDATE sessions SET created_at = expires_at - ? WHERE created_at IS NULL').run(ttlValidMs);

    const getStmt = db.prepare('SELECT valid, expires_at FROM auth_cache WHERE hash = ?');
    const setStmt = db.prepare(
        'INSERT INTO auth_cache (hash, valid, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(hash) DO UPDATE SET valid = excluded.valid, expires_at = excluded.expires_at'
    );
    const deleteStmt = db.prepare('DELETE FROM auth_cache WHERE hash = ?');
    const pruneStmt = db.prepare('DELETE FROM auth_cache WHERE expires_at < ?');
    const sizeStmt = db.prepare('SELECT COUNT(*) AS c FROM auth_cache');

    const sessionGetStmt = db.prepare('SELECT user, pass, hash, expires_at, created_at FROM sessions WHERE token = ?');
    const sessionSetStmt = db.prepare('INSERT INTO sessions (token, user, pass, hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const sessionDeleteStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
    const sessionExtendStmt = db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?');
    const sessionPruneStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
    const sessionSizeStmt = db.prepare('SELECT COUNT(*) AS c FROM sessions');

    // In-memory read-through caches to avoid SQLite disk hits on hot entries.
    const authMem = new Map();
    const sessionMem = new Map();

    function memSet(map, key, value, limit) {
        if (map.size >= limit && !map.has(key)) {
            const first = map.keys().next().value;
            map.delete(first);
        }
        map.set(key, value);
    }

    function memGet(map, key, now) {
        const entry = map.get(key);
        if (entry === undefined) return undefined;
        if (entry.expiresAt < now) {
            map.delete(key);
            return undefined;
        }
        return entry;
    }

    function get(hash, now = Date.now()) {
        const cached = memGet(authMem, hash, now);
        if (cached !== undefined) return cached;

        const row = getStmt.get(hash);
        if (!row) return null;
        if (row.expires_at < now) {
            deleteStmt.run(hash);
            return null;
        }
        const result = { valid: row.valid === 1, expiresAt: row.expires_at };
        memSet(authMem, hash, result, maxMemAuth);
        return result;
    }

    function set(hash, valid, now = Date.now()) {
        const ttl = valid ? ttlValidMs : ttlInvalidMs;
        const expiresAt = now + ttl;
        setStmt.run(hash, valid ? 1 : 0, expiresAt);
        memSet(authMem, hash, { valid, expiresAt }, maxMemAuth);
    }

    function invalidate(hash) {
        deleteStmt.run(hash);
        authMem.delete(hash);
    }

    function prune(now = Date.now()) {
        const changes = pruneStmt.run(now).changes;
        authMem.clear();
        return changes;
    }

    function size() {
        return sizeStmt.get().c;
    }

    let pruneTimer = null;
    if (pruneIntervalMs > 0) {
        pruneTimer = setInterval(() => {
            prune();
            pruneSessions();
        }, pruneIntervalMs);
        pruneTimer.unref();
    }

    function createSession(user, pass, hash, now = Date.now()) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = now + ttlValidMs;
        sessionSetStmt.run(token, user, pass, hash, expiresAt, now);
        memSet(sessionMem, token, { user, pass, hash, expiresAt, createdAt: now }, maxMemSessions);
        return { token, expiresAt };
    }

    function getSession(token, now = Date.now()) {
        const cached = memGet(sessionMem, token, now);
        if (cached !== undefined) {
            if (cached.createdAt != null && now - cached.createdAt > maxLifetimeMs) {
                sessionDeleteStmt.run(token);
                sessionMem.delete(token);
                return null;
            }
            const newExpiresAt = now + ttlValidMs;
            cached.expiresAt = newExpiresAt;
            sessionExtendStmt.run(newExpiresAt, token);
            return { user: cached.user, pass: cached.pass, hash: cached.hash, expiresAt: newExpiresAt };
        }

        const row = sessionGetStmt.get(token);
        if (!row) return null;
        if (row.expires_at < now) {
            sessionDeleteStmt.run(token);
            return null;
        }
        const createdAt = row.created_at != null ? row.created_at : (row.expires_at - ttlValidMs);
        if (now - createdAt > maxLifetimeMs) {
            sessionDeleteStmt.run(token);
            return null;
        }
        const newExpiresAt = now + ttlValidMs;
        sessionExtendStmt.run(newExpiresAt, token);
        const result = { user: row.user, pass: row.pass, hash: row.hash, expiresAt: newExpiresAt };
        memSet(sessionMem, token, { ...result, createdAt }, maxMemSessions);
        return result;
    }

    function deleteSession(token) {
        sessionDeleteStmt.run(token);
        sessionMem.delete(token);
    }

    function pruneSessions(now = Date.now()) {
        const changes = sessionPruneStmt.run(now).changes;
        sessionMem.clear();
        return changes;
    }

    function sessionSize() {
        return sessionSizeStmt.get().c;
    }

    function listActiveSessions(now = Date.now()) {
        return db.prepare('SELECT user, pass, hash, expires_at FROM sessions WHERE expires_at > ?').all(now);
    }

    function close() {
        if (pruneTimer) clearInterval(pruneTimer);
        db.close();
    }

    return { get, set, invalidate, prune, size, close, hashCreds, createSession, getSession, deleteSession, pruneSessions, sessionSize, listActiveSessions };
}

module.exports = { createCache, hashCreds };
