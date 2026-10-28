'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const Fastify = require('fastify');

const { createSecretBox } = require('../../src/secret-box');
const { createAppPasswordStore } = require('../../src/app-password-store');
const { scrubText } = require('../../src/secret-scrub');
const { isAllowed, LOOPBACK_RULES } = require('../../src/ip-allow');
const { redactUrl } = require('../../src/server');
const { visibleTo } = require('../../src/routes/telemetry').__testables;
const { createCache } = require('../../src/cache');
const { createAuthHook } = require('../../src/auth');
const sessionRoutes = require('../../src/routes/session');

const KEY = 'a'.repeat(64);

test('secret-box: a truncated auth tag or wrong-length IV is refused', () => {
    const box = createSecretBox({ envValue: KEY });
    const [prefix, iv, tag, ct] = box.encrypt('secret').split(':');
    assert.equal(box.decrypt([prefix, iv, tag, ct].join(':')), 'secret');

    const shortTag = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');
    assert.equal(box.decrypt([prefix, iv, shortTag, ct].join(':')), null);

    const shortIv = Buffer.from(iv, 'base64').subarray(0, 8).toString('base64');
    assert.equal(box.decrypt([prefix, shortIv, tag, ct].join(':')), null);
});

test('app passwords: revoking wipes the sealed mailbox password', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-apppw-'));
    const filePath = path.join(dir, 'app-passwords.db');
    const store = createAppPasswordStore({ filePath, secretBox: createSecretBox({ envValue: KEY }) });
    try {
        const created = store.create({
            user: 'u@example.com', password: 'mailbox-pw', label: 'x', ipRanges: ['203.0.113.0/24']
        });
        assert.equal(store.revoke({ id: created.id, user: 'u@example.com' }), 1);

        const db = new Database(filePath, { readonly: true });
        const row = db.prepare('SELECT secret, revoked_at FROM app_passwords WHERE id = ?').get(created.id);
        db.close();
        assert.ok(row.revoked_at);
        assert.equal(row.secret, '');
        assert.equal(store.verify({ token: created.token, ip: '203.0.113.9' }).reason, 'revoked');
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('app passwords: expired tokens do not count against the per-user limit', () => {
    const store = createAppPasswordStore({
        filePath: ':memory:', secretBox: createSecretBox({ envValue: KEY }), maxPerUser: 1
    });
    try {
        const mint = (now, days) => store.create({
            user: 'u@example.com', password: 'pw', label: 'x', ipRanges: ['203.0.113.0/24'], expiresInDays: days
        }, now);
        mint(1_000_000, 1);
        assert.throws(() => mint(1_000_000, 1), /Too many app passwords/);
        assert.doesNotThrow(() => mint(1_000_000 + 2 * 86_400_000, 1));
    } finally { store.close(); }
});

test('secret-scrub: quoted multi-word values, "is:" separators and bearer tokens', () => {
    const scrub = (s) => scrubText(s, {});
    assert.equal(scrub('password: "correct horse battery"'), 'password: "[redacted]"');
    assert.equal(scrub('password is: Abc123xyz'), 'password is: [redacted]');
    assert.equal(scrub('Authorization: Bearer abcdef1234567890'), 'Authorization: Bearer [redacted]');
    assert.equal(scrub('Authorization: Basic dXNlcjpwYXNzd29yZA=='), 'Authorization: Basic [redacted]');
    // Prose stays untouched.
    const prose = 'The bearer of this letter is a basic person';
    assert.equal(scrub(prose), prose);
});

test('config: bool() accepts "on"/"off", trims, and falls back to the default on junk', () => {
    const load = (env) => {
        const saved = {};
        for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
        delete require.cache[require.resolve('../../src/config')];
        const warn = console.warn;
        const warnings = [];
        console.warn = (...a) => warnings.push(a.join(' '));
        try {
            return { cfg: require('../../src/config'), warnings };
        } finally {
            console.warn = warn;
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
            delete require.cache[require.resolve('../../src/config')];
        }
    };
    assert.equal(load({ IMAP_TLS_REJECT_UNAUTHORIZED: ' off ' }).cfg.imap.rejectUnauthorized, false);
    assert.equal(load({ IMAP_TLS_REJECT_UNAUTHORIZED: 'on' }).cfg.imap.rejectUnauthorized, true);
    const junk = load({ IMAP_TLS_REJECT_UNAUTHORIZED: 'enabld' });
    assert.equal(junk.cfg.imap.rejectUnauthorized, true, 'a typo must not disable TLS verification');
    assert.ok(junk.warnings.some((w) => w.includes('enabld')));
});

test('request log: capability URLs are redacted', () => {
    assert.equal(redactUrl('/v1/public/ical/s3cr3t.ics'), '/v1/public/ical/[redacted]');
    assert.equal(redactUrl('/v1/webhook-inbox/tok123?x=1'), '/v1/webhook-inbox/[redacted]?x=1');
    assert.equal(
        redactUrl('/v1/webhook-staging/a@b.c/KEY/f.txt?expires=1&sig=zzz'),
        '/v1/webhook-staging/a@b.c/[redacted]/f.txt?expires=1&sig=[redacted]'
    );
    assert.equal(redactUrl('/v1/public/event/GRANT/edit'), '/v1/public/event/[redacted]/edit');
    assert.equal(redactUrl('/v1/messages/approve/TOKEN123'), '/v1/messages/approve/[redacted]');
    assert.equal(redactUrl('/v1/messages/deny/TOKEN123?x=1'), '/v1/messages/deny/[redacted]?x=1');
    assert.equal(redactUrl('/v1/mailboxes/INBOX/messages?limit=5'), '/v1/mailboxes/INBOX/messages?limit=5');
});

test('rate limit: a dual-stack IPv4 loopback peer matches the exemption', () => {
    assert.equal(isAllowed('::ffff:127.0.0.1', LOOPBACK_RULES), true);
    assert.equal(isAllowed('127.0.0.1', LOOPBACK_RULES), true);
    assert.equal(isAllowed('::1', LOOPBACK_RULES), true);
    assert.equal(isAllowed('::ffff:203.0.113.9', LOOPBACK_RULES), false);
});

test('telemetry: non-admins never see ownerless entries', () => {
    const anon = { user: null, ip: '1.2.3.4', message: 'boom' };
    assert.equal(visibleTo(anon, 'a@example.com'), null);
    assert.equal(visibleTo({ user: 'b@example.com' }, 'a@example.com'), null);
    const own = { user: 'A@example.com', message: 'mine' };
    assert.equal(visibleTo(own, 'a@example.com'), own);
});

async function buildSessionApp({ verifier, appPasswords = null }) {
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0 });
    const app = Fastify({ logger: false });
    app.addHook('onRequest', createAuthHook({ cache, imap: {}, appPasswords, verifier }));
    await app.register(sessionRoutes, { cache, sessionTtlMs: 60_000, appPasswords });
    app.addHook('onClose', async () => cache.close());
    return { app, cache };
}

