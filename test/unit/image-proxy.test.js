'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const imageProxyRoutes = require('../../src/routes/image-proxy');

// In-memory stand-in for image-proxy-cache. The route only ever calls these
// four methods, so a Map-backed shim is enough to exercise the SSRF / size
// branches without touching better-sqlite3.
function makeStubCache() {
    const store = new Map(); // url -> { data, contentType, size }
    const usage = new Map(); // user|day -> bytes
    const negative = new Map(); // url -> { status, reason, cachedAt }
    return {
        get(url) { return store.get(url) || null; },
        set(url, data, contentType) {
            store.set(url, { data, contentType, size: data.length });
            return true;
        },
        getUsage(user, day) { return usage.get(`${user}|${day}`) || 0; },
        incrementUsage(user, day, bytes) {
            const k = `${user}|${day}`;
            usage.set(k, (usage.get(k) || 0) + bytes);
        },
        getNegative(url, ttlMs, now = Date.now()) {
            const row = negative.get(url);
            if (!row) return null;
            if (now - row.cachedAt > ttlMs) { negative.delete(url); return null; }
            return row;
        },
        setNegative(url, status, reason, now = Date.now()) {
            negative.set(url, { status, reason: String(reason), cachedAt: now });
        }
    };
}

async function buildApp({ cache, maxBytesPerDay = 1024 * 1024 * 1024 } = {}) {
    const app = Fastify({ logger: false });
    // Mirror server.js's error handler so problem() throws produce
    // application/problem+json with the expected shape.
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    // Stub auth: every request gets a fixed user.
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(imageProxyRoutes, { cache: cache || makeStubCache(), maxBytesPerDay });
    return app;
}

// Reader-style fetch Response stub matching what the route consumes:
//   res.status, res.ok, res.headers.get(), res.body.getReader().read()
function makeResponse({ status = 200, contentType = 'image/png', body = Buffer.alloc(0), headers = {} }) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    let sent = false;
    const allHeaders = { 'content-type': contentType, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k) => allHeaders[String(k).toLowerCase()] ?? null },
        body: {
            getReader() {
                return {
                    async read() {
                        if (sent || buf.length === 0) return { done: true, value: undefined };
                        sent = true;
                        return { done: false, value: new Uint8Array(buf) };
                    }
                };
            },
            async cancel() { /* allow drain on redirect */ }
        }
    };
}

function makeChunkedResponse({ status = 200, contentType = 'image/png', chunks }) {
    let i = 0;
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
        body: {
            getReader() {
                return {
                    async read() {
                        if (i >= chunks.length) return { done: true, value: undefined };
                        return { done: false, value: new Uint8Array(chunks[i++]) };
                    }
                };
            }
        }
    };
}

let originalFetch;
test.beforeEach(() => { originalFetch = global.fetch; });
test.afterEach(() => { global.fetch = originalFetch; });

test('image-proxy: file:// scheme → 400 Only HTTP and HTTPS', async () => {
    global.fetch = async () => { throw new Error('should not fetch'); };
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/image?url=' + encodeURIComponent('file:///etc/passwd')
        });
        assert.equal(res.statusCode, 400);
        const body = JSON.parse(res.body);
        assert.equal(body.status, 400);
        assert.match(body.detail, /HTTP and HTTPS/);
    } finally { await app.close(); }
});

test('image-proxy: ftp:// scheme → 400 Only HTTP and HTTPS', async () => {
    global.fetch = async () => { throw new Error('should not fetch'); };
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/image?url=' + encodeURIComponent('ftp://example.com/x.png')
        });
        assert.equal(res.statusCode, 400);
        assert.match(JSON.parse(res.body).detail, /HTTP and HTTPS/);
    } finally { await app.close(); }
});

test('image-proxy: private IP 10.0.0.1 → 400 Private IP blocked', async () => {
    global.fetch = async () => { throw new Error('should not fetch'); };
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/image?url=' + encodeURIComponent('https://10.0.0.1/x.png')
        });
        assert.equal(res.statusCode, 400);
        assert.match(JSON.parse(res.body).detail, /Private IP/);
    } finally { await app.close(); }
});

test('image-proxy: link-local 169.254.169.254 (cloud metadata) → 400 blocked', async () => {
    global.fetch = async () => { throw new Error('should not fetch'); };
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/image?url=' + encodeURIComponent('https://169.254.169.254/latest/meta-data/')
        });
        assert.equal(res.statusCode, 400);
        assert.match(JSON.parse(res.body).detail, /Private IP/);
    } finally { await app.close(); }
});

test('image-proxy: localhost hostname → 400 blocked', async () => {
    global.fetch = async () => { throw new Error('should not fetch'); };
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/image?url=' + encodeURIComponent('https://localhost/x.png')
        });
        assert.equal(res.statusCode, 400);
        assert.match(JSON.parse(res.body).detail, /Private \/ localhost/);
    } finally { await app.close(); }
});

