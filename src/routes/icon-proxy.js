'use strict';

// Same-origin icon proxy for sender avatars.
//
// The webmail composes silhouette avatars by using DuckDuckGo / simple-icons
// PNGs as `mask-image: url(...)` in CSS. Browsers apply a CORS check to
// images consumed by CSS masks, and DDG doesn't send Access-Control-Allow-*
// — so the mask never paints and the console fills with CORS errors. Proxying
// the bytes through our own server keeps everything same-origin.
//
// The endpoint is intentionally narrow:
//   * Allowlists known icon hosts so it can't be abused as an open proxy.
//   * 5 s upstream timeout, 200 KB byte cap, then error / empty body.
//   * Caches in memory (~256 entries, 12h TTL) so we don't re-hit upstream
//     for every avatar render.
//
// Public route — avatars render on the login screen too.

const { streamWithLimit } = require('../utils/stream');

const ALLOWED_HOSTS = new Set([
    'icons.duckduckgo.com',
    'cdn.simpleicons.org',
    'www.gravatar.com',
    'secure.gravatar.com'
]);

const MAX_BYTES = 200 * 1024;
const UPSTREAM_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX = 256;
// Upstream misses (gravatar d=404, unknown simple-icons slug) are remembered
// briefly in their own map, so a loop over random hashes neither re-hits the
// upstream every time nor flushes the real icons out of the main cache.
const MISS_TTL_MS = 10 * 60 * 1000;

const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function createLru(max, ttlMs) {
    const map = new Map(); // key -> { buf, contentType, ts }
    return {
        get(key) {
            const v = map.get(key);
            if (!v) return null;
            if (Date.now() - v.ts > ttlMs) {
                map.delete(key);
                return null;
            }
            // LRU bump
            map.delete(key);
            map.set(key, v);
            return v;
        },
        put(key, val) {
            if (map.size >= max) {
                const firstKey = map.keys().next().value;
                if (firstKey) map.delete(firstKey);
            }
            map.set(key, val);
        }
    };
}

const cache = createLru(CACHE_MAX, CACHE_TTL_MS);
const misses = createLru(CACHE_MAX, MISS_TTL_MS);

function sendMiss(reply) {
    reply.header('content-type', 'image/gif');
    reply.header('cache-control', 'public, max-age=86400');
    return reply.code(200).send(TRANSPARENT_GIF);
}

function sendIcon(reply, contentType, buf) {
    reply.header('content-type', contentType);
    reply.header('cache-control', 'public, max-age=43200, immutable');
    return reply.send(buf);
}

module.exports = async function iconProxyRoutes(app) {
    app.get('/v1/proxy/icon', {
        // Public, cached, allowlisted — a busy inbox legitimately fires one
        // of these per sender domain; counting them against the global
        // limiter starves real API calls. It gets its own generous per-IP
        // bucket instead, so the route can't be used to hammer the upstreams.
        config: { public: true, rateLimit: { max: 600, timeWindow: '1 minute' } },
        schema: {
            tags: ['system'],
            summary: 'Proxy a sender-avatar icon (allowlisted hosts only)',
            querystring: {
                type: 'object',
                additionalProperties: false,
                required: ['u'],
                properties: { u: { type: 'string', minLength: 1, maxLength: 2048 } }
            }
        }
    }, async (req, reply) => {
        const target = req.query.u;
        let url;
        try { url = new URL(target); } catch { return reply.code(400).send({ error: 'bad url' }); }
        if (url.protocol !== 'https:') return reply.code(400).send({ error: 'https only' });
        if (!ALLOWED_HOSTS.has(url.hostname)) return reply.code(400).send({ error: 'host not allowed' });

        const cached = cache.get(url.href);
        if (cached) return sendIcon(reply, cached.contentType, cached.buf);
        if (misses.get(url.href)) return sendMiss(reply);

        // The timer covers the body read too: a slow-drip upstream must not
        // hold the request open after the headers arrive.
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
        try {
            const res = await fetch(url.href, {
                signal: ac.signal,
                headers: { 'user-agent': 'mailcow-rest-api/icon-proxy' },
                redirect: 'manual'
            });

            if (res.status >= 300 && res.status < 400) {
                try { await res.body?.cancel?.(); } catch { /* */ }
                return reply.code(502).send({ error: 'upstream redirected' });
            }

            if (!res.ok) {
                // Upstream 404/410 for missing icons is normal (gravatar d=404,
                // simple-icons unknown slug, DDG unknown domain). Return a 1x1
                // transparent GIF so the browser's img onload fires cleanly
                // instead of logging a network error to the console.
                try { await res.body?.cancel?.(); } catch { /* */ }
                misses.put(url.href, { ts: Date.now() });
                return sendMiss(reply);
            }

            const contentType = res.headers.get('content-type') || 'image/png';
            // Reject obviously-not-an-image content types so we don't proxy text.
            if (!/^image\//i.test(contentType) && !/^application\/(?:octet-stream|x-png)/i.test(contentType)) {
                try { await res.body?.cancel?.(); } catch { /* */ }
                return reply.code(415).send({ error: 'not an image' });
            }

            const { buf, exceeded } = await streamWithLimit(res.body.getReader(), MAX_BYTES);
            if (exceeded) return reply.code(413).send({ error: 'too large' });
            cache.put(url.href, { buf, contentType, ts: Date.now() });
            return sendIcon(reply, contentType, buf);
        } catch {
            return reply.code(502).send({ error: 'upstream fetch failed' });
        } finally {
            clearTimeout(t);
        }
    });
};
