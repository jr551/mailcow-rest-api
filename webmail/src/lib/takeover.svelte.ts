// Client state for the "AI assistant takeover" surface.
//
// The assistant itself runs SERVER-SIDE (src/takeover-worker.js): it drafts
// replies to mail that looks like it needs one and stops for approval. This
// module is only the browser's view of it — the status, the blocked ("needs
// input") queue, the per-sender rules, and the notice-dismissal memory. The
// knobs (replies per hour, minimum delay) are enforced by the server; nothing
// here sends.
//
// The notice appears once per inbox open and remembers a dismissal across
// opens in localStorage, so a blocked item John closed yesterday does not
// nag him again today (the server keeps it in the queue either way — the
// notice is presentation, the queue is truth).

import {
    getTakeover,
    updateTakeover,
    listTakeoverNeedsInput,
    answerTakeoverNeedsInput,
    dismissTakeoverNeedsInput,
    stopTakeover,
    listTakeoverSenders,
    addTakeoverSender as apiAddTakeoverSender,
    updateTakeoverSender as apiUpdateTakeoverSender,
    deleteTakeoverSender as apiDeleteTakeoverSender,
    ApiError,
    type TakeoverSettings,
    type TakeoverStatus,
    type TakeoverNeedsInputItem,
    type TakeoverSender,
    type TakeoverSenderInput,
    type TakeoverSenderPatch
} from './api';

const DISMISS_KEY = 'webmail.takeover-dismissed.v1';
const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Dismissed notice ids → when, pruned on load. A record (not a Set) so it
// serialises straight to localStorage and stale ids age out on their own.
function readDismissed(): Record<string, number> {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DISMISS_KEY) : null;
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        const now = Date.now();
        const kept: Record<string, number> = {};
        for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof at === 'number' && now - at < DISMISS_TTL_MS) kept[id] = at;
        }
        return kept;
    } catch {
        return {};
    }
}

const state = $state({
    status: null as TakeoverStatus | null,
    items: [] as TakeoverNeedsInputItem[],
    /** Per-sender "AI replies" rules. The assistant only ever answers
     *  mail from a sender listed here; behaviour comes from the rule. */
    senders: [] as TakeoverSender[],
    /** A load completed (success or handled failure) — gates first paint. */
    loaded: false,
    /** The per-sender rules have been fetched at least once. */
    sendersLoaded: false,
    /** A rule add/save/remove is in flight (does not block the global knobs). */
    sendersBusy: false,
    /** The server has no takeover feature at all (404): hide every affordance. */
    unavailable: false,
    error: null as string | null,
    busy: false,
    /** Session: the "couldn't continue" window was shown and closed/handled
     *  this open. One window per open, like the PWA update prompt. */
    dismissed: false,
    /** Persisted per-item notice dismissals (id → timestamp). */
    dismissedIds: readDismissed()
});

export const takeover = state;

// The item the "couldn't continue" window shows: the oldest blocked item
// whose notice has not been dismissed. Functions, not exported $derived —
// Svelte 5 refuses exported derived state from a module
// (derived_invalid_export) and prescribes exactly this shape.
export function takeoverNoticeItem(): TakeoverNeedsInputItem | null {
    if (!state.loaded || state.dismissed || state.unavailable) return null;
    return state.items.find((i) => !(i.id in state.dismissedIds)) ?? null;
}

export function takeoverActive(): boolean {
    return !!state.status?.enabled;
}

// One lockstep behaviour shared by first load and every mutation: the store
// mirrors exactly what the server reports (the server clamps the knobs and
// returns the effective values).
async function refresh(): Promise<void> {
    const [status, items, senders] = await Promise.all([
        getTakeover(),
        listTakeoverNeedsInput(),
        listTakeoverSenders()
    ]);
    state.status = status;
    state.items = items;
    state.senders = senders;
    state.sendersLoaded = true;
}

export async function loadTakeover(): Promise<void> {
    if (state.loaded || state.unavailable) return;
    try {
        await refresh();
    } catch (e) {
        if (e instanceof ApiError && e.status === 404) state.unavailable = true;
        else state.error = (e as Error).message || 'Could not load the assistant status';
    } finally {
        state.loaded = true;
    }
}

export async function setTakeoverEnabled(on: boolean): Promise<void> {
    state.busy = true;
    try {
        // OFF goes through /stop, which disables AND clears the blocked
        // queue — a stopped assistant must not leave prompts behind. ON is
        // a plain settings write; the server starts polling for this user.
        if (on) await updateTakeover({ enabled: true });
        else await stopTakeover();
        await refresh();
    } finally {
        state.busy = false;
    }
}

export async function setTakeoverKnobs(patch: Partial<TakeoverSettings>): Promise<void> {
    state.busy = true;
    try {
        await updateTakeover(patch);
        await refresh();
    } finally {
        state.busy = false;
    }
}

// Per-sender rules ("AI replies" under Settings → Rules). Each mutation
// re-syncs through refresh() so the list always mirrors the server — same
// lockstep as the global knobs. Errors propagate to the caller so the
// Rules card can show them next to the form that caused them.

/** Add a sender rule. The server validates the pattern (full address or
 *  @domain, ≤200 chars), caps at 50 rules and rejects duplicates. */
export async function addSenderRule(input: TakeoverSenderInput): Promise<void> {
    state.sendersBusy = true;
    try {
        await apiAddTakeoverSender(input);
        await refresh();
    } finally {
        state.sendersBusy = false;
    }
}

/** Change a rule's instructions, autoSend or signReplies. */
export async function saveSenderRule(id: string, patch: TakeoverSenderPatch): Promise<void> {
    state.sendersBusy = true;
    try {
        await apiUpdateTakeoverSender(id, patch);
        await refresh();
    } finally {
        state.sendersBusy = false;
    }
}

/** Remove a rule — the assistant immediately stops handling that sender. */
export async function removeSenderRule(id: string): Promise<void> {
    state.sendersBusy = true;
    try {
        await apiDeleteTakeoverSender(id);
        await refresh();
    } finally {
        state.sendersBusy = false;
    }
}

/** "Resume with advice" — the answer feeds the next draft, which still
 *  waits for approval. Never sends. */
export async function answerTakeoverItem(id: string, advice: string): Promise<void> {
    state.busy = true;
    try {
        await answerTakeoverNeedsInput(id, advice);
        state.dismissed = true;
        await refresh();
    } finally {
        state.busy = false;
    }
}

/** Per-item "stop" — the assistant closes the item and leaves the thread. */
export async function stopTakeoverItem(id: string): Promise<void> {
    state.busy = true;
    try {
        await dismissTakeoverNeedsInput(id);
        state.dismissed = true;
        await refresh();
    } finally {
        state.busy = false;
    }
}

/** Close the window without choosing. Persisted so it does not nag on
 *  every inbox open; the server queue is untouched. */
export function dismissTakeoverNotice(id: string): void {
    state.dismissedIds = { ...state.dismissedIds, [id]: Date.now() };
    state.dismissed = true;
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(DISMISS_KEY, JSON.stringify(state.dismissedIds));
        }
    } catch {
        // Storage blocked or full — the session dismissal still holds.
    }
}
