'use strict';

const { URL } = require('node:url');
const dns = require('node:dns').promises;
const { isIP } = require('node:net');
const { Agent } = require('undici');

// Shared destination checks for every place the server fetches a URL a user
// supplied: the image proxy, calendar subscriptions, web-push endpoints.
//
// Each of those had its own partial copy of these rules — or none at all —
// which is why the same class of bug kept reappearing. String matching on
// the hostname is not sufficient on its own: an attacker controls DNS for a
// name they own, so a public-looking hostname can resolve to 127.0.0.1 or
// 169.254.169.254. The name is checked, then the resolved addresses are
// checked, and then the connection is pinned to the address that was
// checked — otherwise the resolver is free to answer differently the second
// time (DNS rebinding).

// Fold the forms that reach the resolver as an IP but don't look like a
// dotted quad: bracketed IPv6, IPv4-mapped IPv6 in either decimal or hex
// form, and bare-integer IPv4.
function normalizeHost(hostname) {
    let h = String(hostname).toLowerCase().trim();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);

    // "::ffff:10.0.0.1" — decimal tail.
    const mappedDecimal = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (mappedDecimal) return mappedDecimal[1];

    // "::ffff:a00:1" — the same address written as hex groups, which the
    // decimal pattern above misses entirely.
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16);
        const lo = parseInt(mappedHex[2], 16);
        return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
    }

    // "2130706433" — the resolver reads a bare integer as an IPv4 address.
    if (/^\d+$/.test(h)) {
        const n = Number(h);
        if (Number.isInteger(n) && n >= 0 && n <= 0xFFFFFFFF) {
            return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
        }
    }
    return h;
}

// Expand an IPv6 address to its eight 16-bit groups, so a fully-spelled
// loopback ("0:0:0:0:0:0:0:1") is recognised as the same thing as "::1".
function ipv6Groups(ip) {
    if (!ip.includes(':')) return null;
    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const groups = halves.length === 2
        ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
        : head;
    if (groups.length !== 8) return null;
    const out = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
        out.push(parseInt(g, 16));
    }
    return out;
}

// Loopback, private, link-local, CGNAT, ULA, and the cloud metadata
// address. Takes a normalized host (see normalizeHost).
function isPrivateIp(rawIp) {
    const ip = normalizeHost(rawIp);

    if (isIP(ip) === 4 || /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        const o = ip.split('.').map(Number);
        if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed: refuse
        if (o[0] === 127) return true;                                  // loopback
        if (o[0] === 10) return true;                                   // RFC1918
        if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;      // RFC1918
        if (o[0] === 192 && o[1] === 168) return true;                  // RFC1918
        if (o[0] === 169 && o[1] === 254) return true;                  // link-local + metadata
        if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;     // CGNAT
        if (o[0] === 0) return true;                                    // this network
        if (o[0] >= 224) return true;                                   // multicast + reserved
        if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;      // IETF protocol assignments
        return false;
    }

    const g = ipv6Groups(ip);
    if (!g) return false;
    if (g.every((n) => n === 0)) return true;                                   // ::
    if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;         // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true;                                // fc00::/7 (ULA)
    if ((g[0] & 0xffc0) === 0xfe80) return true;                                // fe80::/10 (link-local)
    if (g[0] === 0xff00 || (g[0] & 0xff00) === 0xff00) return true;             // ff00::/8 multicast
    // IPv4-mapped that survived normalization (e.g. ::ffff:0:0/96 forms).
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
        const v4 = [(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255].join('.');
        return isPrivateIp(v4);
    }
    return false;
}

function isPrivateHostname(hostname) {
    const lower = String(hostname).toLowerCase();
    if (lower === 'localhost') return true;
    if (lower.endsWith('.local')) return true;
    if (lower.endsWith('.localhost')) return true;
    if (lower.endsWith('.internal')) return true;
    return false;
}

// `schemes` defaults to both; pass ['https:'] where plaintext has no
// business being accepted (calendar feeds, push endpoints).
function validateTargetUrl(raw, { schemes = ['http:', 'https:'] } = {}) {
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return { ok: false, reason: 'Invalid URL' };
    }
    if (!schemes.includes(parsed.protocol)) {
        return {
            ok: false,
            reason: schemes.length === 1 && schemes[0] === 'https:'
                ? 'Only HTTPS URLs are allowed'
                : 'Only HTTP and HTTPS URLs are allowed'
        };
    }
    if (isPrivateHostname(parsed.hostname)) {
        return { ok: false, reason: 'Private / localhost URLs are blocked' };
    }
    const host = normalizeHost(parsed.hostname);
    // Only apply the IP test to things that are actually addresses; a
    // hostname is checked again after resolution.
    if ((isIP(host) || /^[\d.]+$/.test(host)) && isPrivateIp(host)) {
        return { ok: false, reason: 'Private IP addresses are blocked' };
    }
    return { ok: true, url: parsed };
}

// Resolve, reject if any answer is private, then pin the connection to the
// address we checked so the name can't resolve elsewhere on the second
// lookup. Returns null for a literal-IP host (already validated, nothing to
// pin) so callers can pass the result straight to fetch/undici.
async function createPinnedDispatcher(rawUrl, { lookup = dns.lookup, AgentCtor = Agent } = {}) {
    const hostname = new URL(rawUrl).hostname;
    const bare = normalizeHost(hostname);
    if (isIP(bare)) return null;

    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length) throw new Error('Hostname did not resolve');
    if (addresses.some(({ address }) => isPrivateIp(address))) {
        throw new Error('Hostname resolved to a private IP address');
    }

    const primary = addresses[0];
    return new AgentCtor({
        connect: {
            lookup(_hostname, _options, callback) {
                callback(null, primary.address, primary.family);
            }
        }
    });
}

// Convenience for callers that only need "is this destination allowed",
// including the DNS check, without holding a dispatcher.
async function assertPublicDestination(rawUrl, { schemes, lookup = dns.lookup } = {}) {
    const v = validateTargetUrl(rawUrl, schemes ? { schemes } : undefined);
    if (!v.ok) return v;
    const bare = normalizeHost(v.url.hostname);
    if (isIP(bare)) return v;
    let addresses;
    try {
        addresses = await lookup(v.url.hostname, { all: true, verbatim: true });
    } catch {
        return { ok: false, reason: 'Hostname did not resolve' };
    }
    if (!addresses.length) return { ok: false, reason: 'Hostname did not resolve' };
    if (addresses.some(({ address }) => isPrivateIp(address))) {
        return { ok: false, reason: 'Hostname resolves to a private IP address' };
    }
    return v;
}

module.exports = {
    normalizeHost,
    isPrivateIp,
    isPrivateHostname,
    validateTargetUrl,
    createPinnedDispatcher,
    assertPublicDestination
};
