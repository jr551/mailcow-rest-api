'use strict';

// Pluggable LLM provider layer.
//
// We support two protocols, which between them cover virtually every public
// chat-completion API:
//
//   * openai-compatible — POST /chat/completions with bearer auth.
//     Works for: OpenAI, Mistral, Together, Groq, Anyscale, Perplexity,
//     Ollama (with /v1/ prefix), LM Studio, vLLM, and most self-hosted
//     gateways (LiteLLM, OpenRouter, etc.).
//
//   * anthropic — POST /messages with x-api-key auth and a system field.
//
// A provider config is a plain object:
//   { kind: 'openai' | 'anthropic', baseUrl, apiKey, model, timeoutMs?, maxInputChars? }
//
// Callers can pass a `providerOverride` (e.g. from request body) to use a
// per-call provider. Otherwise the server's env-derived default is used.

const { request, Agent } = require('undici');

// undici's default Agent has a 10s connect timeout — too tight for the
// LiteLLM proxy on a contended deploy host (we were getting 502
// "Connect Timeout Error" mid-day). Use a dedicated agent with a
// generous 30s connect + headers timeout aligned with the chat
// timeout. bodyTimeout is left default since reasoning models can
// take a while to stream the full reply.
const llmAgent = new Agent({
    connect: { timeout: 30_000 },
    headersTimeout: 30_000,
    bodyTimeout: 90_000
});

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_CHARS = 24_000;

