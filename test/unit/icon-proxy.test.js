'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');

// The icon-proxy module keeps a module-level Map cache so the same instance
// is shared across `require()` calls within a single test process. Force a
// fresh require for every test so the cache state from one test doesn't leak
// into the next.
function loadIconProxyRoute() {
    delete require.cache[require.resolve('../../src/routes/icon-proxy')];
    return require('../../src/routes/icon-proxy');
}

async function buildApp() {
    const app = Fastify({ logger: false });
    const route = loadIconProxyRoute();
    await app.register(route);
    return app;
}

// Build a minimal Response-like object the route can consume. The icon route
// uses res.status, res.ok, res.headers.get(), res.body?.getReader?.() and
// res.arrayBuffer().
function makeResponse({ status = 200, contentType = 'image/png', body = Buffer.alloc(0), useReader = true }) {
    const ok = status >= 200 && status < 300;
    const headers = new Map([['content-type', contentType]]);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);

    let bodyObj = null;
    if (useReader && buf.length > 0) {
        // Single-chunk reader. Tests that need multi-chunk pass a custom one.
        let sent = false;
        bodyObj = {
            getReader() {
                return {
                    async read() {
                        if (sent) return { done: true, value: undefined };
                        sent = true;
                        return { done: false, value: new Uint8Array(buf) };
                    }
                };
            }
        };
    } else if (useReader) {
        // Empty body still needs a reader that yields done immediately.
        bodyObj = {
            getReader() {
                return {
                    async read() { return { done: true, value: undefined }; }
                };
            }
        };
    }

    return {
        status,
        ok,
        headers: { get: (k) => headers.get(String(k).toLowerCase()) || null },
        body: bodyObj,
        async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }
    };
}

function makeChunkedResponse({ status = 200, contentType = 'image/png', chunks = [] }) {
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
        },
        async arrayBuffer() { return Buffer.concat(chunks).buffer; }
    };
}

let originalFetch;
test.beforeEach(() => { originalFetch = global.fetch; });
test.afterEach(() => { global.fetch = originalFetch; });

test('icon-proxy: allowed host returns image bytes with cache headers', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);
    let called = 0;
    global.fetch = async () => { called++; return makeResponse({ body: png, contentType: 'image/png' }); };

    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/icon?u=' + encodeURIComponent('https://www.gravatar.com/avatar/abc')
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'image/png');
        assert.equal(res.headers['cache-control'], 'public, max-age=43200, immutable');
        assert.deepEqual(Buffer.from(res.rawPayload), png);
        assert.equal(called, 1);
    } finally { await app.close(); }
});

test('icon-proxy: disallowed host → 400 host not allowed', async () => {
    global.fetch = async () => { throw new Error('should not fetch'); };
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/icon?u=' + encodeURIComponent('https://evil.com/x.png')
        });
        assert.equal(res.statusCode, 400);
        assert.deepEqual(JSON.parse(res.body), { error: 'host not allowed' });
    } finally { await app.close(); }
});

test('icon-proxy: http:// URL → 400 https only', async () => {
    global.fetch = async () => { throw new Error('should not fetch'); };
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/icon?u=' + encodeURIComponent('http://www.gravatar.com/avatar/abc')
        });
        assert.equal(res.statusCode, 400);
        assert.deepEqual(JSON.parse(res.body), { error: 'https only' });
    } finally { await app.close(); }
});

test('icon-proxy: malformed URL → 400 bad url', async () => {
    global.fetch = async () => { throw new Error('should not fetch'); };
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/icon?u=' + encodeURIComponent('not-a-url')
        });
        assert.equal(res.statusCode, 400);
        assert.deepEqual(JSON.parse(res.body), { error: 'bad url' });
    } finally { await app.close(); }
});

test('icon-proxy: upstream 3xx redirect → 502 upstream redirected (SSRF guard)', async () => {
    global.fetch = async () => makeResponse({ status: 302, contentType: 'text/html', body: Buffer.alloc(0) });
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/icon?u=' + encodeURIComponent('https://icons.duckduckgo.com/ip3/example.com.ico')
        });
        assert.equal(res.statusCode, 502);
        assert.deepEqual(JSON.parse(res.body), { error: 'upstream redirected' });
    } finally { await app.close(); }
});

test('icon-proxy: upstream 404 → 200 with 1x1 transparent GIF', async () => {
    global.fetch = async () => makeResponse({ status: 404, contentType: 'text/html', body: Buffer.from('not found') });
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/icon?u=' + encodeURIComponent('https://www.gravatar.com/avatar/missing')
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'image/gif');
        const body = Buffer.from(res.rawPayload);
        // GIF89a magic bytes
        assert.equal(body.slice(0, 6).toString('ascii'), 'GIF89a');
        // Decoded length of the canonical 1x1 transparent GIF is 42 bytes.
        assert.equal(body.length, 42);
    } finally { await app.close(); }
});

test('icon-proxy: text/html content-type → 415 not an image', async () => {
    global.fetch = async () => makeResponse({ status: 200, contentType: 'text/html', body: Buffer.from('<html>') });
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/icon?u=' + encodeURIComponent('https://cdn.simpleicons.org/foo')
        });
        assert.equal(res.statusCode, 415);
        assert.deepEqual(JSON.parse(res.body), { error: 'not an image' });
    } finally { await app.close(); }
});

test('icon-proxy: upstream image larger than 200 KB → 413 too large', async () => {
    // Two chunks, each 150 KB → 300 KB total. The route caps at 200 KB.
    const chunks = [Buffer.alloc(150 * 1024, 0xaa), Buffer.alloc(150 * 1024, 0xbb)];
    global.fetch = async () => makeChunkedResponse({ status: 200, contentType: 'image/png', chunks });
    const app = await buildApp();
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/proxy/icon?u=' + encodeURIComponent('https://cdn.simpleicons.org/big')
        });
        assert.equal(res.statusCode, 413);
        assert.deepEqual(JSON.parse(res.body), { error: 'too large' });
    } finally { await app.close(); }
});

test('icon-proxy: second request to same URL is served from cache (fetch called once)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    let called = 0;
    global.fetch = async () => { called++; return makeResponse({ body: png, contentType: 'image/png' }); };

    const app = await buildApp();
    try {
        const url = '/v1/proxy/icon?u=' + encodeURIComponent('https://secure.gravatar.com/avatar/cached');
        const r1 = await app.inject({ method: 'GET', url });
        assert.equal(r1.statusCode, 200);
        const r2 = await app.inject({ method: 'GET', url });
        assert.equal(r2.statusCode, 200);
        assert.equal(called, 1, 'second hit must come from in-memory cache');
        assert.deepEqual(Buffer.from(r2.rawPayload), png);
    } finally { await app.close(); }
});
