<script lang="ts">
    import Icon from './Icon.svelte';

    interface Props {
        count: number;
        onMarkRead: () => void;
        onMarkUnread: () => void;
        onArchive: () => void;
        onTrash: () => void;
        onClear: () => void;
        onSelectAll: () => void;
    }
    let { count, onMarkRead, onMarkUnread, onArchive, onTrash, onClear, onSelectAll }: Props = $props();
</script>

<div class="bar fade-in" role="region" aria-label="Bulk actions" data-testid="bulk-bar">
    <div class="left">
        <button type="button" class="btn btn-ghost" onclick={onClear} title="Clear selection (Esc)">
            <Icon name="close" size={14} />
        </button>
        <span class="count" data-testid="bulk-count">{count} selected</span>
        <button type="button" class="link" onclick={onSelectAll} data-testid="bulk-select-all">Select all visible</button>
    </div>
    <div class="actions">
        <button type="button" class="btn btn-secondary" onclick={onMarkRead} data-testid="bulk-mark-read">
            <Icon name="mail" size={14} /> Mark read
        </button>
        <button type="button" class="btn btn-secondary" onclick={onMarkUnread} data-testid="bulk-mark-unread">
            <Icon name="mail" size={14} /> Mark unread
        </button>
        <button type="button" class="btn btn-secondary" onclick={onArchive} data-testid="bulk-archive">
            <Icon name="archive" size={14} /> Archive
        </button>
        <button type="button" class="btn btn-danger" onclick={onTrash} data-testid="bulk-trash">
            <Icon name="trash" size={14} /> Trash
        </button>
    </div>
</div>

<style>
    .bar {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 80;
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 8px 14px;
        background: var(--bg-elevated);
        border: 1px solid var(--border-soft);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        max-width: calc(100% - 32px);
    }
    .left { display: flex; align-items: center; gap: 10px; }
    .count {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .link {
        font-size: 12px;
        color: var(--accent-text);
        padding: 2px 6px;
        border-radius: var(--radius-xs);
    }
    .link:hover { background: var(--bg-hover); }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .actions .btn { padding: 6px 10px; font-size: 12.5px; }
</style>