const OPENAI_COMPAT_PRESETS = {
    mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-70b-versatile' },
    together: { baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3-8b-chat-hf' },
    ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
    perplexity: { baseUrl: 'https://api.perplexity.ai', model: 'llama-3.1-sonar-small-128k-chat' },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-8b-instruct' }
};

const ANTHROPIC_DEFAULT = { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest' };
const ANTHROPIC_VERSION = '2023-06-01';

function clip(text, max) {
    if (!text) return '';
    const s = String(text);
    return s.length > max ? s.slice(0, max) + '\n…(truncated)' : s;
}

function extractErrorDetail(body, status) {
    if (!body) return `Provider returned ${status}`;
    if (typeof body.message === 'string') return body.message;
    const err = body.error;
    if (typeof err === 'string') return err;
    if (err && typeof err.message === 'string') return err.message;
    return `Provider returned ${status}`;
}

function mapHttpStatus(status, body) {
    const detail = extractErrorDetail(body, status);
    if (status === 401 || status === 403) return { status: 502, title: 'AI provider rejected our credentials', detail };
    if (status === 404) return { status: 502, title: 'AI provider endpoint not found', detail };
    if (status === 429) return { status: 429, title: 'AI provider rate limit', detail };
    if (status >= 500) return { status: 502, title: 'AI provider upstream error', detail };
    return { status: 502, title: `AI provider returned ${status}`, detail };
}

// Resolve a provider config: merge per-call override over server defaults
// and apply preset baseUrl/model when only `kind` was specified.
function resolveProvider(serverDefault, override) {
    const merged = { ...(serverDefault || {}), ...(override || {}) };
    const kind = merged.kind || merged.provider || 'openai';
    const base = { ...merged, kind };

    if (kind === 'openai') {
        const preset = OPENAI_COMPAT_PRESETS[(override && override.preset) || merged.preset || ''];
        if (preset) {
            base.baseUrl = base.baseUrl || preset.baseUrl;
            base.model = base.model || preset.model;
        }
        base.baseUrl = base.baseUrl || OPENAI_COMPAT_PRESETS.openai.baseUrl;
        base.model = base.model || OPENAI_COMPAT_PRESETS.openai.model;
    } else if (kind === 'anthropic') {
        base.baseUrl = base.baseUrl || ANTHROPIC_DEFAULT.baseUrl;
        base.model = base.model || ANTHROPIC_DEFAULT.model;
    }
    // Both must be strictly positive: AbortSignal.timeout(0) throws, and
    // a 0 char limit would clip every input to an empty string.
    base.timeoutMs = (Number.isFinite(base.timeoutMs) && base.timeoutMs > 0) ? base.timeoutMs : DEFAULT_TIMEOUT_MS;
    base.maxInputChars = (Number.isFinite(base.maxInputChars) && base.maxInputChars > 0) ? base.maxInputChars : DEFAULT_MAX_INPUT_CHARS;
    return base;
}

// Adapter for OpenAI / Mistral / Ollama / etc. (any /chat/completions endpoint).
// `extra` lets callers override the body knobs we set by default — e.g.
// sort-inbox needs a much higher max_tokens and json_object response
// format. Unknown keys fall straight through to the provider.
async function callOpenAiCompat({ provider, messages, fetcher = request, signal, extra = {} }) {
    if (!provider.apiKey && provider.kind !== 'openai-compat-noauth') {
        // Local servers (Ollama, LM Studio) often need no key. They also accept
        // any non-empty bearer string. Use a placeholder so callers don't have
        // to special-case it server-side.
        provider.apiKey = provider.apiKey || 'sk-no-key';
    }
    const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const ac = signal ?? AbortSignal.timeout(provider.timeoutMs);
    let res;
    try {
        res = await fetcher(url, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${provider.apiKey}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: provider.model,
                messages,
                temperature: 0.2,
                max_tokens: 600,
                // Default reasoning models to low effort. Without this,
                // mail-ai (a reasoning model behind LiteLLM) was burning
                // 500+ tokens on `reasoning_content` and truncating the
                // actual `content` JSON mid-string. Callers that want
                // deeper reasoning can pass extra.reasoning_effort.
                reasoning_effort: 'low',
                ...extra
            }),
            signal: ac,
            // Use the long-timeout agent so the LiteLLM proxy doesn't
            // 502 on a busy day from undici's default 10s connect cap.
            dispatcher: llmAgent
        });
    } catch (err) {
        return { ok: false, status: 502, title: 'AI provider unreachable', detail: err.message || 'fetch failed' };
    }
    let body = null;
    try { body = await res.body.json(); } catch { body = null; }
    if (res.statusCode >= 400) return { ok: false, ...mapHttpStatus(res.statusCode, body) };
    const choice = body && body.choices && body.choices[0];
    const msg = (choice && choice.message) || {};
    // Reasoning models (DeepSeek v4-pro, o-series, anything routed by the
    // LiteLLM mail-ai alias) often return content: null and put the real
    // answer in reasoning / reasoning_content / reasoning_details. Fall
    // back through them so we don't 502 on a perfectly good response.
    const content = (() => {
        if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
        if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content.trim();
        if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) return msg.reasoning.trim();
        if (Array.isArray(msg.reasoning_details)) {
            const joined = msg.reasoning_details.map((d) => (d && typeof d.text === 'string') ? d.text : '').join('').trim();
            if (joined) return joined;
        }
        return '';
    })();
    if (!content) return { ok: false, status: 502, title: 'Empty AI response', detail: 'Provider returned no content' };
    return { ok: true, content, model: provider.model };
}

// Anthropic /messages adapter.
async function callAnthropic({ provider, system, userMessages, fetcher, signal }) {
    if (!provider.apiKey) {
        return { ok: false, status: 501, title: 'AI not configured', detail: 'No API key for provider "anthropic"' };
    }
    const url = provider.baseUrl.replace(/\/+$/, '') + '/messages';
    const ac = signal ?? AbortSignal.timeout(provider.timeoutMs);
    let res;
    try {
        res = await fetcher(url, {
            method: 'POST',
            headers: {
                'x-api-key': provider.apiKey,
                'anthropic-version': ANTHROPIC_VERSION,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: provider.model,
                system,
                messages: userMessages,
                max_tokens: 600,
                temperature: 0.2
            }),
            signal: ac
        });
    } catch (err) {
        return { ok: false, status: 502, title: 'AI provider unreachable', detail: err.message || 'fetch failed' };
    }
    let body = null;
    try { body = await res.body.json(); } catch { body = null; }
    if (res.statusCode >= 400) return { ok: false, ...mapHttpStatus(res.statusCode, body) };
    const text = body && Array.isArray(body.content)
        ? body.content.filter((p) => p.type === 'text').map((p) => p.text).join('').trim()
        : '';
    if (!text) return { ok: false, status: 502, title: 'Empty AI response', detail: 'Provider returned no content' };
    return { ok: true, content: text, model: provider.model };
}

