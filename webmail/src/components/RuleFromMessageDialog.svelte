<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { trapFocus } from '../lib/focus-trap';
    import {
        addMailRule, listMailRules, listMailboxes, ApiError,
        type MailRule, type MailRuleActionType, type MailRuleConditionType,
        type Mailbox, type MessageListItem
    } from '../lib/api';
    import {
        listOutboundWebhooks, isOutboundWebhooksUnavailable,
        type OutboundWebhook
    } from '../lib/outbound-webhooks';
    import { showToast } from '../lib/store.svelte';
    import Icon from './Icon.svelte';

    // "Create a rule from this message" — right-click → Create rule.
    //
    // Deliberately NOT a one-click action. A rule guessed from the message
    // you happened to right-click is a coin toss: right-clicking a message
    // from a sender you already trust and picking "rule" is meaningless,
    // and the guessed `discard` is destructive. So the message only ever
    // PREFILLS the form (condition + value, from the envelope the list
    // already has); the user edits condition type / value / action and
    // presses Save. Everything — condition vocabulary, action vocabulary,
    // required-field rules, the webhook picker — is the same shape as
    // Settings → Server-side rules, so a rule built here and a rule built
    // there are indistinguishable and equally editable.
    //
    // Extracted out of MessageList (2700+ lines) rather than growing it:
    // this is a modal with its own fetch, its own validation and its own
    // focus trap, none of which belong in the list component.

    interface Props {
        /** The message the user right-clicked. Prefill only — nothing is
         *  created until they hit Save. */
        message: MessageListItem | null;
        onClose: () => void;
    }
    let { message, onClose }: Props = $props();

    // Condition vocabulary — kept byte-identical to Settings.svelte's
    // RULE_CONDITION_LABELS / RULE_ACTION_LABELS. These are NOT exported
    // from Settings.svelte because that file is a huge page component;
    // duplicating two literal maps is cheaper than exporting them from
    // there and coupling a modal's lifetime to the settings page. The
    // `*Has*` helpers below are the ones the form's conditional fields
    // key off, same semantics as Settings.svelte.
    const RULE_CONDITION_LABELS: Record<MailRuleConditionType, string> = {
        'from-contains': 'From contains',
        'to-contains': 'To contains',
        'subject-contains': 'Subject contains',
        'envelope-to-is': 'Envelope-to is exactly',
        'header-contains': 'Header contains',
        'header-is': 'Header is exactly'
    };
    const RULE_ACTION_LABELS: Record<MailRuleActionType, string> = {
        discard: 'Block (discard)',
        redirect: 'Redirect (forward, no copy)',
        copy: 'Copy (forward + keep)',
        fileinto: 'Move to folder (auto-move)',
        webhook: 'Send to external webhook'
    };

    function ruleHasTarget(t: MailRuleActionType): boolean {
        return t === 'redirect' || t === 'copy';
    }
    function ruleNeedsFolder(t: MailRuleActionType): boolean {
        return t === 'fileinto';
    }
    function ruleNeedsWebhook(t: MailRuleActionType): boolean {
        return t === 'webhook';
    }
    function ruleHasHeader(t: MailRuleConditionType): boolean {
        return t === 'header-contains' || t === 'header-is';
    }

    // Form state. `rulesUnavailable` and `outboundUnavailable` both mean
    // "this server build can't do that" (pre-v0.3.2 rules API / no
    // outbound-webhook endpoint) — we hide or explain rather than offering
    // an action whose Save is guaranteed to fail.
    let conditionType = $state<MailRuleConditionType>('from-contains');
    let conditionValue = $state('');
    let conditionHeader = $state('');
    let actionType = $state<MailRuleActionType>('discard');
    let actionTo = $state('');
    let actionFolder = $state('');
    let actionWebhookId = $state('');
    let saving = $state(false);
    let mailboxes = $state<Mailbox[]>([]);
    let outboundHooks = $state<OutboundWebhook[]>([]);
    let outboundUnavailable = $state(false);
    /** True until the outbound-webhook probe settles. The reconcile effect
     *  below must not "fix" the seeded action during that window — it would
     *  clobber the webhook prefill on every open before the fetch lands. */
    let hooksPending = $state(true);
    let rulesUnavailable = $state(false);

    let dialogEl: HTMLDivElement | undefined = $state();

    /** Plain-text copy of the message headers the form was seeded from.
     *  Held as state, not $derived: the list re-creates its MessageListItem
     *  objects on every fetch, so deriving would re-seed the form under the
     *  user's hands and wipe whatever they had typed. */
    interface Seed { from: string; to: string; subject: string; actionType: MailRuleActionType }
    let seed = $state<Seed | null>(null);
    let seededUid = $state<number | null>(null);

    function seedFrom(m: MessageListItem): Seed {
        // Only real envelope data: the list already carries from / to /
        // subject, so the prefill can never invent a header value.
        const from = m.envelope.from?.[0]?.address?.trim() || '';
        const to = m.envelope.to?.[0]?.address?.trim() || '';
        const subject = m.envelope.subject?.trim() || '';
        // A no-reply / notifications sender is nearly always something you
        // want handed to a webhook rather than thrown away, so prefill
        // that instead of a discard. Everything else stays on discard,
        // which is the visible default the user has to consciously pick.
        const autoSender = /(^|[@.])(no-?reply|mailer-daemon|notifications?|alerts?)@/i.test(from);
        return { from, to, subject, actionType: autoSender ? 'webhook' : 'discard' };
    }

    // Seed once per opened message (keyed on uid), not once per render.
    $effect(() => {
        const m = message;
        if (!m || m.uid === seededUid) return;
        seededUid = m.uid;
        const s = seedFrom(m);
        seed = s;
        conditionType = 'from-contains';
        conditionValue = s.from;
        conditionHeader = '';
        actionType = s.actionType;
        actionTo = '';
        actionFolder = '';
        actionWebhookId = '';
    });

    // Where focus was when the dialog opened. The row the user right-clicked
    // (or Shift+F10'd) is still in the DOM behind the overlay, so we can
    // hand focus back instead of dropping it on <body> and losing their
    // place in the list.
    //
    // Assigned in onMount, NOT at component-init: the parent's `{#if
    // ruleFromMessage}` mounts this as the same update that opens it, and
    // reading document.activeElement during init can run before the DOM
    // change is flushed. Capturing inside the mount callback also happens
    // before trapFocus's queueMicrotask steals focus, so the value is the
    // element that actually had it.
    let restoreTo: HTMLElement | null = null;

    onMount(() => {
        restoreTo = document.activeElement as HTMLElement | null;
        // The dialog element itself, not its first control: the form is a
        // wall of selects and inputs seeded from the message, and reading
        // the title before tabbing into them is the point of a dialog.
        // (Same convention as Settings.svelte / EventModal.svelte.)
        dialogEl?.focus();
        // Tab must cycle inside an aria-modal dialog — without this, Tab walks
        // out to the inbox behind the overlay and the modal is only modal
        // visually. Reuses the shared helper every other modal in the app
        // already uses.
        // Kick off the supporting GETs (outbound webhooks, folder list, plus
        // the mail-rules support probe). Without this the `webhook` action and
        // the `fileinto` folder picker never appear at all: those options are
        // rendered conditionally on the lists being non-empty, so an unloaded
        // list silently reads as "this server has no webhooks". Started before
        // the trapFocus return, which is the mount's cleanup.
        void loadSupportData();
        if (dialogEl) return trapFocus(dialogEl);
    });

    onDestroy(() => {
        // Closing (Escape, Cancel, the X, or a successful save) returns
        // focus to the row the dialog was opened from. Guarded: after Save
        // the row can be gone from the re-rendered list, and focusing a
        // detached node silently no-ops.
        if (restoreTo?.isConnected) restoreTo.focus();
    });

    // The webhook list and the folder list are only needed for the two
    // actions that reference them, but they're cheap single GETs and the
    // user may switch action at any time — fetch both up front so the
    // selects are never a spinner.
    async function loadSupportData() {
        await Promise.all([probeRulesSupport(), loadOutboundHooks(), loadFolders()]);
    }

    // A pre-v0.3.2 server has no /v1/me/mail-rules at all. Settings.svelte
    // discovers this the same way — a GET that 404s. Probing here means the
    // Save button is never presented for a server that can't honour it.
    async function probeRulesSupport() {
        try {
            await listMailRules();
        } catch (err) {
            if (err instanceof ApiError && err.status === 404) rulesUnavailable = true;
        }
    }

    async function loadOutboundHooks() {
        try {
            const r = await listOutboundWebhooks();
            outboundHooks = r.webhooks;
            // No webhook is auto-selected: picking one silently would
            // forward real mail somewhere the user never chose. The
            // required-field check nudges them instead.
        } catch (err) {
            // 404/501 → server predates the feature. The webhook action is
            // then hidden entirely rather than offered as a broken option.
            if (isOutboundWebhooksUnavailable(err)) outboundUnavailable = true;
        } finally {
            hooksPending = false;
        }
    }

    // Reconcile the seeded action against what the action select actually
    // offers. A no-reply sender seeds actionType='webhook', but a server
    // with no outbound-webhook endpoint (or no webhooks configured) hides
    // that option — leaving actionType pointing at an option that isn't
    // rendered means the select displays one action while the submitted
    // rule carries another. Drop back to discard, which is always present.
    $effect(() => {
        const canWebhook = !outboundUnavailable && outboundHooks.length > 0;
        if (actionType === 'webhook' && !canWebhook && !hooksPending) {
            actionType = 'discard';
        }
    });

    async function loadFolders() {
        try {
            mailboxes = await listMailboxes();
        } catch {
            // Not fatal — the folder field is a text input with the list as
            // a datalist, so a failed fetch only costs the suggestions.
        }
    }

    function handleKey(e: KeyboardEvent) {
        if (e.key !== 'Escape') return;
        // CAPTURE phase. As a bubbling window handler this lost the race to
        // Layout's document-level Escape handler (registered in Layout's
        // onMount, i.e. before this dialog's, so it runs first in the bubble
        // order and was already clearing the selection / closing the reading
        // pane). One Escape then tore down the dialog AND the message view.
        // Capturing puts us in front of every listener on the page.
        e.preventDefault();
        e.stopPropagation();
        onClose();
    }

    async function save() {
        const value = conditionValue.trim();
        if (!value) { showToast('error', 'Condition value is required'); return; }
        if (ruleHasHeader(conditionType) && !conditionHeader.trim()) {
            showToast('error', 'Header name is required'); return;
        }
        if (ruleHasTarget(actionType) && !actionTo.trim()) {
            showToast('error', 'Forward address is required'); return;
        }
        if (ruleNeedsFolder(actionType) && !actionFolder.trim()) {
            showToast('error', 'Destination folder is required'); return;
        }
        if (ruleNeedsWebhook(actionType) && !actionWebhookId) {
            showToast('error', 'Pick an outbound webhook'); return;
        }
        saving = true;
        try {
            const condition: MailRule['condition'] = { type: conditionType, value };
            if (ruleHasHeader(conditionType)) condition.header = conditionHeader.trim();
            const action: MailRule['action'] = { type: actionType };
            if (ruleHasTarget(actionType)) action.to = actionTo.trim();
            if (ruleNeedsFolder(actionType)) action.folder = actionFolder.trim();
            if (ruleNeedsWebhook(actionType)) action.webhookId = actionWebhookId;
            const name = `${actionType} ${value}`.slice(0, 80);
            await addMailRule({ name, condition, action });
            // The Sieve script is applied to INCOMING mail only. Mail
            // already sitting in the mailbox is never re-filtered, so say
            // so plainly — "it didn't work" reports are almost always
            // someone expecting a retro-active delete.
            showToast('success', 'Rule created — applies to mail from now on, not this message');
            onClose();
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        } finally {
            saving = false;
        }
    }