test('image-proxy: 127.0.0.1 literal → 400 blocked', async () => {
    global.fetch = async () => { throw new Error('should not fetch'); };
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/image?url=' + encodeURIComponent('https://127.0.0.1/x.png')
        });
        assert.equal(res.statusCode, 400);
        assert.match(JSON.parse(res.body).detail, /Private IP/);
    } finally { await app.close(); }
});

// The route validates the *literal* hostname only — DNS isn't resolved
// pre-fetch. So a hostname that looks public passes validation and the
// stubbed fetch path takes over. Real DNS resolution would need either a
// dns.lookup stub (out of scope here, no DI) or genuine network — neither
// fits these unit tests.
test.skip('image-proxy: hostname resolving to public IP → OK', () => {
    // The route does not perform DNS resolution before fetch (it relies on the
    // host string + connect-time behaviour), and there's no dependency-injected
    // DNS lookup to override. Covered indirectly by the success-path test below.
});

test('image-proxy: redirect to private IP is blocked (SSRF defence)', async () => {
    // The proxy now follows safe redirects (most CDN/tracking-pixel URLs
    // 302 to the actual asset host), but each hop is re-validated against
    // the SSRF allow-list. A redirect pointing at 127.0.0.1 must still
    // 502 with a clear "Redirect blocked" reason.
    global.fetch = async () => makeResponse({
        status: 302,
        contentType: 'text/html',
        headers: { location: 'http://127.0.0.1/secret' }
    });
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/image?url=' + encodeURIComponent('https://example.com/x.png')
        });
        assert.equal(res.statusCode, 502);
        assert.match(JSON.parse(res.body).detail, /Redirect blocked/);
    } finally { await app.close(); }
});

test('image-proxy: success returns bytes through with content-type', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xca, 0xfe]);
    let called = 0;
    global.fetch = async () => { called++; return makeResponse({ status: 200, contentType: 'image/png', body: png }); };
    const cache = makeStubCache();
    const app = await buildApp({ cache });
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/image?url=' + encodeURIComponent('https://example.com/ok.png')
        });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^image\/png/);
        assert.deepEqual(Buffer.from(res.rawPayload), png);
        assert.equal(called, 1);
    } finally { await app.close(); }
});

test('image-proxy: upstream body exceeds 1 MB cap → terminal 413', async () => {
    // Two 600 KB chunks → 1.2 MB total. Route streams via getReader and
    // bails when running total crosses MAX_IMAGE_BYTES (1 MB).
    const chunks = [Buffer.alloc(600 * 1024, 0xaa), Buffer.alloc(600 * 1024, 0xbb)];
    global.fetch = async () => makeChunkedResponse({ status: 200, contentType: 'image/png', chunks });
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/image?url=' + encodeURIComponent('https://example.com/huge.png')
        });
        // 413, not 502: an oversized image is a permanent property of the
        // resource, and 502 reads as transient so clients retry forever.
        assert.equal(res.statusCode, 413);
        assert.match(JSON.parse(res.body).detail, /1 MB limit/);
    } finally { await app.close(); }
});

test('image-proxy: a failed fetch is negatively cached, not re-fetched', async () => {
    const chunks = [Buffer.alloc(600 * 1024, 0xaa), Buffer.alloc(600 * 1024, 0xbb)];
    let upstreamCalls = 0;
    global.fetch = async () => {
        upstreamCalls++;
        return makeChunkedResponse({ status: 200, contentType: 'image/png', chunks });
    };
    const app = await buildApp();
    try {
        const url = '/v1/proxy/image?url=' + encodeURIComponent('https://example.com/huge-repeat.png');
        const first = await app.inject({ method: 'GET', url });
        const second = await app.inject({ method: 'GET', url });

        assert.equal(first.statusCode, 413);
        assert.equal(second.statusCode, 413);
        assert.match(JSON.parse(second.body).detail, /1 MB limit/);
        // The whole point: the second render must not hit the origin again.
        assert.equal(upstreamCalls, 1);
    } finally { await app.close(); }
});

test('image-proxy: upstream 404 is negatively cached too', async () => {
    let upstreamCalls = 0;
    global.fetch = async () => {
        upstreamCalls++;
        return makeChunkedResponse({ status: 404, contentType: 'text/html', chunks: [] });
    };
    const app = await buildApp();
    try {
        const url = '/v1/proxy/image?url=' + encodeURIComponent('https://example.com/gone.png');
        const first = await app.inject({ method: 'GET', url });
        const second = await app.inject({ method: 'GET', url });
        assert.equal(first.statusCode, 404);
        assert.equal(second.statusCode, 404);
        assert.equal(upstreamCalls, 1);
    } finally { await app.close(); }
});
