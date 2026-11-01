/** OWA-style search category tabs — Mail, People, Files (slice 51). */

export type SearchCategory = 'mail' | 'people' | 'files';

export type SearchCategoryDef = {
    id: SearchCategory;
    label: string;
};

export const OWA_SEARCH_CATEGORIES: SearchCategoryDef[] = [
    { id: 'mail', label: 'Mail' },
    { id: 'people', label: 'People' },
    { id: 'files', label: 'Files' }
];

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchQueryHasToken(query: string, token: string): boolean {
    const q = query.trim();
    if (!q || !token.trim()) return false;
    const re = new RegExp(`(?:^|\\s)${escapeRegExp(token.trim())}(?=\\s|$)`, 'i');
    return re.test(q);
}

function appendToken(query: string, token: string): string {
    const base = query.trim();
    const t = token.trim();
    if (!t) return base;
    if (!base) return t;
    if (searchQueryHasToken(base, t)) return base;
    return `${base} ${t}`;
}

/** Files search always scopes to messages with attachments. */
export function mailQueryForCategory(userQuery: string, category: SearchCategory): string {
    const q = userQuery.trim();
    if (category !== 'files') return q;
    return appendToken(q, 'has:attachment');
}

export function shouldRunMailSearch(category: SearchCategory): boolean {
    return category !== 'people';
}

export function searchPlaceholderForCategory(
    category: SearchCategory,
    nlEnabled: boolean
): string {
    if (category === 'people') return 'Search people — name or email…';
    if (category === 'files') return 'Search attachments — filename or subject…';
    return nlEnabled
        ? 'Search mail — plain language or from:alice…'
        : 'Search — try from:alice or has:attachment…';
}

export function isSearchCategory(value: unknown): value is SearchCategory {
    return value === 'mail' || value === 'people' || value === 'files';
}
