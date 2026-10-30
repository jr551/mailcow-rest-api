/** Outlook.com-style reading pane placement (View → Reading pane). */

export type ReadingPaneLayout = 'right' | 'bottom' | 'hidden';

export const READING_PANE_LAYOUTS: { id: ReadingPaneLayout; label: string; outlookLabel: string }[] = [
    { id: 'right', label: 'Right', outlookLabel: 'Show on the right' },
    { id: 'bottom', label: 'Bottom', outlookLabel: 'Show on the bottom' },
    { id: 'hidden', label: 'Hidden', outlookLabel: 'Hide' }
];

export function sanitizeReadingPaneLayout(raw: unknown): ReadingPaneLayout {
    return raw === 'bottom' || raw === 'hidden' ? raw : 'right';
}

/** True when the reading pane is docked beside/under the list (not the full-width flyout). */
export function isDockedReadingPane(layout: ReadingPaneLayout): boolean {
    return layout === 'right' || layout === 'bottom';
}

export function readingPaneLayoutLabel(layout: ReadingPaneLayout): string {
    return READING_PANE_LAYOUTS.find((l) => l.id === layout)?.label ?? 'Right';
}

/** Cycle layouts in OWA menu order: right → bottom → hidden → right. */
export function nextReadingPaneLayout(current: ReadingPaneLayout): ReadingPaneLayout {
    if (current === 'right') return 'bottom';
    if (current === 'bottom') return 'hidden';
    return 'right';
}

/** Keyboard chords (Alt+Shift+R/B/H) — match Outlook on the web mnemonics. */
export function readingPaneLayoutFromKeyboard(e: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'key'>): ReadingPaneLayout | null {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return null;
    const k = e.key.toLowerCase();
    if (k === 'r') return 'right';
    if (k === 'b') return 'bottom';
    if (k === 'h') return 'hidden';
    return null;
}
