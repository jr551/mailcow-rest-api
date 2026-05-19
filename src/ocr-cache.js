'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// Content-addressable cache for Mistral OCR results, backed by SQLite (WAL).
// Keys are sha256(buffer):${model} so two attachments with identical bytes
// share the cache regardless of which user/message they came from. Values are
// the full Mistral response JSON. No TTL — OCR output is deterministic for
// (bytes, model). Bounded by row count; oldest evicted on overflow.

function hashContent(buffer, model) {
    const h = crypto.createHash('sha256').update(buffer).digest('hex');
    return `${h}:${model}`;
}

function createOcrCache(opts) {
    const { filePath, maxEntries = 1000, evictBatch = 100 } = opts || {};

    if (filePath !== ':memory:') {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS ocr_cache (
            key TEXT PRIMARY KEY,
            response TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ocr_cache_created ON ocr_cache(created_at);
    `);

    const getStmt = db.prepare('SELECT response FROM ocr_cache WHERE key = ?');
    const setStmt = db.prepare(
        'INSERT INTO ocr_cache (key, response, created_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET response = excluded.response, created_at = excluded.created_at'
    );
    const sizeStmt = db.prepare('SELECT COUNT(*) AS c FROM ocr_cache');
    const evictStmt = db.prepare(
        'DELETE FROM ocr_cache WHERE key IN (SELECT key FROM ocr_cache ORDER BY created_at ASC LIMIT ?)'
    );

    function get(buffer, model) {
        const key = hashContent(buffer, model);
        const row = getStmt.get(key);
        if (!row) return null;
        try {
            return JSON.parse(row.response);
        } catch {
            return null;
        }
    }

    function set(buffer, model, response, now = Date.now()) {
        const key = hashContent(buffer, model);
        setStmt.run(key, JSON.stringify(response), now);
        const count = sizeStmt.get().c;
        if (count > maxEntries) {
            evictStmt.run(Math.min(evictBatch, count - maxEntries + evictBatch));
        }
    }

    function size() {
        return sizeStmt.get().c;
    }

    function close() {
        db.close();
    }

    return { get, set, size, close };
}

module.exports = { createOcrCache, hashContent };
