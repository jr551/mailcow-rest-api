'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// IMAP metadata cache: mailbox tree and per-folder UID manifests.
// Caches lightweight data (not full message objects) and uses cheap IMAP
// STATUS / SELECT values for invalidation.
//
// Tables:
//   mailbox_tree  — serialized LIST result per user
//   folder_uids   — ordered UID array per folder (keyed by uidvalidity)
//   folder_status — cached STATUS result per folder

function createImapCache(opts) {
    const { filePath, ttlMs = 300_000, pruneIntervalMs = 60_000 } = opts || {};
    const maxMemTree = opts.maxMemTree || 500;
    const maxMemUids = opts.maxMemUids || 500;
    const maxMemStatus = opts.maxMemStatus || 500;

    if (filePath !== ':memory:') {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS mailbox_tree (
            user_hash TEXT PRIMARY KEY,
            tree TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS folder_uids (
            user_hash TEXT NOT NULL,
            path TEXT NOT NULL,
            uidvalidity INTEGER NOT NULL,
            uids TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (user_hash, path, uidvalidity)
        );

        CREATE TABLE IF NOT EXISTS folder_status (
            user_hash TEXT NOT NULL,
            path TEXT NOT NULL,
            status TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (user_hash, path)
        );
    `);

    const treeGetStmt = db.prepare('SELECT tree FROM mailbox_tree WHERE user_hash = ? AND expires_at > ?');
    const treeSetStmt = db.prepare(
        'INSERT INTO mailbox_tree (user_hash, tree, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(user_hash) DO UPDATE SET tree = excluded.tree, expires_at = excluded.expires_at'
    );
    const treeDeleteStmt = db.prepare('DELETE FROM mailbox_tree WHERE user_hash = ?');
    const treePruneStmt = db.prepare('DELETE FROM mailbox_tree WHERE expires_at < ?');

    const uidsGetStmt = db.prepare(
        'SELECT uids FROM folder_uids WHERE user_hash = ? AND path = ? AND uidvalidity = ? AND expires_at > ?'
    );
    const uidsSetStmt = db.prepare(
        'INSERT INTO folder_uids (user_hash, path, uidvalidity, uids, expires_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(user_hash, path, uidvalidity) DO UPDATE SET uids = excluded.uids, expires_at = excluded.expires_at'
    );
    const uidsDeleteStmt = db.prepare('DELETE FROM folder_uids WHERE user_hash = ? AND path = ?');
    const uidsPruneStmt = db.prepare('DELETE FROM folder_uids WHERE expires_at < ?');

    const statusGetStmt = db.prepare('SELECT status FROM folder_status WHERE user_hash = ? AND path = ? AND expires_at > ?');
    const statusSetStmt = db.prepare(
        'INSERT INTO folder_status (user_hash, path, status, expires_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(user_hash, path) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at'
    );
    const statusDeleteStmt = db.prepare('DELETE FROM folder_status WHERE user_hash = ? AND path = ?');
    const statusPruneStmt = db.prepare('DELETE FROM folder_status WHERE expires_at < ?');

    // In-memory read-through caches
    const treeMem = new Map();
    const uidsMem = new Map();
    const statusMem = new Map();

    function memSet(map, key, value, limit) {
        if (map.size >= limit && !map.has(key)) {
            const first = map.keys().next().value;
            map.delete(first);
        }
        map.set(key, value);
    }

    function memGet(map, key) {
        return map.get(key);
    }

    function memDelete(map, key) {
        map.delete(key);
    }

    function now() {
        return Date.now();
    }

    // ---------- Mailbox tree ----------

    function getTree(userHash) {
        const n = now();
        const mem = memGet(treeMem, userHash);
        if (mem && mem.expiresAt > n) {
            return mem.tree;
        }
        const row = treeGetStmt.get(userHash, n);
        if (!row) return null;
        try {
            const tree = JSON.parse(row.tree);
            memSet(treeMem, userHash, { tree, expiresAt: n + ttlMs }, maxMemTree);
            return tree;
        } catch {
            return null;
        }
    }

    function setTree(userHash, tree) {
        const n = now();
        const expiresAt = n + ttlMs;
        treeSetStmt.run(userHash, JSON.stringify(tree), expiresAt);
        memSet(treeMem, userHash, { tree, expiresAt }, maxMemTree);
    }

    function invalidateTree(userHash) {
        treeDeleteStmt.run(userHash);
        memDelete(treeMem, userHash);
    }

    // ---------- Folder UIDs ----------

    function _uidsKey(userHash, path, uidvalidity) {
        return `${userHash}\x00${path}\x00${uidvalidity}`;
    }

    function getUids(userHash, path, uidvalidity) {
        const n = now();
        const key = _uidsKey(userHash, path, uidvalidity);
        const mem = memGet(uidsMem, key);
        if (mem && mem.expiresAt > n) {
            return mem.uids;
        }
        const row = uidsGetStmt.get(userHash, path, uidvalidity, n);
        if (!row) return null;
        try {
            const uids = JSON.parse(row.uids);
            if (!Array.isArray(uids)) return null;
            memSet(uidsMem, key, { uids, expiresAt: n + ttlMs }, maxMemUids);
            return uids;
        } catch {
            return null;
        }
    }

    function setUids(userHash, path, uidvalidity, uids) {
        const n = now();
        const expiresAt = n + ttlMs;
        uidsSetStmt.run(userHash, path, uidvalidity, JSON.stringify(uids), expiresAt);
        memSet(uidsMem, _uidsKey(userHash, path, uidvalidity), { uids, expiresAt }, maxMemUids);
    }

    function invalidateFolderUids(userHash, path) {
        // We don't know uidvalidity here, so prune SQLite by path and
        // clear any in-memory entries that match the prefix.
        uidsDeleteStmt.run(userHash, path);
        const prefix = `${userHash}\x00${path}\x00`;
        for (const key of uidsMem.keys()) {
            if (key.startsWith(prefix)) uidsMem.delete(key);
        }
    }

    // ---------- Folder status ----------

    function getStatus(userHash, path) {
        const n = now();
        const mem = memGet(statusMem, `${userHash}\x00${path}`);
        if (mem && mem.expiresAt > n) {
            return mem.status;
        }
        const row = statusGetStmt.get(userHash, path, n);
        if (!row) return null;
        try {
            const status = JSON.parse(row.status);
            memSet(statusMem, `${userHash}\x00${path}`, { status, expiresAt: n + ttlMs }, maxMemStatus);
            return status;
        } catch {
            return null;
        }
    }

    function setStatus(userHash, path, status) {
        const n = now();
        const expiresAt = n + ttlMs;
        statusSetStmt.run(userHash, path, JSON.stringify(status), expiresAt);
        memSet(statusMem, `${userHash}\x00${path}`, { status, expiresAt }, maxMemStatus);
    }

    function invalidateFolderStatus(userHash, path) {
        statusDeleteStmt.run(userHash, path);
        memDelete(statusMem, `${userHash}\x00${path}`);
    }

    // ---------- Combined invalidation ----------

    function invalidateFolder(userHash, path) {
        invalidateFolderUids(userHash, path);
        invalidateFolderStatus(userHash, path);
    }

    function invalidateUser(userHash) {
        invalidateTree(userHash);
        // Bulk-delete folder caches for this user
        db.prepare('DELETE FROM folder_uids WHERE user_hash = ?').run(userHash);
        db.prepare('DELETE FROM folder_status WHERE user_hash = ?').run(userHash);
        for (const key of uidsMem.keys()) {
            if (key.startsWith(`${userHash}\x00`)) uidsMem.delete(key);
        }
        for (const key of statusMem.keys()) {
            if (key.startsWith(`${userHash}\x00`)) statusMem.delete(key);
        }
    }

    // ---------- Prune ----------

    function prune() {
        const n = now();
        treePruneStmt.run(n);
        uidsPruneStmt.run(n);
        statusPruneStmt.run(n);
        treeMem.clear();
        uidsMem.clear();
        statusMem.clear();
    }

    let pruneTimer = null;
    if (pruneIntervalMs > 0) {
        pruneTimer = setInterval(() => prune(), pruneIntervalMs);
        pruneTimer.unref();
    }

    function close() {
        if (pruneTimer) clearInterval(pruneTimer);
        db.close();
    }

    return {
        getTree, setTree, invalidateTree,
        getUids, setUids, invalidateFolderUid: invalidateFolderUids,
        getStatus, setStatus, invalidateFolderStatus,
        invalidateFolder, invalidateUser,
        prune, close
    };
}

module.exports = { createImapCache };
