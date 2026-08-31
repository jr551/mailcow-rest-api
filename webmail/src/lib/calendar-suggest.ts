// One-shot helper that asks the user's LLM to extract a calendar event from
// an email body. Single completion, no tools — keeps the budget tight and
// the latency low. Returns a partial CalEvent ready to seed EventModal.

import { settings, capabilities, aiAuthKey } from './settings.svelte';
import type { CalEvent } from './calendar.svelte';

export interface SuggestInput {
    subject: string;
    from: string;
    body: string;
    /** Reference date for relative phrases like "Friday at 3" — defaults to now. */
    now?: Date;
}

export interface SuggestedEvent extends Partial<CalEvent> {
    /** Set when the model decided there is no event in the message. */
    noEvent?: boolean;
    /** Free-text reason from the model (helps debug "noEvent" cases). */
    reason?: string;
}

const SYSTEM_PROMPT = [
    'You extract calendar events from emails.',
    'Return strictly one JSON object — no prose, no code fences.',
    'Schema:',
    '{ "noEvent": boolean, "reason": string,',
    '  "title": string, "start": string, "end": string, "allDay": boolean,',
    '  "location": string, "description": string }',
    'Rules:',
    '- start/end are ISO 8601 (e.g. "2026-05-02T14:00:00") in the email\'s implied timezone.',
    '- For all-day events use "YYYY-MM-DD" and allDay=true.',
    '- If the email is not about a specific upcoming event, set noEvent=true and leave fields empty.',
    '- Default duration to 1 hour if only a start time is given.',
    '- Resolve relative dates against the reference date you are given.',
    '- Title should be short (≤ 60 chars).',
    '- Description is a one or two sentence summary, not the full email.'
].join('\n');

function resolveBaseUrl(): string {
    if (capabilities.aiConfig?.configured) return capabilities.aiConfig.baseUrl.replace(/\/+$/, '');
    const llm = settings.llm;
    if (llm.baseUrl) return llm.baseUrl.replace(/\/+$/, '');
    const presets: Record<string, string> = {
        mistral: 'https://api.mistral.ai/v1',
        openai: 'https://api.openai.com/v1',
        groq: 'https://api.groq.com/openai/v1',
        together: 'https://api.together.xyz/v1',
        ollama: 'http://127.0.0.1:11434/v1',
        perplexity: 'https://api.perplexity.ai',
        openrouter: 'https://openrouter.ai/api/v1'
    };
    return presets[llm.preset] || presets.openai;
}

function resolveModel(): string {
    if (capabilities.aiConfig?.configured) return capabilities.aiConfig.model;
    const llm = settings.llm;
    if (llm.model) return llm.model;
    const defaults: Record<string, string> = {
        mistral: 'mistral-small-latest',
        openai: 'gpt-4o-mini',
        groq: 'llama-3.1-70b-versatile',
        together: 'meta-llama/Llama-3-8b-chat-hf',
        ollama: 'llama3.1',
        perplexity: 'llama-3.1-sonar-small-128k-chat',
        openrouter: 'meta-llama/llama-3.1-8b-instruct'
    };
    return defaults[llm.preset] || defaults.openai;
}

function resolveApiKey(): string {
    if (capabilities.aiConfig?.configured) return aiAuthKey();
    return settings.llm.apiKey;
}

function isConfigured(): boolean {
    if (capabilities.aiConfig?.configured) return true;
    const llm = settings.llm;
    return !!(settings.useCustomLlm && llm.apiKey && (llm.baseUrl || llm.preset));
}

/** Strip code fences / common LLM artefacts before JSON.parse. */
function extractJsonObject(text: string): string {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = (fenceMatch ? fenceMatch[1] : text).trim();
    // Find the first balanced {...} block.
    const start = candidate.indexOf('{');
    if (start === -1) return candidate;
    let depth = 0;
    for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return candidate.slice(start, i + 1); }
    }
    return candidate.slice(start);
}