</script>

<svelte:window onkeydowncapture={handleKey} />

<div
    class="overlay"
    role="presentation"
    onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
    <!-- aria-describedby only while the note is actually rendered: with
         rulesUnavailable (or before the seed effect has run) the id would
         dangle, and a dialog whose description points at nothing is worse
         than one with no description at all. -->
    <div
        bind:this={dialogEl}
        class="dialog fade-in"
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-labelledby="rule-from-msg-title"
        aria-describedby={seed && !rulesUnavailable ? 'rule-future-only-note' : undefined}
        data-testid="rule-from-message-dialog"
    >
        <header class="head">
            <div>
                <h2 id="rule-from-msg-title">
                    <Icon name="filter" size={15} /> Create rule from message
                </h2>
                <p class="muted">
                    Prefilled from this message. Change anything before you save.
                </p>
            </div>
            <button type="button" class="btn btn-ghost" aria-label="Close" onclick={onClose} data-testid="rule-from-message-close">
                <Icon name="close" size={16} />
            </button>
        </header>

        {#if seed}
            <div class="source" data-testid="rule-from-message-source">
                <div class="src-row">
                    <span class="src-label">From</span>
                    <span class="src-val">{seed.from || '(no From address)'}</span>
                </div>
                <div class="src-row">
                    <span class="src-label">To</span>
                    <span class="src-val">{seed.to || '(no To address)'}</span>
                </div>
                <div class="src-row">
                    <span class="src-label">Subject</span>
                    <span class="src-val">{seed.subject || '(no subject)'}</span>
                </div>
            </div>

            {#if rulesUnavailable}
                <p class="muted notice" data-testid="rule-from-message-unavailable">
                    This server doesn't expose the mail-rules API, so rules can't be
                    created from here. Use the mailserver's Sieve editor instead.
                </p>
            {:else}
                <div class="form">
                    <label class="row">
                        <span class="label">When</span>
                        <select bind:value={conditionType} data-testid="rule-condition-type">
                            {#each Object.keys(RULE_CONDITION_LABELS) as t (t)}
                                <option value={t}>{RULE_CONDITION_LABELS[t as MailRuleConditionType]}</option>
                            {/each}
                        </select>
                    </label>

                    {#if ruleHasHeader(conditionType)}
                        <label class="row">
                            <span class="label">Header</span>
                            <input
                                type="text"
                                placeholder="X-List-ID"
                                bind:value={conditionHeader}
                                data-testid="rule-condition-header"
                            />
                        </label>
                    {/if}

                    <label class="row">
                        <span class="label">Value</span>
                        <input
                            type="text"
                            placeholder="example.com"
                            bind:value={conditionValue}
                            data-testid="rule-condition-value"
                        />
                    </label>

                    <div class="prefills" data-testid="rule-from-message-prefills">
                        <span class="muted">Quick fill:</span>
                        <button
                            type="button"
                            class="chip"
                            onclick={() => { conditionType = 'from-contains'; conditionValue = seed!.from; }}
                            disabled={!seed.from}
                            data-testid="rule-prefill-from"
                        >Sender</button>
                        <button
                            type="button"
                            class="chip"
                            onclick={() => { conditionType = 'to-contains'; conditionValue = seed!.to; }}
                            disabled={!seed.to}
                            data-testid="rule-prefill-to"
                        >Recipient</button>
                        <button
                            type="button"
                            class="chip"
                            onclick={() => { conditionType = 'subject-contains'; conditionValue = seed!.subject; }}
                            disabled={!seed.subject}
                            data-testid="rule-prefill-subject"
                        >Subject</button>
                    </div>

                    <label class="row">
                        <span class="label">Then</span>
                        <select bind:value={actionType} data-testid="rule-action-type">
                            {#each Object.keys(RULE_ACTION_LABELS) as t (t)}
                                {#if t !== 'webhook' || (!outboundUnavailable && outboundHooks.length > 0)}
                                    <option value={t}>{RULE_ACTION_LABELS[t as MailRuleActionType]}</option>
                                {/if}
                            {/each}
                        </select>
                    </label>

                    {#if ruleHasTarget(actionType)}
                        <label class="row">
                            <span class="label">
                                {actionType === 'copy' ? 'Forward a copy to' : 'Forward to'}
                            </span>
                            <input
                                type="email"
                                placeholder="someone@elsewhere.example"
                                bind:value={actionTo}
                                data-testid="rule-action-to"
                            />
                        </label>
                    {/if}

                    {#if ruleNeedsFolder(actionType)}
                        <label class="row">
                            <span class="label">Folder</span>
                            <input
                                type="text"
                                placeholder="Archive"
                                list="rule-folder-options"
                                bind:value={actionFolder}
                                data-testid="rule-action-folder"
                            />
                            <datalist id="rule-folder-options">
                                {#each mailboxes as mb (mb.path)}
                                    <option value={mb.path}>{mb.name || mb.path}</option>
                                {/each}
                            </datalist>
                        </label>
                    {/if}

                    {#if ruleNeedsWebhook(actionType)}
                        <!-- No empty state here, deliberately. The `webhook`
                             option is only rendered when the list is non-empty
                             (see the action select above), and the reconcile
                             effect drops a seeded webhook action back to
                             discard when it is not — so by the time this select
                             can be shown it always has real options. The old
                             "No outbound webhooks yet" paragraph could only
                             ever render while the probe was still in flight,
                             where it asserted an empty list before the list had
                             loaded. -->
                        <label class="row">
                            <span class="label">Webhook</span>
                            <select bind:value={actionWebhookId} data-testid="rule-action-webhook">
                                <option value="" disabled>Pick an outbound webhook…</option>
                                {#each outboundHooks as w (w.id)}
                                    <option value={w.id}>{w.label} — {w.url}</option>
                                {/each}
                            </select>
                        </label>
                    {/if}
                </div>

                <!-- Sieve rules are a filter on the INBOUND stream. The
                     server compiles the script and applies it to mail as it
                     arrives; nothing re-runs it against what's already in
                     the mailbox. This is the single most common source of
                     "I made a rule and nothing happened", so it's stated
                     in the dialog body, not only in the success toast. -->
                <!-- aria-describedby, not just a paragraph. A dialog's
                     accessible description is announced right after its
                     title when focus moves in, so a screen-reader user
                     hears "this won't touch mail you already have" BEFORE
                     typing anything — the only moment it can still change
                     what they do. As a bare <p> it was read in document
                     order at some arbitrary point, with the whole form to
                     tab through before reaching it. -->
                <p class="future-note" id="rule-future-only-note" data-testid="rule-future-only-note">
                    <Icon name="info" size={13} />
                    <span>
                        Rules run on mail as it <strong>arrives</strong>. This rule will
                        not be applied to this message or anything already in your
                        mailbox.
                    </span>
                </p>
            {/if}
        {/if}

        <footer class="foot">
            <button type="button" class="btn btn-ghost" onclick={onClose} data-testid="rule-from-message-cancel">
                Cancel
            </button>
            <button
                type="button"
                class="btn btn-primary"
                disabled={saving || rulesUnavailable}
                onclick={save}
                data-testid="rule-add"
            >{saving ? 'Saving…' : 'Create rule'}</button>
        </footer>
    </div>
</div>

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: var(--bg-overlay);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        /* Above the row context menu (z-index 200) so opening the rule
           dialog from the menu never leaves the menu stacked over the
           modal. */
        z-index: 210;
    }
    .dialog {
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

    .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .head h2 {
        margin: 0 0 4px;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.015em;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .head .muted { font-size: 12.5px; margin: 0; line-height: 1.45; }

    /* The message the form was seeded from. Kept visible (not just in
       the inputs) because a prefill the user didn't ask for is
       indistinguishable from one they did until they look at the source. */
    .source {
        padding: 12px 20px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .src-row {
        display: grid;
        grid-template-columns: 64px 1fr;
        gap: 8px;
        font-size: 12px;
        align-items: baseline;
        min-width: 0;
    }
    .src-label {
        font-weight: 600;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10.5px;
    }
    .src-val {
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
    }

    .form {
        padding: 16px 20px 6px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        overflow-y: auto;
    }
    .row {
        display: grid;
        grid-template-columns: 120px 1fr;
        align-items: center;
        gap: 8px;
        font-size: 12px;
    }
    .label {
        font-weight: 600;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 11px;
    }
    .row select, .row input {
        width: 100%;
        padding: 5px 8px;
        font-size: 12px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        color: var(--text-primary);
    }

    .prefills {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        font-size: 11.5px;
        margin-bottom: 2px;
    }
    .chip {
        padding: 3px 9px;
        font-size: 11.5px;
        border-radius: 999px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-base);
        color: var(--text-secondary);
        cursor: pointer;
    }
    .chip:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .chip:disabled { opacity: 0.5; cursor: not-allowed; }

    .notice {
        font-size: 12px;
        line-height: 1.5;
        margin: 0;
    }

    .future-note {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin: 0;
        padding: 10px 12px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-secondary);
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-left: 3px solid var(--accent);
        border-radius: var(--radius-xs);
    }
    .future-note :global(svg) { flex: none; margin-top: 2px; color: var(--accent); }

    .foot {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 20px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
</style>
