'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const mailboxRoutes = require('../../src/routes/mailboxes');
const messageRoutes = require('../../src/routes/messages');

function makePoolStub(clientMethods) {
    const client = {
        authenticated: true,
        usable: true,
        async getMailboxLock() {
            return { release() {} };
        },
        async search() { return []; },
        ...clientMethods
    };
    return {
        async acquire() { return client; },
        release() {},
        discard() {}
    };
}

async function buildMailboxApp(pool) {
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
    await app.register(mailboxRoutes, { pool });
    return app;
}

async function buildMessageApp(pool, ocrCache) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.addContentTypeParser('message/rfc822', { parseAs: 'buffer' }, (_req, body, done) => {
        done(null, body);
    });
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(messageRoutes, { pool, ocrCache });
    return app;
}

// ── Mailbox routes ──

test('PUT /v1/mailboxes/:path renames nested mailbox', async () => {
    const pool = makePoolStub({
        async mailboxRename(from, newPath) {
            assert.equal(from, 'parent/child');
            assert.equal(newPath, 'parent/renamed');
            return { newPath: 'parent/renamed', delimiter: '/' };
        }
    });
    const app = await buildMailboxApp(pool);
    try {
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/mailboxes/parent%2Fchild',
            payload: { newPath: 'parent/renamed' }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.path, 'parent/renamed');
    } finally {
        await app.close();
    }
});

test('DELETE /v1/mailboxes/:path deletes nested mailbox', async () => {
    const pool = makePoolStub({
        async mailboxDelete(path) {
            assert.equal(path, 'parent/child');
        }
    });
    const app = await buildMailboxApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/parent%2Fchild'
        });
        assert.equal(res.statusCode, 204);
    } finally {
        await app.close();
    }
});

// ── Message routes ──

test('GET /v1/mailboxes/:path/messages lists nested mailbox', async () => {
    const pool = makePoolStub({
        mailbox: { exists: 1, uidValidity: 42 },
        async search() { return [1]; },
        async *fetch() {
            yield {
                uid: 1,
                seq: 1,
                flags: [],
                size: 100,
                internalDate: new Date(),
                envelope: { subject: 'hi' }
            };
        }
    });
    const app = await buildMessageApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/parent%2Fchild/messages'
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.path, 'parent/child');
        assert.equal(body.messages.length, 1);
    } finally {
        await app.close();
    }
});

test('GET /v1/mailboxes/:path/messages/:uid gets message in nested mailbox', async () => {
    const pool = makePoolStub({
        async fetchOne(uid, query, opts) {
            return {
                uid: 42,
                seq: 1,
                flags: [],
                size: 100,
                internalDate: new Date(),
                envelope: { subject: 'hi' },
                bodyStructure: {
                    type: 'text/plain',
                    part: '1',
                    childNodes: []
                }
            };
        },
        async download() {
            return { content: null };
        }
    });
    const app = await buildMessageApp(pool);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/mailboxes/parent%2Fchild/messages/42'
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.uid, 42);
    } finally {
        await app.close();
    }
});

test('PUT /v1/mailboxes/:path/messages/:uid/flags updates flags in nested mailbox', async () => {
    const pool = makePoolStub({
        async messageFlagsAdd() {},
        async fetchOne() {
            return { uid: 42, flags: ['\\Seen'] };
        }
    });
    const app = await buildMessageApp(pool);
    try {
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/mailboxes/parent%2Fchild/messages/42/flags',
            payload: { add: ['\\Seen'] }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.flags, ['\\Seen']);
    } finally {
        await app.close();
    }
});

test('PUT /v1/mailboxes/:path/messages/:uid/move moves from nested mailbox', async () => {
    const pool = makePoolStub({
        async messageMove(uid, dest, opts) {
            assert.equal(dest, 'other/nested');
            return { uidMap: new Map([[42, 99]]) };
        }
    });
    const app = await buildMessageApp(pool);
    try {
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/mailboxes/parent%2Fchild/messages/42/move',
            payload: { path: 'other/nested' }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.destUid, 99);
    } finally {
        await app.close();
    }
});

test('POST /v1/mailboxes/:path/messages appends raw RFC822', async () => {
    let capturedPath = null;
    let capturedContent = null;
    let capturedFlags = null;
    let capturedDate = null;
    const pool = makePoolStub({
        async append(path, content, flags, idate) {
            capturedPath = path;
            capturedContent = content;
            capturedFlags = flags;
            capturedDate = idate;
            return { path, uid: 1234, uidValidity: 5678 };
        }
    });
    const app = await buildMessageApp(pool);
    try {
        const raw = Buffer.from('Subject: webmail-settings\r\nDate: Wed, 30 Apr 2026 12:00:00 +0000\r\nContent-Type: application/json\r\n\r\n{"hello":"world"}');
        const res = await app.inject({
            method: 'POST',
            url: '/v1/mailboxes/.storage_webmailsettings/messages?flags=Seen,Draft',
            headers: { 'content-type': 'message/rfc822' },
            payload: raw
        });
        assert.equal(res.statusCode, 201);
        const body = JSON.parse(res.body);
        assert.equal(body.path, '.storage_webmailsettings');
        assert.equal(body.uid, 1234);
        assert.equal(body.uidValidity, 5678);
        assert.equal(capturedPath, '.storage_webmailsettings');
        assert.ok(Buffer.isBuffer(capturedContent));
        assert.equal(capturedContent.toString(), raw.toString());
        assert.deepEqual(capturedFlags, ['\\Seen', '\\Draft']);
        assert.equal(capturedDate, undefined);
    } finally {
        await app.close();
    }
});

test('POST /v1/mailboxes/:path/messages rejects empty body', async () => {
    const pool = makePoolStub({
        async append() {
            assert.fail('append should not be called for empty body');
        }
    });
    const app = await buildMessageApp(pool);
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/mailboxes/INBOX/messages',
            headers: { 'content-type': 'message/rfc822' },
            payload: Buffer.alloc(0)
        });
        assert.equal(res.statusCode, 400);
    } finally {
        await app.close();
    }
});

test('DELETE /v1/mailboxes/:path/messages/:uid deletes message in nested mailbox', async () => {
    const pool = makePoolStub({
        async messageDelete() {
            return true;
        }
    });
    const app = await buildMessageApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/parent%2Fchild/messages/42'
        });
        assert.equal(res.statusCode, 204);
    } finally {
        await app.close();
    }
});
