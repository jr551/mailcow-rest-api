<script lang="ts">
    import { vibrate } from '../lib/native-bridge';
    interface Props {
        onOpen: () => void;
        onSwipeRight?: () => void;
        onSwipeLeft?: () => void;
        onLongPress?: () => void;
        rightLabel?: string;
        leftLabel?: string;
        rightColor?: string;
        leftColor?: string;
        children?: import('svelte').Snippet;
    }
    let {
        onOpen,
        onSwipeRight,
        onSwipeLeft,
        onLongPress,
        rightLabel = 'Action',
        leftLabel = 'Action',
        rightColor = 'var(--accent)',
        leftColor = 'var(--danger)',
        children
    }: Props = $props();

    let startX = 0;
    let currentX = 0;
    let dragging = $state(false);
    let el: HTMLDivElement | undefined = $state();
    let wrapEl: HTMLDivElement | undefined = $state();
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let longPressTriggered = false;

    const THRESHOLD = 80;
    const MAX = 140;
    const LONG_PRESS_MS = 500;

    // Tracks whether the current drag has crossed the THRESHOLD so we
    // only fire the haptic tick once per swipe direction (otherwise
    // jitter near the line would buzz repeatedly).
    let pastThreshold = false;

    function onPointerDown(e: PointerEvent) {
        if (!onSwipeRight && !onSwipeLeft && !onLongPress) return;
        startX = e.clientX;
        dragging = true;
        longPressTriggered = false;
        pastThreshold = false;
        if (onLongPress) {
            longPressTimer = setTimeout(() => {
                longPressTriggered = true;
                dragging = false;
                vibrate('longPress');
                onLongPress();
            }, LONG_PRESS_MS);
        }
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent) {
        if (!dragging) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 10 && longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        if (!onSwipeRight && dx > 0) return;
        if (!onSwipeLeft && dx < 0) return;
        currentX = Math.max(-MAX, Math.min(MAX, dx));
        if (el) el.style.transform = `translateX(${currentX}px)`;
        const crossed = Math.abs(currentX) >= THRESHOLD;
        if (crossed && !pastThreshold) {
            pastThreshold = true;
            vibrate('tick');
        } else if (!crossed && pastThreshold) {
            pastThreshold = false;
        }
    }

    function onPointerUp(e: PointerEvent) {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        if (!dragging) return;
        dragging = false;
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        if (longPressTriggered) return;
        if (currentX > THRESHOLD && onSwipeRight) {
            onSwipeRight();
        } else if (currentX < -THRESHOLD && onSwipeLeft) {
            onSwipeLeft();
        }
        currentX = 0;
        pastThreshold = false;
        if (el) el.style.transform = '';
    }

    function onClick() {
        if (longPressTriggered) return;
        if (Math.abs(currentX) < 8) onOpen();
    }
    function onKey(e: KeyboardEvent) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
        }
    }
</script>

<div class="swipe-wrap" class:dragging bind:this={wrapEl}>
    {#if onSwipeRight}
        <div class="action right" style="background: {rightColor};">
            <span>{rightLabel}</span>
        </div>
    {/if}
    {#if onSwipeLeft}
        <div class="action left" style="background: {leftColor};">
            <span>{leftLabel}</span>
        </div>
    {/if}
    <div
        bind:this={el}
        class="swipe-content"
        class:dragging
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onclick={onClick}
        onkeydown={onKey}
        role="button"
        tabindex="0"
    >
        {@render children?.()}
    </div>
</div>

<style>
    .swipe-wrap {
        position: relative;
        overflow: hidden;
        touch-action: pan-y;
        background: var(--bg-surface);
    }
    .action {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        padding: 0 20px;
        font-size: 14px;
        font-weight: 700;
        color: #fff;
        pointer-events: none;
        z-index: 0;
        opacity: 0;
        transition: opacity 120ms ease;
    }
    .action.right { justify-content: flex-start; }
    .action.left { justify-content: flex-end; }
    .swipe-wrap.dragging .action {
        opacity: 1;
    }
    .swipe-content {
        position: relative;
        z-index: 1;
        background: var(--bg-surface);
        transition: transform 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
        cursor: pointer;
        width: 100%;
    }
    .swipe-content.dragging {
        transition: none;
    }
</style>
