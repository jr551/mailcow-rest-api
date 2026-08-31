import type { Mailbox, MessageDetail, MessageListItem } from '../../lib/api';
import { playError } from '../../lib/sounds.svelte';
import { vibrate } from './native-bridge';

export type MobileView = 'inbox' | 'message' | 'compose' | 'folders' | 'ai' | 'drive' | 'settings';

export interface MobileState {
    view: MobileView;
    previousView: MobileView;
    mailboxes: Mailbox[];
    mailboxesLoading: boolean;
    selectedPath: string;
    messages: MessageListItem[];
    messagesTotal: number;
    messagesLoading: boolean;
    messagesError: string | null;
    search: string;
    /** 'all' aggregates results across every folder; rows carry .mailbox. */
    searchScope: 'folder' | 'all';
    selectedUid: number | null;
    detail: MessageDetail | null;
    detailLoading: boolean;
    detailError: string | null;
    composeReplyTo: MessageDetail | null;
    composeMode: 'new' | 'reply' | 'replyAll' | 'forward';
    /** One-shot prefill for a fresh compose, populated by launch
     *  intents (manifest shortcut, share-target, mailto: protocol).
     *  ComposeView consumes-and-clears these on mount. */
    composePrefillTo: string;
    composePrefillSubject: string;
    composePrefillBody: string;
    toast: { kind: 'info' | 'error' | 'success'; message: string; ts: number } | null;
    filter: 'all' | 'unread' | 'starred' | 'ai-sorted';
    /** Increments every time the document goes hidden→visible. Views
     *  that need to revalidate stale state on app-resume can mirror
     *  this in an $effect. */
    resumeTick: number;
}

const initial: MobileState = {
    view: 'inbox',
    previousView: 'inbox',
    mailboxes: [],
    mailboxesLoading: false,
    selectedPath: 'INBOX',
    messages: [],
    messagesTotal: 0,
    messagesLoading: false,
    messagesError: null,
    search: '',
    searchScope: 'folder',
    selectedUid: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    composeReplyTo: null,
    composeMode: 'new',
    composePrefillTo: '',
    composePrefillSubject: '',
    composePrefillBody: '',
    toast: null,
    filter: 'all',
    resumeTick: 0,
};

export const mobileState = $state<MobileState>(initial);

// Internal flag set while a popstate event is dispatching so navigate()
// doesn't push a redundant history entry while we're handling the OS
// back button.
let suppressHistoryPush = false;

export function navigate(view: MobileView) {
    if (mobileState.view === view) return;
    mobileState.previousView = mobileState.view;
    mobileState.view = view;
    if (typeof window !== 'undefined' && !suppressHistoryPush) {
        // Mirror the navigation in the browser/Android history stack so
        // hardware back navigates between views before exiting the PWA.
        try { history.pushState({ view }, '', location.href); } catch { /* */ }
    }
}

export function goBack() {
    if (typeof window !== 'undefined' && history.length > 1) {
        // Defer to the browser/OS back so the history stack stays in
        // sync with our mirror of it.
        history.back();
        return;
    }
    const prev = mobileState.previousView;
    mobileState.previousView = mobileState.view;
    mobileState.view = prev;
}

// LIFO of overlay-close callbacks. Modal sheets / popovers / pickers
// register a closer when they open; the OS back button calls the top
// closer instead of restoring a previous view. Empty stack → fall
// through to view-level navigation.
interface OverlayEntry { id: string; close: () => void; }
const overlayStack: OverlayEntry[] = [];

export function pushOverlay(id: string, close: () => void): () => void {
    overlayStack.push({ id, close });
    if (typeof window !== 'undefined') {
        try { history.pushState({ view: mobileState.view, overlay: id }, '', location.href); } catch { /* */ }
    }
    // Returned disposer lets the component remove its entry without
    // triggering a popstate (e.g. user dismisses via the X button).
    return () => {
        const idx = overlayStack.findIndex((o) => o.id === id);
        if (idx >= 0) {
            overlayStack.splice(idx, 1);
            if (typeof window !== 'undefined' && history.state && (history.state as { overlay?: string }).overlay === id) {
                // Walk the history back so the stack stays balanced —
                // no state mismatch between our overlayStack and the
                // browser's. suppressHistoryPush prevents the popstate
                // from re-popping the (now-missing) overlay.
                suppressHistoryPush = true;
                try { history.back(); } catch { /* */ }
                // Reset on next tick — popstate handler clears it too,
                // but in case of failure the timeout is the safety net.
                setTimeout(() => { suppressHistoryPush = false; }, 50);
            }
        }
    };
}

// Wires popstate → mobile view restore. Called once from App.svelte
// onMount. Idempotent (no-op when called twice; the listener is
// installed against window so a fresh listener replaces the old one
// with the same key).
let popstateInstalled = false;
export function installAndroidBackHandler(): () => void {
    if (typeof window === 'undefined') return () => {};
    if (popstateInstalled) return () => {};
    popstateInstalled = true;
    // Prime the stack with a known starting state — without this, the
    // very first hardware back leaves the PWA before we ever see the
    // popstate (because there's no history entry behind us).
    try { history.replaceState({ view: mobileState.view }, '', location.href); } catch { /* */ }
    const onPop = (e: PopStateEvent) => {
        // Overlay first: any open sheet/modal eats the back press
        // before we touch the view stack. Closing one *can* trigger
        // a child popstate (the disposer in pushOverlay), so we mark
        // suppressHistoryPush to keep the chain calm.
        if (overlayStack.length > 0) {
            const top = overlayStack.pop()!;
            try { top.close(); } catch { /* */ }
            // Don't navigate views — the popstate already shifted us
            // back one entry, so the view should remain wherever the
            // overlay was opened over.
            return;
        }
        const target = (e.state && (e.state as { view?: MobileView }).view) || 'inbox';
        suppressHistoryPush = true;
        try {
            mobileState.previousView = mobileState.view;
            mobileState.view = target;
        } finally {
            suppressHistoryPush = false;
        }
    };
    window.addEventListener('popstate', onPop);
    return () => {
        window.removeEventListener('popstate', onPop);
        popstateInstalled = false;
    };
}

export function showToast(kind: 'info' | 'error' | 'success', message: string) {
    // Per UX request: don't surface raw error toasts to the mobile user —
    // backend strings like "listMessages failed: 502" are noise they
    // can't act on. Log to console so we can still diagnose. Info /
    // success still show as normal toasts.
    if (kind === 'error') {
        // eslint-disable-next-line no-console
        console.warn('[mobile-toast suppressed]', message);
        return;
    }
    mobileState.toast = { kind, message, ts: Date.now() };
    if (kind === 'success') {
        vibrate('success');
    }
}

export function clearToast() {
    mobileState.toast = null;
}

$effect.root(() => {
    $effect(() => {
        if (!mobileState.toast) return;
        const t = setTimeout(clearToast, 3000);
        return () => clearTimeout(t);
    });
});
