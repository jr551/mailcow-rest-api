<script lang="ts">
    // Reusable draggable + resizable + minimisable floating panel.
    // Pattern lifted from Gmail / Proton: panel docks to the bottom-right
    // by default, can be dragged anywhere by its header, resized from the
    // bottom-right corner, minimised to a thin title bar pinned to the
    // bottom-right, and maximised to fill most of the viewport. Position
    // and size persist per `storageKey` so reopening lands you in the same
    // spot.

    import { onMount, onDestroy } from 'svelte';
    import { trapFocus } from '../lib/focus-trap';
    import Icon from './Icon.svelte';

    interface Props {
        title: string;
        storageKey: string;
        defaultWidth?: number;
        defaultHeight?: number;
        minWidth?: number;
        minHeight?: number;
        startMinimized?: boolean;
        onClose: () => void;
        children?: import('svelte').Snippet;
        footer?: import('svelte').Snippet;
        overlay?: import('svelte').Snippet;
        overlayVisible?: boolean;
        testId?: string;
    }

    let {
        title,
        storageKey,
        defaultWidth = 720,
        defaultHeight = 560,
        minWidth = 360,
        minHeight = 280,
        startMinimized = false,
        onClose,
        children,
        footer,
        overlay,
        overlayVisible = false,
        testId = 'floating-panel'
    }: Props = $props();

    interface Geometry {
        x: number;
        y: number;
        w: number;
        h: number;
        maximized: boolean;
        minimized: boolean;
    }

    function loadGeo(): Geometry {
        try {
            const raw = localStorage.getItem('webmail.panel.' + storageKey);
            if (raw) {
                const parsed = JSON.parse(raw) as Partial<Geometry>;
                if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
                    return {
                        x: parsed.x,
                        y: parsed.y,
                        w: typeof parsed.w === 'number' ? parsed.w : defaultWidth,
                        h: typeof parsed.h === 'number' ? parsed.h : defaultHeight,
                        maximized: !!parsed.maximized,
                        minimized: !!parsed.minimized || !!startMinimized
                    };
                }
            }
        } catch { /* noop */ }
        // Default position — bottom-right with margin.
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
        return {
            x: Math.max(20, vw - defaultWidth - 20),
            y: Math.max(20, vh - defaultHeight - 20),
            w: defaultWidth,
            h: defaultHeight,
            maximized: false,
            minimized: !!startMinimized
        };
    }

    let geo = $state<Geometry>(loadGeo());
    let dialogEl: HTMLDivElement | undefined = $state();
    let dragging = $state(false);
    let resizing = $state(false);

    function persist() {
        try {
            localStorage.setItem('webmail.panel.' + storageKey, JSON.stringify(geo));
        } catch { /* noop */ }
    }

    function clampToViewport() {
        if (typeof window === 'undefined') return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (geo.w > vw - 24) geo.w = vw - 24;
        if (geo.h > vh - 24) geo.h = vh - 24;
        if (geo.x + geo.w > vw - 8) geo.x = Math.max(8, vw - geo.w - 8);
        if (geo.y + geo.h > vh - 8) geo.y = Math.max(8, vh - geo.h - 8);
        if (geo.x < 8) geo.x = 8;
        if (geo.y < 8) geo.y = 8;
    }

    onMount(() => {
        clampToViewport();
        const onResize = () => { clampToViewport(); };
        window.addEventListener('resize', onResize);
        let stopFocusTrap: (() => void) | undefined;
        if (dialogEl && !geo.minimized) stopFocusTrap = trapFocus(dialogEl);
        return () => {
            window.removeEventListener('resize', onResize);
            if (stopFocusTrap) stopFocusTrap();
        };
    });

    // Drag from header
    let dragStart = { x: 0, y: 0, panelX: 0, panelY: 0 };
    function onDragStart(e: PointerEvent) {
        if (geo.maximized || geo.minimized) return;
        // Don't initiate drag from interactive elements inside the header.
        const target = e.target as HTMLElement;
        if (target.closest('button, input, a')) return;
        dragging = true;
        dragStart = { x: e.clientX, y: e.clientY, panelX: geo.x, panelY: geo.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
    }
    function onDragMove(e: PointerEvent) {
        if (!dragging) return;
        geo.x = dragStart.panelX + (e.clientX - dragStart.x);
        geo.y = dragStart.panelY + (e.clientY - dragStart.y);
        clampToViewport();
    }
    function onDragEnd(e: PointerEvent) {
        if (!dragging) return;
        dragging = false;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
        persist();
    }

    // Resize from bottom-right corner
    let resizeStart = { x: 0, y: 0, w: 0, h: 0 };
    function onResizeStart(e: PointerEvent) {
        if (geo.maximized || geo.minimized) return;
        resizing = true;
        resizeStart = { x: e.clientX, y: e.clientY, w: geo.w, h: geo.h };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
    }
    function onResizeMove(e: PointerEvent) {
        if (!resizing) return;
        geo.w = Math.max(minWidth, resizeStart.w + (e.clientX - resizeStart.x));
        geo.h = Math.max(minHeight, resizeStart.h + (e.clientY - resizeStart.y));
        clampToViewport();
    }
    function onResizeEnd(e: PointerEvent) {
        if (!resizing) return;
        resizing = false;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
        persist();
    }

    function toggleMaximize() {
        geo.maximized = !geo.maximized;
        if (geo.maximized) geo.minimized = false;
        persist();
    }

    function toggleMinimize() {
        geo.minimized = !geo.minimized;
        if (geo.minimized) geo.maximized = false;
        persist();
    }

    function close() {
        // Don't clear geo — next open lands the user in the same place.
        onClose();
    }

    onDestroy(() => persist());

    // Computed style — maximized covers the viewport (with margin), minimized
    // becomes a small title bar pinned bottom-right.
    function styleString(): string {
        if (geo.maximized) {
            return 'left:24px;top:64px;right:24px;bottom:24px;width:auto;height:auto;';
        }
        if (geo.minimized) {
            return `left:auto;right:20px;bottom:20px;top:auto;width:300px;height:auto;`;
        }
        return `left:${geo.x}px;top:${geo.y}px;width:${geo.w}px;height:${geo.h}px;`;
    }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && !geo.minimized) close(); }} />

