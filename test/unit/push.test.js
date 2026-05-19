'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../../src/server');
const { createCache, hashCreds } = require('../../src/cache');
const { createPushStore } = require('../../src/push-store');

const BASIC = 'Basic ' + Buffer.from('user@example.com:hunter2').toString('base64');

function makeCache() {
    const c = createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0 });
    c.set(hashCreds('user@example.com', 'hunter2'), true, Date.now());
    return c;
}

async function makeApp() {
    return build({
        cache: makeCache(),
        ocrCache: null,
        pool: { count: () => 0, closeAll: async () => {} },
        pushStore: createPushStore({ filePath: ':memory:' })
    });
}

test('GET /v1/push/config is public', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/push/config' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(typeof body.configured, 'boolean');
        assert.equal(typeof body.vapidPublicKey, 'string');
    } finally { await app.close(); }
});

test('POST /v1/push/subscribe requires auth', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/push/subscribe',
            payload: { subscription: { endpoint: 'https://x', keys: { p256dh: 'a'.repeat(20), auth: 'b'.repeat(20) } } }
        });
        assert.equal(res.statusCode, 401);
    } finally { await app.close(); }
});

test('POST /v1/push/subscribe stores a valid subscription', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/push/subscribe',
            headers: { authorization: BASIC, 'content-type': 'application/json' },
            payload: {
                subscription: {
                    endpoint: 'https://push.example/abc',
                    keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) }
                }
            }
        });
        assert.equal(res.statusCode, 201);
        const body = JSON.parse(res.body);
        assert.equal(body.ok, true);
    } finally { await app.close(); }
});

test('POST /v1/push/subscribe rejects malformed body', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/push/subscribe',
            headers: { authorization: BASIC, 'content-type': 'application/json' },
            payload: { subscription: { endpoint: 'https://x' } }
        });
        assert.equal(res.statusCode, 400);
    } finally { await app.close(); }
});

test('DELETE /v1/push/subscribe removes a subscription', async () => {
    const app = await makeApp();
    try {
        // Insert
        await app.inject({
            method: 'POST',
            url: '/v1/push/subscribe',
            headers: { authorization: BASIC, 'content-type': 'application/json' },
            payload: {
                subscription: {
                    endpoint: 'https://push.example/del',
                    keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) }
                }
            }
        });
        // Delete
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/push/subscribe',
            headers: { authorization: BASIC, 'content-type': 'application/json' },
            payload: { endpoint: 'https://push.example/del' }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.ok, true);
    } finally { await app.close(); }
});

test('DELETE /v1/push/subscribe requires auth', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/push/subscribe',
            payload: { endpoint: 'https://push.example/del' }
        });
        assert.equal(res.statusCode, 401);
    } finally { await app.close(); }
});

test('DELETE /v1/push/subscribe cannot drop another user\'s subscription', async () => {
    // Seed a subscription owned by alice@example.com directly via the
    // store, then ensure user@example.com's session can't delete it.
    const cache = makeCache();
    cache.set(hashCreds('alice@example.com', 'hunter2'), true, Date.now());
    const pushStore = createPushStore({ filePath: ':memory:' });
    pushStore.upsert({
        user: 'alice@example.com',
        subscription: { endpoint: 'https://push.example/alice', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) } }
    });
    const app = await build({
        cache,
        ocrCache: null,
        pool: { count: () => 0, closeAll: async () => {} },
        pushStore
    });
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/push/subscribe',
            headers: { authorization: BASIC, 'content-type': 'application/json' },
            payload: { endpoint: 'https://push.example/alice' }
        });
        assert.equal(res.statusCode, 404, 'IDOR: foreign endpoint should look like "not found" to the attacker');
        assert.equal(pushStore.count(), 1, 'alice\'s subscription must still exist');
    } finally { await app.close(); }
});

test('PushStore: upsert + listForUser', () => {
    const store = createPushStore({ filePath: ':memory:' });
    store.upsert({
        user: 'a@b.test',
        subscription: { endpoint: 'https://e/1', keys: { p256dh: 'p1', auth: 'a1' } }
    });
    store.upsert({
        user: 'a@b.test',
        subscription: { endpoint: 'https://e/2', keys: { p256dh: 'p2', auth: 'a2' } }
    });
    store.upsert({
        user: 'c@d.test',
        subscription: { endpoint: 'https://e/3', keys: { p256dh: 'p3', auth: 'a3' } }
    });
    assert.equal(store.count(), 3);
    const subs = store.listForUser({ user: 'a@b.test' });
    assert.equal(subs.length, 2);
    store.deleteForUser({ user: 'a@b.test' });
    assert.equal(store.count(), 1);
    store.close();
});

test('PushStore.delete is user-scoped (IDOR guard)', () => {
    const store = createPushStore({ filePath: ':memory:' });
    store.upsert({ user: 'alice@b.test', subscription: { endpoint: 'https://e/alice', keys: { p256dh: 'p', auth: 'a' } } });
    store.upsert({ user: 'eve@b.test', subscription: { endpoint: 'https://e/eve', keys: { p256dh: 'p', auth: 'a' } } });

    // eve trying to delete alice's endpoint must change 0 rows.
    const changes = store.delete({ endpoint: 'https://e/alice', user: 'eve@b.test' });
    assert.equal(changes, 0);
    assert.equal(store.count(), 2);

    // alice's own delete works.
    const ownChanges = store.delete({ endpoint: 'https://e/alice', user: 'alice@b.test' });
    assert.equal(ownChanges, 1);
    assert.equal(store.count(), 1);

    // user must be passed.
    assert.throws(() => store.delete({ endpoint: 'https://e/eve' }), /user required/);
    store.close();
});
