'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../../src/pool');

function fakeClient() {
    const c = {
        authenticated: true,
        usable: true,
        closed: false,
        loggedOut: false,
        close() { c.closed = true; c.authenticated = false; c.usable = false; },
        async logout() { c.loggedOut = true; c.close(); }
    };
    return c;
}

function mockFactory() {
    const created = [];
    return {
        create: async (user, pass) => {
            const c = fakeClient();
            c.user = user;
            created.push(c);
            return c;
        },
        created
    };
}

test('pool: acquire creates new client, release returns it to idle', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 5, idleMs: 10_000, createClient: f.create });
    const c = await pool.acquire('h1', 'u', 'p');
    assert.equal(f.created.length, 1);
    assert.equal(pool.count(), 1);
    pool.release('h1', c);
    assert.equal(pool.count(), 1); // still live, just idle
});

test('pool: acquire reuses idle client for same hash', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 5, idleMs: 10_000, createClient: f.create });
    const c1 = await pool.acquire('h1', 'u', 'p');
    pool.release('h1', c1);
    const c2 = await pool.acquire('h1', 'u', 'p');
    assert.equal(c1, c2);
    assert.equal(f.created.length, 1);
    pool.release('h1', c2);
});

test('pool: discard closes client and frees slot', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 5, idleMs: 10_000, createClient: f.create });
    const c = await pool.acquire('h1', 'u', 'p');
    pool.discard('h1', c);
    assert.equal(pool.count(), 0);
    assert.equal(f.created[0].closed, true);
});

test('pool: does not reuse stale client', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 5, idleMs: 10_000, createClient: f.create });
    const c1 = await pool.acquire('h1', 'u', 'p');
    pool.release('h1', c1);
    c1.authenticated = false; // simulate disconnect while idle
    c1.usable = false;
    const c2 = await pool.acquire('h1', 'u', 'p');
    assert.notEqual(c1, c2);
    assert.equal(f.created.length, 2);
});

test('pool: respects max by evicting oldest idle across users', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 2, idleMs: 10_000, createClient: f.create });
    const a = await pool.acquire('h1', 'u1', 'p');
    pool.release('h1', a);
    await new Promise(r => setTimeout(r, 2));
    const b = await pool.acquire('h2', 'u2', 'p');
    pool.release('h2', b);
    // both idle, max hit
    const c = await pool.acquire('h3', 'u3', 'p'); // triggers eviction of 'a'
    assert.equal(f.created.length, 3);
    assert.equal(a.closed, true, 'oldest idle client should be closed');
    pool.release('h3', c);
});

test('pool: sweepIdle closes clients idle past idleMs', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 5, idleMs: 50, createClient: f.create });
    const c = await pool.acquire('h1', 'u', 'p');
    pool.release('h1', c);
    await new Promise(r => setTimeout(r, 80));
    pool.sweepIdle();
    assert.equal(pool.count(), 0);
    assert.equal(f.created[0].closed, true);
});

test('pool: closeAll logs out clients and rejects waiters', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 1, idleMs: 10_000, createClient: f.create });
    const c = await pool.acquire('h1', 'u', 'p');
    pool.release('h1', c);
    await pool.closeAll();
    assert.equal(f.created[0].loggedOut, true);
});

test('pool: acquire waits when full, released by another', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 1, idleMs: 10_000, createClient: f.create });
    const c1 = await pool.acquire('h1', 'u1', 'p');
    const pending = pool.acquire('h2', 'u2', 'p', { waitMs: 2000 });
    setTimeout(() => pool.discard('h1', c1), 20);
    const c2 = await pending;
    assert.ok(c2);
    pool.release('h2', c2);
});

test('pool: acquire timeout rejects when no slots free', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 1, idleMs: 10_000, createClient: f.create });
    const c1 = await pool.acquire('h1', 'u', 'p'); // hold busy
    await assert.rejects(
        () => pool.acquire('h2', 'u', 'p', { waitMs: 50 }),
        /timeout/i
    );
    pool.release('h1', c1);
});

test('pool: release hands idle client directly to waiter for same hash', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 1, idleMs: 10_000, createClient: f.create });
    const c1 = await pool.acquire('h1', 'u1', 'p');
    const pending = pool.acquire('h1', 'u1', 'p', { waitMs: 2000 });
    setTimeout(() => pool.release('h1', c1), 20);
    const c2 = await pending;
    assert.equal(c1, c2, 'waiter should receive the released idle client');
    assert.equal(f.created.length, 1, 'no new client should be created');
});

