// Cross-component shortcut state via classic Svelte writable stores.
// Writable stores subscribe via the `$store` template prefix and are
// reliable across async boundaries (where Svelte 5's $state reactive
// context tracking can be lost on `await`).

import { writable, type Writable } from 'svelte/store';
import type { Shortcut } from './api';

export const shortcutsItems: Writable<Shortcut[]> = writable([]);
export const embeddedShortcut: Writable<Shortcut | null> = writable(null);
export const popupShortcut: Writable<Shortcut | null> = writable(null);
