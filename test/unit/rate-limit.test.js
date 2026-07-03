'use strict';

process.env.RATE_LIMIT_MAX = '3';
process.env.RATE_LIMIT_WINDOW_MS = '60000';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../../src/server');
const { createCache } = require('../../src/cache');

function makeCache() {
    return createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0 });
}

async function makeApp() {
    return build({ cache: makeCache(), ocrCache: null });
}

test('rate limit: blocks after max requests from the same IP', async () => {
    const app = await makeApp();
    try {
        for (let i = 0; i < 3; i++) {
            const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '9.9.9.9' } });
            assert.equal(res.statusCode, 200);
        }
        const blocked = await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '9.9.9.9' } });
        assert.equal(blocked.statusCode, 429);
    } finally {
        await app.close();
    }
});

test('rate limit: loopback is always exempt', async () => {
    const app = await makeApp();
    try {
        for (let i = 0; i < 6; i++) {
            const res = await app.inject({ method: 'GET', url: '/health' });
            assert.equal(res.statusCode, 200);
        }
    } finally {
        await app.close();
    }
});

test('rate limit: different IPs are tracked independently', async () => {
    const app = await makeApp();
    try {
        for (let i = 0; i < 3; i++) {
            const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '1.1.1.1' } });
            assert.equal(res.statusCode, 200);
        }
        const other = await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '2.2.2.2' } });
        assert.equal(other.statusCode, 200);
    } finally {
        await app.close();
    }
});

test('rate limit: RATE_LIMIT_ENABLED=false disables the limiter', async () => {
    process.env.RATE_LIMIT_ENABLED = 'false';
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/server')];
    const fresh = require('../../src/server');
    const app = await fresh.build({ cache: makeCache(), ocrCache: null });
    try {
        for (let i = 0; i < 6; i++) {
            const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '9.9.9.9' } });
            assert.equal(res.statusCode, 200);
        }
    } finally {
        await app.close();
        delete process.env.RATE_LIMIT_ENABLED;
    }
});
