// Theme manager — auto / light / dark, persisted in localStorage. Sets
// data-theme on <html>. Inline script in index.html applies it pre-paint.

export type Theme = 'auto' | 'light' | 'dark';
const STORAGE_KEY = 'webmail.theme';

function read(): Theme {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'light' || v === 'dark' || v === 'auto') return v;
    } catch { /* noop */ }
    return 'auto';
}

function apply(theme: Theme) {
    document.documentElement.setAttribute('data-theme', theme);
}

const state = $state<{ theme: Theme }>({ theme: read() });
apply(state.theme);

export function getTheme(): Theme {
    return state.theme;
}

export function setTheme(t: Theme) {
    state.theme = t;
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* noop */ }
    apply(t);
    // Subscribers (the skin palette) branch on the effective mode, so an
    // explicit toggle has to reach them too, not just an OS change.
    notifyWatchers();
}

export function nextTheme(t: Theme): Theme {
    if (t === 'auto') return 'light';
    if (t === 'light') return 'dark';
    return 'auto';
}


// --- Effective theme ------------------------------------------------------
//
// `data-theme` records the user's CHOICE, not what is on screen. 'auto' is
// resolved by CSS through a prefers-color-scheme media query, so anything
// that has to branch on the effective mode (a full skin swapping its own
// palette) cannot read the attribute alone — on 'auto' it would have to
// guess, and would be wrong whenever the OS disagrees.
//
// `effectiveTheme` is that resolution in one place, so the media query in
// app.css and the skin palette can never disagree. `isDark()` additionally
// follows the media query live, so flipping the OS while on 'auto' repaints
// the skin without a reload.

const darkQuery = typeof matchMedia === 'function'
    ? matchMedia('(prefers-color-scheme: dark)')
    : null;

// Svelte-reactive mirror of the media query, so `isDark()` is reactive
// wherever it is read from a template or a $derived.
let osPrefersDark = $state(darkQuery?.matches ?? false);

export function effectiveTheme(): 'light' | 'dark' {
    if (state.theme === 'dark') return 'dark';
    if (state.theme === 'light') return 'light';
    return osPrefersDark ? 'dark' : 'light';
}

export function isDark(): boolean {
    return effectiveTheme() === 'dark';
}

// Subscribers re-run whenever the effective mode changes for any reason:
// an explicit choice, or the OS flipping while on 'auto'.
type Watcher = () => void;
const watchers = new Set<Watcher>();

export function onEffectiveThemeChange(fn: Watcher): () => void {
    watchers.add(fn);
    return () => { watchers.delete(fn); };
}

function notifyWatchers() {
    for (const fn of [...watchers]) fn();
}

// The media listener is plain imperative wiring, NOT an $effect. A
// module-scope $effect has no owning component, and Svelte 5 throws
// effect_orphan for it — which aborts the import and takes every dependent
// module (the skin palette included) down with it. These are module-level
// singletons with the lifetime of the page, so a plain listener is also the
// honest model: there is nothing to tear down when.
//
// Subscribers are notified from the two places the effective mode can
// actually change — the media query, and an explicit setTheme().
if (darkQuery) {
    darkQuery.addEventListener('change', (e) => {
        osPrefersDark = e.matches;
        notifyWatchers();
    });
}

export const themeState = state;
