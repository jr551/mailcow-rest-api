<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { trapFocus } from '../lib/focus-trap';
    import {
        addMailRule,
        listMailRules,
        listMailboxes,
        ApiError,
        type MessageListItem,
        type Mailbox
    } from '../lib/api';
    import {
        senderAddressFromMessage,
        senderDisplayLabel,
        type SenderSweepAction
    } from '../lib/message-sender-sweep';
    import {
        automationKindForOneTimeAction,
        buildSenderSweepAutomationRule,
        findExistingSweepAutomation,
        type SenderSweepAutomationKind
    } from '../lib/message-sender-sweep-automation';
    import { findArchiveFolder, findTrashFolder } from '../lib/spam-sweep';
    import { showToast } from '../lib/store.svelte';
    import Icon from './Icon.svelte';

    interface Props {
        message: MessageListItem | null;
        folderPath: string;
        busy?: boolean;
        onClose: () => void;
        /** Run the one-time bulk sweep after the user confirms in this dialog. */
        onRunOneTime: (action: SenderSweepAction) => Promise<boolean>;
    }

    let { message, folderPath, busy = false, onClose, onRunOneTime }: Props = $props();

    let oneTimeAction = $state<SenderSweepAction>('delete-all');
    let alwaysTrash = $state(false);
    let alwaysArchive = $state(false);
    let applying = $state(false);
    let rulesUnavailable = $state(false);
    let mailboxes = $state<Mailbox[]>([]);
    let dialogEl: HTMLDivElement | undefined = $state();
    let restoreTo: HTMLElement | null = null;

    const sender = $derived(message ? senderAddressFromMessage(message) : null);
    const label = $derived(message ? senderDisplayLabel(message) : 'this sender');

    const automationKind = $derived(automationKindForOneTimeAction(oneTimeAction));
    const showTrashAutomation = $derived(oneTimeAction === 'delete-all' || oneTimeAction === 'keep-latest');
    const showArchiveAutomation = $derived(oneTimeAction === 'archive-all');

    $effect(() => {
        if (!showTrashAutomation) alwaysTrash = false;
        if (!showArchiveAutomation) alwaysArchive = false;
    });

    onMount(() => {
        restoreTo = document.activeElement as HTMLElement | null;
        dialogEl?.focus();
        void loadSupport();
        if (dialogEl) return trapFocus(dialogEl);
    });

    onDestroy(() => {
        if (restoreTo?.isConnected) restoreTo.focus();
    });

    async function loadSupport() {
        try {
            await listMailRules();
        } catch (err) {
            if (err instanceof ApiError && err.status === 404) rulesUnavailable = true;
        }
        try {
            mailboxes = await listMailboxes({ counts: false });
        } catch {
            mailboxes = [];
        }
    }

    function handleKey(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
        }
    }

    async function createAutomation(kind: SenderSweepAutomationKind): Promise<boolean> {
        if (!sender || rulesUnavailable) return false;
        const dest =
            kind === 'always-archive'
                ? findArchiveFolder(mailboxes)
                : findTrashFolder(mailboxes);
        if (!dest) {
            showToast(
                'error',
                kind === 'always-archive' ? 'No Archive folder found.' : 'No Trash folder found.'
            );
            return false;
        }
        try {
            const { rules } = await listMailRules();
            if (findExistingSweepAutomation(rules, sender, kind)) {
                showToast('info', 'A sweep rule for this sender already exists.');
                return true;
            }
            await addMailRule(buildSenderSweepAutomationRule(sender, kind, dest));
            const where = kind === 'always-archive' ? 'Archive' : 'Deleted Items';
            showToast('success', `Future mail from ${sender} will move to ${where}.`);
            return true;
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
            return false;
        }
    }

    async function apply() {
        if (!message || !sender || applying || busy) return;
        applying = true;
        try {
            const wantsOneTime = true;
            const wantsAutomation =
                (showTrashAutomation && alwaysTrash) || (showArchiveAutomation && alwaysArchive);

            if (wantsOneTime) {
                const ok = await onRunOneTime(oneTimeAction);
                if (!ok && !wantsAutomation) {
                    return;
                }
            }

            if (wantsAutomation) {
                const kind = showArchiveAutomation && alwaysArchive
                    ? 'always-archive'
                    : automationKind;
                await createAutomation(kind);
            }

            if (wantsOneTime || wantsAutomation) onClose();
        } finally {
            applying = false;
        }
    }
</script>

<svelte:window onkeydowncapture={handleKey} />

