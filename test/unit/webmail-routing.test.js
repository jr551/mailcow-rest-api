'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Build a throwaway webmail dist so the SPA routes register the same way they
// do in the image, without pulling in a real Vite build.
function makeDist() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmail-dist-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.mkdirSync(path.join(dir, 'mobile'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>desktop shell</title>');
    fs.writeFileSync(path.join(dir, 'mobile', 'index.html'), '<!doctype html><title>mobile shell</title>');
    fs.writeFileSync(path.join(dir, 'assets', 'main-abc123.js'), 'console.log("app")');
    fs.writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("install", () => {})');
    return dir;
}

// server.js and config.js both read process.env at require time.
async function buildWithWebmail({ dist, adminToken, webmailEnabled } = {}) {
    for (const m of ['../../src/config', '../../src/server', '../../src/routes/admin']) {
        delete require.cache[require.resolve(m)];
    }
    const saved = {
        WEBMAIL_DIST: process.env.WEBMAIL_DIST,
        ADMIN_TOKEN: process.env.ADMIN_TOKEN,
        WEBMAIL_ENABLED: process.env.WEBMAIL_ENABLED,
        ADMIN_SETTINGS_DB_PATH: process.env.ADMIN_SETTINGS_DB_PATH
    };
    if (dist) process.env.WEBMAIL_DIST = dist;
    else delete process.env.WEBMAIL_DIST;
    if (adminToken) process.env.ADMIN_TOKEN = adminToken;
    else delete process.env.ADMIN_TOKEN;
    if (webmailEnabled !== undefined) process.env.WEBMAIL_ENABLED = String(webmailEnabled);
    else delete process.env.WEBMAIL_ENABLED;
    process.env.ADMIN_SETTINGS_DB_PATH = ':memory:';

    const { build } = require('../../src/server');
    const cache = require('../../src/cache').createCache({
        filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0
    });
    const app = await build({ cache, ocrCache: null });

    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return app;
}

test('webmail: a missing asset 404s instead of falling back to the SPA shell', async (t) => {
    const dist = makeDist();
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const app = await buildWithWebmail({ dist });
    try {
        // The regression this guards: @fastify/static called the not-found
        // handler for a missing asset, the handler served index.html with 200,
        // and the service worker cached HTML under a .js URL. Every later load
        // then failed to parse the "script" and the installed PWA was bricked.
        const res = await app.inject({ method: 'GET', url: '/webmail/assets/missing-xyz.js' });
        assert.equal(res.statusCode, 404);
        assert.match(res.headers['content-type'], /application\/problem\+json/);
        assert.doesNotMatch(res.body, /<!doctype html>/i);
    } finally { await app.close(); }
});

test('webmail: any extensioned path 404s, not just /assets/', async (t) => {
    const dist = makeDist();
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const app = await buildWithWebmail({ dist });
    try {
        for (const url of ['/webmail/nope.svg', '/webmail/missing.webmanifest', '/webmail/deep/path/x.css']) {
            const res = await app.inject({ method: 'GET', url });
            assert.equal(res.statusCode, 404, `${url} should 404`);
            assert.match(res.headers['content-type'], /application\/problem\+json/, url);
        }
    } finally { await app.close(); }
});

test('webmail: existing assets are served with their real content type', async (t) => {
    const dist = makeDist();
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const app = await buildWithWebmail({ dist });
    try {
        const js = await app.inject({ method: 'GET', url: '/webmail/assets/main-abc123.js' });
        assert.equal(js.statusCode, 200);
        assert.match(js.headers['content-type'], /javascript/);

        const sw = await app.inject({ method: 'GET', url: '/webmail/sw.js' });
        assert.equal(sw.statusCode, 200);
        assert.match(sw.headers['content-type'], /javascript/);
    } finally { await app.close(); }
});

test('webmail: extensionless deep links fall back to the right shell', async (t) => {
    const dist = makeDist();
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const app = await buildWithWebmail({ dist });
    try {
        const desktop = await app.inject({ method: 'GET', url: '/webmail/inbox/thread/42' });
        assert.equal(desktop.statusCode, 200);
        assert.match(desktop.body, /desktop shell/);

        const mobile = await app.inject({ method: 'GET', url: '/webmail/mobile/inbox' });
        assert.equal(mobile.statusCode, 200);
        assert.match(mobile.body, /mobile shell/);
    } finally { await app.close(); }
});

test('webmail: bare /webmail and /webmail/mobile redirect to their slash form', async (t) => {
    const dist = makeDist();
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const app = await buildWithWebmail({ dist });
    try {
        const a = await app.inject({ method: 'GET', url: '/webmail' });
        assert.equal(a.statusCode, 308);
        assert.equal(a.headers.location, '/webmail/');

        const b = await app.inject({ method: 'GET', url: '/webmail/mobile' });
        assert.equal(b.statusCode, 308);
        assert.equal(b.headers.location, '/webmail/mobile/');
    } finally { await app.close(); }
});

test('webmail: 404s stay problem+json when no dist is present', async () => {
    // The not-found handler used to be registered inside the `webmail dist
    // exists` branch, so an image built without the SPA answered with
    // Fastify's stock 404 body instead of the API's problem+json. /webmail/*
    // is exempt from the IMAP auth hook, so it reaches the handler directly.
    const app = await buildWithWebmail({ dist: '/nonexistent/webmail/dist' });
    try {
        const res = await app.inject({ method: 'GET', url: '/webmail/anything' });
        assert.equal(res.statusCode, 404);
        assert.match(res.headers['content-type'], /application\/problem\+json/);
        assert.equal(JSON.parse(res.body).status, 404);
    } finally { await app.close(); }
});

test('admin: the toggle takes effect without a restart', async (t) => {
    const dist = makeDist();
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const app = await buildWithWebmail({ dist, adminToken: 'secret-token' });
    const auth = { authorization: 'Bearer secret-token' };
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/webmail/' })).statusCode, 200);

        const off = await app.inject({
            method: 'PUT', url: '/v1/admin/settings', headers: auth,
            payload: { webmail: { enabled: false } }
        });
        assert.equal(off.statusCode, 200);
        assert.equal(JSON.parse(off.body).webmail.enabled, false);

        const blocked = await app.inject({ method: 'GET', url: '/webmail/' });
        assert.equal(blocked.statusCode, 404);
        // Assets are gated too, so a disabled webmail can't be half-served
        // out of the static plugin.
        assert.equal((await app.inject({ method: 'GET', url: '/webmail/sw.js' })).statusCode, 404);

        await app.inject({
            method: 'PUT', url: '/v1/admin/settings', headers: auth,
            payload: { webmail: { enabled: true } }
        });
        assert.equal((await app.inject({ method: 'GET', url: '/webmail/' })).statusCode, 200);
    } finally { await app.close(); }
});

