'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');

const { createAuthHook } = require('../../src/auth');
const { createCache } = require('../../src/cache');
const { createAppPasswordStore } = require('../../src/app-password-store');
const { createSecretBox } = require('../../src/secret-box');
const appPasswordRoutes = require('../../src/routes/app-passwords');

const KEY = 'b'.repeat(64);

function makeStore() {
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    return createAppPasswordStore({ filePath: ':memory:', secretBox });
}

function makeCache() {
    return createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0 });
}

function makeReply() {
    const headers = {};
    return { headers, header(k, v) { headers[k.toLowerCase()] = v; return this; } };
}

function makeReq(authorization, ip) {
    return {
        method: 'GET',
        url: '/v1/mailboxes',
        ip,
        headers: { authorization },
        routeOptions: {},
        log: { warn() {}, info() {}, error() {}, debug() {} }
    };
}

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

// The verifier must never be reached by an app password — a token is not a
// Dovecot password and sending it there would fail the login and, worse, feed
// the credential cache a negative entry.
function explodingVerifier() {
    throw new Error('IMAP verifier must not be called for an app password');
}

test('auth: an app password authenticates via Basic and yields the real mailbox password', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const created = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'mcp', ipRanges: ['203.0.113.0/24']
        });
        const hook = createAuthHook({ cache, imap: {}, appPasswords: store, verifier: explodingVerifier });

        const req = makeReq(basic('u@x.com', created.token), '203.0.113.5');
        await hook(req, makeReply());

        assert.equal(req.creds.user, 'u@x.com');
        assert.equal(req.creds.pass, 'real-pw');
        assert.deepEqual(req.appPassword, { id: created.id, label: 'mcp' });
    } finally { store.close(); cache.close(); }
});

test('auth: an app password also works as a bare bearer token', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const created = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'script', ipRanges: ['203.0.113.0/24']
        });
        const hook = createAuthHook({ cache, imap: {}, appPasswords: store, verifier: explodingVerifier });

        const req = makeReq(`Bearer ${created.token}`, '203.0.113.5');
        await hook(req, makeReply());
        assert.equal(req.creds.user, 'u@x.com');
        assert.equal(req.creds.pass, 'real-pw');
    } finally { store.close(); cache.close(); }
});

test('auth: an app password is refused from outside its IP range', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const created = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'mcp', ipRanges: ['203.0.113.0/24']
        });
        const hook = createAuthHook({ cache, imap: {}, appPasswords: store, verifier: explodingVerifier });

        await assert.rejects(
            () => hook(makeReq(basic('u@x.com', created.token), '198.51.100.1'), makeReply()),
            (err) => err.statusCode === 401
        );
    } finally { store.close(); cache.close(); }
});

test('auth: an app password cannot be used under another mailbox\'s username', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const created = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'mcp', ipRanges: ['203.0.113.0/24']
        });
        const hook = createAuthHook({ cache, imap: {}, appPasswords: store, verifier: explodingVerifier });

        await assert.rejects(
            () => hook(makeReq(basic('someone-else@x.com', created.token), '203.0.113.5'), makeReply()),
            (err) => err.statusCode === 401
        );
    } finally { store.close(); cache.close(); }
});

test('auth: a revoked app password stops authenticating', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const created = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'mcp', ipRanges: ['203.0.113.0/24']
        });
        const hook = createAuthHook({ cache, imap: {}, appPasswords: store, verifier: explodingVerifier });
        await hook(makeReq(basic('u@x.com', created.token), '203.0.113.5'), makeReply());

        store.revoke({ id: created.id, user: 'u@x.com' });
        await assert.rejects(
            () => hook(makeReq(basic('u@x.com', created.token), '203.0.113.5'), makeReply()),
            (err) => err.statusCode === 401
        );
    } finally { store.close(); cache.close(); }
});

test('auth: a normal password still goes to the IMAP verifier', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        let called = false;
        const hook = createAuthHook({
            cache, imap: {}, appPasswords: store,
            verifier: async () => { called = true; return { valid: true }; }
        });
        const req = makeReq(basic('u@x.com', 'an-ordinary-password'), '203.0.113.5');
        await hook(req, makeReply());
        assert.equal(called, true);
        assert.equal(req.creds.pass, 'an-ordinary-password');
        assert.equal(req.appPassword, undefined);
    } finally { store.close(); cache.close(); }
});

// ---- routes -------------------------------------------------------------

