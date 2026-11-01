/** Outlook-style search refiners — toggle IMAP tag tokens on an active query. */

export type SearchRefinerId = 'has-attachment' | 'is-unread' | 'is-flagged' | 'is-read';

export type SearchRefiner = {
    id: SearchRefinerId;
    label: string;
    token: string;
};

export const OWA_SEARCH_REFINERS: SearchRefiner[] = [
    { id: 'has-attachment', label: 'Has attachments', token: 'has:attachment' },
    { id: 'is-unread', label: 'Unread', token: 'is:unread' },
    { id: 'is-flagged', label: 'Flagged', token: 'is:flagged' },
    { id: 'is-read', label: 'Read', token: 'is:read' }
];

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the query already contains this exact tag token. */
export function searchQueryHasToken(query: string, token: string): boolean {
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

function removeToken(query: string, token: string): string {
    const t = token.trim();
    if (!t) return query.trim();
    const re = new RegExp(`(?:^|\\s)${escapeRegExp(t)}(?=\\s|$)`, 'gi');
    const next = query.replace(re, ' ').replace(/\s+/g, ' ').trim();
    return next;
}

/** Add or remove a refiner token; returns the updated query (may be empty). */
export function toggleSearchRefinerToken(query: string, token: string): string {
    if (searchQueryHasToken(query, token)) return removeToken(query, token);
    return appendToken(query, token);
}

export function refinerIsActive(query: string, refiner: SearchRefiner): boolean {
    return searchQueryHasToken(query, refiner.token);
}

/** Refiners show only when the user has an active search string. */
export function showSearchRefiners(query: string): boolean {
    return query.trim().length > 0;
}
