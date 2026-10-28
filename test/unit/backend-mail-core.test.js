'use strict';

// Regression tests for the backend mail core pass: auth-result trust, the
// UID manifest's UIDNEXT check, download hardening, cache pruning, the
// open-tracking notification and ManageSieve/alias-ownership details.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const Database = require('better-sqlite3');

const { parseAuthResultsHeader, downloadPartText } = require('../../src/imap');
const { createImapCache } = require('../../src/imap-cache');
const { createTrackingStore } = require('../../src/tracking-store');
const { isPublicIp } = require('../../src/tracking-enrich');
const { createSieveManager } = require('../../src/sieve-manager');
const smtpClient = require('../../src/smtp-client');
const messageRoutes = require('../../src/routes/messages');

async function buildMessagesApp(pool, imapCache) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, req, reply) => {
        reply.code(err.statusCode || 500).send(err.problem || { title: err.message });
    });
    app.addHook('onRequest', async (req) => { req.creds = { user: 't@x.com', pass: 'p', hash: 'h' }; });
    await app.register(messageRoutes, { pool, imapCache });
    return app;
}

function poolOf(client) {
    const full = { authenticated: true, usable: true, async getMailboxLock() { return { release() {} }; }, ...client };
    return { async acquire() { return full; }, release() {}, discard() {} };
}

// ── Authentication-Results trust ──

const MTA = 'Authentication-Results: mx.local;\r\n\tspf=fail smtp.mailfrom=evil.example;\r\n\tdkim=none;\r\n\tdmarc=fail header.from=evil.example\r\n';
const FORGED = 'Authentication-Results: attacker.example; spf=pass; dkim=pass; dmarc=pass\r\n';
const ARC = 'ARC-Authentication-Results: i=1; x; spf=pass; dkim=pass; dmarc=pass\r\n';

test('only the topmost Authentication-Results header counts; forged lower, ARC and Received-SPF headers are ignored', () => {
    const blob = MTA + FORGED + ARC + 'Received-SPF: pass (x)\r\n';
    assert.deepEqual(parseAuthResultsHeader(blob), { spf: 'fail', dkim: 'none', dmarc: 'fail' });
    const detail = parseAuthResultsHeader(blob, { includeRaw: true });
    assert.equal(detail.dmarc, 'fail');
    assert.match(detail.raw, /^Authentication-Results: mx\.local;/);
    assert.equal(detail.raw.includes('attacker.example'), false);
});

test('a header with only ARC or Received-SPF yields no verdict', () => {
    assert.equal(parseAuthResultsHeader(ARC + 'Received-SPF: pass\r\n'), null);
    assert.equal(parseAuthResultsHeader(ARC, { includeRaw: true }), null);
    assert.equal(parseAuthResultsHeader(''), null);
});

test('a verdict smuggled inside a quoted string or comment is not read', () => {
    const blob = 'Authentication-Results: mx.local; spf=fail smtp.mailfrom="x; dmarc=pass; dkim=pass"@evil.example (dmarc=pass); dmarc=fail\r\n';
    const r = parseAuthResultsHeader(blob);
    assert.equal(r.dmarc, 'fail');
    assert.equal(r.dkim, null);
});

test('the detail route reports the local verdict, not a forged one', async () => {
    const pool = poolOf({
        async fetchOne(_uid, query) {
            assert.deepEqual(query.headers, ['authentication-results']);
            return {
                uid: 1, seq: 1, flags: new Set(), size: 1, internalDate: new Date(0),
                envelope: { subject: 's', from: [], to: [] },
                bodyStructure: { type: 'text/plain', part: '1' },
                headers: Buffer.from(MTA + FORGED, 'utf8')
            };
        },
        async download() { return { content: Readable.from([Buffer.from('hi')]) }; }
    });
    const app = await buildMessagesApp(pool);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages/1' });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(JSON.parse(res.body).auth.dmarc, 'fail');
        assert.equal(res.headers['cache-control'], 'private, no-cache');
    } finally {
        await app.close();
    }
});

// ── downloads ──

test('attachment download is always an attachment, with a correct filename and hardening headers', async () => {
    const pool = poolOf({
        async download() {
            return { content: Readable.from([Buffer.from('x')]), meta: { contentType: 'text/html', filename: 'My "Réport".html' } };
        }
    });
    const app = await buildMessagesApp(pool);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages/1/attachments/2' });
        assert.equal(res.statusCode, 200);
        assert.equal(
            res.headers['content-disposition'],
            'attachment; filename="My R_port.html"; filename*=UTF-8\'\'My%20%22R%C3%A9port%22.html'
        );
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['content-security-policy'], 'sandbox');
    } finally {
        await app.close();
    }
});

