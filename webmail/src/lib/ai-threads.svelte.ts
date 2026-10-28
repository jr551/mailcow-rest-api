// Persistent chat threads for the AI surface. Primary store is localStorage;
// threads are also synced to a hidden IMAP folder (`.AI Conversations`) so
// they survive browser switches and are available on mobile.

import { untrack } from 'svelte';
import type { ChatMessage } from './chat.svelte';
import { parseEmailContext } from './email-context';
import { authState, getSession } from './auth.svelte';
import { listMailboxes, createMailbox, listMessages, getMessage, appendRawMessage } from './api';

// Every key carries the account it belongs to (`<base>.<user>`): chats hold
// mail content and the IMAP sync copies them into the active mailbox, so a
// shared key would hand one account's threads to the next one to sign in.
const STORAGE_KEY = 'webmail.ai.threads.v1';
const TOOLS_KEY = 'webmail.ai.tools.v1';
const DELETED_KEY = 'webmail.ai.deleted.v1';
const MAX_THREADS = 100;
const AI_FOLDER = '.AI Conversations';
const SYNC_DEBOUNCE_MS = 3000;

export interface ChatThread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ChatMessage[];
    /** True once the LLM has named the thread. Without this, the cheap
     *  first-user-message snippet keeps overwriting the AI title and we
     *  end up showing leaked sentinel JSON in the sidebar. */
    aiTitled?: boolean;
    /** A chat that exists only so the composer has somewhere to put the
     *  first message. Never persisted: opening the AI workspace used to
     *  create *and save* an empty thread, so every visit left another
     *  "0 msgs" row in the history. Cleared by appendMessage. */
    draft?: boolean;
}

export interface AiToolPrefs {
    accessEmail: boolean;
    accessAllChats: boolean;
    webSearch: boolean;
}

interface State {
    threads: ChatThread[];
    activeId: string | null;
    tools: AiToolPrefs;
    pendingAutoSend: string | null;
}

function uid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

let scopeUser: string | null = authState.activeUser;

function keyFor(base: string, user: string | null = scopeUser): string | null {
    return user ? `${base}.${user}` : null;
}

function readThreads(): ChatThread[] {
    try {
        const key = keyFor(STORAGE_KEY);
        const raw = key && localStorage.getItem(key);
        if (!raw) return [];
        const arr = JSON.parse(raw) as ChatThread[];
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((t) => t && Array.isArray(t.messages))
            // Clean up the empty threads earlier versions persisted on
            // every visit. A thread with no messages carries nothing, so
            // dropping it can't lose anything the user wrote.
            .filter((t) => t.messages.length > 0);
    } catch { return []; }
}

