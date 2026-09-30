'use strict';

// Regression test: the takeover worker's ONLY exit to a message is a self-POST
// to /v1/messages/send, which must land in the real approval gate. The URL was
// hardcoded `http://127.0.0.1:${config.port}` — on deployments that terminate
// TLS in-process (TLS_CERT/TLS_KEY set) the listener is HTTPS, so every draft
// died before it could reach the gate. And simply flipping the scheme is not
// enough: the loopback listener's certificate is issued for the public name
// (typically self-signed), so a plain fetch fails verification with
// DEPTH_ZERO_SELF_SIGNED_CERT (demonstrated against a real self-signed https
// server). The self-POST is the process talking to itself over loopback — it
// pins verification off for that one request via a dedicated dispatcher.
//
// Before the fix `createTakeoverDeliver` did not exist as a seam: the URL was
// built inline in build() with the hardcoded scheme.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTakeoverDeliver } = require('../../src/server');

function stubFetch() {
    const calls = [];
    return {
        calls,
        fn: async (url, opts) => {
            calls.push({ url, opts });
            return {
                ok: true,
                json: async () => ({ sent: true }),
                text: async () => ''
            };
        }
    };
}

const baseConfig = (tls) => ({ port: 3001, tls });

test('takeover deliver: HTTPS listener → https:// self-POST that skips cert verification', async () => {
    const { calls, fn } = stubFetch();
    const deliver = createTakeoverDeliver({
        config: baseConfig({ cert: 'PEM', key: 'PEM' }),
        fetchImpl: fn
    });

    await deliver({ user: 'u@x.com', pass: 'pw', message: { to: ['a@b.c'], subject: 's' } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://127.0.0.1:3001/v1/messages/send');
    assert.ok(calls[0].opts.dispatcher,
        'the loopback self-POST must not fail TLS verification against the public-name cert');
    // The request still enters the approval gate via Basic auth.
    assert.match(calls[0].opts.headers.authorization, /^Basic /);
});

test('takeover deliver: plain HTTP listener → http:// self-POST', async () => {
    const { calls, fn } = stubFetch();
    const deliver = createTakeoverDeliver({
        config: baseConfig({ cert: '', key: '' }),
        fetchImpl: fn
    });

    await deliver({ user: 'u@x.com', pass: 'pw', message: { to: ['a@b.c'], subject: 's' } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:3001/v1/messages/send');
    assert.ok(!calls[0].opts.dispatcher, 'nothing to relax on a plain-HTTP listener');
});

test('takeover deliver: a refused send still throws with the status', async () => {
    const deliver = createTakeoverDeliver({
        config: baseConfig({ cert: '', key: '' }),
        fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'nope' })
    });
    await assert.rejects(
        () => deliver({ user: 'u@x.com', pass: 'pw', message: {} }),
        /refused \(403\)/
    );
});
