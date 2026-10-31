/** Outlook-style saved mail searches (localStorage only). */

export type SavedSearchScope = 'folder' | 'all';

export interface SavedMailSearch {
    id: string;
    name: string;
    query: string;
    scope: SavedSearchScope;
}

export const SAVED_MAIL_SEARCHES_STORAGE_KEY = 'webmail.saved-searches.v1';
export const MAX_SAVED_MAIL_SEARCHES = 20;
export const MAX_SAVED_SEARCH_NAME_LEN = 60;
export const MAX_SAVED_SEARCH_QUERY_LEN = 400;

function trimName(raw: string): string {
    return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_SAVED_SEARCH_NAME_LEN);
}

function trimQuery(raw: string): string {
    return raw.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, MAX_SAVED_SEARCH_QUERY_LEN);
}

function isScope(v: unknown): v is SavedSearchScope {
    return v === 'folder' || v === 'all';
}

function newId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `ss_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function sanitizeSavedMailSearches(raw: unknown): SavedMailSearch[] {
    if (!Array.isArray(raw)) return [];
    const out: SavedMailSearch[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const name = trimName(String(rec.name ?? ''));
        const query = trimQuery(String(rec.query ?? ''));
        if (!name || !query) continue;
        if (/[<>{}]/.test(query)) continue;
        const scope = isScope(rec.scope) ? rec.scope : 'folder';
        const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim().slice(0, 64) : newId();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name, query, scope });
        if (out.length >= MAX_SAVED_MAIL_SEARCHES) break;
    }
    return out;
}

export function createSavedMailSearch(
    name: string,
    query: string,
    scope: SavedSearchScope
): SavedMailSearch | null {
    const n = trimName(name);
    const q = trimQuery(query);
    if (!n || !q) return null;
    if (/[<>{}]/.test(q)) return null;
    return { id: newId(), name: n, query: q, scope: scope === 'all' ? 'all' : 'folder' };
}

/** Insert at front; replace same id if present; cap length. */
export function upsertSavedMailSearch(list: SavedMailSearch[], entry: SavedMailSearch): SavedMailSearch[] {
    const without = list.filter((s) => s.id !== entry.id);
    return [entry, ...without].slice(0, MAX_SAVED_MAIL_SEARCHES);
}

export function removeSavedMailSearch(list: SavedMailSearch[], id: string): SavedMailSearch[] {
    return list.filter((s) => s.id !== id);
}

/** Move a saved search to the front after the user runs it (OWA recents behavior). */
export function touchSavedMailSearch(list: SavedMailSearch[], id: string): SavedMailSearch[] {
    const hit = list.find((s) => s.id === id);
    if (!hit) return list;
    return upsertSavedMailSearch(list, hit);
}
