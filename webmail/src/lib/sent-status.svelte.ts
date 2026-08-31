// Tracks delivery status for messages the user has just sent. Polls
// /v1/messages/send/:messageId/status with a soft backoff and also polls
// the Sent folder so the user sees confirmation that the message left our
// server. Surfaced in the UI via the toast bar in Layout.svelte.
//
// Lives in memory + a tiny localStorage shadow so a refresh during
// "pending" doesn't lose the entry.

import { getMessageDeliveryStatus, listMessages, type DeliveryStatus } from './api';
import { ui } from './store.svelte';

const STORAGE_KEY = 'webmail.sent-status.v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export interface SentRecord {
    messageId: string;
    subject: string;
    to: string;
    sentAt: number;
    status: DeliveryStatus;
    details: string | null;
    /** Set to true when the user has dismissed the entry from the toast tray. */
    dismissed?: boolean;
    /** True once we see the message in the Sent folder. */
    inSentFolder?: boolean;
    /** 'pending' = checking, 'found' = in Sent, 'slow' = >20s not found yet. */
    sentFolderStatus?: 'pending' | 'found' | 'slow';
    /** True while the row is fading out before dismissal. */
    fadingOut?: boolean;
}

interface State { records: Record<string, SentRecord> }

function read(): State {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { records: {} };
        const p = JSON.parse(raw) as State;
        // Drop anything older than 24h to keep the store from bloating.
        const now = Date.now();
        const out: State = { records: {} };
        for (const [id, r] of Object.entries(p.records || {})) {
            if (r && now - r.sentAt < MAX_AGE_MS) out.records[id] = r;
        }
        return out;
    } catch { return { records: {} }; }
}

function write(s: State) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

const _state = $state<State>(read());
export const sentStatusState = _state;

const polling = new Set<string>();
const sentPolling = new Set<string>();

export function trackSent(input: { messageId: string; subject: string; to: string }): SentRecord {
    const rec: SentRecord = {
        messageId: input.messageId,
        subject: input.subject,
        to: input.to,
        sentAt: Date.now(),
        status: 'pending',
        details: null,
        sentFolderStatus: 'pending'
    };
    _state.records[rec.messageId] = rec;
    write(_state);
    schedulePoll(rec.messageId);
    scheduleSentFolderPoll(rec.messageId);
    return rec;
}

export function dismissSent(messageId: string) {
    const r = _state.records[messageId];
    if (!r) return;
    _state.records[messageId] = { ...r, dismissed: true };
    write(_state);
}

export function clearOldSent() {
    const now = Date.now();
    let changed = false;
    for (const [id, r] of Object.entries(_state.records)) {
        if (!r || now - r.sentAt > MAX_AGE_MS) {
            delete _state.records[id];
            changed = true;
        }
    }
    if (changed) write(_state);
}

// ---------- Delivery-status polling (DSN / bounce check) ----------

// Backoff schedule — the bounce/DSN can take a while to land. Stops
// polling once we hit a terminal state or run out of attempts.
const POLL_DELAYS_MS = [3_000, 8_000, 20_000, 60_000, 180_000, 600_000];

const AUTO_DISMISS_MS = 5000;
const FADE_DURATION_MS = 400;

function autoDismiss(messageId: string) {
    const cur = _state.records[messageId];
    if (!cur || cur.dismissed || cur.fadingOut) return;
    _state.records[messageId] = { ...cur, fadingOut: true };
    write(_state);
    setTimeout(() => {
        const r = _state.records[messageId];
        if (r) {
            _state.records[messageId] = { ...r, dismissed: true, fadingOut: false };
            write(_state);
        }
    }, FADE_DURATION_MS);
}

function schedulePoll(messageId: string, attempt = 0) {
    if (polling.has(messageId)) return;
    if (attempt >= POLL_DELAYS_MS.length) return;
    polling.add(messageId);
    setTimeout(async () => {
        polling.delete(messageId);
        const cur = _state.records[messageId];
        if (!cur) return; // user wiped it
        try {
            const r = await getMessageDeliveryStatus(messageId);
            const terminal = r.status !== 'pending';
            const next: SentRecord = {
                ...cur,
                status: r.status,
                details: r.details ?? null
            };
            _state.records[messageId] = next;
            write(_state);
            if (terminal) {
                setTimeout(() => autoDismiss(messageId), AUTO_DISMISS_MS);
            } else if (next.status === 'pending') {
                schedulePoll(messageId, attempt + 1);
            }
        } catch {
            // Network blip / 404 — try again later but don't escalate.
            schedulePoll(messageId, attempt + 1);
        }
    }, POLL_DELAYS_MS[attempt]);
}

// ---------- Sent-folder polling (cheap local confirmation) ----------

const SENT_POLL_INTERVAL_MS = 2_000;
const SENT_POLL_SLOW_THRESHOLD_MS = 20_000;
const SENT_POLL_MAX_MS = 90_000;

function sentPath(): string {
    return ui.mailboxes.find((m) => m.specialUse === '\\Sent')?.path || 'Sent';
}

function normalizeMessageId(id: string | null): string {
    return (id || '').replace(/^<|>$/g, '');
}

function scheduleSentFolderPoll(messageId: string) {
    if (sentPolling.has(messageId)) return;
    sentPolling.add(messageId);
    const startedAt = Date.now();

    async function tick() {
        const cur = _state.records[messageId];
        if (!cur) {
            sentPolling.delete(messageId);
            return;
        }
        if (cur.inSentFolder) {
            sentPolling.delete(messageId);
            return;
        }

        const elapsed = Date.now() - startedAt;
        if (elapsed > SENT_POLL_MAX_MS) {
            _state.records[messageId] = { ...cur, sentFolderStatus: 'slow' };
            write(_state);
            sentPolling.delete(messageId);
            return;
        }

        try {
            const r = await listMessages(sentPath(), { page: 0, pageSize: 10, cache: 'no-store' });
            const found = r.messages.some((m) => normalizeMessageId(m.envelope.messageId) === normalizeMessageId(messageId));
            if (found) {
                _state.records[messageId] = { ...cur, inSentFolder: true, sentFolderStatus: 'found' };
                write(_state);
                sentPolling.delete(messageId);
                setTimeout(() => autoDismiss(messageId), AUTO_DISMISS_MS);
                return;
            }
        } catch {
            // Network blip — keep trying
        }

        // Mark slow if we've crossed the threshold
        const fresh = _state.records[messageId];
        if (fresh && !fresh.inSentFolder && elapsed > SENT_POLL_SLOW_THRESHOLD_MS && fresh.sentFolderStatus !== 'slow') {
            _state.records[messageId] = { ...fresh, sentFolderStatus: 'slow' };
            write(_state);
        }

        setTimeout(tick, SENT_POLL_INTERVAL_MS);
    }

    tick();
}

/** Resume polling for any pending records on app boot. */
export function resumePolling() {
    for (const r of Object.values(_state.records)) {
        if (r.status === 'pending') schedulePoll(r.messageId);
        if (!r.inSentFolder && r.sentFolderStatus !== 'found') scheduleSentFolderPoll(r.messageId);
    }
}
