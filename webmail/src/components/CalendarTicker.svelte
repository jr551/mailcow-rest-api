<script lang="ts">
    // Live event ticker for the desktop top bar. Slides events
    // horizontally like a stock ticker, with countdown / clock /
    // duration display modes. Click opens the calendar; the caret
    // (or right-click) opens an options menu.
    import { onMount } from 'svelte';
    import { listEvents, type CalEvent } from '../lib/calendar.svelte';
    import { ui } from '../lib/store.svelte';
    import { settings, setCalendarTickerTitles } from '../lib/settings.svelte';

    interface Props {
        rotateMs?: number;
        horizonDays?: number;
    }
    let { rotateMs = 4500, horizonDays = 14 }: Props = $props();

    let now = $state(new Date());
    let cursor = $state(0);
    let slideKey = $state(0);              // bumps on each rotation → drives the slide animation
    let menuOpen = $state(false);
    let menuX = $state(0);
    let menuY = $state(0);
    let triggerEl: HTMLButtonElement | null = $state(null);

    type Style = 'countdown' | 'clock' | 'duration';
    let style = $state<Style>(loadStyle());

    function loadStyle(): Style {
        try {
            const v = localStorage.getItem('webmail.calticker.style');
            if (v === 'countdown' || v === 'clock' || v === 'duration') return v;
        } catch { /* */ }
        return 'countdown';
    }
    function saveStyle(s: Style) {
        style = s;
        try { localStorage.setItem('webmail.calticker.style', s); } catch { /* */ }
    }

    // Tick `now` every 30s so countdown labels stay fresh.
    onMount(() => {
        const t = setInterval(() => { now = new Date(); }, 30 * 1000);
        return () => clearInterval(t);
    });

    let upcoming = $derived.by<CalEvent[]>(() => {
        // Only events whose start is at most 5 minutes in the past —
        // that fully avoids the "in -4060m" bug for multi-day all-day
        // events that the underlying listEvents() returns while still
        // ongoing.
        const cutoff = now.getTime() - 5 * 60 * 1000;
        const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);
        return listEvents({ from: now, to: horizon })
            .filter((e) => new Date(e.start).getTime() >= cutoff)
            .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
            .slice(0, 6);
    });

    let current = $derived<CalEvent | null>(upcoming[cursor % Math.max(1, upcoming.length)] ?? null);

    // Auto-rotate. Bump slideKey so the {#key} block re-renders the
    // pane with a fresh enter animation.
    $effect(() => {
        if (upcoming.length <= 1) { cursor = 0; return; }
        if (cursor >= upcoming.length) cursor = 0;
        const t = setInterval(() => {
            cursor = (cursor + 1) % upcoming.length;
            slideKey++;
        }, rotateMs);
        return () => clearInterval(t);
    });

    function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }

    // Hard-clamped relative — never returns a negative value. Anything
    // already started reads as "now" so the user never sees "-4060m"
    // again, no matter what slips through the upstream filter.
    function relative(start: Date): string {
        const ms = start.getTime() - now.getTime();
        if (ms <= 60_000) return 'now';
        const min = Math.round(ms / 60_000);
        if (min < 60) return `in ${min}m`;
        const hours = Math.round(min / 60);
        if (hours < 24) return `in ${hours}h`;
        const days = Math.round(hours / 24);
        if (days === 1) return 'tomorrow';
        return `in ${days}d`;
    }

    function clockOf(start: Date): string {
        const sameDay = start.toDateString() === now.toDateString();
        const hh = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (sameDay) return hh;
        const tom = new Date(now); tom.setDate(tom.getDate() + 1);
        if (start.toDateString() === tom.toDateString()) return `tmrw ${hh}`;
        return `${start.toLocaleDateString([], { weekday: 'short' })} ${hh}`;
    }

    function durationOf(start: Date, end: Date): string {
        const min = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
        if (min < 60) return `${min}m`;
        const h = Math.floor(min / 60);
        const m = min % 60;
        return m === 0 ? `${h}h` : `${h}h${pad(m)}`;
    }

    let label = $derived.by(() => {
        if (!current) return '';
        const start = new Date(current.start);
        const end = new Date(current.end);
        if (style === 'clock') return clockOf(start);
        if (style === 'duration') return durationOf(start, end);
        return relative(start);
    });

    // The header is on screen from Mail, AI, Drive and Settings, so an
    // event title here is visible during a screen share or to anyone
    // glancing over. Default to a count; the timing — the part that makes
    // the ticker useful — is still shown either way.
    let title = $derived(
        current
            ? (settings.calendarTickerTitles
                ? `${current.title || '(no title)'} — ${new Date(current.start).toLocaleString()}\n${upcoming.length} upcoming · ⌄ for options`
                : `${upcoming.length} upcoming ${upcoming.length === 1 ? 'event' : 'events'} · ⌄ for options`)
            : 'No upcoming events · ⌄ for options'
    );

    function openCalendar() {
        ui.app = 'calendar';
    }

    // Anchor the menu to the trigger button so it appears in a sane spot
    // for both right-click + caret-click. We measure on open instead of
    // tracking the rect reactively — the bar doesn't move mid-session.
    function openMenu(viaRightClick: boolean, e?: MouseEvent) {
        if (e) e.preventDefault();
        if (e && viaRightClick) {
            menuX = e.clientX;
            menuY = e.clientY;
        } else if (triggerEl) {
            const r = triggerEl.getBoundingClientRect();
            menuX = r.left;
            menuY = r.bottom + 6;
        } else {
            menuX = e?.clientX ?? 0;
            menuY = e?.clientY ?? 0;
        }
        // requestAnimationFrame defers the open by one paint so the
        // mousedown that triggered us doesn't immediately close the
        // menu via the document listener registered below.
        requestAnimationFrame(() => { menuOpen = true; });
    }

    function nextEvent() {
        if (upcoming.length === 0) return;
        cursor = (cursor + 1) % upcoming.length;
        slideKey++;
    }

    $effect(() => {
        if (!menuOpen) return;
        const onDoc = (e: MouseEvent) => {
            const tgt = e.target as HTMLElement;
            if (!tgt.closest('.cal-ticker-menu') && !tgt.closest('.cal-ticker') && !tgt.closest('.caret-btn')) menuOpen = false;
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') menuOpen = false; };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    });
</script>

<span class="cal-wrap">
    <button
        type="button"
        class="cal-ticker"
        bind:this={triggerEl}
        {title}
        onclick={openCalendar}
        oncontextmenu={(e) => openMenu(true, e)}
        aria-label={title}
        data-testid="calendar-ticker"
    >
        <span class="ic" aria-hidden="true">📅</span>
        {#if current}
            {#key slideKey}
                <span class="pane">
                    <span class="when">{label}</span>
                    <span class="t">{settings.calendarTickerTitles
                        ? (current.title || '(no title)')
                        : `${upcoming.length} upcoming ${upcoming.length === 1 ? 'event' : 'events'}`}</span>
                </span>
            {/key}
            {#if upcoming.length > 1}
                <span class="dots" aria-hidden="true">
                    {#each upcoming as _, i (i)}
                        <span class="dot" class:on={i === cursor % upcoming.length}></span>
                    {/each}
                </span>
            {/if}
        {:else}
            <span class="empty">No events</span>
        {/if}
    </button>
    <button
        type="button"
        class="caret-btn"
        title="Calendar options"
        aria-label="Calendar options"
        onclick={(e) => { e.stopPropagation(); openMenu(false, e); }}
        oncontextmenu={(e) => openMenu(true, e)}
    >
        ⌄
    </button>
</span>

{#if menuOpen}
    <div
        class="cal-ticker-menu"
        role="menu"
        style="left:{menuX}px; top:{menuY}px;"
    >
        <div class="menu-section">Display style</div>
        <button class="menu-item" class:active={style === 'countdown'} onclick={() => { saveStyle('countdown'); menuOpen = false; }}>
            ⏳ Countdown <span class="ex">in 3h</span>
        </button>
        <button class="menu-item" class:active={style === 'clock'} onclick={() => { saveStyle('clock'); menuOpen = false; }}>
            🕒 Clock <span class="ex">tmrw 09:00</span>
        </button>
        <button class="menu-item" class:active={style === 'duration'} onclick={() => { saveStyle('duration'); menuOpen = false; }}>
            ⏱ Duration <span class="ex">1h30</span>
        </button>
        <div class="menu-section">Privacy</div>
        <button
            class="menu-item"
            class:active={settings.calendarTickerTitles}
            onclick={() => { setCalendarTickerTitles(!settings.calendarTickerTitles); menuOpen = false; }}
        >
            {settings.calendarTickerTitles ? '🙈 Hide event titles' : '👁 Show event titles'}
            <span class="ex">{settings.calendarTickerTitles ? 'visible now' : 'hidden'}</span>
        </button>
        <div class="menu-section">Navigate</div>
        <button class="menu-item" onclick={() => { nextEvent(); menuOpen = false; }}>⏭ Next event</button>
        <button class="menu-item" onclick={() => { ui.app = 'calendar'; menuOpen = false; }}>📅 Open calendar</button>
    </div>
{/if}

<style>
    .cal-wrap {
        position: relative;
        display: inline-flex;
        /* stretch keeps the caret button locked to the same height as
         * the ticker pill — without this the caret can render a few px
         * shorter and the pill seam looks broken when the ticker grows
         * to fit a longer title. */
        align-items: stretch;
        gap: 0;
        /* Prevents the whole gadget from being squeezed when the
         * top-bar is crowded — squeezing makes the caret look like
         * it's detaching from the pill. */
        flex-shrink: 0;
    }
    .cal-ticker {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        font-size: 12px;
        line-height: 1.1;
        border-radius: 999px 0 0 999px;
        background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-surface-alt) 100%);
        color: var(--text-secondary, #4a4a4e);
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
        border-right: 0;
        max-width: 260px;
        min-width: 0;
        cursor: pointer;
        overflow: hidden;
        box-sizing: border-box;
    }
    .cal-ticker:hover { filter: brightness(1.03); }

    .caret-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 22px;
        /* Inherit height from the wrap (align-items: stretch) so the
         * pill seam stays flush no matter how tall the ticker grows. */
        padding: 0;
        background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-surface-alt) 100%);
        color: var(--text-tertiary, #6e6e72);
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
        border-left: 1px solid color-mix(in srgb, var(--text-tertiary, #6e6e72) 18%, transparent);
        border-radius: 0 999px 999px 0;
        cursor: pointer;
        font-size: 12px;
        box-sizing: border-box;
    }
    .caret-btn:hover { filter: brightness(0.96); color: var(--text-primary, #1a1a1c); }

    /* Light/dark and full-skin (cat/retro/etc.) overrides all flow
       through the --bg-surface / --bg-surface-alt vars, so no dark-mode
       hardcoded gradient is needed. */

    .ic { font-size: 14px; }

    /* The pane is keyed off `slideKey`, so a fresh element with the
     * .pane class enters every rotation — the keyframe gives it a
     * smooth slide-in from the right, ticker-style. */
    .pane {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        /* min-width: 0 lets the inner .t ellipsize cleanly when the
         * title is long. Without this the flex algorithm respects the
         * intrinsic min-content width of .t and the overflow leaks
         * past the rounded right edge into the caret button. */
        min-width: 0;
        flex: 1;
        animation: tick-in 460ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    @keyframes tick-in {
        from { transform: translateX(20px); opacity: 0; filter: blur(2px); }
        to   { transform: translateX(0);     opacity: 1; filter: blur(0); }
    }
    @media (prefers-reduced-motion: reduce) {
        .pane { animation: none; }
    }

    .when {
        font-variant-numeric: tabular-nums;
        color: var(--text-primary, #1a1a1c);
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--accent, #4f7cff) 12%, transparent);
    }
    .t {
        flex: 1;
        min-width: 0;
        max-width: 160px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .empty { font-style: italic; opacity: 0.7; }

    .dots {
        display: inline-flex;
        gap: 2px;
        align-items: center;
        margin-left: 2px;
    }
    .dot {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.25;
        transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .dot.on { opacity: 0.95; transform: scale(1.5); background: var(--accent, #4f7cff); }

    .cal-ticker-menu {
        position: fixed;
        z-index: 9999;
        background: var(--bg-surface, #fff);
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.1));
        border-radius: 10px;
        padding: 6px;
        min-width: 220px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
        font-size: 13px;
        display: flex;
        flex-direction: column;
    }
    .menu-section {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary, #8a8a8e);
        padding: 6px 8px 2px;
    }
    .menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 7px 10px;
        background: none;
        border: 0;
        border-radius: 6px;
        color: inherit;
        text-align: left;
        cursor: pointer;
        font: inherit;
    }
    .menu-item:hover { background: var(--bg-surface-alt, #f0f0f3); }
    .menu-item.active { background: color-mix(in srgb, var(--accent, #4f7cff) 15%, transparent); }
    .menu-item .ex { color: var(--text-tertiary, #888); font-variant-numeric: tabular-nums; font-size: 11px; }
</style>
