'use strict';

const { URL } = require('node:url');
const { problem } = require('../errors');
const { streamWithLimit } = require('../utils/stream');

const MAX_IMAGE_BYTES = 1 * 1024 * 1024; // 1 MB per image
const FETCH_TIMEOUT_MS = 10_000;

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

// Block private / loopback / link-local ranges to prevent SSRF.
function isPrivateIp(ip) {
    if (/^127\./.test(ip)) return true;
    if (/^10\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^169\.254\./.test(ip)) return true;
    if (/^0\./.test(ip)) return true;
    if (/^255\./.test(ip)) return true;
    if (ip === '0.0.0.0') return true;
    if (ip === '::1') return true;
    if (/^fc00:/i.test(ip)) return true;
    if (/^fe80:/i.test(ip)) return true;
    return false;
}

function isPrivateHostname(hostname) {
    const lower = hostname.toLowerCase();
    if (lower === 'localhost') return true;
    if (lower.endsWith('.local')) return true;
    if (lower.endsWith('.localhost')) return true;
    return false;
}

function validateTargetUrl(raw) {
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return { ok: false, reason: 'Invalid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: 'Only HTTP and HTTPS URLs are allowed' };
    }
    if (isPrivateHostname(parsed.hostname)) {
        return { ok: false, reason: 'Private / localhost URLs are blocked' };
    }
    if (/^[\d.:]+$/.test(parsed.hostname) && isPrivateIp(parsed.hostname)) {
        return { ok: false, reason: 'Private IP addresses are blocked' };
    }
    return { ok: true, url: parsed };
}

function todayIso() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
}

async function fetchImage(url) {
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
            const res = await fetch(current, {
                signal: controller.signal,
                redirect: 'manual',
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
                return { ok: false, reason: 'Image exceeds 1 MB limit' };
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

module.exports = async function imageProxyRoutes(app, { cache, maxBytesPerDay = 1024 * 1024 * 1024 }) {
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
            return reply.type(cached.contentType).send(cached.data);
        }

        // 2. Fetch upstream
        const result = await fetchImage(rawUrl);
        if (!result.ok) {
            const status = result.status || 502;
            throw problem(status, status === 413 ? 'Payload Too Large' : 'Bad Gateway', result.reason);
        }

        if (!isAllowedImageType(result.contentType)) {
            throw problem(415, 'Unsupported Media Type', `Content-Type "${result.contentType}" is not an allowed image type`);
        }

        const wouldUse = usageToday + result.data.length;
        if (wouldUse > maxBytesPerDay) {
            throw problem(429, 'Too Many Requests', `Daily image proxy limit of ${Math.round(maxBytesPerDay / 1024 / 1024)} MB exceeded`);
        }

        // 3. Store in cache and account usage
        cache.set(rawUrl, result.data, result.contentType);
        cache.incrementUsage(user, day, result.data.length);

        // 4. Return
        return reply.type(result.contentType).send(result.data);
    });
};