test('an attachment with no filename still gets an attachment disposition', async () => {
    const pool = poolOf({
        async download() { return { content: Readable.from([Buffer.from('x')]), meta: { contentType: 'image/svg+xml' } }; }
    });
    const app = await buildMessagesApp(pool);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages/1/attachments/2' });
        assert.match(res.headers['content-disposition'], /^attachment; filename="attachment"/);
    } finally {
        await app.close();
    }
});

test('downloadPartText with a cap truncates instead of buffering the whole part, and drains the stream', async () => {
    let consumed = 0;
    const content = Readable.from((function* () {
        for (let i = 0; i < 10; i++) { consumed++; yield Buffer.from('abcdefghij'); }
    })());
    const client = { async download() { return { content }; } };
    const text = await downloadPartText(client, 1, '1', 25);
    assert.equal(text, 'abcdefghijabcdefghijabcde');
    assert.equal(consumed, 10, 'the literal is still read to the end');
    const whole = await downloadPartText({ async download() { return { content: Readable.from([Buffer.from('abc')]) }; } }, 1, '1');
    assert.equal(whole, 'abc');
});

// ── UID manifest vs UIDNEXT ──

function listClient({ exists, uidNext, searchResults }) {
    const calls = { searches: [] };
    return {
        calls,
        pool: poolOf({
            mailbox: { exists, uidValidity: 1, uidNext },
            async search(criteria) { calls.searches.push(criteria); return searchResults[calls.searches.length - 1]; },
            async *fetch(uids) {
                for (const uid of uids) {
                    yield { uid, seq: uid, flags: new Set(), size: 1, internalDate: new Date(0), envelope: { subject: `m${uid}`, from: [], to: [] } };
                }
            }
        })
    };
}

test('a manifest whose length matches EXISTS is not trusted once UIDNEXT has moved', async () => {
    const cache = createImapCache({ filePath: ':memory:', pruneIntervalMs: 0 });
    // One message expunged and one delivered: EXISTS unchanged, UIDNEXT up.
    cache.setUids('h', 'INBOX', 1, [3, 2, 1], 4);
    const { pool, calls } = listClient({ exists: 3, uidNext: 5, searchResults: [[4, 3, 2]] });
    const app = await buildMessagesApp(pool, cache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages' });
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(calls.searches, [{ all: true }]);
        assert.deepEqual(JSON.parse(res.body).messages.map((m) => m.uid), [4, 3, 2]);
        assert.equal(cache.getUidNext('h', 'INBOX', 1), 5);
    } finally {
        await app.close();
        cache.close();
    }
});

test('a manifest with matching length and UIDNEXT is served without a search', async () => {
    const cache = createImapCache({ filePath: ':memory:', pruneIntervalMs: 0 });
    cache.setUids('h', 'INBOX', 1, [3, 2, 1], 4);
    const { pool, calls } = listClient({ exists: 3, uidNext: 4, searchResults: [] });
    const app = await buildMessagesApp(pool, cache);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/mailboxes/INBOX/messages' });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(calls.searches.length, 0);
    } finally {
        await app.close();
        cache.close();
    }
});

// ── imap-cache ──

test('prune removes expired attachment flags and an old-schema file is migrated', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'imap-cache-mig-')), 'imap.db');
    const old = new Database(file);
    old.exec(`
        CREATE TABLE folder_uids (user_hash TEXT NOT NULL, path TEXT NOT NULL, uidvalidity INTEGER NOT NULL,
            uids TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (user_hash, path, uidvalidity));
        CREATE TABLE msg_attachments (user_hash TEXT NOT NULL, path TEXT NOT NULL, uidvalidity INTEGER NOT NULL,
            uid INTEGER NOT NULL, has_attachment INTEGER NOT NULL, PRIMARY KEY (user_hash, path, uidvalidity, uid));
        INSERT INTO msg_attachments VALUES ('h', 'INBOX', 1, 7, 1);
        INSERT INTO folder_uids VALUES ('h', 'INBOX', 1, '[2,1]', ${Date.now() + 60_000});
    `);
    old.close();
    const c = createImapCache({ filePath: file, pruneIntervalMs: 0, attachmentsTtlMs: 60_000 });
    try {
        assert.deepEqual(c.getUids('h', 'INBOX', 1), [2, 1]);
        assert.equal(c.getUidNext('h', 'INBOX', 1), null, 'a pre-migration manifest has no UIDNEXT');
        assert.equal(c.getAttachmentFlags('h', 'INBOX', 1).size, 1);
        c.setAttachmentFlags('h', 'INBOX', 1, [[8, false]]);
        c.prune();
        const flags = c.getAttachmentFlags('h', 'INBOX', 1);
        assert.equal(flags.has(7), false, 'the pre-migration row has no expiry and is pruned');
        assert.equal(flags.get(8), false, 'a fresh row survives');
    } finally {
        c.close();
    }
});

