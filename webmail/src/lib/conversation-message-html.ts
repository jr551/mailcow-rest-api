/**
 * Sanitized HTML bodies for messages inside the reading-pane conversation
 * stack (Outlook parity slice 42). The main message still uses
 * MessageDetail's iframe pipeline; siblings in the stack previously
 * showed plain text only.
 */

import type { MessageDetail } from './api';
import { buildIframeSrcDoc, sanitizeHtml } from './sanitize';

export function conversationMessageHasHtml(detail: MessageDetail | undefined): boolean {
    const html = detail?.html;
    return typeof html === 'string' && html.trim().length > 0;
}

/** Build a sandboxed iframe srcdoc for one stack message body. */
export function buildConversationMessageSrcDoc(html: string, theme: 'light' | 'dark'): string {
    const safe = sanitizeHtml(html, { allowRemoteImages: true });
    return buildIframeSrcDoc(safe, theme, '');
}
