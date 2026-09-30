// The AI reply-suggestion state machine shared by desktop Compose and
// mobile ComposeView.
//
// Opening a Reply asks the model for a starting paragraph and shows it in
// a strip above the editor. Three properties matter, and each one is
// load-bearing:
//
// 1. IT NEVER BLOCKS. Callers fire the request from a setTimeout(0) in
//    onMount, after the window is already on screen and interactive.
//    Nothing is awaited before render, no field is disabled, and the
//    user can type, edit and send the whole time it runs. If the model
//    is slow the user simply never sees the strip.
//
// 2. IT IS BOUND TO THE COMPONENT. One AbortController, aborted on
//    unmount and whenever a fresh request supersedes the old one.
//    Closing compose mid-generation cancels the HTTP request rather
//    than leaving it to finish into a component that no longer exists —
//    which would spend tokens and, worse, write into dead state.
//
// 3. IT IS SUBORDINATE TO THE MASTER SWITCH. eligible() re-checks
//    settings.aiFeatures on every call, and callers keep an $effect that
//    aborts + hides in-flight work if the user flips AI off while the
//    surface is open. aiSuggestReply only ever narrows the feature
//    further; it can never widen it.

import { draftReply, ApiError, type MessageDetail } from './api';
import { settings, aiAvailable } from './settings.svelte';

export type ReplySuggestMode = 'new' | 'reply' | 'replyAll' | 'forward';

/** Inputs that differ between the desktop window and the mobile view.
 *  Mode and the replied-to message are read through getters so a caller
 *  whose values are $derived stays wired to live state. */
export interface ReplySuggestSource {
    mode: () => ReplySuggestMode;
    replyTo: () => MessageDetail | null | undefined;
}

/** HTML→plain-text fallback. Uses DOMParser so attacker-controlled HTML
 *  (e.g. quoted from a malicious sender) can't trigger resource loads or
 *  fire event handlers during parsing. */
export function htmlToPlainText(html: string): string {
    const prepped = html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/?\s*(p|div|li|h[1-6]|blockquote)\b[^>]*>/gi, '\n');
    const doc = new DOMParser().parseFromString(prepped, 'text/html');
    return (doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/** The original message as the model should see it: headers plus the
 *  plain-text body. Same shape the AI panel's Draft button sends, so the
 *  model gets a thread it already knows how to reply to. */
export function threadForAi(replyTo: MessageDetail | null | undefined): string {
    if (!replyTo) return '';
    const env = replyTo.envelope;
    const headers = [
        `From: ${env.from?.[0]?.name || ''} <${env.from?.[0]?.address || ''}>`,
        env.subject ? `Subject: ${env.subject}` : '',
        env.date ? `Date: ${env.date}` : ''
    ].filter(Boolean).join('\n');
    const text = replyTo.text || htmlToPlainText(replyTo.html || '');
    return `${headers}\n\n${text}`;
}

export class ReplySuggest {
    suggestion = $state<string | null>(null);
    loading = $state(false);
    error = $state<string | null>(null);

    // Epoch of the last request we actually let out. A response from a
    // superseded request is dropped rather than shown, so two overlapping
    // generations can't race each other into the strip.
    private seq = 0;
    private controller: AbortController | null = null;
    // Regenerate is one click and spends real tokens each time, so one
    // request in flight plus a short cooldown between them. Hammering it
    // tells the user nothing — the model has no notion of "try again
    // harder".
    private static readonly REGEN_COOLDOWN_MS = 4000;
    private lastRequestAt = 0;

    constructor(private src: ReplySuggestSource) {}

    /** Every gate, in one place, re-evaluated on each call. */
    eligible(): boolean {
        const mode = this.src.mode();
        const replyTo = this.src.replyTo();
        return (mode === 'reply' || mode === 'replyAll')
            && !!replyTo
            && settings.aiFeatures
            && settings.aiSuggestReply
            && aiAvailable();
    }

    /** Kill whatever is running. Safe to call when nothing is. */
    abort = (): void => {
        if (this.controller) {
            this.controller.abort();
            this.controller = null;
        }
        this.loading = false;
    };

    /** Abort and clear the strip — the dismiss buttons and the
     *  master-switch $effect share this. */
    dismiss = (): void => {
        this.abort();
        this.suggestion = null;
        this.error = null;
    };

    /** Fire a suggestion request. `regen: true` replaces a suggestion the
     *  user is looking at and is rate-limited by the cooldown. */
    request = async (opts: { regen: boolean }): Promise<void> => {
        if (!this.eligible()) return;
        if (this.loading) return;
        if (opts.regen) {
            const since = Date.now() - this.lastRequestAt;
            if (since < ReplySuggest.REGEN_COOLDOWN_MS) return;
        }
        this.abort();
        this.lastRequestAt = Date.now();
        const seq = ++this.seq;
        const controller = new AbortController();
        this.controller = controller;
        this.loading = true;
        this.error = null;
        if (opts.regen) this.suggestion = null;   // don't leave stale text under a spinner
        try {
            const r = await draftReply(threadForAi(this.src.replyTo()), undefined, { signal: controller.signal });
            // Dropped if the user closed the window, hit refresh, or turned
            // AI off while this was in the air.
            if (seq !== this.seq || controller.signal.aborted) return;
            const text = (r.content || '').trim();
            if (!text) {
                this.error = 'No suggestion came back — carry on.';
            } else {
                this.suggestion = text;
            }
        } catch (err) {
            if (controller.signal.aborted || seq !== this.seq) return;
            // An aborted fetch throws a DOMException; anything else is a
            // real failure worth a quiet one-liner. Not an error dialog:
            // the user never asked for this, so it must not interrupt.
            this.error = err instanceof ApiError
                ? (err.detail || err.title)
                : 'Couldn\'t draft a reply — carry on.';
        } finally {
            if (seq === this.seq) {
                this.loading = false;
                if (this.controller === controller) this.controller = null;
            }
        }
    };

    /** Take the current suggestion for insertion. Returns null when there
     *  is nothing to insert; otherwise aborts any in-flight work, clears
     *  the strip, and hands the caller the text. How and where it lands —
     *  rich-editor insert at the caret, textarea prepend — is the caller's
     *  seam. Never replace what the user has typed: the feature being
     *  async is exactly why they may have typed while the model thought,
     *  and overwriting their words to install the model's is the single
     *  most infuriating thing the strip could do. */
    accept = (): string | null => {
        const text = this.suggestion;
        if (!text) return null;
        this.abort();
        this.suggestion = null;
        this.error = null;
        return text;
    };
}

/** The "magic dust" moment: a brief sparkle on whatever received the
 *  inserted draft, so accepting an AI suggestion FEELS like something
 *  happened rather than the text silently changing. Desktop sweeps an
 *  overlay across the editor, mobile flashes a ring on the textarea —
 *  the tick is identical and lives here; the visual is each component's
 *  CSS on `tick > 0`.
 *
 *  Purely decorative: a no-op under prefers-reduced-motion, and a stale
 *  timer can't zero a newer flash — the `mine` epoch guard makes sure of
 *  it, so the class never outlives the animation. */
export class DraftSparkle {
    tick = $state(0);

    flash = (): void => {
        try {
            if (typeof window !== 'undefined'
                && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        } catch { /* matchMedia unavailable — animate anyway */ }
        this.tick++;
        const mine = this.tick;
        setTimeout(() => {
            if (this.tick === mine) this.tick = 0;
        }, 1400);
    };
}
