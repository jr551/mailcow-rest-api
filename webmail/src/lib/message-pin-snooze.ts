/** Outlook-style pin-to-top and snooze (local overlay — no IMAP dependency). */

import type { MessageListItem } from './api';
import type { Thread } from './threads';
import { sortMessageList, type ListSort } from './list-quick-filters';

export const MESSAGE_PIN_SNOOZE_STORAGE_KEY = 'webmail.message-pin-snooze.v1';

export type SnoozePresetId = 'later-today' | 'tomorrow' | 'next-week';

export interface PinSnoozeOverlay {
    pinned: Record<string, true>;
    snoozeUntil: Record<string, number>;
}

export const SNOOZE_PRESET_MENU: { id: SnoozePresetId; label: string }[] = [
    { id: 'later-today', label: 'Later today' },
    { id: 'tomorrow', label: 'Tomorrow morning' },
    { id: 'next-week', label: 'Next week' }
];

export function messageOverlayKey(mailboxPath: string, uid: number): string {
    return `${mailboxPath}\u0000${uid}`;
}

export function emptyPinSnoozeOverlay(): PinSnoozeOverlay {
    return { pinned: {}, snoozeUntil: {} };
}

export function sanitizePinSnoozeOverlay(raw: unknown): PinSnoozeOverlay {
    if (!raw || typeof raw !== 'object') return emptyPinSnoozeOverlay();
    const o = raw as Record<string, unknown>;
    const pinned: Record<string, true> = {};
    const snoozeUntil: Record<string, number> = {};
    if (o.pinned && typeof o.pinned === 'object') {
        for (const k of Object.keys(o.pinned as Record<string, unknown>)) {
            if (typeof k === 'string' && k.includes('\u0000')) pinned[k] = true;
        }
    }
    if (o.snoozeUntil && typeof o.snoozeUntil === 'object') {
        for (const [k, v] of Object.entries(o.snoozeUntil as Record<string, unknown>)) {
            const n = typeof v === 'number' ? v : Number(v);
            if (typeof k === 'string' && k.includes('\u0000') && Number.isFinite(n) && n > 0) {
                snoozeUntil[k] = n;
            }
        }
    }
    return { pinned, snoozeUntil };
}

export function isMessagePinned(
    overlay: PinSnoozeOverlay,
    mailboxPath: string,
    uid: number
): boolean {
    return overlay.pinned[messageOverlayKey(mailboxPath, uid)] === true;
}

export function isMessageSnoozed(
    overlay: PinSnoozeOverlay,
    mailboxPath: string,
    uid: number,
    nowMs: number
): boolean {
    const until = overlay.snoozeUntil[messageOverlayKey(mailboxPath, uid)];
    return typeof until === 'number' && until > nowMs;
}

/** Drop rows hidden by an active snooze. Expired entries are kept until pruned. */
export function filterOutSnoozedMessages(
    messages: MessageListItem[],
    mailboxPath: string,
    overlay: PinSnoozeOverlay,
    nowMs: number
): MessageListItem[] {
    return messages.filter((m) => !isMessageSnoozed(overlay, mailboxPath, m.uid, nowMs));
}

/** Pinned messages stay above the rest while preserving the chosen sort within each group. */
export function sortWithPinnedFirst(
    messages: MessageListItem[],
    mailboxPath: string,
    overlay: PinSnoozeOverlay,
    sort: ListSort
): MessageListItem[] {
    const pinned: MessageListItem[] = [];
    const rest: MessageListItem[] = [];
    for (const m of messages) {
        if (isMessagePinned(overlay, mailboxPath, m.uid)) pinned.push(m);
        else rest.push(m);
    }
    return [...sortMessageList(pinned, sort), ...sortMessageList(rest, sort)];
}

/** Preserve list order within pinned / unpinned groups (for thread heads after buildThreads). */
export function sortThreadsWithPinnedFirst(
    threads: Thread[],
    mailboxPath: string,
    overlay: PinSnoozeOverlay
): Thread[] {
    const pinned: Thread[] = [];
    const rest: Thread[] = [];
    for (const t of threads) {
        const headPinned = t.messages.some((m) => isMessagePinned(overlay, mailboxPath, m.uid));
        if (headPinned) pinned.push(t);
        else rest.push(t);
    }
    return [...pinned, ...rest];
}

function startOfLocalDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function atLocalTime(base: Date, hour: number, minute = 0): number {
    const d = startOfLocalDay(base);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
}

/** OWA-style snooze targets in local time. */
export function snoozeUntilForPreset(preset: SnoozePresetId, nowMs: number): number {
    const now = new Date(nowMs);
    switch (preset) {
        case 'later-today': {
            const sixPm = atLocalTime(now, 18);
            if (sixPm > nowMs) return sixPm;
            return atLocalTime(new Date(nowMs + 86400000), 18);
        }
        case 'tomorrow':
            return atLocalTime(new Date(nowMs + 86400000), 8);
        case 'next-week': {
            const day = now.getDay();
            const daysUntilMonday = ((8 - day) % 7) || 7;
            const monday = new Date(startOfLocalDay(now));
            monday.setDate(monday.getDate() + daysUntilMonday);
            return atLocalTime(monday, 8);
        }
        default:
            return nowMs + 3600000;
    }
}

export function snoozePresetLabel(preset: SnoozePresetId): string {
    return SNOOZE_PRESET_MENU.find((p) => p.id === preset)?.label ?? preset;
}

export function pruneExpiredSnooze(overlay: PinSnoozeOverlay, nowMs: number): PinSnoozeOverlay {
    const snoozeUntil: Record<string, number> = {};
    let changed = false;
    for (const [k, until] of Object.entries(overlay.snoozeUntil)) {
        if (until > nowMs) snoozeUntil[k] = until;
        else changed = true;
    }
    if (!changed) return overlay;
    return { ...overlay, snoozeUntil };
}

export function snoozeSubmenuItems(): { key: string; label: string }[] {
    return SNOOZE_PRESET_MENU.map((p) => ({ key: p.id, label: p.label }));
}
