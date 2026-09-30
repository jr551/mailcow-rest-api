<script lang="ts">
    // The "couldn't continue" window: shown on inbox open when the AI
    // assistant has stopped on a message and needs John's input. Two
    // flavours share this one dialog — a missing fact (it refuses to invent
    // a date, price or order number) and a plain block (it could not
    // continue) — because the server queues both the same way and `reason`
    // is always a complete sentence saying what happened and that nothing
    // was sent.
    //
    // TWO RULES this component exists to keep:
    //
    // 1. It never sends. [Resume with advice] posts John's answer as
    //    context for the NEXT draft; that draft still stops at the approval
    //    gate like every other send. This file contains no send path at all.
    // 2. It never nags. The window appears once per inbox open, and a
    //    dismissal is persisted (webmail/src/lib/takeover.svelte.ts) so a
    //    closed item does not reappear on every open.
    //
    // Modal convention is the shared one (see LinkCheckPrompt.svelte):
    // overlay + dialog, role="dialog" aria-modal="true", trapFocus, and
    // Escape / backdrop / ✕ all dismiss — John is never trapped in here.

    import { trapFocus } from '../lib/focus-trap';
    import { showToast } from '../lib/store.svelte';
    import Icon from './Icon.svelte';
    import {
        takeover,
        takeoverNoticeItem,
        answerTakeoverItem,
        stopTakeoverItem,
        dismissTakeoverNotice
    } from '../lib/takeover.svelte';

    const item = $derived(takeoverNoticeItem());
    const hasMissing = $derived((item?.missing.length ?? 0) > 0);

    let dialogEl = $state<HTMLElement | null>(null);
    let adviceMode = $state(false);
    let adviceText = $state('');
    let busy = $state(false);

    // The dialog only exists while an item is shown, so the trap's
    // lifecycle follows the element rather than the component mount.
    $effect(() => {
        if (!dialogEl) return;
        return trapFocus(dialogEl);
    });

    // Reset the sub-form whenever a different item takes the stage.
    $effect(() => {
        void item?.id;
        adviceMode = false;
        adviceText = '';
    });

    function close() {
        if (item) dismissTakeoverNotice(item.id);
    }

    function handleKey(e: KeyboardEvent) {
        // Escape always leaves. Enter is deliberately NOT hijacked: it has
        // a real meaning inside the advice textarea.
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    }

    async function postAdvice() {
        if (!item || !adviceText.trim() || takeover.busy) return;
        busy = true;
        try {
            await answerTakeoverItem(item.id, adviceText.trim());
            showToast('success', 'Advice saved. The next draft will use it and still wait for your approval.');
        } catch (e) {
            showToast('error', (e as Error).message || 'Could not save your advice');
        } finally {
            busy = false;
        }
    }

    async function stopItem() {
        if (!item || takeover.busy) return;
        busy = true;
        try {
            await stopTakeoverItem(item.id);
            showToast('success', 'Stopped for this thread — the assistant will leave it alone.');
        } catch (e) {
            showToast('error', (e as Error).message || 'Could not stop the assistant for this thread');
        } finally {
            busy = false;
        }
    }
</script>

<svelte:window onkeydowncapture={handleKey} />

