// OWA-style "Sweep" on a message row: bulk-handle every message from the
// same sender in the current folder. Pure selection helpers live here;
// folder fetch is in message-sender-sweep-fetch.ts.

import type { MessageListItem } from './api';

export type SenderSweepAction = 'delete-all' | 'keep-latest' | 'archive-all';

export interface SenderSweepMenuItem {
    key: SenderSweepAction;
    label: string;
}

export function normalizeSenderAddress(address: string | null | undefined): string | null {
    const trimmed = (address || '').trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) return null;
    return trimmed;
}

export function senderAddressFromMessage(message: MessageListItem): string | null {
    return normalizeSenderAddress(message.envelope?.from?.[0]?.address);
}

export function senderDisplayLabel(message: MessageListItem): string {
    const from = message.envelope?.from?.[0];
    if (from?.name?.trim()) return from.name.trim();
    if (from?.address?.trim()) return from.address.trim();
    return 'this sender';
}

function messageTimestamp(message: MessageListItem): number {
    const iso = message.envelope?.date || message.internalDate || '';
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
}

export function selectSenderSweepTargets(
    messages: MessageListItem[],
    sender: string,
    action: SenderSweepAction
): MessageListItem[] {
    const needle = normalizeSenderAddress(sender);
    if (!needle) return [];
    const fromSender = messages.filter((m) => senderAddressFromMessage(m) === needle);
    if (fromSender.length === 0) return [];
    if (action === 'delete-all' || action === 'archive-all') return fromSender;
    if (fromSender.length <= 1) return [];
    const sorted = [...fromSender].sort((a, b) => messageTimestamp(b) - messageTimestamp(a));
    return sorted.slice(1);
}

export function senderSweepMenuItems(displayName: string): SenderSweepMenuItem[] {
    const who = displayName || 'this sender';
    return [
        { key: 'delete-all', label: `Delete all from ${who}` },
        { key: 'keep-latest', label: `Keep only the latest from ${who}` },
        { key: 'archive-all', label: `Move all from ${who} to Archive` }
    ];
}

export function senderSweepConfirmText(action: SenderSweepAction, count: number, displayName: string): string {
    const who = displayName || 'this sender';
    const n = count === 1 ? '1 message' : `${count} messages`;
    switch (action) {
        case 'delete-all':
            return `Move ${n} from ${who} to Deleted Items?`;
        case 'keep-latest':
            return `Move ${n} from ${who} to Deleted Items and keep only the newest?`;
        case 'archive-all':
            return `Move ${n} from ${who} to Archive?`;
        default:
            return `Apply sweep to ${n} from ${who}?`;
    }
}
