<script lang="ts">
    import FloatingPanel from './FloatingPanel.svelte';
    import type { Shortcut } from '../lib/api';

    interface Props {
        shortcut: Shortcut;
        onClose: () => void;
    }
    let { shortcut, onClose }: Props = $props();
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
    <iframe
        src={shortcut.url}
        title={shortcut.title}
        class="shortcut-frame"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
    ></iframe>
</FloatingPanel>

<style>
    .shortcut-frame {
        flex: 1;
        width: 100%;
        height: 100%;
        border: 0;
        background: var(--bg-base);
    }
</style>
