'use strict';

// Set env BEFORE requiring config (frozen at first import).
process.env.MISTRAL_API_KEY = 'test-key';
process.env.MISTRAL_OCR_TIMEOUT_MS = '5000';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const messageRoutes = require('../../src/routes/messages');

function makePoolStub({ download }) {
    const client = {
        authenticated: true,
        usable: true,
        download,
        async getMailboxLock() {
            return { release() {} };
        }
    };
    return {
        async acquire() { return client; },
        release() {},
        discard() {}
    };
}

// Build a Fastify app that exposes the message routes without auth.
async function buildApp(pool) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    // Stub auth: attach a creds object to every request.
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(messageRoutes, { pool });
    return app;
}

function withMockUndici(fn) {
    return async () => {
        const original = getGlobalDispatcher();
        const agent = new MockAgent();
        agent.disableNetConnect();
        setGlobalDispatcher(agent);
        try {
            await fn(agent);
        } finally {
            setGlobalDispatcher(original);
            await agent.close();
        }
    };
}

test('GET attachments/:id/text returns plain text by default', withMockUndici(async (agent) => {
    const mistral = agent.get('https://api.mistral.ai');
    mistral.intercept({ path: '/v1/ocr', method: 'POST' }).reply(200, {
        model: 'mistral-ocr-latest',
        pages: [{ index: 0, markdown: '# Page 1' }, { index: 1, markdown: 'Page 2 body' }],
        usage_info: { pages_processed: 2 }
    });

    const pool = makePoolStub({
        download: async () => ({
            content: Readable.from([Buffer.from('%PDF-1.4 fake')]),
            meta: { contentType: 'application/pdf', filename: 'doc.pdf' }
        })
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/INBOX/messages/42/attachments/2/text'
        });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^text\/plain/);
        assert.equal(res.body, '# Page 1\n\n---\n\nPage 2 body');
    } finally {
        await app.close();
    }
}));

test('GET attachments/:id/text?format=json returns full Mistral response', withMockUndici(async (agent) => {
    const mistral = agent.get('https://api.mistral.ai');
    const expected = {
        model: 'mistral-ocr-latest',
        pages: [{ index: 0, markdown: 'hello' }],
        usage_info: { pages_processed: 1 }
    };
    mistral.intercept({ path: '/v1/ocr', method: 'POST' }).reply(200, expected);

    const pool = makePoolStub({
        download: async () => ({
            content: Readable.from([Buffer.from('xx')]),
            meta: { contentType: 'image/png', filename: 'img.png' }
        })
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/INBOX/messages/42/attachments/2/text?format=json'
        });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^application\/json/);
        assert.deepEqual(JSON.parse(res.body), expected);
    } finally {
        await app.close();
    }
}));

test('GET attachments/:id/text returns 404 when attachment missing', async () => {
    const pool = makePoolStub({
        download: async () => null
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/INBOX/messages/42/attachments/9/text'
        });
        assert.equal(res.statusCode, 404);
        assert.match(res.headers['content-type'], /problem\+json/);
        const body = JSON.parse(res.body);
        assert.equal(body.status, 404);
        assert.match(body.title, /Not Found/);
    } finally {
        await app.close();
    }
});

test('GET attachments/:id/text propagates 429 with Retry-After', withMockUndici(async (agent) => {
    const mistral = agent.get('https://api.mistral.ai');
    mistral.intercept({ path: '/v1/ocr', method: 'POST' })
        .reply(429, { object: 'error', message: 'rate-limit' }, { headers: { 'retry-after': '7' } });

    const pool = makePoolStub({
        download: async () => ({
            content: Readable.from([Buffer.from('%PDF')]),
            meta: { contentType: 'application/pdf', filename: 'd.pdf' }
        })
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/INBOX/messages/42/attachments/2/text'
        });
        assert.equal(res.statusCode, 429);
        assert.equal(res.headers['retry-after'], '7');
    } finally {
        await app.close();
    }
}));

test('GET attachments/:id/text supports nested mailbox paths', withMockUndici(async (agent) => {
    const mistral = agent.get('https://api.mistral.ai');
    mistral.intercept({ path: '/v1/ocr', method: 'POST' }).reply(200, {
        model: 'mistral-ocr-latest',
        pages: [{ index: 0, markdown: 'nested ok' }]
    });

    let seenPart = null;
    const pool = makePoolStub({
        download: async (_uid, part) => {
            seenPart = part;
            return {
                content: Readable.from([Buffer.from('%PDF-1.4 fake')]),
                meta: { contentType: 'application/pdf', filename: 'doc.pdf' }
            };
        }
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/john_rowe_fun%2FArchive/messages/42/attachments/2/text'
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'nested ok');
        assert.equal(seenPart, '2');
    } finally {
        await app.close();
    }
}));
