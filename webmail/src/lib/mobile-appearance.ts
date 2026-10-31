import type { Theme } from './theme.svelte';

/** Outlook-style appearance modes exposed on mobile Settings (matches desktop ThemeToggle). */
export const MOBILE_THEME_OPTIONS: readonly { value: Theme; label: string; testId: string }[] = [
    { value: 'auto', label: 'Auto', testId: 'mobile-theme-auto' },
    { value: 'light', label: 'Light', testId: 'mobile-theme-light' },
    { value: 'dark', label: 'Dark', testId: 'mobile-theme-dark' },
] as const;

/**
 * Colour scheme for message-body iframes. The app resolves light/dark via
 * `data-theme` + `effectiveTheme()` — not the legacy `html.dark` class.
 */
export function messageIframeTheme(effective: 'light' | 'dark'): 'light' | 'dark' {
    return effective;
}
