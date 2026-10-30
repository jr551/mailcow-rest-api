import { sendStub, ApiError } from './api';
import { playSent } from './sounds.svelte';
import { trackSent } from './sent-status.svelte';
import { ui, showToast } from './store.svelte';
import type { ComposeRestoreSnapshot } from './undo-send';

type SendPayload = Parameters<typeof sendStub>[0];

interface PendingSend {
    id: string;
    ts: number;
    payload: SendPayload;
    sentSubject: string;
    toLabel: string;
    composeContext: typeof ui.composeContext;
    restore: ComposeRestoreSnapshot;
    timer: ReturnType<typeof setTimeout>;
}

let pending: PendingSend | null = $state(null);

function clearPending() {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
    ui.sendUndo = null;
}

async function flushSend(p: PendingSend) {
    try {
        const r = await sendStub(p.payload);
        playSent();
        if (r?.messageId) {
            trackSent({ messageId: r.messageId, subject: p.sentSubject, to: p.toLabel });
            showToast('info', 'Sending… we\'ll let you know when it\'s delivered.');
        } else {
            showToast('success', 'Message sent');
        }
    } catch (err) {
        const detail = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
        showToast('error', detail || 'Send failed');
    }
}

export function scheduleUndoSend(input: {
    seconds: number;
    payload: SendPayload;
    sentSubject: string;
    toLabel: string;
    composeContext: typeof ui.composeContext;
    restore: ComposeRestoreSnapshot;
    onScheduled: () => void;
}) {
    if (pending) {
        const prev = pending;
        clearTimeout(prev.timer);
        void flushSend(prev);
    }

    const id = `send-${Date.now()}`;
    const ts = Date.now();
    const timer = setTimeout(async () => {
        if (!pending || pending.id !== id) return;
        const snap = pending;
        clearPending();
        await flushSend(snap);
    }, Math.max(0, input.seconds) * 1000);

    pending = {
        id,
        ts,
        payload: input.payload,
        sentSubject: input.sentSubject,
        toLabel: input.toLabel,
        composeContext: input.composeContext,
        restore: input.restore,
        timer
    };
    ui.sendUndo = { id, ts };
    showToast('success', input.seconds === 1 ? 'Sending in 1 second' : `Sending in ${input.seconds} seconds`);
    input.onScheduled();
}

export function cancelPendingSend(): boolean {
    const p = pending;
    if (!p) return false;
    clearPending();
    ui.composeContext = {
        ...(p.composeContext || { mode: 'new', replyTo: null }),
        restore: p.restore
    };
    ui.composeOpen = true;
    showToast('info', 'Send cancelled');
    return true;
}

export function hasPendingSend(): boolean {
    return pending !== null;
}
