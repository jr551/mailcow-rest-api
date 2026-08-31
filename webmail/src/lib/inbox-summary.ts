// One-shot LLM call that turns the visible inbox into a single-paragraph
// summary + a severity-coloured action list. Same pattern as
// email-actions.svelte.ts: browser → user's OpenAI-compatible provider.

import { settings, capabilities, aiAuthKey } from './settings.svelte';
import { cachedChatCompletion } from './ai-cache.svelte';
import { redactSecrets } from './redact';
import { maybeFlagCooldown, aiCooldownActive, aiCooldownLabel } from './ai-cooldown.svelte';

export type Severity = 'red' | 'orange' | 'yellow' | 'green';
export type ActionCategory = 'operational' | 'marketing';

export interface InboxAction {
    label: string;        // ≤ 8 words, imperative
    severity: Severity;   // red = act now, green = informational
    detail: string;       // one sentence, max ~120 chars
    refUid?: number;      // optional pointer back to a specific message
    category?: ActionCategory; // bucket the UI splits on
    /** True when the action is a real human asking the user something —
     *  enables the inline "AI auto-reply" affordance in the briefing. */
    canAutoReply?: boolean;
}

export interface InboxSummaryResult {
    /** Short prose for the operational (real-person) bucket. The
     *  "Brief me" UI splits this on `\n\n` into a two-paragraph
     *  overview — paragraph 1 = what's in the inbox, paragraph 2 =
     *  what the user should do about it. */
    summary: string;
    /** Optional separate prose for the marketing / no-reply bucket. */
    marketingSummary?: string;
    actions: InboxAction[];
}

export interface InboxMessageInput {
    uid: number;
    subject: string;
    from: string;
    snippet?: string;
    date?: string | null;
    unread: boolean;
    flagged: boolean;
}

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

const SEVERITIES: Severity[] = ['red', 'orange', 'yellow', 'green'];

// Per-page sub-call: takes ≤10 messages, returns a partial result. The
// outer summarizeInbox fires these in parallel and merges client-side so
// the model never has to triage 40+ items in one shot (which is where it
// silently truncates and asks "want me to do the rest?").
const PAGE_SIZE = 10;

const PAGE_SYSTEM = [
    'You are one of several parallel triage workers reading a SLICE of an inbox.',
    'Return JSON only:',
    '{ "summary": string, "marketingSummary": string, "actions": [{ "label": string, "severity": "red"|"orange"|"yellow"|"green", "category": "operational"|"marketing", "detail": string, "refUid"?: number, "canAutoReply"?: boolean }] }',
    '- "summary": 1–2 sentences about the operational mail in YOUR slice only. Empty string if there is none.',
    '- "marketingSummary": 1 short sentence about marketing/newsletters in YOUR slice. Empty string if none.',
    '- "actions": up to 3 items from YOUR slice, ordered red → green.',
    '  * red    = needs reply now or a deadline is now',
    '  * orange = action this week / decaying opportunity',
    '  * yellow = nice to handle when convenient',
    '  * green  = informational',
    '- "category": "operational" for real-people / system alerts the user must handle; "marketing" for newsletters, promos, sales blasts, no-reply campaigns.',
    '- "canAutoReply": true ONLY when the action is a real human waiting on a reply.',
    '- "label": ≤ 8 words, imperative.',
    '- "detail": one sentence, ≤ 120 chars, naming sender/subject so the user can locate the message.',
    '- "refUid": when an action maps to ONE message, set the uid.',
    '- Never invent dates or amounts. Output ALL information in one go — no pagination, no narrative outside JSON.'
].join('\n');

function buildPagePrompt(page: InboxMessageInput[], pageIdx: number, pageCount: number): string {
    const lines = page.map((m, i) => {
        const flags: string[] = [];
        if (m.unread) flags.push('UNREAD');
        if (m.flagged) flags.push('STARRED');
        const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
        // Redact secrets BEFORE building the prompt — defence-in-depth so
        // OTPs/passwords/cards in the snippet never reach a third-party LLM.
        const snip = redactSecrets((m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240));
        return `${i + 1}. uid=${m.uid}${flagStr} • ${m.from || '(unknown)'} — ${redactSecrets(m.subject || '(no subject)')}${snip ? `\n   ${snip}` : ''}`;
    }).join('\n');
    return `Inbox slice ${pageIdx + 1} of ${pageCount} (${page.length} messages):\n\n${lines}`;
}

