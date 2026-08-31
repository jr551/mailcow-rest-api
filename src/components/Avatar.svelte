<script lang="ts">
    // Renders a sender avatar. Resolution chain: Gravatar → simple-icons
    // brand glyph → domain favicon → coloured initial. The resolver is
    // async — first paint shows the initial placeholder; if a remote
    // image loads we swap to it. Cached so subsequent renders are instant.

    import { resolveAvatar, avatarSync, type AvatarRecord } from '../lib/avatars.svelte';

    interface Props {
        email: string | null | undefined;
        name?: string | null;
        size?: number;
        title?: string;
    }
    let { email, name = null, size = 32, title }: Props = $props();

    let rec = $state<AvatarRecord>(avatarSync(email || '', name));
    let imgFailed = $state(false);

    $effect(() => {
        if (!email) return;
        let cancelled = false;
        rec = avatarSync(email, name);
        imgFailed = false;
        resolveAvatar({ email, name, size }).then((r) => {
            if (!cancelled) rec = r;
        }).catch(() => {});
        return () => { cancelled = true; };
    });

    let isBrandGlyph = $derived(rec.kind === 'simpleicon');
    let isFavicon = $derived(rec.kind === 'favicon');
    // Gravatar photos get the silhouette treatment too unless the user
    // explicitly uploaded their own (stored as `data:` URL — kept as-is so
    // their face shows). Result: a wall of message rows reads uniformly.
    let isUserChosen = $derived(!!rec.url && rec.url.startsWith('data:'));
    let isGravatar = $derived(rec.kind === 'gravatar' && !isUserChosen);
    let isMasked = $derived((isBrandGlyph || isFavicon || isGravatar) && !imgFailed && !!rec.url);
    let style = $derived.by(() => {
        const dims = `width: ${size}px; height: ${size}px;`;
        if (rec.kind === 'initials' || imgFailed) {
            // Grey silhouette fallback — matches the brand-glyph tiles so
            // the inbox reads uniformly even when no icon is found.
            return `${dims} background: var(--bg-surface-alt, #ececef); border: 1px solid var(--border-subtle, rgba(0,0,0,0.08)); color: var(--text-secondary, #4a4a4e);`;
        }
        if (isMasked && rec.url) {
            // Hand the image URL to the pseudo-element through a CSS var.
            // The pseudo-element uses it as a mask so only the alpha
            // channel paints — guarantees a clean charcoal silhouette
            // regardless of the source's palette or transparency.
            return `${dims} --icon-url: url("${rec.url.replace(/"/g, '\\"')}");`;
        }
        return dims;
    });
    let fontSize = $derived(`${Math.max(10, Math.round(size * 0.42))}px`);
</script>

<span
    class={`avatar ${isMasked ? 'brand' : ''}`}
    {style}
    title={title || (email || undefined)}
    aria-label={name || email || 'avatar'}
>
    {#if isMasked}
        <!-- Preload the image so the cache is warm + onerror still fires
             for broken URLs; the pseudo-element does the actual paint. -->
        <img
            src={rec.url}
            alt=""
            loading="lazy"
            decoding="async"
            class="probe"
            onerror={() => (imgFailed = true)}
        />
    {:else if rec.url && !imgFailed}
        <img
            src={rec.url}
            alt=""
            loading="lazy"
            decoding="async"
            onerror={() => (imgFailed = true)}
        />
    {:else}
        <!-- Person silhouette fallback. We used to show a letter or digit
             here, but those clashed with the silhouette-style brand glyphs
             (especially on senders whose first char was a number). The
             deterministic background colour from avatarSync still gives
             per-sender differentiation. -->
        <svg
            class="silhouette"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            style="width: {Math.round(size * 0.62)}px; height: {Math.round(size * 0.62)}px;"
        >
            <path
                d="M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 1.8c-3.3 0-7 1.65-7 4.95v.45c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-.45c0-3.3-3.7-4.95-7-4.95Z"
                fill="currentColor"
            />
        </svg>
    {/if}
</span>

<style>
    .avatar {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        border-radius: 50%;
        overflow: hidden;
        color: #fff;
        font-weight: 600;
        line-height: 1;
        user-select: none;
        position: relative;
    }
    .avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }
    .initial { letter-spacing: 0; }
    .silhouette {
        opacity: 0.92;
        flex-shrink: 0;
    }

    /* Silhouette variant for simple-icons brand glyphs + domain favicons.
     * The pseudo-element below is the actual glyph: it uses the image URL
     * as a CSS mask, so only the alpha channel paints — guarantees a clean
     * charcoal shape no matter the source's native palette or rectangular
     * background. The .probe <img> is hidden but kept in the tree so onerror
     * still fires when the URL is broken (we fall back to initials then). */
    .avatar.brand {
        background: var(--bg-surface-alt, #ececef);
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
    }
    .avatar.brand img.probe {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
    }
    .avatar.brand::after {
        content: '';
        position: absolute;
        inset: 22%;
        background-color: var(--text-secondary, #4a4a4e);
        -webkit-mask-image: var(--icon-url);
        mask-image: var(--icon-url);
        -webkit-mask-repeat: no-repeat;
        mask-repeat: no-repeat;
        -webkit-mask-position: center;
        mask-position: center;
        -webkit-mask-size: contain;
        mask-size: contain;
        /* Most favicons / gravatars are full-opacity rectangles (no alpha
         * channel), so the default mask-mode: alpha would paint the whole
         * tile solid and the silhouette never emerges. Switching to
         * luminance uses pixel brightness instead — dark logo on light bg
         * yields the actual brand shape. White-on-dark logos invert (rare;
         * they end up as a "hole" outline), but most senders look right. */
        -webkit-mask-mode: luminance;
        mask-mode: luminance;
    }
    /* Tiny safety net: if mask-image fails entirely (some browsers drop ICO
     * silently), the ::after collapses to zero-area and we get a blank
     * circle. Render a faint diagonal ghost mark so the tile never looks
     * empty — the silhouette path stays preferred when it works. */
    .avatar.brand::before {
        content: '';
        position: absolute;
        inset: 30%;
        background:
            linear-gradient(135deg,
                color-mix(in srgb, var(--text-tertiary) 35%, transparent),
                transparent 60%);
        border-radius: 4px;
        z-index: 0;
    }
    .avatar.brand::after { z-index: 1; }
    :global(html.dark) .avatar.brand,
    :global([data-theme="dark"]) .avatar.brand {
        background: var(--bg-surface-alt, #2a2a2e);
    }
    :global(html.dark) .avatar.brand::after,
    :global([data-theme="dark"]) .avatar.brand::after {
        background-color: var(--text-secondary, #d8d8de);
    }
</style>
