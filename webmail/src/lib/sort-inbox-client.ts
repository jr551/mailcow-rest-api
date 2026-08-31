// Client-side AI inbox-sort. Calls the LiteLLM proxy directly from the
// browser using the per-user scoped key from /v1/ai/config.
//
// Why client-side: the imap-rest server runs on a host whose outbound
// route to a LiteLLM proxy is flaky (intermittent 10-30s connect timeouts),
// so /v1/ai/sort-inbox routinely 502s. The browser → proxy path is
// reliable, and the per-user budget enforcement still applies via the
// scoped LiteLLM key.

import { settings, capabilities } from './settings.svelte';
import { cachedChatCompletion } from './ai-cache.svelte';
import { maybeFlagCooldown, aiCooldownActive, aiCooldownLabel } from './ai-cooldown.svelte';

export interface InboxSortMessage {
    uid: number;
    subject?: string;
    from?: { name?: string | null; address?: string | null }[] | null;
    to?: { name?: string | null; address?: string | null }[] | null;
    date?: string;
}

export type InboxCategory = 'human' | 'family' | 'important' | 'purchase' | 'notification' | 'marketing' | 'info';

export interface InboxSortRanking {
    uid: number;
    /** 1 (low) → 5 (extreme — real-human waiting on the user). */
    level: number;
    category?: InboxCategory;
    human?: boolean;
    reason: string;
}

const SYSTEM = [
    'You triage an email inbox. For each email, return a relevance level + a category + a flag for whether a real human (not a mailmerge / no-reply / list) wrote it.',
    'Levels: 5 = a real person waiting on the user (extreme relevance), 4 = important / time-sensitive, 3 = useful FYI, 2 = marketing / promotional, 1 = newsletters or low-signal.',
    'Categories:',
    ' - "family" = a real person who is the user\'s family member (parent, sibling, partner, child, in-law, close kin). Friends, partners-in-life, and obvious family-tier contacts go here. Always level 5. Family always beats "important" — never tag a family email as "important".',
    ' - "human" = a real person who is NOT family — colleague, friend, acquaintance, professional contact addressing the user directly. Always level 5.',
    ' - "important" = automated but action-needed: security alerts, deadlines, account changes, appointments, banking warnings, calendar invites. Usually level 4. Reserve this for *machine-sent* mail; if a real human wrote it, use "family" or "human".',
    ' - "purchase" = receipts, order confirmations, shipping updates, payment notifications, invoices, refunds. Usually level 3-4.',
    ' - "notification" = system / service notifications that are NOT actionable (build success, comment notifications, social mentions, status updates from apps). Usually level 2-3.',
    ' - "marketing" = sales, promotional offers, newsletters with deals, "you might like…" mailers. Always level 1-2 unless the user is clearly buying.',
    ' - "info" = everything else (reports, FYI digests).',
    '"human": true ONLY when the message is from a real person (no "no-reply", no "newsletter@", not an obvious template). Genuine human emails should be at the top — set level=5.',
    'Be strict about marketing: any "save X% off", "limited time", "shop now", "you may like" content is marketing/level 1-2 regardless of how friendly the sender name appears.',
    'Be careful with security/important: an email IS important when it confirms a real action (sign-in, password reset YOU triggered, 2FA codes), but a generic "secure your account" / "try our new feature" mailer from a brand is marketing, not important.',
    'Return ONLY a valid JSON object: {"rankings":[{"uid":1001,"level":5,"category":"human","human":true,"reason":"short"},...]}',
    'Sort the array from highest relevance (level 5) to lowest (level 1).',
    'Output ALL rankings in one go. Do NOT paginate, do NOT ask whether to continue, do NOT add narrative outside the JSON.'
].join(' ');

// Each request stays bounded so the model never silently caps itself or
// asks "should I do the rest?". Larger inboxes are split into parallel
// chunks and merged client-side.
// Smaller chunks fit comfortably inside the budget when reasoning
// models still try to "think" despite our thinking.disabled hint.
// 20 emails ≈ 1 KB JSON per chunk so we have plenty of headroom.
const CHUNK_SIZE = 20;

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
    return {
        baseUrl: (llm.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
        model: llm.model || 'gpt-4o-mini',
        apiKey: llm.apiKey
    };
}

