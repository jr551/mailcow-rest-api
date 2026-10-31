import {
    SAVED_MAIL_SEARCHES_STORAGE_KEY,
    createSavedMailSearch,
    removeSavedMailSearch,
    sanitizeSavedMailSearches,
    touchSavedMailSearch,
    upsertSavedMailSearch,
    type SavedMailSearch,
    type SavedSearchScope
} from './saved-mail-searches';

function readStored(): SavedMailSearch[] {
    try {
        const raw = localStorage.getItem(SAVED_MAIL_SEARCHES_STORAGE_KEY);
        if (raw === null) return [];
        return sanitizeSavedMailSearches(JSON.parse(raw) as unknown);
    } catch {
        return [];
    }
}

function writeStored(items: SavedMailSearch[]) {
    try {
        localStorage.setItem(SAVED_MAIL_SEARCHES_STORAGE_KEY, JSON.stringify(items));
    } catch { /* quota */ }
}

const _state = $state<{ items: SavedMailSearch[] }>({ items: readStored() });

export const savedMailSearches = _state;

export function addSavedMailSearch(name: string, query: string, scope: SavedSearchScope): SavedMailSearch | null {
    const entry = createSavedMailSearch(name, query, scope);
    if (!entry) return null;
    _state.items = upsertSavedMailSearch(_state.items, entry);
    writeStored(_state.items);
    return entry;
}

export function deleteSavedMailSearch(id: string) {
    const next = removeSavedMailSearch(_state.items, id);
    if (next.length === _state.items.length) return;
    _state.items = next;
    writeStored(_state.items);
}

export function recordSavedMailSearchUse(id: string) {
    const next = touchSavedMailSearch(_state.items, id);
    if (next === _state.items) return;
    _state.items = next;
    writeStored(_state.items);
}
