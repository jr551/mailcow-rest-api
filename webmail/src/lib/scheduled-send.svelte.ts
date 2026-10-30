import { sendStub, ApiError } from './api';
import { playSent } from './sounds.svelte';
import { trackSent } from './sent-status.svelte';
import { showToast } from './store.svelte';
import {
    SCHEDULED_SEND_STORAGE_KEY,
    formatScheduledSendWhen,
    sanitizeScheduledItems,
    type ScheduledSendItem,
    type ScheduledSendPayload
} from './scheduled-send';

const _queue = $state<ScheduledSendItem[]>([]);
let hydrated = false;
let flushing = false;

function persist() {
    try {
        localStorage.setItem(SCHEDULED_SEND_STORAGE_KEY, JSON.stringify(_queue));
    } catch { /* quota */ }
}

export function hydrateScheduledSends() {
    if (hydrated) return;
    hydrated = true;
    try {
        const raw = localStorage.getItem(SCHEDULED_SEND_STORAGE_KEY);
        if (raw === null) return;
        _queue.splice(0, _queue.length, ...sanitizeScheduledItems(JSON.parse(raw)));
    } catch {
        _queue.splice(0, _queue.length);
    }
}

export function scheduledSendQueue(): readonly ScheduledSendItem[] {
    return _queue;
}

export function queueScheduledSend(input: {
    sendAtMs: number;
    payload: ScheduledSendPayload;
    subject: string;
    toLabel: string;
}): ScheduledSendItem {
    hydrateScheduledSends();
    const item: ScheduledSendItem = {
        id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sendAtMs: input.sendAtMs,
        subject: input.subject,
        toLabel: input.toLabel,
        payload: input.payload
    };
    _queue.push(item);
    _queue.sort((a, b) => a.sendAtMs - b.sendAtMs);
    persist();
    showToast('success', `Send scheduled for ${formatScheduledSendWhen(item.sendAtMs)}`);
    return item;
}

export function cancelScheduledSend(id: string): boolean {
    const idx = _queue.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    _queue.splice(idx, 1);
    persist();
    showToast('info', 'Scheduled send cancelled');
    return true;
}

async function flushOne(item: ScheduledSendItem) {
    try {
        const r = await sendStub(item.payload);
        playSent();
        if (r?.messageId) {
            trackSent({ messageId: r.messageId, subject: item.subject, to: item.toLabel });
            showToast('success', `Scheduled message sent — ${item.subject}`);
        } else {
            showToast('success', 'Scheduled message sent');
        }
    } catch (err) {
        const detail = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
        showToast('error', detail || 'Scheduled send failed');
    }
}

export async function processDueScheduledSends(now = Date.now()): Promise<number> {
    hydrateScheduledSends();
    if (flushing || !_queue.length) return 0;
    const due = _queue.filter((i) => i.sendAtMs <= now);
    if (!due.length) return 0;
    flushing = true;
    let sent = 0;
    try {
        for (const item of due) {
            const idx = _queue.findIndex((i) => i.id === item.id);
            if (idx >= 0) _queue.splice(idx, 1);
            persist();
            await flushOne(item);
            sent += 1;
        }
    } finally {
        flushing = false;
    }
    return sent;
}
