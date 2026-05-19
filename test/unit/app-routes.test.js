'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const appRoutes = require('../../src/routes/app');

function makeTempDistDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'imap-rest-app-test-'));
}

test('GET /v1/app/android/version.json returns parsed metadata', async () => {
    const distDir = makeTempDistDir();
    fs.writeFileSync(path.join(distDir, 'version.json'), JSON.stringify({
        version: '0.5.14',
        sha: 'abc1234',
        builtAt: '2026-05-02T14:30:00Z',
        minHostVersion: '0.5.14'
    }));

    try {
        const app = Fastify();
        await app.register(sensible);
        await app.register(appRoutes, { distDir });

        const res = await app.inject({ method: 'GET', url: '/v1/app/android/version.json' });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.version, '0.5.14');
        assert.equal(body.sha, 'abc1234');
        assert.equal(body.minHostVersion, '0.5.14');
    } finally {
        fs.rmSync(distDir, { recursive: true, force: true });
    }
});

test('GET /v1/app/android/version.json returns 404 when version.json missing', async () => {
    const distDir = makeTempDistDir();

    try {
        const app = Fastify();
        await app.register(sensible);
        await app.register(appRoutes, { distDir });

        const res = await app.inject({ method: 'GET', url: '/v1/app/android/version.json' });
        assert.equal(res.statusCode, 404);
        assert.match(res.json().message, /not built/i);
    } finally {
        fs.rmSync(distDir, { recursive: true, force: true });
    }
});

test('GET /v1/app/android.apk streams the file with correct headers', async () => {
    const distDir = makeTempDistDir();
    const apkBytes = Buffer.from('PK\x03\x04fakeapk');
    fs.writeFileSync(path.join(distDir, 'imap-rest.apk'), apkBytes);
    fs.writeFileSync(path.join(distDir, 'version.json'), JSON.stringify({
        version: '0.5.14', sha: 'abc1234', builtAt: '2026-05-02T14:30:00Z', minHostVersion: '0.5.14'
    }));

    try {
        const app = Fastify();
        await app.register(sensible);
        await app.register(appRoutes, { distDir });

        const res = await app.inject({ method: 'GET', url: '/v1/app/android.apk' });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'application/vnd.android.package-archive');
        assert.match(res.headers['content-disposition'], /imap-rest-0\.5\.14\.apk/);
        assert.equal(res.rawPayload.length, apkBytes.length);
        assert.deepEqual(Buffer.from(res.rawPayload), apkBytes);
    } finally {
        fs.rmSync(distDir, { recursive: true, force: true });
    }
});

test('GET /v1/app/android.apk returns 404 when APK missing', async () => {
    const distDir = makeTempDistDir();

    try {
        const app = Fastify();
        await app.register(sensible);
        await app.register(appRoutes, { distDir });

        const res = await app.inject({ method: 'GET', url: '/v1/app/android.apk' });
        assert.equal(res.statusCode, 404);
    } finally {
        fs.rmSync(distDir, { recursive: true, force: true });
    }
});