// Public: run a chat completion regardless of provider kind. `extra` is
// forwarded to the OpenAI-compat body — sort-inbox uses it to lift the
// max_tokens cap and request a json_object response_format.
async function chat({ provider, system, userPrompt, fetcher = request, signal, extra }) {
    if (!provider.apiKey) {
        return { ok: false, status: 501, title: 'AI not configured', detail: 'No API key set for AI provider' };
    }
    if (provider.kind === 'anthropic') {
        return callAnthropic({
            provider,
            system,
            userMessages: [{ role: 'user', content: userPrompt }],
            fetcher,
            signal
        });
    }
    return callOpenAiCompat({
        provider,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt }
        ],
        fetcher,
        signal,
        extra
    });
}

const SUMMARY_SYSTEM = [
    'You summarize email messages.',
    'Reply with a tight summary in 3–5 short bullet points.',
    'Lead with the sender intent. Surface dates, deadlines, money, and explicit asks.',
    'No preamble, no closing line, no markdown headers.'
].join(' ');

const REPLY_SYSTEM = [
    'You draft email replies on behalf of the user.',
    'Match the tone of the source message but stay concise and professional.',
    'Output ONLY the reply body — no greeting line "Subject:", no signature block, no commentary.',
    'If the user supplies an "intent", honor it. Otherwise, write a neutral acknowledgement that addresses the asks.'
].join(' ');

const ACTION_SYSTEM = [
    'You extract action items from an email message.',
    'Reply with a checklist of clear, atomic tasks for the recipient. One task per line, prefixed with "- [ ] ".',
    'Skip pleasantries. If the message has no actionable items, reply with "(no action items)".'
].join(' ');

const TRANSLATE_SYSTEM_PREFIX = 'You translate email messages. Translate the entire message into ';

const SORT_INBOX_SYSTEM = [
    'You triage an email inbox. For each email, return a relevance level + a category + a flag for whether a real human (not a mailmerge / no-reply / list) wrote it.',
    'Levels: 5 = a real person waiting on the user (treat as extreme relevance), 4 = important / time-sensitive, 3 = useful FYI, 2 = marketing / promotional, 1 = newsletters or low-signal.',
    'Categories: "human" = a real person addressing the user directly, "important" = automated but action-needed (alerts, security, receipts, deadlines), "marketing" = sales/promotional/newsletters, "info" = everything else.',
    '"human": true ONLY when the message is from a real person (no "no-reply", no "newsletter@", not an obvious template). Genuine human emails should be at the top — set level=5.',
    'Return ONLY a valid JSON object: {"rankings":[{"uid":1001,"level":5,"category":"human","human":true,"reason":"short"},...]}',
    'Sort the array from highest relevance (level 5) to lowest (level 1).'
].join(' ');

async function summarize({ text, maxWords, provider, fetcher, signal }) {
    const limit = Number.isFinite(maxWords) && maxWords > 0 ? Math.min(400, Math.floor(maxWords)) : 120;
    const clipped = clip(text, provider.maxInputChars);
    const userPrompt = `Summarize this email in at most ${limit} words.\n\n--- BEGIN MESSAGE ---\n${clipped}\n--- END MESSAGE ---`;
    return chat({ provider, system: SUMMARY_SYSTEM, userPrompt, fetcher, signal });
}

async function draftReply({ thread, intent, provider, fetcher, signal }) {
    const clipped = clip(thread, provider.maxInputChars);
    const userPrompt = intent
        ? `Intent for the reply: "${intent.trim().slice(0, 500)}"\n\n--- BEGIN THREAD ---\n${clipped}\n--- END THREAD ---`
        : `--- BEGIN THREAD ---\n${clipped}\n--- END THREAD ---`;
    return chat({ provider, system: REPLY_SYSTEM, userPrompt, fetcher, signal });
}

async function extractActions({ text, provider, fetcher, signal }) {
    const clipped = clip(text, provider.maxInputChars);
    const userPrompt = `Extract action items from this email.\n\n--- BEGIN MESSAGE ---\n${clipped}\n--- END MESSAGE ---`;
    return chat({ provider, system: ACTION_SYSTEM, userPrompt, fetcher, signal });
}

