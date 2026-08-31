// Client-side AI calendar-event extractor. Walks the user's loaded
// messages, asks the LLM to pluck out anything calendar-worthy
// (meetings, flights, deliveries, deadlines), and returns structured
// suggestions the UI can render as a checkbox table.
//
// Mirrors sort-inbox-client.ts: browser → LiteLLM proxy with the
// per-user scoped key. Same cache + cooldown plumbing.

import { settings, capabilities, aiAuthKey } from './settings.svelte';
import { cachedChatCompletion } from './ai-cache.svelte';
import { maybeFlagCooldown, aiCooldownActive, aiCooldownLabel } from './ai-cooldown.svelte';

export interface ScanInputMessage {
    uid: number;
    subject?: string;
    from?: { name?: string | null; address?: string | null }[] | null;
    date?: string;
    preview?: string;
}

export interface EventSuggestion {
    uid: number;
    isEvent: boolean;
    title: string;
    start: string;
    end: string;
    location?: string;
    description?: string;
    why: string;
    citation: string;
    /** 0–1 confidence the LLM has that this is a real event. */
    confidence: number;
}

const SYSTEM = [
    'You scan emails and extract calendar-worthy items: meetings, appointments, deadlines, flights, deliveries, bookings, interviews, reservations.',
    'For each input email return ONE suggestion entry, even when it is not an event (set isEvent=false so the caller knows the message was processed).',
    'Datetimes MUST be ISO 8601 with a timezone offset when known; otherwise output a local-time ISO string (YYYY-MM-DDTHH:mm:ss).',
    'If the email gives only a date with no time (e.g. a deadline), set start to YYYY-MM-DDT09:00:00 and end one hour later.',
    'If duration is implicit, default to 60 minutes.',
    '"title" should be a concise human-readable event name (≤80 chars).',
    '"location" is optional — include it only when the email explicitly states a venue, address, or video-call link.',
    '"description" is optional — include 1–2 sentences of context when useful (agenda, confirmation number, attendees).',
    '"citation" is a short verbatim quote (≤80 chars) from the email subject or preview that justifies the date and title.',
    '"why" explains in ≤120 chars why this looks like a calendar event (or why it does not when isEvent=false).',
    '"confidence" is a number 0–1: 1 = explicit confirmation with date+time, 0.6 = likely but ambiguous, 0.2 = mention only.',
    'Return ONLY a valid JSON object: {"suggestions":[{"uid":123,"isEvent":true,"title":"…","start":"…","end":"…","location":"…","description":"…","why":"…","citation":"…","confidence":0.9}, …]}',
    'Output ALL suggestions in one go. Do NOT paginate, do NOT ask whether to continue, do NOT add narrative outside the JSON.'
].join(' ');

// Per-message output is bigger than the sort-inbox case (titles +
// descriptions + ISO datetimes), so chunks are smaller to keep each
// request comfortably under the token budget.
const CHUNK_SIZE = 12;

