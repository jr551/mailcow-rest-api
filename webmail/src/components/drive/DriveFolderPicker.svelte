<script lang="ts">
    import { onMount } from 'svelte';
    import { getDriveConfig } from '../../lib/api';
    import { listObjects, getConfig, setDriveConfig } from '../../lib/drive-api';
    import type { DriveItem } from '../../lib/drive-api';
    import Icon from '../Icon.svelte';

    interface Props {
        onSelect: (path: string) => void;
        onCancel: () => void;
    }

    let { onSelect, onCancel }: Props = $props();

    let currentPath = $state('');
    let folders = $state<DriveItem[]>([]);
    let loading = $state(false);
    let error = $state<string | null>(null);

    async function loadFolders(path: string) {
        loading = true;
        error = null;
        try {
            if (!getConfig()) {
                const cfg = await getDriveConfig();
                if (cfg) setDriveConfig(cfg);
            }
            const items = await listObjects(path);
            folders = items.filter((i) => i.isFolder);
            currentPath = path;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }

    onMount(() => {
        loadFolders('');
    });

    function breadcrumbParts(): { name: string; path: string }[] {
        if (!currentPath) return [];
        const parts = currentPath.split('/');
        return parts.map((name, i) => ({
            name,
            path: parts.slice(0, i + 1).join('/')
        }));
    }
</script>

<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) onCancel(); }} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Escape') onCancel(); }}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
        <div class="header">
            <span class="title">Choose folder in Drive</span>
            <button type="button" class="close-btn" onclick={onCancel}>
                <Icon name="close" size={18} />
            </button>
        </div>
        <div class="breadcrumb">
            <button type="button" class="crumb" onclick={() => loadFolders('')}>
                <Icon name="drive" size={13} /> Drive
            </button>
            {#each breadcrumbParts() as part}
                <span class="crumb-sep">/</span>
                <button type="button" class="crumb" onclick={() => loadFolders(part.path)}>{part.name}</button>
            {/each}
        </div>
        <div class="body">
            {#if loading}
                <div class="status">Loading folders…</div>
            {:else if error}
                <div class="status error">{error}</div>
            {:else}
                <button type="button" class="folder-row current" onclick={() => onSelect(currentPath)}>
                    <Icon name="check" size={16} />
                    <span>Save to "{currentPath || 'Drive root'}"</span>
                </button>
                {#each folders as folder}
                    <button type="button" class="folder-row" onclick={() => loadFolders(folder.path)}>
                        <Icon name="folderOpen" size={16} />
                        <span>{folder.name}</span>
                        <span style="margin-left: auto; color: var(--text-tertiary); display: inline-flex;">
                            <Icon name="chevronRight" size={14} />
                        </span>
                    </button>
                {/each}
                {#if folders.length === 0 && currentPath !== ''}
                    <div class="status">No subfolders. Saving to current folder.</div>
                {/if}
            {/if}
        </div>
        <div class="footer">
            <button type="button" class="btn-ghost" onclick={onCancel}>Cancel</button>
        </div>
    </div>
</div>

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 120;
        padding: 16px;
    }
    .modal {
        width: 100%;
        max-width: 480px;
        max-height: 70vh;
        background: var(--bg-surface);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-xl);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-base);
        flex: 0 0 auto;
    }
    .title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4px;
        border-radius: var(--radius-sm);
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
    }
    .close-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    .breadcrumb {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 8px 16px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-surface);
        font-size: 12px;
        overflow-x: auto;
        white-space: nowrap;
    }
    .crumb {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        border-radius: var(--radius-xs);
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 12px;
    }
    .crumb:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    .crumb-sep {
        color: var(--text-tertiary);
    }
    .body {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .folder-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: var(--radius-sm);
        background: none;
        border: none;
        color: var(--text-primary);
        cursor: pointer;
        font-size: 13px;
        text-align: left;
        transition: background-color 120ms;
    }
    .folder-row:hover {
        background: var(--bg-hover);
    }
    .folder-row.current {
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 500;
    }
    .folder-row.current:hover {
        background: var(--accent-soft);
        opacity: 0.9;
    }
    .status {
        padding: 20px;
        text-align: center;
        color: var(--text-secondary);
        font-size: 13px;
    }
    .error {
        color: var(--danger);
    }
    .footer {
        display: flex;
        justify-content: flex-end;
        padding: 12px 16px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-base);
        flex: 0 0 auto;
    }
    .btn-ghost {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 500;
        border-radius: var(--radius-md);
        border: none;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
    }
    .btn-ghost:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
</style>