function fmtFrom(from: InboxSortMessage['from']): string {
    if (!Array.isArray(from) || !from.length) return '';
    const f = from[0];
    return f?.name || f?.address || '';
}

const VALID = new Set(['human', 'family', 'important', 'purchase', 'notification', 'marketing', 'info']);

function shortDate(d?: string): string {
    if (!d) return '';
    const t = Date.parse(d);
    if (Number.isNaN(t)) return d.slice(0, 16);
    // YYYY-MM-DD HH:mm — enough to weight recency, half the bytes of ISO.
    const dt = new Date(t);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

async function sortChunkOnce(
    cfg: { baseUrl: string; model: string; apiKey: string },
    messages: InboxSortMessage[],
    opts: { signal?: AbortSignal; skipCache?: boolean }
): Promise<InboxSortRanking[]> {
    const lines = messages.map((m) => {
        const fromStr = fmtFrom(m.from).slice(0, 60);
        const subj = (m.subject || '(no subject)').slice(0, 100);
        // Trimmed: dropped to:, normalized date, capped subject.
        return `uid:${m.uid} | ${shortDate(m.date)} | from:${fromStr} | subj:${subj}`;
    }).join('\n');

    const userPrompt = `Triage these ${messages.length} emails by relevance + category. Return ALL ${messages.length} rankings in one JSON object: {"rankings":[{"uid":number,"level":1-5,"category":"human"|"family"|"important"|"purchase"|"notification"|"marketing"|"info","human":boolean,"reason":"brief"}]} sorted level 5 → 1. Do not paginate or stop early.\n\n${lines}`;

    const requestBody = JSON.stringify({
        model: cfg.model,
        messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        // 16k headroom because some reasoning models still ignore
        // thinking.disabled and chew through 4k+ tokens of internal
        // monologue before emitting any content. Chunk size is 20 so
        // even at this max we won't choke the request.
        max_tokens: 16000,
        reasoning_effort: 'minimal',
        thinking: { type: 'disabled' },
        // Belt-and-braces budget caps that LiteLLM forwards to the
        // underlying provider when supported.
        thinking_budget_tokens: 0,
        reasoning: { effort: 'minimal' },
        response_format: { type: 'json_object' }
    });

    const r = await cachedChatCompletion({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body: requestBody,
        scope: 'sort-inbox', signal: opts.signal, skipCache: opts.skipCache
    });
    if (!r.ok) {
        let detail = `${r.status}`;
        try { const j = JSON.parse(r.text); detail = j?.error?.message || j?.message || detail; } catch { /* */ }
        if (maybeFlagCooldown(detail)) {
            throw new Error(`AI is cooling down — try again in ${aiCooldownLabel()}.`);
        }
        throw new Error(`AI sort: ${detail}`);
    }
    const body = JSON.parse(r.text);
    const msg = body?.choices?.[0]?.message || {};
    // Some thinking-mode providers expose the verbose stream under
    // `reasoning_content` and/or under `provider_specific_fields` —
    // collect everything we can find so the salvage path has the
    // best chance of recovering ranking objects when `content` is
    // empty (DeepSeek "finish_reason: length" + content="" case).
    const reasoningText: string =
        (typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '')
        || (typeof msg.reasoning === 'string' ? msg.reasoning : '')
        || (typeof msg.provider_specific_fields?.reasoning_content === 'string'
            ? msg.provider_specific_fields.reasoning_content : '')
        || '';
    const contentText: string = typeof msg.content === 'string' ? msg.content : '';
    const text = (contentText.trim() || reasoningText.trim());
    if (!text) throw new Error('AI sort: empty reply');

    // Strip ```json fences some models emit even with response_format
    // set, then look for a JSON object first (since we asked for one),
    // then fall back to a bare array. Failure here usually means the
    // model returned reasoning prose instead of JSON — we'll retry
    // skip-cache from the caller before bubbling.
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
            if (Array.isArray((parsed as Record<string, unknown>).rankings)) {
                arr = (parsed as { rankings: unknown[] }).rankings;
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
        // Salvage path: the model truncated mid-object (reasoning chewed
        // the budget). Walk through and pull every `{ ... }` we can
        // parse standalone — partial coverage beats throwing away the
        // user's whole sort.
        arr = salvagePartialEntries(stripped);
        if (arr.length === 0) {
            const snippet = stripped.slice(0, 120).replace(/\s+/g, ' ');
            throw new Error(`AI sort: model did not return JSON (got "${snippet}…")`);
        }
    }
    if (!Array.isArray(arr)) throw new Error('AI sort: not an array');

    return arr
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && typeof (i as Record<string, unknown>).uid === 'number' && typeof (i as Record<string, unknown>).level === 'number')
        // dedupe by uid in case the salvage path picked up two copies
        .filter((i, idx, all) => all.findIndex((j) => (j as { uid: number }).uid === (i as { uid: number }).uid) === idx)
        .map((i) => ({
            uid: Number((i as { uid: number }).uid),
            level: Math.max(1, Math.min(5, Math.round(Number((i as { level: number }).level)))),
            category: VALID.has(String((i as { category?: string }).category) || 'info')
                ? ((i as { category: string }).category as InboxCategory)
                : 'info',
            human: (i as { human?: boolean }).human === true,
            reason: String((i as { reason?: string }).reason || '')
        }));
}

