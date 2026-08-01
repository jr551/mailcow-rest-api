'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Authenticated encryption for the mailbox passwords we have to keep.
//
// The server holds live IMAP credentials for two reasons: sessions renew a
// bearer token without re-prompting, and the open-tracking pixel sends a
// notification as the original sender long after the request that created
// it. Both stored them as plaintext columns, so anyone reading the sqlite
// files — a backup, a volume snapshot, a stray `docker cp` — walked away
// with working passwords for every active user.
//
// AES-256-GCM, so a tampered ciphertext fails to decrypt rather than
// decrypting to something attacker-chosen.
//
// This is not a defence against an attacker who already has the whole
// host: if the key lives in the environment of the process that reads the
// database, someone with both has everything. It is a defence against the
// far more common case where only the data escapes.

const PREFIX = 'v1';
const KEY_FILE = 'credential-key';

function deriveKey(secret) {
    // A 32-byte hex or base64 secret is used as-is; anything else is
    // stretched, so a human-typed passphrase still yields a full-length key.
    if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex');
    const b64 = Buffer.from(secret, 'base64');
    if (b64.length === 32) return b64;
    return crypto.scryptSync(secret, 'mailcow-rest-api/credential-key', 32);
}

// Load the key from the environment, falling back to a generated file
// beside the databases.
//
// The file fallback exists so upgrading doesn't require the operator to do
// anything first — but it is strictly weaker, because a backup that
// captures the data directory captures the key with it. We say so loudly
// once at startup rather than letting it pass for real protection.
function loadKey({ envValue, dataDir, logger }) {
    if (envValue) return { key: deriveKey(envValue), source: 'env' };

    const keyPath = path.join(dataDir, KEY_FILE);
    try {
        if (fs.existsSync(keyPath)) {
            const raw = fs.readFileSync(keyPath, 'utf8').trim();
            if (raw) return { key: deriveKey(raw), source: 'file' };
        }
        fs.mkdirSync(dataDir, { recursive: true });
        const generated = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(keyPath, generated + '\n', { mode: 0o600 });
        logger?.warn(
            { keyPath },
            'generated a credential encryption key on disk — set CREDENTIAL_ENCRYPTION_KEY ' +
            'to this value in the environment so backups of the data volume do not carry the key with them'
        );
        return { key: deriveKey(generated), source: 'file' };
    } catch (err) {
        logger?.error({ err: err.message }, 'could not establish a credential encryption key');
        return { key: null, source: 'none' };
    }
}

function createSecretBox({ envValue, dataDir, logger } = {}) {
    const { key, source } = loadKey({ envValue, dataDir: dataDir || '.', logger });
    const enabled = !!key;

    function encrypt(plaintext) {
        if (!enabled || plaintext === null || plaintext === undefined) return plaintext;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
    }

    // Values written before this existed are bare plaintext with no
    // prefix. Return them unchanged so an upgrade doesn't invalidate every
    // live session; they get replaced with ciphertext on the next write.
    function decrypt(stored) {
        if (typeof stored !== 'string' || !stored.startsWith(`${PREFIX}:`)) return stored;
        if (!enabled) return null;
        const parts = stored.split(':');
        if (parts.length !== 4) return null;
        try {
            const iv = Buffer.from(parts[1], 'base64');
            const tag = Buffer.from(parts[2], 'base64');
            const ct = Buffer.from(parts[3], 'base64');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
        } catch {
            // Wrong key or tampered payload. Returning null makes the
            // caller treat the session as invalid, which is the safe end.
            return null;
        }
    }

    function isEncrypted(stored) {
        return typeof stored === 'string' && stored.startsWith(`${PREFIX}:`);
    }

    return { encrypt, decrypt, isEncrypted, enabled, source };
}

module.exports = { createSecretBox, deriveKey };
