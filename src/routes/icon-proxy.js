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

const cache = new Map(); // url -> { buf, contentType, ts }

function cacheGet(key) {
    const v = cache.get(key);
    if (!v) return null;
    if (Date.now() - v.ts > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    // LRU bump
    cache.delete(key);
    cache.set(key, v);
    return v;
}

function cachePut(key, val) {
    if (cache.size >= CACHE_MAX) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
    }
    cache.set(key, val);
}

module.exports = async function iconProxyRoutes(app) {
    app.get('/v1/proxy/icon', {
        config: { public: true },
        schema: {
            tags: ['system'],
            summary: 'Proxy a sender-avatar icon (allowlisted hosts only)',
            querystring: {
                type: 'object',
                additionalProperties: false,
                required: ['u'],
                properties: { u: { type: 'string', minLength: 1 } }
            }
        }
    }, async (req, reply) => {
        const target = req.query.u;
        let url;
        try { url = new URL(target); } catch { return reply.code(400).send({ error: 'bad url' }); }
        if (url.protocol !== 'https:') return reply.code(400).send({ error: 'https only' });
        if (!ALLOWED_HOSTS.has(url.hostname)) return reply.code(400).send({ error: 'host not allowed' });

        const cached = cacheGet(url.href);
        if (cached) {
            reply.header('content-type', cached.contentType);
            reply.header('cache-control', 'public, max-age=43200, immutable');
            return reply.send(cached.buf);
        }

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url.href, {
                signal: ac.signal,
                headers: { 'user-agent': 'mailcow-rest-api/icon-proxy' },
                redirect: 'manual'
            });
        } catch (err) {
            clearTimeout(t);
            return reply.code(502).send({ error: 'upstream fetch failed', detail: String(err.message || err) });
        }
        clearTimeout(t);

        if (res.status >= 300 && res.status < 400) {
            return reply.code(502).send({ error: 'upstream redirected' });
        }

        if (!res.ok) {
            // Upstream 404/410 for missing icons is normal (gravatar d=404,
            // simple-icons unknown slug, DDG unknown domain). Return a 1x1
            // transparent GIF so the browser's img onload fires cleanly
            // instead of logging a network error to the console.
            const transparentGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
            reply.header('content-type', 'image/gif');
            reply.header('cache-control', 'public, max-age=86400');
            return reply.code(200).send(transparentGif);
        }

        const contentType = res.headers.get('content-type') || 'image/png';
        // Reject obviously-not-an-image content types so we don't proxy text.
        if (!/^image\//i.test(contentType) && !/^application\/(?:octet-stream|x-png)/i.test(contentType)) {
            return reply.code(415).send({ error: 'not an image' });
        }

        const reader = res.body?.getReader?.();
        if (!reader) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > MAX_BYTES) return reply.code(413).send({ error: 'too large' });
            cachePut(url.href, { buf, contentType, ts: Date.now() });
            reply.header('content-type', contentType);
            reply.header('cache-control', 'public, max-age=43200, immutable');
            return reply.send(buf);
        }

        const { buf, exceeded } = await streamWithLimit(reader, MAX_BYTES);
        if (exceeded) return reply.code(413).send({ error: 'too large' });
        cachePut(url.href, { buf, contentType, ts: Date.now() });
        reply.header('content-type', contentType);
        reply.header('cache-control', 'public, max-age=43200, immutable');
        return reply.send(buf);
    });
};
