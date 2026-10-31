/**
 * Outlook.com-style landmarks for `/webmail/mobile/` (parity slice 33).
 * Reuses desktop region ids where the skip link target matches OWA behavior.
 */

import {
    MAIL_COMMAND_BAR_LABEL,
    MAIL_MESSAGE_LIST_LABEL,
    MAIL_MESSAGE_LIST_LANDMARK_ID,
    MAIL_READING_PANE_LABEL,
    MAIL_READING_PANE_LANDMARK_ID,
    MAIL_SKIP_LINK_TEXT
} from './mail-landmarks';

export {
    MAIL_MESSAGE_LIST_LANDMARK_ID,
    MAIL_READING_PANE_LANDMARK_ID,
    MAIL_SKIP_LINK_TEXT,
    MAIL_COMMAND_BAR_LABEL,
    MAIL_MESSAGE_LIST_LABEL,
    MAIL_READING_PANE_LABEL
};

export const MOBILE_APP_NAV_LABEL = 'App navigation';

export const MOBILE_LANDMARK_ROWS = [
    {
        region: MAIL_COMMAND_BAR_LABEL,
        description: 'Folder title, search, refresh, and compose'
    },
    {
        region: MOBILE_APP_NAV_LABEL,
        description: 'Mail, folders, drive, and settings tabs'
    },
    {
        region: MAIL_MESSAGE_LIST_LABEL,
        description: 'Messages in the selected folder'
    },
    {
        region: MAIL_READING_PANE_LABEL,
        description: 'Opened message and conversation thread'
    }
] as const;

export function focusMobileMessageListLandmark(): void {
    document.getElementById(MAIL_MESSAGE_LIST_LANDMARK_ID)?.focus();
}
