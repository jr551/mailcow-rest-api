import {
    MESSAGE_CATEGORIES_STORAGE_KEY,
    categoryStorageKey,
    sanitizeCategoryId,
    sanitizeCategoryOverlay,
    type MessageCategoryId
} from './message-categories';

const _overlay = $state<{ map: Record<string, MessageCategoryId> }>({ map: {} });

let hydrated = false;

function persist() {
    try {
        localStorage.setItem(MESSAGE_CATEGORIES_STORAGE_KEY, JSON.stringify(_overlay.map));
    } catch { /* quota */ }
}

export function hydrateMessageCategories() {
    if (hydrated) return;
    hydrated = true;
    try {
        const raw = localStorage.getItem(MESSAGE_CATEGORIES_STORAGE_KEY);
        if (raw === null) return;
        _overlay.map = sanitizeCategoryOverlay(JSON.parse(raw));
    } catch {
        _overlay.map = {};
    }
}

export function messageCategoryOverlay(): Record<string, MessageCategoryId> {
    return _overlay.map;
}

export function setMessageCategoryOverlay(
    mailboxPath: string,
    uid: number,
    category: MessageCategoryId | null
) {
    const key = categoryStorageKey(mailboxPath, uid);
    if (!category) {
        if (!(key in _overlay.map)) return;
        const next = { ..._overlay.map };
        delete next[key];
        _overlay.map = next;
    } else {
        _overlay.map = { ..._overlay.map, [key]: category };
    }
    persist();
}

export function pruneCategoryOverlay(validKeys: Set<string>) {
    const next: Record<string, MessageCategoryId> = {};
    for (const [k, v] of Object.entries(_overlay.map)) {
        if (validKeys.has(k)) next[k] = v;
    }
    if (Object.keys(next).length === Object.keys(_overlay.map).length) return;
    _overlay.map = next;
    persist();
}

export function remapCategoryOverlay(oldPath: string, newPath: string) {
    if (oldPath === newPath) return;
    const next: Record<string, MessageCategoryId> = {};
    let changed = false;
    for (const [k, v] of Object.entries(_overlay.map)) {
        const sep = k.indexOf('\u0000');
        if (sep === -1) {
            next[k] = v;
            continue;
        }
        const path = k.slice(0, sep);
        const uid = k.slice(sep + 1);
        if (path === oldPath) {
            next[categoryStorageKey(newPath, Number(uid))] = v;
            changed = true;
        } else {
            next[k] = v;
        }
    }
    if (!changed) return;
    _overlay.map = next;
    persist();
}

export function overlayCategoryFor(mailboxPath: string, uid: number): MessageCategoryId | null {
    return _overlay.map[categoryStorageKey(mailboxPath, uid)] ?? null;
}

export function importOverlayEntry(key: string, raw: unknown) {
    const id = sanitizeCategoryId(raw);
    if (!id) return;
    _overlay.map = { ..._overlay.map, [key]: id };
}
