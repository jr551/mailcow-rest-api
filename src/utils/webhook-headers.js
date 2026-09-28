'use strict';

// User-configured HTTP headers sent with outbound webhook POSTs
// (Authorization is the primary case, but any bearer/api-key style header).
//
// This is a request-forgery surface, so the rules below exist for real
// reasons, not hygiene:
//
//  - Header VALUES must never contain CR/LF or control bytes: a value that
//    reached the wire verbatim could inject extra headers or even a fake
//    body boundary into the POST. Printable ASCII/space/tab only.
//  - The reserved list protects the transport and the signature: letting a
//    caller set Content-Length, Host, Transfer-Encoding etc. would let the
//    declared framing diverge from what undici actually sends, and any
//    `x-webhook-*` name would let the caller forge or clobber our own
//    signature headers (the signature is what proves a POST came from us).
//  - The cap of 10 headers keeps a pathological config from bloating every
//    delivery; nothing legitimate needs more.

const MAX_HEADERS = 10;
const MAX_VALUE = 2000;
// RFC 7230 token — the legal header-name alphabet.
const NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
// Printable ASCII plus space and tab. No CR, no LF, no controls, no DEL.
const VALUE_RE = /^[\t\x20-\x7E]*$/;

const RESERVED = new Set([
    'content-type',
    'user-agent',
    'host',
    'content-length',
    'connection',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'keep-alive',
    'proxy-authorization'
]);

// `undefined`/`null` → `{}`. Anything else must be a plain object of
// string → string; violations throw Error (routes map these to 400).
function sanitizeWebhookHeaders(input) {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('headers must be an object mapping header names to values');
    }
    const entries = Object.entries(input);
    if (entries.length > MAX_HEADERS) {
        throw new Error(`headers may contain at most ${MAX_HEADERS} entries`);
    }
    const out = {};
    for (const [rawName, rawValue] of entries) {
        const name = String(rawName).trim();
        if (!NAME_RE.test(name)) {
            throw new Error(`invalid header name: ${rawName}`);
        }
        const lower = name.toLowerCase();
        if (RESERVED.has(lower)) {
            throw new Error(`header "${name}" is reserved and cannot be set`);
        }
        if (lower.startsWith('x-webhook-')) {
            throw new Error(`header "${name}" is reserved (x-webhook-* names carry the signature)`);
        }
        if (typeof rawValue !== 'string') {
            throw new Error(`header "${name}" must have a string value`);
        }
        const value = rawValue.trim();
        if (value.length > MAX_VALUE) {
            throw new Error(`header "${name}" exceeds ${MAX_VALUE} characters`);
        }
        if (!VALUE_RE.test(value)) {
            throw new Error(`header "${name}" contains characters that cannot go on the wire`);
        }
        out[name] = value;
    }
    return out;
}

module.exports = { sanitizeWebhookHeaders };
