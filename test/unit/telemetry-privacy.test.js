'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Fastify = require('fastify');
const telemetryRoutes = require('../../src/routes/telemetry');

test('telemetry strips URL query/fragment data and scrubs credentials before storage', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-privacy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logPath = path.join(dir, 'error.log');
    const app = Fastify({ logger: false });
    await app.register(telemetryRoutes, { logPath });
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/telemetry/error',
            headers: { 'content-type': 'application/json' },
            payload: {
                type: 'api',
                message: 'provider failed: apiKey: sk-live-telemetry-secret',
                status: 500,
                url: 'https://mail.example/v1/mailboxes/INBOX/messages?search=private%20phrase&apiKey=sk-url-secret',
                detail: 'GET /v1/mailboxes/INBOX/messages?search=private%20phrase&token=secret-value\ncalendar feed failed at https://mail.example/v1/public/ical/calendar-path-secret.ics',
                page: 'https://mail.example/webmail/#wm_token=fragment-secret',
                stack: 'Error: password: hunter2\nAuthorization: Bearer abcdefghijklmnop123456\n    at login',
                userAgent: 'test-browser'
            }
        });
        assert.equal(res.statusCode, 204);
        const raw = fs.readFileSync(logPath, 'utf8');
        const entry = JSON.parse(raw.trim());
        assert.equal(entry.url, 'https://mail.example/v1/mailboxes/INBOX/messages');
        assert.equal(entry.page, 'https://mail.example/webmail/');
        assert.match(entry.message, /\[redacted\]/);
        assert.match(entry.stack, /\[REDACTED\]|\[redacted\]/);
        assert.match(entry.detail, /\/v1\/public\/ical\/\[redacted\]/);
        assert.ok(entry.detail.startsWith('GET /v1/mailboxes/INBOX/messages\n'));
        assert.ok(!entry.detail.includes('?'));
        assert.match(entry.stack, /\[redacted\]/);
        for (const secret of [
            'sk-live-telemetry-secret',
            'sk-url-secret',
            'fragment-secret',
            'private phrase',
            'secret-value',
            'hunter2',
            'abcdefghijklmnop123456',
            'calendar-path-secret'
        ]) {
            assert.ok(!raw.includes(secret), `${secret} must not be stored`);
        }
    } finally {
        await app.close();
    }
});
