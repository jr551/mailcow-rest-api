import type { MessageListItem } from './api';

/** Outlook-style message list filter (Filter menu). */
export type OutlookListFilter =
    | 'all'
    | 'unread'
    | 'starred'
    | 'attachments'
    | 'to-me'
    | 'mentions'
    | 'ai-sorted';

export type ListSort =
    | 'date-desc'
    | 'date-asc'
    | 'from-asc'
    | 'from-desc'
    | 'subject-asc'
    | 'subject-desc'
    | 'size-desc'
    | 'flagged';

export const OUTLOOK_FILTER_MENU: { value: Exclude<OutlookListFilter, 'ai-sorted'>; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'unread', label: 'Unread' },
    { value: 'starred', label: 'Flagged' },
    { value: 'to-me', label: 'To me' },
    { value: 'attachments', label: 'Has files' },
    { value: 'mentions', label: 'Mentions me' }
];

export const OUTLOOK_SORT_MENU: { value: ListSort; label: string }[] = [
    { value: 'date-desc', label: 'Newest on top' },
    { value: 'date-asc', label: 'Oldest on top' },
    { value: 'from-asc', label: 'From A to Z' },
    { value: 'from-desc', label: 'From Z to A' },
    { value: 'subject-asc', label: 'Subject A to Z' },
    { value: 'subject-desc', label: 'Subject Z to A' },
    { value: 'size-desc', label: 'Largest on top' },
    { value: 'flagged', label: 'Flagged first' }
];

export function normalizeEmail(address: string | null | undefined): string {
    return (address ?? '').trim().toLowerCase();
}

export function localPart(address: string): string {
    const at = address.indexOf('@');
    return (at === -1 ? address : address.slice(0, at)).trim();
}

export function messageTimestamp(msg: MessageListItem): number {
    const raw = msg.internalDate || msg.envelope.date;
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? t : 0;
}

export function primaryFromLabel(msg: MessageListItem): string {
    const from = msg.envelope.from?.[0];
    const name = (from?.name ?? '').trim();
    const addr = normalizeEmail(from?.address);
    return (name || addr || '').toLowerCase();
}

export function messageIsAddressedToMe(
    msg: MessageListItem,
    userEmail: string,
    extraAddresses: string[] = []
): boolean {
    const targets = new Set(
        [userEmail, ...extraAddresses].map(normalizeEmail).filter(Boolean)
    );
    if (!targets.size) return false;
    const toAddrs = (msg.envelope.to ?? []).map((a) => normalizeEmail(a.address));
    return toAddrs.some((a) => a && targets.has(a));
}

/** Subject / display-name @mention heuristics (list rows have no body). */
export function messageMentionsUser(msg: MessageListItem, userEmail: string): boolean {
    const local = localPart(normalizeEmail(userEmail));
    if (!local) return false;
    const needle = `@${local}`.toLowerCase();
    const subject = (msg.envelope.subject ?? '').toLowerCase();
    if (subject.includes(needle)) return true;
    for (const list of [msg.envelope.to, msg.envelope.cc, msg.envelope.from]) {
        for (const a of list ?? []) {
            if ((a.name ?? '').toLowerCase().includes(needle)) return true;
        }
    }
    return false;
}

export function filterMessagesByOutlookFilter(
    messages: MessageListItem[],
    filter: OutlookListFilter,
    opts: { userEmail?: string; extraAddresses?: string[] } = {}
): MessageListItem[] {
    switch (filter) {
        case 'all':
        case 'ai-sorted':
            return messages;
        case 'unread':
            return messages.filter((m) => !m.flags.includes('\\Seen'));
        case 'starred':
            return messages.filter((m) => m.flags.includes('\\Flagged'));
        case 'attachments':
            return messages.filter((m) => !!m.hasAttachments);
        case 'to-me':
            return messages.filter((m) =>
                messageIsAddressedToMe(m, opts.userEmail ?? '', opts.extraAddresses)
            );
        case 'mentions':
            return messages.filter((m) => messageMentionsUser(m, opts.userEmail ?? ''));
        default:
            return messages;
    }
}

export function compareMessagesForSort(a: MessageListItem, b: MessageListItem, sort: ListSort): number {
    switch (sort) {
        case 'date-asc':
            return messageTimestamp(a) - messageTimestamp(b);
        case 'date-desc':
            return messageTimestamp(b) - messageTimestamp(a);
        case 'from-asc':
            return primaryFromLabel(a).localeCompare(primaryFromLabel(b));
        case 'from-desc':
            return primaryFromLabel(b).localeCompare(primaryFromLabel(a));
        case 'subject-asc':
            return (a.envelope.subject ?? '').localeCompare(b.envelope.subject ?? '', undefined, { sensitivity: 'base' });
        case 'subject-desc':
            return (b.envelope.subject ?? '').localeCompare(a.envelope.subject ?? '', undefined, { sensitivity: 'base' });
        case 'size-desc':
            return (b.size ?? 0) - (a.size ?? 0);
        case 'flagged': {
            const fa = a.flags.includes('\\Flagged') ? 1 : 0;
            const fb = b.flags.includes('\\Flagged') ? 1 : 0;
            if (fb !== fa) return fb - fa;
            return messageTimestamp(b) - messageTimestamp(a);
        }
        default:
            return 0;
    }
}

export function sortMessageList(messages: MessageListItem[], sort: ListSort): MessageListItem[] {
    if (sort === 'date-desc') return messages;
    return [...messages].sort((a, b) => compareMessagesForSort(a, b, sort));
}

export function outlookFilterLabel(filter: OutlookListFilter): string {
    if (filter === 'ai-sorted') return 'AI sorted';
    return OUTLOOK_FILTER_MENU.find((f) => f.value === filter)?.label ?? 'All';
}

export function listSortLabel(sort: ListSort): string {
    return OUTLOOK_SORT_MENU.find((s) => s.value === sort)?.label ?? 'Newest on top';
}

/** IMAP search token appended to folder list fetch (Layout effectiveSearch). */
export function imapFilterToken(
    filter: OutlookListFilter,
    userEmail: string
): string {
    switch (filter) {
        case 'unread':
            return 'is:unread';
        case 'starred':
            return 'is:starred';
        case 'attachments':
            return 'has:attachment';
        case 'to-me': {
            const addr = normalizeEmail(userEmail);
            return addr ? `to:${addr}` : '';
        }
        case 'mentions': {
            const local = localPart(normalizeEmail(userEmail));
            return local ? `body:@${local}` : '';
        }
        default:
            return '';
    }
}
