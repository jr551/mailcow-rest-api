'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCache, hashCreds } = require('../../src/cache');

function mem() {
    return createCache({ filePath: ':memory:', ttlValidMs: 1000, ttlInvalidMs: 500, pruneIntervalMs: 0 });
}

test('hashCreds: deterministic and sensitive to input', () => {
    const a = hashCreds('u', 'p');
    const b = hashCreds('u', 'p');
    const c = hashCreds('u', 'P');
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test('cache: unknown key returns null', () => {
    const c = mem();
    assert.equal(c.get('nope'), null);
    c.close();
});

test('cache: set/get valid entry round-trips', () => {
    const c = mem();
    c.set('h1', true);
    const row = c.get('h1');
    assert.equal(row.valid, true);
    assert.ok(row.expiresAt > Date.now());
    c.close();
});

test('cache: invalid uses shorter TTL than valid', () => {
    const c = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 10, pruneIntervalMs: 0 });
    const now = 1_000_000;
    c.set('h', false, now);
    const row = c.get('h', now);
    assert.equal(row.expiresAt - now, 10);
    c.close();
});

test('cache: expired entries are evicted on read', () => {
    const c = mem();
    const now = 1_000_000;
    c.set('h', true, now);
    assert.ok(c.get('h', now + 500));
    assert.equal(c.get('h', now + 5000), null);
    assert.equal(c.size(), 0);
    c.close();
});

test('cache: invalidate removes an entry', () => {
    const c = mem();
    c.set('h', true);
    c.invalidate('h');
    assert.equal(c.get('h'), null);
    c.close();
});

test('cache: prune clears expired entries', () => {
    const c = mem();
    const now = 1_000_000;
    c.set('h1', true, now);
    c.set('h2', false, now);
    const removed = c.prune(now + 10_000);
    assert.equal(removed, 2);
    assert.equal(c.size(), 0);
    c.close();
});

test('cache: overwrite existing entry', () => {
    const c = mem();
    c.set('h', false);
    assert.equal(c.get('h').valid, false);
    c.set('h', true);
    assert.equal(c.get('h').valid, true);
    c.close();
});


test('session: create and get round-trips', () => {
    const c = mem();
    const now = 1_000_000;
    const session = c.createSession('u@x.com', 'pw', 'hash1', now);
    assert.ok(session.token);
    assert.equal(session.expiresAt, now + 1000);

    const got = c.getSession(session.token, now);
    assert.equal(got.user, 'u@x.com');
    assert.equal(got.pass, 'pw');
    assert.equal(got.hash, 'hash1');
    c.close();
});

test('session: getSession extends TTL on activity', () => {
    const c = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 1000, pruneIntervalMs: 0 });
    const now = 1_000_000;
    const session = c.createSession('u@x.com', 'pw', 'hash1', now);
    assert.equal(session.expiresAt, now + 60000);

    // Access session later — TTL should slide forward
    const later = now + 30000;
    const got = c.getSession(session.token, later);
    assert.equal(got.expiresAt, later + 60000);

    // Access again even later — TTL should slide forward again
    const later2 = later + 1000;
    const got2 = c.getSession(session.token, later2);
    assert.equal(got2.expiresAt, later2 + 60000);
    c.close();
});

test('session: expired token is evicted on read', () => {
    const c = mem();
    const now = 1_000_000;
    const session = c.createSession('u@x.com', 'pw', 'hash1', now);
    assert.ok(c.getSession(session.token, now + 500));
    assert.equal(c.getSession(session.token, now + 5000), null);
    assert.equal(c.sessionSize(), 0);
    c.close();
});

test('session: pruneSessions clears expired entries', () => {
    const c = mem();
    const now = 1_000_000;
    c.createSession('u1', 'p1', 'h1', now);
    c.createSession('u2', 'p2', 'h2', now);
    assert.equal(c.sessionSize(), 2);
    const removed = c.pruneSessions(now + 10_000);
    assert.equal(removed, 2);
    assert.equal(c.sessionSize(), 0);
    c.close();
});

test('session: hard lifetime cap evicts even with continuous activity', () => {
    const c = createCache({
        filePath: ':memory:',
        ttlValidMs: 60_000,
        ttlInvalidMs: 1000,
        pruneIntervalMs: 0,
        maxLifetimeMs: 100_000
    });
    const now = 1_000_000;
    const session = c.createSession('u@x.com', 'pw', 'hash1', now);

    // Within cap: still valid even after multiple slides
    assert.ok(c.getSession(session.token, now + 30_000));
    assert.ok(c.getSession(session.token, now + 60_000));
    assert.ok(c.getSession(session.token, now + 99_000));

    // Past cap: evicted regardless of sliding TTL
    assert.equal(c.getSession(session.token, now + 100_001), null);
    assert.equal(c.sessionSize(), 0);
    c.close();
});

