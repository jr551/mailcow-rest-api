/**
 * Outlook.com-style landmarks for `/webmail/mobile/` (parity slice 33).
 * Region ids and OWA labels match `mail-landmarks.ts` (desktop slice 17).
 */

export const MAIL_SKIP_LINK_TEXT = 'Skip to message list';

export const MAIL_MESSAGE_LIST_LANDMARK_ID = 'mail-message-list-landmark';
export const MAIL_READING_PANE_LANDMARK_ID = 'mail-reading-pane-landmark';

export const MAIL_COMMAND_BAR_LABEL = 'Command bar';
export const MAIL_MESSAGE_LIST_LABEL = 'Message list';
export const MAIL_READING_PANE_LABEL = 'Reading pane';

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
        description: 'Messages in the selected folder; Esc from a full-screen message or closing compose from the inbox returns focus here'
    },
    {
        region: MAIL_READING_PANE_LABEL,
        description: 'Opened message and conversation thread; focus moves here when you open a message'
    }
] as const;

export function focusMobileMessageListLandmark(): void {
    document.getElementById(MAIL_MESSAGE_LIST_LANDMARK_ID)?.focus();
}

/** Move screen-reader / keyboard focus into the opened message (slice 40). */
export function focusMobileReadingPaneLandmark(): void {
    document.getElementById(MAIL_READING_PANE_LANDMARK_ID)?.focus();
}
