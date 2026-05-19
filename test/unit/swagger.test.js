'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../../src/server');

async function buildBare() {
    const cache = require('../../src/cache').createCache({
        filePath: ':memory:',
        ttlValidMs: 60_000,
        ttlInvalidMs: 10_000,
        pruneIntervalMs: 0
    });
    return build({ cache, ocrCache: null });
}

test('GET / serves Swagger UI HTML', async () => {
    const app = await buildBare();
    try {
        const res = await app.inject({ method: 'GET', url: '/' });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/html/);
        assert.match(res.body, /swagger-ui/i);
    } finally {
        await app.close();
    }
});

test('GET /openapi.json serves the spec', async () => {
    const app = await buildBare();
    try {
        const res = await app.inject({ method: 'GET', url: '/openapi.json' });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /application\/json/);
        const doc = JSON.parse(res.body);
        assert.ok(doc.openapi || doc.swagger, 'has openapi/swagger version');
        assert.equal(doc.info.title, 'mailcow-rest-api');
        assert.ok(doc.paths['/v1/mailboxes'], 'lists mailbox routes');
        assert.ok(doc.components.securitySchemes.basicAuth, 'declares basicAuth');
    } finally {
        await app.close();
    }
});

test('GET / and /openapi.json do not require auth', async () => {
    const app = await buildBare();
    try {
        const a = await app.inject({ method: 'GET', url: '/' });
        const b = await app.inject({ method: 'GET', url: '/openapi.json' });
        assert.equal(a.statusCode, 200);
        assert.equal(b.statusCode, 200);
    } finally {
        await app.close();
    }
});

test('OpenAPI description includes MCP setup snippet', async () => {
    const app = await buildBare();
    try {
        const res = await app.inject({ method: 'GET', url: '/openapi.json' });
        const doc = JSON.parse(res.body);
        assert.match(doc.info.description, /Model Context Protocol/);
        assert.match(doc.info.description, /imap-rest-mcp/);
        assert.match(doc.info.description, /npx/);
        assert.match(doc.info.description, /Kimi/);
        assert.match(doc.info.description, /kimi mcp add/);
    } finally {
        await app.close();
    }
});

test('OpenAPI doc tags routes for grouping', async () => {
    const app = await buildBare();
    try {
        const res = await app.inject({ method: 'GET', url: '/openapi.json' });
        const doc = JSON.parse(res.body);
        assert.deepEqual(doc.paths['/v1/mailboxes'].get.tags, ['mailboxes']);
        assert.deepEqual(doc.paths['/health'].get.tags, ['system']);
    } finally {
        await app.close();
    }
});

test('OpenAPI doc includes forwarded public base URL for proxied Swagger try-it-out', async () => {
    const app = await buildBare();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/openapi.json',
            headers: {
                host: 'mail.example.test',
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'mail.example.test',
                'x-forwarded-prefix': '/imap-rest'
            }
        });
        const doc = JSON.parse(res.body);
        assert.deepEqual(doc.servers, [{ url: 'https://mail.example.test/imap-rest' }]);
    } finally {
        await app.close();
    }
});
