import type { SendAttachment } from './api';

export const SCHEDULED_SEND_STORAGE_KEY = 'webmail.scheduled-sends.v1';

export type ScheduledSendPresetId =
    | 'in-one-hour'
    | 'this-evening'
    | 'tomorrow-morning'
    | 'next-monday-morning';

export type ScheduledSendPayload = {
    to: string[];
    cc?: string[];
    bcc?: string[];
    from?: string;
    fromName?: string;
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    trackOpens?: boolean;
    attachments?: SendAttachment[];
};

export interface ScheduledSendItem {
    id: string;
    sendAtMs: number;
    subject: string;
    toLabel: string;
    payload: ScheduledSendPayload;
}

const MIN_LEAD_MS = 60_000;
const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export function minScheduledSendAt(now = Date.now()): number {
    return now + MIN_LEAD_MS;
}

export function maxScheduledSendAt(now = Date.now()): number {
    return now + MAX_HORIZON_MS;
}

export function sanitizeSendAtMs(raw: unknown, now = Date.now()): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : NaN;
    if (!Number.isFinite(n)) return minScheduledSendAt(now);
    return Math.min(maxScheduledSendAt(now), Math.max(minScheduledSendAt(now), n));
}

/** Keep stored queue times (including past-due) so Layout can flush them. */
export function normalizeStoredSendAtMs(raw: unknown, now = Date.now()): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : NaN;
    if (!Number.isFinite(n)) return minScheduledSendAt(now);
    return Math.min(maxScheduledSendAt(now), Math.max(now - 7 * 24 * 60 * 60 * 1000, n));
}

function atLocalTime(base: Date, hour: number, minute: number): number {
    const d = new Date(base);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
}

export function computePresetSendAt(id: ScheduledSendPresetId, now = Date.now()): number {
    const base = new Date(now);
    switch (id) {
        case 'in-one-hour':
            return sanitizeSendAtMs(now + 60 * 60 * 1000, now);
        case 'this-evening': {
            let t = atLocalTime(base, 18, 0);
            if (t <= now + MIN_LEAD_MS) {
                const tomorrow = new Date(base);
                tomorrow.setDate(tomorrow.getDate() + 1);
                t = atLocalTime(tomorrow, 18, 0);
            }
            return sanitizeSendAtMs(t, now);
        }
        case 'tomorrow-morning': {
            const tomorrow = new Date(base);
            tomorrow.setDate(tomorrow.getDate() + 1);
            return sanitizeSendAtMs(atLocalTime(tomorrow, 9, 0), now);
        }
        case 'next-monday-morning': {
            const d = new Date(base);
            const day = d.getDay();
            const daysUntilMonday = ((8 - day) % 7) || 7;
            d.setDate(d.getDate() + daysUntilMonday);
            return sanitizeSendAtMs(atLocalTime(d, 9, 0), now);
        }
        default:
            return minScheduledSendAt(now);
    }
}

export const SCHEDULED_SEND_PRESETS: { id: ScheduledSendPresetId; label: string }[] = [
    { id: 'in-one-hour', label: 'In 1 hour' },
    { id: 'this-evening', label: 'This evening (6 PM)' },
    { id: 'tomorrow-morning', label: 'Tomorrow morning (9 AM)' },
    { id: 'next-monday-morning', label: 'Monday morning (9 AM)' }
];

function isPayload(raw: unknown): raw is ScheduledSendPayload {
    if (!raw || typeof raw !== 'object') return false;
    const p = raw as ScheduledSendPayload;
    return Array.isArray(p.to) && typeof p.subject === 'string';
}

export function sanitizeScheduledItems(raw: unknown, now = Date.now()): ScheduledSendItem[] {
    if (!Array.isArray(raw)) return [];
    const out: ScheduledSendItem[] = [];
    for (const row of raw) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Partial<ScheduledSendItem>;
        if (typeof r.id !== 'string' || !r.id) continue;
        if (!isPayload(r.payload)) continue;
        const sendAtMs = normalizeStoredSendAtMs(r.sendAtMs, now);
        out.push({
            id: r.id,
            sendAtMs,
            subject: String(r.subject || r.payload.subject || '(no subject)'),
            toLabel: String(r.toLabel || r.payload.to.join(', ')),
            payload: r.payload
        });
    }
    out.sort((a, b) => a.sendAtMs - b.sendAtMs);
    return out;
}

export function formatScheduledSendWhen(ms: number, now = Date.now()): string {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date(now).toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return `Today at ${time}`;
    if (isTomorrow) return `Tomorrow at ${time}`;
    return d.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}
