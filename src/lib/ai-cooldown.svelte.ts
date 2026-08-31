// Tracks LiteLLM cooldowns. When the proxy returns "No deployments
// available... Try again in N seconds", we set cooldownUntil and every
// AI surface in the app reads this to disable buttons + show a friendly
// banner instead of letting the user fire calls that will just fail.

import { showToast } from './store.svelte';

interface AiCooldownState {
    /** Epoch ms when the cooldown ends. 0 = no cooldown. */
    cooldownUntil: number;
    /** Reason the AI is cold — kept human-readable for the banner. */
    reason: string;
}

const state = $state<AiCooldownState>({ cooldownUntil: 0, reason: '' });

export const aiCooldown = state;

export function aiCooldownActive(): boolean {
    return state.cooldownUntil > Date.now();
}

export function aiCooldownSecondsLeft(): number {
    if (!aiCooldownActive()) return 0;
    return Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000));
}

/** Format the remaining cooldown for the user. */
export function aiCooldownLabel(): string {
    const s = aiCooldownSecondsLeft();
    if (s <= 0) return '';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.ceil(s / 60)}m`;
    return `${Math.ceil(s / 3600)}h`;
}

/** Set the cooldown. Use the seconds value the LLM proxy reported. */
export function setAiCooldown(seconds: number, reason: string): void {
    const ms = Math.max(0, seconds * 1000);
    state.cooldownUntil = Date.now() + ms;
    state.reason = reason;
    showToast('error', `AI is cooling down — ${aiCooldownLabel()} until it's available again. ${reason}`);
}

export function clearAiCooldown(): void {
    state.cooldownUntil = 0;
    state.reason = '';
}

/** Try to detect a cooldown error from a LiteLLM 429 detail string.
 *  Returns true if the detail looked like a cooldown and the cooldown
 *  was set. The caller should bail out and not retry. */
export function maybeFlagCooldown(detail: string): boolean {
    if (!/no deployments available/i.test(detail)) return false;
    const m = /Try again in (\d+(?:\.\d+)?)\s*seconds?/i.exec(detail);
    const seconds = m ? Number(m[1]) : 60;
    // Cap at 1 day so a wonky proxy response can't lock the app forever.
    setAiCooldown(Math.min(86400, seconds), 'Upstream model is rate-limited.');
    return true;
}
