// Tracks the last few in-app surfaces the user looked at so the AI chat
// can mention them as context ("you were just looking at the Marketing
// folder, then opened the invoice from Acme — want me to act on it?").
//
// Pushes on navigation events from the rest of the UI; we don't try to
// hook every state change here. Callers go through `recordView` whenever
// they think the user has meaningfully landed somewhere.

const MAX_VIEWS = 10;

export type ViewKind =
    | 'folder'         // mailbox switch
    | 'message'        // opened a specific email
    | 'thread'         // opened/expanded a thread
    | 'calendar'       // calendar surface or event
    | 'drive'          // drive folder/file
    | 'ai-thread'      // jumped to an existing AI conversation
    | 'settings'       // opened settings panel
    | 'compose';       // opened compose

export interface RecentView {
    kind: ViewKind;
    title: string;        // short human label, no newlines
    detail?: string;      // optional one-line subtitle (sender, path, etc.)
    ts: number;
}

const state = $state<{ items: RecentView[] }>({ items: [] });

export const recentViews = state;

/** Append a view, trimming to MAX_VIEWS. Drops back-to-back duplicates of the
 *  same (kind, title) so e.g. a re-render of the same message doesn't fill
 *  the buffer with noise. */
export function recordView(v: Omit<RecentView, 'ts'>): void {
    const prev = state.items[0];
    const title = (v.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title) return;
    if (prev && prev.kind === v.kind && prev.title === title) return;
    const entry: RecentView = { kind: v.kind, title, detail: v.detail?.slice(0, 200), ts: Date.now() };
    state.items = [entry, ...state.items].slice(0, MAX_VIEWS);
}

/** Render the recent-view list as an LLM-friendly bulleted block. Returns
 *  '' when nothing's been tracked, so callers can append unconditionally. */
export function recentViewsForPrompt(limit = MAX_VIEWS): string {
    if (state.items.length === 0) return '';
    const lines = state.items.slice(0, limit).map((v) => {
        const ago = humanAgo(v.ts);
        const tail = v.detail ? ` — ${v.detail}` : '';
        return `- [${v.kind}, ${ago}] ${v.title}${tail}`;
    });
    return [
        'Recent in-app surfaces the user has been viewing (most recent first):',
        ...lines
    ].join('\n');
}

function humanAgo(ts: number): string {
    const sec = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const m = Math.round(sec / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

export function clearRecentViews(): void {
    state.items = [];
}