// Walk the (possibly truncated) JSON blob and pull every parseable
// `{ ... }` object out of it. Used when response_format=json_object
// fails because the reasoning model exhausted max_tokens mid-object.
// The brace counter handles nested objects + ignores braces inside
// string literals.
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
                    // Skip the outer `{ "rankings": [...] }` wrapper —
                    // we want the inner ranking objects, identifiable
                    // by having a numeric uid + level.
                    if (obj && typeof obj === 'object'
                        && typeof (obj as Record<string, unknown>).uid === 'number'
                        && typeof (obj as Record<string, unknown>).level === 'number') {
                        out.push(obj);
                    }
                } catch { /* skip un-parseable fragment */ }
                start = -1;
            }
        }
    }
    return out;
}

// Retry wrapper. If the first call's response was a cached bad JSON
// (cachedChatCompletion stores any 2xx, even malformed bodies), the
// second attempt skips the cache so the user can re-run sort without
// having to clear their browser storage. Cooldown / network errors
// don't retry — they're transient by nature, not stuck-cache bugs.
async function sortChunk(
    cfg: { baseUrl: string; model: string; apiKey: string },
    messages: InboxSortMessage[],
    opts: { signal?: AbortSignal }
): Promise<InboxSortRanking[]> {
    try {
        return await sortChunkOnce(cfg, messages, opts);
    } catch (err) {
        const msg = (err as Error).message || '';
        if (/did not return JSON|malformed JSON|not an array|empty reply/i.test(msg)) {
            return await sortChunkOnce(cfg, messages, { ...opts, skipCache: true });
        }
        throw err;
    }
}

export async function sortInboxClient(
    messages: InboxSortMessage[],
    opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<{ rankings: InboxSortRanking[] }> {
    const cfg = resolve();
    if (!cfg) throw new Error('Configure an OpenAI-compatible provider in Settings → AI.');
    if (!messages.length) return { rankings: [] };
    if (aiCooldownActive()) {
        throw new Error(`AI is cooling down — try again in ${aiCooldownLabel()}.`);
    }

    // Split into chunks of CHUNK_SIZE so the model never runs out of token
    // budget mid-list and silently asks "should I do the rest?". Chunks
    // fire in parallel — each one is independently cached by the prompt.
    const chunks: InboxSortMessage[][] = [];
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
        chunks.push(messages.slice(i, i + CHUNK_SIZE));
    }

    let done = 0;
    opts.onProgress?.(0, chunks.length);
    const all = await Promise.all(
        chunks.map((c) => sortChunk(cfg, c, { signal: opts.signal }).then((r) => {
            done++;
            opts.onProgress?.(done, chunks.length);
            return r;
        }))
    );

    // Dedup by uid, last-write-wins (rare with chunked input but cheap).
    const merged = new Map<number, InboxSortRanking>();
    for (const r of all.flat()) merged.set(r.uid, r);
    return { rankings: [...merged.values()] };
}
