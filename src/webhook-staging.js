'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function safeSegment(value) {
    return String(value).replace(/[^A-Za-z0-9._@+-]/g, '_').replace(/^\.+/, '_').slice(0, 180) || '_';
}

function createWebhookStager({ config, logger }) {
    const root = config.webhooks.stagingDir;
    const ttlMs = config.webhooks.stagingTtlMs;
    const baseUrl = String(config.webhooks.stagingBaseUrl || '').replace(/\/+$/, '');

    function secretFor(account) {
        return config.webhooks.stagingSecret || account.secret || '';
    }

    function keyFor(account, uidvalidity, uid) {
        return crypto.createHash('sha256')
            .update(`${account.address}\0${uidvalidity}\0${uid}`)
            .digest('hex').slice(0, 40);
    }

    function sign(account, key, file, expires) {
        const secret = secretFor(account);
        if (!secret) throw new Error('webhook staging secret is not configured');
        return crypto.createHmac('sha256', secret)
            .update(`${account.address}\n${key}\n${file}\n${expires}`)
            .digest('hex');
    }

    function url(account, key, file) {
        const expires = Date.now() + ttlMs;
        const sig = sign(account, key, file, expires);
        const address = encodeURIComponent(account.address);
        const name = encodeURIComponent(file);
        return `${baseUrl}/v1/webhook-staging/${address}/${key}/${name}?expires=${expires}&sig=${sig}`;
    }

    function dirFor(account, key) {
        return path.join(root, safeSegment(account.address), safeSegment(key));
    }

    async function writeFiles(account, key, files) {
        const dir = dirFor(account, key);
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        for (const [name, data] of Object.entries(files)) {
            const safe = name.split('/').map(safeSegment).join('/');
            const target = path.join(dir, safe);
            const parent = path.dirname(target);
            if (!target.startsWith(dir + path.sep)) throw new Error(`unsafe staging path: ${name}`);
            await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
            await fsp.writeFile(target, data, { mode: 0o600 });
        }
        return dir;
    }

    async function cleanup() {
        let entries = [];
        try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
        const cutoff = Date.now() - ttlMs;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(root, entry.name);
            try {
                const stat = await fsp.stat(dir);
                if (stat.mtimeMs < cutoff) await fsp.rm(dir, { recursive: true, force: true });
            } catch (err) {
                logger?.warn({ err: err.message, dir }, 'webhook staging cleanup failed');
            }
        }
    }

    async function stage(account, uidvalidity, uid, files) {
        const key = keyFor(account, uidvalidity, uid);
        await cleanup();
        const dir = await writeFiles(account, key, files);
        return { key, dir, url: (file) => url(account, key, file) };
    }

    async function write(account, key, files) {
        return writeFiles(account, key, files);
    }

    async function resolve(account, key, file, expires, signature) {
        if (!Number.isFinite(expires) || expires < Date.now()) {
            const err = new Error('staged webhook payload link has expired');
            err.statusCode = 410;
            throw err;
        }
        const expected = sign(account, key, file, expires);
        const a = Buffer.from(String(signature || ''));
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            const err = new Error('invalid staged webhook payload signature');
            err.statusCode = 404;
            throw err;
        }
        const safeFile = safeSegment(file);
        const dir = dirFor(account, key);
        const target = path.join(dir, safeFile);
        if (!target.startsWith(dir + path.sep)) {
            const err = new Error('invalid staged webhook payload path');
            err.statusCode = 404;
            throw err;
        }
        const stat = await fsp.stat(target);
        if (!stat.isFile()) {
            const err = new Error('staged webhook payload not found');
            err.statusCode = 404;
            throw err;
        }
        return { path: target, size: stat.size };
    }

    function messageDir(guid) {
        return path.join(root, 'messages', safeSegment(guid));
    }

    function messageUrl(guid) {
        return `${baseUrl}/v1/webhook-message/${encodeURIComponent(guid)}`;
    }

    async function cleanupMessages() {
        const dir = path.join(root, 'messages');
        let entries = [];
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        const cutoff = Date.now() - ttlMs;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const target = path.join(dir, entry.name);
            try {
                const stat = await fsp.stat(target);
                if (stat.mtimeMs < cutoff) await fsp.rm(target, { recursive: true, force: true });
            } catch (err) {
                logger?.warn({ err: err.message, target }, 'webhook message cleanup failed');
            }
        }
    }

    async function stageMessage(account, uidvalidity, uid, source) {
        const guid = crypto.randomBytes(32).toString('hex');
        void account; void uidvalidity; void uid;
        const dir = messageDir(guid);
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        await fsp.writeFile(path.join(dir, 'message.eml'), source, { mode: 0o600 });
        await cleanupMessages();
        return { guid, url: messageUrl(guid), expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    }

    async function resolveMessage(guid) {
        if (!/^[a-f0-9]{64}$/.test(String(guid || ''))) {
            const err = new Error('message link not found');
            err.statusCode = 404;
            throw err;
        }
        const dir = messageDir(guid);
        const file = path.join(dir, 'message.eml');
        let stat;
        try { stat = await fsp.stat(file); } catch {
            const err = new Error('message link not found');
            err.statusCode = 404;
            throw err;
        }
        if (!stat.isFile() || stat.mtimeMs + ttlMs < Date.now()) {
            const err = new Error('message link has expired');
            err.statusCode = 410;
            throw err;
        }
        return { path: file, size: stat.size };
    }

    return { stage, write, url, resolve, stageMessage, resolveMessage, root };
}

module.exports = { createWebhookStager };
