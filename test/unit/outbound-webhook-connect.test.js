'use strict';

// Regression: the outbound webhook forwarder used `new ImapFlow(...)` without
// ever requiring it, so every single connect threw
// `ReferenceError: ImapFlow is not defined`. The feature shipped in v0.22.0
// and has never delivered a message: the forwarder retried forever and logged
// a connect failure each time.
//
// The existing delivery tests could not catch this because they inject a fake
// IMAP (a `connectOverride`), which short-circuits the real constructor. This
// test deliberately does NOT inject one — it drives the genuine connect path
// and asserts the failure is a network error, not a ReferenceError. A missing
// import is a code error, not a connectivity problem, and the two are
// indistinguishable unless the test looks at the error type.

const test = require('node:test');
const assert = require('node:assert');
const { createOutboundWebhookForwarder } = require('../../src/outbound-webhook-forwarder');

function collectForwarder(overrides = {}) {
    const errors = [];
    const forwarder = createOutboundWebhookForwarder({
        // Port 1 on loopback is closed, so the real ImapFlow constructor runs
        // and fails at connect - which is exactly the path that was broken.
        config: {
            imap: { host: '127.0.0.1', port: 1, secure: false },
            outboundWebhooks: { pollIntervalMs: 10, maxAttempts: 1 }
        },
        store: {
            listAllLive: () => [{
                id: 'wh1',
                user: 'user@example.com',
                password: 'irrelevant-connection-fails-first',
                url: 'https://example.com/hook',
                mailbox: 'INBOX',
                includeAttachments: false,
                prepend: ''
            }]
        },
        logger: {
            info: () => {},
            debug: () => {},
            warn: (obj, msg) => errors.push(String((obj && obj.err) || msg || '')),
            error: (obj, msg) => errors.push(String((obj && obj.err) || msg || ''))
        },
        ...overrides
    });
    return { forwarder, errors };
}

test('outbound forwarder: the real connect path fails on the network, not on a missing import', async () => {
    const { forwarder, errors } = collectForwarder();
    forwarder.start();
    // Two ticks: enough for the interval to fire more than once so a success
    // would be stable, short enough to keep the test fast.
    await new Promise((resolve) => setTimeout(resolve, 250));
    forwarder.stop();

    assert.ok(errors.length > 0, 'expected the connect attempt to be reported');

    for (const err of errors) {
        assert.ok(
            !/ImapFlow is not defined/.test(err),
            `connect threw ReferenceError: ImapFlow is not defined - the imapflow import is missing again. Got: ${err}`
        );
        assert.ok(
            !/is not a function|is not defined/.test(err),
            `connect threw a code error rather than a network error. Got: ${err}`
        );
    }
});
