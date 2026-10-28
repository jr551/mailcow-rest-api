<script lang="ts">
    import FloatingPanel from './FloatingPanel.svelte';
    import type { Shortcut } from '../lib/api';
    import { safeShortcutUrl, shortcutSandbox } from '../lib/shortcuts-store';

    interface Props {
        shortcut: Shortcut;
        onClose: () => void;
    }
    let { shortcut, onClose }: Props = $props();
    const safeUrl = $derived(safeShortcutUrl(shortcut.url));
</script>

<FloatingPanel
    title={shortcut.title}
    storageKey={`shortcut.${shortcut.url}`}
    defaultWidth={900}
    defaultHeight={620}
    minWidth={420}
    minHeight={320}
    onClose={onClose}
    testId={`shortcut-popup-${shortcut.title}`}
>
    {#if safeUrl}
        <iframe
            src={safeUrl}
            title={shortcut.title}
            class="shortcut-frame"
            sandbox={shortcutSandbox(safeUrl)}
            referrerpolicy="no-referrer"
        ></iframe>
    {:else}
        <p class="muted blocked">This shortcut has an unsupported link and cannot be shown.</p>
    {/if}
</FloatingPanel>

<style>
    .blocked { margin: 0; padding: 16px; font-size: 13px; }
    .shortcut-frame {
        flex: 1;
        width: 100%;
        height: 100%;
        border: 0;
        background: var(--bg-base);
    }
</style>