async function translate({ text, target, provider, fetcher, signal }) {
    const clipped = clip(text, provider.maxInputChars);
    const lang = (target || 'English').trim().slice(0, 60);
    const system = TRANSLATE_SYSTEM_PREFIX + lang +
        '. Preserve formatting, line breaks, and bullet structure. ' +
        'Do not add commentary or notes — only the translated body.';
    const userPrompt = `--- BEGIN MESSAGE ---\n${clipped}\n--- END MESSAGE ---`;
    return chat({ provider, system, userPrompt, fetcher, signal });
}

async function sortInbox({ messages, provider, fetcher, signal }) {
    // messages: [{ uid, subject, from, to, date }]
    const lines = (messages || []).map((m) => {
        const fromStr = Array.isArray(m.from) && m.from[0]
            ? (m.from[0].name || m.from[0].address || '')
            : (m.from || '');
        const toStr = Array.isArray(m.to) && m.to[0]
            ? (m.to[0].address || '')
            : (m.to || '');
        return `uid:${m.uid} | from:${fromStr} | to:${toStr} | date:${m.date || ''} | subject:${m.subject || '(no subject)'}`;
    }).join('\n');
    const clipped = clip(lines, provider.maxInputChars);
    const userPrompt = `Triage these emails by relevance + category. Return ONLY {"rankings":[{"uid":number,"level":1-5,"category":"human"|"important"|"marketing"|"info","human":boolean,"reason":"brief"}]} sorted level 5 → 1.\n\n${clipped}`;
    // Sorting many messages can take a while — bump timeout to 60s.
    const sortProvider = { ...provider, timeoutMs: Math.max(provider.timeoutMs, 60_000) };
    // ~50 tokens per ranking × up to 60 emails + JSON scaffolding fits in
    // 3500. The default 600-token cap was truncating the response mid-array
    // and the parser saw an unterminated JSON document → 502.
    // response_format json_object: most LiteLLM-aliased models honour it
    // and emit a clean object instead of wrapping in markdown code fences.
    const result = await chat({
        provider: sortProvider,
        system: SORT_INBOX_SYSTEM,
        userPrompt,
        fetcher,
        signal,
        extra: { max_tokens: 3500, response_format: { type: 'json_object' } }
    });
    if (!result.ok) return result;
    try {
        const text = result.content;
        // Accept either {"rankings":[...]} or a bare array, since some
        // models still emit the legacy shape — keeps old clients working.
        let arr;
        const objStart = text.indexOf('{');
        if (objStart !== -1) {
            const objEnd = text.lastIndexOf('}');
            try {
                const parsed = JSON.parse(text.slice(objStart, objEnd + 1));
                if (Array.isArray(parsed.rankings)) arr = parsed.rankings;
            } catch { /* fall through to array form */ }
        }
        if (!arr) {
            const start = text.indexOf('[');
            const end = text.lastIndexOf(']');
            if (start === -1 || end === -1 || end <= start) throw new Error('LLM did not return JSON');
            arr = JSON.parse(text.slice(start, end + 1));
        }
        if (!Array.isArray(arr)) throw new Error('Not an array');
        const VALID_CATS = new Set(['human', 'important', 'marketing', 'info']);
        const cleaned = arr
            .filter((i) => i && typeof i.uid === 'number' && typeof i.level === 'number')
            .map((i) => ({
                uid: i.uid,
                level: Math.max(1, Math.min(5, Math.round(i.level))),
                category: VALID_CATS.has(i.category) ? i.category : 'info',
                human: i.human === true,
                reason: String(i.reason || '')
            }));
        return { ok: true, content: cleaned, model: result.model };
    } catch (err) {
        return { ok: false, status: 502, title: 'Invalid AI sort response', detail: err.message || 'Could not parse JSON' };
    }
}

module.exports = {
    resolveProvider,
    chat,
    summarize,
    draftReply,
    extractActions,
    translate,
    sortInbox,
    OPENAI_COMPAT_PRESETS,
    ANTHROPIC_DEFAULT
};
