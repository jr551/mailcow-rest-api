// Client-side thread grouping. The server's envelope only carries
// `messageId` + `inReplyTo` (References isn't in IMAP's ENVELOPE), so we
// build chains transitively: walk parent links until we hit a root, then
// group by that root. Messages whose parents haven't been loaded yet
// (cross-page reply chains) become their own roots — the background scan
// crawler fills in the gaps over time.
//
// Fallback for senders that strip threading headers: normalised subject.
// "Re: Re: Quote for invoice #42" → "quote for invoice #42". A subject-
// only collision groups unrelated mail, which is exactly what Gmail does
// in the same situation, so it matches user expectations.

import type { MessageListItem } from './api';

export interface Thread {
    id: string;
    messages: MessageListItem[]; // sorted newest → oldest
    latest: MessageListItem;
    count: number;
    hasUnread: boolean;
    hasFlagged: boolean;
    hasAttachments: boolean;
    /** Display order: most-recent participant first, deduped. */
    participants: { name: string | null; address: string | null }[];
}

const SUBJECT_PREFIX_RE = /^(\s*(re|fwd|fw|aw|sv|tr)\s*:\s*)+/i;

function normalizeSubject(s: string | null | undefined): string {
    if (!s) return '';
    let t = s;
    // Strip nested Re:/Fwd:/Aw:/Sv:/Tr:/etc. The regex applies once and
    // captures all leading prefixes since they collapse together.
    t = t.replace(SUBJECT_PREFIX_RE, '');
    return t.trim().toLowerCase();
}

function timestampOf(m: MessageListItem): number {
    const t = m.internalDate || m.envelope.date;
    if (!t) return 0;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : 0;
}

function rootOf(
    msg: MessageListItem,
    byId: Map<string, MessageListItem>,
    seen: Set<string>
): string {
    // Walk up inReplyTo until we either hit a message we don't have or
    // the message itself has no parent. Cycle guard via `seen`.
    let current = msg;
    while (current.envelope.inReplyTo) {
        const id = current.envelope.inReplyTo;
        if (seen.has(id)) break;
        seen.add(id);
        const parent = byId.get(id);
        if (!parent) {
            // The parent isn't loaded — group on the inReplyTo string itself
            // so siblings replying to the same un-loaded message still cluster.
            return `parent:${id}`;
        }
        current = parent;
    }
    return current.envelope.messageId
        || `subj:${normalizeSubject(current.envelope.subject)}`;
}

export function buildThreads(messages: MessageListItem[]): Thread[] {
    const byId = new Map<string, MessageListItem>();
    for (const m of messages) {
        if (m.envelope.messageId) byId.set(m.envelope.messageId, m);
    }

    const groups = new Map<string, MessageListItem[]>();
    // Track which messages were grouped via id-based linkage so we can
    // dedupe against the subject fallback (otherwise messages without
    // headers would land in two buckets if they share a subject with a
    // header-rooted thread).
    const subjectFallback = new Map<string, string>(); // normSubject → first thread root
    for (const m of messages) {
        let key: string;
        if (m.envelope.inReplyTo || m.envelope.messageId) {
            key = rootOf(m, byId, new Set());
            const ns = normalizeSubject(m.envelope.subject);
            if (ns && !subjectFallback.has(ns)) subjectFallback.set(ns, key);
        } else {
            const ns = normalizeSubject(m.envelope.subject);
            // Try to glue header-less messages onto an existing thread with
            // the same normalised subject. Failing that, they get their own
            // subject-keyed bucket.
            key = ns ? (subjectFallback.get(ns) || `subj:${ns}`) : `uid:${m.uid}`;
            if (ns && !subjectFallback.has(ns)) subjectFallback.set(ns, key);
        }
        const arr = groups.get(key);
        if (arr) arr.push(m);
        else groups.set(key, [m]);
    }

    const threads: Thread[] = [];
    for (const [id, items] of groups) {
        items.sort((a, b) => timestampOf(b) - timestampOf(a));
        const latest = items[0];
        const seen = new Set<string>();
        const participants: { name: string | null; address: string | null }[] = [];
        for (const it of items) {
            const f = it.envelope.from?.[0];
            if (!f) continue;
            const k = (f.address || f.name || '').toLowerCase();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            participants.push(f);
        }
        threads.push({
            id,
            messages: items,
            latest,
            count: items.length,
            hasUnread: items.some((m) => !m.flags.includes('\\Seen')),
            hasFlagged: items.some((m) => m.flags.includes('\\Flagged')),
            hasAttachments: items.some((m) => !!m.hasAttachments),
            participants
        });
    }
    threads.sort((a, b) => timestampOf(b.latest) - timestampOf(a.latest));
    return threads;
}
