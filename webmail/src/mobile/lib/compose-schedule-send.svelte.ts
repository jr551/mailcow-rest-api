import { formatScheduledSendWhen, type ScheduledSendPayload } from '../../lib/scheduled-send';
import {
    enqueueScheduledSend,
    hydrateScheduledSends,
    processDueScheduledSends,
    type ScheduledSendNotify
} from '../../lib/scheduled-send.svelte';
import { mobileScheduledSendQueuedMessage } from '../../lib/mobile-compose-schedule';
import { showToast } from './store.svelte';

export function queueMobileScheduledSend(input: {
    sendAtMs: number;
    payload: ScheduledSendPayload;
    subject: string;
    toLabel: string;
}) {
    const item = enqueueScheduledSend(input);
    showToast('success', mobileScheduledSendQueuedMessage(item.sendAtMs));
    return item;
}

export const mobileScheduledSendNotify: ScheduledSendNotify = (kind, message) => {
    showToast(kind, message);
};

/** Flush due scheduled sends on mobile with mobile toasts (same queue as desktop). */
export function startMobileScheduledSendFlusher(): () => void {
    hydrateScheduledSends();
    void processDueScheduledSends(Date.now(), mobileScheduledSendNotify);
    const timer = setInterval(() => {
        if (document.hidden) return;
        void processDueScheduledSends(Date.now(), mobileScheduledSendNotify);
    }, 30_000);
    return () => clearInterval(timer);
}
