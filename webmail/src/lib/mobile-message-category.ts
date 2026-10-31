/** Mobile list row category resolution (Outlook parity slice 32). */

import { resolveMessageCategory, type MessageCategoryId } from './message-categories';

export interface MobileCategoryRow {
    uid: number;
    flags: string[];
    mailbox?: string;
}

export function mobileRowCategory(
    selectedPath: string,
    msg: MobileCategoryRow,
    overlay: Record<string, MessageCategoryId>
): MessageCategoryId | null {
    const path = msg.mailbox ?? selectedPath;
    return resolveMessageCategory(path, msg.uid, msg.flags, overlay);
}