export async function suggestEventFromEmail(input: SuggestInput, opts: { signal?: AbortSignal } = {}): Promise<SuggestedEvent> {
    if (!isConfigured()) {
        throw new Error('Configure an OpenAI-compatible provider + API key in Settings → AI.');
    }
    const baseUrl = resolveBaseUrl();
    const model = resolveModel();
    const apiKey = resolveApiKey();
    const now = input.now ?? new Date();

    // Cap body to keep input small. We've already filtered HTML on the client.
    const body = (input.body || '').slice(0, 6000);
    const userMsg = [
        `Reference date: ${now.toISOString()}`,
        `Subject: ${input.subject || '(no subject)'}`,
        `From: ${input.from || '(unknown)'}`,
        '',
        'Email body:',
        body
    ].join('\n');

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userMsg }
            ],
            temperature: 0,
            // response_format json_object isn't universally supported (DeepSeek
            // reasoning models, Ollama, etc.); the system prompt is strict
            // enough and extractJsonObject() handles fences/prose.
            // Generous token budget so reasoning models still have room to
            // produce visible JSON after their hidden thought.
            max_tokens: 2000
        }),
        signal: opts.signal
    });

    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
            const j = await res.json();
            detail = j?.error?.message || j?.message || detail;
        } catch { /* ignore */ }
        const keyHint = apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : 'none';
        throw new Error(`Provider: ${detail} (url=${baseUrl}, model=${model}, key=${keyHint}, server=${capabilities.aiConfig?.configured})`);
    }

    const r = await res.json();
    const msg = r?.choices?.[0]?.message || {};
    // Reasoning models (DeepSeek v4-pro, o-series) may emit the JSON in
    // `reasoning` rather than `content`. Try both.
    const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
    const detailText = Array.isArray(msg.reasoning_details)
        ? msg.reasoning_details.map((d: { text?: string }) => d?.text || '').join('')
        : '';
    const content: string = msg.content || reasoning || detailText || '';
    let parsed: SuggestedEvent;
    try {
        parsed = JSON.parse(extractJsonObject(content));
    } catch {
        throw new Error("Couldn't parse a calendar event from the model's reply.");
    }
    return parsed;
}

// --- Multi-suggestion variant ----------------------------------------------
//
// suggestEventFromEmail() above returns one best-fit event. The 5-card
// picker exposed by the AI Add-to-calendar button instead asks the LLM
// to propose several useful interpretations of the email, each labelled
// so the user can pick the one that matches what they want.

export interface CalendarSuggestion extends Partial<CalEvent> {
    /** Short label shown on the picker card (e.g. "Lunch on Friday"). */
    label: string;
    /** One-line rationale ("based on the meeting time in the body"). */
    rationale?: string;
    /** Optional fitting emoji ('📅', '⏰', '🍽️'…). */
    icon?: string;
    /** When the model declines this slot. */
    skip?: boolean;
}

const MULTI_SYSTEM_PROMPT = [
    'You propose 5 different calendar event interpretations for an email.',
    'Return strictly one JSON object: { "options": [{ "label", "rationale", "icon", "title", "start", "end", "allDay", "location", "description" }, …] } — no prose, no code fences.',
    'Rules:',
    '- Exactly 5 options, varied in shape (specific event, focus block, follow-up reminder, deadline, prep time, travel block, recurring touch-base, etc.).',
    '- start/end are ISO 8601 ("2026-05-02T14:00:00") in the email\'s implied timezone.',
    '- All-day uses "YYYY-MM-DD" + allDay=true.',
    '- Default duration to 1 hour when only a start time is given.',
    '- label is ≤ 5 words, imperative or noun-phrase ("Lunch with Sam", "Block focus time", "Reply by EOW").',
    '- icon is a single emoji that fits.',
    '- rationale is one short sentence — what in the email implies this slot.',
    '- description summarises the email in 1–2 sentences for the event body.',
    '- Resolve relative dates against the reference date provided.',
    '- If the email truly contains no scheduling signal, return options where label/title is suggestive ("Quick read", "Mark as done") and start = tomorrow at a reasonable time.'
].join('\n');

