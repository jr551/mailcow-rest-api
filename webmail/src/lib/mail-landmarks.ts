/**
 * Outlook.com-style landmark labels for the mail shell (parity slice 17).
 * Screen readers use these region names; tab order follows DOM order
 * (command bar → folders → list → reading pane).
 */

export const MAIL_SKIP_LINK_TEXT = 'Skip to message list';

export const MAIL_MESSAGE_LIST_LANDMARK_ID = 'mail-message-list-landmark';
export const MAIL_READING_PANE_LANDMARK_ID = 'mail-reading-pane-landmark';

export const MAIL_COMMAND_BAR_LABEL = 'Command bar';
export const MAIL_FOLDER_NAV_LABEL = 'Mail folders';
export const MAIL_MESSAGE_LIST_LABEL = 'Message list';
export const MAIL_READING_PANE_LABEL = 'Reading pane';

export const MAIL_LANDMARK_ROWS = [
    {
        region: MAIL_COMMAND_BAR_LABEL,
        description: 'Search, refresh, settings, and account menu'
    },
    {
        region: MAIL_FOLDER_NAV_LABEL,
        description: 'Folder tree, favorites, and compose'
    },
    {
        region: MAIL_MESSAGE_LIST_LABEL,
        description: 'Messages in the selected folder; focus returns here when you close a message with Esc or close a new compose window'
    },
    {
        region: MAIL_READING_PANE_LABEL,
        description: 'Opened message and conversation thread; focus moves here when you open a message and when you close reply or forward compose'
    }
] as const;

export function mailLandmarkLabelSet(): Set<string> {
    return new Set(MAIL_LANDMARK_ROWS.map((r) => r.region));
}

export type ComposeCloseMode = 'new' | 'reply' | 'replyAll' | 'forward';

/** Where keyboard focus should land after compose closes (parity slices 45 / 47). */
export function composeCloseFocusLandmarkId(
    mode: ComposeCloseMode | null | undefined,
    hasSelectedMessage: boolean,
    readingPaneVisible: boolean
): typeof MAIL_MESSAGE_LIST_LANDMARK_ID | typeof MAIL_READING_PANE_LANDMARK_ID {
    if (mode && mode !== 'new' && hasSelectedMessage && readingPaneVisible) {
        return MAIL_READING_PANE_LANDMARK_ID;
    }
    return MAIL_MESSAGE_LIST_LANDMARK_ID;
}

export function focusMailLandmarkById(
    id: typeof MAIL_MESSAGE_LIST_LANDMARK_ID | typeof MAIL_READING_PANE_LANDMARK_ID
): void {
    document.getElementById(id)?.focus();
}

/** Move screen-reader / keyboard focus into the opened message (parity slice 41). */
export function focusMailReadingPaneLandmark(): void {
    focusMailLandmarkById(MAIL_READING_PANE_LANDMARK_ID);
}

/** Return focus to the message list after Esc closes the reading pane (parity slice 43). */
export function focusMailMessageListLandmark(): void {
    focusMailLandmarkById(MAIL_MESSAGE_LIST_LANDMARK_ID);
}
