'use strict';

// Regression test: a corrupt or unwritable DISPOSABLE cache file must not
// stop the service from starting. These four sqlite files (imap-cache,
// ocr-cache, ai-cache, image-proxy) hold only rebuildable data — a broken one
// costs a cache miss. Before this guard, one corrupt cache file made
// build() reject with SQLITE_NOTADB/SQLITE_CORRUPT and every feature
// (read AND send) went down together.

// Env must be set before src/config is required (it snapshots env at load).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-failopen-'));
process.env.CACHE_PATH = path.join(dataDir, 'cache.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../../src/server');
const { createCache } = require('../../src/cache');

function writeCorruptDb(filePath) {
    // Valid SQLite magic header, garbage body: the file opens, then every
    // statement against it fails (SQLITE_NOTADB/SQLITE_CORRUPT).
    fs.writeFileSync(filePath, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192, 0x41)]));
}

test('build(): corrupt disposable cache files must not prevent startup', async () => {
    for (const name of ['imap-cache.db', 'ocr-cache.db', 'ai-cache.db', 'image-proxy.db']) {
        writeCorruptDb(path.join(dataDir, name));
    }
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 500, pruneIntervalMs: 0 });
    const app = await build({ cache, ocrCache: undefined });
    try {
        const res = await app.inject({ method: 'GET', url: '/openapi.json' });
        assert.equal(res.statusCode, 200);
    } finally {
        await app.close();
    }
});
