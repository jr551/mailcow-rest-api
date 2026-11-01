/**
 * Outlook-style mail shortcuts for /webmail/mobile/ when using an external
 * keyboard (tablet, iPad, or phone + Bluetooth keyboard). Touch-only use
 * does not require these chords.
 */

import {
    mailShortcutModifiersBlocked,
    type MailShortcutAction,
    type MailShortcutRow,
} from './mail-keyboard-shortcuts';

export type { MailShortcutAction, MailShortcutRow };

/** Help sheet + Settings copy (OWA-aligned; reading-pane chords are desktop/tablet shell). */
export const MOBILE_MAIL_KEYBOARD_SHORTCUT_ROWS: MailShortcutRow[] = [
    { keys: '↑ / ↓ or J / K', description: 'Highlight previous / next message in the list' },
    { keys: 'Enter', description: 'Open highlighted message' },
    { keys: 'N', description: 'New message' },
    { keys: 'R', description: 'Reply (while reading a message)' },
    { keys: 'Shift+R', description: 'Reply all' },
    { keys: 'Shift+F', description: 'Forward' },
    { keys: 'E', description: 'Archive highlighted or open message' },
    { keys: 'Delete', description: 'Delete (move to Trash)' },
    { keys: 'Q', description: 'Mark as read' },
    { keys: 'U', description: 'Mark as unread' },
    { keys: 'Insert', description: 'Flag / unflag message' },
    { keys: '/', description: 'Focus search' },
    { keys: '?', description: 'Show keyboard shortcuts' },
    { keys: 'Esc', description: 'Close this sheet, leave search, go back from a message, and return focus to the message list' },
];

type KeyLike = Pick<KeyboardEvent, 'key' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;

export function resolveMobileMailShortcut(e: KeyLike): MailShortcutAction | 'open-message' | null {
    if (mailShortcutModifiersBlocked(e)) return null;
    if (e.ctrlKey || e.metaKey) return null;

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) return 'open-message';

    if (e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'r') return 'reply-all';
        if (k === 'f') return 'forward';
        if (e.key === '?' || k === '?') return 'show-help';
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
    if (k === '?') return 'show-help';

    return null;
}
