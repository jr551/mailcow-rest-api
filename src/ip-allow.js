'use strict';

const { isIP } = require('node:net');

function ipv4ToInt(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        throw new Error(`Invalid IPv4: ${ip}`);
    }
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv6ToBigInt(ip) {
    const parts = ip.split('::');
    if (parts.length > 2) throw new Error(`Invalid IPv6: ${ip}`);
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) throw new Error(`Invalid IPv6: ${ip}`);
    const groups = parts.length === 2
        ? [...head, ...Array(missing).fill('0'), ...tail]
        : head;
    if (groups.length !== 8) throw new Error(`Invalid IPv6: ${ip}`);
    let n = 0n;
    for (const g of groups) {
        const v = parseInt(g, 16);
        if (!Number.isFinite(v) || v < 0 || v > 0xffff) throw new Error(`Invalid IPv6: ${ip}`);
        n = (n << 16n) | BigInt(v);
    }
    return n;
}

function parseEntry(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const slash = trimmed.indexOf('/');
    const ipPart = slash < 0 ? trimmed : trimmed.slice(0, slash);
    const prefixPart = slash < 0 ? null : trimmed.slice(slash + 1);
    const family = isIP(ipPart);
    if (family === 0) throw new Error(`Invalid IP: ${trimmed}`);

    const max = family === 4 ? 32 : 128;
    let prefix = max;
    if (prefixPart !== null) {
        const p = Number(prefixPart);
        if (!Number.isInteger(p) || p < 0 || p > max) {
            throw new Error(`Invalid prefix in ${trimmed}`);
        }
        prefix = p;
    }

    if (family === 4) {
        const value = ipv4ToInt(ipPart);
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
        return { family: 4, value: (value & mask) >>> 0, prefix, mask };
    }
    const value = ipv6ToBigInt(ipPart);
    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    return { family: 6, value: value & mask, prefix, mask };
}

function parseAllowlist(raw) {
    const out = { v4: [], v6: [] };
    if (!raw) return out;
    for (const entry of String(raw).split(',')) {
        const parsed = parseEntry(entry);
        if (!parsed) continue;
        if (parsed.family === 4) out.v4.push(parsed);
        else out.v6.push(parsed);
    }
    return out;
}

function isAllowed(ip, rules, { allowAll = false } = {}) {
    if (!ip || typeof ip !== 'string') return false;
    const family = isIP(ip);
    if (family === 0) return false;
    if (allowAll && rules.v4.length === 0 && rules.v6.length === 0) return true;
    if (family === 4) {
        const value = ipv4ToInt(ip);
        return rules.v4.some((r) => ((value & r.mask) >>> 0) === r.value);
    }
    const value = ipv6ToBigInt(ip);
    return rules.v6.some((r) => (value & r.mask) === r.value);
}

const LOOPBACK_RULES = parseAllowlist('127.0.0.0/8,::1');

function createIpAllowHook({ allowlist }) {
    const rules = parseAllowlist(allowlist || '');
    const empty = rules.v4.length === 0 && rules.v6.length === 0;

    return async function ipAllowHook(req, reply) {
        if (empty) return;
        const ip = req.ip;
        if (isAllowed(ip, LOOPBACK_RULES)) return;
        if (isAllowed(ip, rules)) return;

        const problem = {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'Source IP not on allowlist'
        };
        reply.code(403).type('application/problem+json').send(problem);
        return reply;
    };
}

module.exports = { parseAllowlist, isAllowed, createIpAllowHook };