async function summarisePage(
    cfg: { baseUrl: string; apiKey: string; model: string },
    page: InboxMessageInput[],
    pageIdx: number,
    pageCount: number,
    signal?: AbortSignal
): Promise<Partial<InboxSummaryResult>> {
    const requestBody = JSON.stringify({
        model: cfg.model,
        messages: [
            { role: 'system', content: PAGE_SYSTEM },
            { role: 'user', content: buildPagePrompt(page, pageIdx, pageCount) }
        ],
        temperature: 0.2,
        max_tokens: 800,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' }
    });
    const cached = await cachedChatCompletion({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body: requestBody,
        scope: 'inbox-summary-page', signal
    });
    if (!cached.ok) {
        let detail = `${cached.status}`;
        try { const j = JSON.parse(cached.text); detail = j?.error?.message || j?.message || detail; } catch { /* */ }
        if (maybeFlagCooldown(detail)) {
            throw new Error(`AI is cooling down — try again in ${aiCooldownLabel()}.`);
        }
        throw new Error(`Provider: ${detail}`);
    }
    const r = JSON.parse(cached.text);
    const m = r?.choices?.[0]?.message || {};
    const reasoning = typeof m.reasoning === 'string' ? m.reasoning
        : typeof m.reasoning_content === 'string' ? m.reasoning_content
        : '';
    const text = (m.content || reasoning || '').trim();
    if (!text) return {};
    try { return JSON.parse(extractJson(text)) as Partial<InboxSummaryResult>; } catch { return {}; }
}

function severityRank(s: Severity): number {
    return SEVERITIES.indexOf(s); // red=0, green=3
}

export interface SummarizeProgress {
    done: number;
    total: number;
    /** Human-readable label for the status pill ("Reading 12/40…"). */
    label: string;
}

