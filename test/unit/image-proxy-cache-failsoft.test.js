'use strict';

// Regression tests: the image proxy cache (positive entries, negative
// entries, per-user usage counters) is a work-saver and a soft quota — none of
// it may turn a working image request into a 500. Reads that fail degrade to a
// cache miss (and, for usage, to "unknown"), writes that fail simply mean
// nothing was cached. The request itself must still be served.
//
// Writes are made to fail while reads keep working by installing BEFORE
// triggers that RAISE(ABORT); reads are failed by dropping the table from a
// second connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Fastify = require('fastify');
const Database = require('better-sqlite3');
const dns = require('node:dns').promises;

const { createImageProxyCache } = require('../../src/image-proxy-cache');
const imageProxyRoutes = require('../../src/routes/image-proxy');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xca, 0xfe]);

function tmpDb(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-proxy-fail-'));
    return path.join(dir, name);
}

function makeCache(file, maxBytes = 100 * 1024 * 1024) {
    return createImageProxyCache({ filePath: file, maxBytes });
}

function failWrites(file, table, events) {
    const ext = new Database(file);
    for (const ev of events) {
        ext.exec(`CREATE TRIGGER fail_${ev}_${table} BEFORE ${ev} ON ${table}
            BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    }
    ext.close();
}

function dropTables(file, tables) {
    const ext = new Database(file);
    for (const t of tables) ext.exec(`DROP TABLE ${t}`);
    ext.close();
}

// ── module contract ──

test('image-proxy-cache get: a failing read is a miss, not a throw', () => {
    const file = tmpDb('ipc.db');
    const c = makeCache(file);
    try {
        c.set('u', PNG, 'image/png');
        dropTables(file, ['image_proxy_cache']);
        assert.equal(c.get('u'), null);
    } finally {
        c.close();
    }
});

test('image-proxy-cache set: a failing write returns false instead of throwing', () => {
    const file = tmpDb('ipc.db');
    const c = makeCache(file);
    try {
        failWrites(file, 'image_proxy_cache', ['INSERT', 'UPDATE']);
        assert.equal(c.set('u', PNG, 'image/png'), false);
    } finally {
        c.close();
    }
});

test('image-proxy-cache set: a failing eviction delete must not hang or throw', async () => {
    const file = tmpDb('ipc.db');
    const c = makeCache(file, 100);
    try {
        c.set('old', Buffer.alloc(80, 1), 'image/png');
        failWrites(file, 'image_proxy_cache', ['DELETE']);
        // Over budget, so eviction runs — and every delete fails. Must finish.
        const done = await Promise.race([
            Promise.resolve().then(() => c.set('new', Buffer.alloc(80, 2), 'image/png')),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))
        ]);
        assert.notEqual(done, 'hung', 'set() must not spin forever when eviction writes fail');
    } finally {
        c.close();
    }
});

test('image-proxy-cache getUsage: a failing read reports 0 instead of throwing', () => {
    const file = tmpDb('ipc.db');
    const c = makeCache(file);
    try {
        dropTables(file, ['image_proxy_usage']);
        assert.equal(c.getUsage('u', '2026-09-30'), 0);
    } finally {
        c.close();
    }
});

test('image-proxy-cache incrementUsage: a failing write must not throw', () => {
    const file = tmpDb('ipc.db');
    const c = makeCache(file);
    try {
        failWrites(file, 'image_proxy_usage', ['INSERT', 'UPDATE']);
        c.incrementUsage('u', '2026-09-30', 123);
    } finally {
        c.close();
    }
});

test('image-proxy-cache getNegative: expired-entry cleanup failing must not throw', () => {
    const file = tmpDb('ipc.db');
    const c = makeCache(file);
    try {
        c.setNegative('u', 404, 'nope', 1000);
        failWrites(file, 'image_proxy_negative', ['DELETE']);
        assert.equal(c.getNegative('u', 1, 10_000), null);
    } finally {
        c.close();
    }
});

test('image-proxy-cache setNegative: a failing write must not throw', () => {
    const file = tmpDb('ipc.db');
    const c = makeCache(file);
    try {
        failWrites(file, 'image_proxy_negative', ['INSERT', 'UPDATE']);
        c.setNegative('u', 502, 'boom');
    } finally {
        c.close();
    }
});

// ── route: a broken cache must not 500 the image request ──

let savedLookup;
test.beforeEach(() => { savedLookup = dns.lookup; });
test.afterEach(() => { dns.lookup = savedLookup; });

// Fully offline: resolve every hostname to a public address so
// fetchImage's pinned dispatcher is happy without real DNS.
function stubDns() {
    dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
}

function makeResponse({ status = 200, contentType = 'image/png', body = PNG } = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    let sent = false;
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
        body: {
            getReader() {
                return {
                    async read() {
                        if (sent || buf.length === 0) return { done: true, value: undefined };
                        sent = true;
                        return { done: false, value: new Uint8Array(buf) };
                    }
                };
            },
            async cancel() { /* allow drain on redirect */ }
        }
    };
}

async function buildApp(cache) {
    const app = Fastify({ logger: false });
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(imageProxyRoutes, { cache, maxBytesPerDay: 1024 * 1024 * 1024 });
    return app;
}

const IMG_URL = 'https://example.com/pic.png';

test('image route: a cached image is served even when the usage write fails', async () => {
    stubDns();
    const file = tmpDb('ipc.db');
    const cache = makeCache(file);
    cache.set(IMG_URL, PNG, 'image/png');
    failWrites(file, 'image_proxy_usage', ['INSERT', 'UPDATE']);
    const app = await buildApp(cache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/proxy/image?url=' + encodeURIComponent(IMG_URL) });
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(Buffer.from(res.rawPayload), PNG);
    } finally {
        await app.close();
        cache.close();
    }
});

test('image route: a successful fetch is served even when every cache write fails', async () => {
    stubDns();
    const savedFetch = global.fetch;
    global.fetch = async () => makeResponse();
    const file = tmpDb('ipc.db');
    const cache = makeCache(file);
    failWrites(file, 'image_proxy_cache', ['INSERT', 'UPDATE']);
    failWrites(file, 'image_proxy_usage', ['INSERT', 'UPDATE']);
    const app = await buildApp(cache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/proxy/image?url=' + encodeURIComponent(IMG_URL) });
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(Buffer.from(res.rawPayload), PNG);
    } finally {
        global.fetch = savedFetch;
        await app.close();
        cache.close();
    }
});

test('image route: an unreadable cache degrades to a fetch, and the failure stays honest', async () => {
    stubDns();
    const savedFetch = global.fetch;
    // 404 is unambiguous: a cache-induced failure would be a 500 quoting a
    // SQLite error, so this proves the upstream verdict decides the answer.
    global.fetch = async () => makeResponse({ status: 404 });
    const file = tmpDb('ipc.db');
    const cache = makeCache(file);
    dropTables(file, ['image_proxy_cache', 'image_proxy_negative', 'image_proxy_usage']);
    const app = await buildApp(cache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/proxy/image?url=' + encodeURIComponent(IMG_URL) });
        // The upstream failure, not the broken cache, decides the response.
        assert.equal(res.statusCode, 404, res.body);
        assert.match(JSON.parse(res.body).detail, /Upstream returned 404/);
    } finally {
        global.fetch = savedFetch;
        await app.close();
        cache.close();
    }
});
