'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { B2Client } = require('../../src/b2-client');

// The webmail's Drive is a direct browser-to-S3 client, so a bucket
// provisioned without CORS rules can never be opened: the preflight is
// refused and every call surfaces as a bare "Failed to fetch". Buckets
// were being created without them, which left Drive broken for every user
// except the one whose rules had been added by hand.

function makeClient(captured) {
    const c = new B2Client({ keyId: 'k', applicationKey: 'a', logger: { info() {}, warn() {} } });
    c.authorize = async () => ({ apiUrl: 'https://api.test', authorizationToken: 't', accountId: 'acct' });
    c._request = async (url, opts) => {
        captured.push({ url, body: opts.body });
        return { bucketId: 'b1' };
    };
    return c;
}

test('createBucket attaches CORS rules for the given origins', async () => {
    const calls = [];
    const c = makeClient(calls);
    await c.createBucket('imr-example', { corsOrigins: ['https://webmail.example.com'] });

    const body = calls[0].body;
    assert.equal(body.bucketName, 'imr-example');
    assert.equal(body.bucketType, 'allPrivate');
    assert.ok(Array.isArray(body.corsRules) && body.corsRules.length === 1);
    const rule = body.corsRules[0];
    assert.deepEqual(rule.allowedOrigins, ['https://webmail.example.com']);
    // A browser drive needs to read, write and delete, and preflight has
    // to be cacheable or every operation pays for an extra round trip.
    for (const op of ['s3_head', 's3_get', 's3_put', 's3_delete']) {
        assert.ok(rule.allowedOperations.includes(op), `missing ${op}`);
    }
    assert.ok(rule.maxAgeSeconds > 0);
});

test('createBucket omits corsRules entirely when no origins are configured', async () => {
    const calls = [];
    const c = makeClient(calls);
    await c.createBucket('imr-example');
    // B2 rejects an empty corsRules array, so it must be absent, not [].
    assert.equal('corsRules' in calls[0].body, false);
});

test('ensureCors updates an existing bucket and is a no-op without origins', async () => {
    const calls = [];
    const c = makeClient(calls);

    assert.equal(await c.ensureCors('b1', []), null);
    assert.equal(calls.length, 0, 'must not call B2 with nothing to set');

    await c.ensureCors('b1', ['https://webmail.example.com']);
    assert.match(calls[0].url, /b2_update_bucket$/);
    assert.equal(calls[0].body.bucketId, 'b1');
    assert.deepEqual(calls[0].body.corsRules[0].allowedOrigins, ['https://webmail.example.com']);
});
