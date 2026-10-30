/** Outlook.com-style Favorites — pinned folder shortcuts (localStorage). */

export const FOLDER_FAVORITES_STORAGE_KEY = 'webmail.folder-favorites.v1';

/** Default OWA-like favorites when the user has never customized the list. */
export const DEFAULT_FAVORITE_PATHS = ['INBOX', 'Sent', 'Drafts'] as const;

export function sanitizeFavoritePaths(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const path = item.trim();
        if (!path || out.includes(path)) continue;
        out.push(path);
    }
    return out;
}

/** Keep only paths that still exist; preserve order. */
export function filterFavoritesToKnown(paths: string[], knownPaths: Iterable<string>): string[] {
    const known = knownPaths instanceof Set ? knownPaths : new Set(knownPaths);
    return paths.filter((p) => known.has(p));
}

/**
 * Resolve favorites for display.
 * @param storedRaw - parsed JSON from localStorage, or `undefined` if the key was never set
 */
export function resolveFavoritePaths(
    storedRaw: unknown,
    knownPaths: string[],
    defaults: readonly string[] = DEFAULT_FAVORITE_PATHS
): string[] {
    const known = new Set(knownPaths);
    if (storedRaw === undefined) {
        return defaults.filter((p) => known.has(p));
    }
    return filterFavoritesToKnown(sanitizeFavoritePaths(storedRaw), known);
}

export function isFavoritePath(paths: readonly string[], path: string): boolean {
    return paths.includes(path);
}

export function addFavoritePath(paths: readonly string[], path: string): string[] {
    if (!path || paths.includes(path)) return [...paths];
    return [...paths, path];
}

export function removeFavoritePath(paths: readonly string[], path: string): string[] {
    return paths.filter((p) => p !== path);
}

export function moveFavoritePath(paths: readonly string[], fromIndex: number, toIndex: number): string[] {
    if (fromIndex === toIndex) return [...paths];
    if (fromIndex < 0 || fromIndex >= paths.length) return [...paths];
    if (toIndex < 0 || toIndex >= paths.length) return [...paths];
    const next = [...paths];
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item);
    return next;
}

/** When a folder is renamed, update any favorite that matched the old path. */
export function remapFavoritePath(paths: readonly string[], oldPath: string, newPath: string): string[] {
    if (!oldPath || !newPath || oldPath === newPath) return [...paths];
    return paths.map((p) => (p === oldPath ? newPath : p));
}