test('folder status expires on its own short TTL, not the generic ttlMs', async () => {
    const c = createImapCache({ filePath: ':memory:', ttlMs: 300_000, statusTtlMs: 100, pruneIntervalMs: 0 });
    try {
        c.setTree('h', [{ path: 'INBOX' }]);
        c.setStatus('h', 'INBOX', { messages: 1, unseen: 1 });
        assert.deepEqual(c.getStatus('h', 'INBOX'), { messages: 1, unseen: 1 });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(c.getStatus('h', 'INBOX'), null);
        assert.ok(c.getTree('h'));
    } finally {
        c.close();
    }
});

// ── open tracking ──

test('isPublicIp rejects every non-global range, including mapped IPv4 and ULA', () => {
    for (const ip of ['10.1.1.1', '172.16.5.4', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.1.1',
        '100.64.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fe80::1%eth0', '::ffff:10.0.0.1', 'unknown', '', undefined]) {
        assert.equal(isPublicIp(ip), false, String(ip));
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
        assert.equal(isPublicIp(ip), true, ip);
    }
});

test('the open notification authenticates as the owning mailbox, answers first, then drops the stored password', async () => {
    const sent = [];
    const original = smtpClient.sendMessage;
    smtpClient.sendMessage = async (args) => { sent.push(args); };
    delete require.cache[require.resolve('../../src/routes/tracking')];
    const trackingRoutes = require('../../src/routes/tracking');
    smtpClient.sendMessage = original;

    const store = createTrackingStore({ filePath: ':memory:', pruneIntervalMs: 0 });
    const app = Fastify({ logger: false });
    app.decorateRequest('creds', null);
    await app.register(trackingRoutes, { store, smtp: { host: 'smtp.local' } });
    try {
        const ref = store.create({ sender: 'alias@x.com', owner: 'owner@x.com', senderPass: 'secret', recipient: 'r@y.com', subject: 'Hi' });
        const res = await app.inject({ method: 'GET', url: `/v1/track/${ref}.gif`, remoteAddress: '127.0.0.1' });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'image/gif');
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(sent.length, 1);
        assert.equal(sent[0].user, 'owner@x.com');
        assert.equal(sent[0].pass, 'secret');
        assert.equal(sent[0].from, 'alias@x.com');
        assert.deepEqual(sent[0].to, ['alias@x.com']);
        assert.equal(store.recordOpen({ ref }).senderPass, '', 'password cleared after the notification');

        await app.inject({ method: 'GET', url: `/v1/track/${ref}.gif` });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(sent.length, 1, 'only the first open notifies');
    } finally {
        await app.close();
        store.close();
    }
});

// ── alias ownership ──

test('canReceiveAt matches goto entries exactly instead of with LIKE wildcards', async () => {
    const queries = [];
    const db = {
        pool: {
            async execute(sql, params) {
                queries.push({ sql, params });
                return [[]];
            }
        }
    };
    const mgr = createSieveManager({ db, imapHost: '127.0.0.1' });
    await assert.rejects(
        mgr.addBlockedRecipient('john_smith@x.com', 'pw', 'a@x.com'),
        /cannot block a recipient/
    );
    const aliasQueries = queries.filter((q) => /FROM alias\b/.test(q.sql) && !/alias_domain/.test(q.sql));
    assert.equal(aliasQueries.length, 2);
    for (const q of aliasQueries) {
        assert.match(q.sql, /FIND_IN_SET\(\?, REPLACE\(goto, ' ', ''\)\)/);
        assert.equal(/LIKE/i.test(q.sql), false);
    }
    assert.deepEqual(aliasQueries.map((q) => q.params), [['a@x.com', 'john_smith@x.com'], ['@x.com', 'john_smith@x.com']]);
});
