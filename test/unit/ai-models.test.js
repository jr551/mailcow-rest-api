'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../../src/llm');
const { build } = require('../../src/server');
const { createCache } = require('../../src/cache');

const BASIC = 'Basic ' + Buffer.from('user@example.com:hunter2').toString('base64');

function fakeFetcher(replies) {
    let i = 0;
    return async (...args) => {
        const next = replies[i++];
        if (!next) throw new Error('fakeFetcher exhausted');
        if (typeof next === 'function') return next(...args);
        return next;
    };
}

function bodyJson(obj) {
    return { statusCode: 200, body: { json: async () => obj } };
}

function makeCache() {
    const c = createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0 });
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

function provider(over = {}) {
    return llm.resolveProvider({ kind: 'openai', preset: 'mistral', apiKey: 'sk-test' }, over);
}

// --- llm.listModels: the wire behaviour -------------------------------------

test('listModels: normal { data: [{ id }] } catalog is returned and de-duplicated', async () => {
    const fetcher = fakeFetcher([
        bodyJson({ object: 'list', data: [
            { id: 'mistral-small-latest', owned_by: 'mistralai' },
            { id: 'mistral-large-latest', owned_by: 'mistralai' },
            { id: 'mistral-small-latest', owned_by: 'mistralai' } // duplicate
        ] })
    ]);
    const r = await llm.listModels({ provider: provider(), fetcher });
    assert.equal(r.ok, true);
    assert.deepEqual(r.models, [
        { id: 'mistral-small-latest', owned_by: 'mistralai' },
        { id: 'mistral-large-latest', owned_by: 'mistralai' }
    ]);
});

test('listModels: requests {baseUrl}/models with the bearer key', async () => {
    let seenUrl = null;
    let seenAuth = null;
    const fetcher = fakeFetcher([(url, opts) => {
        seenUrl = url;
        seenAuth = opts.headers.authorization;
        return bodyJson({ data: [{ id: 'm' }] });
    }]);
    await llm.listModels({ provider: provider({ baseUrl: 'https://gw.example/v1' }), fetcher });
    assert.equal(seenUrl, 'https://gw.example/v1/models');
    assert.equal(seenAuth, 'Bearer sk-test');
});

test('listModels: honours a custom base URL (Bifrost-style gateway)', async () => {
    let seenUrl = null;
    const fetcher = fakeFetcher([(url) => { seenUrl = url; return bodyJson({ data: [{ id: 'x' }] }); }]);
    const r = await llm.listModels({
        provider: provider({ baseUrl: 'https://bifrost.example/v1/', apiKey: 'sk-gw' }),
        fetcher
    });
    assert.equal(r.ok, true);
    // trailing slash normalised away
    assert.equal(seenUrl, 'https://bifrost.example/v1/models');
});

test('listModels: provider 500 degrades to ok:false with a reason, no throw', async () => {
    const fetcher = fakeFetcher([{ statusCode: 500, body: { json: async () => ({ error: { message: 'boom' } }) } }]);
    const r = await llm.listModels({ provider: provider(), fetcher });
    assert.equal(r.ok, false);
    assert.match(r.detail, /boom/);
    assert.ok(r.status >= 500);
});

test('listModels: provider 401 maps to a credentials rejection', async () => {
    const fetcher = fakeFetcher([{ statusCode: 401, body: { json: async () => ({ error: { message: 'bad key' } }) } }]);
    const r = await llm.listModels({ provider: provider(), fetcher });
    assert.equal(r.ok, false);
    assert.equal(r.title, 'AI provider rejected our credentials');
});

test('listModels: malformed JSON body is reported as unreadable, not empty', async () => {
    const fetcher = fakeFetcher([{ statusCode: 200, body: { json: async () => { throw new Error('Unexpected token'); } } }]);
    const r = await llm.listModels({ provider: provider(), fetcher });
    assert.equal(r.ok, false);
    assert.equal(r.title, 'Unreadable model list');
});

