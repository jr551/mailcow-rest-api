'use strict';

// Server-side link-safety lookup for the webmail's "check before you click"
// prompt.
//
// THE TRADE-OFF, stated once so nobody has to rediscover it: asking a third
// party about a link is itself a disclosure. Every destination a user clicks
// in a message is revealed to VirusTotal, which is a *different* leak from
// the tracking pixels the image proxy already defeats — those tell the
// SENDER that the mail was opened, this tells a third party WHICH link the
// reader picked, in a message that may itself be hostile. Worse, a hostile
// mail can embed a unique per-recipient link and learn "this person opened
// it and clicked" from VT's own logs. That is why the whole feature is
// switchable (settings.linkSafetyCheck), subordinate to the aiFeatures hard
// off, and never on by fiat for someone who did not ask for it.
//
// And the guarantee is weaker than users assume. A "no threats found" verdict
// means nobody has reported this exact URL yet, not that it is safe; a
// malicious URL that was never submitted reads as "no data", and a link that
// is clean today can be flagged tomorrow. The UI is worded to say that.
//
// The key never leaves this process. It is read from VIRUSTOTAL_API_KEY in
// config (like MISTRAL_API_KEY / LLM_API_KEY / BRAVE_SEARCH_API_KEY) and
// attached as the x-apikey header on a server-side fetch. The browser gets
// a verdict and a URL, nothing else — a browser-callable path that took the
// key would let any anonymous visitor burn the operator's quota.

const config = require('../config');
const { assertPublicDestination } = require('../utils/ssrf-guard');
const { problem } = require('../errors');

const VT_BASE = 'https://www.virustotal.com/api/v3';

// VirusTotal's free tier is 4 requests/min and 500/day. A UI that fires one
// lookup per click needs its own ceiling well under the global rate limiter,
// or one user clicking through a newsletter turns into a 429 from VT that
// the UI would report as "check failed" — indistinguishable from a real
// outage. The 429 VT sends is passed through so the client can say so.
const LOOKUP_TIMEOUT_MS = 5000;

// A URL verdict is stable — the same link in a newsletter and the same link
// in a reply should not cost two lookups, and re-clicking a link the user
// already checked must be instant. Cached in memory keyed by the URL
// identifier; process-local on purpose (no new persistence, no new
// migration, and this cache is disposable by nature).
//
// NEGATIVE results are cached too, with a shorter TTL: "never submitted" is
// the common case for any long tail link, and re-asking for every click in
// a mail full of tracking-unique URLs is exactly how the daily quota goes.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;        // 6h for a real verdict
const NOT_FOUND_TTL_MS = 60 * 60 * 1000;        // 1h for "never scanned"
const CACHE_MAX = 2000;

const cache = new Map(); // urlId -> { verdict, expires }

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) {
        cache.delete(key);
        return null;
    }
    // LRU bump
    cache.delete(key);
    cache.set(key, hit);
    return hit;
}

function cachePut(key, verdict, ttlMs) {
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { verdict, expires: Date.now() + ttlMs });
}

/** The VirusTotal URL identifier: base64 of the URL with the `=` padding
 *  stripped. NOT a hash and not URL-encoded. Getting this wrong does not
 *  error — VT answers 404 NotFound, which is indistinguishable from a URL
 *  that has genuinely never been scanned, so every link in the mail would
 *  silently report "no data" forever. */
function urlIdentifier(url) {
    return Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '');
}

function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Map VT's `last_analysis_stats` + the canonical `category` onto our own
// verdict names. The distinction that matters and is easy to lose: VT
// reports `harmless` only when at least one engine has an opinion, and
// `undetected` when none did. Collapsing undetected into harmless is a false
// all-clear — this feature exists to prevent exactly that.
function classify(attrs) {
    const stats = (attrs && attrs.last_analysis_stats) || {};
    const malicious = num(stats.malicious);
    const suspicious = num(stats.suspicious);
    const harmless = num(stats.harmless);
    const undetected = num(stats.undetected);
    const timeout = num(stats.timeout);

    // A category VT itself computed wins over re-deriving it from the
    // counts, so a phishing/other category survives to the UI.
    const category = typeof attrs?.category === 'string' ? attrs.category : '';

    if (malicious > 0) return { verdict: category === 'phishing' ? 'phishing' : 'malicious', malicious, suspicious, harmless, undetected, timeout };
    if (suspicious > 0) return { verdict: 'suspicious', malicious, suspicious, harmless, undetected, timeout };
    if (harmless > 0) return { verdict: 'harmless', malicious, suspicious, harmless, undetected, timeout };
    // No engine had an opinion. `timeout` alone (scanners timed out) is the
    // no-data case too, and is NOT harmless.
    if (undetected > 0 || timeout > 0) return { verdict: 'undetected', malicious, suspicious, harmless, undetected, timeout };
    // Every counter was zero and absent from the payload — a scan that has
    // not produced results yet. Deliberately its own state, never folded
    // into harmless.
    return { verdict: 'unavailable', malicious, suspicious, harmless, undetected, timeout };
}

