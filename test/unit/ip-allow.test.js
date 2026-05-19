'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const { parseAllowlist, isAllowed, createIpAllowHook } = require('../../src/ip-allow');

// parseAllowlist

test('parseAllowlist: empty string returns empty rules', () => {
    assert.deepEqual(parseAllowlist(''), { v4: [], v6: [] });
});

test('parseAllowlist: undefined returns empty rules', () => {
    assert.deepEqual(parseAllowlist(undefined), { v4: [], v6: [] });
});

test('parseAllowlist: single v4 IP becomes /32', () => {
    const r = parseAllowlist('10.0.0.5');
    assert.equal(r.v4.length, 1);
    assert.equal(r.v4[0].prefix, 32);
});

test('parseAllowlist: single v4 CIDR', () => {
    const r = parseAllowlist('10.0.0.0/8');
    assert.equal(r.v4.length, 1);
    assert.equal(r.v4[0].prefix, 8);
});

test('parseAllowlist: comma-separated mix of v4 and v6', () => {
    const r = parseAllowlist('10.0.0.0/8, 192.168.1.5 ,::1');
    assert.equal(r.v4.length, 2);
    assert.equal(r.v6.length, 1);
});

test('parseAllowlist: malformed IP throws', () => {
    assert.throws(() => parseAllowlist('not-an-ip'), /Invalid/);
});

test('parseAllowlist: out-of-range prefix throws', () => {
    assert.throws(() => parseAllowlist('10.0.0.0/33'), /Invalid/);
});

test('parseAllowlist: negative prefix throws', () => {
    assert.throws(() => parseAllowlist('10.0.0.0/-1'), /Invalid/);
});

// isAllowed

test('isAllowed: empty allowlist + allowAll passes', () => {
    const rules = parseAllowlist('');
    assert.equal(isAllowed('1.2.3.4', rules, { allowAll: true }), true);
});

test('isAllowed: in-CIDR allowed', () => {
    const rules = parseAllowlist('10.0.0.0/8');
    assert.equal(isAllowed('10.5.5.5', rules), true);
});

test('isAllowed: out-of-CIDR rejected', () => {
    const rules = parseAllowlist('10.0.0.0/8');
    assert.equal(isAllowed('11.0.0.1', rules), false);
});

test('isAllowed: exact IP match', () => {
    const rules = parseAllowlist('192.168.1.5');
    assert.equal(isAllowed('192.168.1.5', rules), true);
    assert.equal(isAllowed('192.168.1.6', rules), false);
});

test('isAllowed: v6 in CIDR', () => {
    const rules = parseAllowlist('2001:db8::/32');
    assert.equal(isAllowed('2001:db8::1', rules), true);
    assert.equal(isAllowed('2001:db9::1', rules), false);
});

test('isAllowed: malformed input returns false', () => {
    const rules = parseAllowlist('10.0.0.0/8');
    assert.equal(isAllowed('not-an-ip', rules), false);
});

// createIpAllowHook (via Fastify inject)

async function buildApp({ allowlist, trustProxy = false }) {
    const app = Fastify({ trustProxy, logger: false });
    app.addHook('onRequest', createIpAllowHook({ allowlist }));
    app.get('/health', async () => ({ ok: true }));
    return app;
}

test('hook: empty allowlist passes everything', async () => {
    const app = await buildApp({ allowlist: '' });
    try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        assert.equal(res.statusCode, 200);
    } finally {
        await app.close();
    }
});

test('hook: blocked IP returns 403 problem+json', async () => {
    const app = await buildApp({ allowlist: '10.0.0.0/8', trustProxy: true });
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { 'x-forwarded-for': '8.8.8.8' }
        });
        assert.equal(res.statusCode, 403);
        assert.match(res.headers['content-type'], /application\/problem\+json/);
        const body = JSON.parse(res.body);
        assert.equal(body.status, 403);
        assert.equal(body.title, 'Forbidden');
    } finally {
        await app.close();
    }
});

test('hook: loopback always allowed', async () => {
    const app = await buildApp({ allowlist: '10.0.0.0/8' });
    try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        assert.equal(res.statusCode, 200);
    } finally {
        await app.close();
    }
});

test('hook: trustProxy=true honors X-Forwarded-For for allow', async () => {
    const app = await buildApp({ allowlist: '10.0.0.0/8', trustProxy: true });
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { 'x-forwarded-for': '10.5.5.5' }
        });
        assert.equal(res.statusCode, 200);
    } finally {
        await app.close();
    }
});

test('hook: trustProxy=false ignores X-Forwarded-For (loopback wins)', async () => {
    const app = await buildApp({ allowlist: '10.0.0.0/8', trustProxy: false });
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { 'x-forwarded-for': '8.8.8.8' }
        });
        assert.equal(res.statusCode, 200);
    } finally {
        await app.close();
    }
});
