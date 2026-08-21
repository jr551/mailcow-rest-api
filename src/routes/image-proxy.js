'use strict';

const { URL } = require('node:url');
const dns = require('node:dns').promises;
const { Agent } = require('undici');
const { problem } = require('../errors');
const { streamWithLimit } = require('../utils/stream');
const {
    isPrivateIp,
    isPrivateHostname,
    normalizeHost,
    validateTargetUrl,
    createPinnedDispatcher
} = require('../utils/ssrf-guard');

const MAX_IMAGE_BYTES = 1 * 1024 * 1024; // 1 MB per image
const FETCH_TIMEOUT_MS = 10_000;
// How long a failed fetch is remembered. Long enough to collapse a tab's
// re-render loop, short enough that a fixed upstream recovers on its own.
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function titleFor(status) {
    if (status === 413) return 'Payload Too Large';
    if (status === 415) return 'Unsupported Media Type';
    if (status === 404) return 'Not Found';
    return 'Bad Gateway';
}

// Known image MIME types that legitimately appear in email bodies.
const ALLOWED_IMAGE_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
    'image/tiff',
    'image/x-icon',
    'image/avif',
    'image/heic',
    'image/heif'
]);

const problemSchema = {
    type: 'object',
    properties: {
        type: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'integer' },
        detail: { type: 'string' }
    }
};

function isAllowedImageType(contentType) {
    if (!contentType) return false;
    // Normalize: strip charset suffixes like "image/png; charset=utf-8"
    const normalized = contentType.split(';')[0].trim().toLowerCase();
    return ALLOWED_IMAGE_TYPES.has(normalized);
}

// The host/IP/scheme rules and the DNS-pinned dispatcher now live in
// utils/ssrf-guard so the image proxy, calendar subscriptions and web-push
// endpoints all enforce the same thing. The copy that used to live here
// matched only literal IPs in the URL string — no post-resolution check at
// all — so a hostname the attacker controlled could resolve to 10.x, 127.x
// or 169.254.169.254 and pass. It also missed bracketed IPv6, hex-form
// IPv4-mapped addresses (::ffff:a00:1), CGNAT and most of fc00::/7.

function todayIso() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
}

async function fetchImage(url, { fetchImpl = global.fetch, lookup = dns.lookup, AgentCtor = Agent } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    // Manual redirect handling: tracking-pixel and CDN URLs almost always
    // 302 to the actual asset host, so blanket-rejecting redirects (the
    // old behaviour) made the proxy useless for marketing emails. But
    // `redirect: 'follow'` would let an attacker craft a Location: header
    // pointing at an internal IP, defeating the SSRF check. So: follow up
    // to MAX_HOPS times, re-validating each hop against the same allow
    // rules we apply to the user-provided URL.
    const MAX_HOPS = 5;
    let current = url;
    try {
        for (let hop = 0; hop <= MAX_HOPS; hop++) {
            // Resolve first, reject private answers, then pin the connection
            // to the address we checked — otherwise the name is free to
            // resolve somewhere else on the second lookup (DNS rebinding).
            const dispatcher = await createPinnedDispatcher(current, { lookup, AgentCtor });
            const res = await fetchImpl(current, {
                signal: controller.signal,
                redirect: 'manual',
                dispatcher,
                headers: {
                    'user-agent': 'mailcow-rest-api/1.0 (image proxy)',
                    accept: 'image/*,*/*;q=0.8'
                }
            });
            if (res.status >= 300 && res.status < 400) {
                if (hop === MAX_HOPS) {
                    return { ok: false, status: 502, reason: `Too many redirects (>${MAX_HOPS})` };
                }
                const loc = res.headers.get('location');
                if (!loc) {
                    return { ok: false, status: 502, reason: 'Redirect with no Location header' };
                }
                let next;
                try { next = new URL(loc, current).toString(); }
                catch { return { ok: false, status: 502, reason: 'Invalid redirect target' }; }
                const v = validateTargetUrl(next);
                if (!v.ok) return { ok: false, status: 502, reason: `Redirect blocked: ${v.reason}` };
                // Drain so the connection can be reused.
                try { await res.body?.cancel(); } catch { /* */ }
                current = next;
                continue;
            }
            if (!res.ok) {
                return { ok: false, status: res.status, reason: `Upstream returned ${res.status}` };
            }
            const contentType = res.headers.get('content-type') || 'application/octet-stream';
            const reader = res.body.getReader();
            const { buf, exceeded } = await streamWithLimit(reader, MAX_IMAGE_BYTES);
            if (exceeded) {
                // Stop the download — without this undici keeps pulling the
                // rest of the body into memory even though we've given up.
                try { await reader.cancel(); } catch { /* */ }
                return { ok: false, status: 413, reason: 'Image exceeds 1 MB limit' };
            }
            return { ok: true, data: buf, contentType };
        }
        return { ok: false, status: 502, reason: 'Redirect loop' };
    } catch (err) {
        if (err.name === 'AbortError') {
            return { ok: false, reason: 'Fetch timed out' };
        }
        return { ok: false, reason: err.message || 'Fetch failed' };
    } finally {
        clearTimeout(timer);
    }
}

