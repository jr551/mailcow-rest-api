<script lang="ts">
    import { onMount } from 'svelte';
    import { driveState, loadDriveConfig, loadPath, navigateTo, toggleSelect, isImage, deleteSelected, createFolder, breadcrumbParts, openPreview, closePreview, uploadFiles } from '../../lib/drive.svelte';
    import { showToast } from '../../lib/store.svelte';
    import { capabilities } from '../../lib/settings.svelte';
    import { getObjectUrl, fetchBlob } from '../../lib/drive-api';
    import { authState } from '../../lib/auth.svelte';
    import * as cache from '../../lib/drive-cache';
    import Icon from '../../components/Icon.svelte';
    import type { IconName } from '../../lib/icons';
    import DrivePreview from '../../components/drive/DrivePreview.svelte';
    import DriveUploadZone from '../../components/drive/DriveUploadZone.svelte';

    onMount(() => {
        loadDriveConfig().then(() => {
            if (driveState.config?.enabled) {
                loadPath(driveState.currentPath || '');
            }
        });
    });

    let fileInput: HTMLInputElement | undefined = $state();
    let folderInput: HTMLInputElement | undefined = $state();
    let showNewFolder = $state(false);
    let newFolderName = $state('');
    let showUploadMenu = $state(false);

    // Pull-to-refresh state
    let pullStartY = $state(0);
    let pullOffset = $state(0);
    let pullRefreshing = $state(false);
    const PULL_THRESHOLD = 80;

    function onTouchStart(e: TouchEvent) {
        const el = e.currentTarget as HTMLElement;
        if (el.scrollTop > 0) return;
        pullStartY = e.touches[0].clientY;
    }

    function onTouchMove(e: TouchEvent) {
        const el = e.currentTarget as HTMLElement;
        if (el.scrollTop > 0 || pullStartY === 0) return;
        const dy = e.touches[0].clientY - pullStartY;
        if (dy > 0 && dy < 200) {
            pullOffset = Math.min(dy, 120);
            e.preventDefault();
        }
    }

    async function onTouchEnd() {
        if (pullOffset >= PULL_THRESHOLD && !pullRefreshing) {
            pullRefreshing = true;
            pullOffset = PULL_THRESHOLD;
            await loadPath(driveState.currentPath || '');
            pullRefreshing = false;
            showToast('info', 'Refreshed');
        }
        pullStartY = 0;
        pullOffset = 0;
    }

    function onUpload() {
        showUploadMenu = !showUploadMenu;
    }

    function onFileUpload() {
        showUploadMenu = false;
        fileInput?.click();
    }

    function onFolderUpload() {
        showUploadMenu = false;
        folderInput?.click();
    }

    function onFilesSelected(e: Event) {
        const files = (e.target as HTMLInputElement).files;
        if (files && files.length > 0) {
            uploadFiles(Array.from(files));
        }
        if (fileInput) fileInput.value = '';
    }

    function onFolderSelected(e: Event) {
        const files = (e.target as HTMLInputElement).files;
        if (files && files.length > 0) {
            uploadFiles(Array.from(files));
        }
        if (folderInput) folderInput.value = '';
    }

    function onCreateFolder() {
        const name = newFolderName.trim();
        if (!name) return;
        createFolder(name);
        newFolderName = '';
        showNewFolder = false;
    }

    function iconFor(item: typeof driveState.items[0]): IconName {
        if (item.isFolder) return 'folderOpen';
        const ext = item.name.split('.').pop()?.toLowerCase();
        if (['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext || '')) return 'fileImage';
        if (['mp4','webm','mov','avi','mkv','flv'].includes(ext || '')) return 'fileVideoCamera';
        if (['mp3','wav','flac','aac','ogg','m4a','wma'].includes(ext || '')) return 'fileAudio';
        if (['pdf'].includes(ext || '')) return 'bookText';
        if (['xls','xlsx','csv','ods'].includes(ext || '')) return 'table';
        if (['doc','docx','odt'].includes(ext || '')) return 'filePen';
        if (['ppt','pptx','odp'].includes(ext || '')) return 'presentation';
        if (['zip','tar','gz','bz2','rar','7z'].includes(ext || '')) return 'fileArchive';
        if (['json'].includes(ext || '')) return 'fileJson';
        if (['js','ts','jsx','tsx','py','rb','go','java','c','cpp','h','rs','php','swift','kt','scala','r','pl','sql'].includes(ext || '')) return 'fileCode';
        if (['sh','bash','zsh'].includes(ext || '')) return 'fileTerminal';
        if (['db','sqlite','sqlite3'].includes(ext || '')) return 'database';
        if (['tldr'].includes(ext || '')) return 'palette';
        if (['txt','md','rtf','log'].includes(ext || '')) return 'fileText';
        return 'file';
    }

    function formatSize(bytes: number): string {
        if (bytes === 0) return '';
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
    }

    function uploadStatusText(u: typeof driveState.uploads[0]): string {
        if (u.error) return 'Error';
        if (u.done) return 'Done';
        return 'Uploading…';
    }

    const crumbs = $derived(breadcrumbParts(driveState.currentPath));
</script>

<div class="drive-view" data-testid="mobile-drive-view">
    <DriveUploadZone />
    <div class="header">
        <button
            type="button"
            class="back-btn"
            disabled={!driveState.currentPath}
            onclick={() => {
                const parts = driveState.currentPath.split('/');
                parts.pop();
                navigateTo(parts.join('/'));
            }}
        >
            <Icon name="chevronLeft" size={20} />
        </button>
        <div class="breadcrumbs">
            <button type="button" onclick={() => navigateTo('')}>Drive</button>
            {#each crumbs as crumb}
                <span>/</span>
                <button type="button" onclick={() => navigateTo(crumb.path)}>{crumb.name}</button>
            {/each}
        </div>
        <button
            type="button"
            class="refresh-btn"
            disabled={driveState.itemsLoading}
            onclick={() => {
                loadPath(driveState.currentPath || '');
                showToast('info', 'Refreshing…');
            }}
            data-testid="mobile-drive-refresh"
        >
            <Icon name="refresh" size={20} />
        </button>
    </div>

    {#if pullOffset > 0}
        <div class="pull-indicator" style={`transform: translateY(${pullOffset * 0.3}px)`}>
            {#if pullRefreshing}
                <span class="spinner"></span>
            {:else}
                <Icon name="refresh" size={18} class={pullOffset >= PULL_THRESHOLD ? 'ready' : ''} />
            {/if}
            <span>{pullRefreshing ? 'Refreshing…' : pullOffset >= PULL_THRESHOLD ? 'Release to refresh' : 'Pull to refresh'}</span>
        </div>
    {/if}

    <!-- Upload progress indicator -->
    {#if driveState.uploads.length > 0}
        <div class="upload-progress" data-testid="mobile-upload-progress">
            {#each driveState.uploads as u (u.name)}
                <div class="upload-row" class:error={!!u.error} class:done={u.done}>
                    <span class="upload-name">{u.name}</span>
                    <span class="upload-status">{uploadStatusText(u)}</span>
                </div>
            {/each}
        </div>
    {/if}

    {#if !driveState.config?.enabled && !driveState.configLoading}
        <div class="empty">
            <Icon name="drive" size={40} />
            <p>Drive is not configured</p>
        </div>
    {:else if driveState.itemsLoading && driveState.items.length === 0}
        <div class="loading">Loading…</div>
    {:else if driveState.items.length === 0}
        <div class="empty">
            <Icon name="folderOpen" size={40} />
            <p>This folder is empty</p>
        </div>
    {:else}
        <div class="list"
            ontouchstart={onTouchStart}
            ontouchmove={onTouchMove}
            ontouchend={onTouchEnd}
        >
            {#each driveState.items as item (item.path)}
                <button
                    type="button"
                    class="row"
                    class:selected={driveState.selected.has(item.path)}
                    data-testid="mobile-drive-item-{item.name}"
                    onclick={() => {
                        if (item.isFolder) navigateTo(item.path);
                        else openPreview(item);
                    }}
                    oncontextmenu={(e) => {
                        e.preventDefault();
                        toggleSelect(item.path);
                    }}
                >
                    <Icon name={iconFor(item)} size={24} />
                    <div class="info">
                        <span class="name">{item.name}</span>
                        <span class="meta">{formatSize(item.size)}</span>
                    </div>
                </button>
            {/each}
        </div>
    {/if}

    {#if driveState.selected.size > 0}
        <div class="selection-bar">
            <span>{driveState.selected.size} selected</span>
            <button type="button" class="delete-btn" onclick={deleteSelected}>
                <Icon name="trash" size={18} />
            </button>
        </div>
    {/if}

    {#if driveState.selected.size === 0}
        <div class="fab-group">
            {#if showNewFolder}
                <div class="folder-input">
                    <input
                        type="text"
                        placeholder="Folder name"
                        bind:value={newFolderName}
                        onkeydown={(e) => e.key === 'Enter' && onCreateFolder()}
                    />
                    <button type="button" class="btn-primary" onclick={onCreateFolder}>Create</button>
                </div>
            {/if}
            {#if showUploadMenu}
                <div class="upload-menu">
                    <button type="button" class="menu-item" onclick={onFileUpload}>
                        <Icon name="file" size={18} />
                        <span>File upload</span>
                    </button>
                    <button type="button" class="menu-item" onclick={onFolderUpload}>
                        <Icon name="folderUp" size={18} />
                        <span>Folder upload</span>
                    </button>
                </div>
            {/if}
            <button type="button" class="fab" data-testid="mobile-drive-new-folder" onclick={() => showNewFolder = !showNewFolder}>
                <Icon name="plus" size={24} />
            </button>
            <button type="button" class="fab" data-testid="mobile-drive-upload" onclick={onUpload}>
                <Icon name="upload" size={24} />
            </button>
        </div>
    {/if}

    <input
        type="file"
        multiple
        style="display:none"
        bind:this={fileInput}
        onchange={onFilesSelected}
    />

    <input
        type="file"
        webkitdirectory
        style="display:none"
        bind:this={folderInput}
        onchange={onFolderSelected}
        {...{ directory: '' }}
    />

    {#if driveState.previewItem}
        <DrivePreview item={driveState.previewItem} onClose={closePreview} />
    {/if}
</div>

<style>
    .drive-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        background: var(--bg-base);
    }
    .header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-surface);
    }
    .back-btn {
        background: none;
        border: none;
        color: var(--text-primary);
        padding: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .back-btn:disabled {
        opacity: 0.3;
    }
    .breadcrumbs {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 15px;
        font-weight: 600;
        color: var(--text-primary);
        overflow: hidden;
    }
    .breadcrumbs button {
        background: none;
        border: none;
        color: var(--text-primary);
        font-size: 15px;
        font-weight: 600;
        padding: 0;
        white-space: nowrap;
    }
    .breadcrumbs span {
        color: var(--text-tertiary);
    }

    /* Upload progress indicator */
    .upload-progress {
        padding: 8px 12px;
        background: var(--bg-surface);
        border-bottom: 1px solid var(--border-subtle);
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 120px;
        overflow-y: auto;
    }
    .upload-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        background: var(--bg-base);
        font-size: 12px;
    }
    .upload-row.done {
        background: color-mix(in srgb, var(--success) 10%, var(--bg-base));
    }
    .upload-row.error {
        background: color-mix(in srgb, var(--danger) 10%, var(--bg-base));
    }
    .upload-name {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-primary);
    }
    .upload-status {
        font-weight: 500;
        color: var(--text-secondary);
        white-space: nowrap;
    }
    .upload-row.done .upload-status {
        color: var(--success);
    }
    .upload-row.error .upload-status {
        color: var(--danger);
    }

    .list {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        border-radius: var(--radius-md);
        border: none;
        background: var(--bg-surface);
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
    }
    .row.selected {
        background: var(--accent-soft);
    }
    .info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }
    .name {
        font-size: 14px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .meta {
        font-size: 12px;
        color: var(--text-tertiary);
    }
    .empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: var(--text-secondary);
        text-align: center;
        padding: 24px;
    }
    .loading {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-tertiary);
    }
    .fab-group {
        position: fixed;
        bottom: calc(16px + env(safe-area-inset-bottom, 0px) + 52px);
        right: 16px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        z-index: 10;
    }
    .fab {
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: var(--accent);
        color: #fff;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--shadow-md);
        cursor: pointer;
    }
    .folder-input {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-md);
    }
    .folder-input input {
        flex: 1;
        min-width: 120px;
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        background: var(--bg-base);
        color: var(--text-primary);
        font-size: 14px;
    }
    .btn-primary {
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        border: none;
        background: var(--accent);
        color: #fff;
        font-size: 13px;
        cursor: pointer;
        white-space: nowrap;
    }
    .upload-menu {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-md);
        min-width: 160px;
    }
    .menu-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: var(--radius-sm);
        border: none;
        background: none;
        color: var(--text-primary);
        font-size: 14px;
        cursor: pointer;
        text-align: left;
    }
    .menu-item:hover {
        background: var(--bg-hover);
    }
    .selection-bar {
        position: fixed;
        bottom: calc(16px + env(safe-area-inset-bottom, 0px) + 52px);
        left: 16px;
        right: 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-md);
        z-index: 10;
    }
    .delete-btn {
        background: none;
        border: none;
        color: var(--danger);
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .refresh-btn {
        background: none;
        border: none;
        color: var(--text-primary);
        padding: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-left: auto;
    }
    .pull-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 8px;
        font-size: 13px;
        color: var(--text-secondary);
        background: var(--bg-surface);
        border-bottom: 1px solid var(--border-subtle);
        transition: transform 0.1s ease-out;
    }
    .pull-indicator .ready {
        color: var(--accent);
    }
    .spinner {
        width: 18px;
        height: 18px;
        border: 2px solid var(--border-subtle);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
    }
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
</style>
