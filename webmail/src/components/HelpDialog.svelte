<script lang="ts">
    import { onMount } from 'svelte';
    import { trapFocus } from '../lib/focus-trap';
    import Icon from './Icon.svelte';

    interface Props {
        onClose: () => void;
    }
    let { onClose }: Props = $props();

    let dialogEl: HTMLDivElement | undefined = $state();
    onMount(() => {
        if (dialogEl) return trapFocus(dialogEl);
    });

    const groups: { title: string; rows: { keys: string[]; label: string }[] }[] = [
        {
            title: 'Navigate',
            rows: [
                { keys: ['j'], label: 'Next message' },
                { keys: ['k'], label: 'Previous message' },
                { keys: ['Enter'], label: 'Open selected message' },
                { keys: ['Esc'], label: 'Close panel / clear selection' },
                { keys: ['/'], label: 'Focus search' }
            ]
        },
        {
            title: 'Act on this message',
            rows: [
                { keys: ['s'], label: 'Star / unstar' },
                { keys: ['u'], label: 'Toggle read / unread' },
                { keys: ['e'], label: 'Archive' },
                { keys: ['#'], label: 'Move to Trash' },
                { keys: ['x'], label: 'Toggle in selection' },
                { keys: ['z'], label: 'Undo last action' }
            ]
        },
        {
            title: 'Compose',
            rows: [
                { keys: ['c'], label: 'New message' },
                { keys: ['r'], label: 'Reply' },
                { keys: ['a'], label: 'Reply all' },
                { keys: ['f'], label: 'Forward' }
            ]
        },
        {
            title: 'Help',
            rows: [
                { keys: ['?'], label: 'Show this dialog' }
            ]
        }
    ];
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<div
    class="overlay"
    onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    role="presentation"
>
    <div
        bind:this={dialogEl}
        class="dialog fade-in"
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-labelledby="help-title"
        data-testid="help-modal"
    >
        <header class="head">
            <h2 id="help-title">Keyboard shortcuts</h2>
            <button type="button" class="btn btn-ghost" aria-label="Close" onclick={onClose}>
                <Icon name="close" size={16} />
            </button>
        </header>
        <div class="body">
            <div class="cols">
                {#each groups as g (g.title)}
                    <section class="group">
                        <h3>{g.title}</h3>
                        <ul>
                            {#each g.rows as row (row.label)}
                                <li>
                                    <span class="keys">
                                        {#each row.keys as k (k)}
                                            <kbd>{k}</kbd>
                                        {/each}
                                    </span>
                                    <span class="label">{row.label}</span>
                                </li>
                            {/each}
                        </ul>
                    </section>
                {/each}
            </div>
            <p class="footnote muted">
                Shortcuts are inactive while typing in inputs. Hit <kbd>?</kbd> any time to bring this back up.
            </p>
        </div>
    </div>
</div>

<style>
    .overlay {
        position: fixed; inset: 0;
        background: var(--bg-overlay);
        display: flex; align-items: center; justify-content: center;
        padding: 20px; z-index: 60;
        backdrop-filter: blur(2px);
    }
    .dialog {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(680px, 100%);
        max-height: calc(100vh - 40px);
        display: flex; flex-direction: column;
        overflow: hidden;
    }
    .head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 20px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .head h2 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -0.015em; }
    .body { padding: 20px; overflow-y: auto; }
    .cols {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 24px;
    }
    @media (max-width: 600px) { .cols { grid-template-columns: 1fr; } }
    .group h3 {
        margin: 0 0 8px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
    }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    li {
        display: grid;
        grid-template-columns: 80px 1fr;
        align-items: center;
        gap: 10px;
        padding: 4px 0;
        font-size: 13px;
    }
    .keys { display: inline-flex; gap: 4px; }
    kbd {
        display: inline-block;
        min-width: 22px;
        text-align: center;
        padding: 2px 6px;
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 600;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-bottom-width: 2px;
        border-radius: var(--radius-xs);
        color: var(--text-secondary);
    }
    .label { color: var(--text-secondary); }
    .footnote { margin: 18px 0 0; font-size: 12px; }
    .footnote kbd { font-size: 10px; min-width: 18px; padding: 1px 5px; }
</style>
