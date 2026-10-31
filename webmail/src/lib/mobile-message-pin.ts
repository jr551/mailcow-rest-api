/** Mobile list row pin resolution (Outlook parity slice 34). */

import { isMessagePinned, type PinSnoozeOverlay } from './message-pin-snooze';

export interface MobilePinRow {
    uid: number;
    mailbox?: string;
}

export function mobileRowMailboxPath(selectedPath: string, msg: MobilePinRow): string {
    return msg.mailbox ?? selectedPath;
}

export function mobileRowIsPinned(
    overlay: PinSnoozeOverlay,
    selectedPath: string,
    msg: MobilePinRow
): boolean {
    return isMessagePinned(overlay, mobileRowMailboxPath(selectedPath, msg), msg.uid);
}

export function mobilePinActionLabel(pinned: boolean): string {
    return pinned ? 'Unpin' : 'Pin to top';
}
