'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../../src/server');
const { createCache } = require('../../src/cache');

const BASIC = 'Basic ' + Buffer.from('user@example.com:hunter2').toString('base64');

function makeCache() {
    const c = createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0 });
    // Pre-seed valid creds so the verifier is never invoked.
    const { hashCreds } = require('../../src/cache');
    c.set(hashCreds('user@example.com', 'hunter2'), true, Date.now());
    return c;
}

async function makeApp() {
    return build({
        cache: makeCache(),
        ocrCache: null,
        pool: { count: () => 0, closeAll: async () => {} }
    });
}

test('POST /v1/ai/summarize requires auth', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/ai/summarize',
            payload: { text: 'hi' }
        });
        assert.equal(res.statusCode, 401);
    } finally {
        await app.close();
    }
});

test('POST /v1/ai/summarize 501 when MISTRAL_API_KEY missing', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/ai/summarize',
            headers: { authorization: BASIC },
            payload: { text: 'an email body' }
        });
        // unset env in test → ai.apiKey is empty
        assert.equal(res.statusCode, 501);
        const body = JSON.parse(res.body);
        assert.match(body.title, /not configured/i);
    } finally {
        await app.close();
    }
});

test('POST /v1/ai/summarize validates body', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/ai/summarize',
            headers: { authorization: BASIC },
            payload: {}
        });
        assert.equal(res.statusCode, 400);
    } finally {
        await app.close();
    }
});

test('POST /v1/ai/draft-reply 501 when key missing', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/ai/draft-reply',
            headers: { authorization: BASIC },
            payload: { thread: 'last email body', intent: 'decline' }
        });
        assert.equal(res.statusCode, 501);
    } finally {
        await app.close();
    }
});

test('POST /v1/messages/send returns 501 with helpful message', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages/send',
            headers: { authorization: BASIC },
            payload: { to: ['a@b.c'], subject: 's', text: 'hi' }
        });
        assert.equal(res.statusCode, 501);
        const body = JSON.parse(res.body);
        assert.match(body.detail, /SMTP/);
    } finally {
        await app.close();
    }
});

test('POST /v1/messages/send validates body', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages/send',
            headers: { authorization: BASIC },
            payload: { to: [], subject: '' }
        });
        assert.equal(res.statusCode, 400);
    } finally {
        await app.close();
    }
});

test('GET /webmail/ serves the SPA when the dist is built', async () => {
    const app = await makeApp();
    try {
        const fs = require('node:fs');
        const path = require('node:path');
        const distExists = fs.existsSync(path.resolve(process.cwd(), 'webmail/dist/index.html'));
        const res = await app.inject({ method: 'GET', url: '/webmail/' });
        if (distExists) {
            assert.equal(res.statusCode, 200);
            assert.match(res.headers['content-type'], /text\/html/);
            assert.match(res.body, /<div id="app">/);
        } else {
            // No dist built — server logs a warning and the route is unmounted.
            assert.equal(res.statusCode, 404);
        }
    } finally {
        await app.close();
    }
});

test('GET /webmail (no trailing slash) redirects to /webmail/ when dist exists', async () => {
    const app = await makeApp();
    try {
        const fs = require('node:fs');
        const path = require('node:path');
        const distExists = fs.existsSync(path.resolve(process.cwd(), 'webmail/dist/index.html'));
        const res = await app.inject({ method: 'GET', url: '/webmail' });
        if (distExists) {
            assert.equal(res.statusCode, 308);
            assert.equal(res.headers.location, '/webmail/');
        }
    } finally {
        await app.close();
    }
});

test('OpenAPI doc lists ai tag and routes', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/openapi.json' });
        const doc = JSON.parse(res.body);
        const tags = doc.tags.map(t => t.name);
        assert.ok(tags.includes('ai'), 'ai tag declared');
        assert.ok(doc.paths['/v1/ai/summarize'], 'ai summarize route in spec');
        assert.ok(doc.paths['/v1/ai/draft-reply'], 'ai draft-reply route in spec');
        assert.ok(doc.paths['/v1/ai/actions'], 'ai actions route in spec');
        assert.ok(doc.paths['/v1/ai/translate'], 'ai translate route in spec');
        assert.ok(doc.paths['/v1/ai/capabilities'], 'ai capabilities route in spec');
        assert.ok(doc.paths['/v1/messages/send'], 'send stub route in spec');
    } finally {
        await app.close();
    }
});

test('GET /v1/ai/capabilities is public and reports server config', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/ai/capabilities' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(typeof body.configured, 'boolean');
        assert.ok(Array.isArray(body.presets), 'presets is array');
        assert.ok(body.presets.includes('mistral'), 'mistral preset listed');
        assert.ok(body.presets.includes('anthropic'), 'anthropic listed');
        assert.equal(typeof body.allowClientOverride, 'boolean');
    } finally {
        await app.close();
    }
});

test('POST /v1/ai/summarize accepts a per-call provider override', async () => {
    const app = await makeApp();
    try {
        // Without a real upstream we can't get a 200 — but we *can* verify the
        // schema accepts the provider block (validation passes) and the call
        // attempts an outbound request, surfacing as 502 unreachable.
        const res = await app.inject({
            method: 'POST',
            url: '/v1/ai/summarize',
            headers: { authorization: BASIC },
            payload: {
                text: 'hi',
                provider: {
                    kind: 'openai',
                    preset: 'ollama',
                    apiKey: 'sk-no-key',
                    baseUrl: 'http://127.0.0.1:1/v1',
                    model: 'llama3.1'
                }
            }
        });
        // Either 502 (could not connect) or 501 (no key on env if override stripped)
        assert.ok([501, 502].includes(res.statusCode), `unexpected status ${res.statusCode}`);
    } finally {
        await app.close();
    }
});

test('POST /v1/ai/summarize rejects malformed provider override', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/ai/summarize',
            headers: { authorization: BASIC },
            payload: { text: 'hi', provider: { kind: 'not-a-provider' } }
        });
        assert.equal(res.statusCode, 400);
    } finally {
        await app.close();
    }
});

test('POST /v1/ai/actions and /v1/ai/translate validate body', async () => {
    const app = await makeApp();
    try {
        const a = await app.inject({
            method: 'POST',
            url: '/v1/ai/actions',
            headers: { authorization: BASIC },
            payload: {}
        });
        assert.equal(a.statusCode, 400);
        const b = await app.inject({
            method: 'POST',
            url: '/v1/ai/translate',
            headers: { authorization: BASIC },
            payload: { text: 'hi' }  // missing target
        });
        assert.equal(b.statusCode, 400);
    } finally {
        await app.close();
    }
});
