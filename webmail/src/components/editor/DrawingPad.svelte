<script lang="ts">
    // Tiptap doesn't ship a drawing extension, so this is a small canvas-
    // based pad that captures a freehand sketch and hands the result back
    // as a PNG data URL. The caller (RichEditor) drops it into the
    // ProseMirror doc as an <img>.
    //
    // Pointer events are used directly so we get pen/touch support on
    // touchscreen + stylus devices without lib bloat.

    import { onMount } from 'svelte';
    import Icon from '../Icon.svelte';

    interface Props {
        width?: number;
        height?: number;
        onDone: (dataUrl: string) => void;
        onCancel: () => void;
    }
    let { width = 720, height = 420, onDone, onCancel }: Props = $props();

    let canvasEl: HTMLCanvasElement | undefined = $state();
    let ctx: CanvasRenderingContext2D | null = null;
    let drawing = false;
    let lastX = 0;
    let lastY = 0;

    let strokeColor = $state('#1f2937');
    let strokeWidth = $state(3);
    let mode = $state<'pen' | 'erase'>('pen');
    let strokeCount = $state(0);

    const PRESETS = [
        { color: '#1f2937', label: 'Charcoal' },
        { color: '#dc2626', label: 'Red' },
        { color: '#2563eb', label: 'Blue' },
        { color: '#16a34a', label: 'Green' },
        { color: '#d97706', label: 'Amber' },
        { color: '#9333ea', label: 'Violet' }
    ];

    onMount(() => {
        if (!canvasEl) return;
        // Crisp lines on HiDPI screens.
        const dpr = window.devicePixelRatio || 1;
        canvasEl.width = width * dpr;
        canvasEl.height = height * dpr;
        canvasEl.style.width = `${width}px`;
        canvasEl.style.height = `${height}px`;
        ctx = canvasEl.getContext('2d');
        if (!ctx) return;
        ctx.scale(dpr, dpr);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // White-paper background so the PNG isn't transparent.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
    });

    function pos(e: PointerEvent): [number, number] {
        const r = canvasEl!.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    function start(e: PointerEvent) {
        e.preventDefault();
        drawing = true;
        canvasEl!.setPointerCapture(e.pointerId);
        [lastX, lastY] = pos(e);
        // Single-tap dot, otherwise lineTo handles the rest.
        if (ctx) {
            ctx.beginPath();
            ctx.arc(lastX, lastY, strokeWidth / 2, 0, Math.PI * 2);
            ctx.fillStyle = mode === 'erase' ? '#ffffff' : strokeColor;
            ctx.fill();
        }
    }
    function move(e: PointerEvent) {
        if (!drawing || !ctx) return;
        const [x, y] = pos(e);
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.strokeStyle = mode === 'erase' ? '#ffffff' : strokeColor;
        ctx.lineWidth = mode === 'erase' ? Math.max(12, strokeWidth * 4) : strokeWidth;
        ctx.stroke();
        lastX = x; lastY = y;
    }
    function end(e: PointerEvent) {
        if (!drawing) return;
        drawing = false;
        canvasEl!.releasePointerCapture(e.pointerId);
        strokeCount++;
    }

    function clearAll() {
        if (!ctx || !canvasEl) return;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        strokeCount = 0;
    }

    function insert() {
        if (!canvasEl) return;
        // PNG with white background is fine for email — keeps the file
        // small and avoids alpha banding on dark-mode email clients.
        const url = canvasEl.toDataURL('image/png');
        onDone(url);
    }

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); insert(); }
    }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) onCancel(); }} role="presentation">
    <div class="dialog fade-in" role="dialog" aria-modal="true" aria-label="Drawing pad" data-testid="drawing-pad">
        <header class="head">
            <h2><Icon name="palette" size={14} /> Sketch a drawing</h2>
            <button type="button" class="btn btn-ghost" onclick={onCancel} aria-label="Close"><Icon name="close" size={14} /></button>
        </header>
        <div class="toolbar">
            <div class="tool-group" role="radiogroup" aria-label="Tool">
                <button
                    type="button"
                    class:active={mode === 'pen'}
                    onclick={() => (mode = 'pen')}
                    title="Pen"
                    data-testid="draw-pen"
                >Pen</button>
                <button
                    type="button"
                    class:active={mode === 'erase'}
                    onclick={() => (mode = 'erase')}
                    title="Eraser"
                    data-testid="draw-erase"
                >Erase</button>
            </div>
            <div class="tool-group colors" role="radiogroup" aria-label="Stroke colour">
                {#each PRESETS as p (p.color)}
                    <button
                        type="button"
                        class="swatch"
                        class:active={strokeColor === p.color && mode === 'pen'}
                        title={p.label}
                        style={`background: ${p.color};`}
                        onclick={() => { strokeColor = p.color; mode = 'pen'; }}
                    ></button>
                {/each}
            </div>
            <label class="size-input">
                <span>Size</span>
                <input
                    type="range"
                    min="1"
                    max="14"
                    bind:value={strokeWidth}
                    aria-label="Stroke width"
                />
                <span class="size-val">{strokeWidth}</span>
            </label>
            <button type="button" class="btn btn-ghost clear" onclick={clearAll} title="Clear" data-testid="draw-clear">
                <Icon name="trash" size={13} /> Clear
            </button>
        </div>
        <div class="canvas-wrap">
            <canvas
                bind:this={canvasEl}
                onpointerdown={start}
                onpointermove={move}
                onpointerup={end}
                onpointercancel={end}
                aria-label="Drawing canvas"
                data-testid="draw-canvas"
            ></canvas>
        </div>
        <footer class="foot">
            <span class="muted small">Pointer / touch / pen all work. Ctrl+Enter to insert.</span>
            <div class="foot-right">
                <button type="button" class="btn btn-ghost" onclick={onCancel}>Cancel</button>
                <button
                    type="button"
                    class="btn btn-primary"
                    onclick={insert}
                    disabled={strokeCount === 0}
                    data-testid="draw-insert"
                ><Icon name="check" size={13} /> Insert</button>
            </div>
        </footer>
    </div>
</div>

<style>
    .overlay {
        position: fixed; inset: 0;
        background: var(--bg-overlay);
        display: flex; align-items: center; justify-content: center;
        padding: 20px; z-index: 80;
        backdrop-filter: blur(2px);
    }
    .dialog {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        max-width: calc(100vw - 40px);
        max-height: calc(100vh - 40px);
        display: flex; flex-direction: column;
        overflow: hidden;
    }
    .head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-subtle);
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
    .toolbar {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
        padding: 10px 16px;
        background: var(--bg-surface-alt);
        border-bottom: 1px solid var(--border-subtle);
    }
    .tool-group {
        display: inline-flex;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 2px;
    }
    .tool-group button {
        padding: 5px 10px;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-tertiary);
        border-radius: var(--radius-xs);
    }
    .tool-group button.active {
        background: var(--bg-surface);
        color: var(--text-primary);
        font-weight: 600;
        box-shadow: var(--shadow-sm);
    }
    .colors { padding: 4px; gap: 4px; }
    .swatch {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        padding: 0;
    }
    .swatch.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .size-input {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--text-secondary);
    }
    .size-input input[type=range] { width: 100px; accent-color: var(--accent); }
    .size-val { font-variant-numeric: tabular-nums; min-width: 16px; }
    .clear { margin-left: auto; }
    .canvas-wrap {
        padding: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: repeating-linear-gradient(
            45deg,
            color-mix(in srgb, var(--bg-base) 92%, var(--accent)),
            color-mix(in srgb, var(--bg-base) 92%, var(--accent)) 8px,
            var(--bg-base) 8px,
            var(--bg-base) 16px
        );
    }
    canvas {
        background: #ffffff;
        border-radius: var(--radius-sm);
        box-shadow: var(--shadow-md);
        touch-action: none;
        cursor: crosshair;
    }
    .foot {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 16px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    .foot .muted { font-size: 11.5px; color: var(--text-tertiary); }
    .foot-right { display: flex; gap: 6px; }
</style>
