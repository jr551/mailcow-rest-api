// IndexedDB cache for S3 drive directory trees and thumbnails.
// Separate DB from the mail cache so versions don't collide.

import type { DriveItem } from './drive-api';

const DB_NAME = 'webmail-drive';
const DB_VERSION = 1;
const TREE_STORE = 'trees';
const THUMB_STORE = 'thumbs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(TREE_STORE)) {
                db.createObjectStore(TREE_STORE, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(THUMB_STORE)) {
                db.createObjectStore(THUMB_STORE, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function nowMs() { return Date.now(); }

const TREE_TTL = 5 * 60 * 1000; // 5 minutes

interface TreeRow {
    key: string;
    user: string;
    prefix: string;
    path: string;
    items: DriveItem[];
    expiresAt: number;
}

interface ThumbRow {
    key: string;
    user: string;
    etag: string;
    dataUrl: string;
    ts: number;
}

function treeKey(user: string, prefix: string, path: string): string {
    return `${user}|${prefix}|${path}`;
}

function thumbKey(user: string, etag: string): string {
    return `${user}|${etag}`;
}

export async function getTree(
    user: string,
    prefix: string,
    path: string
): Promise<DriveItem[] | undefined> {
    if (typeof indexedDB === 'undefined') return undefined;
    try {
        const db = await openDb();
        return await new Promise<DriveItem[] | undefined>((resolve, reject) => {
            const tx = db.transaction(TREE_STORE, 'readwrite');
            const store = tx.objectStore(TREE_STORE);
            const req = store.get(treeKey(user, prefix, path));
            req.onsuccess = () => {
                const row = req.result as TreeRow | undefined;
                if (!row) return resolve(undefined);
                if (row.expiresAt < nowMs()) {
                    store.delete(row.key);
                    return resolve(undefined);
                }
                resolve(row.items);
            };
            req.onerror = () => reject(req.error);
        });
    } catch {
        return undefined;
    }
}

export async function putTree(
    user: string,
    prefix: string,
    path: string,
    items: DriveItem[]
): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(TREE_STORE, 'readwrite');
            const store = tx.objectStore(TREE_STORE);
            const row: TreeRow = {
                key: treeKey(user, prefix, path),
                user,
                prefix,
                path,
                items,
                expiresAt: nowMs() + TREE_TTL
            };
            store.put(row);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch { /* noop */ }
}

export async function invalidateTree(
    user: string,
    prefix: string,
    path: string
): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
        const db = await openDb();
        await new Promise<void>((resolve) => {
            const tx = db.transaction(TREE_STORE, 'readwrite');
            tx.objectStore(TREE_STORE).delete(treeKey(user, prefix, path));
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch { /* noop */ }
}

export async function getThumb(
    user: string,
    etag: string
): Promise<string | undefined> {
    if (typeof indexedDB === 'undefined') return undefined;
    try {
        const db = await openDb();
        return await new Promise<string | undefined>((resolve, reject) => {
            const tx = db.transaction(THUMB_STORE, 'readonly');
            const store = tx.objectStore(THUMB_STORE);
            const req = store.get(thumbKey(user, etag));
            req.onsuccess = () => {
                const row = req.result as ThumbRow | undefined;
                resolve(row?.dataUrl);
            };
            req.onerror = () => reject(req.error);
        });
    } catch {
        return undefined;
    }
}

export async function putThumb(
    user: string,
    etag: string,
    dataUrl: string
): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(THUMB_STORE, 'readwrite');
            const store = tx.objectStore(THUMB_STORE);
            const row: ThumbRow = {
                key: thumbKey(user, etag),
                user,
                etag,
                dataUrl,
                ts: nowMs()
            };
            store.put(row);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch { /* noop */ }
}

export async function clearUser(user: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
        const db = await openDb();
        for (const storeName of [TREE_STORE, THUMB_STORE]) {
            await new Promise<void>((resolve) => {
                const tx = db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                const req = store.openCursor();
                req.onsuccess = (e) => {
                    const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
                    if (!cur) return resolve();
                    const row = cur.value as { user: string };
                    if (row.user === user) cur.delete();
                    cur.continue();
                };
                tx.onerror = () => resolve();
            });
        }
    } catch { /* noop */ }
}
