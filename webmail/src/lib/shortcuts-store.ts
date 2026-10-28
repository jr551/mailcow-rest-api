// Cross-component shortcut state via classic Svelte writable stores.
// Writable stores subscribe via the `$store` template prefix and are
// reliable across async boundaries (where Svelte 5's $state reactive
// context tracking can be lost on `await`).

import { writable, type Writable } from 'svelte/store';
import type { Shortcut } from './api';

export const shortcutsItems: Writable<Shortcut[]> = writable([]);
export const embeddedShortcut: Writable<Shortcut | null> = writable(null);
export const popupShortcut: Writable<Shortcut | null> = writable(null);

// Shortcut URLs come from server config. Only plain web links are ever
// opened or framed; anything else (javascript:, data:, blob:, ...) is refused.
export function safeShortcutUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url, window.location.href);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

// A frame on the webmail's own origin must not get allow-same-origin next to
// allow-scripts: it could reach the parent's storage and strip its own sandbox.
export function shortcutSandbox(safeUrl: string): string {
    const base = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
    return new URL(safeUrl).origin === window.location.origin ? base : `allow-same-origin ${base}`;
}
