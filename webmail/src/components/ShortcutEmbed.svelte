<script lang="ts">
    import Icon from './Icon.svelte';
    import type { Shortcut } from '../lib/api';
    import { safeShortcutUrl, shortcutSandbox } from '../lib/shortcuts-store';

    interface Props {
        shortcut: Shortcut;
        onClose: () => void;
    }
    let { shortcut, onClose }: Props = $props();
    const safeUrl = $derived(safeShortcutUrl(shortcut.url));
</script>

<section class="embed" aria-label={shortcut.title} data-testid={`shortcut-embed-${shortcut.title}`}>
    <header class="bar">
        <div class="title">
            <Icon name={(shortcut.icon as any) || 'plus'} size={16} />
            <strong>{shortcut.title}</strong>
            {#if shortcut.description}
                <span class="muted">{shortcut.description}</span>
            {/if}
        </div>
        <div class="actions">
            {#if safeUrl}
                <a class="btn btn-ghost" href={safeUrl} target="_blank" rel="noopener noreferrer" title="Open in new browser tab">
                    <Icon name="download" size={14} /> Open externally
                </a>
            {/if}
            <button type="button" class="btn btn-ghost" onclick={onClose} title="Back to inbox" data-testid="shortcut-embed-close">
                <Icon name="close" size={14} /> Close
            </button>
        </div>
    </header>
    {#if safeUrl}
        <iframe
            src={safeUrl}
            title={shortcut.title}
            class="frame"
            sandbox={shortcutSandbox(safeUrl)}
            referrerpolicy="no-referrer"
        ></iframe>
    {:else}
        <p class="muted blocked">This shortcut has an unsupported link and cannot be shown.</p>
    {/if}
</section>

<style>
    .embed {
        grid-column: 1 / -1;
        display: flex;
        flex-direction: column;
        background: var(--bg-base);
        min-width: 0;
        min-height: 0;
    }
    .bar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 8px 16px;
        background: var(--bg-surface);
        border-bottom: 1px solid var(--border-subtle);
    }
    .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title strong { font-size: 13px; font-weight: 600; }
    .title .muted { font-size: 12px; }
    .actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    .actions .btn { padding: 6px 10px; font-size: 12.5px; }
    .blocked { margin: 0; padding: 16px; font-size: 13px; }
    .frame {
        flex: 1;
        width: 100%;
        height: 100%;
        border: 0;
        background: var(--bg-surface);
    }
</style>
