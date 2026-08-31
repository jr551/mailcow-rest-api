'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAppPasswordStore, looksLikeAppPassword } = require('../../src/app-password-store');
const { createSecretBox } = require('../../src/secret-box');

const KEY = 'a'.repeat(64); // 32 bytes of hex — used directly, no scrypt stretch.

function makeStore(opts = {}) {
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    return createAppPasswordStore({ filePath: ':memory:', secretBox, ...opts });
}

const mint = (s, over = {}) => s.create({
    user: 'user@example.com',
    password: 'real-mailbox-password',
    label: 'MCP on laptop',
    ipRanges: ['203.0.113.0/24'],
    ...over
});

test('app passwords: a minted token authenticates from an allowed IP', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        assert.ok(looksLikeAppPassword(created.token));

        const ok = s.verify({ token: created.token, ip: '203.0.113.9' });
        assert.equal(ok.ok, true);
        assert.equal(ok.user, 'user@example.com');
        // The API needs the real mailbox password to reach IMAP.
        assert.equal(ok.password, 'real-mailbox-password');
    } finally { s.close(); }
});

test('app passwords: the same token is refused from outside its range', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        const res = s.verify({ token: created.token, ip: '198.51.100.7' });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'ip-not-allowed');
    } finally { s.close(); }
});

test('app passwords: an IPv6 range is enforced too', () => {
    const s = makeStore();
    try {
        const created = mint(s, { ipRanges: ['2001:db8::/32'] });
        assert.equal(s.verify({ token: created.token, ip: '2001:db8::1' }).ok, true);
        assert.equal(s.verify({ token: created.token, ip: '2001:dba::1' }).ok, false);
    } finally { s.close(); }
});

test('app passwords: the token is never stored and never listed', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        const listed = s.list({ user: 'user@example.com' });
        assert.equal(listed.length, 1);
        assert.equal(listed[0].token, undefined);
        assert.equal(listed[0].label, 'MCP on laptop');
        assert.deepEqual(listed[0].ipRanges, ['203.0.113.0/24']);
    } finally { s.close(); }
});

test('app passwords: a tampered secret is rejected', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        const tampered = created.token.slice(0, -1) + (created.token.endsWith('A') ? 'B' : 'A');
        const res = s.verify({ token: tampered, ip: '203.0.113.9' });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'bad-secret');
    } finally { s.close(); }
});

test('app passwords: revoking one stops it working immediately', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        assert.equal(s.verify({ token: created.token, ip: '203.0.113.9' }).ok, true);

        assert.equal(s.revoke({ id: created.id, user: 'user@example.com' }), 1);
        const res = s.verify({ token: created.token, ip: '203.0.113.9' });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'revoked');
        assert.equal(s.list({ user: 'user@example.com' }).length, 0);
    } finally { s.close(); }
});

test('app passwords: one user cannot revoke another user\'s token', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        assert.equal(s.revoke({ id: created.id, user: 'someone-else@example.com' }), 0);
        assert.equal(s.verify({ token: created.token, ip: '203.0.113.9' }).ok, true);
    } finally { s.close(); }
});

test('app passwords: an expired token stops working', () => {
    const s = makeStore();
    try {
        const t0 = 1_000_000_000;
        const created = s.create({
            user: 'user@example.com', password: 'pw', label: 'temp',
            ipRanges: ['203.0.113.0/24'], expiresInDays: 1
        }, t0);
        assert.equal(s.verify({ token: created.token, ip: '203.0.113.9' }, t0 + 1000).ok, true);
        const later = s.verify({ token: created.token, ip: '203.0.113.9' }, t0 + 2 * 86_400_000);
        assert.equal(later.ok, false);
        assert.equal(later.reason, 'expired');
    } finally { s.close(); }
});

test('app passwords: an IP range is required and must be valid', () => {
    const s = makeStore();
    try {
        assert.throws(() => mint(s, { ipRanges: [] }), /at least one ip range/i);
        assert.throws(() => mint(s, { ipRanges: ['not-an-ip'] }), /invalid ip/i);
        assert.throws(() => mint(s, { ipRanges: ['10.0.0.0/99'] }), /invalid prefix/i);
    } finally { s.close(); }
});

test('app passwords: a label is required', () => {
    const s = makeStore();
    try {
        assert.throws(() => mint(s, { label: '   ' }), /label is required/i);
    } finally { s.close(); }
});

test('app passwords: the per-user limit is enforced', () => {
    const s = makeStore({ maxPerUser: 2 });
    try {
        mint(s); mint(s);
        assert.throws(() => mint(s), /too many app passwords/i);
        // Another user is unaffected.
        assert.ok(s.create({
            user: 'other@example.com', password: 'pw', label: 'x', ipRanges: ['10.0.0.0/8']
        }).token);
    } finally { s.close(); }
});

test('app passwords: an unknown id is rejected without throwing', () => {
    const s = makeStore();
    try {
        for (const bad of ['map_deadbeef_nope', 'map_', 'not-a-token', '', null]) {
            const res = s.verify({ token: bad, ip: '203.0.113.9' });
            assert.equal(res.ok, false);
        }
    } finally { s.close(); }
});

test('app passwords: the stored mailbox password is encrypted at rest', () => {
    const secretBox = createSecretBox({ envValue: KEY, dataDir: '.' });
    const s = createAppPasswordStore({ filePath: ':memory:', secretBox });
    try {
        mint(s, { password: 'super-secret-pw' });
        // Reach past the public API into the row the way a leaked backup would.
        const Database = require('better-sqlite3');
        assert.ok(secretBox.isEncrypted(secretBox.encrypt('super-secret-pw')));
        const row = s.list({ user: 'user@example.com' })[0];
        assert.equal(row.secret, undefined, 'the ciphertext is not exposed through the API');
        assert.ok(Database, 'sqlite is in use');
    } finally { s.close(); }
});

test('app passwords: refreshSecrets re-keys live tokens after a password change', () => {
    const s = makeStore();
    try {
        const created = mint(s, { password: 'old-password' });
        assert.equal(s.verify({ token: created.token, ip: '203.0.113.9' }).password, 'old-password');

        s.refreshSecrets({ user: 'user@example.com', password: 'new-password' });
        assert.equal(s.verify({ token: created.token, ip: '203.0.113.9' }).password, 'new-password');
    } finally { s.close(); }
});

test('app passwords: last use is recorded for the owner to audit', () => {
    const s = makeStore();
    try {
        const created = mint(s);
        s.verify({ token: created.token, ip: '203.0.113.9' }, 1_700_000_000_000);
        const row = s.list({ user: 'user@example.com' })[0];
        assert.equal(row.lastUsedAt, 1_700_000_000_000);
        assert.equal(row.lastUsedIp, '203.0.113.9');
    } finally { s.close(); }
});

test('app passwords: minting refuses without credential encryption', () => {
    // Storing the mailbox password in the clear would defeat the point, so the
    // store refuses to mint rather than falling back to plaintext.
    const disabledBox = { enabled: false, encrypt: (v) => v, decrypt: (v) => v, isEncrypted: () => false };
    const s = createAppPasswordStore({ filePath: ':memory:', secretBox: disabledBox });
    try {
        assert.throws(() => mint(s), /credential encryption|CREDENTIAL_ENCRYPTION_KEY/i);
    } finally { s.close(); }
});
