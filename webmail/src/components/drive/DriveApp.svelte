<script lang="ts">
    import { onMount } from 'svelte';
    import {
        driveState, loadDriveConfig, loadPath, closePreview, closeDrawingEditor,
        saveDrawing, closeTextEditor, saveTextFile, openTextEditor, openDrawingEditor,
        navigateTo, renameItem, deleteItem
    } from '../../lib/drive.svelte';
    import { getObjectUrl } from '../../lib/drive-api';
    import { showToast } from '../../lib/store.svelte';
    import { capabilities } from '../../lib/settings.svelte';
    import DriveToolbar from './DriveToolbar.svelte';
    import DriveGrid from './DriveGrid.svelte';
    import DriveList from './DriveList.svelte';
    import DriveUploadZone from './DriveUploadZone.svelte';
    import DrivePreview from './DrivePreview.svelte';
    import TextEditor from '../editor/TextEditor.svelte';
    import Icon from '../Icon.svelte';
    import type { DriveItem } from '../../lib/drive-api';

    onMount(() => {
        loadDriveConfig().then(() => {
            if (driveState.config?.enabled) {
                loadPath(driveState.currentPath || '');
            }
        });
    });

    function onKeydown(e: KeyboardEvent) {
        const t = e.target as HTMLElement;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
        if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            import('../../lib/drive.svelte').then((m) => m.setView('grid'));
        }
        if (e.key === 'l' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            import('../../lib/drive.svelte').then((m) => m.setView('list'));
        }
    }

    // ---- Context menu ----------------------------------------
    let ctxMenu = $state<{ item: DriveItem; x: number; y: number } | null>(null);

    function openCtxMenu(e: MouseEvent, item: DriveItem) {
        e.preventDefault();
        e.stopPropagation();
        let x = e.clientX;
        let y = e.clientY;
        const menuWidth = 200;
        const menuHeight = 320;
        if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
        if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;
        ctxMenu = { item, x, y };
    }

    function closeCtxMenu() {
        ctxMenu = null;
    }

    function isEditable(name: string): boolean {
        const lower = name.toLowerCase();
        return lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.tldr');
    }

    function ctxOpen(item: DriveItem) {
        if (item.isFolder) {
            navigateTo(item.path);
        } else {
            import('../../lib/drive.svelte').then((m) => m.openPreview(item));
        }
        closeCtxMenu();
    }

    function ctxEdit(item: DriveItem) {
        const lower = item.name.toLowerCase();
        if (lower.endsWith('.tldr')) {
            openDrawingEditor(item.path);
        } else if (lower.endsWith('.md') || lower.endsWith('.txt')) {
            openTextEditor(item.path);
        }
        closeCtxMenu();
    }

    async function ctxDownload(item: DriveItem) {
        try {
            const url = await getObjectUrl(item.path);
            const a = document.createElement('a');
            a.href = url;
            a.download = item.name;
            a.click();
        } catch (e) {
            showToast('error', 'Failed to get download link');
        }
        closeCtxMenu();
    }

    async function ctxCopyLink(item: DriveItem) {
        try {
            const url = await getObjectUrl(item.path);
            await navigator.clipboard.writeText(url);
            showToast('success', 'Link copied to clipboard');
        } catch {
            showToast('error', 'Failed to copy link');
        }
        closeCtxMenu();
    }

    async function ctxRename(item: DriveItem) {
        const newName = prompt('Rename to:', item.name);
        if (newName && newName !== item.name) {
            await renameItem(item.path, newName);
        }
        closeCtxMenu();
    }

    async function ctxDelete(item: DriveItem) {
        if (!confirm(`Delete "${item.name}"?`)) return;
        await deleteItem(item.path, item.isFolder);
        closeCtxMenu();
    }

    function fmtBytes(bytes: number): string {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        const val = bytes / Math.pow(1024, i);
        return `${val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
    }

    function fmtSpeed(bps: number): string {
        if (!Number.isFinite(bps) || bps <= 0) return '— /s';
        return `${fmtBytes(bps)}/s`;
    }
</script>

<svelte:window onkeydown={onKeydown} onclick={closeCtxMenu} oncontextmenu={(e) => { if (ctxMenu && !(e.target as HTMLElement)?.closest?.('.ctx-menu')) closeCtxMenu(); }} />

<div class="drive-app" data-testid="drive-app">
    <DriveUploadZone />
    <DriveToolbar />

    {#if !driveState.config?.enabled && !driveState.configLoading}
        <div class="empty">
            <Icon name="drive" size={48} />
            <p>Drive is not configured</p>
            <span class="hint">Ask your administrator to enable S3_DRIVE_ENABLED.</span>
        </div>
    {:else if driveState.itemsLoading && driveState.items.length === 0}
        <div class="skeleton">
            {#each Array(12) as _, i}
                <div class="skeleton-card">
                    <div class="skeleton-thumb"></div>
                    <div class="skeleton-text"></div>
                </div>
            {/each}
        </div>
    {:else if driveState.itemsError && driveState.items.length === 0}
        <div class="empty">
            <Icon name="info" size={40} />
            <p>{driveState.itemsError}</p>
        </div>
    {:else if driveState.items.length === 0}
        <div class="empty">
            <Icon name="folderOpen" size={48} />
            <p>This folder is empty</p>
            <span class="hint">Drag and drop files here to upload</span>
        </div>
    {:else if driveState.view === 'grid'}
        <DriveGrid onPreview={(item) => driveState.previewItem = item} onContextMenu={openCtxMenu} />
    {:else}
        <DriveList onPreview={(item) => driveState.previewItem = item} onContextMenu={openCtxMenu} />
    {/if}

    {#if driveState.uploads.length > 0}
        <div class="upload-tray">
            {#each driveState.uploads as u (u.name)}
                {@const pct = Math.round(u.progress)}
                <div class="upload-row" class:error={!!u.error} class:done={u.done && !u.error}>
                    <div class="upload-meta">
                        <span class="upload-name" title={u.name}>{u.name}</span>
                        <span class="upload-status">
                            {#if u.error}
                                {u.error.length > 60 ? u.error.slice(0, 60) + '…' : u.error}
                            {:else if u.done}
                                Done · {fmtBytes(u.total)}
                            {:else}
                                {fmtBytes(u.loaded)} / {fmtBytes(u.total)} · {fmtSpeed(u.speedBps)} · {pct}%
                            {/if}
                        </span>
                    </div>
                    <div class="upload-bar" aria-hidden={u.error ? 'true' : null}>
                        <div class="upload-bar-fill" style={`width: ${pct}%;`}></div>
                    </div>
                </div>
            {/each}
        </div>
    {/if}

    {#if driveState.previewItem}
        <DrivePreview
            item={driveState.previewItem}
            onClose={closePreview}
            onEdit={(item) => { openTextEditor(item.path); closePreview(); }}
        />
    {/if}

    {#if driveState.drawingEditor}
        {#await import('../editor/TldrawPad.svelte') then mod}
            <mod.default
                mode={driveState.drawingEditor.mode}
                defaultName={driveState.drawingEditor.path.split('/').pop() || 'drawing.tldr'}
                initialSnapshot={driveState.drawingEditor.initialSnapshot}
                onSave={saveDrawing}
                onCancel={closeDrawingEditor}
            />
        {/await}
    {/if}

    {#if driveState.textEditor}
        <TextEditor
            item={driveState.textEditor.item}
            initialContent={driveState.textEditor.content}
            onSave={saveTextFile}
            onClose={closeTextEditor}
        />
    {/if}

    {#if ctxMenu}
        <ul class="ctx-menu" role="menu" style={`top: ${ctxMenu.y}px; left: ${ctxMenu.x}px;`}>
            <li><button type="button" role="menuitem" onclick={() => ctxOpen(ctxMenu!.item)}><Icon name="eye" size={14} /> Open</button></li>
            {#if !ctxMenu.item.isFolder && isEditable(ctxMenu.item.name)}
                <li><button type="button" role="menuitem" onclick={() => ctxEdit(ctxMenu!.item)}><Icon name="filePen" size={14} /> Edit</button></li>
            {/if}
            <li class="sep"></li>
            <li><button type="button" role="menuitem" onclick={() => ctxDownload(ctxMenu!.item)}><Icon name="download" size={14} /> Download</button></li>
            <li><button type="button" role="menuitem" onclick={() => ctxCopyLink(ctxMenu!.item)}><Icon name="copy" size={14} /> Copy link</button></li>
            <li class="sep"></li>
            <li><button type="button" role="menuitem" onclick={() => ctxRename(ctxMenu!.item)}><Icon name="type" size={14} /> Rename</button></li>
            <li><button type="button" role="menuitem" class="danger" onclick={() => ctxDelete(ctxMenu!.item)}><Icon name="trash" size={14} /> Delete</button></li>
        </ul>
    {/if}
</div>

<style>
    .drive-app {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        background: var(--bg-base);
    }
    .skeleton {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 12px;
        padding: 12px;
        overflow-y: auto;
    }
    .skeleton-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-subtle);
        background: var(--bg-surface);
    }
    .skeleton-thumb {
        width: 100%;
        aspect-ratio: 1;
        border-radius: var(--radius-sm);
        background: var(--bg-hover);
        animation: pulse 1.5s infinite;
    }
    .skeleton-text {
        height: 16px;
        width: 70%;
        border-radius: var(--radius-sm);
        background: var(--bg-hover);
        animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
        0% { opacity: 1; }
        50% { opacity: 0.5; }
        100% { opacity: 1; }
    }
    .empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        color: var(--text-secondary);
        text-align: center;
        padding: 24px;
    }
    .empty p {
        margin: 0;
        font-size: 16px;
        font-weight: 500;
        color: var(--text-primary);
    }
    .hint {
        font-size: 13px;
        color: var(--text-tertiary);
    }
    .upload-tray {
        position: fixed;
        bottom: 16px;
        right: 16px;
        width: 320px;
        max-width: calc(100vw - 32px);
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 50;
        padding-bottom: calc(10px + env(safe-area-inset-bottom));
    }
    .upload-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px;
        border-radius: var(--radius-sm);
        font-size: 12px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
    }
    .upload-row.error {
        background: var(--danger-soft);
        border-color: color-mix(in srgb, var(--danger) 35%, var(--border-subtle));
        color: var(--danger);
    }
    .upload-row.done { border-color: color-mix(in srgb, var(--success, #16a34a) 30%, var(--border-subtle)); }
    .upload-meta {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
    }
    .upload-name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-weight: 600;
        flex: 1;
        min-width: 0;
    }
    .upload-status {
        font-weight: 500;
        white-space: nowrap;
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
        font-size: 11.5px;
    }
    .upload-bar {
        position: relative;
        height: 4px;
        background: var(--bg-base);
        border-radius: 999px;
        overflow: hidden;
    }
    .upload-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #d268f4));
        transition: width 200ms ease-out;
        border-radius: 999px;
    }
    .upload-row.done .upload-bar-fill { background: var(--success, #16a34a); }
    .upload-row.error .upload-bar-fill { background: var(--danger); }

    /* Context menu */
    .ctx-menu {
        position: fixed;
        list-style: none;
        margin: 0;
        padding: 4px;
        min-width: 180px;
        max-height: 70vh;
        overflow-y: auto;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 200;
        animation: fade-in 120ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .ctx-menu li { list-style: none; }
    .ctx-menu li.sep { height: 1px; margin: 4px 0; background: var(--border-subtle); }
    .ctx-menu button {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 10px;
        font-size: 12.5px;
        text-align: left;
        border-radius: var(--radius-xs);
        color: var(--text-primary);
        background: none;
        border: none;
        cursor: pointer;
    }
    .ctx-menu button:hover { background: var(--bg-hover); }
    .ctx-menu button.danger { color: var(--danger); }
    .ctx-menu button.danger:hover { background: var(--danger-soft); }
    @keyframes fade-in {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
    }
</style>
