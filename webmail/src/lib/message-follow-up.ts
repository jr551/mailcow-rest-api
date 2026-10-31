/** Outlook-style follow-up flag due dates (local overlay + IMAP \\Flagged). */

import { messageOverlayKey } from './message-pin-snooze';

export const MESSAGE_FOLLOW_UP_STORAGE_KEY = 'webmail.message-follow-up.v1';

export type FollowUpPresetId = 'today' | 'tomorrow' | 'this-week' | 'no-date';

export interface FollowUpOverlay {
    /** End-of-reminder instant in local time (ms). Omitted key = flagged with no due date. */
    dueBy: Record<string, number>;
}

export const FOLLOW_UP_PRESET_MENU: { id: FollowUpPresetId; label: string }[] = [
    { id: 'today', label: 'Today' },
    { id: 'tomorrow', label: 'Tomorrow' },
    { id: 'this-week', label: 'This week' },
    { id: 'no-date', label: 'No date' }
];

export function emptyFollowUpOverlay(): FollowUpOverlay {
    return { dueBy: {} };
}

export function sanitizeFollowUpOverlay(raw: unknown): FollowUpOverlay {
    if (!raw || typeof raw !== 'object') return emptyFollowUpOverlay();
    const o = raw as Record<string, unknown>;
    const dueBy: Record<string, number> = {};
    if (o.dueBy && typeof o.dueBy === 'object') {
        for (const [k, v] of Object.entries(o.dueBy as Record<string, unknown>)) {
            const n = typeof v === 'number' ? v : Number(v);
            if (typeof k === 'string' && k.includes('\u0000') && Number.isFinite(n) && n > 0) {
                dueBy[k] = n;
            }
        }
    }
    return { dueBy };
}

export function followUpOverlayKey(mailboxPath: string, uid: number): string {
    return messageOverlayKey(mailboxPath, uid);
}

function startOfLocalDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfLocalDay(d: Date): number {
    const end = startOfLocalDay(d);
    end.setHours(23, 59, 59, 999);
    return end.getTime();
}

/** Reminder instants for OWA-style follow-up presets (local time). */
export function followUpDueForPreset(preset: FollowUpPresetId, nowMs: number): number | null {
    const now = new Date(nowMs);
    switch (preset) {
        case 'today':
            return endOfLocalDay(now);
        case 'tomorrow': {
            const t = new Date(startOfLocalDay(now));
            t.setDate(t.getDate() + 1);
            return endOfLocalDay(t);
        }
        case 'this-week': {
            const day = now.getDay();
            const daysUntilSunday = day === 0 ? 0 : 7 - day;
            const sun = new Date(startOfLocalDay(now));
            sun.setDate(sun.getDate() + daysUntilSunday);
            return endOfLocalDay(sun);
        }
        case 'no-date':
            return null;
        default:
            return null;
    }
}

export function followUpSubmenuItems(): { key: string; label: string }[] {
    return [
        ...FOLLOW_UP_PRESET_MENU.map((p) => ({ key: p.id, label: p.label })),
        { key: 'clear', label: 'Clear flag' }
    ];
}

export function getFollowUpDueMs(
    overlay: FollowUpOverlay,
    mailboxPath: string,
    uid: number
): number | null {
    const key = followUpOverlayKey(mailboxPath, uid);
    const v = overlay.dueBy[key];
    return typeof v === 'number' && v > 0 ? v : null;
}

/** Human-readable label for list rows (e.g. "Follow up today"). */
export function followUpDueLabel(dueMs: number | null, nowMs: number): string | null {
    if (dueMs === null) return null;
    const now = new Date(nowMs);
    const due = new Date(dueMs);
    const todayEnd = endOfLocalDay(now);
    const tomorrowEnd = followUpDueForPreset('tomorrow', nowMs);
    if (dueMs <= todayEnd) return 'Follow up today';
    if (tomorrowEnd !== null && dueMs <= tomorrowEnd) return 'Follow up tomorrow';
    const weekEnd = followUpDueForPreset('this-week', nowMs);
    if (weekEnd !== null && dueMs <= weekEnd) return 'Follow up this week';
    return `Follow up ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export function isFollowUpOverdue(dueMs: number | null, nowMs: number): boolean {
    if (dueMs === null) return false;
    return dueMs < nowMs;
}