function readDeletedIds(): string[] {
    try {
        const key = keyFor(DELETED_KEY);
        const raw = key && localStorage.getItem(key);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function writeDeletedIds(ids: string[]) {
    const key = keyFor(DELETED_KEY);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* quota */ }
}

function markDeleted(id: string) {
    const ids = readDeletedIds();
    if (!ids.includes(id)) {
        ids.push(id);
        writeDeletedIds(ids);
    }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let imapSyncInited = false;
let syncingFromImap = false;
let lastSyncAt = 0;

function writeThreads(threads: ChatThread[]) {
    try {
        // A draft has never been written to, so it must not reach storage.
        let trimmed = threads.filter((t) => !t.draft);
        if (trimmed.length > MAX_THREADS) {
            trimmed = [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
        }
        const key = keyFor(STORAGE_KEY);
        if (key) localStorage.setItem(key, JSON.stringify(trimmed));
    } catch { /* quota */ }
    if (!syncingFromImap) scheduleImapSync();
}

function readTools(): AiToolPrefs {
    try {
        const key = keyFor(TOOLS_KEY);
        const raw = key && localStorage.getItem(key);
        if (!raw) return { accessEmail: false, accessAllChats: false, webSearch: false };
        const p = JSON.parse(raw);
        return {
            accessEmail: !!p.accessEmail,
            accessAllChats: !!p.accessAllChats,
            webSearch: !!p.webSearch
        };
    } catch { return { accessEmail: false, accessAllChats: false, webSearch: false }; }
}

function writeTools(t: AiToolPrefs) {
    const key = keyFor(TOOLS_KEY);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(t)); } catch { /* quota */ }
}

// Earlier builds used one global key for every account. Its contents cannot
// be attributed to a user, so drop them (the IMAP copy restores a user's own
// threads on the next sync).
try {
    for (const k of [STORAGE_KEY, TOOLS_KEY, DELETED_KEY]) localStorage.removeItem(k);
} catch { /* storage disabled */ }

const initialThreads = readThreads();
const state = $state<State>({
    threads: initialThreads,
    activeId: initialThreads[0]?.id ?? null,
    tools: readTools(),
    pendingAutoSend: null
});

export function requestAutoSend(threadId: string) {
    state.activeId = threadId;
    state.pendingAutoSend = threadId;
}
export function clearAutoSend() {
    state.pendingAutoSend = null;
}

export const aiState = state;

// Follow the active account: reload that account's threads and tool prefs,
// and forget everything stored for an account that has signed out.
function syncScope() {
    const user = authState.activeUser;
    if (user === scopeUser) return;
    scopeUser = user;
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    imapSyncInited = false;
    lastSyncAt = 0;
    const threads = readThreads();
    state.threads = threads;
    state.activeId = threads[0]?.id ?? null;
    state.tools = readTools();
    state.pendingAutoSend = null;
    if (user) void refreshImapSync();
}

function clearUserStorage(user: string) {
    try {
        for (const base of [STORAGE_KEY, TOOLS_KEY, DELETED_KEY]) {
            localStorage.removeItem(`${base}.${user}`);
        }
    } catch { /* storage disabled */ }
}

let knownUsers = authState.sessions.map((s) => s.user);
$effect.root(() => {
    $effect(() => {
        const users = authState.sessions.map((s) => s.user);
        void authState.activeUser;
        untrack(() => {
            for (const u of knownUsers) if (!users.includes(u)) clearUserStorage(u);
            knownUsers = users;
            syncScope();
        });
    });
});

// `persist: true` forces the thread to be saved straight away — used when
// something other than the composer creates it with content in mind.
// The default is a draft: visible in the sidebar so the user can type into
// it, but not written to storage until it actually holds a message.
export function newThread(opts: { persist?: boolean } = {}): ChatThread {
    syncScope();
    const t: ChatThread = {
        id: uid(),
        title: '💬 New chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        ...(opts.persist ? {} : { draft: true })
    };
    // Replace any untouched draft rather than stacking them up, so
    // navigating in and out of the workspace can't accumulate rows.
    state.threads = [t, ...state.threads.filter((x) => !x.draft)];
    state.activeId = t.id;
    writeThreads(state.threads);
    return t;
}

export function selectThread(id: string) {
    syncScope();
    if (state.threads.find((t) => t.id === id)) state.activeId = id;
}

export function deleteThread(id: string) {
    syncScope();
    state.threads = state.threads.filter((t) => t.id !== id);
    if (state.activeId === id) state.activeId = state.threads[0]?.id ?? null;
    writeThreads(state.threads);
    markDeleted(id);
}

export function renameThread(id: string, title: string, opts: { ai?: boolean } = {}) {
    syncScope();
    state.threads = state.threads.map((t) =>
        t.id === id
            ? { ...t, title, updatedAt: Date.now(), ...(opts.ai ? { aiTitled: true } : {}) }
            : t
    );
    writeThreads(state.threads);
}

export function appendMessage(id: string, msg: ChatMessage) {
    syncScope();
    const idx = state.threads.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const t = state.threads[idx];
    const updated: ChatThread = {
        ...t,
        messages: [...t.messages, msg],
        updatedAt: Date.now()
    };
    // First real content promotes the draft into a saved conversation.
    delete updated.draft;
    if (updated.title === '💬 New chat' && msg.role === 'user') {
        // Strip the [[email:{...}]] / "Email context (for your reference, …)"
        // sentinel so message-detail-spawned chats don't show raw JSON
        // as their sidebar title. Prefer the email subject when present
        // — it's a much better one-glance label than the user's prompt.
        const parsed = parseEmailContext(msg.content || '');
        const subject = parsed.meta?.subject?.trim();
        const fallback = parsed.display || msg.content || '';
        const raw = subject || fallback || (msg.images?.length ? '📷 Image' : '');
        if (raw) {
            const trimmed = raw.slice(0, 60).replace(/\s+/g, ' ').trim();
            updated.title = trimmed.startsWith('📷') ? trimmed : `💬 ${trimmed}`;
        }
    }
    state.threads = [
        updated,
        ...state.threads.slice(0, idx),
        ...state.threads.slice(idx + 1)
    ];
    writeThreads(state.threads);
}

export function patchLastAssistant(id: string, patch: Partial<ChatMessage>) {
    syncScope();
    const idx = state.threads.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const t = state.threads[idx];
    const lastIdx = [...t.messages].reverse().findIndex((m) => m.role === 'assistant');
    if (lastIdx < 0) return;
    const realIdx = t.messages.length - 1 - lastIdx;
    const next = t.messages.slice();
    next[realIdx] = { ...next[realIdx], ...patch };
    const updated: ChatThread = { ...t, messages: next, updatedAt: Date.now() };
    state.threads = [
        updated,
        ...state.threads.slice(0, idx),
        ...state.threads.slice(idx + 1)
    ];
    writeThreads(state.threads);
}

export function setTools(patch: Partial<AiToolPrefs>) {
    syncScope();
    state.tools = { ...state.tools, ...patch };
    writeTools(state.tools);
}

export function searchThreads(q: string): ChatThread[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return state.threads.filter((t) => {
        if (t.title.toLowerCase().includes(needle)) return true;
        return t.messages.some((m) => ((m.content || '') + (m.images?.join('') || '')).toLowerCase().includes(needle));
    });
}

function scheduleImapSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        void syncThreadsToImap();
    }, SYNC_DEBOUNCE_MS);
}