{#if item}
    <div
        class="takeover-overlay"
        role="presentation"
        data-testid="takeover-notice-overlay"
        onclick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
        <div
            bind:this={dialogEl}
            class="takeover-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="takeover-title"
            data-testid="takeover-notice-dialog"
        >
            <div class="takeover-status">
                <Icon name="sparkles" size={16} />
                <span id="takeover-title" data-testid="takeover-title">
                    Your AI assistant couldn't continue
                </span>
                <button
                    type="button"
                    class="takeover-close"
                    aria-label="Close"
                    onclick={close}
                    data-testid="takeover-close"
                >×</button>
            </div>

            <p class="takeover-meta">
                <span class="takeover-from">{item.from}</span>
                <span class="takeover-subject">{item.subject}</span>
            </p>

            <p class="takeover-reason" data-testid="takeover-reason">{item.reason}</p>

            {#if hasMissing}
                <div class="takeover-missing" data-testid="takeover-missing">
                    <span class="takeover-missing-label">
                        It will not guess these — tell it and it can carry on:
                    </span>
                    <ul>
                        {#each item.missing as m (m)}
                            <li>{m}</li>
                        {/each}
                    </ul>
                </div>
            {/if}

            {#if item.threadSnippet}
                <pre class="takeover-snippet" data-testid="takeover-snippet">{item.threadSnippet}</pre>
            {/if}

            <p class="takeover-honesty muted">
                Nothing has been sent, and nothing will be sent without your approval.
                If you give advice, it becomes context for the assistant's next draft — that
                draft still stops at your approval, and every reply it sends is signed
                "This reply came from my AI assistant."
            </p>

            {#if adviceMode}
                <label class="takeover-advice-label" for="takeover-advice">
                    Your advice — the facts it was missing, the tone you want, or the reply
                    you would have written:
                </label>
                <textarea
                    id="takeover-advice"
                    class="takeover-advice"
                    bind:value={adviceText}
                    rows="5"
                    placeholder="e.g. The appointment is 3 October at 2pm — confirm that and keep it short."
                    data-testid="takeover-advice-input"
                ></textarea>
                <div class="takeover-actions">
                    <button
                        type="button"
                        class="btn btn-primary"
                        onclick={postAdvice}
                        disabled={busy || takeover.busy || !adviceText.trim()}
                        data-testid="takeover-advice-submit"
                    >{busy ? 'Saving…' : 'Post advice'}</button>
                    <button
                        type="button"
                        class="btn btn-ghost"
                        onclick={() => (adviceMode = false)}
                        disabled={busy || takeover.busy}
                        data-testid="takeover-advice-back"
                    >Back</button>
                </div>
            {:else}
                <div class="takeover-actions">
                    <button
                        type="button"
                        class="btn btn-primary"
                        onclick={() => (adviceMode = true)}
                        disabled={busy || takeover.busy}
                        data-testid="takeover-resume"
                    >Resume with advice</button>
                    <button
                        type="button"
                        class="btn btn-secondary"
                        onclick={stopItem}
                        disabled={busy || takeover.busy}
                        data-testid="takeover-stop"
                    >{busy ? 'Stopping…' : 'Stop'}</button>
                </div>
            {/if}
        </div>
    </div>
{/if}

<style>
    /* Token-only, same as LinkCheckPrompt: reads correctly in both skins,
     * light and dark, without a single literal colour. */
    .takeover-overlay {
        position: fixed;
        inset: 0;
        z-index: 90;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--bg-overlay);
    }
    .takeover-dialog {
        width: min(520px, 100%);
        max-height: calc(100vh - 48px);
        overflow-y: auto;
        background: var(--bg-elevated);
        color: var(--text-primary);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    .takeover-status {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 14px;
        color: var(--text-primary);
    }
    .takeover-close {
        appearance: none;
        background: transparent;
        border: none;
        color: var(--text-secondary);
        font-size: 18px;
        line-height: 1;
        padding: 2px 6px;
        cursor: pointer;
        border-radius: 50%;
        margin-left: auto;
    }
    .takeover-close:hover {
        background: color-mix(in srgb, var(--text-secondary) 14%, transparent);
        color: var(--text-primary);
    }
    .takeover-meta {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 12.5px;
        line-height: 1.5;
    }
    .takeover-from { color: var(--text-secondary); }
    .takeover-subject { color: var(--text-primary); font-weight: 600; }
    .takeover-reason {
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-primary);
    }
    .takeover-missing {
        font-size: 13px;
        line-height: 1.5;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 8px 10px;
    }
    .takeover-missing-label {
        display: block;
        color: var(--text-secondary);
        margin-bottom: 4px;
    }
    .takeover-missing ul {
        margin: 0;
        padding-left: 18px;
    }
    .takeover-snippet {
        margin: 0;
        max-height: 120px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-secondary);
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 8px 10px;
    }
    .takeover-honesty {
        margin: 0;
        font-size: 12.5px;
        line-height: 1.5;
    }
    .takeover-advice-label {
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-secondary);
    }
    .takeover-advice {
        width: 100%;
        resize: vertical;
        font-family: inherit;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-primary);
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 8px 10px;
    }
    .takeover-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
    }
</style>
