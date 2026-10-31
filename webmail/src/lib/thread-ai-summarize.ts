// Build AI summarize payloads for a single message or a full conversation thread.

import type { MessageDetail, MessageListItem } from './api';
import { conversationOrderChronological, findThreadForUid } from './conversation-view';

function envelopeHeaders(item: MessageListItem | MessageDetail): string[] {
    const env = item.envelope;
    const from = env.from?.[0];
    const fromLine = from
        ? `From: ${from.name || ''} <${from.address || ''}>`.trim()
        : '';
    return [
        fromLine,
        env.subject ? `Subject: ${env.subject}` : '',
        env.date ? `Date: ${env.date}` : ''
    ].filter(Boolean);
}

function bodyFromDetail(detail: MessageDetail | null, fallbackText?: string | null): string {
    if (detail?.text?.trim()) return detail.text.trim();
    if (detail?.html) {
        return detail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (fallbackText?.trim()) return fallbackText.trim();
    return '';
}

/** One RFC822-ish block for the model (headers + body). */
export function formatMessageForAi(
    detail: MessageDetail | null,
    listItem?: MessageListItem | null
): string {
    const source = detail ?? listItem;
    if (!source) return '';
    const headers = envelopeHeaders(source);
    const body = bodyFromDetail(detail, null);
    return `${headers.join('\n')}\n\n${body}`.trim();
}

export type ThreadSummarizeMode = 'message' | 'thread';

export function buildThreadSummarizePayload(input: {
    messages: MessageListItem[];
    focusUid: number;
    primaryDetail: MessageDetail | null;
    conversationDetails: Record<number, MessageDetail>;
    groupThreads: boolean;
}): { mode: ThreadSummarizeMode; text: string } {
    if (!input.groupThreads || !input.primaryDetail) {
        return {
            mode: 'message',
            text: formatMessageForAi(input.primaryDetail)
        };
    }
    const thread = findThreadForUid(input.messages, input.focusUid);
    if (!thread || thread.messages.length < 2) {
        return {
            mode: 'message',
            text: formatMessageForAi(input.primaryDetail)
        };
    }
    const ordered = conversationOrderChronological(thread);
    const blocks = ordered.map((item) => {
        const detail =
            input.conversationDetails[item.uid] ??
            (item.uid === input.focusUid ? input.primaryDetail : null);
        return formatMessageForAi(detail, item);
    });
    return {
        mode: 'thread',
        text: blocks.filter(Boolean).join('\n\n---\n\n')
    };
}
