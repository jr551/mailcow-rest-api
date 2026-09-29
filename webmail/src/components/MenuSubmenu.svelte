<!--
    One submenu row + nested panel, shared by every menu that needs to hang a
    folder list off a trigger (message row context menu, MessageDetail's Move
    dropdown). Keeping ONE implementation means the hover intent timer, the
    keyboard contract and the edge-flipping geometry are literally the same
    code in both places — the alternative was two hand-rolled submenus that
    would drift apart within a week.

    Behaviour contract (both call sites rely on this being identical):

      Pointer — hovering the trigger opens the panel after a short intent
      delay, so sweeping the pointer down a menu doesn't strobe it open.
      Closing is deferred by a longer delay: the trigger and the panel are
      two separate boxes with a gap between them, so the pointer has to be
      allowed to travel that gap in either direction without the panel
      vanishing. Touch devices never hover, so the trigger is also a plain
      button — tapping it toggles the panel.
      Keyboard — the trigger is a real <button> with aria-haspopup="menu".
      Enter/Space/ArrowRight open AND move focus into the panel (pressing
      Enter to "open" something and leaving focus behind is the classic
      broken-submenu bug). ArrowDown/ArrowUp walk the list, Home/End jump,
      Escape or ArrowLeft close the SUBMENU ONLY, returning focus to the
      trigger and stopping propagation — which is what makes Escape a
      two-stage close rather than collapsing the whole parent menu on the
      first press.
      Geometry — the panel is position:fixed (host menus are overflow-y:auto
      and would otherwise clip it), measured after mount, flipped to the
      LEFT of the trigger when it would overflow the viewport's right edge,
      and clamped to the bottom edge so a long folder list scrolls instead of
      running off-screen.

    The panel lives INSIDE the trigger's <li> (so the host <ul role="menu">
    keeps valid list nesting) but is position:fixed, which is what keeps a
    host menu's `overflow-y: auto` from clipping it. Callers put this inside
    a `role="menu"` <ul>.
