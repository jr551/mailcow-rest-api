'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Re-require config with a fresh require cache so each test can stub
// COMPANY_SHORTCUTS without leaking into siblings.
function loadShortcutsRoute(envValue) {
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/routes/shortcuts')];
    const prev = process.env.COMPANY_SHORTCUTS;
    if (envValue === undefined) delete process.env.COMPANY_SHORTCUTS;
    else process.env.COMPANY_SHORTCUTS = envValue;
    const route = require('../../src/routes/shortcuts');
    process.env.COMPANY_SHORTCUTS = prev || '';
    return route;
}

async function buildApp(envValue) {
    const Fastify = require('fastify');
    const app = Fastify({ logger: false });
    const route = loadShortcutsRoute(envValue);
    await app.register(route);
    return app;
}

test('GET /v1/me/shortcuts returns [] by default', async () => {
    const app = await buildApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/shortcuts' });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(JSON.parse(res.body), { shortcuts: [] });
    } finally { await app.close(); }
});

test('GET /v1/me/shortcuts parses + sanitizes a valid JSON array', async () => {
    const json = JSON.stringify([
        { title: 'HR Portal', url: 'https://hr.example.com', mode: 'link', icon: 'user' },
        { title: 'Wiki', url: 'https://wiki.example.com', mode: 'popup' },
        { title: 'Calendar', url: 'https://cal.example.com', mode: 'embed' },
        { title: 'Bad mode', url: 'https://x.example', mode: 'launch-missiles' }
    ]);
    const app = await buildApp(json);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/shortcuts' });
        const body = JSON.parse(res.body);
        assert.equal(body.shortcuts.length, 4);
        assert.equal(body.shortcuts[0].mode, 'link');
        assert.equal(body.shortcuts[1].mode, 'popup');
        assert.equal(body.shortcuts[2].mode, 'embed');
        // Unknown mode falls back to "link"
        assert.equal(body.shortcuts[3].mode, 'link');
    } finally { await app.close(); }
});

test('GET /v1/me/shortcuts ignores malformed JSON', async () => {
    const app = await buildApp('not json {{{');
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/shortcuts' });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(JSON.parse(res.body), { shortcuts: [] });
    } finally { await app.close(); }
});

test('GET /v1/me/shortcuts drops entries without title or url', async () => {
    const app = await buildApp(JSON.stringify([
        { title: 'OK', url: 'https://x.example' },
        { title: 'No url' },
        { url: 'https://no-title.example' },
        null,
        'string'
    ]));
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/shortcuts' });
        const body = JSON.parse(res.body);
        assert.equal(body.shortcuts.length, 1);
        assert.equal(body.shortcuts[0].title, 'OK');
    } finally { await app.close(); }
});
