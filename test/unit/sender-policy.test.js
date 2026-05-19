'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const senderPolicyRoutes = require('../../src/routes/sender-policy');

function makeDbStub() {
    const blocked = [];
    const allowed = [];
    let nextId = 1;
    return {
        async listPolicies(email, option) {
            const list = option === 'blacklist_from' ? blocked : allowed;
            return list.filter((i) => i.email === email).map(({ prefid, sender }) => ({ prefid, sender }));
        },
        async addPolicy(email, option, sender) {
            const list = option === 'blacklist_from' ? blocked : allowed;
            if (list.some((i) => i.email === email && i.sender === sender)) {
                throw new Error('Sender policy already exists');
            }
            const item = { prefid: nextId++, email, sender };
            list.push(item);
            return { prefid: item.prefid, sender };
        },
        async removePolicy(email, option, prefid) {
            const list = option === 'blacklist_from' ? blocked : allowed;
            const idx = list.findIndex((i) => i.email === email && i.prefid === prefid);
            if (idx === -1) return false;
            list.splice(idx, 1);
            return true;
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
    await app.register(senderPolicyRoutes, { db });
    return app;
}

test('GET /v1/me/blocked-senders returns empty list initially', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/blocked-senders' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.user, 't@x.com');
        assert.deepEqual(body.list, []);
    } finally {
        await app.close();
    }
});

test('POST /v1/me/blocked-senders adds a blocked sender', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/me/blocked-senders',
            payload: { sender: 'spammer@evil.com' }
        });
        assert.equal(res.statusCode, 201);
        const body = JSON.parse(res.body);
        assert.equal(body.sender, 'spammer@evil.com');
        assert.equal(typeof body.prefid, 'number');
    } finally {
        await app.close();
    }
});

test('POST /v1/me/blocked-senders rejects invalid sender pattern', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/me/blocked-senders',
            payload: { sender: 'not valid!' }
        });
        assert.equal(res.statusCode, 400);
    } finally {
        await app.close();
    }
});

test('POST /v1/me/blocked-senders rejects duplicate', async () => {
    const db = makeDbStub();
    const app = await buildApp(db);
    try {
        await app.inject({ method: 'POST', url: '/v1/me/blocked-senders', payload: { sender: 'dup@x.com' } });
        const res = await app.inject({ method: 'POST', url: '/v1/me/blocked-senders', payload: { sender: 'dup@x.com' } });
        assert.equal(res.statusCode, 409);
    } finally {
        await app.close();
    }
});

test('DELETE /v1/me/blocked-senders/:prefid removes blocked sender', async () => {
    const db = makeDbStub();
    const app = await buildApp(db);
    try {
        const add = await app.inject({ method: 'POST', url: '/v1/me/blocked-senders', payload: { sender: 'bye@x.com' } });
        const { prefid } = JSON.parse(add.body);
        const res = await app.inject({ method: 'DELETE', url: `/v1/me/blocked-senders/${prefid}` });
        assert.equal(res.statusCode, 204);
    } finally {
        await app.close();
    }
});

test('DELETE /v1/me/blocked-senders/:prefid returns 404 for unknown prefid', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/me/blocked-senders/999' });
        assert.equal(res.statusCode, 404);
    } finally {
        await app.close();
    }
});

test('GET /v1/me/allowed-senders returns empty list initially', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/allowed-senders' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.user, 't@x.com');
        assert.deepEqual(body.list, []);
    } finally {
        await app.close();
    }
});

test('POST /v1/me/allowed-senders adds an allowed sender', async () => {
    const app = await buildApp(makeDbStub());
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/me/allowed-senders',
            payload: { sender: 'boss@company.com' }
        });
        assert.equal(res.statusCode, 201);
        const body = JSON.parse(res.body);
        assert.equal(body.sender, 'boss@company.com');
    } finally {
        await app.close();
    }
});

