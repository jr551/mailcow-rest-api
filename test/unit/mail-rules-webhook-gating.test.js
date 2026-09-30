'use strict';

// A webhook-type mail rule compiles to `fileinto ".wh-<id>"; stop;`. When
// outbound webhooks are disabled nothing polls those parking mailboxes, so
// creating such a rule parked every matching message forever — silent mail
// loss with a rule that looked healthy. Creating a webhook rule while the
// feature is off must be refused outright.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const mailRulesRoutes = require('../../src/routes/mail-rules');

function sieveStub(seen) {
    return {
        async addRule(user, pass, body) {
            seen.push(body);
            return { id: 'r1', ...body };
        }
    };
}

async function buildApp(sieveManager, outboundWebhooks) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(mailRulesRoutes, { sieveManager, outboundWebhooks });
    return app;
}

const webhookRule = {
    name: 'Park it',
    condition: { type: 'from-contains', value: 'monitor' },
    action: { type: 'webhook', webhookId: 'wh1' }
};

const fileintoRule = {
    name: 'File it',
    condition: { type: 'from-contains', value: 'monitor' },
    action: { type: 'fileinto', folder: 'Filed' }
};

test('a webhook rule is rejected while outbound webhooks are disabled', async () => {
    const seen = [];
    const app = await buildApp(sieveStub(seen), null);
    try {
        const res = await app.inject({ method: 'POST', url: '/v1/me/mail-rules', payload: webhookRule });
        assert.equal(res.statusCode, 400);
        assert.equal(seen.length, 0, 'the Sieve rule must not be written');
    } finally {
        await app.close();
    }
});

test('a webhook rule is rejected when the webhook is not one the caller owns', async () => {
    const seen = [];
    const app = await buildApp(sieveStub(seen), { get: () => null });
    try {
        const res = await app.inject({ method: 'POST', url: '/v1/me/mail-rules', payload: webhookRule });
        assert.equal(res.statusCode, 400);
        assert.equal(seen.length, 0);
    } finally {
        await app.close();
    }
});

test('a webhook rule is created when the webhook is owned', async () => {
    const seen = [];
    const app = await buildApp(sieveStub(seen), { get: () => ({ id: 'wh1', user: 't@x.com' }) });
    try {
        const res = await app.inject({ method: 'POST', url: '/v1/me/mail-rules', payload: webhookRule });
        assert.equal(res.statusCode, 201);
        assert.equal(seen.length, 1);
    } finally {
        await app.close();
    }
});

test('non-webhook rules still work while outbound webhooks are disabled', async () => {
    const seen = [];
    const app = await buildApp(sieveStub(seen), null);
    try {
        const res = await app.inject({ method: 'POST', url: '/v1/me/mail-rules', payload: fileintoRule });
        assert.equal(res.statusCode, 201);
        assert.equal(seen.length, 1);
    } finally {
        await app.close();
    }
});
