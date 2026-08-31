<script lang="ts">
    // Frosted-glass "we'll be back in a moment" panel that pops over the
    // SPA when the server stops answering. Polls /health on a
    // 10s interval (the actual polling lives in lib/server-health, this
    // component just listens). Also offers a "browse cached emails"
    // dropdown so the user can keep skimming what was loaded into
    // ui.messages while the backend is unreachable.

    import Icon from './Icon.svelte';
    import { serverHealth } from '../lib/server-health.svelte';
    import { ui } from '../lib/store.svelte';
    import { senderShort } from '../lib/format';

    let cachedOpen = $state(false);
    let now = $state(Date.now());
    // Tick once a second so the "checking again in Xs" countdown stays
    // accurate. Cheap; only runs while the overlay is mounted.
    $effect(() => {
        if (!serverHealth.down) return;
        const t = setInterval(() => { now = Date.now(); }, 1000);
        return () => clearInterval(t);
    });

    const lastSeenAgo = $derived.by(() => {
        if (!serverHealth.lastOkAt) return 'never';
        const sec = Math.max(0, Math.round((now - serverHealth.lastOkAt) / 1000));
        if (sec < 60) return `${sec}s ago`;
        if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
        return `${Math.round(sec / 3600)}h ago`;
    });

    const nextProbeIn = $derived.by(() => {
        if (!serverHealth.lastProbeAt) return '…';
        const sec = Math.max(0, 10 - Math.round((now - serverHealth.lastProbeAt) / 1000));
        return `${sec}s`;
    });

    // Limit to the most recent 50 visible items so the dropdown stays
    // light. We don't try to load anything else while we're down — the
    // whole point is "show what you've already got."
    const cachedMessages = $derived(ui.messages.slice(0, 50));
</script>

{#if serverHealth.down}
    <div class="maint-overlay" role="dialog" aria-modal="true" aria-label="Server maintenance" data-testid="maintenance-overlay">
        <div class="maint-card glass">
            <div class="maint-icon-wrap" aria-hidden="true">
                <span class="orb orb-1"></span>
                <span class="orb orb-2"></span>
                <span class="orb orb-3"></span>
                <span class="maint-icon"><Icon name="cloudOff" size={32} /></span>
            </div>
            <h2>We're tuning the engine</h2>
            <p class="muted">The mail server isn't answering right now. We'll keep checking — no need to refresh.</p>

            <div class="maint-meta muted small">
                <span><Icon name="clock" size={11} /> Last seen: {lastSeenAgo}</span>
                <span><Icon name="refreshCw" size={11} /> Next check in {nextProbeIn}</span>
            </div>

            {#if cachedMessages.length}
                <button
                    type="button"
                    class="cached-toggle"
                    onclick={() => (cachedOpen = !cachedOpen)}
                    aria-expanded={cachedOpen}
                    data-testid="maintenance-cached-toggle"
                >
                    <Icon name="inbox" size={12} />
                    {cachedOpen ? 'Hide' : `Browse ${cachedMessages.length} cached emails`}
                </button>
                {#if cachedOpen}
                    <ul class="cached-list" data-testid="maintenance-cached-list">
                        {#each cachedMessages as m (m.uid)}
                            {@const isUnread = !m.flags.includes('\\Seen')}
                            <li class="cached-row" class:unread={isUnread}>
                                <span class="cached-from truncate">{senderShort(m.envelope.from)}</span>
                                <span class="cached-subj truncate">{m.envelope.subject || '(no subject)'}</span>
                            </li>
                        {/each}
                    </ul>
                    <p class="muted xs">Read-only — actions resume when the server is back.</p>
                {/if}
            {/if}
        </div>
    </div>
{/if}

<style>
    .maint-overlay {
        position: fixed;
        inset: 0;
        z-index: 5000;
        display: grid;
        place-items: center;
        padding: 20px;
        /* Frosted-glass scrim. backdrop-filter is the magic — falls back
           to a plain rgba background where unsupported. */
        background: rgba(20, 22, 30, 0.55);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        backdrop-filter: blur(14px) saturate(140%);
        animation: maint-fade-in 240ms ease-out;
    }
    .maint-card {
        max-width: 420px;
        width: 100%;
        padding: 26px 28px;
        text-align: center;
        border-radius: 18px;
        background: color-mix(in srgb, var(--bg-elevated) 92%, white);
        border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border-subtle));
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
        color: var(--text-primary);
    }
    .maint-card.glass {
        background: linear-gradient(
            145deg,
            color-mix(in srgb, var(--bg-elevated) 88%, white) 0%,
            color-mix(in srgb, var(--accent) 8%, var(--bg-elevated)) 100%
        );
    }
    .maint-card h2 {
        margin: 12px 0 6px;
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.01em;
    }
    .maint-card p { margin: 0 0 12px; font-size: 13.5px; line-height: 1.5; }

    /* Animated icon — three orbs orbiting a central cloud-off glyph. */
    .maint-icon-wrap {
        position: relative;
        width: 84px;
        height: 84px;
        margin: 0 auto;
        display: grid;
        place-items: center;
    }
    .maint-icon {
        position: relative;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface));
        color: var(--accent-text);
        box-shadow: 0 4px 16px color-mix(in srgb, var(--accent) 28%, transparent);
        animation: maint-icon-pulse 2s ease-in-out infinite;
    }
    .orb {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 10px; height: 10px;
        margin: -5px 0 0 -5px;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 60%, transparent);
        animation: maint-orbit 3s linear infinite;
    }
    .orb-1 { animation-delay: 0s;    background: var(--accent); }
    .orb-2 { animation-delay: -1s;   background: #d268f4; }
    .orb-3 { animation-delay: -2s;   background: #3b82f6; }
    @keyframes maint-orbit {
        from { transform: rotate(0deg) translateX(36px) rotate(0deg); opacity: 0.8; }
        50%  { opacity: 1; }
        to   { transform: rotate(360deg) translateX(36px) rotate(-360deg); opacity: 0.8; }
    }
    @keyframes maint-icon-pulse {
        0%, 100% { transform: scale(1); }
        50%      { transform: scale(1.07); }
    }
    @keyframes maint-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
    }

    .maint-meta {
        display: flex;
        justify-content: center;
        gap: 14px;
        flex-wrap: wrap;
        margin-bottom: 14px;
        font-variant-numeric: tabular-nums;
    }
    .maint-meta span { display: inline-flex; align-items: center; gap: 4px; }

    .cached-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 14px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--accent-text);
        background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface));
        border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        border-radius: 999px;
        cursor: pointer;
    }
    .cached-toggle:hover { background: color-mix(in srgb, var(--accent) 22%, var(--bg-surface)); }

    .cached-list {
        list-style: none;
        margin: 12px 0 6px;
        padding: 0;
        text-align: left;
        max-height: 220px;
        overflow-y: auto;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: var(--bg-surface);
    }
    .cached-row {
        display: grid;
        grid-template-columns: 110px 1fr;
        gap: 8px;
        align-items: baseline;
        padding: 7px 10px;
        font-size: 12px;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border-subtle);
    }
    .cached-row:last-child { border-bottom: none; }
    .cached-row.unread { color: var(--text-primary); font-weight: 600; }
    .cached-from { color: var(--text-tertiary); font-size: 11px; }
    .cached-subj { font-size: 12px; }
    .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .xs { font-size: 11px; margin-top: 6px; }

    @media (prefers-reduced-motion: reduce) {
        .orb, .maint-icon { animation: none; }
    }
</style>
