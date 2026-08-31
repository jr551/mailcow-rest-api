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
}

export function nextTheme(t: Theme): Theme {
    if (t === 'auto') return 'light';
    if (t === 'light') return 'dark';
    return 'auto';
}

export const themeState = state;
