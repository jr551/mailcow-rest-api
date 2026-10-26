'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');
const { createPendingSendStore } = require('../../src/pending-send-store');
const { createSecretBox } = require('../../src/secret-box');

const smtpClientPath = require.resolve('../../src/smtp-client');
const sendRoutesPath = require.resolve('../../src/routes/send.js');

const TEST_USER = 'owner@example.com';
const TEST_PASS = 'mailbox-password';

const FIXTURE = {
    user: TEST_USER,
    pass: TEST_PASS,
    from: TEST_USER,
    to: ['recipient@example.com'],
    subject: 'ROW-324 persistence test',
    text: 'test draft body'
};

function tempDb() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pending-send-')), 'pending.db');
}

function installSendRecorder() {
    const smtpClient = require(smtpClientPath);
    const original = smtpClient.sendMessage;
    const sent = [];
    smtpClient.sendMessage = async (msg) => {
        sent.push(msg);
        return { messageId: `<captured-${sent.length}@example.com>`, response: '250 captured', raw: 'RAW' };
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

async function buildApp() {
    const Fastify = require('fastify');
    const sensible = require('@fastify/sensible');
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
        db: {
            getSendFromAddresses: async () => ({ addresses: [TEST_USER], wildcardDomains: ['example.com'] })
        },
        smtp: { host: '127.0.0.1', port: 1, secure: false },
        pool: null,
        trackingStore: null,
        getPublicBaseUrl: () => 'https://mail.example.com',
        imapCache: null,
        approvalEmailBaseUrl: 'https://mail.example.com'
    });
    return app;
}

const basic = () => `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString('base64')}`;

test('sqlite: entry survives close and reopen on the same file', () => {
    const filePath = tempDb();
    const store1 = createPendingSendStore({ filePath });
    const token = store1.create(FIXTURE);
    store1.close();

    const store2 = createPendingSendStore({ filePath });
    const entry = store2.claim(token);
    assert.ok(entry);
    assert.equal(entry.subject, FIXTURE.subject);
    assert.equal(entry.text, FIXTURE.text);
    store2.close();
});

test('sqlite: pass is sealed at rest when secretBox is provided', () => {
    const filePath = tempDb();
    const secretBox = createSecretBox({ envValue: '0'.repeat(64) });
    const store = createPendingSendStore({ filePath, secretBox });
    const token = store.create(FIXTURE);
    const row = new Database(filePath).prepare('SELECT pass FROM pending_sends WHERE token = ?').get(token);
    assert.ok(row.pass.startsWith('v1:'));
    assert.equal(row.pass.includes(TEST_PASS), false);
    const entry = store.claim(token);
    assert.equal(entry.pass, TEST_PASS);
    store.close();
});

test('sqlite: expired claim re-keys and preserves draft payload', () => {
    const filePath = tempDb();
    const store = createPendingSendStore({ filePath, ttlMs: 60_000 });
    const token = store.create(FIXTURE);
    new Database(filePath).prepare('UPDATE pending_sends SET created_at = ? WHERE token = ?').run(1, token);
    let freshToken;
    assert.equal(store.claim(token), null);
    const row = new Database(filePath).prepare('SELECT token FROM pending_sends').get();
    assert.ok(row);
    freshToken = row.token;
    const entry = store.get(freshToken);
    assert.ok(entry);
    assert.equal(entry.subject, FIXTURE.subject);
    assert.equal(store.get(token), null);
    store.close();
});

test('sqlite: onExpired callback fires once per expired token', () => {
    const filePath = tempDb();
    const store = createPendingSendStore({ filePath, ttlMs: -1 });
    const token = store.create(FIXTURE);
    let calls = 0;
    let freshToken;
    assert.equal(store.get(token, (info) => {
        calls++;
        freshToken = info.freshToken;
    }), null);
    assert.equal(calls, 1);
    assert.ok(freshToken);
    calls = 0;
    assert.equal(store.get(token, () => { calls++; }), null);
    assert.equal(calls, 0);
    store.close();
});

test('sqlite: restore after claim allows retry on the same token', () => {
    const filePath = tempDb();
    const store = createPendingSendStore({ filePath });
    const token = store.create(FIXTURE);
    const entry = store.claim(token);
    assert.ok(entry);
    store.restore(token, entry);
    const again = store.claim(token);
    assert.ok(again);
    assert.equal(again.subject, FIXTURE.subject);
    store.close();
});

test('approve POST accepts form and empty body; unknown token returns HTML expired page', async (t) => {
    const recorder = installSendRecorder();
    const app = await buildApp();
    t.after(async () => { await app.close(); recorder.restore(); });

    const create = await app.inject({
        method: 'POST',
        url: '/v1/messages/send',
        headers: { authorization: basic() },
        payload: {
            to: ['recipient@example.com'],
            subject: 'ROW-324 approve POST test',
            text: 'draft for approval'
        }
    });
    assert.equal(create.statusCode, 200);
    for (const headers of [
        { 'content-type': 'application/x-www-form-urlencoded' },
        {}
    ]) {
        const held = await app.inject({
            method: 'POST',
            url: '/v1/messages/send',
            headers: { authorization: basic() },
            payload: {
                to: ['recipient@example.com'],
                subject: 'ROW-324 approve POST test',
                text: 'draft for approval'
            }
        });
        const { token } = held.json();
        const ok = await app.inject({
            method: 'POST',
            url: `/v1/messages/approve/${token}`,
            headers,
            payload: headers['content-type'] === 'application/x-www-form-urlencoded' ? 'submit=1' : undefined
        });
        assert.equal(ok.statusCode, 200, `approve POST failed for headers ${JSON.stringify(headers)}`);
        assert.match(ok.headers['content-type'] || '', /^text\/html/);
        assert.match(ok.body, /Email sent/);
    }

    const unknownCases = [
        { headers: {} },
        { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'x=1' },
        { headers: { 'content-type': 'application/json' }, payload: '{}' }
    ];
    for (const { headers, payload } of unknownCases) {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages/approve/not-a-real-token',
            headers,
            payload
        });
        assert.equal(res.statusCode, 404);
        assert.match(res.headers['content-type'] || '', /^text\/html/);
        assert.match(res.body, /Approval expired/);
        assert.equal((res.headers['content-type'] || '').includes('application/problem+json'), false);
    }
});
