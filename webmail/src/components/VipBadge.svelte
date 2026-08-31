<script lang="ts">
    // Family-icon badge in the corner of an avatar when a VIP address
    // (defined in Settings) is involved. The wrapper around the avatar
    // also gets a soft neon ring (.vip-glow) so VIP rows stand out
    // without being shouty. Hovering the ring or the badge surfaces
    // a tooltip identifying the matching VIP address.
    interface Props {
        match: string;          // the VIP address that matched
        direction: 'to' | 'from';
        size?: number;          // badge size in px
    }
    let { match, direction, size = 14 }: Props = $props();

    let tooltip = $derived(
        direction === 'to'
            ? `Sent to ${match} — VIP account`
            : `From ${match} — VIP account`
    );
</script>

<!-- The glow is a decorative ring around the avatar. It carried the same
     aria-label as the badge below, so assistive tech announced the one
     visible concept twice. It keeps `title` for the mouse tooltip and is
     hidden from the accessibility tree; the badge is the single
     accessible name. -->
<span
    class="vip-glow {direction === 'to' ? 'glow-to' : 'glow-from'}"
    title={tooltip}
    aria-hidden="true"
></span>
<span
    class="vip-badge"
    style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.78)}px;"
    title={tooltip}
    role="img"
    aria-label={tooltip}
>
    <span aria-hidden="true">👨‍👩‍👧</span>
</span>

<style>
    .vip-glow {
        position: absolute;
        inset: -3px;
        border-radius: 50%;
        pointer-events: auto;
        z-index: 1;
        cursor: help;
        animation: vip-pulse 3.4s ease-in-out infinite;
    }
    /* Two flavours so 'sent to' vs 'from' read at a glance, but
       both stay subtle enough to coexist with avatars. */
    .vip-glow.glow-from {
        box-shadow:
            0 0 0 1.5px rgba(255, 122, 69, 0.55),
            0 0 8px 2px rgba(255, 200, 90, 0.55),
            0 0 14px 4px rgba(255, 130, 70, 0.32);
    }
    .vip-glow.glow-to {
        box-shadow:
            0 0 0 1.5px rgba(120, 180, 255, 0.55),
            0 0 8px 2px rgba(150, 200, 255, 0.55),
            0 0 14px 4px rgba(80, 140, 240, 0.32);
    }
    @keyframes vip-pulse {
        0%, 100% { opacity: 0.85; transform: scale(1); }
        50%      { opacity: 1;    transform: scale(1.04); }
    }
    @media (prefers-reduced-motion: reduce) {
        .vip-glow { animation: none; }
    }

    .vip-badge {
        position: absolute;
        right: -3px;
        bottom: -3px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #ffd86b, #ff7a45);
        color: #fff;
        border-radius: 50%;
        line-height: 1;
        box-shadow:
            0 0 0 2px var(--bg-canvas, #fff),
            0 0 6px 1px rgba(255, 130, 70, 0.55);
        z-index: 3;
        pointer-events: auto;
        cursor: help;
    }
</style>