function resolve(): { baseUrl: string; model: string; apiKey: string } | null {
    if (capabilities.aiConfig?.configured) {
        return {
            baseUrl: capabilities.aiConfig.baseUrl.replace(/\/+$/, ''),
            model: capabilities.aiConfig.model,
            apiKey: aiAuthKey()
        };
    }
    const llm = settings.llm;
    if (!settings.useCustomLlm || !llm.apiKey) return null;
    return {
        baseUrl: (llm.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
        model: llm.model || 'gpt-4o-mini',
        apiKey: llm.apiKey
    };
}

function fmtFrom(from: ScanInputMessage['from']): string {
    if (!Array.isArray(from) || !from.length) return '';
    const f = from[0];
    return f?.name || f?.address || '';
}

function shortDate(d?: string): string {
    if (!d) return '';
    const t = Date.parse(d);
    if (Number.isNaN(t)) return d.slice(0, 16);
    const dt = new Date(t);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

async function scanChunkOnce(
    cfg: { baseUrl: string; model: string; apiKey: string },
    messages: ScanInputMessage[],
    opts: { signal?: AbortSignal; skipCache?: boolean }
): Promise<EventSuggestion[]> {
    const lines = messages.map((m) => {
        const fromStr = fmtFrom(m.from).slice(0, 60);
        const subj = (m.subject || '(no subject)').slice(0, 120);
        const preview = (m.preview || '').replace(/\s+/g, ' ').slice(0, 400);
        return `uid:${m.uid} | ${shortDate(m.date)} | from:${fromStr} | subj:${subj} | preview:${preview}`;
    }).join('\n');

    const userPrompt = `Extract calendar events from these ${messages.length} emails. Return ALL ${messages.length} suggestion rows in one JSON object: {"suggestions":[{"uid":number,"isEvent":boolean,"title":"…","start":"ISO","end":"ISO","location":"…","description":"…","why":"…","citation":"…","confidence":0..1}]}. Do not paginate or stop early.\n\n${lines}`;

    const requestBody = JSON.stringify({
        model: cfg.model,
        messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 16000,
        reasoning_effort: 'minimal',
        thinking: { type: 'disabled' },
        thinking_budget_tokens: 0,
        reasoning: { effort: 'minimal' },
        response_format: { type: 'json_object' }
    });

    const r = await cachedChatCompletion({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body: requestBody,
        scope: 'scan-events', signal: opts.signal, skipCache: opts.skipCache
    });
    if (!r.ok) {
        let detail = `${r.status}`;
        try { const j = JSON.parse(r.text); detail = j?.error?.message || j?.message || detail; } catch { /* */ }
        if (maybeFlagCooldown(detail)) {
            throw new Error(`AI is cooling down — try again in ${aiCooldownLabel()}.`);
        }
        throw new Error(`AI calendar scan: ${detail}`);
    }
    const body = JSON.parse(r.text);
    const msg = body?.choices?.[0]?.message || {};
    const reasoningText: string =
        (typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '')
        || (typeof msg.reasoning === 'string' ? msg.reasoning : '')
        || (typeof msg.provider_specific_fields?.reasoning_content === 'string'
            ? msg.provider_specific_fields.reasoning_content : '')
        || '';
    const contentText: string = typeof msg.content === 'string' ? msg.content : '';
    const text = (contentText.trim() || reasoningText.trim());
    if (!text) throw new Error('AI calendar scan: empty reply');

    const stripped = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

    let arr: unknown[] | null = null;
    const objStart = stripped.indexOf('{');
    if (objStart !== -1) {
        const objEnd = stripped.lastIndexOf('}');
        try {
            const parsed = JSON.parse(stripped.slice(objStart, objEnd + 1));
            if (Array.isArray((parsed as Record<string, unknown>).suggestions)) {
                arr = (parsed as { suggestions: unknown[] }).suggestions;
            }
        } catch { /* fall through */ }
    }
    if (!arr) {
        const start = stripped.indexOf('[');
        const end = stripped.lastIndexOf(']');
        if (start !== -1 && end !== -1) {
            try { arr = JSON.parse(stripped.slice(start, end + 1)); }
            catch { /* fall through to salvage */ }
        }
    }
    if (!arr) {
        arr = salvagePartialEntries(stripped);
        if (arr.length === 0) {
            const snippet = stripped.slice(0, 120).replace(/\s+/g, ' ');
            throw new Error(`AI calendar scan: model did not return JSON (got "${snippet}…")`);
        }
    }
    if (!Array.isArray(arr)) throw new Error('AI calendar scan: not an array');

    return arr
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object'
            && typeof (i as Record<string, unknown>).uid === 'number'
            && typeof (i as Record<string, unknown>).title === 'string')
        .filter((i, idx, all) => all.findIndex((j) => (j as { uid: number }).uid === (i as { uid: number }).uid) === idx)
        .map((i) => {
            const r = i as Record<string, unknown>;
            const conf = Number(r.confidence);
            return {
                uid: Number(r.uid),
                isEvent: r.isEvent === true,
                title: String(r.title || ''),
                start: String(r.start || ''),
                end: String(r.end || r.start || ''),
                location: typeof r.location === 'string' && r.location ? r.location : undefined,
                description: typeof r.description === 'string' && r.description ? r.description : undefined,
                why: String(r.why || ''),
                citation: String(r.citation || ''),
                confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0
            } as EventSuggestion;
        });
}

// Salvage path identical in spirit to sort-inbox-client: pull every
// parseable `{ ... }` object out of a possibly-truncated JSON blob.
// We accept entries that have a numeric uid + string title (the
// minimum to be a useful suggestion).
function salvagePartialEntries(s: string): unknown[] {
    const out: unknown[] = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                try {
                    const obj = JSON.parse(s.slice(start, i + 1));
                    if (obj && typeof obj === 'object'
                        && typeof (obj as Record<string, unknown>).uid === 'number'
                        && typeof (obj as Record<string, unknown>).title === 'string') {
                        out.push(obj);
                    }
                } catch { /* skip un-parseable fragment */ }
                start = -1;
            }
        }
    }
    return out;
}

async function scanChunk(
    cfg: { baseUrl: string; model: string; apiKey: string },
    messages: ScanInputMessage[],
    opts: { signal?: AbortSignal }
): Promise<EventSuggestion[]> {
    try {
        return await scanChunkOnce(cfg, messages, opts);
    } catch (err) {
        const msg = (err as Error).message || '';
        if (/did not return JSON|malformed JSON|not an array|empty reply/i.test(msg)) {
            return await scanChunkOnce(cfg, messages, { ...opts, skipCache: true });
        }
        throw err;
    }
}

export async function scanForEventsClient(
    messages: ScanInputMessage[],
    opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<{ suggestions: EventSuggestion[] }> {
    const cfg = resolve();
    if (!cfg) throw new Error('Configure an OpenAI-compatible provider in Settings → AI.');
    if (!messages.length) return { suggestions: [] };
    if (aiCooldownActive()) {
        throw new Error(`AI is cooling down — try again in ${aiCooldownLabel()}.`);
    }

    const chunks: ScanInputMessage[][] = [];
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
        chunks.push(messages.slice(i, i + CHUNK_SIZE));
    }

    let done = 0;
    opts.onProgress?.(0, chunks.length);
    const all = await Promise.all(
        chunks.map((c) => scanChunk(cfg, c, { signal: opts.signal }).then((r) => {
            done++;
            opts.onProgress?.(done, chunks.length);
            return r;
        }))
    );

    const merged = new Map<number, EventSuggestion>();
    for (const r of all.flat()) merged.set(r.uid, r);
    return { suggestions: [...merged.values()] };
}
