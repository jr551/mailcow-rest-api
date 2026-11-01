<script lang="ts">
    import Icon from '../../components/Icon.svelte';
    import { summarizeMessage, type MessageListItem, type MessageDetail, ApiError } from '../../lib/api';
    import { showToast } from '../lib/store.svelte';
    import { settings } from '../../lib/settings.svelte';
    import { followUpSubmenuItems, type FollowUpPresetId } from '../../lib/message-follow-up';
    import {
        snoozeSubmenuItems,
        type SnoozePresetId
    } from '../../lib/message-pin-snooze';
    import {
        senderAddressFromMessage
    } from '../../lib/message-sender-sweep';
    import {
        categoryMenuItems,
        MESSAGE_CATEGORY_BY_ID,
        type MessageCategoryId
    } from '../../lib/message-categories';
    import { mobilePinActionLabel } from '../../lib/mobile-message-pin';

    interface Props {
        msg: MessageListItem;
        detail: MessageDetail | null;
        isOpen: boolean;
        onClose: () => void;
        onOpen: () => void;
        onReply: () => void;
        onToggleStar: () => void;
        onFollowUp: (preset: FollowUpPresetId | 'clear') => void | Promise<void>;
        onToggleRead: () => void;
        onArchive: () => void;
        onTrash: () => void;
        onSnooze: (preset: SnoozePresetId) => void | Promise<void>;
        onOpenSweepDialog: () => void;
        onCategory: (category: MessageCategoryId | 'clear') => void | Promise<void>;
        onTogglePin: () => void;
        isPinned?: boolean;
        currentCategory?: MessageCategoryId | null;
    }

    let {
        msg,
        detail,
        isOpen,
        onClose,
        onOpen,
        onReply,
        onToggleStar,
        onFollowUp,
        onToggleRead,
        onArchive,
        onTrash,
        onSnooze,
        onOpenSweepDialog,
        onCategory,
        onTogglePin,
        isPinned = false,
        currentCategory = null
    }: Props = $props();

    let summaryLoading = $state(false);
    let summaryResult = $state<string | null>(null);
    let summaryError = $state<string | null>(null);
    let followUpMenuOpen = $state(false);
    let snoozeMenuOpen = $state(false);
    let categoryMenuOpen = $state(false);

    const followUpItems = followUpSubmenuItems();
    const categoryItems = categoryMenuItems();
    const snoozeItems = snoozeSubmenuItems();
    const sweepSender = $derived(senderAddressFromMessage(msg));

    // Derived, not captured at init: the sheet stays open after a Star /
    // mark-read tap and the handlers mutate `msg.flags` in place, so frozen
    // booleans left the button reading "Star" after starring (the next tap
    // then silently UN-starred) and "Mark read" after marking read.
    const isUnread = $derived(!msg.flags.includes('\\Seen'));
    const isStarred = $derived(msg.flags.includes('\\Flagged'));

    function bodyForAi(): string {
        if (!detail) return '';
        const env = detail.envelope;
        const headers = [
            `From: ${env.from?.[0]?.name || ''} <${env.from?.[0]?.address || ''}>`,
            env.subject ? `Subject: ${env.subject}` : '',
            env.date ? `Date: ${env.date}` : ''
        ].filter(Boolean).join('\n');
        const body = detail.text || (detail.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        return `${headers}\n\n${body}`;
    }

    async function runSummarize() {
        // Defence in depth — the button is hidden when AI is off, but
        // summarizeMessage is a real paid call to the server's /v1/ai route.
        if (!settings.aiFeatures) return;
        if (!detail) {
            showToast('error', 'Open the message first');
            return;
        }
        summaryLoading = true;
        summaryError = null;
        summaryResult = null;
        try {
            const r = await summarizeMessage(bodyForAi());
            summaryResult = r.content;
        } catch (err) {
            summaryError = err instanceof ApiError ? (err.detail || err.title || 'Summarize failed') : 'Summarize failed';
        } finally {
            summaryLoading = false;
        }
    }

    function closeAll() {
        summaryResult = null;
        summaryError = null;
        followUpMenuOpen = false;
        snoozeMenuOpen = false;
        categoryMenuOpen = false;
        onClose();
    }

    async function pickFollowUp(key: string) {
        await onFollowUp(key as FollowUpPresetId | 'clear');
        followUpMenuOpen = false;
        onClose();
    }

    async function pickSnooze(key: string) {
        await onSnooze(key as SnoozePresetId);
        snoozeMenuOpen = false;
        onClose();
    }

    async function pickCategory(key: string) {
        await onCategory(key as MessageCategoryId | 'clear');
        categoryMenuOpen = false;
        onClose();
    }
</script>

{#if isOpen}
    <!-- Presentation role: this layer only provides the tap-outside-to-close
         convenience for pointer users; the sheet's close button is the
         accessible dismiss path. -->
    <div class="sheet-backdrop" role="presentation" onclick={closeAll}></div>
    <div class="action-sheet slide-up" role="dialog" aria-modal="true" aria-label="Message actions">
        {#if summaryResult || summaryLoading || summaryError}
            <div class="sheet-header">
                <h3>Summary</h3>
                <button type="button" class="close-btn" aria-label="Close" onclick={closeAll}>
                    <Icon name="close" size={18} />
                </button>
            </div>
            <div class="sheet-body">
                {#if summaryLoading}
                    <div class="center">
                        <span class="spinner" style="width:24px;height:24px"></span>
                        <span class="muted">Summarizing…</span>
                    </div>
                {:else if summaryError}
                    <div class="error">{summaryError}</div>
                {:else}
                    <pre class="summary">{summaryResult}</pre>
                {/if}
            </div>
        {:else if snoozeMenuOpen}
            <div class="sheet-header">
                <button type="button" class="back-btn" aria-label="Back" onclick={() => { snoozeMenuOpen = false; }}>
                    <Icon name="chevronLeft" size={18} />
                </button>
                <h3>Snooze</h3>
                <button type="button" class="close-btn" aria-label="Close" onclick={onClose}>
                    <Icon name="close" size={18} />
                </button>
            </div>
            <div class="actions">
                {#each snoozeItems as item (item.key)}
                    <button
                        type="button"
                        class="action-row"
                        data-testid={`mobile-snooze-item-${item.key}`}
                        onclick={() => pickSnooze(item.key)}
                    >
                        <Icon name="clock" size={20} />
                        <span>{item.label}</span>
                    </button>
                {/each}
            </div>
        {:else if categoryMenuOpen}
            <div class="sheet-header">
                <button type="button" class="back-btn" aria-label="Back" onclick={() => { categoryMenuOpen = false; }}>
                    <Icon name="chevronLeft" size={18} />
                </button>
                <h3>Categorize</h3>
                <button type="button" class="close-btn" aria-label="Close" onclick={onClose}>
                    <Icon name="close" size={18} />
                </button>
            </div>
            <div class="actions">
                {#each categoryItems as item (item.value)}
                    <button
                        type="button"
                        class="action-row"
                        class:active={item.value !== 'clear' && item.value === currentCategory}
                        data-testid={`mobile-category-item-${item.value}`}
                        onclick={() => pickCategory(item.value)}
                    >
                        {#if item.value === 'clear'}
                            <Icon name="close" size={20} />
                        {:else}
                            <span
                                class="category-swatch"
                                style={`background: ${MESSAGE_CATEGORY_BY_ID[item.value].color}`}
                                aria-hidden="true"
                            ></span>
                        {/if}
                        <span>{item.label}</span>
                    </button>
                {/each}
            </div>
        {:else if followUpMenuOpen}
            <div class="sheet-header">
                <button type="button" class="back-btn" aria-label="Back" onclick={() => { followUpMenuOpen = false; }}>
                    <Icon name="chevronLeft" size={18} />
                </button>
                <h3>Flag for follow-up</h3>
                <button type="button" class="close-btn" aria-label="Close" onclick={onClose}>
                    <Icon name="close" size={18} />
                </button>
            </div>
            <div class="actions">
                {#each followUpItems as item (item.key)}
                    <button
                        type="button"
                        class="action-row"
                        data-testid={`mobile-follow-up-item-${item.key}`}
                        onclick={() => pickFollowUp(item.key)}
                    >
                        <Icon name={item.key === 'clear' ? 'star' : 'starFilled'} size={20} />
                        <span>{item.label}</span>
                    </button>
                {/each}
            </div>
        {:else}
            <div class="sheet-header">
                <h3>{msg.envelope.subject || '(no subject)'}</h3>
                <button type="button" class="close-btn" aria-label="Close" onclick={onClose}>
                    <Icon name="close" size={18} />
                </button>
            </div>
            <div class="actions">
                <button type="button" class="action-row" onclick={() => { onOpen(); onClose(); }}>
                    <Icon name="mail" size={20} />
                    <span>Open</span>
                </button>
                <button type="button" class="action-row" onclick={() => { onReply(); onClose(); }}>
                    <Icon name="reply" size={20} />
                    <span>Reply</span>
                </button>
                {#if settings.aiFeatures}
                    <button type="button" class="action-row accent" onclick={runSummarize}>
                        <Icon name="sparkles" size={20} />
                        <span>Summarize</span>
                    </button>
                {/if}
                <button type="button" class="action-row" onclick={() => { onToggleStar(); onClose(); }}>
                    <Icon name={isStarred ? 'starFilled' : 'star'} size={20} />
                    <span>{isStarred ? 'Unstar' : 'Star'}</span>
                </button>
                <button
                    type="button"
                    class="action-row"
                    data-testid="mobile-follow-up-trigger"
                    onclick={() => { followUpMenuOpen = true; }}
                >
                    <Icon name="starFilled" size={20} />
                    <span>{isStarred ? 'Follow-up date…' : 'Flag for follow-up'}</span>
                </button>
                <button
                    type="button"
                    class="action-row"
                    data-testid="mobile-category-trigger"
                    onclick={() => { categoryMenuOpen = true; }}
                >
                    <Icon name="palette" size={20} />
                    <span>Categorize</span>
                </button>
                <button
                    type="button"
                    class="action-row"
                    data-testid="mobile-pin-toggle"
                    onclick={() => { onTogglePin(); onClose(); }}
                >
                    <Icon name="pin" size={20} />
                    <span>{mobilePinActionLabel(isPinned)}</span>
                </button>
                <button
                    type="button"
                    class="action-row"
                    data-testid="mobile-snooze-trigger"
                    onclick={() => { snoozeMenuOpen = true; }}
                >
                    <Icon name="clock" size={20} />
                    <span>Snooze</span>
                </button>
                {#if sweepSender}
                    <button
                        type="button"
                        class="action-row"
                        data-testid="mobile-sweep-trigger"
                        onclick={() => { onOpenSweepDialog(); onClose(); }}
                    >
                        <Icon name="filter" size={20} />
                        <span>Sweep</span>
                    </button>
                {/if}
                <button type="button" class="action-row" onclick={() => { onToggleRead(); onClose(); }}>
                    <Icon name={isUnread ? 'eye' : 'mail'} size={20} />
                    <span>{isUnread ? 'Mark read' : 'Mark unread'}</span>
                </button>
                <button type="button" class="action-row" onclick={() => { onArchive(); onClose(); }}>
                    <Icon name="archive" size={20} />
                    <span>Archive</span>
                </button>
                <button type="button" class="action-row danger" onclick={() => { onTrash(); onClose(); }}>
                    <Icon name="trash" size={20} />
                    <span>Delete</span>
                </button>
            </div>
        {/if}
    </div>
{/if}

<style>
    .sheet-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(2px);
        z-index: 90;
        animation: fade-in 180ms ease;
    }
    .action-sheet {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 95;
        background: var(--bg-surface);
        border-radius: 16px 16px 0 0;
        padding: 8px 0 calc(16px + env(safe-area-inset-bottom));
        box-shadow: 0 -4px 24px rgba(0,0,0,0.15);
        animation: slide-up 260ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
    }
    .sheet-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px 8px;
    }
    .sheet-header h3 {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        color: var(--text-primary);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .close-btn {
        background: none;
        border: none;
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        cursor: pointer;
    }
    .back-btn {
        background: none;
        border: none;
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        cursor: pointer;
        flex-shrink: 0;
    }
    .actions {
        display: flex;
        flex-direction: column;
        padding: 0 12px;
    }
    .action-row {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 13px 16px;
        background: none;
        border: none;
        border-radius: 10px;
        color: var(--text-primary);
        font-size: 16px;
        font-weight: 400;
        text-align: left;
        cursor: pointer;
        transition: background-color 80ms;
        user-select: none;
        -webkit-user-select: none;
    }
    .action-row:active { background: var(--bg-hover); }
    .action-row.active { background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .action-row.accent { color: var(--accent); font-weight: 500; }
    .action-row.danger { color: var(--danger); }
    .sheet-body {
        padding: 8px 16px 16px;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
    }
    .summary {
        margin: 0;
        font-family: inherit;
        font-size: 14px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--text-primary);
    }
    .center {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 24px;
        color: var(--text-secondary);
    }
    .error {
        padding: 12px;
        background: var(--danger-soft);
        color: var(--danger);
        border-radius: 10px;
        font-size: 14px;
    }
    .muted { color: var(--text-tertiary); font-size: 14px; }
    .category-swatch {
        width: 20px;
        height: 20px;
        border-radius: 4px;
        flex-shrink: 0;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 12%, transparent);
    }
    @keyframes fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }
    @keyframes slide-up {
        from { transform: translateY(100%); }
        to { transform: translateY(0); }
    }
</style>
