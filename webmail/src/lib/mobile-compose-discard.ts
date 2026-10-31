/** Copy and helpers for mobile compose discard confirmation (slice 39). */

export const MOBILE_COMPOSE_DISCARD_TITLE = 'Discard this message?';
export const MOBILE_COMPOSE_DISCARD_BODY =
    'Your changes have not been sent. You can save a draft or discard them.';

export const MOBILE_COMPOSE_DISCARD_KEEP = 'Keep editing';
export const MOBILE_COMPOSE_DISCARD_SAVE = 'Save draft';
export const MOBILE_COMPOSE_DISCARD_CONFIRM = 'Discard';

/** When true, closing compose should show the discard sheet (not for empty drafts). */
export function mobileComposeNeedsDiscardConfirm(hasDraftContent: boolean): boolean {
    return hasDraftContent;
}
