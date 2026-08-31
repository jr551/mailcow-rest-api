<script lang="ts">
    import { renderMarkdown } from '../../lib/markdown';
    import Icon from '../Icon.svelte';

    interface Props {
        item: { name: string; path: string };
        initialContent: string;
        onSave: (blob: Blob, filename: string) => void;
        onClose: () => void;
    }

    let { item, initialContent, onSave, onClose }: Props = $props();

    let content = $state(initialContent);
    let tab = $state<'edit' | 'preview'>('edit');
    let saving = $state(false);
    let textareaEl = $state<HTMLTextAreaElement | null>(null);

    const isMarkdown = item.name.toLowerCase().endsWith('.md');

    async function save() {
        if (saving) return;
        saving = true;
        const blob = new Blob([content], { type: isMarkdown ? 'text/markdown' : 'text/plain' });
        await onSave(blob, item.name);
        saving = false;
    }

    function onKeydown(e: KeyboardEvent) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            save();
        }
        if (e.key === 'Escape' && !saving) {
            onClose();
        }
    }

    function insertTab(e: KeyboardEvent) {
        if (e.key === 'Tab') {
            e.preventDefault();
            const el = textareaEl;
            if (!el) return;
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const spaces = '  ';
            content = content.slice(0, start) + spaces + content.slice(end);
            requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + spaces.length;
            });
        }
    }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
        <div class="header">
            <span class="title">Edit {item.name}</span>
            <div class="tabs">
                {#if isMarkdown}
                    <button type="button" class="tab" class:active={tab === 'edit'} onclick={() => tab = 'edit'}>
                        <Icon name="filePen" size={13} /> Edit
                    </button>
                    <button type="button" class="tab" class:active={tab === 'preview'} onclick={() => tab = 'preview'}>
                        <Icon name="eye" size={13} /> Preview
                    </button>
                {/if}
            </div>
            <div class="actions">
                <button type="button" class="btn-primary" onclick={save} disabled={saving}>
                    {#if saving}<span class="spinner"></span>{/if}
                    <Icon name="check" size={14} /> Save
                </button>
                <button type="button" class="btn-ghost" onclick={onClose}>Close</button>
            </div>
        </div>
        <div class="body">
            {#if tab === 'edit'}
                <textarea
                    bind:this={textareaEl}
                    bind:value={content}
                    spellcheck="false"
                    onkeydown={insertTab}
                ></textarea>
            {:else}
                <div class="preview markdown-body">
                    {@html renderMarkdown(content)}
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.75);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        padding: 16px;
    }
    .modal {
        width: 100%;
        max-width: 960px;
        height: 90vh;
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
        gap: 12px;
    }
    .title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }
    .tabs {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 1;
        justify-content: center;
    }
    .tab {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 13px;
        font-weight: 500;
        border-radius: var(--radius-sm);
        border: none;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        transition: background-color 120ms, color 120ms;
    }
    .tab:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    .tab.active {
        background: var(--bg-surface);
        color: var(--text-primary);
        font-weight: 600;
        box-shadow: var(--shadow-sm);
    }
    .actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }
    .btn-primary {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 500;
        border-radius: var(--radius-md);
        border: none;
        background: var(--accent);
        color: #fff;
        cursor: pointer;
        transition: opacity 120ms;
    }
    .btn-primary:hover:not(:disabled) {
        opacity: 0.9;
    }
    .btn-primary:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
    .btn-ghost {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 500;
        border-radius: var(--radius-md);
        border: none;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        transition: background-color 120ms, color 120ms;
    }
    .btn-ghost:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    .body {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        background: var(--bg-base);
    }
    textarea {
        flex: 1;
        width: 100%;
        height: 100%;
        resize: none;
        border: none;
        outline: none;
        padding: 20px 24px;
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 14px;
        line-height: 1.6;
        color: var(--text-primary);
        background: var(--bg-base);
        white-space: pre;
        overflow-wrap: normal;
        overflow-x: auto;
    }
    .preview {
        flex: 1;
        width: 100%;
        overflow-y: auto;
        padding: 24px 32px;
        text-align: left;
    }
    .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 600ms linear infinite;
    }
    @keyframes spin {
        to { transform: rotate(360deg); }
    }

    /* Markdown body styles */
    .markdown-body :global(h1),
    .markdown-body :global(h2),
    .markdown-body :global(h3),
    .markdown-body :global(h4) {
        color: var(--text-primary);
        margin: 16px 0 8px;
        font-weight: 600;
        line-height: 1.3;
    }
    .markdown-body :global(h1) { font-size: 22px; }
    .markdown-body :global(h2) { font-size: 19px; }
    .markdown-body :global(h3) { font-size: 16px; }
    .markdown-body :global(h4) { font-size: 14px; }
    .markdown-body :global(p) {
        color: var(--text-primary);
        margin: 8px 0;
        line-height: 1.6;
    }
    .markdown-body :global(pre) {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 12px;
        overflow-x: auto;
        margin: 8px 0;
    }
    .markdown-body :global(pre code) {
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 13px;
        color: var(--text-primary);
        background: transparent;
        padding: 0;
    }
    .markdown-body :global(code) {
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 13px;
        background: var(--bg-surface);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        color: var(--accent);
    }
    .markdown-body :global(ul),
    .markdown-body :global(ol) {
        margin: 8px 0;
        padding-left: 24px;
        color: var(--text-primary);
    }
    .markdown-body :global(li) {
        margin: 4px 0;
        line-height: 1.5;
    }
    .markdown-body :global(blockquote) {
        border-left: 3px solid var(--accent);
        margin: 8px 0;
        padding: 4px 12px;
        color: var(--text-secondary);
        background: var(--bg-surface);
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    }
    .markdown-body :global(a) {
        color: var(--accent);
        text-decoration: none;
    }
    .markdown-body :global(a:hover) {
        text-decoration: underline;
    }
    .markdown-body :global(hr) {
        border: none;
        border-top: 1px solid var(--border-subtle);
        margin: 16px 0;
    }
    .markdown-body :global(strong) { font-weight: 600; }
    .markdown-body :global(em) { font-style: italic; }
    .markdown-body :global(del) { text-decoration: line-through; }
</style>
