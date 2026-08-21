'use strict';

// Regression tests for the SSRF bypasses that reached the image proxy and
// calendar subscriptions: no post-resolution DNS check at all, and hostname
// string checks that missed bracketed IPv6, hex-form IPv4-mapped addresses,
// CGNAT and most of fc00::/7.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    isPrivateIp,
    normalizeHost,
    validateTargetUrl,
    createPinnedDispatcher,
    assertPublicDestination
} = require('../../src/utils/ssrf-guard');

test('isPrivateIp covers the ranges a proxy must never reach', () => {
    for (const ip of [
        '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
        '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.0.1',
        '0.0.0.0', '224.0.0.1', '255.255.255.255'
    ]) assert.equal(isPrivateIp(ip), true, `${ip} must be private`);

    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '93.184.216.34']) {
        assert.equal(isPrivateIp(ip), false, `${ip} must be public`);
    }
});

test('isPrivateIp covers IPv6, including the forms the old filter missed', () => {
    for (const ip of [
        '::1',
        '0:0:0:0:0:0:0:1',        // fully spelled loopback
        '::',
        'fc00::1',
        'fd00::1',                 // fd = ULA too; the old /^fc00:/ missed it
        'fe80::1',
        'fea0::1',                 // fe80::/10 spans fe80-febf
        '::ffff:10.0.0.1',         // mapped, decimal
        '::ffff:a00:1'             // mapped, hex — parsed as a different address before
    ]) assert.equal(isPrivateIp(ip), true, `${ip} must be private`);

    assert.equal(isPrivateIp('2606:4700::1111'), false);
    assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
});

test('normalizeHost folds bracketed, mapped and integer forms', () => {
    assert.equal(normalizeHost('[::1]'), '::1');
    assert.equal(normalizeHost('::ffff:10.0.0.1'), '10.0.0.1');
    assert.equal(normalizeHost('::ffff:a00:1'), '10.0.0.1');
    assert.equal(normalizeHost('2130706433'), '127.0.0.1');
    assert.equal(normalizeHost('Example.COM'), 'example.com');
});

test('validateTargetUrl rejects every literal bypass form', () => {
    for (const url of [
        'http://[::ffff:a00:1]/x',
        'http://[fd00::1]/x',
        'http://[0:0:0:0:0:0:0:1]/x',
        'http://2130706433/x',
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost/x',
        'http://foo.internal/x',
        'file:///etc/passwd',
        'gopher://example.com/x'
    ]) {
        const r = validateTargetUrl(url);
        assert.equal(r.ok, false, `${url} must be rejected`);
        assert.ok(r.reason, 'a reason is always given');
    }
    assert.equal(validateTargetUrl('https://example.com/a.png').ok, true);
});

test('validateTargetUrl can require https', () => {
    const opts = { schemes: ['https:'] };
    assert.equal(validateTargetUrl('http://example.com/f.ics', opts).ok, false);
    assert.equal(validateTargetUrl('https://example.com/f.ics', opts).ok, true);
});

test('createPinnedDispatcher refuses a public name that resolves privately', async () => {
    // The whole point: the URL string looks fine, DNS does not.
    const lookup = async () => [{ address: '10.1.2.3', family: 4 }];
    await assert.rejects(
        () => createPinnedDispatcher('https://rebind.example/x', { lookup, AgentCtor: class {} }),
        /private IP/i
    );
});

test('createPinnedDispatcher pins the connection to the address it checked', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    let pinned = null;
    class FakeAgent {
        constructor(opts) {
            // Capture what undici would use to connect.
            opts.connect.lookup('rebind.example', {}, (_e, addr) => { pinned = addr; });
        }
    }
    const d = await createPinnedDispatcher('https://ok.example/x', { lookup, AgentCtor: FakeAgent });
    assert.ok(d instanceof FakeAgent);
    assert.equal(pinned, '93.184.216.34');
});

test('createPinnedDispatcher returns null for an already-checked literal IP', async () => {
    let looked = false;
    const lookup = async () => { looked = true; return []; };
    const d = await createPinnedDispatcher('https://93.184.216.34/x', { lookup, AgentCtor: class {} });
    assert.equal(d, null);
    assert.equal(looked, false, 'a literal IP needs no resolution');
});

test('assertPublicDestination combines the string and DNS checks', async () => {
    const priv = await assertPublicDestination('https://rebind.example/f.ics', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }]
    });
    assert.equal(priv.ok, false);
    assert.match(priv.reason, /private/i);

    const pub = await assertPublicDestination('https://ok.example/f.ics', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }]
    });
    assert.equal(pub.ok, true);

    // A name that doesn't resolve fails closed rather than throwing.
    const nx = await assertPublicDestination('https://nope.example/f.ics', {
        lookup: async () => { throw new Error('ENOTFOUND'); }
    });
    assert.equal(nx.ok, false);
});
