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
        description: 'Messages in the selected folder'
    },
    {
        region: MAIL_READING_PANE_LABEL,
        description: 'Opened message and conversation thread'
    }
] as const;

export function mailLandmarkLabelSet(): Set<string> {
    return new Set(MAIL_LANDMARK_ROWS.map((r) => r.region));
}
