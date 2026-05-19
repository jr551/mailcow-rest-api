'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProvider, OPENAI_COMPAT_PRESETS, ANTHROPIC_DEFAULT } = require('../../src/llm');

// --- Preset baseUrl/model resolution for every openai-compat preset.

for (const [name, preset] of Object.entries(OPENAI_COMPAT_PRESETS)) {
    test(`resolveProvider: openai preset "${name}" applies preset baseUrl + model`, () => {
        const resolved = resolveProvider({ kind: 'openai', preset: name, apiKey: 'k' }, undefined);
        assert.equal(resolved.kind, 'openai');
        assert.equal(resolved.baseUrl, preset.baseUrl);
        assert.equal(resolved.model, preset.model);
        assert.equal(resolved.apiKey, 'k');
        assert.ok(resolved.timeoutMs > 0);
        assert.ok(resolved.maxInputChars > 0);
    });
}

test('resolveProvider: openai with no preset falls back to OpenAI defaults', () => {
    const resolved = resolveProvider({ kind: 'openai', apiKey: 'k' }, undefined);
    assert.equal(resolved.baseUrl, OPENAI_COMPAT_PRESETS.openai.baseUrl);
    assert.equal(resolved.model, OPENAI_COMPAT_PRESETS.openai.model);
});

// --- Anthropic kind.

test('resolveProvider: anthropic uses anthropic defaults', () => {
    const resolved = resolveProvider({ kind: 'anthropic', apiKey: 'sk-ant-xxx' }, undefined);
    assert.equal(resolved.kind, 'anthropic');
    assert.equal(resolved.baseUrl, ANTHROPIC_DEFAULT.baseUrl);
    assert.equal(resolved.model, ANTHROPIC_DEFAULT.model);
    assert.equal(resolved.apiKey, 'sk-ant-xxx');
});

// --- Override gating. allowClientOverride lives on the server config in
// src/routes/ai.js, but the resolver itself just merges override-over-default.
// The route is responsible for stripping the override when the flag is off.
// We mirror that contract here: simulate the route's gate, then call resolver.

function applyOverrideGate(serverDefault, override) {
    return serverDefault.allowClientOverride ? override : undefined;
}

test('resolveProvider: override allowed → caller-supplied baseUrl wins', () => {
    const serverDefault = { kind: 'openai', preset: 'mistral', apiKey: 'srv', allowClientOverride: true };
    const override = { baseUrl: 'http://custom.local/v1' };
    const gated = applyOverrideGate(serverDefault, override);
    const resolved = resolveProvider(serverDefault, gated);
    assert.equal(resolved.baseUrl, 'http://custom.local/v1');
    // Preset model still wins because override didn't supply a model.
    assert.equal(resolved.model, OPENAI_COMPAT_PRESETS.mistral.model);
});

test('resolveProvider: override blocked → override silently dropped', () => {
    const serverDefault = { kind: 'openai', preset: 'mistral', apiKey: 'srv', allowClientOverride: false };
    const override = { baseUrl: 'http://attacker.example/v1', apiKey: 'leaked' };
    const gated = applyOverrideGate(serverDefault, override);
    const resolved = resolveProvider(serverDefault, gated);
    assert.equal(resolved.baseUrl, OPENAI_COMPAT_PRESETS.mistral.baseUrl);
    assert.equal(resolved.apiKey, 'srv');
});

// --- Model precedence.

test('resolveProvider: explicit override model wins over preset default', () => {
    const resolved = resolveProvider(
        { kind: 'openai', preset: 'mistral', apiKey: 'k' },
        { model: 'mistral-large-latest' }
    );
    assert.equal(resolved.model, 'mistral-large-latest');
    assert.equal(resolved.baseUrl, OPENAI_COMPAT_PRESETS.mistral.baseUrl);
});

test('resolveProvider: preset default fills in when no override model', () => {
    const resolved = resolveProvider(
        { kind: 'openai', preset: 'groq', apiKey: 'k' },
        {}
    );
    assert.equal(resolved.model, OPENAI_COMPAT_PRESETS.groq.model);
});

test('resolveProvider: server-default model survives when override has none', () => {
    const resolved = resolveProvider(
        { kind: 'openai', preset: 'mistral', apiKey: 'k', model: 'server-pinned-model' },
        undefined
    );
    assert.equal(resolved.model, 'server-pinned-model');
});

// --- timeoutMs / maxInputChars guards (zero/negative fall back to defaults).

test('resolveProvider: non-positive timeoutMs / maxInputChars fall back to safe defaults', () => {
    const resolved = resolveProvider(
        { kind: 'openai', preset: 'openai', apiKey: 'k', timeoutMs: 0, maxInputChars: -1 },
        undefined
    );
    assert.equal(resolved.timeoutMs, 30_000);
    assert.equal(resolved.maxInputChars, 24_000);
});

// --- MISTRAL_API_KEY backward-compat lives in src/config.js, not the resolver.
// We exercise it by reloading config with a faked env.

test('config: MISTRAL_API_KEY backward-compat sets apiKey + preset=mistral', () => {
    const savedKey = process.env.MISTRAL_API_KEY;
    const savedLlmKey = process.env.LLM_API_KEY;
    const savedPreset = process.env.LLM_PRESET;
    process.env.MISTRAL_API_KEY = 'mistral-test-key';
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_PRESET;
    delete require.cache[require.resolve('../../src/config')];
    try {
        const cfg = require('../../src/config');
        assert.equal(cfg.ai.apiKey, 'mistral-test-key');
        assert.equal(cfg.ai.preset, 'mistral');
        // And the resolver picks up the mistral baseUrl from that preset.
        const resolved = resolveProvider(cfg.ai, undefined);
        assert.equal(resolved.baseUrl, OPENAI_COMPAT_PRESETS.mistral.baseUrl);
        assert.equal(resolved.apiKey, 'mistral-test-key');
    } finally {
        if (savedKey === undefined) delete process.env.MISTRAL_API_KEY;
        else process.env.MISTRAL_API_KEY = savedKey;
        if (savedLlmKey !== undefined) process.env.LLM_API_KEY = savedLlmKey;
        if (savedPreset !== undefined) process.env.LLM_PRESET = savedPreset;
        delete require.cache[require.resolve('../../src/config')];
    }
});