export async function summarizeInbox(
    messages: InboxMessageInput[],
    opts: { signal?: AbortSignal; onProgress?: (p: SummarizeProgress) => void } = {}
): Promise<InboxSummaryResult> {
    if (!isConfigured()) {
        throw new Error('Configure an OpenAI-compatible provider + API key in Settings → AI.');
    }
    if (aiCooldownActive()) {
        throw new Error(`AI is cooling down — try again in ${aiCooldownLabel()}.`);
    }
    if (!messages.length) {
        return { summary: 'Inbox is empty — nothing to brief.', actions: [] };
    }
    const baseUrl = resolveBaseUrl();
    const model = resolveModel();
    const apiKey = resolveApiKey();
    const cfg = { baseUrl, apiKey, model };

    // Cap the briefing at 60 most-recent so a 5000-message inbox doesn't
    // fan out 500 sub-calls. The user's "show me what's important right
    // now" intent is satisfied by the recent slice.
    const sorted = messages.slice(0, 60);
    const pages: InboxMessageInput[][] = [];
    for (let i = 0; i < sorted.length; i += PAGE_SIZE) {
        pages.push(sorted.slice(i, i + PAGE_SIZE));
    }

    const total = pages.length;
    let done = 0;
    opts.onProgress?.({ done: 0, total, label: `Reading 0/${sorted.length}…` });

    const partials = await Promise.all(
        pages.map((page, idx) =>
            summarisePage(cfg, page, idx, total, opts.signal)
                .then((r) => {
                    done++;
                    const seen = Math.min(sorted.length, done * PAGE_SIZE);
                    opts.onProgress?.({ done, total, label: `Reading ${seen}/${sorted.length}…` });
                    return r;
                })
                .catch(() => {
                    done++;
                    const seen = Math.min(sorted.length, done * PAGE_SIZE);
                    opts.onProgress?.({ done, total, label: `Reading ${seen}/${sorted.length}…` });
                    return {} as Partial<InboxSummaryResult>;
                })
        )
    );

    // Merge: concat operational summaries (≤2 sentences each) into one
    // prose block, fold marketing summaries into one short line, dedup
    // actions by uid+label+severity, sort by severity, cap at 6.
    const opSummaries: string[] = [];
    const mktSummaries: string[] = [];
    const allActions: InboxAction[] = [];

    for (const p of partials) {
        if (typeof p.summary === 'string' && p.summary.trim()) opSummaries.push(p.summary.trim());
        if (typeof p.marketingSummary === 'string' && p.marketingSummary.trim()) mktSummaries.push(p.marketingSummary.trim());
        const raw = Array.isArray(p.actions) ? p.actions : [];
        for (const a of raw) {
            if (!a || typeof a.label !== 'string' || typeof a.detail !== 'string') continue;
            allActions.push({
                label: a.label.slice(0, 80),
                severity: SEVERITIES.includes(a.severity as Severity) ? (a.severity as Severity) : 'yellow',
                detail: a.detail.slice(0, 200),
                refUid: typeof a.refUid === 'number' ? a.refUid : undefined,
                category: a.category === 'marketing' ? 'marketing' : 'operational',
                canAutoReply: a.canAutoReply === true
            });
        }
    }

    const seen = new Set<string>();
    const dedupedActions: InboxAction[] = [];
    for (const a of allActions) {
        const k = `${a.refUid ?? ''}::${a.label.toLowerCase()}::${a.severity}`;
        if (seen.has(k)) continue;
        seen.add(k);
        dedupedActions.push(a);
    }
    dedupedActions.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    const actions = dedupedActions.slice(0, 6);

    // Two-paragraph synthesis. Para 1 = what's in the inbox (the
     // page-level summaries strung together). Para 2 = the top action
     // items rephrased as a "what you should do" line. Local-only —
     // no extra LLM call so we don't burn another round of tokens.
    const para1 = opSummaries.length
        ? opSummaries.join(' ')
        : 'Nothing in your recent operational mail needs attention.';

    let para2: string;
    if (actions.length === 0) {
        para2 = 'No actions needed — you can close this and move on.';
    } else {
        const top = actions.slice(0, 3);
        const verbs = top.map((a) => {
            // First word of the imperative label, lowercased.
            const v = (a.label.split(/\s+/)[0] || '').toLowerCase();
            return v ? a.label : 'review';
        });
        const sevHeadline = (() => {
            const reds = actions.filter((a) => a.severity === 'red').length;
            const oranges = actions.filter((a) => a.severity === 'orange').length;
            if (reds > 0) return `${reds} item${reds === 1 ? '' : 's'} need${reds === 1 ? 's' : ''} a reply or decision today`;
            if (oranges > 0) return `${oranges} item${oranges === 1 ? '' : 's'} can wait until later this week`;
            return 'nothing urgent — these are nice-to-handle';
        })();
        para2 = `What to do: ${sevHeadline}. Start with “${verbs[0]}”` + (verbs.length > 1 ? `, then ${verbs.slice(1).map((v) => `“${v}”`).join(' and ')}` : '') + '. Tick each action below as you handle it, or ignore the ones that don\'t matter.';
    }

    const summary = `${para1}\n\n${para2}`;
    const marketingSummary = mktSummaries.length ? mktSummaries.join(' ') : undefined;

    opts.onProgress?.({ done: total, total, label: 'Briefing ready.' });
    return { summary, marketingSummary, actions };
}

// Render the summary as a self-contained HTML email body for the
// "Email this to myself" button. Keeps inline styles only — no <link>,
// no external assets — so it survives webmail clients that strip <style>.
export function summaryToHtml(result: InboxSummaryResult, when: Date = new Date()): string {
    const colourFor: Record<Severity, string> = {
        red: '#c92a2a',
        orange: '#e8590c',
        yellow: '#c5a300',
        green: '#2f9e44'
    };
    const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c] as string));

    const items = result.actions.map((a) => {
        const colour = colourFor[a.severity];
        return `<li style="margin: 6px 0; padding-left: 10px; border-left: 4px solid ${colour};">
  <strong style="color:${colour};">${escape(a.label)}</strong>
  <div style="color:#444; font-size:14px;">${escape(a.detail)}</div>
</li>`;
    }).join('\n');

    return `<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:#222; max-width: 640px;">
  <h2 style="margin: 0 0 4px;">Inbox briefing</h2>
  <div style="color:#666; font-size:12px; margin-bottom: 14px;">${escape(when.toLocaleString())}</div>
  <p style="font-size: 15px; line-height: 1.55;">${escape(result.summary)}</p>
  ${items ? `<h3 style="margin: 16px 0 6px;">Action list</h3>\n<ul style="list-style:none; padding:0; margin:0;">\n${items}\n</ul>` : ''}
  <hr style="border:none; border-top:1px solid #eee; margin: 18px 0;" />
  <div style="color:#999; font-size:11px;">Generated by webmail • ${escape(when.toISOString())}</div>
</body></html>`;
}
