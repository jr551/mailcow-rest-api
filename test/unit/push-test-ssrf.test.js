'use strict';

// Regression test: POST /v1/push/test must send through a DNS-pinned agent,
// exactly like the background push-sender does. The endpoint is validated at
// SUBSCRIBE time, but a hostname the attacker controls can be re-pointed at
// an internal address afterwards (DNS rebinding) — so every SEND has to
// re-check and pin the address it checked. The test route used to call
// webpush.sendNotification with no agent at all, defeating the subscribe-time
// SSRF check and POSTing to whatever the name resolved to at send time.

// VAPID keys must be in env before src/config is required (it snapshots env).
const webpush = require('web-push');
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = publicKey;
process.env.VAPID_PRIVATE_KEY = privateKey;

const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const pushRoutes = require('../../src/routes/push');

function stubSendNotification() {
    const original = webpush.sendNotification;
    const calls = [];
    webpush.sendNotification = async (sub, payload, options) => {
        calls.push({ sub, payload, options });
        return { statusCode: 201 };
    };
    return { calls, restore() { webpush.sendNotification = original; } };
}

test('push test-send: a rebound endpoint must be blocked, not POSTed to', async (t) => {
    const recorder = stubSendNotification();
    t.after(recorder.restore);

    // Start with a healthy public answer at subscribe time…
    let answers = [{ address: '93.184.216.34', family: 4 }];
    const lookup = async (_host, _opts, cb) => {
        if (typeof cb === 'function') return cb(null, answers);
        return answers;
    };

    const subs = [];
    const pushStore = {
        upsert({ user, subscription }) { subs.push({ user, ...subscription }); },
        listForUser({ user }) {
            return subs.filter((s) => s.user === user).map((s) => ({
                endpoint: s.endpoint,
                p256dh: s.keys.p256dh,
                auth_key: s.keys.auth
            }));
        },
        delete() { return 1; }
    };

    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
        const auth = req.headers.authorization || '';
        if (auth.startsWith('Basic ')) {
            const decoded = Buffer.from(auth.slice(6), 'base64').toString();
            const idx = decoded.indexOf(':');
            req.creds = { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
        }
    });
    await app.register(pushRoutes, { pushStore, lookup });
    t.after(() => app.close());

    const sub = {
        endpoint: 'https://rebound.example/push/abc',
        keys: { p256dh: 'A'.repeat(65), auth: 'B'.repeat(16) }
    };
    const created = await app.inject({
        method: 'POST',
        url: '/v1/push/subscribe',
        headers: { authorization: `Basic ${Buffer.from('u@x.com:pw').toString('base64')}` },
        payload: { subscription: sub }
    });
    assert.equal(created.statusCode, 201, created.body);

    // …then the name is rebound to a loopback address after the check.
    answers = [{ address: '127.0.0.1', family: 4 }];

    const res = await app.inject({
        method: 'POST',
        url: '/v1/push/test',
        headers: { authorization: `Basic ${Buffer.from('u@x.com:pw').toString('base64')}` }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.sent, 0, 'nothing may be delivered to the rebound address');
    assert.equal(recorder.calls.length, 0, 'no POST may go out to an endpoint that now resolves privately');
    assert.equal(body.endpoints.length, 1);
    assert.equal(body.endpoints[0].ok, false);
    assert.match(body.endpoints[0].error, /blocked|private/i);
});