test('session: deleteSession removes a specific token', () => {
    const c = mem();
    const s1 = c.createSession('u1', 'p1', 'h1');
    const s2 = c.createSession('u2', 'p2', 'h2');
    c.deleteSession(s1.token);
    assert.equal(c.getSession(s1.token), null);
    assert.ok(c.getSession(s2.token));
    c.close();
});

test('timer: prune interval cleans both auth_cache and sessions', async () => {
    const c = createCache({ filePath: ':memory:', ttlValidMs: 50, ttlInvalidMs: 50, pruneIntervalMs: 10 });
    const now = Date.now();
    c.set('h1', true, now);
    c.createSession('u1', 'p1', 'h1', now);
    assert.equal(c.size(), 1);
    assert.equal(c.sessionSize(), 1);

    await new Promise(r => setTimeout(r, 120));
    assert.equal(c.size(), 0);
    assert.equal(c.sessionSize(), 0);
    c.close();
});

test('session: revoke (deleteSession) clears token from both memory and SQLite', () => {
    const c = mem();
    const session = c.createSession('u@x.com', 'pw', 'hash1');
    // Confirm in-memory hot path returns it
    assert.ok(c.getSession(session.token));
    // Revoke
    c.deleteSession(session.token);
    // Both in-memory and SQLite paths must report null
    assert.equal(c.getSession(session.token), null);
    assert.equal(c.sessionSize(), 0);
    c.close();
});

test('session: revoke removes from SQLite even if memory entry is absent', () => {
    // Use a tiny memory cap so we can prove the SQLite path is hit on read.
    const c = createCache({
        filePath: ':memory:',
        ttlValidMs: 60_000,
        ttlInvalidMs: 1000,
        pruneIntervalMs: 0,
        maxMemSessions: 1
    });
    const s1 = c.createSession('u1', 'p1', 'h1');
    // Insert another session so the LRU evicts s1 from in-memory cache.
    c.createSession('u2', 'p2', 'h2');
    // s1 must now be served from SQLite — confirm read works first
    assert.ok(c.getSession(s1.token), 'pre-revoke: SQLite path should rehydrate');
    // Revoke and confirm both paths report null
    c.deleteSession(s1.token);
    assert.equal(c.getSession(s1.token), null);
    c.close();
});

test('timer: prune sweep removes past-expiry session row from SQLite', async () => {
    const c = createCache({
        filePath: ':memory:',
        ttlValidMs: 30,
        ttlInvalidMs: 30,
        pruneIntervalMs: 50
    });
    c.createSession('u@x.com', 'pw', 'hash1');
    assert.equal(c.sessionSize(), 1);
    // Wait long enough for entry to expire AND for at least one timer tick.
    await new Promise(r => setTimeout(r, 150));
    // sessionSize() reads directly from the SQLite COUNT(*).
    assert.equal(c.sessionSize(), 0);
    c.close();
});

test('session: SQLite rehydrates in-memory cache after eviction', () => {
    // maxMemSessions = 1 forces LRU eviction of the first session when the
    // second is inserted. Reading the first then exercises the SQLite path
    // and must repopulate the in-memory map.
    const c = createCache({
        filePath: ':memory:',
        ttlValidMs: 60_000,
        ttlInvalidMs: 1000,
        pruneIntervalMs: 0,
        maxMemSessions: 1
    });
    const s1 = c.createSession('u1', 'p1', 'h1');
    c.createSession('u2', 'p2', 'h2'); // evicts s1 from memory
    // SQLite read path: must rehydrate
    const got = c.getSession(s1.token);
    assert.ok(got);
    assert.equal(got.user, 'u1');
    assert.equal(got.pass, 'p1');
    assert.equal(got.hash, 'h1');
    c.close();
});

test('cache: getAuth-style hit/miss for set/get round-trip', () => {
    // Black-box check on the get(hash) API used by auth verification.
    const c = mem();
    const h = hashCreds('u@x.com', 'pw');
    // miss
    assert.equal(c.get(h), null);
    // set valid -> hit
    c.set(h, true);
    const hit = c.get(h);
    assert.ok(hit);
    assert.equal(hit.valid, true);
    // invalidate -> miss
    c.invalidate(h);
    assert.equal(c.get(h), null);
    c.close();
});
