// Reading-pane conversation stack (Outlook-style): chronological messages,
// focused/selected message expanded, older siblings collapsed until expanded.

import type { MessageListItem } from './api';
import { buildThreads, type Thread } from './threads';

/** Find the thread row that contains `uid`, if any. */
export function findThreadForUid(messages: MessageListItem[], uid: number): Thread | null {
    const threads = buildThreads(messages);
    for (const t of threads) {
        if (t.messages.some((m) => m.uid === uid)) return t;
    }
    return null;
}

/** Oldest → newest (Outlook transcript order in the reading pane). */
export function conversationOrderChronological(thread: Thread): MessageListItem[] {
    return [...thread.messages].sort(
        (a, b) => timestampOf(a) - timestampOf(b)
    );
}

function timestampOf(m: MessageListItem): number {
    const t = m.internalDate || m.envelope.date;
    if (!t) return 0;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : 0;
}

/** True when the message body should render expanded in the stack. */
export function isConversationMessageExpanded(
    uid: number,
    focusUid: number,
    userExpanded: ReadonlySet<number>
): boolean {
    if (uid === focusUid) return true;
    return userExpanded.has(uid);
}

/** One-line preview for a collapsed sibling. */
export function conversationSnippet(text: string | null | undefined, max = 140): string {
    if (!text) return '(no preview)';
    const one = text.replace(/\s+/g, ' ').trim();
    if (one.length <= max) return one;
    return `${one.slice(0, max - 1)}…`;
}
