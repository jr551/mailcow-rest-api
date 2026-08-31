// Client-side cache layer.
//
// Two storage tiers:
//   - localStorage  — small, fast, synchronous. Used for mailbox list and
//                     paginated message lists (1–10 KB each, 30–60 s TTL).
//   - IndexedDB     — async, fits MBs. Used for full message bodies (with
//                     HTML, possibly large), 24 h TTL, LRU bound at 50.
//
// Pattern (stale-while-revalidate):
//   1. Caller asks for cache.getMailboxes(). Returns whatever's in cache
//      immediately (or undefined on miss).
//   2. Caller separately fires the network fetch and on success calls
//      cache.putMailboxes(fresh).
//   3. UI renders from cache instantly, then re-renders when fetch resolves.
//
// Invalidation: any flag/move/delete action calls cache.invalidatePath(path)
// which drops every messages-list entry for that mailbox plus the body for
// the touched UID. Mailbox counts are invalidated on the next fetch (we
// always hit the network for them, the cache just removes the flash).

import type { Mailbox, MessageDetail, MessageListResponse } from './api';

const LS_PREFIX = 'webmail.cache.v1.';
const KEY_MAILBOXES = LS_PREFIX + 'mailboxes';
const KEY_MESSAGES_PREFIX = LS_PREFIX + 'messages.';
const KEY_USER_PREFIX = LS_PREFIX + 'user.'; // user-bucketed cache key prefix

// We use TWO horizons here:
//   - "fresh" — how long the cached entry counts as up-to-date enough to
//     skip the network refetch silently. Tighter, so background polling
//     drives the visible state.
//   - "keep"  — how long we hold onto the entry for offline fallback. A
//     much wider window so a PWA opened on the train still has folders.
const TTL_MAILBOXES_FRESH = 60 * 1000;
const TTL_MAILBOXES_KEEP = 30 * 86_400_000; // 30 days
const TTL_MESSAGES_FRESH = 30 * 1000;
const TTL_MESSAGES_KEEP = 30 * 86_400_000; // 30 days
const TTL_BODY = 30 * 86_400_000;
const BODY_LRU_LIMIT = 200;

// Bucket cache entries per logged-in user so switching accounts doesn't
// leak previous user's data.
function bucket(user: string | null | undefined): string {
    return user ? KEY_USER_PREFIX + encodeURIComponent(user) + '.' : '';
}

function nowMs() { return Date.now(); }

interface Entry<T> {
    value: T;
    /** Hard expiry — past this we drop the entry entirely on read. */
    expiresAt: number;
    /** When the value was last considered fresh. Past this, callers can
     *  still use the value as offline fallback but should refresh. */
    freshUntil?: number;
}