async function lookup(urlId, apiKey, fetchImpl) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LOOKUP_TIMEOUT_MS);
    try {
        const res = await fetchImpl(`${VT_BASE}/urls/${encodeURIComponent(urlId)}`, {
            method: 'GET',
            headers: { 'x-apikey': apiKey, accept: 'application/json' },
            signal: ac.signal
        });

        if (res.status === 404) {
            // Never submitted, or submitted so recently that the report does
            // not exist yet. Submitting it for a fresh scan is possible but
            // is async (minutes) and spends quota the free tier cannot spare,
            // so this is reported as its own state rather than as safe.
            return { verdict: 'not_found' };
        }
        if (res.status === 429) {
            const err = new Error('VirusTotal rate limit reached');
            err.statusCode = 429;
            throw err;
        }
        if (res.status === 401 || res.status === 403) {
            const err = new Error('VirusTotal rejected the API key');
            err.statusCode = 502;
            err.logDetail = 'virustotal auth failed';
            throw err;
        }
        if (!res.ok) {
            const err = new Error('VirusTotal request failed');
            err.statusCode = 502;
            err.logDetail = `virustotal http ${res.status}`;
            throw err;
        }

        const body = await res.json();
        const data = body && typeof body.data === 'object' && body.data ? body.data : null;
        const attributes = (data && data.attributes) || {};
        return { ...classify(attributes), title: typeof attributes.title === 'string' ? attributes.title : '' };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = function linkCheckRoutes(app) {
    // GET /v1/link-check/config — the SPA needs to know whether the operator
    // configured a key so Settings can explain the feature being inert
    // rather than every click silently doing nothing.
    app.get('/v1/link-check/config', {
        config: { public: true, rateLimit: false },
        schema: {
            tags: ['link-check'],
            summary: 'Whether link-safety checking is configured server-side',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        configured: { type: 'boolean' }
                    }
                }
            }
        }
    }, async () => ({ configured: !!config.virustotal.apiKey }));

    app.get('/v1/link-check', {
        // Authenticated (no `public: true`), so the session hook applies and
        // this cannot be used anonymously to burn the operator's quota.
        // The global limiter applies too, plus the per-verdict cache below.
        schema: {
            tags: ['link-check'],
            summary: 'Look up a link destination with VirusTotal',
            description: 'Returns a reputation verdict for a URL. The VirusTotal key is held server-side and never sent to the browser. Note that this discloses the link to a third party.',
            querystring: {
                type: 'object',
                additionalProperties: false,
                required: ['url'],
                properties: { url: { type: 'string', minLength: 1 } }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        url: { type: 'string' },
                        verdict: {
                            type: 'string',
                            enum: ['malicious', 'phishing', 'suspicious', 'harmless', 'undetected', 'unavailable', 'not_found']
                        },
                        malicious: { type: 'integer' },
                        suspicious: { type: 'integer' },
                        harmless: { type: 'integer' },
                        undetected: { type: 'integer' },
                        timeout: { type: 'integer' },
                        title: { type: 'string' }
                    }
                },
                400: { type: 'object' },
                429: { type: 'object' },
                502: { type: 'object' }
            }
        }
    }, async (req, reply) => {
        const apiKey = config.virustotal.apiKey;
        if (!apiKey) {
            throw problem(501, 'Not Implemented', 'Link checking is not configured on this server');
        }

        const raw = String(req.query.url || '');

        // The server never fetches the URL — it only hands the string to
        // VirusTotal. But it still validates hard, for two reasons: a
        // loopback/private target would turn this into an internal network
        // probe helper for anyone with a session, and the URL is echoed
        // back to every user of the mailbox, so an unbounded string is a
        // cheap way to bloat the cache and the response.
        let validated;
        try {
            validated = await assertPublicDestination(raw);
        } catch (err) {
            throw problem(400, 'Bad Request', err.message || 'That link cannot be checked');
        }

        const url = validated.url.href;
        const urlId = urlIdentifier(url);

        const cached = cacheGet(urlId);
        if (cached) {
            reply.header('cache-control', 'private, max-age=600');
            return reply.send({ url, ...cached.verdict });
        }

        let verdict;
        try {
            verdict = await lookup(urlId, apiKey, (...args) => fetch(...args));
        } catch (err) {
            if (err.statusCode === 429) {
                throw problem(429, 'Too Many Requests', 'VirusTotal rate limit reached — try again shortly');
            }
            req.log.warn({ detail: err.logDetail || err.message }, 'link check failed');
            throw problem(502, 'Bad Gateway', 'The link check could not be completed');
        }

        const ttl = verdict.verdict === 'not_found' ? NOT_FOUND_TTL_MS : CACHE_TTL_MS;
        cachePut(urlId, verdict, ttl);

        reply.header('cache-control', 'private, max-age=600');
        return reply.send({ url, ...verdict });
    });
};

module.exports.urlIdentifier = urlIdentifier;
module.exports.classify = classify;