test('admin: WEBMAIL_ENABLED=false is not overridable through the API', async (t) => {
    const dist = makeDist();
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const app = await buildWithWebmail({ dist, adminToken: 'secret-token', webmailEnabled: false });
    try {
        const res = await app.inject({
            method: 'PUT', url: '/v1/admin/settings',
            headers: { authorization: 'Bearer secret-token' },
            payload: { webmail: { enabled: true } }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.webmail.enabled, false);
        assert.equal(body.webmail.source, 'env-forced-off');
        assert.equal((await app.inject({ method: 'GET', url: '/webmail/' })).statusCode, 404);
    } finally { await app.close(); }
});

test('admin: rejects a missing or wrong token', async (t) => {
    const dist = makeDist();
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const app = await buildWithWebmail({ dist, adminToken: 'secret-token' });
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/settings' })).statusCode, 401);
        const wrong = await app.inject({
            method: 'GET', url: '/v1/admin/settings',
            headers: { authorization: 'Bearer not-the-token' }
        });
        assert.equal(wrong.statusCode, 401);
        // A wrong token of a different length must not be distinguishable.
        const short = await app.inject({
            method: 'GET', url: '/v1/admin/settings',
            headers: { authorization: 'Bearer x' }
        });
        assert.equal(short.statusCode, 401);
    } finally { await app.close(); }
});

test('admin: routes are not registered without ADMIN_TOKEN', async (t) => {
    const dist = makeDist();
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const app = await buildWithWebmail({ dist });
    try {
        // With no token configured the plugin registers nothing, so the path
        // is just an unknown /v1 route and the ordinary API auth hook turns it
        // away — same response any unauthenticated caller gets anywhere else,
        // which is what keeps the admin surface from being discoverable.
        const res = await app.inject({
            method: 'GET', url: '/v1/admin/settings',
            headers: { authorization: 'Bearer anything' }
        });
        assert.equal(res.statusCode, 401);
        assert.doesNotMatch(res.body, /webmail/, 'must not leak admin settings');

        // And the route genuinely is absent from the routing table.
        assert.doesNotMatch(app.printRoutes(), /admin/);
    } finally { await app.close(); }
});
