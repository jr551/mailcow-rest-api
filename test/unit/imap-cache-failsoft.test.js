'use strict';

// Regression tests: the IMAP metadata cache (mailbox tree, folder UID
// manifests, folder status, attachment flags) is purely an optimisation — a
// full or read-only database must not fail the IMAP request it is meant to
// speed up. Module-level contract: reads that fail are cache misses, fills,
// invalidations and pruning are best-effort, and the in-memory tier is
// cleared even when the SQLite half of an invalidation fails.
//
// Writes are made to fail while reads keep working by installing BEFORE
// triggers that RAISE(ABORT); reads are failed by dropping the table from a
// second connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Fastify = require('fastify');
const Database = require('better-sqlite3');

const { createImapCache } = require('../../src/imap-cache');
const messageRoutes = require('../../src/routes/messages');

function tmpDb(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-cache-fail-'));
    return path.join(dir, name);
}

function makeCache(file) {
    return createImapCache({ filePath: file, ttlMs: 300_000, pruneIntervalMs: 0 });
}

function failWrites(file, table, events) {
    const ext = new Database(file);
    for (const ev of events) {
        ext.exec(`CREATE TRIGGER fail_${ev}_${table} BEFORE ${ev} ON ${table}
            BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    }
    ext.close();
}

function dropTables(file, tables) {
    const ext = new Database(file);
    for (const t of tables) ext.exec(`DROP TABLE ${t}`);
    ext.close();
}

// ── module contract: reads degrade to a miss ──

test('imap-cache getTree/getUids/getStatus: a failing read is a miss, not a throw', () => {
    const file = tmpDb('imap.db');
    const writer = makeCache(file);
    writer.setTree('h', [{ path: 'INBOX' }]);
    writer.setUids('h', 'INBOX', 1, [1, 2]);
    writer.setStatus('h', 'INBOX', { messages: 2, unseen: 1 });
    writer.close();
    dropTables(file, ['mailbox_tree', 'folder_uids', 'folder_status']);
    // A second instance (fresh in-memory tiers) so the SQLite read path is
    // actually exercised rather than short-circuited by the memory cache.
    const reader = makeCache(file);
    try {
        assert.equal(reader.getTree('h'), null);
        assert.equal(reader.getUids('h', 'INBOX', 1), null);
        assert.equal(reader.getStatus('h', 'INBOX'), null);
    } finally {
        reader.close();
    }
});

test('imap-cache getAttachmentFlags: a failing read is an empty map, not a throw', () => {
    const file = tmpDb('imap.db');
    const c = makeCache(file);
    try {
        c.setAttachmentFlags('h', 'INBOX', 1, [[1, true]]);
        dropTables(file, ['msg_attachments']);
        const flags = c.getAttachmentFlags('h', 'INBOX', 1);
        assert.equal(flags.size, 0);
    } finally {
        c.close();
    }
});

// ── module contract: fills are best-effort ──

test('imap-cache setTree/setUids/setStatus: a failing fill must not throw', () => {
    const file = tmpDb('imap.db');
    const c = makeCache(file);
    try {
        failWrites(file, 'mailbox_tree', ['INSERT', 'UPDATE']);
        failWrites(file, 'folder_uids', ['INSERT', 'UPDATE']);
        failWrites(file, 'folder_status', ['INSERT', 'UPDATE']);
        c.setTree('h', [{ path: 'INBOX' }]);
        c.setUids('h', 'INBOX', 1, [1, 2]);
        c.setStatus('h', 'INBOX', { messages: 2, unseen: 1 });
    } finally {
        c.close();
    }
});

test('imap-cache setAttachmentFlags: a failing fill must not throw', () => {
    const file = tmpDb('imap.db');
    const c = makeCache(file);
    try {
        failWrites(file, 'msg_attachments', ['INSERT', 'UPDATE']);
        c.setAttachmentFlags('h', 'INBOX', 1, [[1, true], [2, false]]);
    } finally {
        c.close();
    }
});

// ── module contract: invalidation and pruning are best-effort ──

test('imap-cache invalidations and prune: failing deletes must not throw', () => {
    const file = tmpDb('imap.db');
    const c = makeCache(file);
    try {
        c.setTree('h', [{ path: 'INBOX' }]);
        c.setUids('h', 'INBOX', 1, [1]);
        c.setStatus('h', 'INBOX', { messages: 1, unseen: 0 });
        c.setAttachmentFlags('h', 'INBOX', 1, [[1, true]]);
        failWrites(file, 'mailbox_tree', ['DELETE']);
        failWrites(file, 'folder_uids', ['DELETE']);
        failWrites(file, 'folder_status', ['DELETE']);
        failWrites(file, 'msg_attachments', ['DELETE']);
        c.invalidateTree('h');
        c.invalidateFolderUid('h', 'INBOX');
        c.invalidateFolderStatus('h', 'INBOX');
        c.invalidateFolder('h', 'INBOX');
        c.invalidateUser('h');
        c.prune();
    } finally {
        c.close();
    }
});

test('imap-cache invalidateFolderUid: the in-memory tier is cleared even when the delete fails', () => {
    const file = tmpDb('imap.db');
    const c = makeCache(file);
    try {
        c.setUids('h', 'INBOX', 1, [1, 2]);
        assert.deepEqual(c.getUids('h', 'INBOX', 1), [1, 2]);
        failWrites(file, 'folder_uids', ['DELETE']);
        c.invalidateFolderUid('h', 'INBOX'); // the delete fails…
        // …so SQLite still holds the row, but the memory tier must not keep
        // serving it past the invalidation.
        dropTables(file, ['folder_uids']);
        assert.equal(c.getUids('h', 'INBOX', 1), null);
    } finally {
        c.close();
    }
});

// ── bug F: invalidateUser must cover every per-user cache table ──

test('imap-cache invalidateUser clears msg_attachments too (the largest table)', () => {
    const file = tmpDb('imap.db');
    const c = makeCache(file);
    try {
        c.setTree('h', [{ path: 'INBOX' }]);
        c.setUids('h', 'INBOX', 1, [1]);
        c.setStatus('h', 'INBOX', { messages: 1, unseen: 0 });
        c.setAttachmentFlags('h', 'INBOX', 1, [[1, true], [2, false]]);

        c.invalidateUser('h');

        assert.equal(c.getTree('h'), null);
        assert.equal(c.getUids('h', 'INBOX', 1), null);
        assert.equal(c.getStatus('h', 'INBOX'), null);
        assert.equal(c.getAttachmentFlags('h', 'INBOX', 1).size, 0,
            'invalidateUser must bulk-delete msg_attachments like every other user cache table');
    } finally {
        c.close();
    }
});

// ── route: a broken cache must not fail the messages handlers ──

function makePoolStub(clientMethods = {}) {
    const client = {
        authenticated: true,
        usable: true,
        // exists > 0 so the list handler reaches the UID-manifest cache.
        mailbox: { exists: 2, uidValidity: 1 },
        async getMailboxLock() {
            return { release() {} };
        },
        async search() { return []; },
        async messageDelete() { return true; },
        ...clientMethods
    };
    return {
        async acquire() { return client; },
        release() {},
        discard() {}
    };
}

async function buildApp(pool, imapCache) {
    const app = Fastify({ logger: false });
    await app.register(require('@fastify/sensible'));
    app.addContentTypeParser('message/rfc822', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(messageRoutes, { pool, ocrCache: null, imapCache });
    return app;
}

test('message list survives an unreadable UID-manifest cache', async () => {
    const file = tmpDb('imap.db');
    const imapCache = makeCache(file);
    imapCache.setUids('h', 'INBOX', 1, [9]);
    dropTables(file, ['folder_uids']);
    const app = await buildApp(makePoolStub(), imapCache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages' });
        assert.equal(res.statusCode, 200, res.body);
    } finally {
        await app.close();
        imapCache.close();
    }
});

test('message delete answers 204 even when the cache invalidation fails (the delete already happened)', async () => {
    const file = tmpDb('imap.db');
    const imapCache = makeCache(file);
    imapCache.setUids('h', 'INBOX', 1, [5]);
    failWrites(file, 'folder_uids', ['DELETE']);
    failWrites(file, 'folder_status', ['DELETE']);
    const app = await buildApp(makePoolStub(), imapCache);
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/mailboxes/INBOX/messages/5' });
        assert.equal(res.statusCode, 204, res.body);
    } finally {
        await app.close();
        imapCache.close();
    }
});
