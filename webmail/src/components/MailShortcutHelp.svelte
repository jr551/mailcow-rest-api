<script lang="ts">
    import { MAIL_KEYBOARD_SHORTCUT_ROWS } from '../lib/mail-keyboard-shortcuts';
    import { trapFocus } from '../lib/focus-trap';

    interface Props {
        open: boolean;
        onClose: () => void;
    }
    let { open, onClose }: Props = $props();

    let dialogEl: HTMLDivElement | null = $state(null);

    $effect(() => {
        if (!open || !dialogEl) return;
        return trapFocus(dialogEl, true);
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
    <div class="backdrop" data-testid="mail-shortcut-help-backdrop" onclick={onClose} aria-hidden="true"></div>
    <div
        bind:this={dialogEl}
        class="dialog fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-shortcut-help-title"
        data-testid="mail-shortcut-help"
    >
        <header class="hdr">
            <h2 id="mail-shortcut-help-title">Keyboard shortcuts</h2>
            <button type="button" class="close" aria-label="Close" data-testid="mail-shortcut-help-close" onclick={onClose}>
                ×
            </button>
        </header>
        <p class="muted small">Available while viewing mail (not when typing in a field). Matches Outlook on the web where possible.</p>
        <table class="grid">
            <thead>
                <tr><th scope="col">Keys</th><th scope="col">Action</th></tr>
            </thead>
            <tbody>
                {#each MAIL_KEYBOARD_SHORTCUT_ROWS as row}
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
        background: rgba(0, 0, 0, 0.35);
        z-index: 9000;
    }
    .dialog {
        position: fixed;
        z-index: 9001;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: min(520px, calc(100vw - 32px));
        max-height: min(80vh, 640px);
        overflow: auto;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.2));
        padding: 16px 20px 20px;
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
