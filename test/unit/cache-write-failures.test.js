'use strict';

// Regression tests: a failing SQLite WRITE must never turn a readable
// session/auth entry into a thrown error. The auth cache exists to save a
// IMAP round-trip; the sliding-TTL extension and the expired-row cleanup are
// best-effort maintenance writes. When the disk is full (SQLITE_FULL) or the
// file is read-only (SQLITE_READONLY), reads keep working — and every
// authenticated request used to 500 because getSession()'s extension write
// ran unwrapped on every request (even memory-cache hits).
//
// Writes are made to fail while reads keep working by installing BEFORE
// triggers that RAISE(ABORT) — the closest deterministic stand-in for a
// full/read-only database.

const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createCache } = require('../../src/cache');
const { createAuthHook } = require('../../src/auth');
const { createIpAllowHook } = require('../../src/ip-allow');
const sessionRoutes = require('../../src/routes/session');

function makeCache() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-write-fail-'));
    const file = path.join(dir, 'cache.db');
    const cache = createCache({ filePath: file, ttlValidMs: 60_000, ttlInvalidMs: 500, pruneIntervalMs: 0 });
    return { cache, file };
}

function failAllWrites(file) {
    const ext = new Database(file);
    ext.exec(`
        CREATE TRIGGER fail_upd_sessions BEFORE UPDATE ON sessions
        BEGIN SELECT RAISE(ABORT, 'disk full'); END;
        CREATE TRIGGER fail_del_sessions BEFORE DELETE ON sessions
        BEGIN SELECT RAISE(ABORT, 'disk full'); END;
        CREATE TRIGGER fail_del_auth BEFORE DELETE ON auth_cache
        BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    ext.close();
}

function makeReq(headerValue) {
    return {
        headers: { authorization: headerValue },
        routeOptions: {},
        log: { warn() {}, info() {}, error() {}, debug() {} }
    };
}

function makeReply() {
    const headers = {};
    return {
        headers,
        header(k, v) { headers[k.toLowerCase()] = v; return this; }
    };
}

test('cache.get: expired-entry cleanup write failing must not throw (read result is what matters)', () => {
    const { cache, file } = makeCache();
    cache.set('h1', true, Date.now() - 10_000_000); // long expired
    failAllWrites(file);
    assert.equal(cache.get('h1', Date.now()), null);
    cache.close();
});

test('cache.getSession: sliding-TTL write failing on memory hit must not throw; session still served', () => {
    const { cache, file } = makeCache();
    const { token } = cache.createSession('u@example.com', 'pw', 'hash1');
    const warm = cache.getSession(token); // fills the in-memory session cache
    assert.equal(warm.user, 'u@example.com');
    failAllWrites(file);
    const again = cache.getSession(token);
    assert.equal(again.user, 'u@example.com');
    assert.equal(again.pass, 'pw');
    cache.close();
});

test('cache.getSession: sliding-TTL write failing on database hit must not throw; session still served', () => {
    const { cache, file } = makeCache();
    const { token } = cache.createSession('u@example.com', 'pw', 'hash1');
    cache.close(); // drop the in-memory layer so the next read comes from SQLite
    const cache2 = createCache({ filePath: file, ttlValidMs: 60_000, ttlInvalidMs: 500, pruneIntervalMs: 0 });
    failAllWrites(file);
    const again = cache2.getSession(token);
    assert.equal(again.user, 'u@example.com');
    assert.equal(again.pass, 'pw');
    cache2.close();
});

test('auth hook: Bearer session stays valid when the session-store write fails (no throw, no 500)', async () => {
    const { cache, file } = makeCache();
    const { token } = cache.createSession('u@example.com', 'pw', hash('u@example.com', 'pw'));
    cache.getSession(token); // warm memory
    failAllWrites(file);
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => { throw new Error('should not run'); } });
    const req = makeReq(`Bearer ${token}`);
    await hook(req, makeReply()); // must resolve and populate req.creds
    assert.equal(req.creds.user, 'u@example.com');
    cache.close();
});

test('auth hook: Basic auth with an expired cache entry whose cleanup write fails falls through to IMAP verification', async () => {
    const { cache, file } = makeCache();
    cache.set(cache.hashCreds('u@example.com', 'pw'), true, Date.now() - 10_000_000); // expired
    failAllWrites(file);
    let verified = 0;
    const hook = createAuthHook({
        cache,
        imap: {},
        verifier: async () => { verified++; return { valid: true }; }
    });
    const req = makeReq('Basic ' + Buffer.from('u@example.com:pw').toString('base64'));
    await hook(req, makeReply());
    assert.equal(verified, 1);
    assert.equal(req.creds.user, 'u@example.com');
    cache.close();
});

test('auth hook: a session store whose READS throw is treated as sign-in-again (401), not a 500', async () => {
    const brokenCache = {
        getSession() { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); },
        get() { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); },
        set() {}
    };
    const hook = createAuthHook({ cache: brokenCache, imap: {}, verifier: async () => { throw new Error('should not run'); } });
    const req = makeReq('Bearer sometoken');
    await assert.rejects(
        () => hook(req, makeReply()),
        (err) => err.statusCode === 401,
        'a broken session store must read as an expired session, not crash the request'
    );
});

test('auth hook: an auth-verification cache whose READS throw falls through to IMAP verification', async () => {
    const brokenCache = {
        getSession() { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); },
        get() { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); },
        set() {}
    };
    let verified = 0;
    const hook = createAuthHook({
        cache: brokenCache,
        imap: {},
        verifier: async () => { verified++; return { valid: true }; }
    });
    const req = makeReq('Basic ' + Buffer.from('u@example.com:pw').toString('base64'));
    await hook(req, makeReply());
    assert.equal(verified, 1);
    assert.equal(req.creds.user, 'u@example.com');
});

function hash(user, pass) {
    return require('../../src/cache').hashCreds(user, pass);
}

// The session routes dereference `cache` unguarded. When the session store
// failed to open (the documented fail-open state, cache = null), creating a
// session threw a TypeError (500) instead of an honest 503, and revoking
// tokens 500'd instead of succeeding as a no-op.
async function buildMiniApp(cache, verifier) {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', createIpAllowHook({ allowlist: '' }));
    app.addHook('onRequest', createAuthHook({ cache, imap: {}, verifier }));
    await app.register(sessionRoutes, { cache, imap: {}, sessionTtlMs: 60_000 });
    return app;
}

test('session routes: POST /v1/auth/session with a dead session store returns 503, not a TypeError 500', async () => {
    const app = await buildMiniApp(null, async () => ({ valid: true }));
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/auth/session',
            headers: { authorization: 'Basic ' + Buffer.from('u@x.com:pw').toString('base64') }
        });
        assert.equal(res.statusCode, 503);
    } finally {
        await app.close();
    }
});

test('session routes: DELETE /v1/auth/session with a dead session store succeeds as a no-op', async () => {
    const app = await buildMiniApp(null, async () => ({ valid: true }));
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/auth/session',
            headers: { authorization: 'Basic ' + Buffer.from('u@x.com:pw').toString('base64') }
        });
        assert.equal(res.statusCode, 204);
    } finally {
        await app.close();
    }
});
