'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../../src/llm');

function fakeFetcher(replies) {
    let i = 0;
    return async (...args) => {
        const next = replies[i++];
        if (!next) throw new Error('fakeFetcher exhausted');
        if (typeof next === 'function') return next(...args);
        return next;
    };
}

function bodyJson(obj) {
    return { body: { json: async () => obj } };
}

function defaultProvider(over = {}) {
    return llm.resolveProvider(
        { kind: 'openai', preset: 'mistral', apiKey: 'sk-test', maxInputChars: 1000 },
        over
    );
}

// resolveProvider

test('resolveProvider: env mistral preset fills in baseUrl + model', () => {
    const p = llm.resolveProvider({ kind: 'openai', preset: 'mistral', apiKey: 'k' });
    assert.equal(p.baseUrl, 'https://api.mistral.ai/v1');
    assert.equal(p.model, 'mistral-small-latest');
    assert.equal(p.kind, 'openai');
});

test('resolveProvider: per-call override beats env', () => {
    const env = { kind: 'openai', preset: 'mistral', apiKey: 'env-k' };
    const p = llm.resolveProvider(env, { preset: 'groq', apiKey: 'user-k' });
    assert.equal(p.baseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(p.apiKey, 'user-k');
});

test('resolveProvider: explicit baseUrl + model wins over preset', () => {
    const p = llm.resolveProvider(
        { kind: 'openai', preset: 'mistral', apiKey: 'k' },
        { baseUrl: 'https://my-llm.example/v1', model: 'custom-3' }
    );
    assert.equal(p.baseUrl, 'https://my-llm.example/v1');
    assert.equal(p.model, 'custom-3');
});

test('resolveProvider: anthropic preset has correct defaults', () => {
    const p = llm.resolveProvider({ kind: 'anthropic', apiKey: 'k' });
    assert.equal(p.baseUrl, 'https://api.anthropic.com/v1');
    assert.match(p.model, /^claude/);
});

test('resolveProvider: unknown preset falls back to OpenAI defaults', () => {
    const p = llm.resolveProvider({ kind: 'openai', preset: 'wat-is-this', apiKey: 'k' });
    assert.equal(p.baseUrl, 'https://api.openai.com/v1');
});

test('resolveProvider: rejects timeoutMs <= 0', () => {
    // AbortSignal.timeout(0) throws — make sure resolveProvider clamps.
    const p = llm.resolveProvider({ kind: 'openai', preset: 'mistral', apiKey: 'k', timeoutMs: 0 });
    assert.equal(p.timeoutMs, 30_000);
    const p2 = llm.resolveProvider({ kind: 'openai', preset: 'mistral', apiKey: 'k', timeoutMs: -5 });
    assert.equal(p2.timeoutMs, 30_000);
});

test('resolveProvider: rejects maxInputChars <= 0', () => {
    // 0 would clip every input to '' and break the AI features silently.
    const p = llm.resolveProvider({ kind: 'openai', preset: 'mistral', apiKey: 'k', maxInputChars: 0 });
    assert.equal(p.maxInputChars, 24_000);
});

// summarize / draftReply / extractActions / translate

test('summarize: 501 when no API key', async () => {
    const provider = llm.resolveProvider({ kind: 'openai', preset: 'mistral' }, { apiKey: '' });
    const r = await llm.summarize({ text: 'hi', provider });
    assert.equal(r.ok, false);
    assert.equal(r.status, 501);
});

test('summarize: success path returns content + model', async () => {
    const fetcher = fakeFetcher([{
        statusCode: 200,
        ...bodyJson({ choices: [{ message: { content: '- bullet 1' } }] })
    }]);
    const r = await llm.summarize({ text: 'body', provider: defaultProvider(), fetcher });
    assert.equal(r.ok, true);
    assert.match(r.content, /bullet 1/);
    assert.equal(r.model, 'mistral-small-latest');
});

test('summarize: clips oversized input', async () => {
    let captured;
    const fetcher = async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { statusCode: 200, ...bodyJson({ choices: [{ message: { content: 'ok' } }] }) };
    };
    const long = 'x'.repeat(50_000);
    await llm.summarize({ text: long, provider: defaultProvider(), fetcher });
    const userMsg = captured.messages.find((m) => m.role === 'user').content;
    assert.ok(userMsg.length < 5000, 'user message should be clipped');
    assert.match(userMsg, /truncated/);
});