test('session routes: an app password cannot create or revoke sessions', async () => {
    const store = createAppPasswordStore({ filePath: ':memory:', secretBox: createSecretBox({ envValue: KEY }) });
    let verifies = 0;
    const { app, cache } = await buildSessionApp({
        appPasswords: store,
        verifier: async () => { verifies++; return { valid: true }; }
    });
    try {
        const { token } = store.create({
            user: 'u@x.com', password: 'real-pw', label: 'x', ipRanges: ['127.0.0.1/32']
        });
        const live = cache.createSession('u@x.com', 'real-pw', cache.hashCreds('u@x.com', 'real-pw'));

        const bearer = { authorization: `Bearer ${token}` };
        const basic = { authorization: 'Basic ' + Buffer.from(`u@x.com:${token}`).toString('base64') };

        for (const headers of [bearer, basic]) {
            const del = await app.inject({ method: 'DELETE', url: '/v1/auth/session', headers });
            assert.equal(del.statusCode, 403);
        }
        const post = await app.inject({ method: 'POST', url: '/v1/auth/session', headers: basic });
        assert.equal(post.statusCode, 403);
        assert.equal(verifies, 0, 'the app-password token must never reach IMAP');

        assert.ok(cache.getSession(live.token), 'the owner\'s session must survive');
    } finally {
        await app.close();
        store.close();
    }
});

test('auth: repeated failed Basic logins from one IP are answered with 429 before IMAP', async () => {
    let verifies = 0;
    const cache = createCache({ filePath: ':memory:', ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0 });
    const hook = createAuthHook({
        cache, imap: {}, verifier: async () => { verifies++; return { valid: false }; }
    });
    const attempt = async (pass, ip = '198.51.100.1') => {
        const headers = {};
        const reply = { header(k, v) { headers[k] = v; } };
        const req = {
            method: 'GET', url: '/v1/x', ip, routeOptions: {}, log: { warn() {} },
            headers: { authorization: 'Basic ' + Buffer.from(`u@x.com:${pass}`).toString('base64') }
        };
        try { await hook(req, reply); return { status: 200 }; }
        catch (err) { return { status: err.statusCode, headers }; }
    };
    try {
        for (let i = 0; i < 30; i++) assert.equal((await attempt(`bad-${i}`)).status, 401);
        const blocked = await attempt('bad-next');
        assert.equal(blocked.status, 429);
        assert.ok(Number(blocked.headers['retry-after']) >= 1);
        assert.equal(verifies, 30);
        assert.equal((await attempt('bad-other-ip', '198.51.100.2')).status, 401, 'other IPs are unaffected');
    } finally {
        cache.close();
    }
});