<div
    bind:this={dialogEl}
    class={`panel ${geo.maximized ? 'is-max' : ''} ${geo.minimized ? 'is-min' : ''} ${dragging ? 'is-dragging' : ''}`}
    role="dialog"
    aria-label={title}
    aria-modal="false"
    style={styleString()}
    data-testid={testId}
>
    <header
        class="head"
        onpointerdown={onDragStart}
        onpointermove={onDragMove}
        onpointerup={onDragEnd}
        onpointercancel={onDragEnd}
        ondblclick={() => !geo.minimized && toggleMaximize()}
        data-testid={`${testId}-header`}
    >
        <h2>{title}</h2>
        <div class="head-actions">
            <button
                type="button"
                class="head-btn"
                onclick={toggleMinimize}
                title={geo.minimized ? 'Expand' : 'Minimize'}
                aria-label={geo.minimized ? 'Expand' : 'Minimize'}
                data-testid={`${testId}-minimize`}
            >
                {#if geo.minimized}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                {:else}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="14" x2="19" y2="14"/></svg>
                {/if}
            </button>
            {#if !geo.minimized}
                <button
                    type="button"
                    class="head-btn"
                    onclick={toggleMaximize}
                    title={geo.maximized ? 'Restore' : 'Maximize'}
                    aria-label={geo.maximized ? 'Restore' : 'Maximize'}
                    data-testid={`${testId}-maximize`}
                >
                    {#if geo.maximized}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/></svg>
                    {:else}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>
                    {/if}
                </button>
            {/if}
            <button
                type="button"
                class="head-btn"
                onclick={close}
                title="Close"
                aria-label="Close"
                data-testid={`${testId}-close`}
            >
                <Icon name="close" size={14} />
            </button>
        </div>
    </header>

    {#if !geo.minimized}
        <div class="body">
            {@render children?.()}
        </div>
        {#if footer}
            <div class="foot">{@render footer()}</div>
        {/if}
        {#if overlay && overlayVisible === true}
            <div class="overlay">{@render overlay()}</div>
        {/if}
        <div
            class="resize-grip"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize"
            onpointerdown={onResizeStart}
            onpointermove={onResizeMove}
            onpointerup={onResizeEnd}
            onpointercancel={onResizeEnd}
            data-testid={`${testId}-resize`}
        >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <line x1="2" y1="12" x2="12" y2="2"/>
                <line x1="6" y1="12" x2="12" y2="6"/>
                <line x1="10" y1="12" x2="12" y2="10"/>
            </svg>
        </div>
    {/if}
</div>

<style>
    .panel {
        position: fixed;
        z-index: 70;
        background: var(--bg-surface);
        border: 1px solid var(--border-soft);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: panel-in 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    @keyframes panel-in {
        from { opacity: 0; transform: translateY(8px) scale(0.98); }
        to { opacity: 1; transform: none; }
    }
    .panel.is-max { animation: none; }
    .panel.is-min {
        height: auto !important;
        box-shadow: var(--shadow-md);
    }
    .panel.is-dragging {
        user-select: none;
        cursor: grabbing;
    }
    .head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 8px 0 16px;
        height: 38px;
        background: var(--bg-surface-alt);
        border-bottom: 1px solid var(--border-subtle);
        cursor: grab;
        user-select: none;
    }
    .panel.is-min .head { border-bottom: none; }
    .panel.is-max .head { cursor: default; }
    .head:active { cursor: grabbing; }
    .head h2 {
        margin: 0;
        font-size: 13.5px;
        font-weight: 600;
        letter-spacing: -0.01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .head-actions {
        display: flex;
        align-items: center;
        gap: 2px;
    }
    .head-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: var(--radius-xs);
        color: var(--text-secondary);
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .head-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
    .body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        display: flex;
        flex-direction: column;
    }
    .foot {
        flex: 0 0 auto;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    .resize-grip {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        color: var(--text-tertiary);
        display: flex;
        align-items: flex-end;
        justify-content: flex-end;
        padding: 2px;
        opacity: 0.6;
        touch-action: none;
    }
    .resize-grip:hover { opacity: 1; color: var(--text-secondary); }
    .panel.is-max .resize-grip { display: none; }
    .overlay {
        position: absolute;
        inset: 0;
        z-index: 10;
        background: color-mix(in srgb, var(--bg-surface) 65%, transparent);
        backdrop-filter: blur(6px) saturate(140%);
        -webkit-backdrop-filter: blur(6px) saturate(140%);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        animation: overlay-in 220ms ease-out;
    }
    @keyframes overlay-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }
</style>
