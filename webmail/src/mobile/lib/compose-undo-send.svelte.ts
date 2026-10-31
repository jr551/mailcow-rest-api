import { sendStub, ApiError } from '../../lib/api';
import { playSent } from '../../lib/sounds.svelte';
import { trackSent } from '../../lib/sent-status.svelte';
import type { ComposeRestoreSnapshot } from '../../lib/undo-send';
import { mobileUndoSendToastMessage } from '../../lib/mobile-compose-undo';
import type { MessageDetail } from '../../lib/api';
import { mobileState, navigate, showToast, type MobileView } from './store.svelte';

type SendPayload = Parameters<typeof sendStub>[0];

interface MobileComposeContext {
    mode: typeof mobileState.composeMode;
    replyTo: MessageDetail | null;
    showCc: boolean;
    previousView: MobileView;
}

interface PendingSend {
    id: string;
    ts: number;
    payload: SendPayload;
    sentSubject: string;
    toLabel: string;
    composeContext: MobileComposeContext;
    restore: ComposeRestoreSnapshot;
    timer: ReturnType<typeof setTimeout>;
}

let pending: PendingSend | null = $state(null);

function clearPending() {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
    mobileState.sendUndo = null;
}

async function flushSend(p: PendingSend) {
    try {
        const r = await sendStub(p.payload);
        playSent();
        if (r?.messageId) {
            trackSent({ messageId: r.messageId, subject: p.sentSubject, to: p.toLabel });
            showToast('info', 'Sending… we\'ll let you know when it\'s delivered.');
        } else if (r?.sent) {
            showToast('success', 'Message sent');
        } else {
            showToast('error', 'Send failed');
        }
    } catch (err) {
        const detail = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
        showToast('error', detail || 'Send failed');
    }
}

export function scheduleMobileUndoSend(input: {
    seconds: number;
    payload: SendPayload;
    sentSubject: string;
    toLabel: string;
    composeContext: MobileComposeContext;
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
    mobileState.sendUndo = { id, ts };
    showToast(
        'success',
        mobileUndoSendToastMessage(input.seconds)
    );
    input.onScheduled();
}

export function cancelMobilePendingSend(): boolean {
    const p = pending;
    if (!p) return false;
    clearPending();
    mobileState.composeMode = p.composeContext.mode;
    mobileState.composeReplyTo = p.composeContext.replyTo;
    mobileState.composeRestore = p.restore;
    mobileState.composeRestoreShowCc = p.composeContext.showCc;
    mobileState.view = 'compose';
    mobileState.previousView = p.composeContext.previousView;
    showToast('info', 'Send cancelled');
    return true;
}

export function hasMobilePendingSend(): boolean {
    return pending !== null;
}
