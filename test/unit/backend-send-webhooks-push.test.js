'use strict';

// Regression tests for the send pipeline, webhook and push hardening pass:
// deny is POST-only, approval links are escaped, held sends are bounded,
// a failure after SMTP acceptance does not reject the send, push sends time
// out and are bounded per user, webhook inbox ingest is capped per token and
// Message-IDs are unique, staged messages are swept on a timer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');

const smtpClientPath = require.resolve('../../src/smtp-client');
const sendRoutesPath = require.resolve('../../src/routes/send.js');

const TEST_USER = 'owner@example.com';
const TEST_PASS = 'mailbox-password';
const basic = () => `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString('base64')}`;

function installSendRecorder() {
    const smtpClient = require(smtpClientPath);
    const original = smtpClient.sendMessage;
    const sent = [];
    smtpClient.sendMessage = async (msg) => {
        sent.push(msg);
        return { sent: true, messageId: `<captured-${sent.length}@example.com>`, raw: 'RAW' };
    };
    delete require.cache[sendRoutesPath];
    return {
        sent,
        restore() {
            smtpClient.sendMessage = original;
            delete require.cache[sendRoutesPath];
        }
    };
}

async function buildSendApp(getPublicBaseUrl = () => 'https://mail.example.com') {
    const sendRoutes = require(sendRoutesPath);
    const app = Fastify();
    await app.register(sensible);
    app.addHook('onRequest', async (req) => {
        const auth = req.headers.authorization || '';
        if (auth.startsWith('Basic ')) {
            const decoded = Buffer.from(auth.slice(6), 'base64').toString();
            const idx = decoded.indexOf(':');
            req.creds = { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
        }
    });
    await app.register(sendRoutes, {
        db: { getSendFromAddresses: async () => ({ addresses: [TEST_USER], wildcardDomains: [] }) },
        smtp: { host: '127.0.0.1', port: 1, secure: false },
        pool: null,
        trackingStore: null,
        getPublicBaseUrl,
        imapCache: null
    });
    return app;
}

const hold = (app, headers = {}) => app.inject({
    method: 'POST',
    url: '/v1/messages/send',
    headers: { authorization: basic(), ...headers },
    payload: { to: ['c@example.com'], subject: 's', text: 't' }
});

function approvalToken(recorder) {
    const mails = recorder.sent.filter((m) => /^Approve sending:/.test(m.subject || ''));
    return (mails[mails.length - 1].text.match(/\/deny\/([a-f0-9]{64})/) || [])[1];
}

test('deny: GET only renders a confirm page; POST removes the pending send', async (t) => {
    const recorder = installSendRecorder();
    const app = await buildSendApp();
    t.after(async () => { await app.close(); recorder.restore(); });

    assert.equal((await hold(app)).statusCode, 200);
    const token = approvalToken(recorder);
    assert.ok(token);

    const scan = await app.inject({ method: 'GET', url: `/v1/messages/deny/${token}` });
    assert.equal(scan.statusCode, 200);
    assert.match(scan.body, /<form method="POST"/);

    // A scanner's GET must not have cancelled the draft.
    const view = await app.inject({ method: 'GET', url: `/v1/messages/approve/${token}` });
    assert.equal(view.statusCode, 200, 'the pending send survives a GET on the deny link');

    const denied = await app.inject({ method: 'POST', url: `/v1/messages/deny/${token}` });
    assert.equal(denied.statusCode, 200);
    assert.match(denied.body, /Send denied/);

    const again = await app.inject({ method: 'POST', url: `/v1/messages/deny/${token}` });
    assert.equal(again.statusCode, 404);
    const gone = await app.inject({ method: 'GET', url: `/v1/messages/approve/${token}` });
    assert.equal(gone.statusCode, 404);
});

test('approval email: links built from request headers are escaped in the href', async (t) => {
    const recorder = installSendRecorder();
    const app = await buildSendApp(() => 'https://evil.example"><b id="x');
    t.after(async () => { await app.close(); recorder.restore(); });

    assert.equal((await hold(app)).statusCode, 200);
    const mail = recorder.sent.find((m) => /^Approve sending:/.test(m.subject));
    assert.ok(!mail.html.includes('"><b id="x'), 'a quote in the base URL must not break out of the href');
    assert.match(mail.html, /href="https:\/\/evil\.example&quot;&gt;&lt;b id=&quot;x\/v1\/messages\/approve\//);
});

test('pending sends: a user cannot hold more than the per-user limit', async (t) => {
    const recorder = installSendRecorder();
    const app = await buildSendApp();
    t.after(async () => { await app.close(); recorder.restore(); });

    for (let i = 0; i < 25; i++) {
        const res = await hold(app);
        assert.equal(res.statusCode, 200, `send ${i}: ${res.body}`);
    }
    const over = await hold(app);
    assert.equal(over.statusCode, 429);
    assert.equal(recorder.sent.length, 25, 'no approval email goes out for a refused send');
});

test('smtp-client: a failure building the Sent copy does not reject an accepted send', async () => {
    const nodemailer = require('nodemailer');
    const MailComposer = require('nodemailer/lib/mail-composer');
    const origCreate = nodemailer.createTransport;
    const origCompile = MailComposer.prototype.compile;
    nodemailer.createTransport = () => ({
        async sendMail() { return { messageId: '<accepted@example.com>' }; },
        close() {}
    });
    MailComposer.prototype.compile = () => { throw new Error('out of memory'); };
    try {
        const { sendMessage } = require(smtpClientPath);
        const result = await sendMessage({
            smtpConfig: { host: 'h', port: 25, secure: false, rejectUnauthorized: true },
            user: TEST_USER,
            pass: TEST_PASS,
            from: TEST_USER,
            to: ['c@example.com'],
            subject: 's',
            text: 't'
        });
        assert.equal(result.sent, true);
        assert.equal(result.messageId, '<accepted@example.com>');
        assert.equal(result.raw, null);
    } finally {
        nodemailer.createTransport = origCreate;
        MailComposer.prototype.compile = origCompile;
    }
});

test('push store: subscriptions per user are capped, re-subscribing an existing endpoint is not', () => {
    const { createPushStore } = require('../../src/push-store');
    const store = createPushStore({ filePath: ':memory:' });
    const sub = (n) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p'.repeat(16), auth: 'a'.repeat(8) } });
    for (let i = 0; i < 20; i++) store.upsert({ user: 'a@b.test', subscription: sub(i) });
    assert.throws(() => store.upsert({ user: 'a@b.test', subscription: sub(99) }), /too many push subscriptions/);
    store.upsert({ user: 'a@b.test', subscription: sub(3) });
    store.upsert({ user: 'c@d.test', subscription: sub(100) });
    assert.equal(store.count(), 21);
    store.close();
});

test('push sender: every send is given a timeout', async () => {
    const webpush = require('web-push');
    const origSend = webpush.sendNotification;
    const { sendPush } = require('../../src/push-sender');
    let seen;
    webpush.sendNotification = async (_sub, _payload, opts) => { seen = opts; throw new Error('Socket timeout'); };
    // A literal public IP endpoint keeps the SSRF guard offline.
    try {
        const result = await sendPush({ endpoint: 'https://93.184.216.34/push', p256dh: 'k', auth_key: 'a' }, '{}');
        assert.equal(result.ok, false);
        assert.equal(result.error, 'Socket timeout');
        assert.ok(seen.timeout > 0 && seen.timeout <= 30_000);
    } finally {
        webpush.sendNotification = origSend;
    }
});

test('webhook inbox: Message-IDs differ within the same millisecond and ingest is capped per token', async (t) => {
    const webhookInboxRoutes = require('../../src/routes/webhook-inbox');
    const appended = [];
    const client = {
        authenticated: true,
        usable: true,
        async getMailboxLock() { return { release() {} }; },
        async append(_box, message) { appended.push(message.toString('utf8')); return { uid: 1 }; }
    };
    const pool = { async acquire() { return client; }, release() {}, discard() {} };
    const store = {
        maxPerUser: 5,
        list: () => [],
        verify: ({ token }) => (token === 'good'
            ? { ok: true, id: 'ib1', label: 'M', user: 't@x.com', password: 'pw' }
            : { ok: false, reason: 'unknown' })
    };
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, _req, reply) => {
        const status = err.statusCode || 500;
        reply.code(status).send(err.problem || { status, detail: err.message });
    });
    app.addHook('onRequest', async (req) => { req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' }; });
    await app.register(webhookInboxRoutes, { store, pool, getPublicBaseUrl: () => 'https://m.example' });
    t.after(() => app.close());

    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
        for (let i = 0; i < 2; i++) {
            const res = await app.inject({ method: 'POST', url: '/v1/webhook-inbox/good', payload: 'hello', headers: { 'content-type': 'text/plain' } });
            assert.equal(res.statusCode, 202);
        }
        const ids = appended.map((m) => m.match(/^Message-ID: (.+)$/m)[1]);
        assert.notEqual(ids[0], ids[1]);

        for (let i = 2; i < 120; i++) {
            const res = await app.inject({ method: 'POST', url: '/v1/webhook-inbox/good', payload: 'x', headers: { 'content-type': 'text/plain' } });
            assert.equal(res.statusCode, 202, `delivery ${i}`);
        }
        const limited = await app.inject({ method: 'POST', url: '/v1/webhook-inbox/good', payload: 'x', headers: { 'content-type': 'text/plain' } });
        assert.equal(limited.statusCode, 429);
        assert.equal(limited.headers['retry-after'], '60');
        assert.equal(appended.length, 120);
    } finally {
        Date.now = realNow;
    }
});

test('webhook staging: expired staged messages are swept without another stageMessage', async (t) => {
    const { createWebhookStager } = require('../../src/webhook-staging');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-sweep-'));
    const stager = createWebhookStager({
        config: { webhooks: { stagingDir: root, stagingTtlMs: 1000, stagingBaseUrl: 'https://m.example' } },
        logger: null
    });
    t.after(() => { stager.close(); fs.rmSync(root, { recursive: true, force: true }); });

    const { guid } = await stager.stageMessage({ address: 'a@b.c' }, 1, 1, Buffer.from('mail'));
    const dir = path.join(root, 'messages', guid);
    assert.ok(fs.existsSync(dir));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(dir, old, old);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(fs.existsSync(dir), false, 'the staged .eml must not outlive its TTL');
});
