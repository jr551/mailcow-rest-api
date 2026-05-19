'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const { ocrAttachment, pagesToText, buildDocumentChunk, mapMistralStatus } = require('../../src/ocr');
const { createOcrCache } = require('../../src/ocr-cache');

const baseConfig = {
    apiKey: 'test-key',
    model: 'mistral-ocr-latest',
    endpoint: 'https://api.mistral.ai/v1/ocr',
    timeoutMs: 5000,
    maxBytes: 50 * 1024 * 1024
};

function withMockAgent(fn) {
    return async () => {
        const original = getGlobalDispatcher();
        const agent = new MockAgent();
        agent.disableNetConnect();
        setGlobalDispatcher(agent);
        try {
            await fn(agent);
        } finally {
            setGlobalDispatcher(original);
            await agent.close();
        }
    };
}

test('returns 501 when MISTRAL_API_KEY is unset', async () => {
    const result = await ocrAttachment({
        buffer: Buffer.from('hello'),
        mimeType: 'application/pdf',
        config: { ...baseConfig, apiKey: '' }
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 501);
    assert.match(result.title, /not configured/i);
});

test('returns 422 for empty attachment', async () => {
    const result = await ocrAttachment({
        buffer: Buffer.alloc(0),
        mimeType: 'application/pdf',
        config: baseConfig
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
});

test('returns 413 when attachment exceeds maxBytes', async () => {
    const result = await ocrAttachment({
        buffer: Buffer.alloc(11),
        mimeType: 'application/pdf',
        config: { ...baseConfig, maxBytes: 10 }
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 413);
    assert.match(result.detail, /11 bytes/);
});

test('happy path returns full Mistral response', withMockAgent(async (agent) => {
    const pool = agent.get('https://api.mistral.ai');
    const expected = {
        model: 'mistral-ocr-latest',
        pages: [{ index: 0, markdown: '# Hello world' }],
        usage_info: { pages_processed: 1 }
    };
    pool.intercept({ path: '/v1/ocr', method: 'POST' }).reply(200, expected);

    const result = await ocrAttachment({
        buffer: Buffer.from('%PDF-1.4'),
        mimeType: 'application/pdf',
        filename: 'doc.pdf',
        config: baseConfig
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.response, expected);
}));

test('maps Mistral 401 to 502', withMockAgent(async (agent) => {
    const pool = agent.get('https://api.mistral.ai');
    pool.intercept({ path: '/v1/ocr', method: 'POST' })
        .reply(401, { object: 'error', message: 'Invalid API key' });

    const result = await ocrAttachment({
        buffer: Buffer.from('x'),
        mimeType: 'application/pdf',
        config: baseConfig
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.match(result.title, /credentials/i);
}));

test('maps Mistral 422 to 415 (unsupported media type)', withMockAgent(async (agent) => {
    const pool = agent.get('https://api.mistral.ai');
    pool.intercept({ path: '/v1/ocr', method: 'POST' })
        .reply(422, { object: 'error', message: 'Unsupported file type' });

    const result = await ocrAttachment({
        buffer: Buffer.from('x'),
        mimeType: 'application/x-weird',
        config: baseConfig
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 415);
}));

test('maps Mistral 429 to 429 and preserves Retry-After', withMockAgent(async (agent) => {
    const pool = agent.get('https://api.mistral.ai');
    pool.intercept({ path: '/v1/ocr', method: 'POST' })
        .reply(429, { object: 'error', message: 'rate-limit' }, { headers: { 'retry-after': '12' } });

    const result = await ocrAttachment({
        buffer: Buffer.from('x'),
        mimeType: 'application/pdf',
        config: baseConfig
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.retryAfter, '12');
}));

test('maps Mistral 5xx to 502', withMockAgent(async (agent) => {
    const pool = agent.get('https://api.mistral.ai');
    pool.intercept({ path: '/v1/ocr', method: 'POST' }).reply(503, { message: 'upstream' });

    const result = await ocrAttachment({
        buffer: Buffer.from('x'),
        mimeType: 'application/pdf',
        config: baseConfig
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.match(result.title, /upstream/i);
}));

test('buildDocumentChunk picks image_url for image/png', () => {
    const chunk = buildDocumentChunk(Buffer.from('xx'), 'image/png');
    assert.equal(chunk.type, 'image_url');
    assert.match(chunk.image_url, /^data:image\/png;base64,/);
});

test('buildDocumentChunk picks document_url for application/pdf', () => {
    const chunk = buildDocumentChunk(Buffer.from('xx'), 'application/pdf');
    assert.equal(chunk.type, 'document_url');
    assert.match(chunk.document_url, /^data:application\/pdf;base64,/);
});

test('buildDocumentChunk falls back to document_url for unknown mime', () => {
    const chunk = buildDocumentChunk(Buffer.from('xx'), 'application/x-zip');
    assert.equal(chunk.type, 'document_url');
});

test('mapMistralStatus surfaces detail message', () => {
    const m = mapMistralStatus(401, { message: 'bad key' });
    assert.equal(m.status, 502);
    assert.equal(m.detail, 'bad key');
});

test('pagesToText joins page markdowns with separator', () => {
    const text = pagesToText({ pages: [{ markdown: 'A' }, { markdown: 'B' }, { markdown: 'C' }] });
    assert.equal(text, 'A\n\n---\n\nB\n\n---\n\nC');
});

test('pagesToText handles empty pages array', () => {
    assert.equal(pagesToText({ pages: [] }), '');
    assert.equal(pagesToText({}), '');
    assert.equal(pagesToText(null), '');
});

test('cache hit skips Mistral call entirely', withMockAgent(async (agent) => {
    // No interceptors defined: any HTTP request will throw "no matching mock found".
    agent.get('https://api.mistral.ai'); // no .intercept() — strict
    const cache = createOcrCache({ filePath: ':memory:' });
    try {
        const buf = Buffer.from('PDF cached');
        cache.set(buf, baseConfig.model, { pages: [{ markdown: 'cached!' }] });
        const result = await ocrAttachment({
            buffer: buf,
            mimeType: 'application/pdf',
            config: baseConfig,
            cache
        });
        assert.equal(result.ok, true);
        assert.equal(result.cached, true);
        assert.equal(result.response.pages[0].markdown, 'cached!');
    } finally {
        cache.close();
    }
}));

test('cache miss writes the Mistral response to cache', withMockAgent(async (agent) => {
    const pool = agent.get('https://api.mistral.ai');
    const fresh = { model: 'mistral-ocr-latest', pages: [{ markdown: 'fresh' }] };
    pool.intercept({ path: '/v1/ocr', method: 'POST' }).reply(200, fresh);

    const cache = createOcrCache({ filePath: ':memory:' });
    try {
        const buf = Buffer.from('PDF first time');
        const result = await ocrAttachment({
            buffer: buf,
            mimeType: 'application/pdf',
            config: baseConfig,
            cache
        });
        assert.equal(result.ok, true);
        assert.equal(result.cached, false);
        assert.equal(cache.size(), 1);
        // Second call for same buffer hits cache (no interceptor defined for second call).
        const second = await ocrAttachment({
            buffer: buf,
            mimeType: 'application/pdf',
            config: baseConfig,
            cache
        });
        assert.equal(second.cached, true);
        assert.equal(second.response.pages[0].markdown, 'fresh');
    } finally {
        cache.close();
    }
}));

test('error responses are not cached', withMockAgent(async (agent) => {
    const pool = agent.get('https://api.mistral.ai');
    pool.intercept({ path: '/v1/ocr', method: 'POST' }).reply(429, { message: 'rate limit' });

    const cache = createOcrCache({ filePath: ':memory:' });
    try {
        const result = await ocrAttachment({
            buffer: Buffer.from('PDF'),
            mimeType: 'application/pdf',
            config: baseConfig,
            cache
        });
        assert.equal(result.ok, false);
        assert.equal(result.status, 429);
        assert.equal(cache.size(), 0, 'errors must not pollute cache');
    } finally {
        cache.close();
    }
}));
