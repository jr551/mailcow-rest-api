'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWebhookInboxStore, looksLikeWebhookToken } = require('../../src/webhook-inbox-store');
const { createSecretBox } = require('../../src/secret-box');

const KEY = 'a'.repeat(64);

function makeStore(opts = {}) {
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    return createWebhookInboxStore({ filePath: ':memory:', secretBox, ...opts });
}

const mint = (s, over = {}) => s.create({
    user: 'user@example.com',
    password: 'real-mailbox-password',
    label: 'Uptime monitor',
    ...over
});

test('webhook inbox: a minted token verifies and returns the mailbox password', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        assert.ok(looksLikeWebhookToken(created.token));

        const ok = s.verify({ token: created.token });
        assert.equal(ok.ok, true);
        assert.equal(ok.user, 'user@example.com');
        assert.equal(ok.password, 'real-mailbox-password');
    } finally { s.close(); }
});

test('webhook inbox: the token is never stored and never listed', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        const listed = s.list({ user: 'user@example.com' });
        assert.equal(listed.length, 1);
        assert.equal(listed[0].token, undefined);
        assert.equal(listed[0].label, 'Uptime monitor');
    } finally { s.close(); }
});

test('webhook inbox: a revoked token is refused', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        s.revoke({ id: created.id, user: 'user@example.com' });
        assert.equal(s.verify({ token: created.token }).ok, false);
    } finally { s.close(); }
});

test('webhook inbox: a wrong secret is refused', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        const bad = created.token.slice(0, -4) + 'AAAA';
        assert.equal(s.verify({ token: bad }).ok, false);
    } finally { s.close(); }
});

test('webhook inbox: per-user limit is enforced', () => {
    const s = makeStore({ maxPerUser: 1 });
    try {
        mint(s);
        assert.throws(() => mint(s, { label: 'second' }), /limit 1/);
    } finally { s.close(); }
});

test('webhook inbox: refreshSecrets re-keys stored passwords', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        s.refreshSecrets({ user: 'user@example.com', password: 'new-password' });
        const ok = s.verify({ token: created.token });
        assert.equal(ok.ok, true);
        assert.equal(ok.password, 'new-password');
    } finally { s.close(); }
});