export async function suggestCalendarOptions(
    input: SuggestInput,
    opts: { signal?: AbortSignal } = {}
): Promise<CalendarSuggestion[]> {
    if (!isConfigured()) {
        throw new Error('Configure an OpenAI-compatible provider + API key in Settings → AI.');
    }
    const baseUrl = resolveBaseUrl();
    const model = resolveModel();
    const apiKey = resolveApiKey();
    const now = input.now ?? new Date();
    const body = (input.body || '').slice(0, 5000);
    const userMsg = [
        `Reference date: ${now.toISOString()}`,
        `Subject: ${input.subject || '(no subject)'}`,
        `From: ${input.from || '(unknown)'}`,
        '',
        'Email body:',
        body
    ].join('\n');

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: MULTI_SYSTEM_PROMPT },
                { role: 'user', content: userMsg }
            ],
            temperature: 0.4,
            max_tokens: 2500
        }),
        signal: opts.signal
    });

    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try { const j = await res.json(); detail = j?.error?.message || j?.message || detail; } catch { /* */ }
        const keyHint = apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : 'none';
        throw new Error(`Provider: ${detail} (url=${baseUrl}, model=${model}, key=${keyHint}, server=${capabilities.aiConfig?.configured})`);
    }

    const r = await res.json();
    const msg = r?.choices?.[0]?.message || {};
    const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
    const detailText = Array.isArray(msg.reasoning_details)
        ? msg.reasoning_details.map((d: { text?: string }) => d?.text || '').join('')
        : '';
    const text = (msg.content || reasoning || detailText || '').trim();
    if (!text) throw new Error('Provider returned an empty reply.');

    let parsed: { options?: CalendarSuggestion[] } = {};
    try { parsed = JSON.parse(extractJsonObject(text)); } catch { /* fall through */ }

    const cleaned = (Array.isArray(parsed.options) ? parsed.options : [])
        .filter((o) => o && typeof o.label === 'string')
        .slice(0, 5)
        .map((o) => ({
            ...o,
            label: o.label.slice(0, 60),
            icon: o.icon ? String(o.icon).slice(0, 4) : '📅',
            rationale: o.rationale ? String(o.rationale).slice(0, 140) : undefined
        }));
    if (cleaned.length >= 3) return cleaned;

    // Fallback — generic 5 options keyed off the email subject/body
    // when the model misbehaves. Default times relative to the reference.
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const slot = (h: number, m = 0) => {
        const d = new Date(tomorrow);
        d.setHours(h, m, 0, 0);
        return d.toISOString().slice(0, 19);
    };
    const subj = (input.subject || 'this email').slice(0, 40);
    return [
        { label: `Schedule "${subj}"`, icon: '📅', rationale: 'Tomorrow morning, 1-hour block.', title: subj, start: slot(10), end: slot(11), description: input.subject },
        { label: 'Block focus time', icon: '🛡️', rationale: 'Hour to actually deal with the ask.', title: `Focus: ${subj}`, start: slot(14), end: slot(15), description: input.subject },
        { label: 'Quick reply reminder', icon: '✉️', rationale: 'Short reminder to send a reply.', title: `Reply: ${subj}`, start: slot(9), end: slot(9, 15), description: 'Reply to this email.' },
        { label: 'Read carefully', icon: '🔎', rationale: '15-minute slot to read in detail.', title: `Read: ${subj}`, start: slot(16), end: slot(16, 15), description: input.subject },
        { label: 'Mark as deadline', icon: '⏰', rationale: 'All-day deadline reminder.', title: `Deadline: ${subj}`, start: tomorrow.toISOString().slice(0, 10), end: tomorrow.toISOString().slice(0, 10), allDay: true, description: input.subject }
    ];
}
