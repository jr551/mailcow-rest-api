'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuthFailureLimiter } = require('../../src/auth-failure-limit');

const WINDOW = 5 * 60_000;

test('limiter: a key is not blocked below max', () => {
    const limiter = createAuthFailureLimiter({ max: 3, windowMs: WINDOW });
    const t = 1_000_000;
    assert.deepEqual(limiter.check('a', t), { blocked: false, retryAfterMs: 0 });
    limiter.fail('a', t);
    limiter.fail('a', t);
    assert.deepEqual(limiter.check('a', t), { blocked: false, retryAfterMs: 0 });
});

test('limiter: reaching max inside the window blocks, and reports the time left', () => {
    const limiter = createAuthFailureLimiter({ max: 3, windowMs: WINDOW });
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.fail('a', t);
    const state = limiter.check('a', t + 60_000);
    assert.equal(state.blocked, true);
    assert.equal(state.retryAfterMs, WINDOW - 60_000);
});

test('limiter: retryAfterMs decreases as the window elapses', () => {
    const limiter = createAuthFailureLimiter({ max: 2, windowMs: WINDOW });
    const t = 1_000_000;
    limiter.fail('a', t);
    limiter.fail('a', t);
    const first = limiter.check('a', t).retryAfterMs;
    const later = limiter.check('a', t + 120_000).retryAfterMs;
    assert.ok(later < first, `${later} should be less than ${first}`);
    assert.equal(first - later, 120_000);
});

test('limiter: the block lifts once the window has passed', () => {
    const limiter = createAuthFailureLimiter({ max: 2, windowMs: WINDOW });
    const t = 1_000_000;
    limiter.fail('a', t);
    limiter.fail('a', t);
    assert.equal(limiter.check('a', t + WINDOW - 1).blocked, true);
    assert.deepEqual(limiter.check('a', t + WINDOW), { blocked: false, retryAfterMs: 0 });
});

test('limiter: clear drops the key', () => {
    const limiter = createAuthFailureLimiter({ max: 2, windowMs: WINDOW });
    const t = 1_000_000;
    limiter.fail('a', t);
    limiter.fail('a', t);
    assert.equal(limiter.check('a', t).blocked, true);
    limiter.clear('a');
    assert.equal(limiter.check('a', t).blocked, false);
    assert.equal(limiter.size(), 0);
});

test('limiter: a failure after the window starts a fresh run', () => {
    const limiter = createAuthFailureLimiter({ max: 3, windowMs: WINDOW });
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.fail('a', t);
    assert.equal(limiter.check('a', t + WINDOW).blocked, false);
    limiter.fail('a', t + WINDOW);
    // One failure into the new window, not three-plus.
    assert.equal(limiter.check('a', t + WINDOW).blocked, false);
    assert.equal(limiter.check('a', t + WINDOW + 1000).blocked, false);
});

test('limiter: keys are independent', () => {
    const limiter = createAuthFailureLimiter({ max: 2, windowMs: WINDOW });
    const t = 1_000_000;
    limiter.fail('a', t);
    limiter.fail('a', t);
    assert.equal(limiter.check('a', t).blocked, true);
    assert.equal(limiter.check('b', t).blocked, false);
    limiter.fail('b', t);
    assert.equal(limiter.check('b', t).blocked, false);
});

test('limiter: writes prune entries whose window has closed', () => {
    const limiter = createAuthFailureLimiter({ max: 2, windowMs: WINDOW });
    const t = 1_000_000;
    limiter.fail('a', t);
    limiter.fail('a', t);
    limiter.fail('b', t);
    assert.equal(limiter.size(), 2);
    // 'a' and 'b' have both aged out by the time 'c' is written.
    limiter.fail('c', t + WINDOW);
    assert.equal(limiter.size(), 1);
});

test('limiter: maxKeys evicts the oldest key and keeps the map bounded', () => {
    const limiter = createAuthFailureLimiter({ max: 2, windowMs: WINDOW, maxKeys: 3 });
    const t = 1_000_000;
    for (const key of ['a', 'b', 'c', 'd']) {
        limiter.fail(key, t);
        limiter.fail(key, t);
    }
    assert.equal(limiter.size(), 3);
    // 'a' failed first, so it is the one that made room.
    assert.equal(limiter.check('a', t).blocked, false);
    assert.equal(limiter.check('b', t).blocked, true);
    assert.equal(limiter.check('d', t).blocked, true);
});
