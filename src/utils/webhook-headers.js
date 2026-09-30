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
//    declared framing diverge from what undici actually sends, and the two
//    x-webhook-* names we emit are the signature block — a caller setting
//    one could pass a forged signature off as ours. Only those exact names
//    are blocked, not x-* generally: vendor auth headers (X-Api-Key and
//    friends) are a legitimate use.
//  - Content-Type and User-Agent are NOT reserved. A caller overriding them
//    changes only how the receiver labels the POST — the framing and the
//    signature still come from us.
//  - The cap of 16 headers keeps a pathological config from bloating every
//    delivery; nothing legitimate needs more.

const MAX_HEADERS = 16;
const MAX_VALUE = 1024;
// RFC 7230 token — the legal header-name alphabet.
const NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
// Printable ASCII plus space and tab. No CR, no LF, no controls, no DEL.
const VALUE_RE = /^[\t\x20-\x7E]*$/;

// Transport headers (framing/proxy state belongs to undici, not the caller)
// and the two signature names the delivery path sets itself. Compared
// case-insensitively — header names are.
const RESERVED = new Set([
    'host',
    'content-length',
    'connection',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailer',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'x-webhook-timestamp',
    'x-webhook-signature-v2'
]);

// `undefined`/`null` → { ok, headers: {} }. Anything else must be a plain
// object of string → string. Returns { ok: true, headers } or
// { ok: false, error } so callers choose their own failure shape — routes
// map the error to a 400, config parsing drops the block with a warning.
function sanitizeWebhookHeaders(input) {
    if (input === undefined || input === null) return { ok: true, headers: {} };
    if (typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: 'headers must be an object mapping header names to values' };
    }
    const entries = Object.entries(input);
    if (entries.length > MAX_HEADERS) {
        return { ok: false, error: `headers may contain at most ${MAX_HEADERS} entries` };
    }
    const out = {};
    for (const [rawName, rawValue] of entries) {
        const name = String(rawName).trim();
        if (!NAME_RE.test(name)) {
            return { ok: false, error: `invalid header name: ${rawName}` };
        }
        const lower = name.toLowerCase();
        if (RESERVED.has(lower)) {
            return { ok: false, error: `header "${name}" is reserved and cannot be set` };
        }
        if (typeof rawValue !== 'string') {
            return { ok: false, error: `header "${name}" must have a string value` };
        }
        const value = rawValue.trim();
        if (value.length > MAX_VALUE) {
            return { ok: false, error: `header "${name}" exceeds ${MAX_VALUE} characters` };
        }
        if (!VALUE_RE.test(value)) {
            return { ok: false, error: `header "${name}" contains characters that cannot go on the wire` };
        }
        out[name] = value;
    }
    return { ok: true, headers: out };
}

// Set a header on a delivery map so the new value REPLACES any existing
// one, whatever case it was written in. Header names are case-insensitive
// on the wire, and undici serialises a plain object key-by-key — so a
// caller-supplied `Content-Type` sitting next to our `content-type` would
// send both. Deleting the differently-cased twin first keeps the map to
// one entry per name, which is what "custom headers may override our
// defaults" and "the signature always wins" both need.
function setHeader(headers, name, value) {
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lower && key !== name) delete headers[key];
    }
    headers[name] = value;
}

module.exports = { sanitizeWebhookHeaders, setHeader };
