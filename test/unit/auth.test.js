'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const { parseBasicAuth, parseBearerAuth, createAuthHook } = require('../../src/auth');
const { createCache, hashCreds } = require('../../src/cache');
const { createIpAllowHook } = require('../../src/ip-allow');
const sessionRoutes = require('../../src/routes/session');

function makeReply() {
    const headers = {};
    return {
        headers,
        header(k, v) { headers[k.toLowerCase()] = v; return this; }
    };
}

function makeReq(headerValue) {
    return {
        headers: { authorization: headerValue },
        routeOptions: {},
        log: { warn() {}, info() {}, error() {}, debug() {} }
    };
}

test('parseBasicAuth: valid header', () => {
    const v = 'Basic ' + Buffer.from('u@x.com:pw').toString('base64');
    assert.deepEqual(parseBasicAuth(v), { user: 'u@x.com', pass: 'pw' });
});

test('parseBasicAuth: lowercased scheme still works', () => {
    const v = 'basic ' + Buffer.from('a:b').toString('base64');
    assert.deepEqual(parseBasicAuth(v), { user: 'a', pass: 'b' });
});

test('parseBasicAuth: missing header returns null', () => {
    assert.equal(parseBasicAuth(undefined), null);
    assert.equal(parseBasicAuth(''), null);
});

test('parseBasicAuth: non-basic scheme returns null', () => {
    assert.equal(parseBasicAuth('Bearer xyz'), null);
});

test('parseBearerAuth: valid header', () => {
    assert.equal(parseBearerAuth('Bearer mytoken123'), 'mytoken123');
});

test('parseBearerAuth: lowercased scheme still works', () => {
    assert.equal(parseBearerAuth('bearer mytoken123'), 'mytoken123');
});

test('parseBearerAuth: missing header returns null', () => {
    assert.equal(parseBearerAuth(undefined), null);
    assert.equal(parseBearerAuth(''), null);
});

test('parseBearerAuth: non-bearer scheme returns null', () => {
    assert.equal(parseBearerAuth('Basic abc'), null);
});

test('parseBasicAuth: missing colon returns null', () => {
    const v = 'Basic ' + Buffer.from('nocolon').toString('base64');
    assert.equal(parseBasicAuth(v), null);
});

test('parseBasicAuth: empty user or pass returns null', () => {
    assert.equal(parseBasicAuth('Basic ' + Buffer.from(':pw').toString('base64')), null);
    assert.equal(parseBasicAuth('Basic ' + Buffer.from('u:').toString('base64')), null);
});

test('authHook: missing auth → 401 + WWW-Authenticate', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 1000, ttlInvalidMs: 1000, pruneIntervalMs: 0 });
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => ({ valid: true }) });
    const req = makeReq(undefined);
    const reply = makeReply();
    await assert.rejects(() => hook(req, reply), (err) => err.statusCode === 401);
    assert.equal(reply.headers['www-authenticate'], 'Bearer realm="imap-rest"');
    cache.close();
});

test('authHook: valid Bearer token → passes, sets req.creds and req.session', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    const session = cache.createSession('u@x.com', 'pw', 'somehash');
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => { throw new Error('should not run'); } });
    const req = makeReq('Bearer ' + session.token);
    await hook(req, makeReply());
    assert.equal(req.creds.user, 'u@x.com');
    assert.equal(req.creds.pass, 'pw');
    assert.ok(req.session);
    assert.ok(req.session.expiresAt > Date.now());
    cache.close();
});

test('authHook: expired Bearer token → 401', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => { throw new Error('should not run'); }, now: () => Date.now() + 7200000 });
    const session = cache.createSession('u@x.com', 'pw', 'somehash');
    const req = makeReq('Bearer ' + session.token);
    const reply = makeReply();
    await assert.rejects(() => hook(req, reply), (err) => err.statusCode === 401);
    assert.equal(reply.headers['www-authenticate'], 'Bearer realm="imap-rest"');
    cache.close();
});

test('authHook: cached valid → passes, sets req.creds', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    const hash = hashCreds('u@x.com', 'pw');
    cache.set(hash, true);
    let verified = 0;
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => { verified++; return { valid: true }; } });
    const req = makeReq('Basic ' + Buffer.from('u@x.com:pw').toString('base64'));
    await hook(req, makeReply());
    assert.equal(verified, 0, 'should not call verifier on cache hit');
    assert.equal(req.creds.user, 'u@x.com');
    assert.equal(req.creds.pass, 'pw');
    assert.equal(req.creds.hash, hash);
    cache.close();
});

test('authHook: cached invalid → 401 without re-verifying', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    const hash = hashCreds('u@x.com', 'bad');
    cache.set(hash, false);
    let verified = 0;
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => { verified++; return { valid: true }; } });
    const req = makeReq('Basic ' + Buffer.from('u@x.com:bad').toString('base64'));
    await assert.rejects(() => hook(req, makeReply()), (e) => e.statusCode === 401);
    assert.equal(verified, 0);
    cache.close();
});

test('authHook: cache miss → verifier called, result cached', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    let verified = 0;
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => { verified++; return { valid: true }; } });
    const req = makeReq('Basic ' + Buffer.from('u@x.com:pw').toString('base64'));
    await hook(req, makeReply());
    assert.equal(verified, 1);
    // second call should hit cache
    const req2 = makeReq('Basic ' + Buffer.from('u@x.com:pw').toString('base64'));
    await hook(req2, makeReply());
    assert.equal(verified, 1);
    cache.close();
});

