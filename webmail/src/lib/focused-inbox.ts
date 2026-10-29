import type { MessageListItem } from './api';

/** Outlook-style inbox tab selection (INBOX only). */
export type InboxTab = 'focused' | 'other';

/** Outlook-style Focused vs Other split (no AI required). */
export type InboxBucket = 'focused' | 'other';

const BULK_LOCAL = /^(no[-_.]?reply|donotreply|mailer-daemon|newsletter|notifications?|updates?|news|marketing|promo|deals|billing|invoice|receipts?|orders?|accounts?)$/i;

const BULK_SUBJECT = /^(newsletter|digest|weekly|daily|sale|deal|offer|unsubscribe|your (invoice|receipt|order|statement))/i;

export function primaryFromAddress(msg: MessageListItem): string {
    return (msg.envelope.from?.[0]?.address ?? '').trim().toLowerCase();
}

export function localPart(address: string): string {
    const at = address.indexOf('@');
    return (at === -1 ? address : address.slice(0, at)).trim();
}

/**
 * Classify a single message into Focused or Other using deterministic rules.
 * Starred mail, VIP senders, and replies (In-Reply-To set) land in Focused;
 * typical bulk / newsletter senders land in Other.
 */
export function inboxBucketForMessage(
    msg: MessageListItem,
    opts: { isVip?: (addresses: Array<string | null | undefined>) => string | null } = {}
): InboxBucket {
    if (msg.flags.includes('\\Flagged')) return 'focused';

    const from = primaryFromAddress(msg);
    if (from && opts.isVip?.(msg.envelope.from?.map((f) => f.address) ?? [])) {
        return 'focused';
    }

    if (msg.envelope.inReplyTo) return 'focused';

    const local = localPart(from);
    if (local && BULK_LOCAL.test(local)) return 'other';

    const subject = (msg.envelope.subject ?? '').trim();
    if (subject && BULK_SUBJECT.test(subject)) return 'other';

    return 'focused';
}

export function filterMessagesByInboxTab(
    messages: MessageListItem[],
    tab: InboxTab,
    opts: { isVip?: (addresses: Array<string | null | undefined>) => string | null } = {}
): MessageListItem[] {
    return messages.filter((m) => inboxBucketForMessage(m, opts) === tab);
}