-->
<script lang="ts">
    import { tick } from 'svelte';
    import Icon from './Icon.svelte';
    import type { IconName } from '../lib/icons';

    export interface SubmenuItem {
        /** Stable key for the `{#each}` — use the folder path or an id. */
        key: string;
        label: string;
        disabled?: boolean;
    }

    interface Props {
        /** Trigger row text, e.g. "Move to…" or "Move 12 selected to…". */
        label: string;
        /** Optional leading glyph on the trigger row. */
        icon?: IconName;
        /** Full item list — rendered unbounded and scrolled, never truncated. */
        items: SubmenuItem[];
        /** Fired when an item is picked. The caller closes its own menu. */
        onSelect: (key: string) => void;
        /** Test id prefix; trigger, panel and every item are tagged from it. */
        testid: string;
        /**
         * Panel width in px. Matched to the host menu's own min-width so the
         * submenu reads as part of the same menu rather than a bolt-on.
         */
        width?: number;
        /**
         * Called every time the panel is about to open, after it has been
         * mounted. Lets a caller fetch a list lazily — the panel opening is
         * the first time anyone has asked for this data, so asking on mount
         * would be a request per page render for a menu most users never
         * touch.
         *
         * The panel opens immediately and renders whatever `items`
         * currently holds: this is a notification, not a gate. A caller
         * that wants a spinner refetches and mutates `items`, and the host
         * re-renders when the fetch resolves.
         */
        onOpen?: () => void;
        /**
         * Shown in place of the item list when there is nothing to pick —
         * "no webhooks configured", "not available on this server". An empty
         * panel with no explanation reads as a broken menu, and a broken
         * menu is worse than a menu that says why it has nothing.
         */
        emptyText?: string | null;
    }
    let { label, icon, items, onSelect, testid, width = 220, onOpen, emptyText = null }: Props = $props();

    let open = $state(false);
    let triggerEl = $state<HTMLButtonElement | null>(null);
    let panelEl = $state<HTMLUListElement | null>(null);
    // Resolved viewport position, set on open once the trigger has a rect.
    let panelPos = $state<{ left: number; top: number; maxHeight: number } | null>(null);

    // Hover intent. OPEN_DELAY stops the panel strobing open while the
    // pointer sweeps down the parent menu. CLOSE_DELAY only has to cover the
    // trip across the gap between trigger and panel, so it can afford to be
    // generous — a late close is unnoticeable, a premature one is not.
    const OPEN_DELAY = 120;
    const CLOSE_DELAY = 260;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;

    function clearTimers() {
        if (openTimer) { clearTimeout(openTimer); openTimer = null; }
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    }

    /**
     * Work out where the panel goes. Flips to the LEFT of the trigger when
     * the right edge would leave the viewport, and clamps its height so a
     * long folder list scrolls rather than running off the bottom. Measured
     * against the viewport, not the document, because the panel is fixed.
     */
    function place() {
        const t = triggerEl;
        if (!t) return;
        const r = t.getBoundingClientRect();
        const margin = 8;                  // breathing room at every edge
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Prefer opening to the right of the trigger; flip to the left when
        // that would push past the right edge. If neither side fits (narrow
        // viewport), clamp to the right-hand margin and let it overlay.
        let left = r.right + 4;
        if (left + width > vw - margin) {
            const flipped = r.left - width - 4;
            left = flipped >= margin ? flipped : Math.max(margin, vw - width - margin);
        }

        // Ideal height for the whole list; the panel then scrolls if the
        // viewport can't give it that much.
        const idealH = Math.min(items.length * 30 + 12, 320);
        const top = Math.min(Math.max(r.top - 4, margin), Math.max(margin, vh - idealH - margin));
        const maxHeight = Math.max(120, Math.min(320, vh - top - margin));

        panelPos = { left, top, maxHeight };
    }

    /** Open without touching focus (pointer path). */
    function openFromPointer() {
        clearTimers();
        if (open) return;
        open = true;
        place();
        // Fired AFTER `open = true` so a caller that refetches and mutates
        // `items` lands in a panel that is already mounted and will
        // re-render. Firing it before would swap the list out from under a
        // panel that had not measured itself yet.
        onOpen?.();
    }

    /** Open and drop focus into the list (keyboard / tap path). */
    async function openWithFocus() {
        openFromPointer();
        await tick();
        focusAt(0);
    }

    function hide(returnFocus = false) {
        clearTimers();
        if (!open) return;
        open = false;
        panelPos = null;
        if (returnFocus) triggerEl?.focus();
    }

    // ── hover intent ──────────────────────────────────────────────────────
    // Entering EITHER box cancels a pending close; leaving EITHER box starts
    // one. The trigger does double duty: if the panel is shut, leaving it
    // schedules nothing and entering it schedules the open instead.
    function onTriggerEnter() {
        clearTimers();
        if (!open) openTimer = setTimeout(openFromPointer, OPEN_DELAY);
    }
    function onTriggerLeave() {
        clearTimers();
        if (open) closeTimer = setTimeout(() => hide(), CLOSE_DELAY);
    }
    function onPanelEnter() {
        clearTimers();
    }
    function onPanelLeave() {
        clearTimers();
        closeTimer = setTimeout(() => hide(), CLOSE_DELAY);
    }

    // Re-place while open so the panel follows its trigger when the host
    // menu scrolls or the window resizes.
    //
    // `$effect`, NOT `onMount`: the panel can only open from a hover/click
    // handler that runs after mount, so at mount time `open` is always
    // false. An onMount guard therefore never registered the listeners at
    // all, and the panel silently stayed pinned to its first position while
    // the host menu scrolled under it. Tracking `open` re-runs the effect on
    // every open/close, so the listeners exist exactly while the panel does.
    $effect(() => {
        if (!open) return;
        const reposition = () => place();
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    });

    // Re-measure when the folder list grows (mailboxes still loading).
    $effect(() => {
        void items.length;
        if (open) place();
    });

    function panelButtons(): HTMLButtonElement[] {
        return Array.from(panelEl?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    }

    function focusAt(i: number) {
        const b = panelButtons();
        if (b.length) b[Math.max(0, Math.min(i, b.length - 1))].focus();
    }

    function onTriggerKeydown(e: KeyboardEvent) {
        switch (e.key) {
            case 'Enter':
            case ' ':
            case 'ArrowRight':
                e.preventDefault();
                void openWithFocus();
                break;
            case 'ArrowDown':
            case 'ArrowUp': {
                // The host menu owns the walk — except that MessageList's
                // walk deliberately skips everything inside .submenu (so it
                // cannot yank focus out of an open panel), and MessageDetail's
                // Move menu has no walk at all. Left unhandled, the key then
                // reached Layout's document handler, which moves the message
                // selection behind the open menu. So the trigger owns these
                // two: walk the panel when it is open, the host menu when it
                // is not.
                e.preventDefault();
                e.stopPropagation();
                if (open) {
                    focusAt(e.key === 'ArrowDown' ? 0 : panelButtons().length - 1);
                    break;
                }
                const host = triggerEl?.closest('[role="menu"]');
                const items = Array.from(
                    host?.querySelectorAll<HTMLElement>('button[role="menuitem"]:not(:disabled)') ?? []
                );
                const at = triggerEl ? items.indexOf(triggerEl) : -1;
                if (at === -1) break;
                const step = e.key === 'ArrowDown' ? 1 : -1;
                items[(at + step + items.length) % items.length]?.focus();
                break;
            }
            case 'Escape':
                // Escape on an ALREADY-OPEN submenu is consumed here. On a
                // closed one it is deliberately not intercepted, so it
                // bubbles to the parent menu's own Escape handling.
                if (open) { e.preventDefault(); e.stopPropagation(); hide(true); }
                break;
            case 'Tab':
                // Tab is not a menu key. Per the APG menu pattern it leaves
                // the widget for the next element in the page tab sequence
                // and CLOSES the menu on the way out. Unhandled, it walked
                // focus off the trigger while the panel stayed painted —
                // an orphaned submenu nothing could dismiss but a click.
                if (open) hide();
                break;
        }
    }

    function onPanelKeydown(e: KeyboardEvent) {
        const buttons = panelButtons();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        // stopPropagation on the arrow keys, not just preventDefault: the
        // host page (Layout) registers a bubble-phase keydown on document
        // that moves the message selection on ArrowUp/ArrowDown. These keys
        // belong to the submenu while it's open — without the stop, one
        // ArrowDown both advanced the folder list and changed the message
        // open behind it.
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                e.stopPropagation();
                if (i === -1) focusAt(0); else focusAt(i + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                e.stopPropagation();
                // Up from the first item returns to the trigger, which is
                // how a user backs out of a submenu without reaching for
                // Escape.
                if (i <= 0) triggerEl?.focus(); else focusAt(i - 1);
                break;
            case 'Home':
                e.preventDefault();
                e.stopPropagation();
                focusAt(0);
                break;
            case 'End':
                e.preventDefault();
                e.stopPropagation();
                focusAt(buttons.length - 1);
                break;
            case 'ArrowRight':
                // No nested level below this one — swallow it so the host
                // page doesn't treat it as "next pane".
                e.preventDefault();
                break;
            case 'Tab':
                // Same contract as on the trigger, and the case that
                // actually bites: every panel item is tabindex="-1", so Tab
                // jumps straight past the panel to whatever is next in the
                // document. Close first so it doesn't stay behind.
                // Deliberately NOT preventDefault/stopPropagation — Tab has
                // to keep travelling for the user to land anywhere.
                hide();
                break;
            case 'Escape':
            case 'ArrowLeft':
                // Close the SUBMENU only, focus back on the trigger, and stop
                // propagation — that stop is what makes Escape two-stage.
                e.preventDefault();
                e.stopPropagation();
                hide(true);
                break;
            default:
                // Enter and Space are left alone so the focused button's own
                // click handler runs.
                break;
        }
    }

    function pick(key: string) {
        hide();
        onSelect(key);
    }
</script>

<!-- The panel lives INSIDE the trigger's <li> so the host <ul role="menu">
     keeps valid list nesting — but the panel is position:fixed, so it
     escapes the host menu's overflow-y: auto and stacking context anyway. -->
<!-- `data-submenu-open` lets a HOST menu ask whether the panel is showing
     without owning any of this component's state. MessageList needs exactly
     that: its window-level capture-phase Escape handler runs BEFORE this
     component's own handler, so without the attribute the first Escape
     would close the whole context menu instead of just the submenu.
     Reflects hover-open too, since the user can press Escape with the panel
     open but the trigger not focused. -->
<li class="submenu" class:open role="none" data-submenu-open={open ? 'true' : undefined}>
    <button
        type="button"
        class="submenu-trigger"
        bind:this={triggerEl}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onmouseenter={onTriggerEnter}
        onmouseleave={onTriggerLeave}
        onclick={(e) => {
            // Host menus close on any window click (MessageList binds
            // closeCtx straight to <svelte:window>). Without this stop the
            // toggle would open the panel and immediately be torn down by
            // the same click.
            e.stopPropagation();
            if (open) hide(true);
            else void openWithFocus();
        }}
        onkeydown={onTriggerKeydown}
        data-testid={testid + '-trigger'}
    >
        {#if icon}<Icon name={icon} size={12} />{/if}
        <span class="submenu-label">{label}</span>
        <span class="submenu-chevron" aria-hidden="true"><Icon name="chevronRight" size={13} /></span>
    </button>

    {#if open && panelPos}
        <ul
            class="submenu-panel"
            role="menu"
            aria-label={label}
            bind:this={panelEl}
            style="left:{panelPos.left}px; top:{panelPos.top}px; max-height:{panelPos.maxHeight}px; width:{width}px;"
            onmouseenter={onPanelEnter}
            onmouseleave={onPanelLeave}
            onkeydown={onPanelKeydown}
            onclick={(e) => e.stopPropagation()}
            data-testid={testid + '-panel'}
        >
            {#each items as it (it.key)}
                <li role="none">
                    <button
                        type="button"
                        role="menuitem"
                        disabled={it.disabled}
                        tabindex="-1"
                        onclick={() => pick(it.key)}
                        data-testid={testid + '-item-' + it.key}
                    >{it.label}</button>
                </li>
            {/each}
        </ul>
    {/if}
</li>
<style>
    .submenu-trigger {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 10px;
        font-size: 12.5px;
        text-align: left;
        border-radius: var(--radius-xs);
        color: var(--text-primary);
        cursor: pointer;
    }
    .submenu-trigger:hover,
    .submenu.open .submenu-trigger { background: var(--bg-hover); }
    .submenu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .submenu-chevron { display: flex; opacity: 0.5; flex-shrink: 0; }
    .submenu.open .submenu-chevron { opacity: 1; }

    /* position:fixed so the panel escapes the host menu's overflow-y:auto and
       stacks above it. Host menus sit at z-index 200 (MessageList) and 5
       (MessageDetail); 400 clears both. */
    .submenu-panel {
        position: fixed;
        overflow-y: auto;
        overscroll-behavior: contain;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        list-style: none;
        margin: 0;
        padding: 4px;
        z-index: 400;
        animation: submenu-in 110ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .submenu-panel li { list-style: none; }
    .submenu-empty {
        padding: 8px 10px;
        font-size: 11.5px;
        line-height: 1.4;
        color: var(--text-tertiary);
        /* Wraps, unlike the item buttons beside it: the text is a sentence
           pointing somewhere, not a label that can be ellipsised into
           meaninglessness. */
        white-space: normal;
    }
    .submenu-panel button {
        display: block;
        width: 100%;
        padding: 6px 10px;
        font-size: 12.5px;
        text-align: left;
        border-radius: var(--radius-xs);
        color: var(--text-primary);
        cursor: pointer;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .submenu-panel button:hover:not(:disabled),
    .submenu-panel button:focus-visible { background: var(--bg-hover); outline: none; }
    .submenu-panel button:disabled { opacity: 0.5; cursor: default; }

    @keyframes submenu-in {
        from { opacity: 0; transform: translateX(-4px); }
        to   { opacity: 1; transform: translateX(0); }
    }
    @media (prefers-reduced-motion: reduce) {
        .submenu-panel { animation: none; }
    }
</style>
