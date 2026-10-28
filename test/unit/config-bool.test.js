'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadConfigWith(env) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    delete require.cache[require.resolve('../../src/config')];
    try {
        return require('../../src/config');
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        delete require.cache[require.resolve('../../src/config')];
    }
}

test('bool env parsing treats empty string as unset (uses default)', () => {
    const cfg = loadConfigWith({ WEBMAIL_ENABLED: '' });
    assert.equal(cfg.webmail.enabled, true, 'default webmail stays on when env is blank');
});

test('bool env parsing treats null-like unset as default', () => {
    delete process.env.RATE_LIMIT_ENABLED;
    const cfg = loadConfigWith({ RATE_LIMIT_ENABLED: undefined });
    assert.equal(cfg.rateLimit.enabled, true);
});
