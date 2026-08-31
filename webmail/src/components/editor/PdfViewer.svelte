<script lang="ts">
    // Pop-out PDF viewer + rasterise-and-annotate flow.
    //
    //   1. View — PDF.js renders the current page to a viewer canvas.
    //   2. Annotate — same page is rasterised at 2x to a hidden bg
    //      canvas; an overlay drawing canvas captures pen/touch input.
    //   3. Flatten — bg + drawing layers + text boxes composited; result
    //      attached to a fresh reply via the standard Compose flow,
    //      downloaded as PNG, or embedded in a one-page PDF via pdf-lib.
    //
    // The PDF.js worker is loaded from the same package via Vite's
    // `?url` query so we don't need an external CDN. pdf-lib stays
    // entirely in-process.

    import { onMount, onDestroy } from 'svelte';
    import * as pdfjsLib from 'pdfjs-dist';
    import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
    import { PDFDocument } from 'pdf-lib';
    import Icon from '../Icon.svelte';

    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

    interface Props {
        /** The original PDF bytes — fetched by the caller via the
         *  attachment download URL. */
        bytes: ArrayBuffer;
        filename?: string;
        /** Called when the user picks 'Reply with annotation' — the
         *  caller decides whether to attach to a new compose draft. */
        onAttach?: (file: { filename: string; contentType: string; dataUrl: string }) => void;
        onClose: () => void;
        /** When true, render as a flex-filling inline component instead of
         *  a fixed-position overlay (used inside Drive preview modals). */
        inline?: boolean;
    }
    let { bytes, filename = 'document.pdf', onAttach, onClose, inline = false }: Props = $props();

    let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
    let pageNum = $state(1);
    let totalPages = $state(0);
    let mode = $state<'view' | 'annotate'>('view');
    let zoom = $state(1.5);
    // Surfaced when pdf.js or canvas rendering fails — the original code only
    // logged to console, so the user just saw the empty viewer modal.
    let loadError = $state<string | null>(null);
    let docReady = $state(false);

    let viewerCanvas: HTMLCanvasElement | undefined = $state();
    let drawCanvas: HTMLCanvasElement | undefined = $state();
    let bgCanvas: HTMLCanvasElement | null = null;

    let penColor = $state('#dc2626');
    let penWidth = $state(3);
    let tool = $state<'pen' | 'erase' | 'text'>('pen');
    let strokeCount = $state(0);

    const PEN_COLORS = ['#1f2937', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#9333ea'];

    let isDrawing = false;
    let lastX = 0;
    let lastY = 0;

    // Text-box annotation state
    interface TextBox {
        id: number;
        x: number;
        y: number;
        text: string;
        fontSize: number;
        color: string;
        width: number;
        height: number;
    }
    let textBoxes = $state<TextBox[]>([]);
    let nextTextId = $state(1);
    let activeTextId = $state<number | null>(null);
    let isDraggingText = false;
    let dragTextId: number | null = null;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    onMount(async () => {
        try {
            // pdfjs mutates the buffer it's given, which can break a second
            // open of the same document (rare in practice, but cheap to guard).
            const buf = bytes.slice(0);
            pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
            totalPages = pdfDoc.numPages;
            docReady = true;
            await renderPage(pageNum);
        } catch (err) {
            console.error('PDF load failed', err);
            loadError = (err as Error).message || 'Could not load this PDF.';
        }
    });
    onDestroy(() => {
        pdfDoc?.destroy?.().catch(() => { /* noop */ });
    });

    async function renderPage(num: number) {
        if (!pdfDoc) return;
        // The canvas only mounts when mode==='view'. After 'docReady' flips
        // we may briefly tick before bind:this runs — re-poll if needed so
        // the first render isn't a silent no-op.
        let canvas = viewerCanvas;
        for (let i = 0; !canvas && i < 5; i++) {
            await new Promise((r) => requestAnimationFrame(r));
            canvas = viewerCanvas;
        }
        if (!canvas) {
            loadError = 'Internal: viewer canvas never mounted.';
            return;
        }
        try {
            const page = await pdfDoc.getPage(num);
            const viewport = page.getViewport({ scale: zoom });
            // Set the canvas dimensions BEFORE pulling the 2D context so the
            // context isn't stale (changing canvas.width resets the context).
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                loadError = 'Internal: could not get 2D context.';
                return;
            }
            await page.render({ canvas, canvasContext: ctx, viewport }).promise;
            loadError = null;
        } catch (err) {
            console.error('PDF page render failed', err);
            loadError = (err as Error).message || 'Could not render this page.';
        }
    }

    async function go(delta: 1 | -1) {
        const next = pageNum + delta;
        if (next < 1 || next > totalPages) return;
        pageNum = next;
        await renderPage(pageNum);
    }
    async function zoomBy(delta: number) {
        zoom = Math.max(0.5, Math.min(3, zoom + delta));
        await renderPage(pageNum);
    }

    async function startAnnotating() {
        if (!pdfDoc) return;
        const page = await pdfDoc.getPage(pageNum);
        const scale = 2;
        const viewport = page.getViewport({ scale });

        bgCanvas = document.createElement('canvas');
        bgCanvas.width = viewport.width;
        bgCanvas.height = viewport.height;
        const bgCtx = bgCanvas.getContext('2d');
        if (!bgCtx) return;
        bgCtx.fillStyle = '#ffffff';
        bgCtx.fillRect(0, 0, viewport.width, viewport.height);
        await page.render({ canvas: bgCanvas, canvasContext: bgCtx, viewport }).promise;

        mode = 'annotate';
        // The drawing canvas mounts on the next tick after `mode` flips.
        queueMicrotask(() => {
            if (!drawCanvas || !bgCanvas) return;
            drawCanvas.width = viewport.width;
            drawCanvas.height = viewport.height;
            const ctx = drawCanvas.getContext('2d');
            if (ctx) { ctx.lineCap = 'round'; ctx.lineJoin = 'round'; }
            drawCanvas.style.backgroundImage = `url(${bgCanvas.toDataURL()})`;
            drawCanvas.style.backgroundSize = '100% 100%';
            drawCanvas.style.backgroundRepeat = 'no-repeat';
            strokeCount = 0;
            textBoxes = [];
            nextTextId = 1;
            activeTextId = null;
        });
    }
    function cancelAnnotating() {
        mode = 'view';
        bgCanvas = null;
        textBoxes = [];
        activeTextId = null;
        renderPage(pageNum);
    }

    function pos(e: PointerEvent): [number, number] {
        if (!drawCanvas) return [0, 0];
        const r = drawCanvas.getBoundingClientRect();
        const sx = drawCanvas.width / r.width;
        const sy = drawCanvas.height / r.height;
        return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
    }
    function startDraw(e: PointerEvent) {
        if (!drawCanvas || tool === 'text') return;
        e.preventDefault();
        isDrawing = true;
        drawCanvas.setPointerCapture(e.pointerId);
        [lastX, lastY] = pos(e);
        const ctx = drawCanvas.getContext('2d');
        if (ctx) {
            ctx.beginPath();
            ctx.arc(lastX, lastY, penWidth / 2, 0, Math.PI * 2);
            ctx.fillStyle = tool === 'erase' ? '#ffffff' : penColor;
            ctx.fill();
        }
    }
    function moveDraw(e: PointerEvent) {
        if (!isDrawing || !drawCanvas || tool === 'text') return;
        const ctx = drawCanvas.getContext('2d');
        if (!ctx) return;
        const [x, y] = pos(e);
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.strokeStyle = tool === 'erase' ? '#ffffff' : penColor;
        ctx.lineWidth = tool === 'erase' ? Math.max(12, penWidth * 4) : penWidth;
        ctx.stroke();
        lastX = x; lastY = y;
    }
    function endDraw(e: PointerEvent) {
        if (!isDrawing || !drawCanvas || tool === 'text') return;
        isDrawing = false;
        drawCanvas.releasePointerCapture(e.pointerId);
        strokeCount++;
    }
    function clearStrokes() {
        if (!drawCanvas) return;
        const ctx = drawCanvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        strokeCount = 0;
        textBoxes = [];
        nextTextId = 1;
        activeTextId = null;
    }

    // Text-box annotation handlers
    function handleCanvasClick(e: PointerEvent) {
        if (tool !== 'text' || !drawCanvas) return;
        // If clicking on an existing text box, don't create a new one
        const target = e.target as HTMLElement;
        if (target.closest('.text-box-overlay')) return;

        const [x, y] = pos(e);
        const id = nextTextId++;
        const fontSize = Math.round(penWidth * 5 + 10); // 15–80px range mapped to canvas scale
        textBoxes = [...textBoxes, { id, x, y, text: '', fontSize, color: penColor, width: 200, height: 40 }];
        activeTextId = id;
    }

    function updateTextBox(id: number, updates: Partial<TextBox>) {
        textBoxes = textBoxes.map((tb) => (tb.id === id ? { ...tb, ...updates } : tb));
    }

    function deleteTextBox(id: number) {
        textBoxes = textBoxes.filter((tb) => tb.id !== id);
        if (activeTextId === id) activeTextId = null;
    }

    function startDragText(e: PointerEvent, id: number) {
        if (!drawCanvas) return;
        e.preventDefault();
        e.stopPropagation();
        isDraggingText = true;
        dragTextId = id;
        const [x, y] = pos(e);
        const tb = textBoxes.find((t) => t.id === id);
        if (tb) {
            dragOffsetX = x - tb.x;
            dragOffsetY = y - tb.y;
        }
        activeTextId = id;
    }

    function moveDragText(e: PointerEvent) {
        if (!isDraggingText || dragTextId === null || !drawCanvas) return;
        const [x, y] = pos(e);
        updateTextBox(dragTextId, {
            x: Math.max(0, x - dragOffsetX),
            y: Math.max(0, y - dragOffsetY)
        });
    }

    function endDragText() {
        isDraggingText = false;
        dragTextId = null;
    }

    function autoGrow(el: HTMLTextAreaElement) {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    }

    /** Composite bg + ink + text-box layers and return a PNG data URL. */
    function flattenToPng(): string | null {
        if (!bgCanvas || !drawCanvas) return null;
        const out = document.createElement('canvas');
        out.width = bgCanvas.width;
        out.height = bgCanvas.height;
        const ctx = out.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(bgCanvas, 0, 0);
        ctx.drawImage(drawCanvas, 0, 0);
        // Render committed text boxes onto the canvas
        for (const tb of textBoxes) {
            ctx.font = `${tb.fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
            ctx.fillStyle = tb.color;
            const lines = tb.text.split('\n');
            const lineHeight = tb.fontSize * 1.25;
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], tb.x, tb.y + (i + 1) * lineHeight);
            }
        }
        return out.toDataURL('image/png');
    }

    async function downloadPng() {
        const url = flattenToPng();
        if (!url) return;
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename.replace(/\.pdf$/i, '')}-page${pageNum}-annotated.png`;
        a.click();
    }

    /** Build a single-page PDF from the flattened image. Faster + more
     *  reliable than embedding into the original (which can crash on
     *  encrypted / heavily-styled documents). */
    async function downloadPdf() {
        const png = flattenToPng();
        if (!png) return;
        const pdf = await PDFDocument.create();
        const bytes = Uint8Array.from(atob(png.split(',')[1]), (c) => c.charCodeAt(0));
        const img = await pdf.embedPng(bytes);
        const page = pdf.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        const out = await pdf.save();
        // Slice the underlying ArrayBuffer so the Blob constructor's
        // BlobPart type narrows correctly across pdf-lib's typing.
        const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
        const blob = new Blob([ab], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename.replace(/\.pdf$/i, '')}-annotated.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function attachToReply() {
        const url = flattenToPng();
        if (!url || !onAttach) return;
        onAttach({
            filename: `${filename.replace(/\.pdf$/i, '')}-page${pageNum}-annotated.png`,
            contentType: 'image/png',
            dataUrl: url
        });
    }

    const hasAnnotations = $derived(strokeCount > 0 || textBoxes.length > 0);
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<div class="overlay" class:inline onclick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="presentation">
    <div class="dialog fade-in" class:inline role="dialog" aria-modal="true" aria-label="PDF viewer" data-testid="pdf-viewer">
        <header class="head">
            <div class="head-left">
                <h2><Icon name="paperclip" size={14} /> {filename}</h2>
                {#if totalPages > 0}
                    <span class="muted small">page {pageNum} of {totalPages}</span>
                {/if}
            </div>
            <button type="button" class="btn btn-ghost" onclick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </header>

        <div class="toolbar">
            {#if mode === 'view'}
                <div class="grp">
                    <button type="button" onclick={() => go(-1)} disabled={pageNum <= 1} title="Previous page">
                        <Icon name="chevronLeft" size={13} />
                    </button>
                    <span class="muted small page-pos">{pageNum}/{totalPages || '?'}</span>
                    <button type="button" onclick={() => go(1)} disabled={pageNum >= totalPages} title="Next page">
                        <Icon name="chevronRight" size={13} />
                    </button>
                </div>
                <div class="grp">
                    <button type="button" onclick={() => zoomBy(-0.25)} title="Zoom out">−</button>
                    <span class="muted small">{Math.round(zoom * 100)}%</span>
                    <button type="button" onclick={() => zoomBy(0.25)} title="Zoom in">+</button>
                </div>
                <button
                    type="button"
                    class="btn btn-secondary annotate-btn"
                    onclick={startAnnotating}
                    data-testid="pdf-annotate"
                ><Icon name="palette" size={13} /> Annotate this page</button>
            {:else}
                <div class="grp">
                    <button
                        type="button"
                        class:active={tool === 'pen'}
                        onclick={() => (tool = 'pen')}
                        title="Pen"
                    >Pen</button>
                    <button
                        type="button"
                        class:active={tool === 'erase'}
                        onclick={() => (tool = 'erase')}
                        title="Eraser"
                    >Erase</button>
                    <button
                        type="button"
                        class:active={tool === 'text'}
                        onclick={() => (tool = 'text')}
                        title="Text box"
                    ><Icon name="type" size={13} /></button>
                </div>
                <div class="grp colors">
                    {#each PEN_COLORS as c (c)}
                        <button
                            type="button"
                            class="swatch"
                            class:active={penColor === c && tool !== 'erase'}
                            style={`background:${c}`}
                            onclick={() => { penColor = c; tool = tool === 'erase' ? 'pen' : tool; }}
                            aria-label={`Pen colour ${c}`}
                        ></button>
                    {/each}
                </div>
                <label class="size">
                    <span class="muted small">Size</span>
                    <input type="range" min="1" max="14" bind:value={penWidth} aria-label="Stroke width" />
                </label>
                <button type="button" class="btn btn-ghost" onclick={clearStrokes} title="Clear all annotations">
                    <Icon name="trash" size={13} /> Clear
                </button>
                <span class="grp-spacer"></span>
                <button type="button" class="btn btn-ghost" onclick={cancelAnnotating}>Done</button>
            {/if}
        </div>

        <div class="canvas-wrap">
            {#if loadError}
                <div class="viewer-state" role="alert">
                    <Icon name="info" size={20} />
                    <p>{loadError}</p>
                    <button type="button" class="btn btn-ghost" onclick={onClose}>Close</button>
                </div>
            {:else if !docReady && mode === 'view'}
                <div class="viewer-state" aria-live="polite">
                    <span class="spinner"></span>
                    <p class="muted small">Loading PDF…</p>
                </div>
            {:else if mode === 'view'}
                <canvas bind:this={viewerCanvas} class="viewer-canvas"></canvas>
            {:else}
                <div class="annotate-wrap">
                    <canvas
                        bind:this={drawCanvas}
                        class="draw-canvas"
                        class:text-cursor={tool === 'text'}
                        onpointerdown={(e) => {
                            if (tool === 'text') handleCanvasClick(e);
                            else startDraw(e);
                        }}
                        onpointermove={(e) => {
                            moveDraw(e);
                            moveDragText(e);
                        }}
                        onpointerup={(e) => {
                            endDraw(e);
                            endDragText();
                        }}
                        onpointercancel={(e) => {
                            endDraw(e);
                            endDragText();
                        }}
                    ></canvas>
                    <!-- Text-box overlays -->
                    {#each textBoxes as tb (tb.id)}
                        <div
                            class="text-box-overlay"
                            class:active={activeTextId === tb.id}
                            style={`left:${tb.x}px;top:${tb.y}px;width:${tb.width}px;`}
                        >
                            <div
                                class="text-drag-handle"
                                onpointerdown={(e) => startDragText(e, tb.id)}
                                title="Drag to move"
                            >
                                <Icon name="gripVertical" size={12} />
                            </div>
                            <button
                                type="button"
                                class="text-del-btn"
                                onclick={() => deleteTextBox(tb.id)}
                                title="Delete text box"
                            >
                                <Icon name="close" size={10} />
                            </button>
                            <textarea
                                placeholder="Type here…"
                                bind:value={tb.text}
                                oninput={(e) => {
                                    updateTextBox(tb.id, { text: tb.text });
                                    autoGrow(e.currentTarget);
                                }}
                                onfocus={() => (activeTextId = tb.id)}
                                onkeydown={(e) => {
                                    if (e.key === 'Escape') {
                                        activeTextId = null;
                                        (e.currentTarget as HTMLTextAreaElement).blur();
                                    }
                                }}
                                style={`color:${tb.color};font-size:${tb.fontSize}px;`}
                            ></textarea>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>

        {#if mode === 'annotate'}
            <footer class="foot">
                <span class="muted small">{strokeCount} stroke{strokeCount === 1 ? '' : 's'}, {textBoxes.length} text box{textBoxes.length === 1 ? '' : 'es'} on page {pageNum}</span>
                <div class="foot-actions">
                    <button type="button" class="btn btn-ghost" onclick={downloadPng} disabled={!hasAnnotations}>
                        <Icon name="download" size={13} /> PNG
                    </button>
                    <button type="button" class="btn btn-ghost" onclick={downloadPdf} disabled={!hasAnnotations}>
                        <Icon name="download" size={13} /> PDF
                    </button>
                    {#if onAttach}
                        <button
                            type="button"
                            class="btn btn-primary"
                            onclick={attachToReply}
                            disabled={!hasAnnotations}
                            data-testid="pdf-attach"
                        ><Icon name="reply" size={13} /> Attach to reply</button>
                    {/if}
                </div>
            </footer>
        {/if}
    </div>
</div>

<style>
    .overlay {
        position: fixed; inset: 0;
        background: var(--bg-overlay);
        display: flex; align-items: center; justify-content: center;
        padding: 20px; z-index: 90;
        backdrop-filter: blur(2px);
    }
    .dialog {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(960px, 100%);
        max-height: calc(100vh - 40px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .overlay.inline {
        position: static;
        background: transparent;
        padding: 0;
        backdrop-filter: none;
        flex: 1;
        display: flex;
        z-index: auto;
    }
    .dialog.inline {
        width: 100%;
        max-height: 100%;
        border: none;
        border-radius: 0;
        box-shadow: none;
    }
    .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 18px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .head-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .head h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: -0.01em;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 480px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        padding: 10px 16px;
        background: var(--bg-surface-alt);
        border-bottom: 1px solid var(--border-subtle);
    }
    .grp {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
    }
    .grp button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px; height: 26px;
        font-size: 12px;
        color: var(--text-secondary);
        border-radius: var(--radius-xs);
    }
    .grp button.active { background: var(--bg-surface); color: var(--text-primary); font-weight: 600; box-shadow: var(--shadow-sm); }
    .grp button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .grp button:disabled { opacity: 0.4; cursor: not-allowed; }
    .grp .page-pos { padding: 0 6px; font-variant-numeric: tabular-nums; }
    .grp.colors { padding: 4px; gap: 4px; }
    .swatch {
        width: 22px; height: 22px;
        border-radius: 50%;
        border: 2px solid transparent;
        padding: 0;
        cursor: pointer;
    }
    .swatch.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .size { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-secondary); }
    .size input[type=range] { width: 100px; accent-color: var(--accent); }
    .grp-spacer { flex: 1; }
    .annotate-btn {
        margin-left: auto;
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 20%, var(--bg-surface)),
            color-mix(in srgb, #d268f4 14%, var(--bg-surface)));
        font-weight: 600;
    }
    .canvas-wrap {
        flex: 1;
        overflow: auto;
        padding: 16px;
        background: repeating-linear-gradient(
            45deg,
            color-mix(in srgb, var(--bg-base) 92%, var(--accent)),
            color-mix(in srgb, var(--bg-base) 92%, var(--accent)) 8px,
            var(--bg-base) 8px,
            var(--bg-base) 16px
        );
        display: flex;
        align-items: flex-start;
        justify-content: center;
    }
    canvas {
        background: #ffffff;
        box-shadow: var(--shadow-md);
        border-radius: var(--radius-sm);
        max-width: 100%;
        height: auto;
        touch-action: none;
        cursor: crosshair;
    }
    canvas.text-cursor { cursor: text; }
    .viewer-state {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        color: var(--text-secondary);
        text-align: center;
        padding: 32px;
    }
    .viewer-state p { margin: 0; max-width: 420px; line-height: 1.5; }
    .foot {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    .foot-actions { display: flex; gap: 6px; }

    /* Text-box overlay system */
    .annotate-wrap {
        position: relative;
        display: inline-block;
    }
    .text-box-overlay {
        position: absolute;
        z-index: 10;
        display: flex;
        flex-direction: column;
        min-width: 120px;
    }
    .text-box-overlay.active {
        z-index: 20;
    }
    .text-box-overlay textarea {
        width: 100%;
        min-height: 32px;
        padding: 4px 6px;
        background: rgba(255, 255, 255, 0.92);
        border: 1px dashed color-mix(in srgb, var(--accent) 50%, var(--border-subtle));
        border-radius: var(--radius-xs);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        line-height: 1.3;
        resize: both;
        overflow: hidden;
        outline: none;
        cursor: text;
        box-shadow: var(--shadow-sm);
    }
    .text-box-overlay textarea:focus {
        border-style: solid;
        border-color: var(--accent);
        background: #ffffff;
    }
    .text-box-overlay textarea::placeholder {
        color: var(--text-tertiary);
        opacity: 0.7;
    }
    .text-drag-handle {
        position: absolute;
        left: -18px;
        top: 2px;
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        color: var(--text-tertiary);
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
        opacity: 0;
        transition: opacity var(--transition-fast);
    }
    .text-box-overlay:hover .text-drag-handle,
    .text-box-overlay.active .text-drag-handle {
        opacity: 1;
    }
    .text-drag-handle:active { cursor: grabbing; }
    .text-del-btn {
        position: absolute;
        right: -10px;
        top: -10px;
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: var(--danger);
        color: #fff;
        opacity: 0;
        transition: opacity var(--transition-fast);
        cursor: pointer;
        z-index: 21;
    }
    .text-box-overlay:hover .text-del-btn,
    .text-box-overlay.active .text-del-btn {
        opacity: 1;
    }
    .text-del-btn:hover { background: color-mix(in srgb, var(--danger) 85%, #000); }
</style>
