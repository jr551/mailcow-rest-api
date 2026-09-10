// One-shot helper that asks the LLM for the broadest sensible sender-block
// pattern for a given message — usually the whole domain, occasionally a
// subdomain wildcard. Returns a mailcow sender-policy pattern (e.g.
// "@spam.example", "*@*.mail.spam.example") or null when the model thinks
// only the exact address should be blocked.

import { settings, capabilities, aiAuthKey } from './settings.svelte';

const SYSTEM_PROMPT = [
    'You suggest a sender-block pattern for a mail server policy.',
    'Given a From address, display name, and subject, return strictly one JSON object:',
    '{ "pattern": string, "reason": string }',
    'Rules:',
    '- pattern must be one of: the exact address ("a@b.com"), a whole domain ("@b.com"),',
    '  or a wildcard ("*@*.b.com", "*promo*@b.com").',
    '- Prefer the whole domain for obvious bulk/marketing/spam senders.',
    '- Prefer the exact address for personal mail or ambiguous cases.',
    '- Never suggest patterns that would match a major provider domain',
    '  (gmail.com, outlook.com, yahoo.com, icloud.com, proton.me, etc.) —',
    '  use the exact address instead.',
    '- No prose, no code fences.'
].join('\n');

// Never return a bare major-provider domain no matter what the model says —
// blocking "@gmail.com" is unrecoverable for most users.
const MAJOR_DOMAINS: Record<string, true> = {
    'gmail.com': true, 'googlemail.com': true, 'outlook.com': true,
    'hotmail.com': true, 'live.com': true, 'yahoo.com': true,
    'icloud.com': true, 'me.com': true, 'proton.me': true,
    'protonmail.com': true, 'aol.com': true, 'msn.com': true,
    'mail.com': true, 'zoho.com': true, 'gmx.com': true, 'gmx.net': true
};

const PRESET_URLS: Record<string, string> = {
    mistral: 'https://api.mistral.ai/v1',
    openai: 'https://api.openai.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    together: 'https://api.together.xyz/v1',
    ollama: 'http://127.0.0.1:11434/v1',
    perplexity: 'https://api.perplexity.ai',
    openrouter: 'https://openrouter.ai/api/v1',
    deepseek: 'https://api.deepseek.com/v1'
};

const PRESET_MODELS: Record<string, string> = {
    mistral: 'mistral-small-latest',
    openai: 'gpt-4o-mini',
    groq: 'llama-3.1-70b-versatile',
    together: 'meta-llama/Llama-3-8b-chat-hf',
    ollama: 'llama3.1',
    perplexity: 'llama-3.1-sonar-small-128k-chat',
    openrouter: 'meta-llama/llama-3.1-8b-instruct',
    deepseek: 'deepseek-v4-flash'
};

export async function suggestBlockPattern(
    input: { from: string; fromName?: string; subject?: string },
    opts: { signal?: AbortSignal } = {}
): Promise<string | null> {
    const llm = settings.llm;
    const configured = capabilities.aiConfig?.configured
        || (settings.useCustomLlm && llm.apiKey && (llm.baseUrl || llm.preset));
    if (!configured) return null;

    const baseUrl = (capabilities.aiConfig?.configured
        ? capabilities.aiConfig.baseUrl
        : (llm.baseUrl || PRESET_URLS[llm.preset] || PRESET_URLS.openai)).replace(/\/+$/, '');
    const model = capabilities.aiConfig?.configured
        ? capabilities.aiConfig.model
        : (llm.model || PRESET_MODELS[llm.preset] || PRESET_MODELS.openai);
    const apiKey = capabilities.aiConfig?.configured ? aiAuthKey() : llm.apiKey;

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: [
                        `From: ${input.fromName ? `${input.fromName} <${input.from}>` : input.from}`,
                        `Subject: ${input.subject || '(no subject)'}`
                    ].join('\n')
                }
            ],
            temperature: 0,
            max_tokens: 500
        }),
        signal: opts.signal
    });
    if (!res.ok) return null;

    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let parsed: { pattern?: string };
    try { parsed = JSON.parse(m[0]); } catch { return null; }

    const p = String(parsed.pattern || '').trim().toLowerCase();
    if (!/^[a-z0-9@_.*-]+$/.test(p)) return null;
    const bare = p.replace(/^\*?@\*?\./, '@').replace(/^\*?@/, '');
    if (MAJOR_DOMAINS[bare]) return input.from;
    return p;
}