test('summarize: 401 maps to 502 with credentials title', async () => {
    const fetcher = fakeFetcher([{ statusCode: 401, ...bodyJson({ error: { message: 'bad key' } }) }]);
    const r = await llm.summarize({ text: 'x', provider: defaultProvider(), fetcher });
    assert.equal(r.status, 502);
    assert.match(r.title, /credentials/);
});

test('summarize: 429 surfaces as rate limit', async () => {
    const fetcher = fakeFetcher([{ statusCode: 429, ...bodyJson({ error: { message: 'slow down' } }) }]);
    const r = await llm.summarize({ text: 'x', provider: defaultProvider(), fetcher });
    assert.equal(r.status, 429);
});

test('draftReply: passes intent into prompt', async () => {
    let captured;
    const fetcher = async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { statusCode: 200, ...bodyJson({ choices: [{ message: { content: 'reply' } }] }) };
    };
    await llm.draftReply({
        thread: 'Hi can you confirm?',
        intent: 'decline politely',
        provider: defaultProvider(),
        fetcher
    });
    const userMsg = captured.messages.find((m) => m.role === 'user').content;
    assert.match(userMsg, /decline politely/);
});

test('draftReply: empty content surfaces 502', async () => {
    const fetcher = fakeFetcher([{ statusCode: 200, ...bodyJson({ choices: [{ message: { content: '' } }] }) }]);
    const r = await llm.draftReply({ thread: 'x', provider: defaultProvider(), fetcher });
    assert.equal(r.status, 502);
});

test('extractActions: hits chat/completions with checklist system prompt', async () => {
    let captured;
    const fetcher = async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { statusCode: 200, ...bodyJson({ choices: [{ message: { content: '- [ ] do it' } }] }) };
    };
    const r = await llm.extractActions({ text: 'meeting at 2pm bring slides', provider: defaultProvider(), fetcher });
    assert.equal(r.ok, true);
    const sys = captured.messages.find((m) => m.role === 'system').content;
    assert.match(sys, /action items/);
});

test('translate: includes target language in system prompt', async () => {
    let captured;
    const fetcher = async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { statusCode: 200, ...bodyJson({ choices: [{ message: { content: 'hola' } }] }) };
    };
    await llm.translate({ text: 'hello', target: 'Spanish', provider: defaultProvider(), fetcher });
    const sys = captured.messages.find((m) => m.role === 'system').content;
    assert.match(sys, /Spanish/);
});

test('network error surfaces as 502 unreachable', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const r = await llm.summarize({ text: 'x', provider: defaultProvider(), fetcher });
    assert.equal(r.status, 502);
    assert.match(r.title, /unreachable/);
});

// Anthropic adapter

test('anthropic: sends x-api-key + system field, parses content[].text', async () => {
    let capturedUrl, capturedHeaders, capturedBody;
    const fetcher = async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        capturedBody = JSON.parse(opts.body);
        return { statusCode: 200, ...bodyJson({ content: [{ type: 'text', text: 'summary' }] }) };
    };
    const provider = llm.resolveProvider({ kind: 'anthropic', apiKey: 'sk-ant', maxInputChars: 1000 });
    const r = await llm.summarize({ text: 'hi', provider, fetcher });
    assert.equal(r.ok, true);
    assert.match(capturedUrl, /\/messages$/);
    assert.equal(capturedHeaders['x-api-key'], 'sk-ant');
    assert.ok(capturedHeaders['anthropic-version']);
    assert.ok(capturedBody.system);
    assert.equal(r.content, 'summary');
});

test('anthropic: missing key returns 501', async () => {
    const provider = llm.resolveProvider({ kind: 'anthropic' }, { apiKey: '' });
    const r = await llm.summarize({ text: 'x', provider });
    assert.equal(r.status, 501);
});

// OpenAI-compatible custom endpoint (e.g., Ollama)

test('openai-compat: respects custom baseUrl (Ollama-style)', async () => {
    let url;
    const fetcher = async (u) => {
        url = u;
        return { statusCode: 200, ...bodyJson({ choices: [{ message: { content: 'ok' } }] }) };
    };
    const provider = llm.resolveProvider(
        { kind: 'openai' },
        { baseUrl: 'http://my-ollama:11434/v1', model: 'llama3.1', apiKey: 'sk-no-key' }
    );
    await llm.summarize({ text: 'x', provider, fetcher });
    assert.equal(url, 'http://my-ollama:11434/v1/chat/completions');
});
