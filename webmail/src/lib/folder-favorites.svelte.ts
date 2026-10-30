// Pinned folder shortcuts (Outlook Favorites) — localStorage only.

import { isHiddenWebmailFolder } from './contacts';
import {
    FOLDER_FAVORITES_STORAGE_KEY,
    addFavoritePath,
    moveFavoritePath,
    remapFavoritePath,
    removeFavoritePath,
    resolveFavoritePaths
} from './folder-favorites';

function readStoredRaw(): unknown {
    try {
        const raw = localStorage.getItem(FOLDER_FAVORITES_STORAGE_KEY);
        if (raw === null) return undefined;
        return JSON.parse(raw) as unknown;
    } catch {
        return undefined;
    }
}

function hasPersistedFavorites(): boolean {
    try {
        return localStorage.getItem(FOLDER_FAVORITES_STORAGE_KEY) !== null;
    } catch {
        return false;
    }
}

function writePaths(paths: string[]) {
    try {
        localStorage.setItem(FOLDER_FAVORITES_STORAGE_KEY, JSON.stringify(paths));
    } catch { /* quota */ }
}

const _state = $state<{ paths: string[] }>({ paths: [] });

export const folderFavorites = _state;

/** Call when mailbox list changes — hydrates OWA defaults once, then prunes stale paths. */
export function syncFolderFavorites(mailboxes: Array<{ path: string }>) {
    const known = mailboxes.map((m) => m.path).filter((p) => !isHiddenWebmailFolder(p));
    const storedRaw = hasPersistedFavorites() ? readStoredRaw() : undefined;
    _state.paths = resolveFavoritePaths(storedRaw, known);
}

export function isFolderFavorite(path: string): boolean {
    return _state.paths.includes(path);
}

export function addFolderFavorite(path: string) {
    if (!path || isHiddenWebmailFolder(path)) return;
    _state.paths = addFavoritePath(_state.paths, path);
    writePaths(_state.paths);
}

export function removeFolderFavorite(path: string) {
    if (!_state.paths.includes(path)) return;
    _state.paths = removeFavoritePath(_state.paths, path);
    writePaths(_state.paths);
}

export function toggleFolderFavorite(path: string) {
    if (isFolderFavorite(path)) removeFolderFavorite(path);
    else addFolderFavorite(path);
}

export function reorderFolderFavorite(fromIndex: number, toIndex: number) {
    _state.paths = moveFavoritePath(_state.paths, fromIndex, toIndex);
    writePaths(_state.paths);
}

export function onFolderRenamed(oldPath: string, newPath: string) {
    if (!hasPersistedFavorites() && _state.paths.length === 0) return;
    const next = remapFavoritePath(_state.paths, oldPath, newPath);
    if (next.join('\0') === _state.paths.join('\0')) return;
    _state.paths = next;
    writePaths(_state.paths);
}

export function onFolderDeleted(path: string) {
    removeFolderFavorite(path);
}
