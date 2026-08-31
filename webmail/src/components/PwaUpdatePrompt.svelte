<script lang="ts">
    // Toast that appears when the SW detects a new version is waiting
    // to take over. Driven by pwa.updateAvailable. The user gets a
    // single "Refresh now" button — clicking it posts SKIP_WAITING to
    // the waiting worker, which triggers controllerchange and a soft
    // reload. "Later" hides the toast for this session; the prompt
    // re-appears on the next 30-min update poll if the new SW is
    // still waiting.

    import { pwa, applyPwaUpdate } from '../lib/pwa.svelte';

    let dismissed = $state(false);
    let visible = $derived(pwa.updateAvailable && !dismissed);
    let updating = $state(false);

    function refreshNow() {
        updating = true;
        applyPwaUpdate();
    }
</script>

{#if visible}
    <div class="upd" role="status" aria-live="polite" data-testid="pwa-update-prompt">
        <span class="upd-orb" aria-hidden="true">
            <span class="upd-orb-ring"></span>
            <span class="upd-orb-core">⟲</span>
        </span>
        <span class="upd-text">
            <strong>Update available</strong>
            <span class="upd-sub">A new build is ready. Refresh to apply.</span>
        </span>
        <button type="button" class="upd-btn" onclick={refreshNow} disabled={updating}>
            {updating ? 'Updating…' : 'Refresh now'}
        </button>
        <button type="button" class="upd-dismiss" aria-label="Later" onclick={() => dismissed = true}>×</button>
    </div>
{/if}

<style>
    .upd {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        z-index: 95;
        display: inline-flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px 10px 10px;
        max-width: calc(100vw - 32px);
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #334155 100%);
        color: #e0f2fe;
        border: 1px solid color-mix(in srgb, #38bdf8 30%, transparent);
        border-radius: 999px;
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        box-shadow:
            0 12px 30px rgba(15, 23, 42, 0.45),
            0 0 0 1px color-mix(in srgb, #38bdf8 14%, transparent) inset;
        font-size: 13px;
        animation: upd-in 320ms ease-out;
    }
    @keyframes upd-in {
        from { opacity: 0; transform: translate(-50%, 12px); }
        to   { opacity: 1; transform: translate(-50%, 0); }
    }
    .upd-orb {
        position: relative;
        width: 26px;
        height: 26px;
        flex: 0 0 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
    .upd-orb-ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid transparent;
        border-top-color: #7dd3fc;
        border-right-color: #38bdf8;
        animation: upd-spin 1.2s linear infinite;
    }
    .upd-orb-core {
        font-size: 13px;
        line-height: 1;
        opacity: 0.92;
    }
    @keyframes upd-spin { to { transform: rotate(360deg); } }
    .upd-text {
        display: flex;
        flex-direction: column;
        line-height: 1.2;
        min-width: 0;
    }
    .upd-text strong {
        font-weight: 600;
        font-size: 13px;
    }
    .upd-sub {
        font-size: 11.5px;
        color: color-mix(in srgb, #cbd5e1 90%, transparent);
        margin-top: 1px;
    }
    .upd-btn {
        appearance: none;
        background: linear-gradient(135deg, #38bdf8, #0ea5e9);
        color: #052438;
        font-weight: 600;
        font-size: 12.5px;
        border: none;
        border-radius: 999px;
        padding: 6px 14px;
        cursor: pointer;
        flex-shrink: 0;
        transition: filter 0.15s ease;
    }
    .upd-btn:hover { filter: brightness(1.08); }
    .upd-btn[disabled] { opacity: 0.7; cursor: progress; }
    .upd-dismiss {
        appearance: none;
        background: transparent;
        border: none;
        color: color-mix(in srgb, #e0f2fe 70%, transparent);
        font-size: 18px;
        line-height: 1;
        padding: 2px 6px;
        cursor: pointer;
        border-radius: 50%;
    }
    .upd-dismiss:hover {
        background: rgba(255,255,255,0.12);
        color: #f0f9ff;
    }
    @media (prefers-reduced-motion: reduce) {
        .upd-orb-ring { animation: none; }
        .upd { animation: none; }
    }
</style>