// Stand-in for the real auth hook: the routes only care about req.creds and
// whether the request arrived on an app password.
async function buildRouteApp({ store, asAppPassword = false, user = 'u@x.com', pass = 'real-pw' }) {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
        req.creds = { user, pass, hash: 'h' };
        if (asAppPassword) req.appPassword = { id: 'x', label: 'y' };
    });
    app.setErrorHandler((err, _req, reply) => {
        reply.code(err.statusCode || 500).send(err.problem || { message: err.message });
    });
    await app.register(appPasswordRoutes, { store });
    return app;
}

test('routes: create, list and revoke round-trip', async () => {
    const store = makeStore();
    const app = await buildRouteApp({ store });
    try {
        const created = await app.inject({
            method: 'POST', url: '/v1/me/app-passwords',
            payload: { label: 'MCP laptop', ipRanges: ['203.0.113.0/24'] }
        });
        assert.equal(created.statusCode, 201);
        const body = JSON.parse(created.body);
        assert.match(body.token, /^map_/);

        const listed = await app.inject({ method: 'GET', url: '/v1/me/app-passwords' });
        assert.equal(listed.statusCode, 200);
        const list = JSON.parse(listed.body);
        assert.equal(list.appPasswords.length, 1);
        assert.equal(list.appPasswords[0].token, undefined, 'the token is never listed');

        const del = await app.inject({ method: 'DELETE', url: `/v1/me/app-passwords/${body.id}` });
        assert.equal(del.statusCode, 204);
        assert.equal(JSON.parse((await app.inject({ method: 'GET', url: '/v1/me/app-passwords' })).body).appPasswords.length, 0);
    } finally { await app.close(); store.close(); }
});

test('routes: an app password cannot mint or revoke app passwords', async () => {
    const store = makeStore();
    const app = await buildRouteApp({ store, asAppPassword: true });
    try {
        // Otherwise a leaked token could issue itself a fresh credential
        // scoped to the attacker's network, surviving revocation of the first.
        const create = await app.inject({
            method: 'POST', url: '/v1/me/app-passwords',
            payload: { label: 'escalate', ipRanges: ['0.0.0.0/0'] }
        });
        assert.equal(create.statusCode, 403);

        assert.equal((await app.inject({ method: 'GET', url: '/v1/me/app-passwords' })).statusCode, 403);
        assert.equal((await app.inject({ method: 'DELETE', url: '/v1/me/app-passwords/anything' })).statusCode, 403);
    } finally { await app.close(); store.close(); }
});

test('routes: a malformed IP range is a 400, not a 500', async () => {
    const store = makeStore();
    const app = await buildRouteApp({ store });
    try {
        const res = await app.inject({
            method: 'POST', url: '/v1/me/app-passwords',
            payload: { label: 'bad', ipRanges: ['not-an-ip'] }
        });
        assert.equal(res.statusCode, 400);
    } finally { await app.close(); store.close(); }
});

test('routes: ipRanges and label are required by the schema', async () => {
    const store = makeStore();
    const app = await buildRouteApp({ store });
    try {
        assert.equal((await app.inject({
            method: 'POST', url: '/v1/me/app-passwords', payload: { label: 'no ranges' }
        })).statusCode, 400);
        assert.equal((await app.inject({
            method: 'POST', url: '/v1/me/app-passwords', payload: { ipRanges: ['10.0.0.0/8'] }
        })).statusCode, 400);
        // additionalProperties:false makes Fastify strip unknown fields rather
        // than reject, so an unexpected key is ignored and never reaches the store.
        const extra = await app.inject({
            method: 'POST', url: '/v1/me/app-passwords',
            payload: { label: 'x', ipRanges: ['10.0.0.0/8'], expiresInDays: 'not-a-number' }
        });
        assert.equal(extra.statusCode, 400, 'a wrongly typed field is still rejected');
    } finally { await app.close(); store.close(); }
});

test('routes: revoking someone else\'s id is a 404', async () => {
    const store = makeStore();
    store.create({ user: 'other@x.com', password: 'pw', label: 'theirs', ipRanges: ['10.0.0.0/8'] });
    const theirs = store.list({ user: 'other@x.com' })[0];
    const app = await buildRouteApp({ store, user: 'u@x.com' });
    try {
        const res = await app.inject({ method: 'DELETE', url: `/v1/me/app-passwords/${theirs.id}` });
        assert.equal(res.statusCode, 404);
        assert.equal(store.list({ user: 'other@x.com' }).length, 1);
    } finally { await app.close(); store.close(); }
});

test('routes: the whole surface is absent when the store is off', async () => {
    const app = Fastify({ logger: false });
    await app.register(appPasswordRoutes, { store: null });
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/v1/me/app-passwords' })).statusCode, 404);
    } finally { await app.close(); }
});
