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

test('createPinnedDispatcher answers in whichever lookup shape was asked for', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    let arrayForm = null;
    let scalarForm = null;
    class FakeAgent {
        constructor(opts) {
            // Node asks for the array form when autoSelectFamily is on and
            // the scalar form otherwise. Answering with the wrong one kills
            // the socket with ERR_INVALID_IP_ADDRESS — which is what broke
            // the image proxy, calendar feeds and webhook delivery.
            opts.connect.lookup('ok.example', { all: true }, (_e, addr) => { arrayForm = addr; });
            opts.connect.lookup('ok.example', {}, (_e, addr, family) => { scalarForm = [addr, family]; });
        }
    }
    const d = await createPinnedDispatcher('https://ok.example/x', { lookup, AgentCtor: FakeAgent });
    assert.ok(d instanceof FakeAgent);
    assert.deepEqual(arrayForm, [{ address: '93.184.216.34', family: 4 }]);
    assert.deepEqual(scalarForm, ['93.184.216.34', 4]);
});

test('createPinnedDispatcher pins every checked address, not just the first', async () => {
    // Pinning only addresses[0] drops happy-eyeballs, so a dual-stack host
    // whose AAAA comes first fails on a box with no IPv6 route.
    const lookup = async () => [
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
        { address: '93.184.216.34', family: 4 }
    ];
    let pinned = null;
    class FakeAgent {
        constructor(opts) {
            opts.connect.lookup('ok.example', { all: true }, (_e, addrs) => { pinned = addrs; });
        }
    }
    await createPinnedDispatcher('https://ok.example/x', { lookup, AgentCtor: FakeAgent });
    assert.equal(pinned.length, 2);
    assert.deepEqual(pinned[1], { address: '93.184.216.34', family: 4 });
});

test('a private destination is marked permanent, a resolution failure is not', async () => {
    // The forwarder fails fast on permanent and retries the rest. Marking a
    // transient resolver blip permanent abandoned mail after one attempt.
    const priv = await assertPublicDestination('https://rebind.example/x', {
        lookup: async () => [{ address: '10.0.0.1', family: 4 }]
    }).catch((e) => e);
    assert.equal(priv.permanent, true);

    const blip = await assertPublicDestination('https://flaky.example/x', {
        lookup: async () => { throw new Error('EAI_AGAIN'); }
    }).catch((e) => e);
    assert.notEqual(blip.permanent, true);
});

test('createPinnedDispatcher refuses a literal private IP', async () => {
    // Nothing to resolve, but a literal address still has to be public —
    // this is what let a webhook POST to http://127.0.0.1/.
    await assert.rejects(
        () => createPinnedDispatcher('http://127.0.0.1:3001/health', { AgentCtor: class {} }),
        /private IP/i
    );
    await assert.rejects(
        () => createPinnedDispatcher('http://169.254.169.254/latest/meta-data/', { AgentCtor: class {} }),
        /private IP/i
    );
});

test('createPinnedDispatcher returns null for an already-checked literal IP', async () => {
    let looked = false;
    const lookup = async () => { looked = true; return []; };
    const d = await createPinnedDispatcher('https://93.184.216.34/x', { lookup, AgentCtor: class {} });
    assert.equal(d, null);
    assert.equal(looked, false, 'a literal IP needs no resolution');
});

test('assertPublicDestination throws on a rejected destination', async () => {
    // It must THROW, not return a verdict: the route wraps it in try/catch,
    // and a returned verdict is silently discarded by that shape.
    await assert.rejects(
        () => assertPublicDestination('https://rebind.example/f.ics', {
            lookup: async () => [{ address: '127.0.0.1', family: 4 }]
        }),
        /private/i
    );

    const pub = await assertPublicDestination('https://ok.example/f.ics', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }]
    });
    assert.equal(pub.ok, true);

    // A name that doesn't resolve fails closed.
    await assert.rejects(
        () => assertPublicDestination('https://nope.example/f.ics', {
            lookup: async () => { throw new Error('ENOTFOUND'); }
        }),
        /did not resolve/i
    );

    // A literal private address is rejected without any lookup.
    await assert.rejects(
        () => assertPublicDestination('http://127.0.0.1:3001/health'),
        /private/i
    );
});
