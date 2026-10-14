'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const mailRulesRoutes = require('../../src/routes/mail-rules');

function sieveStub(seen) {
    return {
        listRules: async () => [],
        addRule: async (user, pass, body) => {
            seen.push({ user, pass, body });
            return { id: 'rule-test', ...body };
        }
    };
}

async function buildApp(sieveManager) {
    const app = Fastify();
    app.addHook('preHandler', async (req) => {
        req.creds = { user: 'u@example.com', pass: 'secret' };
    });
    await app.register(mailRulesRoutes, { sieveManager });
    return app;
}

test('POST /v1/me/mail-rules accepts compound all-of condition', async () => {
    const seen = [];
    const app = await buildApp(sieveStub(seen));
    const payload = {
        name: 'Healthera',
        condition: {
            match: 'all',
            conditions: [
                { type: 'from-contains', value: 'healthera' },
                { type: 'subject-contains', value: 'days left' },
                { type: 'subject-contains', value: 'X', not: true }
            ]
        },
        action: { type: 'fileinto', folder: 'Health' }
    };
    const res = await app.inject({ method: 'POST', url: '/v1/me/mail-rules', payload });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(seen[0].body.condition, payload.condition);
});

test('POST /v1/me/mail-rules still accepts legacy single condition', async () => {
    const seen = [];
    const app = await buildApp(sieveStub(seen));
    const payload = {
        name: 'Legacy',
        condition: { type: 'from-contains', value: 'news' },
        action: { type: 'discard' }
    };
    const res = await app.inject({ method: 'POST', url: '/v1/me/mail-rules', payload });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(seen[0].body.condition, payload.condition);
});
