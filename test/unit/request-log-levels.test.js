'use strict';

// ROW-70: expected client errors (401 missing credentials, 403 app-password
// self-management, 404s) were logged at warn next to real warnings. 4xx is the
// client's problem; only 5xx is ours. Also guards the FSTDEP023 fix: Fastify
// 5.12 deprecates the top-level disableRequestLogging option and removes it in
// fastify@6, so build() must not pass it any more.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../../src/server');
const { createCache } = require('../../src/cache');

function makeRecorder() {
    const records = [];
    const record = (level) => (first, second) => {
        if (typeof first === 'string') records.push({ level, msg: first, payload: {} });
        else records.push({ level, msg: second, payload: first || {} });
    };
    const recorder = {
        records,
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        debug: record('debug'),
        fatal: record('fatal'),
        trace: record('trace'),
        child() { return recorder; }
    };
    return recorder;
}

function makeCache() {
    return createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0 });
}

function makeApp(logger) {
    return build({ cache: makeCache(), ocrCache: null, logger });
}

test('a 401 rejection is logged at info, not warn', async () => {
    const logger = makeRecorder();
    const app = await makeApp(logger);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes' });
        assert.equal(res.statusCode, 401);
        const rejected = logger.records.filter((r) => r.msg === 'request rejected');
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].level, 'info');
        assert.equal(rejected[0].payload.status, 401);
        assert.equal(logger.records.some((r) => r.level === 'warn' && r.msg === 'request rejected'), false);
    } finally {
        await app.close();
    }
});

test('an unplanned 500 is logged at error with the error attached', async () => {
    const logger = makeRecorder();
    const app = await makeApp(logger);
    try {
        // The app is not listening, so a route can still be registered.
        // `public` keeps the auth hook out of the way so the handler's throw
        // is what the error handler sees.
        app.get('/__boom', { config: { public: true, rateLimit: false } }, async () => {
            throw new Error('boom');
        });
        const res = await app.inject({ method: 'GET', url: '/__boom' });
        assert.equal(res.statusCode, 500);
        const failed = logger.records.filter((r) => r.msg === 'request failed');
        assert.equal(failed.length, 1);
        assert.equal(failed[0].level, 'error');
        assert.equal(failed[0].payload.err.message, 'boom');
    } finally {
        await app.close();
    }
});

test('building the app emits no FSTDEP023 deprecation warning', async () => {
    const warnings = [];
    const onWarning = (w) => warnings.push(w);
    process.on('warning', onWarning);
    let app;
    try {
        app = await makeApp(makeRecorder());
        // process-warning defers the 'warning' event to the next tick.
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
            warnings.some((w) => w.code === 'FSTDEP023'),
            false,
            `FSTDEP023 emitted: ${warnings.map((w) => `${w.code}: ${w.message}`).join(' | ')}`
        );
    } finally {
        process.removeListener('warning', onWarning);
        if (app) await app.close();
    }
});