{#if message && sender}
    <div
        class="overlay"
        role="presentation"
        onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
        <div
            bind:this={dialogEl}
            class="dialog fade-in"
            role="dialog"
            tabindex="-1"
            aria-modal="true"
            aria-labelledby="sender-sweep-title"
            data-testid="sender-sweep-dialog"
        >
            <header class="head">
                <div>
                    <h2 id="sender-sweep-title">
                        <Icon name="filter" size={15} /> Sweep
                    </h2>
                    <p class="muted">Bulk-handle mail from <strong>{label}</strong> in this folder.</p>
                </div>
                <button type="button" class="btn btn-ghost" aria-label="Close" onclick={onClose} data-testid="sender-sweep-close">
                    <Icon name="close" size={16} />
                </button>
            </header>

            <div class="body">
                <p class="section-label">One-time</p>
                <fieldset class="actions">
                    <legend class="sr-only">One-time sweep action</legend>
                    <label class="radio-row">
                        <input
                            type="radio"
                            name="sender-sweep-one-time"
                            value="delete-all"
                            bind:group={oneTimeAction}
                            data-testid="sender-sweep-action-delete-all"
                        />
                        <span>Delete all messages from {label}</span>
                    </label>
                    <label class="radio-row">
                        <input
                            type="radio"
                            name="sender-sweep-one-time"
                            value="keep-latest"
                            bind:group={oneTimeAction}
                            data-testid="sender-sweep-action-keep-latest"
                        />
                        <span>Keep only the latest message from {label}</span>
                    </label>
                    <label class="radio-row">
                        <input
                            type="radio"
                            name="sender-sweep-one-time"
                            value="archive-all"
                            bind:group={oneTimeAction}
                            data-testid="sender-sweep-action-archive-all"
                        />
                        <span>Move all messages from {label} to Archive</span>
                    </label>
                </fieldset>

                {#if !rulesUnavailable}
                    <p class="section-label">Automation</p>
                    <p class="muted small future-note">
                        Rules apply to new mail as it arrives — not messages already in your mailbox.
                    </p>
                    {#if showTrashAutomation}
                        <label class="check-row">
                            <input
                                type="checkbox"
                                bind:checked={alwaysTrash}
                                data-testid="sender-sweep-automation-trash"
                            />
                            <span>Always move future messages from {label} to Deleted Items</span>
                        </label>
                    {/if}
                    {#if showArchiveAutomation}
                        <label class="check-row">
                            <input
                                type="checkbox"
                                bind:checked={alwaysArchive}
                                data-testid="sender-sweep-automation-archive"
                            />
                            <span>Always move future messages from {label} to Archive</span>
                        </label>
                    {/if}
                {:else}
                    <p class="muted small">Mail rules are not available on this server — one-time sweep only.</p>
                {/if}
            </div>

            <footer class="foot">
                <button type="button" class="btn btn-ghost" onclick={onClose}>Cancel</button>
                <button
                    type="button"
                    class="btn btn-primary"
                    disabled={applying || busy}
                    onclick={() => void apply()}
                    data-testid="sender-sweep-apply"
                >
                    {applying || busy ? 'Working…' : 'Sweep'}
                </button>
            </footer>
        </div>
    </div>
{/if}

<style>
    .overlay {
        position: fixed;
        inset: 0;
        z-index: 1200;
        background: rgb(0 0 0 / 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
    }
    .dialog {
        width: min(100%, 28rem);
        max-height: min(90vh, 32rem);
        overflow: auto;
        background: var(--surface-elevated, #fff);
        border-radius: 8px;
        box-shadow: 0 12px 40px rgb(0 0 0 / 0.2);
        display: flex;
        flex-direction: column;
    }
    .head {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 1rem 1rem 0.5rem;
        border-bottom: 1px solid var(--border-subtle, #e5e5e5);
    }
    .head h2 {
        margin: 0;
        font-size: 1.05rem;
        display: flex;
        align-items: center;
        gap: 0.35rem;
    }
    .body {
        padding: 0.75rem 1rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
    .section-label {
        margin: 0.25rem 0 0;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted, #666);
    }
    .actions {
        border: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }
    .radio-row,
    .check-row {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        font-size: 0.9rem;
        cursor: pointer;
    }
    .radio-row input,
    .check-row input {
        margin-top: 0.2rem;
    }
    .foot {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding: 0.75rem 1rem 1rem;
        border-top: 1px solid var(--border-subtle, #e5e5e5);
    }
    .muted {
        color: var(--text-muted, #666);
        font-size: 0.85rem;
        margin: 0.25rem 0 0;
    }
    .small {
        font-size: 0.8rem;
    }
    .future-note {
        margin: 0 0 0.35rem;
    }
    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        border: 0;
    }
</style>
