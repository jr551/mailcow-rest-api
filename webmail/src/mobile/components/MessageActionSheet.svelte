<script lang="ts">
    import Icon from '../../components/Icon.svelte';
    import { summarizeMessage, type MessageListItem, type MessageDetail, ApiError } from '../../lib/api';
    import { showToast } from '../lib/store.svelte';

    interface Props {
        msg: MessageListItem;
        detail: MessageDetail | null;
        isOpen: boolean;
        onClose: () => void;
        onOpen: () => void;
        onReply: () => void;
        onToggleStar: () => void;
        onToggleRead: () => void;
        onArchive: () => void;
        onTrash: () => void;
    }

    let {
        msg,
        detail,
        isOpen,
        onClose,
        onOpen,
        onReply,
        onToggleStar,
        onToggleRead,
        onArchive,
        onTrash
    }: Props = $props();

    let summaryLoading = $state(false);
    let summaryResult = $state<string | null>(null);
    let summaryError = $state<string | null>(null);

    const isUnread = !msg.flags.includes('\\Seen');
    const isStarred = msg.flags.includes('\\Flagged');

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
        onClose();
    }
</script>

{#if isOpen}
    <div class="sheet-backdrop" onclick={closeAll}></div>
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
        {:else}
            <div class="sheet-header">
                <h3>{msg.envelope.subject || '(no subject)'}</h3>
                <button type="button" class="close-btn" onclick={onClose}>
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
                <button type="button" class="action-row accent" onclick={runSummarize}>
                    <Icon name="sparkles" size={20} />
                    <span>Summarize</span>
                </button>
                <button type="button" class="action-row" onclick={() => { onToggleStar(); onClose(); }}>
                    <Icon name={isStarred ? 'starFilled' : 'star'} size={20} />
                    <span>{isStarred ? 'Unstar' : 'Star'}</span>
                </button>
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
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
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
        -webkit-user-select: none;
    }
    .action-row:active { background: var(--bg-hover); }
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
    @keyframes fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }
    @keyframes slide-up {
        from { transform: translateY(100%); }
        to { transform: translateY(0); }
    }
</style>