const imageProxyRoutes = async function imageProxyRoutes(app, { cache, maxBytesPerDay = 1024 * 1024 * 1024 }) {
    app.get('/v1/proxy/image', {
        schema: {
            tags: ['proxy'],
            summary: 'Proxy an external image',
            description: 'Fetches an external image through the server so the client IP is never exposed to the upstream host. Results are cached up to a 100 MB total limit. Per-user daily cap applies.',
            querystring: {
                type: 'object',
                required: ['url'],
                properties: {
                    url: { type: 'string', format: 'uri' }
                }
            },
            response: {
                200: { type: 'string', contentMediaType: 'image/*' },
                400: problemSchema,
                413: problemSchema,
                415: problemSchema,
                429: problemSchema,
                502: problemSchema
            }
        }
    }, async (req, reply) => {
        const rawUrl = req.query.url;
        if (!rawUrl) {
            throw problem(400, 'Bad Request', 'Missing url query parameter');
        }

        const validation = validateTargetUrl(rawUrl);
        if (!validation.ok) {
            throw problem(400, 'Bad Request', validation.reason);
        }

        const user = req.creds.user;
        const day = todayIso();
        const usageToday = cache.getUsage(user, day);

        // 1. Check cache
        const cached = cache.get(rawUrl);
        if (cached) {
            if (!isAllowedImageType(cached.contentType)) {
                throw problem(415, 'Unsupported Media Type', 'Cached content is not an allowed image type');
            }
            const wouldUse = usageToday + cached.size;
            if (wouldUse > maxBytesPerDay) {
                throw problem(429, 'Too Many Requests', `Daily image proxy limit of ${Math.round(maxBytesPerDay / 1024 / 1024)} MB exceeded`);
            }
            cache.incrementUsage(user, day, cached.size);
            reply.header('cache-control', 'private, max-age=86400');
            return reply.type(cached.contentType).send(cached.data);
        }

        // 2. Known-bad? Fail fast without re-hitting the origin. An open
        // webmail tab re-renders the same message every ~30s; before this,
        // each render re-downloaded a multi-MB image just to reject it.
        const negative = cache.getNegative(rawUrl, NEGATIVE_TTL_MS);
        if (negative) {
            reply.header('cache-control', `private, max-age=${Math.floor(NEGATIVE_TTL_MS / 1000)}`);
            throw problem(negative.status, titleFor(negative.status), negative.reason);
        }

        // 3. Fetch upstream
        const result = await fetchImage(rawUrl);
        if (!result.ok) {
            const status = result.status || 502;
            // Remember terminal failures so the retry loop above can't
            // form. 5xx/timeouts are recorded too — they expire on the
            // same TTL, which is the backoff.
            cache.setNegative(rawUrl, status, result.reason);
            reply.header('cache-control', `private, max-age=${Math.floor(NEGATIVE_TTL_MS / 1000)}`);
            throw problem(status, titleFor(status), result.reason);
        }

        if (!isAllowedImageType(result.contentType)) {
            const detail = `Content-Type "${result.contentType}" is not an allowed image type`;
            cache.setNegative(rawUrl, 415, detail);
            throw problem(415, 'Unsupported Media Type', detail);
        }

        const wouldUse = usageToday + result.data.length;
        if (wouldUse > maxBytesPerDay) {
            throw problem(429, 'Too Many Requests', `Daily image proxy limit of ${Math.round(maxBytesPerDay / 1024 / 1024)} MB exceeded`);
        }

        // 4. Store in cache and account usage
        cache.set(rawUrl, result.data, result.contentType);
        cache.incrementUsage(user, day, result.data.length);

        // Return
        reply.header('cache-control', 'private, max-age=86400');
        return reply.type(result.contentType).send(result.data);
    });
};

module.exports = imageProxyRoutes;
module.exports.fetchImage = fetchImage;
module.exports.validateTargetUrl = validateTargetUrl;
module.exports.isPrivateIp = isPrivateIp;
module.exports.isPrivateHostname = isPrivateHostname;
module.exports.normalizeHost = normalizeHost;
module.exports.createPinnedDispatcher = createPinnedDispatcher;
