<script lang="ts">
    import { onDestroy, tick } from 'svelte';
    import { trapFocus } from '../lib/focus-trap';
    import {
        takeover,
        loadTakeover,
        addSenderRule,
        saveSenderRule,
        removeSenderRule
    } from '../lib/takeover.svelte';
    import type { TakeoverSender } from '../lib/api';
    import { showToast } from '../lib/store.svelte';
    import Icon from './Icon.svelte';

    // "AI replies…" — right-click a message → manage the per-sender rules
    // that decide whose mail the assistant may answer. This is the same
    // store, and therefore the same rules, as Settings → Rules → "AI
    // replies"; the modal just starts from the sender you were looking at
    // instead of making you retype their address.
    //
    // Semantics are deliberately identical to the Settings card: an exact
    // address or an @domain pattern (exact wins over domain), optional
    // per-rule instructions (≤2000 chars), auto-send and sign-off both
    // default ON, ≤50 rules, duplicates rejected by the server. Every
    // mutation goes through the takeover store, so the list here and the
    // card in Settings can never disagree.

    interface Props {
        /** Whether the modal is showing. The parent only ever sets it
         *  true; every close path (Escape, backdrop, ✕) writes back. */
        open: boolean;
        /** The right-clicked message's From address, for the quick-add
         *  prefill. Null (no resolvable sender) just hides the quick-add
         *  strip — the full form still works. */
        sender: string | null;
    }
    let { open = $bindable(false), sender = null }: Props = $props();

    let panelEl: HTMLDivElement | undefined = $state();

    // Add form — mirrors Settings.svelte's aiRule* state one-for-one.
    let pattern = $state('');
    let instructions = $state('');
    let autoSend = $state(true);
    let signReplies = $state(true);
    /** Inline error for the add form (empty-input validation + API
     *  refusals: duplicate pattern, @-shape, the 50-rule cap). */
    let formError = $state('');

    // Quick-add scope: the exact address, or the whole @domain behind it.
    let useDomainScope = $state(false);

    // Row edit — one row expanded at a time, same as the Settings card.
    let editId = $state<string | null>(null);
    /** What the user typed into the expanded row's textarea. Null means
     *  "show the server's value"; after a refused save it holds the typed
     *  text so the box doesn't silently snap back (same as Settings). */
    let editInstructions = $state<string | null>(null);

    // The quick-add patterns derived from `sender`. The domain half is
    // lower-cased: patterns are compared by the server as typed, and a
    // mixed-case Hostname would create a rule that never matches.
    const quickSender = $derived((sender ?? '').trim());
    const quickDomain = $derived(
        quickSender.includes('@') ? `@${quickSender.split('@').pop()!.toLowerCase()}` : ''
    );
    const quickPattern = $derived(useDomainScope && quickDomain ? quickDomain : quickSender);
    /** The chosen quick pattern already has a rule — the server would
     *  refuse a duplicate, so the one-click button stands down instead. */
    const quickExists = $derived(
        takeover.senders.some((s) => s.pattern.toLowerCase() === quickPattern.toLowerCase())
    );

    /** One-line behaviour summary for a collapsed row — byte-identical
     *  wording to Settings.svelte's aiRuleSummary. */
    function summary(s: TakeoverSender): string {
        return [
            s.autoSend ? 'sends directly' : 'asks first',
            s.signReplies ? 'signs replies' : 'no sign-off'
        ].join(' · ');
    }

    /** First line of a rule's instructions, for the collapsed row. */
    function snippet(s: TakeoverSender): string {
        const t = (s.instructions || '').replace(/\s+/g, ' ').trim();
        return t.length > 64 ? `${t.slice(0, 64)}…` : t;
    }

    // ---- Open/close lifecycle ------------------------------------------------
    //
    // Unlike RuleFromMessageDialog this component stays mounted (the list
    // renders it unconditionally and gates it on `open`), so the open/close
    // work lives on the edges of `open` rather than in onMount/onDestroy.
    // Rising edge: seed the form around the right-clicked sender, fetch the
    // rules, focus the panel. Falling edge: release the focus trap and hand
    // focus back to whatever the user was doing (the row they right-clicked).

    let wasOpen = false;
    let restoreTo: HTMLElement | null = null;
    let releaseTrap: (() => void) | null = null;

    $effect(() => {
        if (!open) {
            if (wasOpen) {
                wasOpen = false;
                releaseTrap?.();
                releaseTrap = null;
                // Guarded: the row can be gone from a re-rendered list, and
                // focusing a detached node silently no-ops.
                if (restoreTo?.isConnected) restoreTo.focus();
                restoreTo = null;
            }
            return;
        }
        if (wasOpen) return;
        wasOpen = true;

        // Where focus was BEFORE anything moved — captured synchronously,
        // before the microtask that moves focus into the panel.
        restoreTo = document.activeElement as HTMLElement | null;

        // Fresh prefill per open, keyed on the rising edge (not per render):
        // re-typing into the form must not be wiped while the modal sits open.
        pattern = (sender ?? '').trim();
        instructions = '';
        autoSend = true;
        signReplies = true;
        useDomainScope = false;
        formError = '';
        editId = null;
        editInstructions = null;

        // Loads once per session (the store no-ops when already loaded) —
        // a 404 flips takeover.unavailable and the body renders the muted
        // "Not available" line instead of the form.
        void loadTakeover();

        // Focus the PANEL (not the first control): reading the title and the
        // quick-add strip before tabbing into fields is the point of a dialog
        // — same convention as RuleFromMessageDialog / EventModal.
        void tick().then(() => {
            if (!open || !panelEl) return;
            panelEl.focus();
            releaseTrap = trapFocus(panelEl);
        });
    });

    onDestroy(() => {
        releaseTrap?.();
        if (open && restoreTo?.isConnected) restoreTo.focus();
    });

    function close() {
        open = false;
    }

    // CAPTURE phase: as a bubbling window handler this loses the race to
    // Layout's document-level Escape handler (registered earlier, so it
    // bubbles first and was already tearing down the reading pane). One
    // Escape then closed the modal AND the message view behind it. Capturing
    // puts this dialog in front of every listener on the page — same as
    // RuleFromMessageDialog.
    function handleKey(e: KeyboardEvent) {
        if (!open || e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
    }

    // ---- Mutations -----------------------------------------------------------

    /** The one-click path: allow the right-clicked sender as-is or whole
     *  domain. The store refreshes the list on success, which also flips
     *  `quickExists` and stands the button down. */
    async function quickAdd() {
        const p = quickPattern;
        if (!p) return;
        formError = '';
        try {
            await addSenderRule({ pattern: p });
            showToast('success', `AI will answer ${p}`);
        } catch (e) {
            const msg = (e as Error).message || 'Could not add that sender.';
            formError = msg;
            showToast('error', msg);
        }
    }

    /** The full form. Success clears it back to defaults; a refusal
     *  (duplicate, bad pattern, cap) lands in the inline error line. */
    async function addRule() {
        const p = pattern.trim();
        if (!p) {
            formError = 'Enter an email address or an @domain.';
            return;
        }
        formError = '';
        try {
            await addSenderRule({
                pattern: p,
                instructions: instructions.trim() || undefined,
                autoSend,
                signReplies
            });
            pattern = '';
            instructions = '';
            autoSend = true;
            signReplies = true;
            showToast('success', `AI will answer ${p}`);
        } catch (e) {
            formError = (e as Error).message || 'Could not add that sender.';
        }
    }

    function toggleEdit(s: TakeoverSender) {
        if (editId === s.id) {
            editId = null;
            editInstructions = null;
        } else {
            editId = s.id;
            editInstructions = null;
        }
    }

    /** Saved on change (click away / blur), same contract as Settings:
     *  a refused save keeps the typed text in the box instead of snapping
     *  back to the server's old value. */
    async function saveInstructions(s: TakeoverSender, v: string) {
        editInstructions = null;
        try {
            await saveSenderRule(s.id, { instructions: v });
        } catch (e) {
            showToast('error', (e as Error).message || 'Could not save that setting');
            editInstructions = v;
        }
    }

    async function saveFlag(s: TakeoverSender, key: 'autoSend' | 'signReplies', on: boolean) {
        try {
            await saveSenderRule(s.id, key === 'autoSend' ? { autoSend: on } : { signReplies: on });
        } catch (e) {
            showToast('error', (e as Error).message || 'Could not save that setting');
        }
    }

    async function removeRule(s: TakeoverSender) {
        try {
            await removeSenderRule(s.id);
            if (editId === s.id) {
                editId = null;
                editInstructions = null;
            }
            showToast('success', `AI will no longer answer ${s.pattern}`);
        } catch (e) {
            showToast('error', (e as Error).message || 'Could not remove that sender');
        }
    }
</script>

<svelte:window onkeydowncapture={handleKey} />

{#if open}
    <!-- Backdrop click closes (target === currentTarget): clicks on the
         panel never bubble into a close, and there is deliberately no
         stopPropagation shield — same overlay contract as every other
         modal in this codebase. -->
    <div
        class="overlay"
        role="presentation"
        onclick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
        <div
            bind:this={panelEl}
            class="dialog fade-in"
            role="dialog"
            tabindex="-1"
            aria-modal="true"
            aria-labelledby="ai-rules-title"
            data-testid="ai-rules-modal"
        >
            <header class="head">
                <div class="head-title">
                    <span class="ai-badge" aria-hidden="true"><Icon name="sparkles" size={15} /></span>
                    <div class="head-copy">
                        <h2 id="ai-rules-title">AI replies</h2>
                        <p class="muted head-sub">Choose whose mail the assistant may answer.</p>
                    </div>
                </div>
                <button
                    type="button"
                    class="btn btn-ghost"
                    aria-label="Close"
                    onclick={close}
                    data-testid="ai-rules-close"
                >
                    <Icon name="close" size={16} />
                </button>
            </header>

            <div class="body">
                {#if !takeover.loaded}
                    <p class="muted small loading-line" role="status" data-testid="ai-rules-loading">
                        <span class="spinner" aria-hidden="true"></span> Loading…
                    </p>
                {:else if takeover.unavailable}
                    <p class="muted small" data-testid="ai-rules-unavailable">Not available on this server.</p>
                {:else}
                    {#if quickSender}
                        <!-- The right-clicked sender, one click away from a rule.
                             The scope chips ARE the preview: whichever is pressed
                             is the pattern the Allow button will create. -->
                        <div class="quick" data-testid="ai-rules-quick">
                            <div class="quick-copy">
                                <strong>Allow AI replies from:</strong>
                                <div class="quick-chips" role="group" aria-label="Sender scope">
                                    <button
                                        type="button"
                                        class="chip"
                                        aria-pressed={!useDomainScope}
                                        onclick={() => (useDomainScope = false)}
                                        data-testid="ai-rules-quick-exact"
                                    >{quickSender}</button>
                                    {#if quickDomain}
                                        <button
                                            type="button"
                                            class="chip"
                                            aria-pressed={useDomainScope}
                                            onclick={() => (useDomainScope = true)}
                                            data-testid="ai-rules-quick-domain"
                                        >{quickDomain} <span class="chip-note">whole domain</span></button>
                                    {/if}
                                </div>
                            </div>
                            <button
                                type="button"
                                class="btn btn-primary"
                                onclick={quickAdd}
                                disabled={quickExists || takeover.sendersBusy}
                                data-testid="ai-rules-quick-add"
                            >{quickExists ? 'Already allowed' : takeover.sendersBusy ? 'Adding…' : 'Allow'}</button>
                        </div>
                    {/if}

                    <div class="rule-form" data-testid="ai-rule-form">
                        <label class="form-row">
                            <span class="flabel">Sender</span>
                            <input
                                type="text"
                                placeholder="alice@example.com or @example.com"
                                bind:value={pattern}
                                disabled={takeover.sendersBusy}
                                onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addRule(); }}}
                                data-testid="ai-rule-pattern"
                            />
                        </label>
                        <label class="form-row form-row-stack">
                            <span class="flabel">Instructions</span>
                            <textarea
                                rows="2"
                                maxlength="2000"
                                placeholder="Optional — tone, what to handle, what to leave alone"
                                bind:value={instructions}
                                disabled={takeover.sendersBusy}
                                data-testid="ai-rule-instructions"
                            ></textarea>
                            <span class="counter muted" aria-live="polite">{instructions.length}/2000</span>
                        </label>
                        <div class="form-row">
                            <span class="flabel">Auto-send</span>
                            <label class="opt">
                                <input
                                    type="checkbox"
                                    checked={autoSend}
                                    disabled={takeover.sendersBusy}
                                    aria-label="Send confident replies automatically"
                                    onchange={(e) => { autoSend = (e.currentTarget as HTMLInputElement).checked; }}
                                    data-testid="ai-rule-autosend"
                                />
                                <span>{autoSend ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                        <div class="form-row">
                            <span class="flabel">Sign-off</span>
                            <label class="opt">
                                <input
                                    type="checkbox"
                                    checked={signReplies}
                                    disabled={takeover.sendersBusy}
                                    aria-label="Append the AI sign-off to replies"
                                    onchange={(e) => { signReplies = (e.currentTarget as HTMLInputElement).checked; }}
                                    data-testid="ai-rule-signreplies"
                                />
                                <span>{signReplies ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                        <div class="form-actions">
                            <button
                                type="button"
                                class="btn btn-primary"
                                disabled={takeover.sendersBusy}
                                onclick={addRule}
                                data-testid="ai-rule-add"
                            >{takeover.sendersBusy ? 'Adding…' : 'Add sender'}</button>
                        </div>
                        {#if formError}
                            <p class="form-error" role="alert" data-testid="ai-rule-error">{formError}</p>
                        {/if}
                    </div>

                    {#if takeover.error && !takeover.senders.length}
                        <p class="form-error" role="alert" data-testid="ai-rules-load-error">{takeover.error}</p>
                    {:else if takeover.senders.length}
                        <ul class="rules" data-testid="ai-rule-list">
                            {#each takeover.senders as s (s.id)}
                                <li class="rule" class:expanded={editId === s.id} data-testid={`ai-rule-item-${s.id}`}>
                                    <div class="rule-head">
                                        <span class="rule-pattern truncate" title={s.pattern}>
                                            <Icon name="sparkles" size={11} /> {s.pattern}
                                        </span>
                                        <span class="rule-summary">{summary(s)}</span>
                                        <button
                                            type="button"
                                            class="iconbtn"
                                            onclick={() => toggleEdit(s)}
                                            aria-expanded={editId === s.id}
                                            aria-label={`Settings for ${s.pattern}`}
                                            title="Settings"
                                            data-testid={`ai-rule-details-${s.id}`}
                                        >
                                            <Icon name={editId === s.id ? 'chevronUp' : 'chevronDown'} size={14} />
                                        </button>
                                        <button
                                            type="button"
                                            class="iconbtn danger"
                                            onclick={() => removeRule(s)}
                                            aria-label={`Stop handling ${s.pattern}`}
                                            title="Stop handling this sender"
                                            data-testid={`ai-rule-remove-${s.id}`}
                                        ><Icon name="trash" size={12} /></button>
                                    </div>
                                    {#if s.instructions && editId !== s.id}
                                        <p class="rule-says muted" title={s.instructions}>Says: {snippet(s)}</p>
                                    {/if}
                                    {#if editId === s.id}
                                        <div class="rule-edit" data-testid={`ai-rule-edit-${s.id}`}>
                                            <label class="edit-instr">
                                                <span class="flabel">Instructions</span>
                                                <textarea
                                                    rows="3"
                                                    maxlength="2000"
                                                    aria-label={`Instructions for ${s.pattern}`}
                                                    placeholder="e.g. Friendly and brief. Handle delivery questions myself. Never mention invoices."
                                                    value={editInstructions ?? s.instructions}
                                                    disabled={takeover.sendersBusy}
                                                    oninput={(e) => { editInstructions = (e.currentTarget as HTMLTextAreaElement).value; }}
                                                    onchange={(e) => saveInstructions(s, (e.currentTarget as HTMLTextAreaElement).value)}
                                                    data-testid={`ai-rule-instructions-${s.id}`}
                                                ></textarea>
                                                <span class="counter muted">{(editInstructions ?? s.instructions).length}/2000</span>
                                            </label>
                                            <div class="flag-row">
                                                <div class="flag-copy">
                                                    <strong>Auto-send</strong>
                                                    <span class="muted">Confident replies send themselves; unsure ones wait for you.</span>
                                                </div>
                                                <label class="opt">
                                                    <input
                                                        type="checkbox"
                                                        checked={s.autoSend}
                                                        disabled={takeover.sendersBusy}
                                                        aria-label="Send confident replies automatically"
                                                        onchange={(e) => saveFlag(s, 'autoSend', (e.currentTarget as HTMLInputElement).checked)}
                                                        data-testid={`ai-rule-autosend-${s.id}`}
                                                    />
                                                    <span>{s.autoSend ? 'On' : 'Off'}</span>
                                                </label>
                                            </div>
                                            <div class="flag-row">
                                                <div class="flag-copy">
                                                    <strong>Sign-off</strong>
                                                    <span class="muted">Adds “This reply came from my AI assistant.” to replies.</span>
                                                </div>
                                                <label class="opt">
                                                    <input
                                                        type="checkbox"
                                                        checked={s.signReplies}
                                                        disabled={takeover.sendersBusy}
                                                        aria-label="Append the AI sign-off to replies"
                                                        onchange={(e) => saveFlag(s, 'signReplies', (e.currentTarget as HTMLInputElement).checked)}
                                                        data-testid={`ai-rule-signreplies-${s.id}`}
                                                    />
                                                    <span>{s.signReplies ? 'On' : 'Off'}</span>
                                                </label>
                                            </div>
                                        </div>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                    {:else}
                        <p class="muted small empty" data-testid="ai-rule-empty">
                            No senders yet — the assistant idles until you add one.
                        </p>
                    {/if}
                {/if}
            </div>

            <footer class="foot">
                <p class="muted small">
                    <Icon name="info" size={12} />
                    <span>Master switch: Settings → AI → Let the assistant answer mail.</span>
                </p>
            </footer>
        </div>
    </div>
{/if}

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: var(--bg-overlay);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        /* Same tier as the rule-from-message dialog (210): above the row
           context menu (z-index 200), so opening this from the menu never
           leaves the menu stacked over the modal. */
        z-index: 210;
    }
    .dialog {
        /* The violet AI identity — same pair Compose's .history-panel uses,
           with an added on-accent colour for filled chips in dark mode
           (white on violet-400 would fail contrast there). */
        --ai-accent: #7c3aed;   /* violet-600 */
        --ai-bg: #f3e8ff;       /* violet-100 */
        --ai-border: #e9d5ff;   /* violet-200 */
        --ai-on-accent: #ffffff;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(560px, 100%);
        max-height: calc(100vh - 40px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .dialog:focus { outline: none; }
    :global([data-theme='dark']) .dialog {
        --ai-accent: #a78bfa;   /* violet-400 */
        --ai-bg: #2e1065;       /* violet-950 */
        --ai-border: #6d28d9;   /* violet-700 */
        --ai-on-accent: #2e1065;
    }
    @media (prefers-color-scheme: dark) {
        :global([data-theme='auto']) .dialog {
            --ai-accent: #a78bfa;
            --ai-bg: #2e1065;
            --ai-border: #6d28d9;
            --ai-on-accent: #2e1065;
        }
    }

    .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-subtle);
        /* A quiet violet wash, not a banner: the AI identity should read
           as a flavour of the dialog, not a different app. */
        background: linear-gradient(135deg, var(--ai-bg) 0%, transparent 65%);
    }
    .head-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .ai-badge {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 9px;
        background: var(--ai-bg);
        border: 1px solid var(--ai-border);
        color: var(--ai-accent);
    }
    .head-copy { min-width: 0; }
    .head h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.015em;
    }
    .head-sub { margin: 1px 0 0; font-size: 12px; line-height: 1.45; }

    .body {
        padding: 14px 20px 6px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        overflow-y: auto;
    }
    .loading-line { display: inline-flex; align-items: center; gap: 8px; margin: 4px 0; }
    .loading-line .spinner { width: 14px; height: 14px; border-width: 2px; }

    /* --- Quick-add strip ------------------------------------------------ */
    .quick {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
        padding: 10px 12px;
        background: var(--ai-bg);
        border: 1px solid var(--ai-border);
        border-left: 3px solid var(--ai-accent);
        border-radius: var(--radius-sm);
    }
    .quick-copy { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 12.5px; }
    .quick-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        max-width: 100%;
        padding: 3px 10px;
        font-size: 11.5px;
        font-family: var(--font-mono);
        border-radius: 999px;
        border: 1px solid var(--ai-border);
        background: var(--bg-surface);
        color: var(--text-secondary);
        cursor: pointer;
        transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
    }
    .chip:hover { background: var(--bg-hover); color: var(--text-primary); }
    .chip[aria-pressed='true'] {
        background: var(--ai-accent);
        border-color: var(--ai-accent);
        color: var(--ai-on-accent);
        font-weight: 600;
    }
    .chip-note { opacity: 0.75; font-family: inherit; font-weight: 400; }
    .quick .btn { flex: none; }

    /* --- Add form ------------------------------------------------------- */
    .rule-form {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
    }
    .form-row {
        display: grid;
        grid-template-columns: 100px 1fr;
        align-items: center;
        gap: 4px 8px;
        font-size: 12px;
    }
    .form-row-stack { align-items: start; }
    .flabel {
        font-weight: 600;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 11px;
    }
    .form-row input[type='text'],
    .form-row textarea,
    .edit-instr textarea {
        width: 100%;
        padding: 6px 9px;
        font-size: 12px;
        font-family: inherit;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        color: var(--text-primary);
        resize: vertical;
    }
    .form-row input:focus,
    .form-row textarea:focus,
    .edit-instr textarea:focus {
        outline: none;
        border-color: var(--ai-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--ai-accent) 18%, transparent);
    }
    .counter {
        grid-column: 2;
        justify-self: end;
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
    }
    .opt {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
    }
    .opt input { width: 14px; height: 14px; accent-color: var(--ai-accent); }
    .form-actions { display: flex; justify-content: flex-end; }
    .form-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--danger); }

    /* --- Rules list ------------------------------------------------------ */
    .rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .rule {
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-left: 3px solid var(--ai-border);
        border-radius: var(--radius-md);
        padding: 9px 12px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    .rule:hover { box-shadow: var(--shadow-sm); }
    .rule.expanded { border-left-color: var(--ai-accent); }
    .rule-head { display: flex; align-items: center; gap: 8px; }
    .rule-pattern {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        flex: 1;
        min-width: 0;
        font-family: var(--font-mono);
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .rule-pattern :global(svg) { flex: none; color: var(--ai-accent); }
    .rule-summary { flex: none; font-size: 11.5px; color: var(--text-tertiary); }
    .rule-says {
        margin: 0;
        font-size: 11.5px;
        line-height: 1.45;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .iconbtn {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-tertiary);
        cursor: pointer;
    }
    .iconbtn:hover { background: var(--bg-hover); color: var(--text-primary); }
    /* Destructive affordance is quiet until the row is attended to —
       hover OR keyboard focus must both reveal it. */
    .iconbtn.danger {
        opacity: 0;
        transition: opacity var(--transition-fast), background-color var(--transition-fast), color var(--transition-fast);
    }
    .rule:hover .iconbtn.danger,
    .rule:focus-within .iconbtn.danger { opacity: 1; }
    .iconbtn.danger:hover { background: var(--danger-soft); color: var(--danger); }

    .rule-edit {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 10px 12px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
    }
    .edit-instr { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .edit-instr .counter { align-self: flex-end; }
    .flag-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
    }
    .flag-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .flag-copy strong { font-size: 12px; }
    .flag-copy .muted { font-size: 11.5px; line-height: 1.4; }

    .empty { margin: 2px 0 6px; }

    .foot {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 20px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    .foot p { margin: 0; display: inline-flex; align-items: center; gap: 6px; }
    .foot :global(svg) { flex: none; color: var(--ai-accent); }

    @media (prefers-reduced-motion: reduce) {
        .dialog { animation: none; }
        .chip,
        .rule,
        .iconbtn.danger { transition: none; }
    }
</style>
