/**
 * Outlook.com-style landmarks for mobile compose (parity slice 38).
 * Matches desktop compose region naming from `mail-landmarks.ts`.
 */

export const MOBILE_COMPOSE_LANDMARK_ID = 'mail-compose-landmark';
export const MOBILE_COMPOSE_LABEL = 'Compose message';
export const MOBILE_COMPOSE_FIELDS_LABEL = 'Message fields';
export const MOBILE_COMPOSE_ACTIONS_LABEL = 'Compose actions';

export const MOBILE_COMPOSE_LANDMARK_ROWS = [
    {
        region: MOBILE_COMPOSE_LABEL,
        description: 'New message, reply, or forward with Save draft and Send'
    },
    {
        region: MOBILE_COMPOSE_FIELDS_LABEL,
        description: 'From, recipients, subject, and message body'
    },
    {
        region: MOBILE_COMPOSE_ACTIONS_LABEL,
        description: 'Attach photos and open-tracking toggle'
    }
] as const;

export function focusMobileComposeLandmark(): void {
    document.getElementById(MOBILE_COMPOSE_LANDMARK_ID)?.focus();
}

/** Move keyboard focus to the To field when compose opens (OWA-style). */
export function focusMobileComposeToField(): void {
    const el = document.querySelector<HTMLElement>('[data-testid="compose-to"]');
    el?.focus();
}
