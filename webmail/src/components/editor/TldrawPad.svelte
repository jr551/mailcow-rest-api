<script lang="ts">
    // tldraw drawing modal. tldraw is a React component, so we mount a
    // tiny React tree inside a Svelte div via createRoot. Everything
    // tldraw-related is dynamically imported so the React + tldraw
    // chunk only ships when the user actually opens the drawing modal.
    //
    // The "Insert" button asks tldraw's editor to export the current
    // page as PNG, then hands the data URL back to RichEditor (which
    // drops it in as an <img>).

    import { onMount, onDestroy } from 'svelte';
    import Icon from '../Icon.svelte';

    interface Props {
        /** 'email' = original compose flow (Insert PNG). 'create'|'edit' = Drive flow (Save .tldr). */
        mode?: 'email' | 'create' | 'edit';
        initialSnapshot?: object;
        defaultName?: string;
        onDone?: (dataUrl: string) => void;
        onSave?: (blob: Blob, filename: string) => void;
        onCancel: () => void;
    }
    let { mode = 'email', initialSnapshot, defaultName = 'drawing.tldr', onDone, onSave, onCancel }: Props = $props();

    let mountEl: HTMLDivElement | undefined = $state();
    let loading = $state(true);
    let exporting = $state(false);
    let saving = $state(false);
    let error = $state<string | null>(null);

    // The tldraw editor instance + the React root are stashed on these
    // refs so the Insert/Save button can drive them without re-rendering React.
    let editorRef: { current: unknown } = { current: null };
    let reactRoot: { unmount: () => void } | null = null;

    onMount(async () => {
        if (!mountEl) return;
        try {
            const [{ Tldraw }, React, ReactDOM, _css] = await Promise.all([
                import('tldraw'),
                import('react'),
                import('react-dom/client'),
                import('tldraw/tldraw.css')
            ]);
            const root = ReactDOM.createRoot(mountEl);
            reactRoot = root;
            const onMountReact = (editor: unknown) => {
                editorRef.current = editor;
                if (mode === 'edit' && initialSnapshot) {
                    try {
                        (editor as { loadSnapshot: (s: object) => void }).loadSnapshot(initialSnapshot);
                    } catch (err) {
                        console.warn('Failed to load tldraw snapshot', err);
                    }
                }
                loading = false;
            };
            root.render(
                React.createElement(
                    'div',
                    { style: { position: 'absolute', inset: 0 } },
                    React.createElement(Tldraw, { onMount: onMountReact })
                )
            );
        } catch (err) {
            error = (err as Error).message || 'Failed to load tldraw';
            loading = false;
        }
    });

    onDestroy(() => {
        try { reactRoot?.unmount(); } catch { /* noop */ }
        editorRef.current = null;
    });

    async function insert() {
        if (mode !== 'email' || !onDone) return;
        const ed = editorRef.current as {
            getCurrentPageShapeIds: () => Set<string>;
            toImage: (ids: string[], opts: Record<string, unknown>) => Promise<{ blob: Blob; width: number; height: number }>;
        } | null;
        if (!ed) return;
        const ids = Array.from(ed.getCurrentPageShapeIds());
        if (!ids.length) {
            // Nothing drawn yet — just bail.
            onCancel();
            return;
        }
        exporting = true;
        try {
            const result = await ed.toImage(ids, {
                format: 'png',
                background: true,
                padding: 16,
                scale: 2
            });
            const dataUrl = await blobToDataUrl(result.blob);
            onDone(dataUrl);
        } catch (err) {
            error = `Export failed: ${(err as Error).message}`;
        } finally {
            exporting = false;
        }
    }

    async function save() {
        if (mode === 'email' || !onSave) return;
        const ed = editorRef.current as { getSnapshot: () => object } | null;
        if (!ed) return;
        saving = true;
        try {
            const snapshot = ed.getSnapshot();
            const json = JSON.stringify(snapshot);
            const blob = new Blob([json], { type: 'application/json' });
            const filename = defaultName.endsWith('.tldr') ? defaultName : `${defaultName}.tldr`;
            onSave(blob, filename);
        } catch (err) {
            error = `Save failed: ${(err as Error).message}`;
        } finally {
            saving = false;
        }
    }

    function blobToDataUrl(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result as string);
            fr.onerror = () => reject(new Error('FileReader failed'));
            fr.readAsDataURL(blob);
        });
    }

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) onCancel(); }} role="presentation">
    <div class="dialog fade-in" role="dialog" aria-modal="true" aria-label="Drawing pad" data-testid="tldraw-pad">
        <header class="head">
            <h2><Icon name="palette" size={14} /> {mode === 'email' ? 'Sketch a drawing' : mode === 'create' ? 'New drawing' : 'Edit drawing'}</h2>
            <div class="head-actions">
                <button type="button" class="btn btn-ghost" onclick={onCancel}>Cancel</button>
                {#if mode === 'email'}
                    <button
                        type="button"
                        class="btn btn-primary"
                        onclick={insert}
                        disabled={loading || exporting}
                        data-testid="tldraw-insert"
                    >
                        {#if exporting}<span class="spinner"></span>{/if}
                        <Icon name="check" size={13} /> Insert into email
                    </button>
                {:else}
                    <button
                        type="button"
                        class="btn btn-primary"
                        onclick={save}
                        disabled={loading || saving}
                        data-testid="tldraw-save"
                    >
                        {#if saving}<span class="spinner"></span>{/if}
                        <Icon name="check" size={13} /> Save
                    </button>
                {/if}
            </div>
        </header>

        <div class="canvas-shell">
            {#if loading}
                <div class="loading">
                    <span class="loading-spinner" aria-hidden="true"></span>
                    <p class="muted">Loading drawing tools…</p>
                </div>
            {/if}
            {#if error}
                <div class="error" role="alert">{error}</div>
            {/if}
            <div bind:this={mountEl} class="tldraw-mount" data-testid="tldraw-mount"></div>
        </div>
    </div>
</div>

<style>
    .overlay {
        position: fixed; inset: 0;
        background: var(--bg-overlay);
        display: flex; align-items: center; justify-content: center;
        padding: 14px; z-index: 90;
        backdrop-filter: blur(2px);
    }
    .dialog {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(1100px, 100%);
        height: min(720px, calc(100vh - 28px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .head {
        display: flex; justify-content: space-between; align-items: center;
        gap: 12px;
        padding: 10px 16px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    .head h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: -0.01em;
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .head-actions { display: flex; gap: 6px; }
    .canvas-shell {
        flex: 1;
        position: relative;
        background: #fafafb;
    }
    .tldraw-mount {
        position: absolute;
        inset: 0;
    }
    .loading {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 10px;
        color: var(--text-tertiary);
        z-index: 1;
        pointer-events: none;
    }
    .loading-spinner {
        width: 28px;
        height: 28px;
        border: 2px solid var(--border-subtle);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 720ms linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error {
        position: absolute;
        top: 12px;
        left: 12px;
        right: 12px;
        padding: 10px 12px;
        background: var(--danger-soft);
        color: var(--danger);
        border-radius: var(--radius-sm);
        font-size: 12.5px;
    }
</style>
