<script lang="ts">
    import { MOBILE_MAIL_KEYBOARD_SHORTCUT_ROWS } from '../../lib/mobile-mail-keyboard-shortcuts';
    import { trapFocus } from '../../lib/focus-trap';
    import { pushOverlay } from '../lib/store.svelte';
    import { onMount } from 'svelte';

    interface Props {
        open: boolean;
        onClose: () => void;
    }
    let { open, onClose }: Props = $props();

    let sheetEl: HTMLDivElement | null = $state(null);
    let disposeOverlay: (() => void) | null = null;

    $effect(() => {
        if (!open || !sheetEl) return;
        return trapFocus(sheetEl, true);
    });

    $effect(() => {
        if (!open) {
            if (disposeOverlay) {
                disposeOverlay();
                disposeOverlay = null;
            }
            return;
        }
        if (!disposeOverlay) {
            disposeOverlay = pushOverlay('mobile-mail-shortcut-help', onClose);
        }
    });

    onMount(() => () => {
        if (disposeOverlay) disposeOverlay();
    });

    function onKey(e: KeyboardEvent) {
        if (!open) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
    <div class="backdrop" data-testid="mobile-mail-shortcut-help-backdrop" onclick={onClose} aria-hidden="true"></div>
    <div
        bind:this={sheetEl}
        class="sheet fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-mail-shortcut-help-title"
        data-testid="mobile-mail-shortcut-help"
    >
        <div class="grab" aria-hidden="true"></div>
        <header class="hdr">
            <h2 id="mobile-mail-shortcut-help-title">Keyboard shortcuts</h2>
            <button type="button" class="close" aria-label="Close" data-testid="mobile-mail-shortcut-help-close" onclick={onClose}>
                ×
            </button>
        </header>
        <p class="muted small">
            For tablet or phone with an external keyboard. Shortcuts are ignored while you type in a field.
        </p>
        <table class="grid">
            <thead>
                <tr><th scope="col">Keys</th><th scope="col">Action</th></tr>
            </thead>
            <tbody>
                {#each MOBILE_MAIL_KEYBOARD_SHORTCUT_ROWS as row}
                    <tr>
                        <td><kbd>{row.keys}</kbd></td>
                        <td>{row.description}</td>
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
{/if}

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 9500;
    }
    .sheet {
        position: fixed;
        z-index: 9501;
        left: 0;
        right: 0;
        bottom: 0;
        max-height: min(85vh, 640px);
        overflow: auto;
        background: var(--bg-elevated, var(--bg-base));
        border-radius: 16px 16px 0 0;
        box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
        padding: 8px 20px calc(20px + env(safe-area-inset-bottom, 0));
    }
    .grab {
        width: 36px;
        height: 4px;
        border-radius: 2px;
        background: var(--border);
        margin: 4px auto 12px;
    }
    .hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
    }
    h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
    }
    .close {
        border: 0;
        background: transparent;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
        color: var(--text-muted);
        padding: 4px 8px;
        border-radius: 4px;
    }
    .close:hover { background: var(--bg-hover); color: var(--text); }
    .grid {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        margin-top: 12px;
    }
    th, td {
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px solid var(--border-subtle, var(--border));
        vertical-align: top;
    }
    th { font-weight: 600; color: var(--text-muted); }
    kbd {
        font-family: ui-monospace, monospace;
        font-size: 12px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--bg-base);
        border: 1px solid var(--border);
        white-space: nowrap;
    }
</style>
