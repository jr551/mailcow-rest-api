/** Outlook-style undo send: delay the API call so the user can cancel. */

export const UNDO_SEND_MIN_SEC = 0;
export const UNDO_SEND_MAX_SEC = 30;
export const UNDO_SEND_DEFAULT_SEC = 5;

export function sanitizeUndoSendSeconds(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return UNDO_SEND_DEFAULT_SEC;
    return Math.max(UNDO_SEND_MIN_SEC, Math.min(UNDO_SEND_MAX_SEC, Math.round(raw)));
}

export function undoSendEnabled(seconds: number): boolean {
    return seconds > 0;
}

export interface ComposeRestoreSnapshot {
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    body: string;
    from: string;
    trackOpens: boolean;
    attachments: Array<{ filename: string; contentType: string; size: number; content: string }>;
}