test('listModels: a non-catalog 200 body is unreadable (not silently empty)', async () => {
    const fetcher = fakeFetcher([bodyJson({ hello: 'world' })]);
    const r = await llm.listModels({ provider: provider(), fetcher });
    assert.equal(r.ok, false);
    assert.equal(r.title, 'Unreadable model list');
});

test('listModels: a well-formed but empty catalog is ok with an empty array', async () => {
    const fetcher = fakeFetcher([bodyJson({ data: [] })]);
    const r = await llm.listModels({ provider: provider(), fetcher });
    assert.equal(r.ok, true);
    assert.deepEqual(r.models, []);
});

test('listModels: connection failure degrades to ok:false with the undici cause', async () => {
    const fetcher = fakeFetcher([() => {
        const err = new Error('');
        err.errors = [{ message: 'ECONNREFUSED' }];
        throw err;
    }]);
    const r = await llm.listModels({ provider: provider(), fetcher });
    assert.equal(r.ok, false);
    assert.match(r.detail, /ECONNREFUSED/);
});

test('listModels: accepts a bare-array and { models: [] } gateway variant', async () => {
    const bare = await llm.listModels({ provider: provider(), fetcher: fakeFetcher([bodyJson([{ id: 'a' }])]) });
    assert.deepEqual(bare.models, [{ id: 'a' }]);
    const wrapped = await llm.listModels({ provider: provider(), fetcher: fakeFetcher([bodyJson({ models: [{ id: 'b' }] })]) });
    assert.deepEqual(wrapped.models, [{ id: 'b' }]);
});