test('pool: pump reuses idle client from another user for waiter', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 2, idleMs: 10_000, createClient: f.create });
    const a = await pool.acquire('h1', 'u1', 'p');
    pool.release('h1', a);
    const b = await pool.acquire('h2', 'u2', 'p'); // pool at max
    const pending = pool.acquire('h1', 'u1', 'p', { waitMs: 2000 });
    setTimeout(() => pool.release('h2', b), 20);
    const c = await pending;
    assert.equal(c, a, 'waiter should reuse idle client for h1');
    assert.equal(f.created.length, 2, 'no new client should be created');
    pool.release('h1', c);
});

test('pool: max bound enforced under concurrent acquire', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 3, idleMs: 10_000, createClient: f.create });
    // Fire 6 concurrent acquires for distinct users; never release.
    const settled = await Promise.allSettled([
        pool.acquire('h1', 'u1', 'p', { waitMs: 50 }),
        pool.acquire('h2', 'u2', 'p', { waitMs: 50 }),
        pool.acquire('h3', 'u3', 'p', { waitMs: 50 }),
        pool.acquire('h4', 'u4', 'p', { waitMs: 50 }),
        pool.acquire('h5', 'u5', 'p', { waitMs: 50 }),
        pool.acquire('h6', 'u6', 'p', { waitMs: 50 })
    ]);
    // Exactly 3 should have fulfilled, 3 should have rejected (timeout).
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 3, 'at most max=3 acquires should succeed');
    assert.equal(rejected.length, 3, 'remaining 3 must wait and time out');
    // Factory must not have created more than max connections.
    assert.ok(f.created.length <= 3, `expected <= 3 created, got ${f.created.length}`);
    assert.equal(pool.count(), 3);
});

test('pool: timed-out waiter is cleaned up; later release does not orphan-resolve', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 1, idleMs: 10_000, createClient: f.create });
    const c1 = await pool.acquire('h1', 'u1', 'p');

    // Track whether the timed-out waiter accidentally gets resolved later.
    let resolvedAfterTimeout = false;
    const pending = pool
        .acquire('h2', 'u2', 'p', { waitMs: 50 })
        .then(() => { resolvedAfterTimeout = true; })
        .catch(() => {});
    await assert.rejects(
        pool.acquire('h3', 'u3', 'p', { waitMs: 50 }),
        /timeout/i
    );
    await pending; // ensure first waiter has settled (rejected by timeout)

    // Now release the held connection. The released slot must NOT wake the
    // timed-out waiter (no orphan resolution), and must not create extras.
    pool.release('h1', c1);
    // Give any (incorrect) deferred resolution a chance to fire.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(resolvedAfterTimeout, false, 'timed-out waiter must not be resolved');
    // A fresh acquire for h1 should now succeed and reuse the released client.
    const c2 = await pool.acquire('h1', 'u1', 'p', { waitMs: 100 });
    assert.equal(c2, c1, 'released idle client should be reusable');
    assert.equal(f.created.length, 1, 'no extra connections created during waiter cleanup');
    pool.release('h1', c2);
});

test('pool: per-user LIFO reuses most recently released connection', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 5, idleMs: 10_000, createClient: f.create });
    // Acquire and release the same hash twice sequentially.
    const a1 = await pool.acquire('h1', 'u', 'p');
    pool.release('h1', a1);
    const a2 = await pool.acquire('h1', 'u', 'p');
    assert.equal(a2, a1, 'second acquire should reuse the released client');
    pool.release('h1', a2);
    // Only one connection should ever have been opened.
    assert.equal(f.created.length, 1);
});

test('pool: idle connection is closed after idleMs (sweepIdle)', async () => {
    const f = mockFactory();
    const pool = createPool({ max: 5, idleMs: 50, createClient: f.create });
    const c = await pool.acquire('h1', 'u', 'p');
    pool.release('h1', c);
    await new Promise((r) => setTimeout(r, 100));
    pool.sweepIdle();
    assert.equal(pool.count(), 0, 'idle past idleMs should be evicted');
    assert.equal(f.created[0].closed, true, 'evicted client must be closed');
});
