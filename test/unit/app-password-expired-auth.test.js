'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuthHook } = require('../../src/auth');
const { createCache } = require('../../src/cache');
const { createAppPasswordStore } = require('../../src/app-password-store');
const { createSecretBox } = require('../../src/secret-box');
const { createAuthFailureLimiter } = require('../../src/auth-failure-limit');

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

// An app password is not a Dovecot password: the verifier must never be
// reached, and it must not be reached even for a rejected token.
function explodingVerifier() {
    throw new Error('IMAP verifier must not be called for an app password');
}

// `expiresInDays: -1` lands the row's expiry a day in the past.
function mintExpired(store, overrides = {}) {
    return store.create({
        user: 'u@x.com', password: 'real-pw', label: 'expired-client',
        ipRanges: ['203.0.113.0/24'], expiresInDays: -1, ...overrides
    });
}

test('expired app password via Basic: 401 naming the expiry, RFC 6750 WWW-Authenticate', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const created = mintExpired(store);
        let verifierCalls = 0;
        const hook = createAuthHook({
            cache, imap: {}, appPasswords: store,
            verifier: () => { verifierCalls++; throw new Error('must not run'); }
        });

        const reply = makeReply();
        await assert.rejects(
            () => hook(makeReq(basic('u@x.com', created.token), '203.0.113.5'), reply),
            (err) => {
                assert.equal(err.statusCode, 401);
                assert.match(err.problem.detail, /expired/i);
                return true;
            }
        );
        assert.match(reply.headers['www-authenticate'], /error="invalid_token"/);
        assert.match(reply.headers['www-authenticate'], /error_description="app password expired"/);
        assert.equal(verifierCalls, 0, 'the IMAP verifier must not be called for an app password');
    } finally { store.close(); cache.close(); }
});

test('expired app password via Bearer: 401 naming the expiry, RFC 6750 WWW-Authenticate', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const created = mintExpired(store, { label: 'bearer-client' });
        let verifierCalls = 0;
        const hook = createAuthHook({
            cache, imap: {}, appPasswords: store,
            verifier: () => { verifierCalls++; throw new Error('must not run'); }
        });

        const reply = makeReply();
        await assert.rejects(
            () => hook(makeReq(`Bearer ${created.token}`, '203.0.113.5'), reply),
            (err) => {
                assert.equal(err.statusCode, 401);
                assert.match(err.problem.detail, /expired/i);
                return true;
            }
        );
        assert.match(reply.headers['www-authenticate'], /error="invalid_token"/);
        assert.equal(verifierCalls, 0);
    } finally { store.close(); cache.close(); }
});

test('an expired row with a WRONG secret is a generic 401 — the reason does not leak', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const created = mintExpired(store);
        // Same id, garbage secret: before the fix this reported `expired`,
        // confirming the id existed to a caller that does not hold the token.
        const forged = `map_${created.id}_${'x'.repeat(43)}`;
        assert.equal(store.verify({ token: forged, ip: '203.0.113.5' }).reason, 'bad-secret');

        const hook = createAuthHook({ cache, imap: {}, appPasswords: store, verifier: explodingVerifier });
        const reply = makeReply();
        await assert.rejects(
            () => hook(makeReq(basic('u@x.com', forged), '203.0.113.5'), reply),
            (err) => {
                assert.equal(err.statusCode, 401);
                assert.equal(err.problem.detail, 'Invalid credentials');
                assert.doesNotMatch(err.problem.detail, /expired/i);
                return true;
            }
        );
        assert.equal(reply.headers['www-authenticate'], 'Bearer realm="imap-rest"');
    } finally { store.close(); cache.close(); }
});

test('repeated failures on one token: 429 with retry-after, and the store is not checked again', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const created = mintExpired(store);
        let verifyCalls = 0;
        const counting = {
            verify: (...args) => { verifyCalls++; return store.verify(...args); }
        };
        const authFailures = createAuthFailureLimiter({ max: 3, windowMs: 5 * 60_000 });
        const hook = createAuthHook({
            cache, imap: {}, appPasswords: counting, verifier: explodingVerifier, authFailures
        });

        for (let i = 0; i < 3; i++) {
            await assert.rejects(
                () => hook(makeReq(basic('u@x.com', created.token), '203.0.113.5'), makeReply()),
                (err) => err.statusCode === 401
            );
        }
        assert.equal(verifyCalls, 3);

        const reply = makeReply();
        await assert.rejects(
            () => hook(makeReq(basic('u@x.com', created.token), '203.0.113.5'), reply),
            (err) => {
                assert.equal(err.statusCode, 429);
                assert.match(err.problem.detail, /too many failed app password attempts/i);
                return true;
            }
        );
        assert.equal(verifyCalls, 3, 'a blocked attempt must not re-check the store');
        const retryAfter = Number(reply.headers['retry-after']);
        assert.ok(
            Number.isInteger(retryAfter) && retryAfter >= 1,
            `retry-after must be whole seconds >= 1, got ${reply.headers['retry-after']}`
        );
    } finally { store.close(); cache.close(); }
});

test('a success clears the counter, so the next failure starts from one', async () => {
    const cache = makeCache();
    try {
        const token = `map_abc123_${'s'.repeat(20)}`;
        let mode = 'fail';
        const stub = {
            verify: () => (mode === 'ok'
                ? { ok: true, user: 'u@x.com', password: 'real-pw', id: 'abc123', label: 'stub' }
                : { ok: false, reason: 'expired' })
        };
        const authFailures = createAuthFailureLimiter({ max: 3, windowMs: 5 * 60_000 });
        const hook = createAuthHook({
            cache, imap: {}, appPasswords: stub, verifier: explodingVerifier, authFailures
        });
        const req = () => makeReq(basic('u@x.com', token), '203.0.113.5');

        for (let i = 0; i < 2; i++) {
            await assert.rejects(() => hook(req(), makeReply()), (err) => err.statusCode === 401);
        }

        mode = 'ok';
        const okReq = req();
        await hook(okReq, makeReply());
        assert.equal(okReq.creds.pass, 'real-pw');

        // Had the two failures survived, the very next one would already be
        // blocked. It must take three fresh failures to trip the limit again.
        mode = 'fail';
        for (let i = 0; i < 3; i++) {
            await assert.rejects(() => hook(req(), makeReply()), (err) => err.statusCode === 401);
        }
        await assert.rejects(() => hook(req(), makeReply()), (err) => err.statusCode === 429);
    } finally { cache.close(); }
});

test('a blocked token id does not block a different app password', async () => {
    const store = makeStore();
    const cache = makeCache();
    try {
        const expired = mintExpired(store);
        const good = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'other', ipRanges: ['203.0.113.0/24']
        });
        const authFailures = createAuthFailureLimiter({ max: 2, windowMs: 5 * 60_000 });
        const hook = createAuthHook({
            cache, imap: {}, appPasswords: store, verifier: explodingVerifier, authFailures
        });

        for (let i = 0; i < 2; i++) {
            await assert.rejects(
                () => hook(makeReq(basic('u@x.com', expired.token), '203.0.113.5'), makeReply()),
                (err) => err.statusCode === 401
            );
        }
        await assert.rejects(
            () => hook(makeReq(basic('u@x.com', expired.token), '203.0.113.5'), makeReply()),
            (err) => err.statusCode === 429
        );

        const req = makeReq(basic('u@x.com', good.token), '203.0.113.5');
        await hook(req, makeReply());
        assert.equal(req.creds.pass, 'real-pw');
    } finally { store.close(); cache.close(); }
});
