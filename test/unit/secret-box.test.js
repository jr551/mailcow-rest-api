'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretBox } = require('../../src/secret-box');
const { createCache } = require('../../src/cache');

function tmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('round-trips a password and does not store it in the clear', () => {
    const box = createSecretBox({ envValue: 'a'.repeat(64) });
    const secret = 'hunter2-with-ünicode-and-:colons:';
    const sealed = box.encrypt(secret);

    assert.notEqual(sealed, secret);
    assert.ok(!sealed.includes(secret), 'ciphertext must not contain the plaintext');
    assert.ok(box.isEncrypted(sealed));
    assert.equal(box.decrypt(sealed), secret);
});

test('each encryption uses a fresh nonce', () => {
    const box = createSecretBox({ envValue: 'a'.repeat(64) });
    // Identical plaintexts must not produce identical ciphertexts, or the
    // database leaks which users share a password.
    assert.notEqual(box.encrypt('same'), box.encrypt('same'));
});

test('tampering is detected rather than silently decrypting', () => {
    const box = createSecretBox({ envValue: 'a'.repeat(64) });
    const sealed = box.encrypt('secret');
    const parts = sealed.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString('base64')].join(':');

    assert.equal(box.decrypt(tampered), null);
});

test('a different key cannot read the ciphertext', () => {
    const a = createSecretBox({ envValue: 'a'.repeat(64) });
    const b = createSecretBox({ envValue: 'b'.repeat(64) });
    assert.equal(b.decrypt(a.encrypt('secret')), null);
});

test('legacy plaintext rows still read back unchanged', () => {
    // Upgrading must not invalidate every live session: values written
    // before encryption existed have no prefix and are returned as-is.
    const box = createSecretBox({ envValue: 'a'.repeat(64) });
    assert.equal(box.decrypt('plain-old-password'), 'plain-old-password');
    assert.equal(box.isEncrypted('plain-old-password'), false);
});

test('a passphrase is stretched to a usable key', () => {
    const box = createSecretBox({ envValue: 'short passphrase' });
    assert.equal(box.enabled, true);
    assert.equal(box.decrypt(box.encrypt('x')), 'x');
});

test('generates and reuses an on-disk key when the env has none', () => {
    const { dir, cleanup } = tmpDir();
    try {
        const warnings = [];
        const first = createSecretBox({ dataDir: dir, logger: { warn: (_o, m) => warnings.push(m) } });
        assert.equal(first.enabled, true);
        assert.equal(first.source, 'file');
        // The operator must be told, because a backup of this directory
        // now contains the key next to the data it protects.
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /CREDENTIAL_ENCRYPTION_KEY/);

        const sealed = first.encrypt('secret');
        const second = createSecretBox({ dataDir: dir, logger: { warn() {} } });
        assert.equal(second.decrypt(sealed), 'secret', 'a restart must still read existing rows');
    } finally { cleanup(); }
});

test('sessions are stored encrypted and still usable', () => {
    const { dir, cleanup } = tmpDir();
    try {
        const box = createSecretBox({ envValue: 'a'.repeat(64) });
        const file = path.join(dir, 'cache.db');
        const cache = createCache({
            filePath: file,
            ttlValidMs: 60_000,
            ttlInvalidMs: 10_000,
            pruneIntervalMs: 0,
            secretBox: box
        });
        try {
            const { token } = cache.createSession('u@x.com', 'sup3rs3cret', 'hash1');

            // Round-trips for the app...
            const got = cache.getSession(token);
            assert.equal(got.pass, 'sup3rs3cret');
            assert.equal(cache.listActiveSessions()[0].pass, 'sup3rs3cret');

            // ...but the password is not sitting in the file.
            const bytes = fs.readFileSync(file);
            assert.equal(bytes.includes(Buffer.from('sup3rs3cret')), false,
                'plaintext password found in the database file');
        } finally { cache.close(); }
    } finally { cleanup(); }
});

test('a session sealed with a lost key is dropped, not handed to IMAP', () => {
    const { dir, cleanup } = tmpDir();
    try {
        const file = path.join(dir, 'cache.db');
        const good = createCache({
            filePath: file, ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0,
            secretBox: createSecretBox({ envValue: 'a'.repeat(64) })
        });
        const { token } = good.createSession('u@x.com', 'pw', 'h');
        good.close();

        const wrong = createCache({
            filePath: file, ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0,
            secretBox: createSecretBox({ envValue: 'b'.repeat(64) })
        });
        try {
            assert.equal(wrong.getSession(token), null);
        } finally { wrong.close(); }
    } finally { cleanup(); }
});

test('existing plaintext rows are sealed on startup, not left to expire', () => {
    const { dir, cleanup } = tmpDir();
    try {
        const file = path.join(dir, 'cache.db');
        // A pre-upgrade database: sessions written with no encryption.
        const before = createCache({
            filePath: file, ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0
        });
        const { token } = before.createSession('u@x.com', 'legacy-secret', 'h');
        before.close();

        const box = createSecretBox({ envValue: 'a'.repeat(64) });
        const after = createCache({
            filePath: file, ttlValidMs: 60_000, ttlInvalidMs: 10_000, pruneIntervalMs: 0,
            secretBox: box
        });
        try {
            assert.equal(after.migratePlaintextSessions(), 1);

            // Still usable afterwards — migrating must not sign anyone out.
            assert.equal(after.getSession(token).pass, 'legacy-secret');

            // And the plaintext is gone from the file, which is the point:
            // waiting for lazy rewrite would leave it readable for as long
            // as the session lived.
            after.close();
            assert.equal(fs.readFileSync(file).includes(Buffer.from('legacy-secret')), false);
        } catch (err) {
            try { after.close(); } catch { /* already closed */ }
            throw err;
        }
    } finally { cleanup(); }
});
