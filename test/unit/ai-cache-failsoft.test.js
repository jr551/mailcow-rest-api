'use strict';

// Regression tests: the AI response cache exists only to save a paid upstream
// call, so a broken cache must never fail the request it is meant to serve.
// Reads that fail are cache misses; the maintenance writes that hang off a
// read (expired-row cleanup, hit counting) are best-effort — losing a cached
// answer because the hit counter could not write would defeat the cache.
//
// Writes are made to fail while reads keep working by installing a BEFORE
// trigger that RAISE(ABORT); reads are failed by dropping the table from a
// second connection — the closest deterministic stand-ins for a full or
// corrupt database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Fastify = require('fastify');
const Database = require('better-sqlite3');

const { createAiCache } = require('../../src/ai-cache');
const aiRoutes = require('../../src/routes/ai');
const config = require('../../src/config');

const body = () => ({
    model: 'm',
    messages: [{ role: 'user', content: 'summarise this' }]
});
const reply = (content) => ({ choices: [{ message: { content } }] });

function tmpDb(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cache-fail-'));
    return path.join(dir, name);
}

function failWrites(file, table, events) {
    const ext = new Database(file);
    for (const ev of events) {
        ext.exec(`CREATE TRIGGER fail_${ev}_${table} BEFORE ${ev} ON ${table}
            BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    }
    ext.close();
}

// ── module contract ──

test('ai-cache get: a hit survives a failing hit-counter write', () => {
    const file = tmpDb('ai.db');
    const c = createAiCache({ filePath: file });
    try {
        c.set('a@x.com', body(), reply('answer'), Date.now(), 'pw');
        failWrites(file, 'ai_cache', ['UPDATE']);
        const hit = c.get('a@x.com', body(), Date.now(), 'pw');
        assert.ok(hit, 'the cached answer must still be served');
        assert.equal(hit.body.choices[0].message.content, 'answer');
    } finally {
        c.close();
    }
});

test('ai-cache get: expired-entry cleanup failing must not throw (miss either way)', () => {
    const file = tmpDb('ai.db');
    const c = createAiCache({ filePath: file, ttlMs: 1000 });
    try {
        const t0 = 5_000_000;
        c.set('a@x.com', body(), reply('stale'), t0, 'pw');
        failWrites(file, 'ai_cache', ['DELETE']);
        assert.equal(c.get('a@x.com', body(), t0 + 60_000, 'pw'), null);
    } finally {
        c.close();
    }
});

test('ai-cache get: a failing read degrades to a miss instead of throwing', () => {
    const file = tmpDb('ai.db');
    const c = createAiCache({ filePath: file });
    try {
        c.set('a@x.com', body(), reply('answer'), Date.now(), 'pw');
        const ext = new Database(file);
        ext.exec('DROP TABLE ai_cache');
        ext.close();
        assert.equal(c.get('a@x.com', body(), Date.now(), 'pw'), null);
    } finally {
        c.close();
    }
});

test('ai-cache set: eviction trim failing must not fail the write it follows', () => {
    const file = tmpDb('ai.db');
    const c = createAiCache({ filePath: file, maxEntries: 2 });
    try {
        c.set('a@x.com', body(), reply('one'), Date.now() - 2000, 'pw');
        c.set('b@x.com', body(), reply('two'), Date.now() - 1000, 'pw');
        failWrites(file, 'ai_cache', ['DELETE']);
        // Third entry puts the cache over maxEntries, so the trim runs — and
        // fails. The entry itself must still be stored and served.
        assert.equal(c.set('c@x.com', body(), reply('three'), Date.now(), 'pw') !== undefined, true);
        assert.equal(c.get('c@x.com', body(), Date.now(), 'pw').body.choices[0].message.content, 'three');
    } finally {
        c.close();
    }
});

// ── route: a broken cache must not 500 the AI request ──

function makeStubProvider() {
    const server = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply('from provider')));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function makeApp(aiCache) {
    const app = Fastify({ logger: false });
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(aiRoutes, { aiCache });
    return app;
}

test('AI chat request survives a broken ai-cache (hit path and miss path)', async () => {
    const server = await makeStubProvider();
    const { port } = server.address();
    const saved = { apiKey: config.ai.apiKey, baseUrl: config.ai.baseUrl };
    config.ai.apiKey = 'test-key';
    config.ai.baseUrl = `http://127.0.0.1:${port}`;

    const file = tmpDb('ai.db');
    const aiCache = createAiCache({ filePath: file });
    const app = await makeApp(aiCache);
    const payload = { messages: [{ role: 'user', content: 'hello' }] };
    try {
        // Warm the cache through the real route.
        const first = await app.inject({
            method: 'POST', url: '/v1/ai/llm/chat/completions', payload
        });
        assert.equal(first.statusCode, 200, first.body);
        assert.notEqual(first.headers['x-ai-cache'], 'hit');

        // Maintenance write (hit counter) fails: the hit must still be served.
        failWrites(file, 'ai_cache', ['UPDATE']);
        const second = await app.inject({
            method: 'POST', url: '/v1/ai/llm/chat/completions', payload
        });
        assert.equal(second.statusCode, 200, second.body);
        assert.equal(second.headers['x-ai-cache'], 'hit');
        assert.equal(JSON.parse(second.body).choices[0].message.content, 'from provider');

        // Whole cache unreadable: degrade to a miss and answer from upstream.
        const ext = new Database(file);
        ext.exec('DROP TABLE ai_cache');
        ext.close();
        const third = await app.inject({
            method: 'POST', url: '/v1/ai/llm/chat/completions', payload
        });
        assert.equal(third.statusCode, 200, third.body);
        assert.equal(JSON.parse(third.body).choices[0].message.content, 'from provider');
    } finally {
        await app.close();
        aiCache.close();
        server.close();
        config.ai.apiKey = saved.apiKey;
        config.ai.baseUrl = saved.baseUrl;
    }
});
