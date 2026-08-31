<script lang="ts">
    // Full-screen glass overlay for long-running bulk operations
    // (move/archive/trash). Driven by ui.bulkProgress — any code path
    // that processes many items can set/clear it. While the overlay is
    // up the rest of the UI is intentionally inert: no accidental
    // double-clicks of an action that already kicked off.
    import { ui } from '../lib/store.svelte';

    let pct = $derived.by(() => {
        const p = ui.bulkProgress;
        if (!p || p.total === 0) return 0;
        return Math.min(100, Math.round((p.done / p.total) * 100));
    });

    let isComplete = $derived.by(() => {
        const p = ui.bulkProgress;
        return !!(p && p.total > 0 && p.done >= p.total);
    });
</script>

{#if ui.bulkProgress}
    <!-- aria-busy + role=status keeps screen readers in the loop without
         stealing focus. Pointer-events: all on the backdrop is what makes
         the rest of the UI inert during the operation. -->
    <div
        class="bulk-overlay"
        role="status"
        aria-live="polite"
        aria-busy={!isComplete}
        data-testid="bulk-progress"
    >
        <div class="card" class:complete={isComplete}>
            <div class="spinner" aria-hidden="true">
                <span class="orb o1"></span>
                <span class="orb o2"></span>
                <span class="orb o3"></span>
            </div>
            <div class="title">{ui.bulkProgress.action}</div>
            <div class="counts">
                <span class="big">{ui.bulkProgress.done}</span>
                <span class="of">of</span>
                <span class="big total">{ui.bulkProgress.total}</span>
                {#if ui.bulkProgress.failed > 0}
                    <span class="failed">· {ui.bulkProgress.failed} failed</span>
                {/if}
            </div>
            <div class="bar" aria-hidden="true">
                <span class="fill" style="width: {pct}%;"></span>
                <span class="stripes"></span>
            </div>
            <div class="pct">{pct}%</div>
            <div class="hint">
                {#if isComplete}
                    Wrapping up…
                {:else}
                    Hold on — interrupting now might leave items half-moved.
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .bulk-overlay {
        position: fixed;
        inset: 0;
        z-index: 9990;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, #0b0d12 30%, transparent);
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        animation: fade-in 200ms ease;
    }
    @keyframes fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
    }

    .card {
        position: relative;
        width: min(92vw, 460px);
        padding: 32px 32px 26px;
        border-radius: 22px;
        background: color-mix(in srgb, var(--bg-elevated, #fff) 90%, transparent);
        border: 1px solid color-mix(in srgb, var(--accent, #4f7cff) 18%, var(--border-subtle, rgba(0, 0, 0, 0.08)));
        box-shadow:
            0 30px 80px rgba(0, 0, 0, 0.34),
            0 0 0 1px rgba(255, 255, 255, 0.04) inset,
            0 1px 0 rgba(255, 255, 255, 0.6) inset;
        text-align: center;
        animation: card-in 280ms cubic-bezier(0.22, 1, 0.36, 1);
        overflow: hidden;
    }
    @keyframes card-in {
        from { transform: translateY(14px) scale(0.96); opacity: 0; }
        to   { transform: translateY(0)    scale(1);    opacity: 1; }
    }

    /* Conic shimmer ring around the card while it's active. Settles to
     * a flat colour once isComplete fires so the user sees "done". */
    .card::before {
        content: '';
        position: absolute;
        inset: -2px;
        border-radius: inherit;
        padding: 2px;
        background: conic-gradient(
            from var(--shimmer-angle, 0deg),
            transparent 0deg,
            color-mix(in srgb, var(--accent, #4f7cff) 60%, transparent) 90deg,
            transparent 180deg,
            color-mix(in srgb, var(--accent, #4f7cff) 60%, transparent) 270deg,
            transparent 360deg
        );
        -webkit-mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
        mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        animation: shimmer 3.6s linear infinite;
        pointer-events: none;
    }
    @property --shimmer-angle {
        syntax: '<angle>';
        inherits: false;
        initial-value: 0deg;
    }
    @keyframes shimmer {
        from { --shimmer-angle: 0deg; }
        to   { --shimmer-angle: 360deg; }
    }
    .card.complete::before { animation-play-state: paused; opacity: 0.4; }

    .spinner {
        position: relative;
        width: 64px;
        height: 64px;
        margin: 0 auto 18px;
    }
    .spinner .orb {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 3px solid transparent;
        border-top-color: var(--accent, #4f7cff);
        animation: spin 1.2s linear infinite;
    }
    .spinner .o2 {
        inset: 8px;
        border-top-color: color-mix(in srgb, var(--accent, #4f7cff) 60%, #ffffff);
        animation-direction: reverse;
        animation-duration: 1.6s;
    }
    .spinner .o3 {
        inset: 16px;
        border-top-color: color-mix(in srgb, var(--accent, #4f7cff) 30%, #ffffff);
        animation-duration: 2.0s;
    }
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
    .card.complete .spinner .orb { animation-play-state: paused; opacity: 0.5; }

    .title {
        font-size: 17px;
        font-weight: 600;
        color: var(--text-primary, #1a1a1c);
        margin-bottom: 10px;
        letter-spacing: -0.01em;
    }

    .counts {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        margin-bottom: 14px;
        color: var(--text-secondary, #4a4a4e);
        font-variant-numeric: tabular-nums;
    }
    .counts .big {
        font-size: 30px;
        font-weight: 700;
        color: var(--text-primary, #1a1a1c);
        letter-spacing: -0.02em;
    }
    .counts .total {
        color: var(--text-tertiary, #8a8a8e);
        font-weight: 600;
    }
    .counts .of { font-size: 13px; color: var(--text-tertiary, #8a8a8e); }
    .counts .failed {
        font-size: 12px;
        color: var(--danger, #d6515b);
        margin-left: 6px;
    }

    .bar {
        position: relative;
        height: 10px;
        border-radius: 5px;
        background: color-mix(in srgb, var(--text-tertiary, #6c6c70) 16%, transparent);
        overflow: hidden;
        margin: 0 auto 10px;
    }
    .fill {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        background: linear-gradient(90deg,
            var(--accent, #4f7cff),
            color-mix(in srgb, var(--accent, #4f7cff) 60%, #ffffff));
        transition: width 220ms cubic-bezier(0.22, 1, 0.36, 1);
        box-shadow: 0 0 12px color-mix(in srgb, var(--accent, #4f7cff) 60%, transparent);
        border-radius: inherit;
    }
    .stripes {
        position: absolute;
        inset: 0;
        background-image: repeating-linear-gradient(
            -45deg,
            rgba(255, 255, 255, 0.18) 0,
            rgba(255, 255, 255, 0.18) 6px,
            transparent 6px,
            transparent 14px
        );
        animation: stripe-slide 1.2s linear infinite;
        pointer-events: none;
        mix-blend-mode: overlay;
    }
    @keyframes stripe-slide {
        from { background-position: 0 0; }
        to   { background-position: 28px 0; }
    }
    .card.complete .stripes { animation-play-state: paused; opacity: 0.3; }

    .pct {
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        color: var(--text-tertiary, #8a8a8e);
        margin-bottom: 14px;
    }

    .hint {
        font-size: 12px;
        color: var(--text-tertiary, #8a8a8e);
        margin: 0;
    }

    :global(html.dark) .bulk-overlay,
    :global([data-theme="dark"]) .bulk-overlay {
        background: color-mix(in srgb, #000 50%, transparent);
    }
    :global(html.dark) .card,
    :global([data-theme="dark"]) .card {
        background: color-mix(in srgb, #1f2128 92%, transparent);
        border-color: color-mix(in srgb, var(--accent, #4f7cff) 20%, rgba(255, 255, 255, 0.08));
    }

    @media (prefers-reduced-motion: reduce) {
        .bulk-overlay,
        .card,
        .stripes,
        .spinner .orb,
        .card::before {
            animation: none !important;
        }
        .fill { transition: none; }
    }
</style>
