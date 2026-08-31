<script lang="ts">
    import { driveState, setView, loadPath, createFolder, createDrawing, deleteSelected, breadcrumbParts, navigateTo } from '../../lib/drive.svelte';
    import { showToast } from '../../lib/store.svelte';
    import DriveQuota from './DriveQuota.svelte';
    import Icon from '../Icon.svelte';

    let newFolderName = $state('');
    let newDrawingName = $state('');
    let showNewFolder = $state(false);
    let fileInput: HTMLInputElement | undefined = $state();

    function onUploadClick() {
        fileInput?.click();
    }

    function onFilesSelected(e: Event) {
        const files = (e.target as HTMLInputElement).files;
        if (files && files.length > 0) {
            import('../../lib/drive.svelte').then((m) => m.uploadFiles(Array.from(files)));
        }
        if (fileInput) fileInput.value = '';
    }

    function onCreateFolder() {
        const name = newFolderName.trim();
        if (!name) return;
        createFolder(name);
        newFolderName = '';
        showNewFolder = false;
    }

    function onCreateDrawing() {
        const name = newDrawingName.trim();
        if (!name) return;
        createDrawing(name);
        newDrawingName = '';
        showNewFolder = false;
    }

    const crumbs = $derived(breadcrumbParts(driveState.currentPath));
</script>

<div class="toolbar" data-testid="drive-toolbar">
    <div class="left">
        <button
            type="button"
            class="btn-icon"
            title="Go up"
            disabled={!driveState.currentPath}
            onclick={() => {
                const parts = driveState.currentPath.split('/');
                parts.pop();
                navigateTo(parts.join('/'));
            }}
        >
            <Icon name="chevronLeft" size={18} />
        </button>

        <nav class="breadcrumbs" aria-label="Breadcrumbs">
            <button type="button" class="crumb" onclick={() => navigateTo('')}>Drive</button>
            {#each crumbs as crumb}
                <span class="sep">/</span>
                <button type="button" class="crumb" onclick={() => navigateTo(crumb.path)}>
                    {crumb.name}
                </button>
            {/each}
        </nav>
    </div>

    <div class="center">
        <DriveQuota />
        {#if driveState.selected.size > 0}
            <span class="selection-hint">{driveState.selected.size} selected</span>
            <button type="button" class="btn danger" onclick={deleteSelected}>
                <Icon name="trash" size={16} />
                Delete
            </button>
        {/if}
    </div>

    <div class="right">
        <div class="dropdown">
            <button type="button" class="btn" onclick={() => showNewFolder = !showNewFolder}>
                <Icon name="plus" size={16} />
                New
            </button>
            {#if showNewFolder}
                <div class="menu">
                    <!-- Each field/button pair is its own labelled group. Both
                         buttons used to be announced as just "Create", so
                         without the visual layout there was no way to tell
                         which one made a folder and which made a drawing. -->
                    <div class="menu-row" role="group" aria-labelledby="drive-new-folder-label">
                        <label id="drive-new-folder-label" class="sr-only" for="drive-new-folder-name">Folder name</label>
                        <input
                            id="drive-new-folder-name"
                            type="text"
                            placeholder="Folder name"
                            bind:value={newFolderName}
                            onkeydown={(e) => e.key === 'Enter' && onCreateFolder()}
                        />
                        <button type="button" class="btn primary" onclick={onCreateFolder} aria-label="Create folder">Create</button>
                    </div>
                    <div class="menu-row" role="group" aria-labelledby="drive-new-drawing-label">
                        <label id="drive-new-drawing-label" class="sr-only" for="drive-new-drawing-name">Drawing name</label>
                        <input
                            id="drive-new-drawing-name"
                            type="text"
                            placeholder="Drawing name"
                            bind:value={newDrawingName}
                            onkeydown={(e) => e.key === 'Enter' && onCreateDrawing()}
                        />
                        <button type="button" class="btn primary" onclick={onCreateDrawing} aria-label="Create drawing">Create</button>
                    </div>
                    <button type="button" class="menu-item" onclick={() => { showNewFolder = false; onUploadClick(); }}>
                        <Icon name="upload" size={16} />
                        File upload
                    </button>
                </div>
            {/if}
        </div>

        <input
            type="file"
            multiple
            style="display:none"
            bind:this={fileInput}
            onchange={onFilesSelected}
        />

        <button
            type="button"
            class="btn-icon"
            title="Refresh"
            aria-label="Refresh"
            disabled={driveState.itemsLoading}
            onclick={() => {
                loadPath(driveState.currentPath || '');
                showToast('info', 'Refreshing…');
            }}
            data-testid="drive-refresh-btn"
        >
            <Icon name="refresh" size={18} />
        </button>
        <button
            type="button"
            class="btn-icon"
            class:active={driveState.view === 'grid'}
            title="Grid view"
            onclick={() => setView('grid')}
        >
            <Icon name="grid" size={18} />
        </button>
        <button
            type="button"
            class="btn-icon"
            class:active={driveState.view === 'list'}
            title="List view"
            onclick={() => setView('list')}
        >
            <Icon name="listView" size={18} />
        </button>
    </div>
</div>

<style>
    .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-surface);
        min-height: 48px;
    }
    .left {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        min-width: 0;
    }
    .center {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .right {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .breadcrumbs {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 13px;
        color: var(--text-secondary);
        overflow: hidden;
    }
    .crumb {
        background: none;
        border: none;
        color: var(--text-primary);
        font-size: 13px;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: var(--radius-sm);
        white-space: nowrap;
    }
    .crumb:hover {
        background: var(--bg-hover);
    }
    .sep {
        color: var(--text-tertiary);
    }
    .btn-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: var(--radius-sm);
        border: none;
        background: none;
        color: var(--text-secondary);
        cursor: pointer;
        transition: background-color var(--transition-fast);
    }
    .btn-icon:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    .btn-icon.active {
        background: var(--accent-soft);
        color: var(--accent-text);
    }
    .btn-icon:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
    .btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        background: var(--bg-base);
        color: var(--text-primary);
        font-size: 13px;
        cursor: pointer;
        transition: background-color var(--transition-fast);
    }
    .btn:hover {
        background: var(--bg-hover);
    }
    .btn.primary {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
    }
    .btn.danger {
        color: var(--danger);
        border-color: var(--danger-soft);
        background: var(--danger-soft);
    }
    .dropdown {
        position: relative;
    }
    .menu {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 180px;
        z-index: 10;
    }
    .menu-row {
        display: flex;
        gap: 6px;
        padding: 4px;
    }
    .menu-row input {
        flex: 1;
        padding: 4px 8px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        background: var(--bg-base);
        color: var(--text-primary);
        font-size: 13px;
    }
    .menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: var(--radius-sm);
        border: none;
        background: none;
        color: var(--text-primary);
        font-size: 13px;
        cursor: pointer;
        text-align: left;
    }
    .menu-item:hover {
        background: var(--bg-hover);
    }
    .selection-hint {
        font-size: 12px;
        color: var(--text-secondary);
    }
</style>
