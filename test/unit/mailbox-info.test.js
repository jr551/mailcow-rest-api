'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const mailboxInfoRoutes = require('../../src/routes/mailbox-info');

function makeDbStub() {
    const tempAliases = [];
    return {
        async getMailbox(email) {
            return {
                username: email,
                name: 'Test User',
                active: true,
                domain: 'x.com',
                localPart: 't',
                quota: 10737418240,
                quotaUsed: 5368709120,
                percentInUse: 50,
                messages: 42,
                created: '2024-01-01 00:00:00',
                modified: '2024-01-02 00:00:00',
                authsource: 'mailcow',
                attributes: {}
            };
        },
        async getLogins(email, limit) {
            return [
                { service: 'imap', ip: '1.2.3.4', time: '2024-01-03 10:00:00' }
            ];
        },
        async listAliases(email) {
            return [
                { id: 1, address: 'alias@x.com', domain: 'x.com', goto: email, active: true, sogoVisible: true, internal: false, senderAllowed: true }
            ];
        },
        async listTempAliases(email) {
            return tempAliases.filter((a) => a.goto === email);
        },
        async createTempAlias(email, opts) {
            const item = {
                address: 'abc123@x.com',
                goto: email,
                validity: opts.permanent ? 0 : Math.floor(Date.now() / 1000) + (opts.validityHours * 3600),
                permanent: opts.permanent
            };
            tempAliases.push(item);
            return { address: item.address, validity: item.validity, permanent: item.permanent };
        },
        async deleteTempAlias(email, address) {
            const idx = tempAliases.findIndex((a) => a.goto === email && a.address === address);
            if (idx === -1) return false;
            tempAliases.splice(idx, 1);
            return true;
        },
        async getSendFromAddresses(email) {
            return [email, 'alias@x.com'];
        }
    };
}

async function buildApp(db) {
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
    await app.register(mailboxInfoRoutes, { db });
    return app;
}

test('GET /v1/me/mailbox returns stats', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/mailbox' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.username, 't@x.com');
        assert.equal(body.messages, 42);
        assert.equal(body.percentInUse, 50);
    } finally {
        await app.close();
    }
});

test('GET /v1/me/logins returns history', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/logins' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.user, 't@x.com');
        assert.equal(body.logins.length, 1);
        assert.equal(body.logins[0].service, 'imap');
    } finally {
        await app.close();
    }
});

test('GET /v1/me/aliases returns aliases', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/aliases' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.aliases.length, 1);
        assert.equal(body.aliases[0].address, 'alias@x.com');
    } finally {
        await app.close();
    }
});

test('GET /v1/me/temp-aliases returns empty initially', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/temp-aliases' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.aliases, []);
    } finally {
        await app.close();
    }
});

test('POST /v1/me/temp-aliases creates alias', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/me/temp-aliases',
            payload: { description: 'test', validityHours: 24 }
        });
        assert.equal(res.statusCode, 201);
        const body = JSON.parse(res.body);
        assert.ok(body.address);
        assert.equal(body.permanent, false);
    } finally {
        await app.close();
    }
});

test('DELETE /v1/me/temp-aliases/:address removes alias', async () => {
    const db = makeDbStub();
    const app = await buildApp(db);
    try {
        await app.inject({ method: 'POST', url: '/v1/me/temp-aliases', payload: {} });
        const res = await app.inject({ method: 'DELETE', url: '/v1/me/temp-aliases/abc123%40x.com' });
        assert.equal(res.statusCode, 204);
    } finally {
        await app.close();
    }
});

test('GET /v1/me/send-from returns addresses', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/send-from' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.addresses, ['t@x.com', 'alias@x.com']);
    } finally {
        await app.close();
    }
});