function readLs<T>(key: string, opts: { allowStale?: boolean } = {}): Entry<T> | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Entry<T>;
        if (!parsed || typeof parsed.expiresAt !== 'number') return null;
        if (parsed.expiresAt < nowMs()) {
            localStorage.removeItem(key);
            return null;
        }
        if (!opts.allowStale && typeof parsed.freshUntil === 'number' && parsed.freshUntil < nowMs()) {
            // Caller wanted only-fresh — entry kept on disk for the next
            // allowStale: true read but reported as missing here.
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function writeLs<T>(key: string, value: T, freshMs: number, keepMs: number): void {
    try {
        const entry: Entry<T> = { value, expiresAt: nowMs() + keepMs, freshUntil: nowMs() + freshMs };
        localStorage.setItem(key, JSON.stringify(entry));
    } catch {
        // QuotaExceeded — drop the oldest message entries and retry once.
        try {
            evictOldestMessages(8);
            const entry: Entry<T> = { value, expiresAt: nowMs() + keepMs, freshUntil: nowMs() + freshMs };
            localStorage.setItem(key, JSON.stringify(entry));
        } catch { /* give up silently */ }
    }
}

function evictOldestMessages(n: number) {
    const candidates: { key: string; expiresAt: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (!k.startsWith(KEY_MESSAGES_PREFIX) && !k.includes(KEY_MESSAGES_PREFIX.replace(LS_PREFIX, ''))) continue;
        try {
            const e = JSON.parse(localStorage.getItem(k) || '{}');
            candidates.push({ key: k, expiresAt: e.expiresAt || 0 });
        } catch { /* skip */ }
    }
    candidates.sort((a, b) => a.expiresAt - b.expiresAt);
    candidates.slice(0, n).forEach((c) => localStorage.removeItem(c.key));
}

// ---------- Mailboxes ----------

export function getMailboxes(user: string, opts: { allowStale?: boolean } = {}): Mailbox[] | undefined {
    const e = readLs<Mailbox[]>(bucket(user) + KEY_MAILBOXES, opts);
    return e?.value;
}

export function putMailboxes(user: string, mailboxes: Mailbox[]): void {
    writeLs(bucket(user) + KEY_MAILBOXES, mailboxes, TTL_MAILBOXES_FRESH, TTL_MAILBOXES_KEEP);
}

// ---------- Message lists ----------

function listKey(user: string, path: string, page: number, search: string | undefined): string {
    return bucket(user) + KEY_MESSAGES_PREFIX +
        encodeURIComponent(path) + '.' + page + '.' + (search || '');
}

export function getMessageList(
    user: string,
    path: string,
    page: number,
    search?: string,
    opts: { allowStale?: boolean } = {}
): MessageListResponse | undefined {
    const e = readLs<MessageListResponse>(listKey(user, path, page, search), opts);
    return e?.value;
}

/** Like getMessageList but always returns the cached value if it exists,
 *  regardless of the freshness window. Used for offline fallback when the
 *  network probe times out or fails outright. */
export function getMessageListStale(
    user: string,
    path: string,
    page: number,
    search?: string
): MessageListResponse | undefined {
    return getMessageList(user, path, page, search, { allowStale: true });
}

export function putMessageList(
    user: string,
    path: string,
    page: number,
    search: string | undefined,
    response: MessageListResponse
): void {
    writeLs(listKey(user, path, page, search), response, TTL_MESSAGES_FRESH, TTL_MESSAGES_KEEP);
}

export function invalidatePath(user: string, path: string): void {
    // Drop all message-list entries for this path.
    const prefix = bucket(user) + KEY_MESSAGES_PREFIX + encodeURIComponent(path) + '.';
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
}

export function invalidateMailboxes(user: string): void {
    localStorage.removeItem(bucket(user) + KEY_MAILBOXES);
}

// ---------- Message bodies (IndexedDB) ----------

const DB_NAME = 'webmail-cache';
const DB_VERSION = 1;
const STORE = 'bodies';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'key' });
                store.createIndex('lastUsed', 'lastUsed', { unique: false });
                store.createIndex('user', 'user', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

interface BodyRow {
    key: string;       // user|path|uid
    user: string;
    path: string;
    uid: number;
    body: MessageDetail;
    expiresAt: number;
    lastUsed: number;
}

function bodyKey(user: string, path: string, uid: number): string {
    return user + '|' + path + '|' + uid;
}

export async function getMessageBody(
    user: string,
    path: string,
    uid: number
): Promise<MessageDetail | undefined> {
    if (typeof indexedDB === 'undefined') return undefined;
    try {
        const db = await openDb();
        return await new Promise<MessageDetail | undefined>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.get(bodyKey(user, path, uid));
            req.onsuccess = () => {
                const row = req.result as BodyRow | undefined;
                if (!row) return resolve(undefined);
                if (row.expiresAt < nowMs()) {
                    store.delete(row.key);
                    return resolve(undefined);
                }
                row.lastUsed = nowMs();
                store.put(row);
                resolve(row.body);
            };
            req.onerror = () => reject(req.error);
        });
    } catch {
        return undefined;
    }
}

export async function putMessageBody(
    user: string,
    path: string,
    uid: number,
    body: MessageDetail
): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const row: BodyRow = {
                key: bodyKey(user, path, uid),
                user,
                path,
                uid,
                body,
                expiresAt: nowMs() + TTL_BODY,
                lastUsed: nowMs()
            };
            store.put(row);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        // Best-effort LRU eviction (don't block the caller).
        evictBodiesOverLimit().catch(() => {});
    } catch { /* noop */ }
}

async function evictBodiesOverLimit(): Promise<void> {
    const db = await openDb();
    return new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const countReq = store.count();
        countReq.onsuccess = () => {
            const count = countReq.result;
            if (count <= BODY_LRU_LIMIT) return resolve();
            const overflow = count - BODY_LRU_LIMIT;
            const idx = store.index('lastUsed');
            let dropped = 0;
            idx.openCursor().onsuccess = (e) => {
                const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
                if (!cur || dropped >= overflow) return resolve();
                cur.delete();
                dropped++;
                cur.continue();
            };
        };
        tx.onerror = () => resolve();
    });
}

export async function invalidateBody(user: string, path: string, uid: number): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
        const db = await openDb();
        await new Promise<void>((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(bodyKey(user, path, uid));
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch { /* noop */ }
}

export async function clearAllForUser(user: string): Promise<void> {
    // localStorage entries
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(bucket(user))) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
    // IDB rows
    if (typeof indexedDB === 'undefined') return;
    try {
        const db = await openDb();
        await new Promise<void>((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const idx = store.index('user');
            const req = idx.openCursor(IDBKeyRange.only(user));
            req.onsuccess = (e) => {
                const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
                if (!cur) return resolve();
                cur.delete();
                cur.continue();
            };
            tx.onerror = () => resolve();
        });
    } catch { /* noop */ }
}
