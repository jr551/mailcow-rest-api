<script lang="ts">
    import { driveState, toggleSelect, navigateTo, openDrawingEditor, isImage, type DriveItem } from '../../lib/drive.svelte';
    import { getObjectUrl, fetchBlob } from '../../lib/drive-api';
    import { authState } from '../../lib/auth.svelte';
    import * as cache from '../../lib/drive-cache';
    import Icon from '../Icon.svelte';
    import type { IconName } from '../../lib/icons';

    interface Props {
        item: DriveItem;
        onPreview?: (item: DriveItem) => void;
        onContextMenu?: (e: MouseEvent, item: DriveItem) => void;
    }
    let { item, onPreview, onContextMenu }: Props = $props();

    let thumbUrl = $state<string | null>(null);
    let loadingThumb = $state(false);

    const selected = $derived(driveState.selected.has(item.path));

    function iconForItem(): IconName {
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

    function iconColorClass(): string {
        if (item.isFolder) return 'cat-folder';
        const ext = item.name.split('.').pop()?.toLowerCase();
        if (['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext || '')) return 'cat-image';
        if (['mp4','webm','mov','avi','mkv','flv'].includes(ext || '')) return 'cat-video';
        if (['mp3','wav','flac','aac','ogg','m4a','wma'].includes(ext || '')) return 'cat-audio';
        if (['pdf'].includes(ext || '')) return 'cat-doc';
        if (['xls','xlsx','csv','ods'].includes(ext || '')) return 'cat-sheet';
        if (['doc','docx','odt'].includes(ext || '')) return 'cat-doc';
        if (['ppt','pptx','odp'].includes(ext || '')) return 'cat-slide';
        if (['zip','tar','gz','bz2','rar','7z'].includes(ext || '')) return 'cat-archive';
        if (['js','ts','jsx','tsx','py','rb','go','java','c','cpp','h','rs','php','swift','kt','scala','r','pl','sh','json','xml','yaml','yml','html','htm','css','scss','sass','less','sql','db','sqlite','sqlite3'].includes(ext || '')) return 'cat-code';
        if (['tldr'].includes(ext || '')) return 'cat-draw';
        return 'cat-generic';
    }

    async function loadThumb() {
        if (!isImage(item) || thumbUrl) return;
        const user = authState.activeUser;
        if (!user) return;
        const cached = await cache.getThumb(user, item.etag);
        if (cached) {
            thumbUrl = cached;
            return;
        }
        loadingThumb = true;
        try {
            const blob = await fetchBlob(item.path);
            const url = URL.createObjectURL(blob);
            // Generate a small thumbnail via canvas
            const img = new Image();
            img.src = url;
            await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject();
            });
            const canvas = document.createElement('canvas');
            const MAX = 200;
            const ratio = Math.min(MAX / img.naturalWidth, MAX / img.naturalHeight, 1);
            canvas.width = img.naturalWidth * ratio;
            canvas.height = img.naturalHeight * ratio;
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            thumbUrl = dataUrl;
            await cache.putThumb(user, item.etag, dataUrl);
            URL.revokeObjectURL(url);
        } catch {
            // fall back to icon
        } finally {
            loadingThumb = false;
        }
    }

    $effect(() => {
        if (driveState.view === 'grid' && isImage(item)) {
            loadThumb();
        }
    });

    function isPreviewable(): boolean {
        const name = item.name.toLowerCase();
        const ext = name.split('.').pop() || '';
        if (['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext)) return true;
        if (['mp4','webm','mov','avi','mkv','flv'].includes(ext)) return true;
        if (['mp3','wav','flac','aac','ogg','m4a','wma'].includes(ext)) return true;
        if (ext === 'pdf') return true;
        if (['doc','docx','odt','xls','xlsx','csv','ods','ppt','pptx','odp'].includes(ext)) return true;
        if (ext === 'tldr') return true;
        if (ext === 'md') return true;
        if ([
            'txt', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'java',
            'c', 'cpp', 'h', 'rs', 'php', 'swift', 'kt', 'scala', 'r', 'pl',
            'sql', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'html', 'htm', 'css',
            'scss', 'sass', 'less', 'xml', 'log', 'csv', 'ini', 'toml', 'conf'
        ].includes(ext)) return true;
        return false;
    }

    async function onClick(_e: MouseEvent | KeyboardEvent) {
        if (item.isFolder) {
            navigateTo(item.path);
        } else if (item.name.toLowerCase().endsWith('.tldr')) {
            openDrawingEditor(item.path);
        } else if (isPreviewable() && onPreview) {
            onPreview(item);
        } else {
            const url = await getObjectUrl(item.path);
            window.open(url, '_blank');
        }
    }

    function onToggleSelect(e: MouseEvent) {
        e.stopPropagation();
        toggleSelect(item.path);
    }

    function formatSize(bytes: number): string {
        if (bytes === 0) return '';
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
    }

    function formatDate(iso: string): string {
        if (!iso) return '';
        const d = new Date(iso);
        return d.toLocaleDateString();
    }
</script>

{#if driveState.view === 'grid'}
    <div
        class="card"
        class:selected
        onclick={onClick}
        ondblclick={onClick}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }}
        oncontextmenu={(e) => onContextMenu?.(e, item)}
        role="button"
        tabindex="0"
        data-testid="drive-item-{item.name}"
    >
        <div class="preview {iconColorClass()}">
            {#if item.isFolder}
                <Icon name="folderOpen" size={48} />
            {:else if thumbUrl}
                <img src={thumbUrl} alt={item.name} loading="lazy" />
            {:else}
                <Icon name={iconForItem()} size={48} />
            {/if}
        </div>
        <div class="meta">
            <input
                type="checkbox"
                checked={selected}
                onclick={onToggleSelect}
                aria-label="Select {item.name}"
            />
            <span class="name" title={item.name}>{item.name}</span>
            <span class="size">{formatSize(item.size)}</span>
        </div>
    </div>
{:else}
    <tr class="row" class:selected data-testid="drive-item-{item.name}" oncontextmenu={(e) => onContextMenu?.(e, item)}
    >
        <td class="cell-check">
            <input
                type="checkbox"
                checked={selected}
                onclick={onToggleSelect}
                aria-label="Select {item.name}"
            />
        </td>
        <td class="cell-icon {iconColorClass()}">
            <Icon name={iconForItem()} size={18} />
        </td>
        <td class="cell-name" onclick={onClick} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }} role="button" tabindex="0"
        >
            {item.name}
        </td>
        <td class="cell-size">{formatSize(item.size)}</td>
        <td class="cell-date">{formatDate(item.lastModified)}</td>
    </tr>
{/if}

<style>
    .card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 12px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-subtle);
        background: var(--bg-surface);
        cursor: pointer;
        transition: background-color var(--transition-fast), box-shadow var(--transition-fast);
        position: relative;
    }
    .card:hover {
        background: var(--bg-hover);
        box-shadow: var(--shadow-sm);
    }
    .card.selected {
        border-color: var(--accent);
        background: var(--accent-soft);
    }
    .preview {
        width: 100%;
        aspect-ratio: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        overflow: hidden;
        background: var(--bg-base);
    }
    .preview img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .meta {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
    }
    .name {
        flex: 1;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .size {
        font-size: 11px;
        color: var(--text-tertiary);
        white-space: nowrap;
    }

    .row {
        cursor: pointer;
        transition: background-color var(--transition-fast);
    }
    .row:hover {
        background: var(--bg-hover);
    }
    .row.selected {
        background: var(--accent-soft);
    }
    .cell-check {
        width: 32px;
        padding: 8px 4px;
    }
    .cell-icon {
        width: 28px;
        padding: 8px 4px;
        color: var(--text-tertiary);
    }
    .cell-name {
        padding: 8px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 300px;
    }
    .cell-size {
        padding: 8px;
        font-size: 12px;
        color: var(--text-secondary);
        white-space: nowrap;
        text-align: right;
    }
    .cell-date {
        padding: 8px;
        font-size: 12px;
        color: var(--text-secondary);
        white-space: nowrap;
    }

    /* Category tint colors for file type icons */
    .preview.cat-image    { background: color-mix(in srgb, #f43f5e 12%, var(--bg-base)); color: #e11d48; }
    .preview.cat-video    { background: color-mix(in srgb, #8b5cf6 12%, var(--bg-base)); color: #7c3aed; }
    .preview.cat-audio    { background: color-mix(in srgb, #f59e0b 12%, var(--bg-base)); color: #d97706; }
    .preview.cat-doc      { background: color-mix(in srgb, #3b82f6 12%, var(--bg-base)); color: #2563eb; }
    .preview.cat-sheet    { background: color-mix(in srgb, #10b981 12%, var(--bg-base)); color: #059669; }
    .preview.cat-slide    { background: color-mix(in srgb, #f97316 12%, var(--bg-base)); color: #ea580c; }
    .preview.cat-archive  { background: color-mix(in srgb, #78716c 12%, var(--bg-base)); color: #57534e; }
    .preview.cat-code     { background: color-mix(in srgb, #64748b 12%, var(--bg-base)); color: #475569; }
    .preview.cat-draw     { background: color-mix(in srgb, #ec4899 12%, var(--bg-base)); color: #db2777; }
    .preview.cat-generic  { background: var(--bg-base); color: var(--text-tertiary); }
    .preview.cat-folder   { background: color-mix(in srgb, #eab308 12%, var(--bg-base)); color: #ca8a04; }

    .cell-icon.cat-image    { color: #e11d48; }
    .cell-icon.cat-video    { color: #7c3aed; }
    .cell-icon.cat-audio    { color: #d97706; }
    .cell-icon.cat-doc      { color: #2563eb; }
    .cell-icon.cat-sheet    { color: #059669; }
    .cell-icon.cat-slide    { color: #ea580c; }
    .cell-icon.cat-archive  { color: #57534e; }
    .cell-icon.cat-code     { color: #475569; }
    .cell-icon.cat-draw     { color: #db2777; }
    .cell-icon.cat-generic  { color: var(--text-tertiary); }
    .cell-icon.cat-folder   { color: #ca8a04; }
</style>
