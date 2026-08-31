// One-shot helper that asks the configured LLM for a tight subject line
// based on the body the user just typed. Used by Compose when the user
// hits Send without filling in the subject — we propose, they accept.
//
// Same provider plumbing as email-actions; we avoid going through the
// streaming chatTurn() because we only need a 6-token reply.

import { settings, capabilities } from './settings.svelte';
import { cachedChatCompletion } from './ai-cache.svelte';

const PRESETS: Record<string, { url: string; model: string }> = {
    mistral:    { url: 'https://api.mistral.ai/v1',          model: 'mistral-small-latest' },
    openai:     { url: 'https://api.openai.com/v1',          model: 'gpt-4o-mini' },
    groq:       { url: 'https://api.groq.com/openai/v1',     model: 'llama-3.1-70b-versatile' },
    together:   { url: 'https://api.together.xyz/v1',        model: 'meta-llama/Llama-3-8b-chat-hf' },
    ollama:     { url: 'http://127.0.0.1:11434/v1',          model: 'llama3.1' },
    perplexity: { url: 'https://api.perplexity.ai',          model: 'llama-3.1-sonar-small-128k-chat' },
    openrouter: { url: 'https://openrouter.ai/api/v1',       model: 'meta-llama/llama-3.1-8b-instruct' }
};

function resolve(): { baseUrl: string; model: string; apiKey: string } | null {
    if (capabilities.aiConfig?.configured) {
        return {
            baseUrl: capabilities.aiConfig.baseUrl.replace(/\/+$/, ''),
            model: capabilities.aiConfig.model,
            apiKey: capabilities.aiConfig.apiKey
        };
    }
    const llm = settings.llm;
    if (!settings.useCustomLlm || !llm.apiKey) return null;
    const preset = PRESETS[llm.preset] || PRESETS.openai;
    return {
        baseUrl: (llm.baseUrl || preset.url).replace(/\/+$/, ''),
        model: llm.model || preset.model,
        apiKey: llm.apiKey
    };
}

const SYS = [
    'Suggest one short subject line for the email below.',
    'Reply with ONLY the subject line — no quotes, no leading "Subject:", no period at the end.',
    'Up to 8 words. Match the tone of the body. Use Title Case unless the body is casual.',
    'If the body is empty or unclear, return: (no subject)'
].join(' ');

const SYS_PAIR = [
    'Suggest TWO contrasting short subject line options for the email below.',
    'Reply with EXACTLY two lines. No numbering, no quotes, no leading "Subject:".',
    'Each line up to 8 words. The first should be plain/literal; the second more punchy/hooky.',
    'Match the tone of the body. If the body is empty or unclear, reply with: (no subject)'
].join(' ');

export async function suggestSubject(body: string, opts: { signal?: AbortSignal } = {}): Promise<string | null> {
    const cfg = resolve();
    if (!cfg) return null;
    const text = (body || '').trim();
    if (text.length < 5) return null;
    try {
        const requestBody = JSON.stringify({
            model: cfg.model,
            messages: [
                { role: 'system', content: SYS },
                { role: 'user', content: text.slice(0, 4000) }
            ],
            temperature: 0.4,
            // Reasoning models (DeepSeek thinking, etc.) eat the budget
            // on chain-of-thought before emitting the answer, so we need
            // headroom even though the answer itself is tiny.
            max_tokens: 600,
            reasoning_effort: 'minimal',
            // LiteLLM passthrough for providers that key off this name.
            thinking: { type: 'disabled' }
        });
        // Hitting the wand twice on the same draft body within an hour
        // returns the same subject — no point burning a second LLM call
        // on it. The body is in the hash so any edit to the draft skips
        // the cache.
        const r = await cachedChatCompletion({
            baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body: requestBody,
            scope: 'subject-suggest', signal: opts.signal
        });
        if (!r.ok) return null;
        const data = JSON.parse(r.text);
        const msg = data?.choices?.[0]?.message ?? {};
        // DeepSeek thinking via LiteLLM puts the visible answer in
        // `content` but, when the budget is exhausted before the model
        // exits the <think> block, content is empty and the candidate
        // subject is the last sensible line of `reasoning_content`.
        let raw: string = (msg.content || '').trim();
        if (!raw) {
            const reasoning: string =
                msg.reasoning_content
                || msg.reasoning
                || msg.provider_specific_fields?.reasoning_content
                || '';
            raw = extractSubjectFromReasoning(reasoning);
        }
        // Strip surrounding quotes / "Subject:" prefixes / trailing punctuation.
        const cleaned = raw
            .trim()
            .replace(/^subject\s*:\s*/i, '')
            .replace(/^["'`]+|["'`]+$/g, '')
            .replace(/\.$/, '')
            .trim();
        if (!cleaned || /^\(?no subject\)?$/i.test(cleaned)) return null;
        return cleaned.slice(0, 120);
    } catch {
        return null;
    }
}

// Plural variant — asks for two contrasting subject options in one
// LLM call. Used by Compose's "Review and send" button so the user
// can pick the framing they prefer before the message ships.
export async function suggestSubjects(body: string, opts: { signal?: AbortSignal } = {}): Promise<string[]> {
    const cfg = resolve();
    if (!cfg) return [];
    const text = (body || '').trim();
    if (text.length < 5) return [];
    try {
        const requestBody = JSON.stringify({
            model: cfg.model,
            messages: [
                { role: 'system', content: SYS_PAIR },
                { role: 'user', content: text.slice(0, 4000) }
            ],
            temperature: 0.6,
            max_tokens: 800,
            reasoning_effort: 'minimal',
            thinking: { type: 'disabled' }
        });
        const r = await cachedChatCompletion({
            baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body: requestBody,
            scope: 'subject-suggest-pair', signal: opts.signal
        });
        if (!r.ok) return [];
        const data = JSON.parse(r.text);
        const msg = data?.choices?.[0]?.message ?? {};
        let raw: string = (msg.content || '').trim();
        if (!raw) {
            const reasoning: string = msg.reasoning_content || msg.reasoning
                || msg.provider_specific_fields?.reasoning_content || '';
            raw = reasoning;
        }
        const lines = raw
            .split(/\n+/)
            .map((l) => l.trim()
                .replace(/^[\d.)\-•*\s]+/, '')
                .replace(/^subject\s*:\s*/i, '')
                .replace(/^["'`]+|["'`]+$/g, '')
                .replace(/\.$/, '')
                .trim()
            )
            .filter((l) => l.length > 0 && l.length <= 120 && !/^\(?no subject\)?$/i.test(l));
        // Dedupe in case the model echoed the same line twice.
        const out: string[] = [];
        for (const l of lines) {
            if (!out.some((existing) => existing.toLowerCase() === l.toLowerCase())) out.push(l);
            if (out.length === 2) break;
        }
        return out;
    } catch {
        return [];
    }
}

// Best-effort recovery when a thinking model exhausts max_tokens before
// closing its </think> tag. The chain-of-thought usually ends with a
// candidate subject — we look for the last quoted string, then fall
// back to the last short non-empty line.
function extractSubjectFromReasoning(reasoning: string): string {
    if (!reasoning) return '';
    const quoted = reasoning.match(/"([^"\n]{2,80})"/g);
    if (quoted && quoted.length) {
        const last = quoted[quoted.length - 1].replace(/^"|"$/g, '');
        if (last) return last;
    }
    const lines = reasoning
        .split(/\n+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l.length <= 100 && !/[?:;]$/.test(l));
    if (!lines.length) return '';
    return lines[lines.length - 1];
}