test('listModels: caps the catalog so a huge gateway cannot flood the client', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}` }));
    const fetcher = fakeFetcher([bodyJson({ data: many })]);
    const r = await llm.listModels({ provider: provider(), fetcher });
    assert.equal(r.ok, true);
    assert.equal(r.models.length, 400);
});

test('listModels: the API key is never present in the returned payload', async () => {
    const fetcher = fakeFetcher([bodyJson({ data: [{ id: 'm' }] })]);
    const r = await llm.listModels({ provider: provider({ apiKey: 'sk-super-secret' }), fetcher });
    assert.ok(!JSON.stringify(r).includes('sk-super-secret'));
});

// --- GET /v1/ai/models: the route --------------------------------------------

test('GET /v1/ai/models requires auth', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/ai/models' });
        assert.equal(res.statusCode, 401);
    } finally {
        await app.close();
    }
});

test('GET /v1/ai/models is documented in the OpenAPI spec', async () => {
    const app = await makeApp();
    try {
        const res = await app.inject({ method: 'GET', url: '/openapi.json' });
        const doc = JSON.parse(res.body);
        assert.ok(doc.paths['/v1/ai/models'], 'ai models route in spec');
    } finally {
        await app.close();
    }
});

test('GET /v1/ai/models returns a catalog and never echoes the key', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedBase = config.ai.baseUrl;
    const savedOverride = config.ai.allowClientOverride;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    config.ai.baseUrl = 'https://gw.example/v1';
    config.ai.allowClientOverride = false;
    let seenProviderKey = null;
    llm.listModels = async ({ provider }) => {
        seenProviderKey = provider.apiKey;
        return { ok: true, models: [{ id: 'alpha' }, { id: 'beta', owned_by: 'acme' }] };
    };
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models',
            headers: { authorization: BASIC }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.models, [{ id: 'alpha' }, { id: 'beta', owned_by: 'acme' }]);
        assert.equal(body.error, undefined);
        // The key reached the provider, not the client.
        assert.equal(seenProviderKey, 'sk-server-secret');
        assert.ok(!res.body.includes('sk-server-secret'));
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.baseUrl = savedBase;
        config.ai.allowClientOverride = savedOverride;
        await app.close();
    }
});

// Each of these route tests sets a distinct `config.ai.baseUrl`. The route
// memoizes the catalog per provider — failures included, deliberately — so
// tests sharing a provider would share a cache slot and read each other's
// results.
test('GET /v1/ai/models 200s with empty models + error when the provider is down', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedBase = config.ai.baseUrl;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    config.ai.baseUrl = 'https://down.example/v1';
    llm.listModels = async () => ({ ok: false, status: 502, title: 'AI provider unreachable', detail: 'ECONNREFUSED' });
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models',
            headers: { authorization: BASIC }
        });
        // Not a 5xx — the Settings dropdown must get a usable answer it can render.
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.models, []);
        assert.match(body.error, /ECONNREFUSED/);
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.baseUrl = savedBase;
        await app.close();
    }
});

test('GET /v1/ai/models 200s with empty models + error on a malformed catalog', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedBase = config.ai.baseUrl;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    config.ai.baseUrl = 'https://malformed.example/v1';
    llm.listModels = async () => ({ ok: false, status: 502, title: 'Unreadable model list', detail: 'not a catalog' });
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models',
            headers: { authorization: BASIC }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.models, []);
        assert.match(body.error, /not a catalog/);
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.baseUrl = savedBase;
        await app.close();
    }
});

test('GET /v1/ai/models 200s with an empty array when the gateway lists no models', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedBase = config.ai.baseUrl;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    config.ai.baseUrl = 'https://norem.example/v1';
    llm.listModels = async () => ({ ok: true, models: [] });
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models',
            headers: { authorization: BASIC }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        // Empty is a *successful* answer, not an error: the client renders
        // "the gateway returned no models", which reads differently from a
        // failed fetch, and the two must not be conflated.
        assert.deepEqual(body.models, []);
        assert.equal(body.error, undefined);
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.baseUrl = savedBase;
        await app.close();
    }
});

test('GET /v1/ai/models 501 when no key is configured at all', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    config.ai.apiKey = '';
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models',
            headers: { authorization: BASIC }
        });
        assert.equal(res.statusCode, 501);
    } finally {
        config.ai.apiKey = savedKey;
        await app.close();
    }
});

// The next two tests exercise the client-supplied baseUrl path, which now
// goes through assertPublicDestination. They use a *literal* public address
// (93.184.216.34) rather than a hostname: the guard resolves hostnames, and a
// test should not depend on the resolver. Literal IPs still get the private-
// range check, which is what matters here.
test('GET /v1/ai/models honours a public custom base URL from the query', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedOverride = config.ai.allowClientOverride;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    config.ai.allowClientOverride = true;
    let seenBase = null;
    llm.listModels = async ({ provider }) => {
        seenBase = provider.baseUrl;
        return { ok: true, models: [{ id: 'custom' }] };
    };
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models?kind=openai&baseUrl=https%3A%2F%2F93.184.216.34%2Fv1',
            headers: { authorization: BASIC }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(seenBase, 'https://93.184.216.34/v1');
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.allowClientOverride = savedOverride;
        await app.close();
    }
});

test('GET /v1/ai/models ignores a client base URL when overrides are disabled', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedBase = config.ai.baseUrl;
    const savedOverride = config.ai.allowClientOverride;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    // Distinct from the previous test's server address: the catalog cache is
    // keyed on the resolved baseUrl, so a shared one would read its result.
    config.ai.baseUrl = 'https://198.51.100.7/v1';
    config.ai.allowClientOverride = false;
    let seenBase = null;
    llm.listModels = async ({ provider }) => {
        seenBase = provider.baseUrl;
        return { ok: true, models: [] };
    };
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models?baseUrl=https%3A%2F%2F10.0.0.5%2Fv1',
            headers: { authorization: BASIC }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(seenBase, 'https://198.51.100.7/v1', 'client base URL must be dropped');
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.baseUrl = savedBase;
        config.ai.allowClientOverride = savedOverride;
        await app.close();
    }
});

// --- SSRF: a client-supplied baseUrl must not become a read primitive -------

test('GET /v1/ai/models refuses a loopback base URL from the query', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedOverride = config.ai.allowClientOverride;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    config.ai.allowClientOverride = true;
    let probed = false;
    llm.listModels = async () => { probed = true; return { ok: true, models: [] }; };
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models?baseUrl=' + encodeURIComponent('http://127.0.0.1:9200/_cluster/health'),
            headers: { authorization: BASIC }
        });
        // Degrades to 200 so the dropdown still renders…
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.models, []);
        // …and the provider is never contacted at all.
        assert.equal(probed, false, 'must not reach an internal destination');
        assert.match(body.error, /private/i);
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.allowClientOverride = savedOverride;
        await app.close();
    }
});

test('GET /v1/ai/models refuses the cloud metadata address from the query', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedOverride = config.ai.allowClientOverride;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    config.ai.allowClientOverride = true;
    let probed = false;
    llm.listModels = async () => { probed = true; return { ok: true, models: [] }; };
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models?baseUrl=' + encodeURIComponent('http://169.254.169.254/latest/meta-data/'),
            headers: { authorization: BASIC }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.models, []);
        assert.equal(probed, false);
        assert.match(body.error, /private/i);
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.allowClientOverride = savedOverride;
        await app.close();
    }
});

test('GET /v1/ai/models refuses an RFC1918 base URL from the query', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedOverride = config.ai.allowClientOverride;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    config.ai.allowClientOverride = true;
    let probed = false;
    llm.listModels = async () => { probed = true; return { ok: true, models: [] }; };
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models?baseUrl=' + encodeURIComponent('http://10.1.2.3:8080/v1'),
            headers: { authorization: BASIC }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.models, []);
        assert.equal(probed, false);
        assert.match(body.error, /private/i);
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.allowClientOverride = savedOverride;
        await app.close();
    }
});

test('GET /v1/ai/models still allows a private SERVER base URL (local Ollama)', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedBase = config.ai.baseUrl;
    const savedPreset = config.ai.preset;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    // The supported `ollama` preset: a private address as operator config.
    // Guarding the server's own provider would break every local install.
    config.ai.baseUrl = 'http://127.0.0.1:11434/v1';
    config.ai.preset = '';
    let seenBase = null;
    llm.listModels = async ({ provider }) => {
        seenBase = provider.baseUrl;
        return { ok: true, models: [{ id: 'llama3.1' }] };
    };
    const app = await makeApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/ai/models',
            headers: { authorization: BASIC }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.error, undefined, 'server-configured private baseUrl must not be blocked');
        assert.deepEqual(body.models, [{ id: 'llama3.1' }]);
        assert.equal(seenBase, 'http://127.0.0.1:11434/v1');
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.baseUrl = savedBase;
        config.ai.preset = savedPreset;
        await app.close();
    }
});

test('GET /v1/ai/models caches so repeated opens do not re-probe the gateway', async () => {
    const config = require('../../src/config');
    const savedKey = config.ai.apiKey;
    const savedBase = config.ai.baseUrl;
    const realListModels = llm.listModels;
    config.ai.apiKey = 'sk-server-secret';
    config.ai.baseUrl = 'https://cache.example/v1';
    let calls = 0;
    llm.listModels = async () => { calls++; return { ok: true, models: [{ id: 'cached' }] }; };
    const app = await makeApp();
    try {
        const headers = { authorization: BASIC };
        await app.inject({ method: 'GET', url: '/v1/ai/models', headers });
        await app.inject({ method: 'GET', url: '/v1/ai/models', headers });
        await app.inject({ method: 'GET', url: '/v1/ai/models', headers });
        assert.equal(calls, 1, 'second and third reads served from cache');
    } finally {
        llm.listModels = realListModels;
        config.ai.apiKey = savedKey;
        config.ai.baseUrl = savedBase;
        await app.close();
    }
});