function buildRfc822(thread: ChatThread, userEmail: string): Uint8Array {
    const json = JSON.stringify(thread);
    const date = new Date(thread.updatedAt).toUTCString();
    const subject = thread.title.replace(/[\r\n]/g, ' ');
    const headers = [
        `Message-ID: <${thread.id}@ai.webmail.local>`,
        `Subject: ${subject}`,
        `From: AI Assistant <ai@webmail.local>`,
        `To: ${userEmail}`,
        `Date: ${date}`,
        `X-AI-Thread-Id: ${thread.id}`,
        `Content-Type: application/json; charset=utf-8`,
        ``,
        json
    ].join('\r\n');
    return new TextEncoder().encode(headers);
}

async function ensureAiFolder() {
    const mailboxes = await listMailboxes();
    if (mailboxes.some((m) => m.path === AI_FOLDER)) return;
    await createMailbox(AI_FOLDER);
}

async function syncThreadsToImap() {
    const session = getSession();
    if (!session || session.user !== scopeUser) return;
    const user = session.user;
    try {
        await ensureAiFolder();
        if (authState.activeUser !== user) return;
        const threadsToSync = state.threads.filter((t) => t.updatedAt > lastSyncAt);
        if (!threadsToSync.length) return;
        for (const thread of threadsToSync) {
            // The mailbox is whichever account is active when the append
            // runs; never write this account's chats into another one.
            if (authState.activeUser !== user) return;
            const rfc822 = buildRfc822(thread, session.user);
            await appendRawMessage(AI_FOLDER, rfc822, { flags: ['Seen'] });
        }
        lastSyncAt = Date.now();
    } catch (err) {
        console.error('[ai-threads] IMAP sync failed:', err);
    }
}

async function loadThreadsFromImap(): Promise<ChatThread[]> {
    const session = getSession();
    if (!session) return [];
    try {
        const mailboxes = await listMailboxes();
        if (!mailboxes.some((m) => m.path === AI_FOLDER)) return [];
        const list = await listMessages(AI_FOLDER, { page: 0, pageSize: 100 });
        const threads = new Map<string, ChatThread>();
        const deletedIds = readDeletedIds();
        for (const msg of list.messages) {
            try {
                // The folder is a chat history we own, not real mail, so the
                // usual freshness guards do not apply — but a single
                // unresponsive request must not take the whole sync with it.
                // A bare `getMessage` had no timeout at all, so on a flaky
                // connection one hung socket stalled this serial loop
                // indefinitely and every later thread reported "Failed to
                // fetch" as the connection gave up.
                const detail = await getMessage(AI_FOLDER, msg.uid, {
                    signal: AbortSignal.timeout(20_000)
                });
                if (!detail.text) continue;
                const thread = JSON.parse(detail.text) as ChatThread;
                if (!thread?.id || !Array.isArray(thread.messages)) continue;
                if (deletedIds.includes(thread.id)) continue;
                const existing = threads.get(thread.id);
                if (!existing || thread.updatedAt > existing.updatedAt) {
                    threads.set(thread.id, thread);
                }
            } catch (err) {
                // One unreadable message is not a reason to abandon the rest
                // of the history — log it and carry on.
                console.warn(`[ai-threads] skipping uid ${msg.uid}:`, err);
            }
        }
        return Array.from(threads.values());
    } catch (err) {
        console.error('[ai-threads] IMAP load failed:', err);
        return [];
    }
}

function mergeThreads(local: ChatThread[], remote: ChatThread[]): ChatThread[] {
    const byId = new Map<string, ChatThread>();
    for (const t of local) byId.set(t.id, t);
    for (const t of remote) {
        const existing = byId.get(t.id);
        if (!existing || t.updatedAt > existing.updatedAt) {
            byId.set(t.id, t);
        }
    }
    return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function initImapSync() {
    if (imapSyncInited) return;
    imapSyncInited = true;
    await refreshImapSync();
}

export async function refreshImapSync() {
    const user = authState.activeUser;
    const remote = await loadThreadsFromImap();
    if (authState.activeUser !== user || scopeUser !== user) return;
    if (remote.length) {
        syncingFromImap = true;
        const merged = mergeThreads(state.threads, remote);
        state.threads = merged;
        writeThreads(merged);
        syncingFromImap = false;
        lastSyncAt = Date.now();
    }
}
