/** Shared copy for mobile undo-send toasts (slice 35). */

export function mobileUndoSendToastMessage(seconds: number): string {
    const sec = Math.max(0, Math.round(seconds));
    return sec === 1 ? 'Sending in 1 second' : `Sending in ${sec} seconds`;
}
