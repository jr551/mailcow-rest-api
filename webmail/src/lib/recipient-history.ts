// Pulls a one-paragraph AI summary of every message in the user's
// mailbox to/from the email address they're currently composing to.
// Surfaced in Compose as a small reference panel so the writer can
// remember context without breaking flow.
//
// Search costs are bounded by the IMAP server-side filter (uses the
// new from:/to: tokens) and the LLM call is cached for an hour via
// cachedChatCompletion — same drafting body → same summary.

import { listMailboxes, listMessages, type Mailbox, type MessageListItem } from './api';
import { settings, capabilities, aiAuthKey } from './settings.svelte';
import { cachedChatCompletion } from './ai-cache.svelte';

interface ProviderCfg { baseUrl: string; model: string; apiKey: string; }
function resolveProvider(): ProviderCfg | null {
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

function findInbox(boxes: Mailbox[]): string | null {
    return boxes.find((m) => m.specialUse === '\\Inbox')?.path || boxes.find((m) => /^inbox$/i.test(m.name))?.path || null;
}
function findSent(boxes: Mailbox[]): string | null {
    return boxes.find((m) => m.specialUse === '\\Sent')?.path || boxes.find((m) => /^sent(\s|$)/i.test(m.name))?.path || null;
}

function fmtAddr(a: { name?: string | null; address?: string | null } | undefined): string {
    if (!a) return '';
    if (a.name && a.address) return `${a.name} <${a.address}>`;
    return a.address || a.name || '';
}

function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
}

export interface HistorySummary {
    /** One-paragraph AI summary, with dates inlined. */
    summary: string;
    /** Raw count of matched messages (capped at MAX_HITS). */
    count: number;
    /** First / last date observed across the matched set. */
    oldest: string;
    newest: string;
}

const MAX_HITS = 30;

export async function summariseRecipientHistory(
    address: string,
    opts: { signal?: AbortSignal } = {}
): Promise<HistorySummary | null> {
    const cleanAddr = (address || '').trim().toLowerCase();
    if (!cleanAddr || !cleanAddr.includes('@')) return null;
    const cfg = resolveProvider();
    if (!cfg) return null;

    const boxes = await listMailboxes();
    const inbox = findInbox(boxes);
    const sent = findSent(boxes);

    // Two parallel fetches — inbox for incoming, sent for outgoing.
    // Each uses the new search-token grammar so the IMAP server does
    // the filtering. We cap at MAX_HITS per side; the cap is generous
    // enough that you'd be unlikely to hit it in normal correspondence.
    const tasks: Promise<MessageListItem[]>[] = [];
    if (inbox) {
        tasks.push(listMessages(inbox, { pageSize: MAX_HITS, search: `from:${cleanAddr}` })
            .then((r) => r.messages || []).catch(() => []));
    }
    if (sent) {
        tasks.push(listMessages(sent, { pageSize: MAX_HITS, search: `to:${cleanAddr}` })
            .then((r) => r.messages || []).catch(() => []));
    }
    const [inboxHits = [], sentHits = []] = await Promise.all(tasks);

    if (opts.signal?.aborted) return null;
    if (inboxHits.length === 0 && sentHits.length === 0) return null;

    // Tag each message with its direction so the LLM has clean context.
    type Tagged = { dir: 'in' | 'out'; date: string; subject: string; from: string; to: string };
    const tagged: Tagged[] = [];
    for (const m of inboxHits) {
        tagged.push({
            dir: 'in',
            date: m.envelope?.date || m.internalDate || '',
            subject: m.envelope?.subject || '(no subject)',
            from: fmtAddr(m.envelope?.from?.[0]),
            to: fmtAddr(m.envelope?.to?.[0])
        });
    }
    for (const m of sentHits) {
        tagged.push({
            dir: 'out',
            date: m.envelope?.date || m.internalDate || '',
            subject: m.envelope?.subject || '(no subject)',
            from: fmtAddr(m.envelope?.from?.[0]),
            to: fmtAddr(m.envelope?.to?.[0])
        });
    }
    tagged.sort((a, b) => +new Date(b.date || 0) - +new Date(a.date || 0));
    const slice = tagged.slice(0, MAX_HITS);

    const oldest = fmtDate(slice[slice.length - 1]?.date || '');
    const newest = fmtDate(slice[0]?.date || '');

    const lines = slice.map((t, i) => {
        const arrow = t.dir === 'in' ? '←' : '→';
        return `${i + 1}. ${fmtDate(t.date)} ${arrow} ${t.subject}`;
    }).join('\n');

    const sys = [
        'You write a one-paragraph factual summary of someone\'s past email exchanges with a specific contact.',
        'Mention dates inline (YYYY-MM-DD), highlight recurring themes, and call out the most recent message.',
        'Be concise — 2–4 sentences max. No bullet lists, no headings, no preamble.',
        'If the list is short or nothing notable stands out, simply describe what\'s there factually.'
    ].join('\n');
    const user = `Email history with ${cleanAddr} (newest first):\n${lines}`;

    const requestBody = JSON.stringify({
        model: cfg.model,
        messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user.slice(0, 6000) }
        ],
        temperature: 0.2,
        max_tokens: 220,
        reasoning_effort: 'low'
    });

    try {
        const r = await cachedChatCompletion({
            baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body: requestBody,
            scope: 'recipient-history', signal: opts.signal
        });
        if (!r.ok) return null;
        const data = JSON.parse(r.text);
        const summary = (data?.choices?.[0]?.message?.content || '').trim();
        if (!summary) return null;
        return { summary, count: slice.length, oldest, newest };
    } catch {
        return null;
    }
}
