import { formatScheduledSendWhen } from './scheduled-send';

/** Toast copy when mobile compose queues a scheduled send (slice 36). */
export function mobileScheduledSendQueuedMessage(sendAtMs: number, now = Date.now()): string {
    return `Send scheduled for ${formatScheduledSendWhen(sendAtMs, now)}`;
}
