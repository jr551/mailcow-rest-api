<script lang="ts">
    // Global floating indicator for active AI background tasks.
    // Mounts once at the top level of each shell (desktop Layout +
    // mobile App). When ≥1 task is running, renders a draggable glass
    // pill near the bottom-right showing the running task's
    // description, an animated spinner, and a cancel button. Hidden
    // entirely when no tasks are active.
    //
    // Why global: previously the indicator only showed inside the AI
    // chat surface, so the user lost sight of running work the moment
    // they switched to inbox/calendar/etc.

    import { backgroundTasks, cancelBackgroundTask } from '../lib/background-tasks.svelte';
    import { aiState } from '../lib/ai-threads.svelte';
    import { ui } from '../lib/store.svelte';
    import { toolDisplay } from '../lib/tool-icons';

    let tasks = $derived(backgroundTasks().active);

    // Tap the pill to jump to the originating chat thread. Mobile and
    // desktop have different routing primitives — sniff the URL to
    // decide which surface to drive.
    function openTaskThread(threadId: string) {
        aiState.activeId = threadId;
        if (typeof window !== 'undefined' && window.location.pathname.startsWith('/webmail/mobile/')) {
            void import('../mobile/lib/store.svelte').then((m) => m.navigate('ai')).catch(() => { /* noop */ });
        } else {
            ui.app = 'ai';
        }
    }

    // Elapsed timer ticks every 5 s — cheap, and fast enough that the
    // pill feels live. Using $state so the derived label reactively
    // re-renders even though we're polling a wall clock.
    let now = $state(Date.now());
    $effect(() => {
        if (!tasks.length) return;
        const t = setInterval(() => { now = Date.now(); }, 5_000);
        return () => clearInterval(t);
    });

    function elapsed(startedAt: number): string {
        const s = Math.max(0, Math.round((now - startedAt) / 1000));
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        return `${m}m ${s % 60}s`;
    }
</script>

{#if tasks.length}
    <div class="bg-floater" role="status" aria-live="polite" data-testid="bg-task-floater">
        {#each tasks as t (t.id)}
            <!-- Outer is a div (not button) so the inner Cancel button
                 isn't a nested-button HTML violation. role+tabindex+
                 keypress give it the same a11y as a real button. -->
            <div
                class="bg-pill"
                role="button"
                tabindex="0"
                aria-label="Open background task"
                onclick={() => openTaskThread(t.threadId)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTaskThread(t.threadId); } }}
            >
                <span class="orb" aria-hidden="true">
                    <span class="orb-ring"></span>
                    <span class="orb-core">✨</span>
                </span>
                <span class="pill-text">
                    <span class="pill-title">{t.description || 'AI working…'}</span>
                    <span class="pill-sub">
                        {#if t.currentTool && t.currentTool !== 'starting…'}
                            {toolDisplay(t.currentTool).label} · {elapsed(t.startedAt)}
                        {:else}
                            {elapsed(t.startedAt)} · tap to view
                        {/if}
                    </span>
                </span>
                <button
                    type="button"
                    class="cancel-btn"
                    aria-label="Cancel background task"
                    onclick={(e) => { e.stopPropagation(); cancelBackgroundTask(t.id); }}
                >×</button>
            </div>
        {/each}
    </div>
{/if}

<style>
    .bg-floater {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 90;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
        max-width: calc(100vw - 32px);
    }
    .bg-pill {
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px 8px 8px;
        background: linear-gradient(135deg,
            color-mix(in srgb, #8b5cf6 22%, var(--bg-surface, #fff)),
            color-mix(in srgb, #6366f1 14%, var(--bg-surface, #fff)));
        color: var(--text-primary, #111);
        border: 1px solid color-mix(in srgb, #8b5cf6 35%, var(--border-subtle, #ccc));
        border-radius: 999px;
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        box-shadow:
            0 6px 24px color-mix(in srgb, #6366f1 25%, transparent),
            0 0 0 1px color-mix(in srgb, #8b5cf6 16%, transparent) inset;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
        transition: transform 0.18s ease, box-shadow 0.18s ease;
        max-width: 360px;
        appearance: none;
        text-align: left;
    }
    .bg-pill:hover {
        transform: translateY(-1px);
        box-shadow:
            0 10px 32px color-mix(in srgb, #6366f1 32%, transparent),
            0 0 0 1px color-mix(in srgb, #8b5cf6 28%, transparent) inset;
    }
    .orb {
        position: relative;
        width: 26px;
        height: 26px;
        flex: 0 0 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
    .orb-ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid transparent;
        border-top-color: #c4b5fd;
        border-right-color: #818cf8;
        animation: orb-spin 1.1s linear infinite;
    }
    .orb-core {
        font-size: 13px;
        line-height: 1;
        animation: orb-pulse 2.4s ease-in-out infinite;
    }
    @keyframes orb-spin { to { transform: rotate(360deg); } }
    @keyframes orb-pulse {
        0%, 100% { transform: scale(1); opacity: 0.95; }
        50%      { transform: scale(1.18); opacity: 1; }
    }
    .pill-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
        line-height: 1.2;
    }
    .pill-title {
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 240px;
    }
    .pill-sub {
        font-size: 10.5px;
        color: color-mix(in srgb, var(--text-secondary, #666) 90%, transparent);
        margin-top: 1px;
    }
    .cancel-btn {
        appearance: none;
        background: transparent;
        border: none;
        color: color-mix(in srgb, currentColor 70%, transparent);
        font-size: 18px;
        line-height: 1;
        padding: 2px 6px;
        cursor: pointer;
        border-radius: 50%;
        transition: background 0.15s ease, color 0.15s ease;
    }
    .cancel-btn:hover {
        background: color-mix(in srgb, currentColor 14%, transparent);
        color: currentColor;
    }

    @media (prefers-reduced-motion: reduce) {
        .orb-ring, .orb-core { animation: none; }
        .bg-pill:hover { transform: none; }
    }

    /* Mobile: nudge it up above the bottom nav. */
    @media (max-width: 640px) {
        .bg-floater {
            right: 12px;
            bottom: 76px;
        }
        .bg-pill {
            font-size: 12px;
            padding: 7px 8px 7px 6px;
        }
        .pill-title { max-width: 180px; }
    }
</style>
