// Top-level UI state shared across components.

import type { Mailbox, MessageDetail, MessageListItem, Shortcut } from './api';
import type { CalEvent } from './calendar.svelte';
import { playError } from './sounds.svelte';

export interface UiState {
    mailboxes: Mailbox[];
    mailboxesLoading: boolean;
    selectedPath: string;
    messages: MessageListItem[];
    messagesTotal: number;
    messagesPage: number;
    messagesLoading: boolean;
    messagesError: string | null;
    search: string;
    /** When 'all', the message list is an aggregated search across every
     *  folder; rows carry a `mailbox` field. 'folder' is the default. */
    searchScope: 'folder' | 'all';
    selectedUid: number | null;
    detail: MessageDetail | null;
    detailLoading: boolean;
    detailError: string | null;
    composeOpen: boolean;
    composeContext: { replyTo?: MessageDetail | null; mode?: 'new' | 'reply' | 'replyAll' | 'forward' } | null;
    settingsOpen: boolean;
    helpOpen: boolean;
    setupOpen: boolean;
    aiPanelOpen: boolean;
    selected: Set<number>;
    undo: { kind: 'trash' | 'archive' | 'move'; uid: number; fromPath: string; toPath: string; ts: number } | null;
    shortcuts: Shortcut[];
    embeddedShortcut: Shortcut | null;
    popupShortcut: Shortcut | null;
    aiSummary: string | null;
    aiSummaryLoading: boolean;
    aiSummaryError: string | null;
    aiDraft: string | null;
    aiDraftLoading: boolean;
    aiDraftError: string | null;
    aiActions: string | null;
    aiActionsLoading: boolean;
    aiActionsError: string | null;
    aiTranslate: string | null;
    aiTranslateLoading: boolean;
    aiTranslateError: string | null;
    aiTranslateLang: string;
    toast: { kind: 'info' | 'error' | 'success'; message: string; ts: number } | null;
    /** Top-level app surface — Mail, Calendar, AI chat, or Drive. */
    app: 'mail' | 'calendar' | 'ai' | 'drive';
    /** AI-suggested event awaiting user confirmation in the EventModal. */
    suggestedEvent: Partial<CalEvent> | null;
    /** True while the suggest button is calling the LLM. */
    suggestLoading: boolean;
    /** Hand-off slot for an attachment that should land in the next
     *  Compose to open (e.g. PdfViewer → "Attach to reply"). Cleared
     *  after Compose mounts. */
    pendingAttachment: { filename: string; contentType: string; dataUrl: string } | null;
    /** Floating progress widget for long-running bulk operations
     *  (move, archive, trash). Set by bulkMove callers; cleared when
     *  done. The widget itself lives in Layout. */
    bulkProgress: {
        action: string;          // human label e.g. "Moving to Trash"
        done: number;
        total: number;
        failed: number;
    } | null;
    /** Network status, kept in sync with navigator.onLine. The banner in
     *  Layout flips visibility off this. Reads served from the SW cache
     *  while offline are still useful — the banner just tells the user
     *  why writes/sends are queued or failing. */
    online: boolean;
    /** True when the most recent API response carried the
     *  `x-webmail-from-cache` header — i.e. served from the SW offline
     *  fallback. Lets the UI badge "showing cached data" subtly. */
    servingCachedApi: boolean;
}

const SESSION_KEY = 'webmail.ui.session';

function loadSession(): Partial<UiState> {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* noop */ }
    return {};
}

function saveSession(patch: Partial<UiState>) {
    try {
        const existing = loadSession();
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...existing, ...patch }));
    } catch { /* noop */ }
}

const session = loadSession();

const initial: UiState = {
    mailboxes: [],
    mailboxesLoading: false,
    selectedPath: session.selectedPath || 'INBOX',
    messages: [],
    messagesTotal: 0,
    messagesPage: 0,
    messagesLoading: false,
    messagesError: null,
    search: session.search || '',
    searchScope: 'folder',
    selectedUid: session.selectedUid ?? null,
    detail: null,
    detailLoading: false,
    detailError: null,
    composeOpen: false,
    composeContext: null,
    settingsOpen: false,
    helpOpen: false,
    setupOpen: false,
    aiPanelOpen: false,
    selected: new Set<number>(),
    undo: null,
    shortcuts: [],
    embeddedShortcut: null,
    popupShortcut: null,
    aiSummary: null,
    aiSummaryLoading: false,
    aiSummaryError: null,
    aiDraft: null,
    aiDraftLoading: false,
    aiDraftError: null,
    aiActions: null,
    aiActionsLoading: false,
    aiActionsError: null,
    aiTranslate: null,
    aiTranslateLoading: false,
    aiTranslateError: null,
    aiTranslateLang: 'English',
    toast: null,
    app: session.app || 'mail',
    suggestedEvent: null,
    suggestLoading: false,
    pendingAttachment: null,
    bulkProgress: null,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    servingCachedApi: false
};

export const ui = $state<UiState>(initial);

// Keep ui.online in sync with the browser's network status. Drives the
// offline banner in Layout and gates "send queued" UX in Compose.
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { ui.online = true; });
    window.addEventListener('offline', () => { ui.online = false; });
}

// Persist navigation state to sessionStorage so refresh lands back in the
// same folder / message without re-fetching from INBOX every time.
$effect.root(() => {
    $effect(() => {
        saveSession({
            selectedPath: ui.selectedPath,
            selectedUid: ui.selectedUid,
            search: ui.search,
            app: ui.app
        });
    });
});

export function showToast(kind: 'info' | 'error' | 'success', message: string) {
    ui.toast = { kind, message, ts: Date.now() };
    // Per-user "error" sound pack fires for every error toast — silent
    // unless they've opted in via Settings → Sounds.
    if (kind === 'error') playError();
}

export function clearToast() {
    ui.toast = null;
}

export function toggleSelected(uid: number) {
    if (ui.selected.has(uid)) ui.selected.delete(uid);
    else ui.selected.add(uid);
    ui.selected = new Set(ui.selected); // reactivity
}

export function clearSelection() {
    if (ui.selected.size === 0) return;
    ui.selected = new Set();
}

export function selectAllVisible() {
    ui.selected = new Set(ui.messages.map((m) => m.uid));
}
