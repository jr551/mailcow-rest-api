// Generate 3 contextual AI actions for the currently-open email. Same
// endpoint resolution as the chat bot: the server's same-origin proxy when
// the server has AI configured, otherwise the user's provider directly.
// Each action returns a `prompt` you can drop into a new AI thread.

import { resolveProvider } from './llm-provider';

export interface EmailAction {
    title: string;     // short label (≤ 6 words)
    icon?: string;     // optional emoji
    prompt: string;    // full prompt to seed a new AI thread with
    web?: boolean;     // hint: this action wants web search
}

export interface SuggestInput {
    subject: string;
    from: string;
    body: string;
}

const SYSTEM_PROMPT = [
    'Suggest the 3 best next actions for the email below.',
    'Return JSON only: {"actions":[{"title":"...","icon":"...","prompt":"...","web":false}, ...]}.',
    '- Exactly 3 varied actions.',
    '- Title ≤ 5 words, imperative.',
    '- Icon: one emoji (📅 ✏️ 🔎 📝 🌐 🗑️ 🤝 📤).',
    '- Prompt: one full instruction; refer to "this email", not the sender by name.',
    '- web: true only when live search clearly helps.',
    '- Transactional/OTP/no-reply: archive / unsubscribe style.',
    '- Don\'t invent dates, names, or amounts.'
].join('\n');

function extractJson(text: string): string {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = (fence ? fence[1] : text).trim();
    const start = candidate.indexOf('{');
    if (start < 0) return candidate;
    let depth = 0;
    for (let i = start; i < candidate.length; i++) {
        if (candidate[i] === '{') depth++;
        else if (candidate[i] === '}') { depth--; if (!depth) return candidate.slice(start, i + 1); }
    }
    return candidate.slice(start);
}

export async function suggestEmailActions(
    input: SuggestInput,
    opts: { signal?: AbortSignal } = {}
): Promise<EmailAction[]> {
    const cfg = resolveProvider();
    if (!cfg) {
        throw new Error('Configure an OpenAI-compatible provider + API key in Settings → AI.');
    }
    const body = (input.body || '').slice(0, 5000);
    const userMsg = [
        `Subject: ${input.subject || '(no subject)'}`,
        `From: ${input.from || '(unknown)'}`,
        '',
        'Body:',
        body
    ].join('\n');

    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${cfg.apiKey}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: cfg.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userMsg }
            ],
            temperature: 0.2,
            // 3 actions × ~80 tokens each + JSON scaffolding fits in 800
            // once we add reasoning_effort=low to keep mail-ai's reasoning
            // tokens under 50. Without the throttle the full budget went
            // to chain-of-thought and the JSON came back truncated.
            max_tokens: 800,
            reasoning_effort: 'low',
            // Most providers honour json_object → no need to hope the model
            // emits clean JSON. LiteLLM passes this through to the backend.
            response_format: { type: 'json_object' }
        }),
        signal: opts.signal
    });
    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try { const j = await res.json(); detail = j?.error?.message || j?.message || detail; } catch { /* */ }
        throw new Error(`Provider: ${detail}`);
    }
    const r = await res.json();
    const m = r?.choices?.[0]?.message || {};
    const reasoning = typeof m.reasoning === 'string' ? m.reasoning : '';
    const detailText = Array.isArray(m.reasoning_details)
        ? m.reasoning_details.map((d: { text?: string }) => d?.text || '').join('')
        : '';
    const text = (m.content || reasoning || detailText || '').trim();
    if (!text) throw new Error('Provider returned an empty reply.');

    let parsed: { actions?: EmailAction[] } = {};
    try { parsed = JSON.parse(extractJson(text)); } catch { /* fall through */ }

    const out = Array.isArray(parsed.actions) ? parsed.actions : [];
    const cleaned = out
        .filter((a) => a && typeof a.title === 'string' && typeof a.prompt === 'string')
        .slice(0, 3)
        .map((a) => ({
            title: a.title.slice(0, 50),
            icon: a.icon ? String(a.icon).slice(0, 4) : '✨',
            prompt: a.prompt.slice(0, 600),
            web: !!a.web
        }));
    if (cleaned.length >= 2) return cleaned;
    // Graceful fallback — happens with reasoning models that ramble past the
    // token budget, providers that ignore JSON formatting hints, or 1×1 noise
    // we get back from local Ollamas. Better to give the user 3 generic
    // actions than a red error popup.
    return fallbackActions();
}

function fallbackActions(): EmailAction[] {
    return [
        {
            icon: '📝',
            title: 'Summarise',
            prompt: 'Summarise this email in 3 short bullets — the ask, the key facts, and what response (if any) is expected.',
            web: false
        },
        {
            icon: '✏️',
            title: 'Draft a reply',
            prompt: 'Draft a concise, friendly reply to this email. Match the sender\'s tone. End with a clear next step.',
            web: false
        },
        {
            icon: '📅',
            title: 'Extract dates',
            prompt: 'List every date, deadline, and concrete action item mentioned in this email. If nothing is time-bound, say so.',
            web: false
        }
    ];
}