test('authHook: verifier returns invalid → 401, cached as invalid', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => ({ valid: false, reason: 'auth' }) });
    const req = makeReq('Basic ' + Buffer.from('u@x.com:bad').toString('base64'));
    await assert.rejects(() => hook(req, makeReply()), (e) => e.statusCode === 401);
    const entry = cache.get(hashCreds('u@x.com', 'bad'));
    assert.equal(entry.valid, false);
    cache.close();
});

test('authHook: verifier throws (backend down) → 502', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => { throw new Error('ECONNREFUSED'); } });
    const req = makeReq('Basic ' + Buffer.from('u@x.com:pw').toString('base64'));
    await assert.rejects(() => hook(req, makeReply()), (e) => e.statusCode === 502);
    cache.close();
});

test('authHook: public-route config skips auth', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    const hook = createAuthHook({ cache, imap: {}, verifier: async () => { throw new Error('should not run'); } });
    const req = makeReq(undefined);
    req.routeOptions = { config: { public: true } };
    await hook(req, makeReply());
    cache.close();
});

// --- Integration-style tests that compose real hooks with a tiny Fastify app.

// Stand up the same wiring server.js uses (ip-allow, then auth, then session
// route + a stub protected route) so we can verify hook ordering and the
// Basic→Bearer exchange end-to-end without booting the full app.
async function buildMiniApp({ cache, verifier, ipAllowlist = '' }) {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', createIpAllowHook({ allowlist: ipAllowlist }));
    app.addHook('onRequest', createAuthHook({ cache, imap: {}, verifier }));
    await app.register(sessionRoutes, { cache, imap: {}, sessionTtlMs: 60_000 });
    app.get('/v1/protected', async (req) => {
        return { user: req.creds.user, hasSession: !!req.session };
    });
    return app;
}

// Counts LOGINs so we can assert IP-allowlist short-circuits before auth runs.
function makeFakeImapFactory() {
    let openCount = 0;
    return {
        verifier: async () => { openCount++; return { valid: true }; },
        get openCount() { return openCount; }
    };
}

test('Basic→Bearer flow: session token unlocks protected route without re-LOGIN', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    const fake = makeFakeImapFactory();
    const app = await buildMiniApp({ cache, verifier: fake.verifier });
    try {
        const basic = 'Basic ' + Buffer.from('u@x.com:pw').toString('base64');
        const sessRes = await app.inject({
            method: 'POST',
            url: '/v1/auth/session',
            headers: { authorization: basic }
        });
        assert.equal(sessRes.statusCode, 201);
        const { token, expiresAt } = JSON.parse(sessRes.body);
        assert.ok(token && typeof token === 'string');
        assert.ok(new Date(expiresAt).getTime() > Date.now());
        assert.equal(fake.openCount, 1, 'session creation should LOGIN once');

        const protectedRes = await app.inject({
            method: 'GET',
            url: '/v1/protected',
            headers: { authorization: 'Bearer ' + token }
        });
        assert.equal(protectedRes.statusCode, 200);
        const body = JSON.parse(protectedRes.body);
        assert.equal(body.user, 'u@x.com');
        assert.equal(body.hasSession, true);
        assert.equal(fake.openCount, 1, 'Bearer call must not trigger another LOGIN');
    } finally {
        await app.close();
        cache.close();
    }
});

test('Expired Bearer token (cache row with past expiresAt) → 401', async () => {
    // Insert a session directly into the cache with a tiny TTL and let it
    // age out, then call the hook — getSession() prunes expired rows on read
    // and the hook surfaces a 401 with the WWW-Authenticate challenge.
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 1, ttlInvalidMs: 1, pruneIntervalMs: 0 });
    const fake = makeFakeImapFactory();
    const session = cache.createSession('u@x.com', 'pw', hashCreds('u@x.com', 'pw'));
    await new Promise((r) => setTimeout(r, 10));

    const hook = createAuthHook({ cache, imap: {}, verifier: fake.verifier });
    const req = makeReq('Bearer ' + session.token);
    const reply = makeReply();
    await assert.rejects(() => hook(req, reply), (err) => err.statusCode === 401);
    assert.equal(reply.headers['www-authenticate'], 'Bearer realm="imap-rest"');
    assert.equal(fake.openCount, 0, 'expired bearer must not trigger LOGIN');
    cache.close();
});

test('IP allowlist short-circuits before auth (no IMAP LOGIN on blocked IP)', async () => {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60000, ttlInvalidMs: 60000, pruneIntervalMs: 0 });
    const fake = makeFakeImapFactory();
    // Allowlist contains only a remote subnet — neither loopback nor the
    // synthetic injected IP should match.
    const app = await buildMiniApp({
        cache,
        verifier: fake.verifier,
        ipAllowlist: '10.99.99.0/24'
    });
    try {
        const basic = 'Basic ' + Buffer.from('u@x.com:pw').toString('base64');
        const res = await app.inject({
            method: 'POST',
            url: '/v1/auth/session',
            headers: { authorization: basic },
            remoteAddress: '203.0.113.7'
        });
        assert.equal(res.statusCode, 403);
        const body = JSON.parse(res.body);
        assert.equal(body.status, 403);
        assert.match(body.detail || '', /allowlist/i);
        assert.equal(fake.openCount, 0, 'blocked IP must NOT trigger an IMAP LOGIN');
    } finally {
        await app.close();
        cache.close();
    }
});
