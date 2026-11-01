/**
 * Outlook on the web-style global mail shortcuts (when focus is not in an input).
 * Reading-pane chords (Alt+Shift+R/B/H) live in reading-pane-layout.ts.
 */

export type MailShortcutAction =
    | 'navigate-next'
    | 'navigate-prev'
    | 'compose-new'
    | 'reply'
    | 'reply-all'
    | 'forward'
    | 'archive'
    | 'delete'
    | 'mark-read'
    | 'mark-unread'
    | 'toggle-flag'
    | 'focus-search'
    | 'show-help'
    | 'undo';

export type MailShortcutRow = { keys: string; description: string };

/** Rows for Settings and the in-app help dialog (OWA-aligned where noted). */
export const MAIL_KEYBOARD_SHORTCUT_ROWS: MailShortcutRow[] = [
    { keys: '↑ / ↓ or J / K', description: 'Select previous / next message' },
    { keys: 'N', description: 'New message' },
    { keys: 'R', description: 'Reply' },
    { keys: 'Shift+R', description: 'Reply all' },
    { keys: 'Shift+F', description: 'Forward' },
    { keys: 'E', description: 'Archive' },
    { keys: 'Delete', description: 'Delete (move to Trash)' },
    { keys: 'Q', description: 'Mark as read' },
    { keys: 'U', description: 'Mark as unread' },
    { keys: 'Insert', description: 'Flag / unflag message' },
    { keys: '/', description: 'Focus search' },
    { keys: '?', description: 'Show keyboard shortcuts' },
    { keys: 'Ctrl+Z', description: 'Undo last move or delete' },
    { keys: 'Alt+Shift+R', description: 'Reading pane on the right' },
    { keys: 'Alt+Shift+B', description: 'Reading pane at the bottom' },
    { keys: 'Alt+Shift+H', description: 'Hide reading pane' },
    { keys: 'Esc', description: 'Close panel, clear selection, or close message (focus returns to the list)' }
];

type KeyLike = Pick<KeyboardEvent, 'key' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;

/** True when a chord should not fire mail shortcuts (browser chrome combos, etc.). */
export function mailShortcutModifiersBlocked(e: KeyLike): boolean {
    if (e.altKey && !e.shiftKey) return true;
    if (e.metaKey && e.key !== 'z' && e.key !== 'Z') return true;
    return false;
}

export function resolveMailShortcut(e: KeyLike): MailShortcutAction | null {
    if (mailShortcutModifiersBlocked(e)) return null;

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        return 'undo';
    }

    if (e.ctrlKey || e.metaKey) return null;

    if (e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'r') return 'reply-all';
        if (k === 'f') return 'forward';
        if (e.key === '?' || (k === '?' )) return 'show-help';
        return null;
    }

    if (e.altKey) return null;

    const k = e.key;
    const lower = k.toLowerCase();

    if (k === 'ArrowDown' || lower === 'j') return 'navigate-next';
    if (k === 'ArrowUp' || lower === 'k') return 'navigate-prev';
    if (lower === 'n') return 'compose-new';
    if (lower === 'r') return 'reply';
    if (lower === 'e') return 'archive';
    if (k === 'Delete' || k === 'Backspace') return 'delete';
    if (lower === 'q') return 'mark-read';
    if (lower === 'u') return 'mark-unread';
    if (k === 'Insert') return 'toggle-flag';
    if (k === '/') return 'focus-search';
    if (k === '?' ) return 'show-help';

    return null;
}
