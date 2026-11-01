/** OWA-style inline quick reply at the bottom of the reading pane (slice 52). */

import type { MessageDetail } from './api';
import { formatAddress, formatFullDate } from './format';

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function quickReplySubject(original: string | undefined | null): string {
    const subj = (original || '').trim();
    if (!subj) return 'Re: (no subject)';
    if (/^re:\s/i.test(subj)) return subj;
    return `Re: ${subj.replace(/^(re:\s*)+/i, '')}`;
}

export function quickReplyToAddress(detail: MessageDetail): string {
    return detail.envelope.from?.[0]?.address?.trim() || '';
}

export function quickReplyRecipientLabel(detail: MessageDetail): string {
    const from = detail.envelope.from?.[0];
    if (!from) return 'sender';
    if (from.name?.trim()) return from.name.trim();
    return from.address || 'sender';
}

export function quickReplyPlaceholder(detail: MessageDetail): string {
    return `Reply to ${quickReplyRecipientLabel(detail)}…`;
}

/** Plain-text body must be non-empty after trim. */
export function canSendQuickReply(text: string): boolean {
    return text.trim().length > 0;
}

export function buildQuickReplyHtml(detail: MessageDetail, plainText: string, htmlToPlainText: (html: string) => string): string {
    const draftBlock = `<p>${escapeHtml(plainText.trim()).replace(/\n/g, '<br>')}</p>`;
    const heading = `On ${escapeHtml(formatFullDate(detail.internalDate || detail.envelope.date))}, ${escapeHtml(formatAddress(detail.envelope.from?.[0]))} wrote:`;
    const sourceText = detail.text || htmlToPlainText(detail.html || '');
    const quoted = sourceText
        ? escapeHtml(sourceText).replace(/\n/g, '<br>')
        : '<em>[No text content]</em>';
    return `${draftBlock}<p>${heading}</p><blockquote><p>${quoted}</p></blockquote>`;
}

export type QuickReplySendPayload = {
    to: string[];
    from?: string;
    fromName?: string;
    subject: string;
    html: string;
    text: string;
    inReplyTo?: string;
};

export function buildQuickReplySendPayload(
    detail: MessageDetail,
    plainText: string,
    from: string,
    fromName: string | undefined,
    htmlToPlainText: (html: string) => string
): QuickReplySendPayload | null {
    const to = quickReplyToAddress(detail);
    if (!to || !canSendQuickReply(plainText)) return null;
    const html = buildQuickReplyHtml(detail, plainText, htmlToPlainText);
    return {
        to: [to],
        from: from.trim() || undefined,
        fromName,
        subject: quickReplySubject(detail.envelope.subject),
        html,
        text: plainText.trim(),
        inReplyTo: detail.envelope.messageId || undefined
    };
}
