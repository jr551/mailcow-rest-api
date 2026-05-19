'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// SQLite-backed LRU cache for proxied images. Hard cap on total bytes
// stored; insertions evict oldest entries until there is room.

function createImageProxyCache(opts) {
    const { filePath, maxBytes = 100 * 1024 * 1024 } = opts;

    if (filePath !== ':memory:') {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS image_proxy_cache (
            url TEXT PRIMARY KEY,
            data BLOB NOT NULL,
            content_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            cached_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ipc_cached_at ON image_proxy_cache(cached_at);

        CREATE TABLE IF NOT EXISTS image_proxy_usage (
            user TEXT NOT NULL,
            day TEXT NOT NULL,
            bytes INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user, day)
        );
        CREATE INDEX IF NOT EXISTS idx_ipc_usage_day ON image_proxy_usage(day);
    `);

    const getStmt = db.prepare(
        'SELECT data, content_type, size, cached_at FROM image_proxy_cache WHERE url = ?'
    );
    const setStmt = db.prepare(
        'INSERT INTO image_proxy_cache (url, data, content_type, size, cached_at) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(url) DO UPDATE SET data = excluded.data, content_type = excluded.content_type, ' +
        'size = excluded.size, cached_at = excluded.cached_at'
    );
    const deleteStmt = db.prepare('DELETE FROM image_proxy_cache WHERE url = ?');
    const totalSizeStmt = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM image_proxy_cache');
    const oldestStmt = db.prepare('SELECT url, size FROM image_proxy_cache ORDER BY cached_at ASC LIMIT 1');
    const pruneCountStmt = db.prepare('SELECT COUNT(*) AS c FROM image_proxy_cache');
    const pruneOldestStmt = db.prepare(
        'DELETE FROM image_proxy_cache WHERE url IN ' +
        '(SELECT url FROM image_proxy_cache ORDER BY cached_at ASC LIMIT ?)'
    );

    const usageGetStmt = db.prepare(
        'SELECT bytes FROM image_proxy_usage WHERE user = ? AND day = ?'
    );
    const usageIncStmt = db.prepare(
        'INSERT INTO image_proxy_usage (user, day, bytes) VALUES (?, ?, ?) ' +
        'ON CONFLICT(user, day) DO UPDATE SET bytes = bytes + excluded.bytes'
    );
    const usagePruneStmt = db.prepare('DELETE FROM image_proxy_usage WHERE day < ?');

    function totalSize() {
        return totalSizeStmt.get().total;
    }

    function evictToMakeRoom(neededBytes) {
        while (totalSize() + neededBytes > maxBytes) {
            const row = oldestStmt.get();
            if (!row) break; // nothing left to evict
            deleteStmt.run(row.url);
        }
    }

    function get(url) {
        const row = getStmt.get(url);
        if (!row) return null;
        return {
            data: row.data,
            contentType: row.content_type,
            size: row.size,
            cachedAt: row.cached_at
        };
    }

    function set(url, data, contentType, now = Date.now()) {
        const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
        if (size > maxBytes) return false; // can't fit even after full eviction
        evictToMakeRoom(size);
        setStmt.run(url, data, contentType, size, now);
        return true;
    }

    function remove(url) {
        return deleteStmt.run(url).changes;
    }

    function count() {
        return pruneCountStmt.get().c;
    }

    function getUsage(user, day) {
        const row = usageGetStmt.get(user, day);
        return row ? row.bytes : 0;
    }

    function incrementUsage(user, day, bytes) {
        usageIncStmt.run(user, day, bytes);
    }

    function pruneUsage(beforeDay) {
        return usagePruneStmt.run(beforeDay).changes;
    }

    function close() {
        db.close();
    }

    return { get, set, remove, totalSize, count, getUsage, incrementUsage, pruneUsage, close };
}

module.exports = { createImageProxyCache };
