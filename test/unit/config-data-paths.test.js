'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Every sqlite file has to live on the same persistent volume as the main
// cache. When these defaulted to a bare './data/...', any deployment whose
// compose file didn't set each one explicitly wrote to the container's
// working directory instead, and the file was destroyed on the next
// `docker compose up` — silently, because sqlite just recreates it. That
// is exactly how the AI cache shipped ephemeral.

function loadConfigWith(env) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    delete require.cache[require.resolve('../../src/config')];
    try {
        return require('../../src/config');
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        delete require.cache[require.resolve('../../src/config')];
    }
}

const DATA_PATHS = (cfg) => ({
    cache: cfg.cache.path,
    imapCache: cfg.imapCache.path,
    ocrCache: cfg.ocr.cachePath,
    aiCache: cfg.ai.cachePath,
    push: cfg.push.dbPath,
    tracking: cfg.tracking.dbPath,
    imageProxy: cfg.imageProxy.cachePath,
    calendarSubs: cfg.calendarSubs.dbPath,
    webhooks: cfg.webhooks.dbPath
});

test('every sqlite file defaults to the cache directory', () => {
    const cfg = loadConfigWith({
        CACHE_PATH: '/data/cache.db',
        OCR_CACHE_PATH: undefined, AI_CACHE_PATH: undefined, PUSH_DB_PATH: undefined,
        TRACKING_DB_PATH: undefined, IMAGE_PROXY_CACHE_PATH: undefined,
        CALENDAR_SUBS_DB_PATH: undefined, WEBHOOK_DB_PATH: undefined, IMAP_CACHE_PATH: undefined
    });
    for (const [name, p] of Object.entries(DATA_PATHS(cfg))) {
        assert.equal(path.dirname(p), '/data', `${name} (${p}) must sit beside cache.db`);
    }
});

test('an explicit override still wins', () => {
    const cfg = loadConfigWith({
        CACHE_PATH: '/data/cache.db',
        AI_CACHE_PATH: '/elsewhere/ai.db',
        IMAP_CACHE_PATH: undefined, OCR_CACHE_PATH: undefined, PUSH_DB_PATH: undefined,
        TRACKING_DB_PATH: undefined, IMAGE_PROXY_CACHE_PATH: undefined,
        CALENDAR_SUBS_DB_PATH: undefined, WEBHOOK_DB_PATH: undefined
    });
    assert.equal(cfg.ai.cachePath, '/elsewhere/ai.db');
    assert.equal(cfg.imapCache.path, '/data/imap-cache.db');
});

test('a relative CACHE_PATH keeps the others alongside it', () => {
    const cfg = loadConfigWith({
        CACHE_PATH: './var/state/cache.db',
        AI_CACHE_PATH: undefined, IMAP_CACHE_PATH: undefined, OCR_CACHE_PATH: undefined,
        PUSH_DB_PATH: undefined, TRACKING_DB_PATH: undefined, IMAGE_PROXY_CACHE_PATH: undefined,
        CALENDAR_SUBS_DB_PATH: undefined, WEBHOOK_DB_PATH: undefined
    });
    for (const [name, p] of Object.entries(DATA_PATHS(cfg))) {
        // path.join() normalizes the leading './' away, so compare
        // normalized forms rather than the raw string.
        assert.equal(path.normalize(path.dirname(p)), path.normalize('var/state'),
            `${name} (${p}) must follow CACHE_PATH`);
    }
});
