<script lang="ts">
    import { getObjectUrl } from '../../lib/drive-api';
    import Icon from '../Icon.svelte';

    interface Props {
        path: string;
        onClose: () => void;
    }
    let { path, onClose }: Props = $props();

    let url = $state('');
    $effect(() => {
        getObjectUrl(path).then((u) => { url = u; });
    });
</script>

<div class="preview-overlay" onclick={onClose} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}>
    <div class="preview-modal" onclick={(e) => e.stopPropagation()}>
        <div class="preview-header">
            <span class="preview-title">{path.split('/').pop()}</span>
            <button type="button" class="preview-close" onclick={onClose}>
                <Icon name="close" size={20} />
            </button>
        </div>
        <iframe src={url} title={path}></iframe>
    </div>
</div>

<style>
    .preview-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        padding: 16px;
    }
    .preview-modal {
        width: 100%;
        max-width: 900px;
        height: 90vh;
        background: var(--bg-surface);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-xl);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .preview-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-base);
    }
    .preview-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .preview-close {
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
    }
    .preview-close:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    iframe {
        flex: 1;
        border: none;
        width: 100%;
        background: #fff;
    }
</style>
