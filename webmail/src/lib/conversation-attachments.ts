import type { Attachment, MessageDetail, MessageListItem } from './api';

/** Short label for collapsed conversation rows (paperclip + count or filename). */
export function conversationAttachmentHint(
    listItem: MessageListItem,
    detail?: MessageDetail | undefined
): string | null {
    const fromDetail = detail?.attachments?.length
        ? summarizeAttachmentFilenames(detail.attachments)
        : null;
    if (fromDetail) return fromDetail;
    if (listItem.attachmentCount && listItem.attachmentCount > 0) {
        return listItem.attachmentCount === 1 ? '1 attachment' : `${listItem.attachmentCount} attachments`;
    }
    if (listItem.hasAttachments) return 'Has attachment';
    return null;
}

export function summarizeAttachmentFilenames(attachments: Attachment[]): string | null {
    if (!attachments.length) return null;
    const names = attachments
        .map((a) => (a.filename || '').trim())
        .filter(Boolean);
    if (names.length === 1) return names[0];
    if (names.length > 1) {
        const extra = names.length - 1;
        return `${names[0]} +${extra}`;
    }
    if (attachments.length === 1) return '1 attachment';
    return `${attachments.length} attachments`;
}

export function conversationAttachmentEntries(
    listItem: MessageListItem,
    detail?: MessageDetail | undefined
): Attachment[] {
    if (detail?.attachments?.length) return detail.attachments;
    if (!listItem.hasAttachments && !(listItem.attachmentCount && listItem.attachmentCount > 0)) {
        return [];
    }
    const count = Math.max(1, listItem.attachmentCount ?? 1);
    return Array.from({ length: count }, (_, i) => ({
        id: String(i + 1),
        filename: count === 1 ? 'Attachment' : `Attachment ${i + 1}`,
        contentType: 'application/octet-stream',
        size: 0,
        disposition: 'attachment',
        related: false
    }));
}
