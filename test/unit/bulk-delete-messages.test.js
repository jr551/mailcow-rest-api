'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const messageRoutes = require('../../src/routes/messages');

// DELETE /v1/mailboxes/:path/messages — the bulk form used by "block this
// sender and delete their mail". The behaviour worth pinning here is not
// "it deleted something" (the IMAP stub trivially agrees) but the two
// claims the client makes to the user in its confirmation: the count is
// the count the server found, and a refused expunge is reported as a
// failure rather than as a clean-up that did not happen.

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

async function buildApp(pool) {
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
    await app.register(messageRoutes, { pool });
    return app;
}

test('sender form searches the mailbox and expunges every match', async () => {
    let searched;
    let deleted;
    const pool = makePoolStub({
        async search(query) {
            searched = query;
            return [11, 12, 13];
        },
        async messageDelete(uids, opts) {
            deleted = { uids, opts };
            return true;
        }
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/INBOX/messages',
            payload: { sender: '*@spam.example' }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.path, 'INBOX');
        // The count the confirmation quotes is the server's own match count,
        // so it cannot drift from what was actually expunged.
        assert.equal(body.matched, 3);
        assert.equal(body.deleted, 3);
        assert.deepEqual(searched, { from: '*@spam.example' });
        // UIDs, not sequence numbers — the pattern has to be applied by UID
        // or a concurrent expunge would delete the wrong messages.
        assert.deepEqual(deleted.uids, [11, 12, 13]);
        assert.deepEqual(deleted.opts, { uid: true });
    } finally {
        await app.close();
    }
});

test('uid form expunges exactly the listed uids without searching', async () => {
    let searched = false;
    let deleted;
    const pool = makePoolStub({
        async search() { searched = true; return [99]; },
        async messageDelete(uids) { deleted = uids; return true; }
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/INBOX/messages',
            payload: { uids: [4, 7] }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).deleted, 2);
        assert.deepEqual(deleted, [4, 7]);
        // The bulk-select path already knows the uids; a search here would
        // be a second round-trip and could widen the set.
        assert.equal(searched, false);
    } finally {
        await app.close();
    }
});

test('no matches is a success reporting zero, not an error', async () => {
    const pool = makePoolStub({
        async search() { return []; },
        async messageDelete() { throw new Error('must not be called'); }
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/INBOX/messages',
            payload: { sender: 'noreply@example.com' }
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(
            { matched: JSON.parse(res.body).matched, deleted: JSON.parse(res.body).deleted },
            { matched: 0, deleted: 0 }
        );
    } finally {
        await app.close();
    }
});

test('a refused expunge range is an error, never a silent success', async () => {
    const pool = makePoolStub({
        async search() { return [5, 6, 7]; },
        // IMAP returning false means it declined the range. Reporting
        // deleted: 0 with a 200 would tell the user the folder was cleaned
        // when it still holds every one of those messages.
        async messageDelete() { return false; }
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/INBOX/messages',
            payload: { sender: 'noreply@example.com' }
        });
        assert.equal(res.statusCode, 502);
    } finally {
        await app.close();
    }
});

test('sending both uids and sender is rejected rather than silently picking one', async () => {
    const pool = makePoolStub({});
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/INBOX/messages',
            payload: { uids: [1], sender: 'a@b.com' }
        });
        assert.equal(res.statusCode, 400);
    } finally {
        await app.close();
    }
});

test('dryRun counts without expunging, and opens the mailbox read-only', async () => {
    let readonly = null;
    let deleted = false;
    const pool = makePoolStub({
        async getMailboxLock(_path, opts) {
            readonly = opts && opts.readonly;
            return { release() {} };
        },
        async search() { return [1, 2, 3, 4]; },
        async messageDelete() { deleted = true; return true; }
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/INBOX/messages',
            payload: { sender: 'noreply@example.com', dryRun: true }
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        // The whole point: the number for the confirmation prompt, with
        // nothing destroyed.
        assert.equal(body.matched, 4);
        assert.equal(body.deleted, 0);
        assert.equal(deleted, false);
        // Read-only is the guarantee that survives a future edit dropping
        // the `if (dryRun)` line.
        assert.equal(readonly, true);
    } finally {
        await app.close();
    }
});

test('a real delete opens the mailbox read-write', async () => {
    let readonly = null;
    const pool = makePoolStub({
        async getMailboxLock(_path, opts) {
            readonly = opts && opts.readonly;
            return { release() {} };
        },
        async search() { return [1]; },
        async messageDelete() { return true; }
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/INBOX/messages',
            payload: { sender: 'noreply@example.com' }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(readonly, false);
    } finally {
        await app.close();
    }
});

test('an empty uid list is a no-op, not a search and not an expunge', async () => {
    let searched = false;
    const pool = makePoolStub({
        async search() { searched = true; return [9]; },
        async messageDelete() { throw new Error('must not be called'); }
    });
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/INBOX/messages',
            payload: { uids: [] }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).deleted, 0);
        assert.equal(searched, false);
    } finally {
        await app.close();
    }
});

test('an empty body is rejected — no silent whole-folder interpretation', async () => {
    const pool = makePoolStub({});
    const app = await buildApp(pool);
    try {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/mailboxes/INBOX/messages',
            payload: {}
        });
        assert.equal(res.statusCode, 400);
    } finally {
        await app.close();
    }
});
