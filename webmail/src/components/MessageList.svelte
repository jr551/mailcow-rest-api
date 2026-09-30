<script lang="ts">
    import { tick } from 'svelte';
    import { ui, toggleSelected, selectAllVisible, clearSelection } from '../lib/store.svelte';
    import { formatDate, senderShort, isTrackingEmail, isNotificationMessage, isSmsMessage } from '../lib/format';
    import { capabilities } from '../lib/settings.svelte';
    import Avatar from './Avatar.svelte';
    import VipBadge from './VipBadge.svelte';
    import { settings, setListFilter, isVipAddress, type ListFilter } from '../lib/settings.svelte';
    import { getCachedScan } from '../lib/phishing-scan';
    import Icon from './Icon.svelte';
    import { buildThreads, type Thread } from '../lib/threads';
    import { sortInboxClient, type InboxSortRanking } from '../lib/sort-inbox-client';
    import type { MessageListItem } from '../lib/api';
    import { playSortDone, playClick } from '../lib/sounds.svelte';
    import { runSpamSweep, bulkMove, findArchiveFolder, findTrashFolder, type SweepCandidate } from '../lib/spam-sweep';
    import { listMailboxes, modifyFlags } from '../lib/api';
    import { showToast } from '../lib/store.svelte';
    import EventsScanPanel from './EventsScanPanel.svelte';
    import MenuSubmenu, { type SubmenuItem } from './MenuSubmenu.svelte';
    import RuleFromMessageDialog from './RuleFromMessageDialog.svelte';
    import { domainPattern, rootDomainPattern } from '../lib/domain-scope';
    import { addMailRule } from '../lib/api';
    import { listOutboundWebhooks, isOutboundWebhooksUnavailable } from '../lib/outbound-webhooks';

    interface ScanState { scanned: number; total: number; reason: string }
    interface Props {
        onSelect: (uid: number) => void;
        onStar: (uid: number) => void;
        onUnread: (uid: number) => void;
        onTrash: (uid: number) => void;
        onArchive: (uid: number) => void;
        onPageChange: (page: number) => void;
        onMarkFolderRead: () => void;
        onSummariseAndMarkRead: () => void;
        onLoadMore?: () => void;
        /** The page size the list is actually fetched with. Pagination has
         *  to divide by the same number the fetch used, or the footer
         *  reports a page count for a list nobody is looking at. */
        effectivePageSize?: number;
        appendingMore?: boolean;
        scanState?: ScanState | null;
        onMove?: (uid: number, dest: string) => void;
        /** Block a sender pattern. `pattern` defaults to the message's exact
         *  From address; the Block domain / Block root domain items pass a
         *  pre-computed `*@host` pattern instead. Widening this one prop is
         *  what keeps a single confirm → blockSender → toast → error flow in
         *  Layout — a second callback would have meant a second copy of that
         *  flow, which is the rot this file just shed. */
        onBlockSender?: (uid: number, pattern?: string) => void;
    }
    let {
        onSelect, onStar, onUnread, onTrash, onArchive,
        onPageChange, onMarkFolderRead, onSummariseAndMarkRead, onLoadMore,
        effectivePageSize = 25, appendingMore = false,
        scanState = null,
        onMove, onBlockSender
    }: Props = $props();

    // Right-click context menu on a row.
    // `x`/`y` are the ANCHOR (where the pointer was, or the row's rect for
    // the keyboard path). They are deliberately not the render position:
    // see ctxPos / placeCtx for why the final position cannot be known until
    // the menu has been measured on screen.
    let ctx = $state<{ uid: number; x: number; y: number } | null>(null);
    // Resolved viewport position for the menu, written by placeCtx() once the
    // menu is in the document and has a measurable box. Rendered from this,
    // not from ctx.x/ctx.y.
    let ctxPos = $state<{ left: number; top: number } | null>(null);
    // The row to hand focus back to when the menu closes. Without a
    // keyboard path into the menu, closeCtx just nulled `ctx` and focus
    // stayed wherever the pointer happened to be; now that the menu is
    // reachable with Shift+F10 the focus has to come home too.
    let ctxRow: HTMLElement | null = null;
    // $state, not a plain let: the menu is torn down and rebuilt on every
    // open, and closeCtx reads this to decide whether focus was inside it
    // when the menu went away. A non-reactive binding would keep pointing at
    // the detached <ul> from the previous open.
    let ctxEl: HTMLUListElement | null = $state(null);

    // Gap kept between the menu and every viewport edge, and the smallest
    // gap used when a menu is flipped above its anchor. 8px is enough to
    // show that the menu continues past the edge without crowding the
    // window furniture; deliberately the same value MenuSubmenu uses so
    // the two agree on where a "flush" edge is.
    const CTX_MARGIN = 8;
    // The menu is `position: fixed`, so the box it must fit inside is the
    // VIEWPORT, not the message list. The list scrolls underneath it while
    // the menu stays put, which is exactly why the anchor has to be the
    // window and not any ancestor.
    function clampCtx(anchorX: number, anchorY: number, w: number, h: number) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // A menu taller/wider than the viewport itself can only be clamped
        // to the top-left and allowed to overflow: the CSS caps max-height
        // at 70vh and gives it overflow-y:auto, so it scrolls internally
        // and every item stays reachable. Subtracting a margin from a
        // negative available space would push the menu off the far edge.
        if (w >= vw - CTX_MARGIN * 2 || h >= vh - CTX_MARGIN * 2) {
            return {
                left: Math.max(CTX_MARGIN, Math.min(anchorX, vw - w - CTX_MARGIN)),
                top: Math.max(CTX_MARGIN, Math.min(anchorY, vh - h - CTX_MARGIN))
            };
        }
        // Vertical: prefer BELOW the anchor, which is what a context menu
        // anchored at the pointer is expected to do. Flip ABOVE when below
        // would run off the bottom AND above has room — flipping beats
        // clamping here because a clamped menu is no longer next to the
        // row the user pointed at, and "the menu jumped to the top of the
        // screen" is its own bug. The old code did neither on the pointer
        // path: it wrote e.clientY straight into `top`, so a right-click in
        // the lower third put the menu's bottom items below the fold where
        // they could not be clicked.
        let top = anchorY;
        if (anchorY + h > vh - CTX_MARGIN) {
            const flipped = anchorY - h;
            top = flipped >= CTX_MARGIN ? flipped : Math.max(CTX_MARGIN, vh - h - CTX_MARGIN);
        }
        top = Math.max(CTX_MARGIN, Math.min(top, vh - h - CTX_MARGIN));
        // Horizontal: prefer to the RIGHT of the anchor, flip LEFT when it
        // would overflow and left has room, then clamp as the backstop for
        // a menu wider than the space on either side. A right-click near the
        // right edge ran off-screen the same way the bottom did.
        let left = anchorX;
        if (anchorX + w > vw - CTX_MARGIN) {
            const flipped = anchorX - w;
            left = flipped >= CTX_MARGIN ? flipped : Math.max(CTX_MARGIN, vw - w - CTX_MARGIN);
        }
        left = Math.max(CTX_MARGIN, Math.min(left, vw - w - CTX_MARGIN));
        return { left, top };
    }

    /**
     * Measure the open menu and write its clamped position.
     *
     * Re-measurement is the whole point. The previous fix GUESSED a height
     * — the keyboard path subtracted a hard-coded 80px — and that guess was
     * wrong the moment the menu gained or lost an item, so v0.20.0 shipped
     * a clamp whose target was never the real box and it read as "the
     * clamping doesn't work". `getBoundingClientRect` on the element that
     * is actually on screen is the only number that cannot drift.
     */
    function placeCtx() {
        if (!ctx || !ctxEl) return;
        const r = ctxEl.getBoundingClientRect();
        const next = clampCtx(ctx.x, ctx.y, r.width, r.height);
        // Write only on a real change. placeCtx runs from a scroll handler
        // on every frame, and assigning a fresh object each time re-renders
        // the whole menu subtree for no visible difference.
        if (ctxPos && ctxPos.top === next.top && ctxPos.left === next.left) return;
        ctxPos = next;
    }

    // The menu is inside the {#if ctx} block, so ctxEl only exists while it
    // is open. Tracking the open state (rather than registering listeners
    // imperatively in openCtx) means a torn-down menu tears its listeners
    // down with it — there is no window listener left pointing at a
    // detached node. Same pattern MenuSubmenu uses for its panel.
    // ctxPos is deliberately NOT read here. An earlier version read it to
    // "re-run when the menu changed", which made this effect depend on a
    // value it also writes: every placeCtx() produced a new object, the
    // effect re-ran, and it never settled — leaving the resize/scroll
    // listeners unregistered, so the menu silently kept its pre-resize
    // position. The menu's box changing is observed directly below instead.
    $effect(() => {
        if (!ctx || !ctxEl) return;
        placeCtx();
        const reposition = () => placeCtx();
        // Capture phase on scroll so a scroll inside ANY ancestor (the
        // message list, the reading pane, the window) re-clamps, not just
        // the document's own scroll.
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        // The menu's own box can change while the anchor stays put — a
        // submenu opening, the item list changing, a font finishing load.
        // Measuring is the only way to notice, and a stale height is what
        // makes a clamp look broken even though the code is running.
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reposition) : null;
        ro?.observe(ctxEl);
        return () => {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
            ro?.disconnect();
        };
    });

    /**
     * Re-clamp once a submenu opens.
     *
     * The Move and webhook submenus render INSIDE this <ul>, and a folder
     * list long enough to scroll changes the host menu's scroll state.
     * Re-running placeCtx one tick after the panel appears is cheap and
     * keeps the menu honest instead of assuming the first measurement
     * still holds. (The panel itself is position:fixed, so it is the
     * HOST menu that needs re-measuring, not the panel.)
     */
    $effect(() => {
        if (!ctx) return;
        if (submenuOpen()) void tick().then(placeCtx);
    });

    function openCtx(e: MouseEvent, uid: number) {
        e.preventDefault();
        e.stopPropagation();
        ctx = { uid, x: e.clientX, y: e.clientY };
        // Anchor only. The rendered position comes from placeCtx() once the
        // menu is measurable, so nothing has to be re-guessed here — the
        // previous `top: ${ctx.y}px` wrote the raw pointer Y and that IS
        // the reported bug.
        ctxPos = null;
        ctxRow = e.currentTarget as HTMLElement;
        ctxSelectRow(uid);
        // Deliberately does NOT move focus. The pointer user never had focus
        // in this menu before the keyboard path existed, and pulling it in
        // on every right-click would change existing behaviour (and flash a
        // focus ring at a menu the user is driving with a pointer).
        // focusCtxItem is the keyboard opener's job.
    }
    /**
     * Make the right-clicked row look selected, without opening it.
     *
     * This is deliberately NOT selectRow(uid), for three separate reasons:
     *
     *   1. selectRow calls onSelect, which is Layout's selectMessage. That
     *      nulls ui.detail, fetches the body and puts it in the reading pane.
     *      Right-clicking a row is a request for a menu, not a request to
     *      read the message — and a user right-clicking several rows in turn
     *      to compare senders would trigger a body fetch per click and get
     *      the reading pane flickering under the menu.
     *   2. playClick() is the Settings → Sounds row-click noise. Emitting it
     *      for a gesture the user did not perceive as a click makes the
     *      sound feel broken; it is a confirmation of a navigation that
     *      isn't happening.
     *   3. ui.selectedUid is the only thing the row highlight reads
     *      (class:selected on the head row at :1119 and on thread children
     *      at :1298). Layout's own Escape/arrow-key handler writes it
     *      directly too, so setting it is an established way to move the
     *      highlight without going through the fetch.
     *
     * Deliberately does NOT touch `ui.selected` (the checkbox Set). That Set
     * means "rows the user explicitly bulk-marked"; the highlight means "the
     * row the caret is on". Conflating them would mean every right-click
     * silently added a row to whatever the user had bulk-selected for the
     * next action — and would make Escape-to-clear bulk selection impossible
     * to reason about. Keeping them separate also leaves the Move submenu's
     * count coherent: moveTo() computes
     *   bulkN = ui.selected.has(ctx.uid) ? ui.selected.size : 0
     * so a right-click on a row that is part of an existing multi-selection
     * still reports and moves the full N, and a right-click on a row outside
     * it still moves just that one row. This helper changes neither number.
     *
     * Note the bulk-N label therefore describes the checkbox selection, not
     * the highlighted row — unchanged from before this helper existed, and
     * correct: "Move 12 selected to…" is about the 12 the user ticked, not
     * about which one they last touched with a right-click.
     */
    function ctxSelectRow(uid: number) {
        // Guarded so a re-right-click on the already-highlighted row is a
        // true no-op: writing the same value would still re-trigger every
        // $effect that reads ui.selectedUid for nothing.
        if (ui.selectedUid !== uid) ui.selectedUid = uid;
    }
    /**
     * Close the menu, handing focus back to its row if — and only if —
     * focus was inside the menu when it closed.
     *
     * The guard is load-bearing twice over:
     *   - this runs from <svelte:window onclick>, so it fires for clicks
     *     ANYWHERE in the app. Unconditionally refocusing the row would
     *     yank focus off whatever the user actually just clicked.
     *   - a right-click-opened menu never has focus in it (see openCtx), so
     *     a pointer dismissal leaves focus exactly where it was, as before.
     * A keyboard-opened one does, so Escape, Tab, and picking an item all
     * return the user to the row they started from.
     */
    function closeCtx() {
        const wasOpen = !!ctx;
        // Read BEFORE nulling `ctx` — `ctxEl` is bound to the menu element,
        // which Svelte only unmounts after this handler returns.
        const focusInMenu = !!ctxEl && ctxEl.contains(document.activeElement as Node);
        ctx = null;
        // Drop the resolved position with the menu. Leaving it set means the
        // next open renders one frame at the PREVIOUS menu's coordinates
        // before placeCtx re-measures, which is a visible jump at the old
        // spot.
        ctxPos = null;
        if (wasOpen && focusInMenu && ctxRow?.isConnected) ctxRow.focus();
        ctxRow = null;
    }

    /** This menu's own items, minus the submenu's — those have their own
     *  key handling and must not have focus stolen by the parent walk. */
    function ctxItems(): HTMLElement[] {
        if (!ctxEl) return [];
        // The submenu's own trigger IS part of this walk: it is a menu item
        // like any other, and excluding it (as this did) made the whole Move
        // submenu unreachable by keyboard — the arrows skipped straight past
        // it and Tab closes the menu. Only the submenu's PANEL is excluded,
        // because MenuSubmenu owns the arrows inside it.
        return Array.from(
            ctxEl.querySelectorAll<HTMLElement>('button[role="menuitem"]:not(:disabled)')
        ).filter((b) => !b.closest('.submenu-panel'));
    }

    function focusCtxItem(i: number) {
        const b = ctxItems();
        if (b.length) b[Math.max(0, Math.min(i, b.length - 1))].focus();
    }

    /**
     * APG menu pattern: ArrowDown/ArrowUp walk the items, Home/End jump to
     * the ends. MenuSubmenu owns its own panel's arrows, so anything from
     * inside a .submenu is left alone — including its trigger, which walks
     * the host menu itself (MenuSubmenu's onTriggerKeydown) rather than
     * letting this walk yank focus back out of a panel the user just opened.
     */
    function ctxMenuKey(e: KeyboardEvent) {
        if (!ctx || (e.target as HTMLElement)?.closest?.('.submenu')) return;
        const b = ctxItems();
        if (!b.length) return;
        const i = b.indexOf(document.activeElement as HTMLElement);
        // Per APG, the menu owns these keys while it is open: both
        // preventDefault (don't scroll) and stopPropagation (don't let
        // Layout's global arrow handling steal the key — see the comment
        // on the <svelte:window> handler below).
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                e.stopPropagation();
                focusCtxItem(i === -1 ? 0 : i + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                e.stopPropagation();
                focusCtxItem(i <= 0 ? b.length - 1 : i - 1);
                break;
            case 'Home':
                e.preventDefault();
                e.stopPropagation();
                focusCtxItem(0);
                break;
            case 'End':
                e.preventDefault();
                e.stopPropagation();
                focusCtxItem(b.length - 1);
                break;
            case 'Tab':
                // Menu buttons are natively focusable, so an unhandled Tab
                // walks the focus ring THROUGH a menu that stays on screen.
                closeCtx();
                break;
        }
    }

    /**
     * Keyboard equivalent of right-click: open the row's context menu
     * anchored to the row, because there is otherwise no way to reach it
     * without a pointer. The menu used to be right-click only, which made
     * every action in it — including "Create rule from message" — invisible
     * to keyboard and switch users.
     *
     * Shift+F10 is the de-facto key for this (it's what the Windows
     * context-menu key, and most web apps, bind); the Menu key is the other
     * half of the same chord and is what the APG's menu-button example
     * accepts. Both are offered because which one fires is browser/OS
     * dependent.
     *
     * Anchoring: a keyboard menu has no cursor, so `e.clientX/Y` would place
     * it at the last physical mouse position, which can be metres away from
     * the row. Anchor to the row's own rect instead.
     */
    function openCtxKeyboard(e: KeyboardEvent, uid: number) {
        if (e.key !== 'F10' && e.key !== 'ContextMenu') return;
        if (!e.shiftKey && e.key !== 'ContextMenu') return;
        const el = e.currentTarget as HTMLElement;
        const r = el.getBoundingClientRect();
        e.preventDefault();
        e.stopPropagation();
        // Anchor only, exactly as the pointer path. The old code clamped
        // here against a hard-coded 240x80 — a guess about the menu's size
        // that stopped being true the moment the item list changed. The
        // measurement in placeCtx() supersedes it and also flips above the
        // row, which this could never do: for a row in the lower third,
        // `r.bottom + 4` is already past where the menu can fit below.
        ctx = { uid, x: r.left + 24, y: r.bottom + 4 };
        ctxPos = null;
        ctxRow = el;
        // Same highlight as the pointer path, so the row the keyboard menu
        // belongs to is visibly the row the menu will act on — otherwise
        // there is no way to tell which message "Create rule from message"
        // would be built from.
        ctxSelectRow(uid);
        void tick().then(() => focusCtxItem(0));
    }
    function rowOf(uid: number) {
        return ui.messages.find((m) => m.uid === uid);
    }

    // Folder destinations for the context menu's Move submenu. Deliberately
    // NOT capped: the list used to be truncated to 8 with a silent
    // `.slice(0, 8)`, which hid every folder past the 8th with no
    // indication that more existed. MenuSubmenu renders the whole thing in a
    // scrolling, edge-flipping panel, so there is no reason to hide any.
    let moveTargets = $derived<SubmenuItem[]>(
        ui.mailboxes
            .filter((mb) => mb.path !== ui.selectedPath)
            .map((mb) => ({ key: mb.path, label: mb.name || mb.path }))
    );

    // Pick a Move destination. With more than one row selected this moves the
    // whole selection, matching the pre-submenu behaviour.
    async function moveTo(dest: string) {
        const target = ctx?.uid;
        if (target == null) return;
        const bulkN = ui.selected.has(target) ? ui.selected.size : 0;
        closeCtx();
        if (bulkN > 1) {
            await bulkMoveSelected(dest);
        } else {
            onMove?.(target, dest);
        }
    }

    // ── "Send to external webhook" ─────────────────────────────────────────
    //
    // The user asked for "always send from this sender" — a PERSISTENT rule,
    // not a one-off send of the message under the cursor. So this creates the
    // same rule the rule dialog would have built (condition from-contains on
    // the right-clicked sender, action { type: 'webhook', webhookId }), which
    // the server compiles to `fileinto :create ".wh-<id>"; stop;` and the
    // outbound forwarder picks up. The dialog is deliberately NOT reopened
    // here: it is a form for editing, and the point of this item is one
    // click, not a second form to fill in with values already known.
    //
    // Loaded LAZILY, on first open of the submenu, because a list that only
    // matters after a deliberate right-click should not cost a request on
    // every page render. Refreshed on every open so a webhook created in
    // Settings during this session shows up without a reload.
    let webhookItems = $state<SubmenuItem[] | null>(null);
    let webhookLoading = $state(false);
    let webhookNote = $state<string | null>(null);

    /**
     * Load the webhook list for the submenu, folding the three "no
     * webhooks" cases into one honest sentence each.
     *
     * A dead menu item is worse than a missing one: a trigger that opens an
     * empty panel reads as a bug, and a trigger that isn't there at all is
     * just a feature the user hasn't set up. So unavailable (the server
     * predates the endpoint) and none-configured are stated, not rendered
     * as a selection the user can fail to make.
     */
    async function loadWebhookTargets() {
        if (webhookLoading) return;
        webhookLoading = true;
        webhookNote = null;
        try {
            const { webhooks } = await listOutboundWebhooks();
            webhookItems = webhooks.map((w) => ({ key: w.id, label: w.label || w.url }));
            if (!webhooks.length) {
                webhookNote = 'No webhooks yet — add one in Settings → Outbound webhooks.';
            }
        } catch (err) {
            webhookItems = [];
            // 404/501 means the SERVER has no such endpoint. Anything else
            // is a different failure, and saying "not available on this
            // server" for a network blip would send the user off to check
            // their server config when the truth is a timeout.
            webhookNote = isOutboundWebhooksUnavailable(err)
                ? 'Outbound webhooks are not available on this server.'
                : 'Could not load your webhooks — try again in a moment.';
        } finally {
            webhookLoading = false;
        }
    }

    /**
     * Create the persistent "always forward this sender here" rule, then
     * close the menu.
     *
     * closeCtx() before the await, and `from` resolved before it, for the
     * same reason every other item in this menu does it: closeCtx nulls
     * `ctx` synchronously, so anything still reading ctx afterwards throws.
     */
    async function sendSenderToWebhook(webhookId: string) {
        const target = ctx?.uid;
        if (target == null) return;
        const from = rowOf(target)?.envelope?.from?.[0]?.address;
        closeCtx();
        if (!from) {
            showToast('error', 'That message has no sender address to match on');
            return;
        }
        try {
            // One MailRuleInput object, which is what api.addMailRule takes —
            // not three positional args. The name is the sender address so
            // the list in Settings reads as "who did I point at what", which
            // is the question a user has when they come back to disable one.
            await addMailRule({
                name: from,
                condition: { type: 'from-contains', value: from },
                action: { type: 'webhook', webhookId }
            });
            // The future-only wording is the single most common source of
            // "I made the rule and nothing happened" — Sieve runs on arrival,
            // nothing re-runs against the mailbox. RuleFromMessageDialog
            // already says this in its body; reuse the same claim here
            // rather than inventing a third variant of it.
            showToast('success', `Mail from ${from} will go to that webhook as it arrives`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Could not create the rule';
            showToast('error', msg);
        }
    }

    // "Create rule from message" — right-clicked a message, built a Sieve
    // rule from its headers. Holding the message object (not just the uid)
    // is what lets the dialog prefill from envelope data the list already
    // has, with no extra fetch. Null means the dialog isn't open.
    let ruleFromMessage = $state<MessageListItem | null>(null);
    function openRuleFromMessage(m: MessageListItem) {
        ruleFromMessage = m;
    }

    /**
     * True while the Move submenu's folder panel is showing.
     *
     * The submenu sets `data-submenu-open` on its root <li> precisely so
     * this menu can implement a two-stage Escape without owning the
     * submenu's internal state. MessageList's window handler runs in the
     * CAPTURE phase, which fires before the submenu's own keydown handler,
     * so it has to stand down explicitly while the submenu is open —
     * otherwise the first Escape would close the whole context menu.
     */
    function submenuOpen() {
        return !!document.querySelector('.msg-ctx [data-submenu-open="true"]');
    }

    // Infinite-scroll trigger — calls onLoadMore when the user scrolls
    // within ~120 px of the bottom. Layout caps server requests at 100
    // per page, so this fires repeatedly to fill bigger / unlimited
    // page-size choices.
    function onListScroll(e: Event) {
        if (!onLoadMore) return;
        const el = e.currentTarget as HTMLDivElement;
        const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
        if (remaining < 120) onLoadMore();
    }

    // Pagination footer is meaningless in unlimited mode (the crawler/infinite
    // scroll handles loading), so hide it when the user picked unlimited or
    // a size big enough that the prev/next buttons would just confuse.
    //
    // The denominator must use the size the list is actually fetched with.
    // It was hardcoded to 25 while Layout fetched settings.pageSize, so a
    // user on 50/page saw twice the pages that existed — "page 1 of 12"
    // for a mailbox that ended at 6, with the back half all empty.
    const totalPages = $derived(
        settings.pageSize === 'unlimited'
            ? 1
            : Math.max(1, Math.ceil((ui.messagesTotal || 0) / Math.max(1, effectivePageSize)))
    );

    function flagged(flags: string[]) {
        return flags.includes('\\Flagged');
    }
    function unread(flags: string[]) {
        return !flags.includes('\\Seen');
    }

    // Centralised row-select used by both click and keyboard activation
    // so the per-user click sound (Settings → Sounds) reliably fires
    // regardless of input modality.
    function selectRow(uid: number) {
        playClick();
        onSelect(uid);
    }

    function rowKey(e: KeyboardEvent, uid: number) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectRow(uid);
        }
    }

    // Filter the in-memory list — purely client-side, doesn't re-fetch.
    // hasAttachments is now decorated server-side from bodyStructure, so the
    // Attachments filter works without a per-row round-trip.
    const filtered = $derived.by(() => {
        const f = settings.listFilter;
        if (f === 'all' || f === 'ai-sorted') return ui.messages;
        if (f === 'unread') return ui.messages.filter((m) => !m.flags.includes('\\Seen'));
        if (f === 'starred') return ui.messages.filter((m) => m.flags.includes('\\Flagged'));
        if (f === 'attachments') return ui.messages.filter((m) => !!m.hasAttachments);
        return ui.messages;
    });

    // Threading: collapse multi-message conversations into single rows.
    // When the toggle is off the threads array is one-message-per-thread,
    // which makes the rendering loop identical to the un-grouped case.
    const baseThreads = $derived(
        settings.groupThreads
            ? buildThreads(filtered)
            : filtered.map((m) => ({
                id: `m:${m.uid}`,
                messages: [m],
                latest: m,
                count: 1,
                hasUnread: !m.flags.includes('\\Seen'),
                hasFlagged: m.flags.includes('\\Flagged'),
                hasAttachments: !!m.hasAttachments,
                participants: m.envelope.from?.length ? [m.envelope.from[0]] : []
            } as Thread))
    );

    // When AI-sorted is active, re-order threads by category bucket then
    // by LLM relevance level. Bucket order: human → important → info →
    // marketing. Inside each bucket the LLM's level (5→1) wins.
    const CAT_RANK: Record<string, number> = { family: 0, human: 1, important: 2, info: 3, marketing: 4 };
    const threads = $derived.by(() => {
        if (settings.listFilter !== 'ai-sorted' || aiRankings.length === 0) return baseThreads;
        const indexFor = new Map<number, number>();
        aiRankings.forEach((r, i) => indexFor.set(r.uid, i));
        return [...baseThreads].sort((a, b) => {
            const ra = rankingFor(a.latest.uid);
            const rb = rankingFor(b.latest.uid);
            const catA = (ra?.human ? 'human' : ra?.category) || 'info';
            const catB = (rb?.human ? 'human' : rb?.category) || 'info';
            const cdiff = (CAT_RANK[catA] ?? 9) - (CAT_RANK[catB] ?? 9);
            if (cdiff !== 0) return cdiff;
            // Higher level first within bucket.
            const lvlDiff = (rb?.level ?? 0) - (ra?.level ?? 0);
            if (lvlDiff !== 0) return lvlDiff;
            // Stable fallback: LLM order, then base order.
            const ao = indexFor.get(a.latest.uid) ?? Infinity;
            const bo = indexFor.get(b.latest.uid) ?? Infinity;
            return ao - bo;
        });
    });

    // Inline expansion state for multi-message threads. Stored as a Set of
    // thread IDs; click the chevron to toggle.
    let expandedThreads = $state(new Set<string>());

    // AI calendar-scan modal state. Toggled from the icon button next to AI sort.
    let eventsScanOpen = $state(false);

    // UIDs currently being processed by a client-side rule. The row
    // wears a glassy shimmer (and a pop-away on `done`) so the user
    // sees something happen rather than a silent disappearance.
    let ruleAnimUids = $state(new Set<number>());
    let ruleDoneUids = $state(new Set<number>());
    // Registered via $effect so it is torn down with the component. As a
    // bare top-level addEventListener it survived every remount (app-surface
    // switches), stacking another handler holding stale component state
    // each time.
    $effect(() => {
        if (typeof window === 'undefined') return;
        const onRule = (e: Event) => {
            const ev = e as CustomEvent<{ path: string; uid: number; phase: 'start' | 'done' | 'error' }>;
            if (!ev.detail) return;
            const { uid, phase } = ev.detail;
            if (phase === 'start') {
                const next = new Set(ruleAnimUids); next.add(uid); ruleAnimUids = next;
            } else if (phase === 'done') {
                const next = new Set(ruleDoneUids); next.add(uid); ruleDoneUids = next;
                // Drop the marker shortly after the animation plays so
                // the local cache that still holds this row briefly
                // doesn't keep replaying it on a re-render.
                setTimeout(() => {
                    const a = new Set(ruleAnimUids); a.delete(uid); ruleAnimUids = a;
                    const b = new Set(ruleDoneUids); b.delete(uid); ruleDoneUids = b;
                }, 600);
            } else {
                const a = new Set(ruleAnimUids); a.delete(uid); ruleAnimUids = a;
            }
        };
        window.addEventListener('webmail:client-rule', onRule);
        return () => window.removeEventListener('webmail:client-rule', onRule);
    });

    // AI inbox-sort state.
    let aiSortLoading = $state(false);
    let aiSortError = $state<string | null>(null);
    let aiRankings = $state<InboxSortRanking[]>([]);
    let aiSortProgress = $state<{ done: number; total: number } | null>(null);
    let aiSortStartTs = $state(0);

    // Spam-sweep companion state. Sweep piggybacks on every AI sort
    // (when settings.aiSortSweepSpam is on), surfacing junk + phishing
    // candidates in a banner the user can act on with one click.
    let sweepResults = $state<SweepCandidate[] | null>(null);
    let sweepRunning = $state(false);
    let sweepDestSpam = $state<string | null>(null);
    let sweepDestTrash = $state<string | null>(null);
    let sweepBulkBusy = $state(false);
    let sweepDismissed = $state(false);
    let sweepAbort: AbortController | null = null;

    // AI sort runs ONLY when the user explicitly clicks the magic button
    // (runAiSort below). The previous $effect re-fired whenever ui.messages
    // changed (new mail arrives, message marked read, etc.) which burned
    // the user's daily LLM budget without their consent. Filter switches
    // alone now show the *cached* ranking — no automatic re-run.
    function runAiSort() {
        // Defence in depth: the button that calls this is hidden when AI
        // is off, but nothing should reach a paid model call through a
        // stale handler, a queued click, or a future entry point.
        if (!settings.aiFeatures) return;
        const msgs = ui.messages;
        if (msgs.length === 0) {
            aiRankings = [];
            return;
        }
        aiSortLoading = true;
        aiSortError = null;
        aiSortProgress = { done: 0, total: 0 };
        aiSortStartTs = Date.now();
        sortInboxClient(
            msgs.map((m) => ({
                uid: m.uid,
                subject: m.envelope.subject || undefined,
                from: m.envelope.from,
                to: m.envelope.to,
                date: m.envelope.date || m.internalDate || undefined
            })),
            {
                onProgress: (done, total) => {
                    aiSortProgress = { done, total };
                }
            }
        )
            .then((res) => { aiRankings = res.rankings; playSortDone(); })
            .catch((err) => { aiSortError = err instanceof Error ? err.message : 'AI sort failed'; })
            .finally(() => {
                aiSortLoading = false;
                // Hold the "done" state briefly so the user gets visual confirmation.
                setTimeout(() => { aiSortProgress = null; }, 800);
            });
        // Kick off the spam sweep alongside the sort if enabled. They
        // share the same per-message phishing-scan cache, so two passes
        // over the same inbox don't cost double tokens.
        if (settings.aiSortSweepSpam) {
            runSweepAlongside();
        }
    }

    function runSweepAlongside() {
        if (sweepRunning) return;
        sweepRunning = true;
        sweepDismissed = false;
        sweepAbort?.abort();
        sweepAbort = new AbortController();
        runSpamSweep({ signal: sweepAbort.signal })
            .then((out) => {
                sweepResults = out.candidates;
                sweepDestSpam = out.spamPath;
                sweepDestTrash = out.trashPath;
            })
            .catch(() => { /* sweep is best-effort; sort already handled the user-visible error */ })
            .finally(() => { sweepRunning = false; });
    }

    async function applySweep(kind: 'spam' | 'phishing') {
        if (!sweepResults || sweepBulkBusy) return;
        const dest = kind === 'spam' ? sweepDestSpam : sweepDestTrash;
        if (!dest) {
            showToast('error', kind === 'spam' ? 'No Spam folder found.' : 'No Trash folder found.');
            return;
        }
        const items = sweepResults
            .filter((c) => kind === 'spam' ? c.isSpam && !c.isPhishing : c.isPhishing)
            .map((c) => ({ path: c.path, uid: c.uid }));
        if (items.length === 0) return;
        sweepBulkBusy = true;
        ui.bulkProgress = {
            action: kind === 'spam' ? `Moving to Spam` : `Moving to Trash`,
            done: 0,
            total: items.length,
            failed: 0
        };
        try {
            const r = await bulkMove(items, dest, (done, total) => {
                if (ui.bulkProgress) {
                    ui.bulkProgress = { ...ui.bulkProgress, done, total };
                }
            });
            // Brief tail so the user sees the bar hit 100% before it
            // disappears — feels less abrupt than vanishing instantly.
            setTimeout(() => { ui.bulkProgress = null; }, 600);
            showToast('success', `Moved ${r.moved} message${r.moved === 1 ? '' : 's'} to ${dest}${r.failed ? ` (${r.failed} failed)` : ''}.`);
            sweepResults = sweepResults.filter((c) => !items.some((i) => i.uid === c.uid));
            if (sweepResults.length === 0) sweepDismissed = true;
        } finally {
            sweepBulkBusy = false;
        }
    }

    // Bulk-move every selected uid to `dest`. Used by the right-click
    // "Move to…" submenu when multiple rows are selected; the single-
    // row path still goes through onMove() per the existing flow.
    async function bulkMoveSelected(dest: string) {
        const sel = Array.from(ui.selected);
        if (sel.length <= 1) return false;
        const items = sel.map((uid) => ({ path: ui.selectedPath, uid }));
        ui.bulkProgress = {
            action: `Moving to ${dest.split('/').pop() || dest}`,
            done: 0,
            total: items.length,
            failed: 0
        };
        try {
            const r = await bulkMove(items, dest, (done, total) => {
                if (ui.bulkProgress) ui.bulkProgress = { ...ui.bulkProgress, done, total };
            });
            setTimeout(() => { ui.bulkProgress = null; }, 600);
            showToast('success', `Moved ${r.moved} message${r.moved === 1 ? '' : 's'} to ${dest}${r.failed ? ` (${r.failed} failed)` : ''}.`);
            // Drop them from the visible list immediately — server-side
            // refresh will reconcile when the user navigates back.
            ui.messages = ui.messages.filter((m) => !sel.includes(m.uid));
            ui.selected = new Set();
        } catch {
            ui.bulkProgress = null;
        }
        return true;
    }

    function dangerLevel(uid: number): number {
        const r = aiRankings.find((x) => x.uid === uid);
        // Old "danger" 1-4 scale is now relevance 1-5; clamp to the legacy
        // 4 levels for the colour-coded danger badges already in the row,
        // but treat human/level-5 as the maximum.
        return r ? Math.max(1, Math.min(4, r.level >= 5 ? 4 : r.level)) : 0;
    }

    // Treat anything with internalDate within the last 10 minutes as
    // "fresh" — drives the .fresh sparkle animation in the row.
    const FRESH_WINDOW_MS = 10 * 60 * 1000;
    function isFresh(d: string | null | undefined): boolean {
        if (!d) return false;
        const t = Date.parse(d);
        if (Number.isNaN(t)) return false;
        return Date.now() - t < FRESH_WINDOW_MS;
    }
    function toggleThread(id: string) {
        const next = new Set(expandedThreads);
        if (next.has(id)) next.delete(id); else next.add(id);
        expandedThreads = next;
    }

    function senderListText(t: Thread): string {
        if (t.count === 1) return senderShort(t.latest.envelope.from);
        const names = t.participants.slice(0, 3).map((p) => {
            return (p.name?.split(/\s+/)[0]) || (p.address?.split('@')[0]) || '?';
        });
        const more = t.participants.length - names.length;
        return more > 0 ? `${names.join(', ')} +${more}` : names.join(', ');
    }

    // AI sort lives as a magic-style button next to "All", not as a chip
    // in the main filter strip — keeps it obviously special and makes
    // room for a future settings popover (per-user prefs).
    const FILTERS: { value: ListFilter; label: string }[] = [
        { value: 'all', label: 'All' },
        { value: 'unread', label: 'Unread' },
        { value: 'starred', label: 'Starred' },
        { value: 'attachments', label: 'Attachments' }
    ];

    function rankingFor(uid: number): InboxSortRanking | null {
        return aiRankings.find((r) => r.uid === uid) ?? null;
    }
    type AiCat = 'human' | 'family' | 'important' | 'purchase' | 'notification' | 'marketing' | 'info';
    function aiCategory(uid: number): AiCat | null {
        const r = rankingFor(uid);
        if (!r) return null;
        // Promote to "human" when the LLM flagged the human bool but
        // forgot the category; common with smaller models.
        if (r.human) return 'human';
        return (r.category as AiCat) ?? null;
    }
    // Visual treatment for each category pill — emoji, label, and the
    // CSS class that drives the gradient. The "Notification" pill is
    // the blue one the user asked for.
    const CAT_META: Record<AiCat, { label: string; emoji: string; tone: string }> = {
        family:       { label: 'Family',    emoji: '💖', tone: 'cat-family' },
        human:        { label: 'Important', emoji: '👤', tone: 'cat-human' },
        important:    { label: 'Important', emoji: '⚡', tone: 'cat-important' },
        purchase:     { label: 'Purchase',  emoji: '🛍', tone: 'cat-purchase' },
        notification: { label: 'Notification', emoji: '🔔', tone: 'cat-notification' },
        marketing:    { label: 'Marketing', emoji: '📣', tone: 'cat-marketing' },
        info:         { label: 'Info',      emoji: 'ℹ',  tone: 'cat-info' }
    };
    // VIP from the address list deserves its own pill — outranks the
    // model-derived category so the user always sees it first. VIPs are
    // configured under Settings → "VIP / family addresses", so a match
    // there means the message touches the user's family/inner-circle —
    // surface the concise "Family" tag instead of "Important", which is
    // both more accurate and less alarming.
    function effectiveCategory(uid: number, vipMatch: string | null, isNotice: boolean): AiCat | null {
        if (vipMatch) return 'family';
        if (isNotice) return 'notification';
        return aiCategory(uid);
    }

    /** Collect every visible message UID matching `cat`. Shared by both
     *  the chip-tap "select" path and the one-click bulk actions. */
    function uidsForCategory(cat: AiCat): number[] {
        const out: number[] = [];
        for (const m of ui.messages) {
            const isNotice = isNotificationMessage({
                from: m.envelope.from,
                subject: m.envelope.subject,
                notificationSenders: capabilities.server?.notificationSenders,
                smsSenders: capabilities.server?.smsSenders
            });
            const vipMatch = isVipAddress([
                m.envelope.from?.[0]?.address,
                ...((m.envelope.to || []).map((a) => a.address)),
                ...((m.envelope.cc || []).map((a) => a.address))
            ]);
            if (effectiveCategory(m.uid, vipMatch, isNotice) === cat) out.push(m.uid);
        }
        return out;
    }

    /** Replace the current selection with every visible message that
     *  matches `cat`. The user can then chase with the BulkBar. */
    function selectByCategory(cat: AiCat) {
        ui.selected = new Set(uidsForCategory(cat));
    }

    /** One-click bulk action over an entire AI-sort category — Archive,
     *  Trash, or Mark-read for every visible message in that bucket.
     *  Powers the per-category action buttons next to each quick-chip.
     */
    let categoryActionBusy = $state(false);
    async function runCategoryAction(cat: AiCat, action: 'archive' | 'trash' | 'markRead') {
        if (categoryActionBusy) return;
        const uids = uidsForCategory(cat);
        if (uids.length === 0) return;
        const items = uids.map((uid) => ({ path: ui.selectedPath, uid }));
        const meta = CAT_META[cat];

        if (action === 'markRead') {
            categoryActionBusy = true;
            ui.bulkProgress = {
                action: `Marking ${meta.label.toLowerCase()} read`,
                done: 0,
                total: items.length,
                failed: 0
            };
            try {
                let done = 0;
                for (const { path, uid } of items) {
                    try { await modifyFlags(path, uid, { add: ['\\Seen'] }); }
                    catch { /* swallow per-uid; surfaced via failed count */ }
                    done++;
                    if (ui.bulkProgress) ui.bulkProgress = { ...ui.bulkProgress, done };
                }
                setTimeout(() => { ui.bulkProgress = null; }, 600);
                showToast('success', `Marked ${done} ${meta.label.toLowerCase()} message${done === 1 ? '' : 's'} read.`);
                // Reflect locally without a refetch — the seen-flag flip is
                // visible immediately in the row's bold/regular weight.
                ui.messages = ui.messages.map((m) => uids.includes(m.uid)
                    ? { ...m, flags: m.flags.includes('\\Seen') ? m.flags : [...m.flags, '\\Seen'] }
                    : m);
            } finally {
                categoryActionBusy = false;
            }
            return;
        }

        // Archive / Trash both go through bulkMove — figure out the folder.
        let dest: string | null = null;
        try {
            const mboxes = await listMailboxes({ counts: false });
            dest = action === 'archive' ? findArchiveFolder(mboxes) : findTrashFolder(mboxes);
        } catch { /* ignore — handled below */ }
        if (!dest) {
            showToast('error', action === 'archive'
                ? 'No Archive folder found. Create one in your IMAP account first.'
                : 'No Trash folder found.');
            return;
        }

        const ok = window.confirm(
            `${action === 'archive' ? 'Archive' : 'Trash'} ${items.length} ${meta.label.toLowerCase()} message${items.length === 1 ? '' : 's'}?`
        );
        if (!ok) return;

        categoryActionBusy = true;
        ui.bulkProgress = {
            action: `${action === 'archive' ? 'Archiving' : 'Moving to Trash'} ${meta.label.toLowerCase()}`,
            done: 0,
            total: items.length,
            failed: 0
        };
        try {
            const r = await bulkMove(items, dest, (done, total) => {
                if (ui.bulkProgress) ui.bulkProgress = { ...ui.bulkProgress, done, total };
            });
            setTimeout(() => { ui.bulkProgress = null; }, 600);
            showToast('success', `${action === 'archive' ? 'Archived' : 'Trashed'} ${r.moved} message${r.moved === 1 ? '' : 's'}${r.failed ? ` (${r.failed} failed)` : ''}.`);
            // Drop them from the visible list — the server view will catch up.
            ui.messages = ui.messages.filter((m) => !uids.includes(m.uid));
            // Anything in the now-removed set should also leave the bulk selection.
            const nextSel = new Set<number>();
            for (const id of ui.selected) if (!uids.includes(id)) nextSel.add(id);
            ui.selected = nextSel;
        } catch {
            ui.bulkProgress = null;
        } finally {
            categoryActionBusy = false;
        }
    }

    // Auto-suggest AI sort when the user has a pile of unread mail. Sticky
    // localStorage key so we don't nag every page load.
    const SUGGEST_KEY = 'webmail.ai-sort.suggested-v1';
    let suggestAiSort = $state(false);
    let suggestAiSortDismissed = $state(false);
    $effect(() => {
        if (suggestAiSortDismissed || settings.listFilter === 'ai-sorted') {
            suggestAiSort = false;
            return;
        }
        const unread = ui.messages.filter((m) => !m.flags.includes('\\Seen')).length;
        const stamp = (() => {
            try { return Number(localStorage.getItem(SUGGEST_KEY) || '0'); } catch { return 0; }
        })();
        // Re-show every 24h max, and only when 25+ unread are visible.
        if (unread >= 25 && Date.now() - stamp > 86_400_000) {
            suggestAiSort = true;
        }
    });
    function acceptSuggestion() {
        suggestAiSort = false;
        suggestAiSortDismissed = true;
        try { localStorage.setItem(SUGGEST_KEY, String(Date.now())); } catch { /* */ }
        setListFilter('ai-sorted');
    }
    function dismissSuggestion() {
        suggestAiSort = false;
        suggestAiSortDismissed = true;
        try { localStorage.setItem(SUGGEST_KEY, String(Date.now())); } catch { /* */ }
    }

    function prettyName(path: string): string {
        if (!path) return '';
        if (path.toUpperCase() === 'INBOX') return 'Inbox';
        // Show only the last segment of nested paths, capitalized.
        const last = path.split('/').pop() || path;
        return last.charAt(0).toUpperCase() + last.slice(1);
    }

    // Slow-load detector. Quick loads (cached / cache-warm IMAP folders)
    // shouldn't flash an overlay — only show it after ~280ms of waiting,
    // long enough that the user has registered the folder switch and
    // would otherwise be staring at the previous folder's mail. Reset
    // immediately when the load completes so the overlay never out-lives
    // the actual fetch.
    let loadingSlow = $state(false);
    $effect(() => {
        if (!ui.messagesLoading) { loadingSlow = false; return; }
        const t = setTimeout(() => { loadingSlow = true; }, 280);
        return () => clearTimeout(t);
    });
</script>

<section class="list" aria-label="Message list">
    <header class="list-header">
        <div class="list-title">
            <span class="title-folder">{prettyName(ui.selectedPath)}</span>
            {#if ui.search}<span class="search-tag">"{ui.search}"</span>{/if}
        </div>
        <div class="list-meta muted">
            {#if ui.messagesLoading}<span class="spinner" style="width:14px;height:14px"></span>{/if}
            {#if !ui.messagesLoading}
                <span data-testid="msg-count">{ui.messagesTotal} {ui.messagesTotal === 1 ? 'message' : 'messages'}</span>
            {/if}
        </div>
    </header>

    <nav class="filter-chips" aria-label="Filter messages" data-testid="filter-chips">
        <!-- AI action group: collapsed to compact icon buttons so the three
             AI affordances (briefing, sort, calendar scan) sit tight at the
             head of the chip row. Tooltips carry the labels that the
             previous spans showed inline. Hidden wholesale when AI is
             hard-off — these three are the only way into the AI sort,
             briefing and calendar scan. -->
        {#if settings.aiFeatures}
        <div class="ai-action-group">
            <button
                type="button"
                class="ai-icon-btn ai-summary-btn"
                title="Generate an AI inbox briefing — operational vs marketing split, action list, auto-replies"
                aria-label="AI inbox briefing"
                onclick={onSummariseAndMarkRead}
                data-testid="mark-folder-read"
            >
                <Icon name="table" size={14} />
            </button>
            <button
                type="button"
                class="ai-icon-btn magic-btn"
                class:active={settings.listFilter === 'ai-sorted'}
                class:loading={aiSortLoading}
                title="AI sort — humans on top, then important, info, marketing"
                aria-label="AI sort"
                onclick={() => {
                    if (settings.listFilter === 'ai-sorted') {
                        // Second click while active → re-run the sort. Useful
                        // when new mail has arrived and the user wants the AI
                        // to re-rank.
                        runAiSort();
                    } else {
                        setListFilter('ai-sorted');
                        // First time switching to AI sort kicks off the call.
                        // Cached rankings (if any) keep showing meanwhile.
                        if (aiRankings.length === 0 && !aiSortLoading) runAiSort();
                    }
                }}
                data-testid="filter-ai-sorted"
            >
                <Icon name="arrowUpDown" size={14} />
            </button>
            <button
                type="button"
                class="ai-icon-btn calendar-scan-btn"
                title="AI calendar scan — find events to add to your calendar"
                aria-label="AI calendar scan"
                onclick={() => (eventsScanOpen = true)}
                data-testid="ai-calendar-scan"
            >
                <Icon name="calendar" size={14} />
                <span class="cal-spark" aria-hidden="true"></span>
            </button>
        </div>
        {/if}
        {#if ui.messages.length > 0}
            {@const allSelected = ui.selected.size > 0 && ui.selected.size >= ui.messages.length}
            <button
                type="button"
                class="chip select-all-chip"
                class:active={allSelected}
                title={allSelected
                    ? `Clear selection (${ui.selected.size})`
                    : `Select all ${ui.messages.length} visible messages`}
                onclick={() => allSelected ? clearSelection() : selectAllVisible()}
                data-testid="select-all-btn"
            >
                <span class="check-mini" aria-hidden="true">
                    {#if allSelected}
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6L9 17l-5-5"/>
                        </svg>
                    {/if}
                </span>
                <span>{allSelected ? `${ui.selected.size} selected` : 'Select all'}</span>
            </button>
        {/if}
        {#each FILTERS as f (f.value)}
            <button
                type="button"
                class="chip"
                class:active={settings.listFilter === f.value}
                onclick={() => setListFilter(f.value)}
                data-testid={`filter-${f.value}`}
            >{f.label}</button>
        {/each}

        {#if settings.aiFeatures && settings.listFilter === 'ai-sorted' && aiRankings.length > 0 && ui.messagesTotal > 0}
            <span class="cat-quick-spacer" aria-hidden="true"></span>
            {@const buckets = (() => {
                const counts: Record<AiCat, number> = {
                    human: 0, family: 0, important: 0, purchase: 0, notification: 0, marketing: 0, info: 0
                };
                for (const m of ui.messages) {
                    const isNotice = isNotificationMessage({
                        from: m.envelope.from,
                        subject: m.envelope.subject,
                        notificationSenders: capabilities.server?.notificationSenders,
                        smsSenders: capabilities.server?.smsSenders
                    });
                    const vipMatch = isVipAddress([
                        m.envelope.from?.[0]?.address,
                        ...((m.envelope.to || []).map((a) => a.address)),
                        ...((m.envelope.cc || []).map((a) => a.address))
                    ]);
                    const cat = effectiveCategory(m.uid, vipMatch, isNotice);
                    if (cat) counts[cat]++;
                }
                return counts;
            })()}
            {#each ['marketing', 'notification', 'purchase'] as cat (cat)}
                {#if buckets[cat as AiCat] > 0}
                    {@const meta = CAT_META[cat as AiCat]}
                    {@const n = buckets[cat as AiCat]}
                    <span class={`cat-quick-group ${meta.tone}`} data-testid={`cat-quick-group-${cat}`}>
                        <button
                            type="button"
                            class={`chip cat-quick-chip ${meta.tone}`}
                            title={`Select all ${n} ${meta.label.toLowerCase()} message${n === 1 ? '' : 's'} for bulk action`}
                            onclick={() => selectByCategory(cat as AiCat)}
                            data-testid={`cat-quick-${cat}`}
                        >
                            <span aria-hidden="true">{meta.emoji}</span>
                            <span>{meta.label}</span>
                            <span class="cat-quick-count">{n}</span>
                        </button>
                        <button
                            type="button"
                            class="cat-act"
                            disabled={categoryActionBusy}
                            title={`Mark all ${n} ${meta.label.toLowerCase()} as read`}
                            aria-label={`Mark all ${meta.label.toLowerCase()} as read`}
                            onclick={() => runCategoryAction(cat as AiCat, 'markRead')}
                            data-testid={`cat-act-read-${cat}`}
                        >
                            <Icon name="mail" size={12} />
                        </button>
                        <button
                            type="button"
                            class="cat-act"
                            disabled={categoryActionBusy}
                            title={`Archive all ${n} ${meta.label.toLowerCase()}`}
                            aria-label={`Archive all ${meta.label.toLowerCase()}`}
                            onclick={() => runCategoryAction(cat as AiCat, 'archive')}
                            data-testid={`cat-act-archive-${cat}`}
                        >
                            <Icon name="archive" size={12} />
                        </button>
                        <button
                            type="button"
                            class="cat-act danger"
                            disabled={categoryActionBusy}
                            title={`Trash all ${n} ${meta.label.toLowerCase()}`}
                            aria-label={`Trash all ${meta.label.toLowerCase()}`}
                            onclick={() => runCategoryAction(cat as AiCat, 'trash')}
                            data-testid={`cat-act-trash-${cat}`}
                        >
                            <Icon name="trash" size={12} />
                        </button>
                    </span>
                {/if}
            {/each}
        {/if}
    </nav>

    {#if suggestAiSort && settings.aiFeatures}
        <div class="ai-sort-suggest" role="status" data-testid="ai-sort-suggest">
            <Icon name="sparkles" size={12} />
            <span>You have a lot of unread mail. Want the AI to surface what's important?</span>
            <button type="button" class="suggest-btn primary" onclick={acceptSuggestion}>View AI sorted</button>
            <button type="button" class="suggest-btn" onclick={dismissSuggestion}>Not now</button>
        </div>
    {/if}

    {#if settings.aiFeatures && (aiSortLoading || aiSortProgress || sweepRunning)}
        {@const progPct = aiSortProgress && aiSortProgress.total > 0
            ? Math.round((aiSortProgress.done / aiSortProgress.total) * 100)
            : 0}
        {@const elapsedMs = Date.now() - aiSortStartTs}
        <div class="ai-sort-glass" role="status" aria-live="polite" data-testid="ai-sort-progress">
            <div class="glass-row glass-head">
                <span class="glass-spinner" aria-hidden="true">
                    <span class="orb"></span>
                    <span class="orb"></span>
                    <span class="orb"></span>
                </span>
                <strong class="glass-title">AI sort</strong>
                {#if aiSortProgress && aiSortProgress.total > 0}
                    <span class="glass-counter">batch {aiSortProgress.done}/{aiSortProgress.total}</span>
                {/if}
                <span class="glass-spacer"></span>
                <span class="glass-elapsed">{Math.max(0, Math.round(elapsedMs / 1000))}s</span>
            </div>
            <div class="glass-bar" aria-hidden="true">
                <span class="glass-fill" style={`--pct: ${Math.max(8, progPct)}%`}></span>
            </div>
            <div class="glass-row glass-detail">
                {#if aiSortProgress && aiSortProgress.total > 0}
                    Scoring relevance & category — {progPct}%
                {:else if sweepRunning}
                    Sweeping for spam &amp; phishing alongside…
                {:else}
                    Asking the model to triage…
                {/if}
            </div>
        </div>
    {/if}

    {#if sweepResults && sweepResults.length > 0 && !sweepDismissed}
        {@const phishCount = sweepResults.filter((c) => c.isPhishing).length}
        {@const spamCount = sweepResults.filter((c) => c.isSpam && !c.isPhishing).length}
        <div class="ai-sort-suggest sweep-banner" role="status" data-testid="sweep-results">
            <Icon name="shieldAlert" size={12} />
            <span>
                Sweep flagged
                {#if phishCount > 0}
                    <strong>{phishCount} phishing</strong>
                {/if}
                {#if phishCount > 0 && spamCount > 0} + {/if}
                {#if spamCount > 0}
                    <strong>{spamCount} spam</strong>
                {/if}
                in this inbox.
            </span>
            {#if phishCount > 0 && sweepDestTrash}
                <button type="button" class="suggest-btn primary" disabled={sweepBulkBusy} onclick={() => applySweep('phishing')}>Move {phishCount} phishing to Trash</button>
            {/if}
            {#if spamCount > 0 && sweepDestSpam}
                <button type="button" class="suggest-btn primary" disabled={sweepBulkBusy} onclick={() => applySweep('spam')}>Move {spamCount} spam to Spam</button>
            {/if}
            <button type="button" class="suggest-btn" onclick={() => { sweepDismissed = true; }}>Dismiss</button>
        </div>
    {/if}

    {#if scanState}
        {@const pct = Math.min(100, Math.round((scanState.scanned / Math.max(1, scanState.total)) * 100))}
        <div class="scan-strip" data-testid="scan-strip" aria-live="polite">
            <span class="scan-label">
                {#if scanState.reason === 'attachments'}
                    Scanning for attachments…
                {:else if scanState.reason === 'starred'}
                    Scanning for starred…
                {:else if scanState.reason === 'unread'}
                    Scanning for unread…
                {:else if scanState.reason === 'search'}
                    Searching mailbox…
                {:else if scanState.reason === 'global-search'}
                    Searching every folder…
                {:else}
                    Loading more…
                {/if}
                <span class="scan-counter">{scanState.scanned.toLocaleString()} / {scanState.total.toLocaleString()}</span>
            </span>
            <span class="scan-bar" aria-hidden="true" style={`--pct: ${pct}%;`}></span>
        </div>
    {/if}

    {#if ui.messagesError}
        <div class="state error" role="alert">{ui.messagesError}</div>
    {:else if !ui.messagesLoading && ui.messages.length === 0}
        <div class="state empty muted">
            <Icon name="inbox" size={32} />
            <p>{ui.search ? 'No matches found.' : 'This folder is empty.'}</p>
        </div>
    {:else if filtered.length === 0 && settings.listFilter !== 'all'}
        <div class="state empty muted">
            <Icon name="inbox" size={32} />
            <p>
                {#if settings.listFilter === 'attachments'}
                    No messages with attachments here.
                {:else}
                    No {settings.listFilter} messages here.
                {/if}
            </p>
            <button type="button" class="btn btn-ghost" onclick={() => setListFilter('all')}>Show all</button>
        </div>
    {:else}
        {#if aiSortLoading}
            <div class="scan-strip" data-testid="ai-sort-strip" aria-live="polite">
                <span class="scan-label">
                    <span class="spinner" style="width:14px;height:14px"></span>
                    <span>AI sorting…</span>
                </span>
            </div>
        {:else if aiSortError}
            <div class="scan-strip error" role="alert" data-testid="ai-sort-error">
                <span class="scan-label">{aiSortError}</span>
            </div>
        {/if}
        <ul class="rows" data-testid="msg-list" onscroll={onListScroll}>
            {#each threads as t (t.id)}
                {@const isThread = t.count > 1}
                {@const isExpanded = isThread && expandedThreads.has(t.id)}
                {@const headMsg = t.latest}
                {@const headIsUnread = isThread ? t.hasUnread : unread(headMsg.flags)}
                {@const headIsStarred = isThread ? t.hasFlagged : flagged(headMsg.flags)}
                {@const headSender = isThread ? senderListText(t) : senderShort(headMsg.envelope.from)}
                {@const headEmail = headMsg.envelope.from?.[0]?.address || ''}
                {@const headName = headMsg.envelope.from?.[0]?.name || null}
                {@const headSelected = ui.selected.has(headMsg.uid)}
                {@const headHasAttachments = isThread ? t.hasAttachments : !!headMsg.hasAttachments}
                {@const headIsTracked = isTrackingEmail(headMsg.envelope.subject)}
                {@const headIsNotice = isNotificationMessage({
                    from: headMsg.envelope.from,
                    subject: headMsg.envelope.subject,
                    notificationSenders: capabilities.server?.notificationSenders,
                    smsSenders: capabilities.server?.smsSenders
                })}
                {@const headIsSms = isSmsMessage({
                    from: headMsg.envelope.from,
                    smsSenders: capabilities.server?.smsSenders
                })}
                {@const headDanger = settings.listFilter === 'ai-sorted' ? dangerLevel(headMsg.uid) : 0}
                {@const headAiCat = settings.listFilter === 'ai-sorted'
                    ? effectiveCategory(headMsg.uid, isVipAddress([
                        headEmail,
                        ...((headMsg.envelope.to || []).map((a) => a.address)),
                        ...((headMsg.envelope.cc || []).map((a) => a.address))
                    ]), headIsNotice)
                    : null}
                {@const headCatPill = headAiCat}
                {@const _isAiThreadFolder = ui.selectedPath === '.AI Conversations' || ui.selectedPath === 'AI Conversations'}
                {@const headPhishing = (settings.phishingScan && !_isAiThreadFolder) ? getCachedScan(ui.selectedPath, headMsg.uid) : null}
                {@const headIsPhishing = (headPhishing?.isPhishing ?? false) && (headPhishing?.confidence ?? 0) >= settings.phishingScanConfidenceFloor}
                {@const headIsSpam = !headIsPhishing && (headPhishing?.isSpam ?? false) && (headPhishing?.spamConfidence ?? 0) >= (settings.spamSuggestConfidenceFloor || 0.7)}
                {@const headFresh = isFresh(headMsg.internalDate || headMsg.envelope.date)}
                {@const headVipFrom = isVipAddress([headEmail])}
                {@const headVipTo = headVipFrom ? null : isVipAddress([
                    ...((headMsg.envelope.to || []).map((a) => a.address)),
                    ...((headMsg.envelope.cc || []).map((a) => a.address))
                ])}
                <li class={isThread ? 'thread-wrap' : ''}>
                    <div
                        class="row"
                        class:unread={headIsUnread}
                        class:fresh={headFresh}
                        class:selected={ui.selectedUid === headMsg.uid}
                        class:bulk-selected={headSelected}
                        class:starred={headIsStarred}
                        class:spy-tracked={headIsTracked}
                        class:notice-row={headIsNotice}
                        class:sms-row={headIsSms}
                        class:danger-1={headDanger === 1}
                        class:danger-2={headDanger === 2}
                        class:danger-3={headDanger === 3}
                        class:danger-4={headDanger === 4}
                        class:phishing-risk={headIsPhishing}
                        class:spam-risk={headIsSpam}
                        class:ai-cat-family={headAiCat === 'family'}
                        class:ai-cat-human={headAiCat === 'human'}
                        class:ai-cat-important={headAiCat === 'important'}
                        class:ai-cat-marketing={headAiCat === 'marketing'}
                        class:ai-cat-info={headAiCat === 'info'}
                        class:thread-head={isThread}
                        class:rule-running={ruleAnimUids.has(headMsg.uid)}
                        class:rule-popping={ruleDoneUids.has(headMsg.uid)}
                        role="button"
                        tabindex="0"
                        draggable="true"
                        ondragstart={(e) => {
                            // Drag every uid in the thread so move/archive
                            // operations affect the whole conversation. If
                            // this row is also part of the bulk selection,
                            // the bulk wins.
                            const baseUids = isThread
                                ? t.messages.map((m) => m.uid)
                                : [headMsg.uid];
                            const uids = ui.selected.has(headMsg.uid)
                                ? Array.from(ui.selected)
                                : baseUids;
                            const dt = e.dataTransfer;
                            if (!dt) return;
                            dt.effectAllowed = 'move';
                            dt.setData('application/x-webmail-uids', JSON.stringify(uids));
                            dt.setData('text/plain', uids.join(','));
                            document.body.dataset.draggingUids = String(uids.length);
                        }}
                        ondragend={() => { delete document.body.dataset.draggingUids; }}
                        onclick={() => { if (isThread) toggleThread(t.id); selectRow(headMsg.uid); }}
                        onkeydown={(e) => { rowKey(e, headMsg.uid); openCtxKeyboard(e, headMsg.uid); }}
                        oncontextmenu={(e) => openCtx(e, headMsg.uid)}
                        data-testid={`msg-row-${headMsg.uid}`}
                    >
                        <span class="unread-dot" aria-hidden="true"></span>
                        <button
                            type="button"
                            class={`avatar-slot ${headSelected ? 'is-checked' : ''}`}
                            title={headSelected ? 'Deselect' : 'Select'}
                            aria-pressed={headSelected}
                            aria-label={headSelected ? 'Deselect message' : 'Select message'}
                            onclick={(e) => { e.stopPropagation(); toggleSelected(headMsg.uid); }}
                            data-testid={`msg-row-check-${headMsg.uid}`}
                        >
                            {#if headIsSms}
                                <span class="sms-avatar" title="SMS gateway" aria-label="SMS gateway">
                                    <Icon name="phone" size={18} />
                                </span>
                            {:else}
                                <Avatar email={headEmail} name={headName} size={32} title={headSender} />
                            {/if}
                            {#if headVipFrom}
                                <VipBadge match={headVipFrom} direction="from" />
                            {:else if headVipTo}
                                <VipBadge match={headVipTo} direction="to" />
                            {/if}
                            <span class="check" aria-hidden="true">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M20 6L9 17l-5-5"/>
                                </svg>
                            </span>
                        </button>
                        <span class="row-main">
                            <span class="row-top">
                                <span class="from truncate">{headSender}</span>
                                {#if isThread}
                                    <span class="thread-count" title={`${t.count} messages in this thread`} aria-label={`${t.count} messages in thread`}>
                                        {t.count}
                                    </span>
                                {/if}
                                {#if headHasAttachments}
                                    <span class="row-attachment-mark" title="Has attachment" aria-label="Has attachment">
                                        <Icon name="paperclip" size={12} />
                                    </span>
                                {/if}
                                <span class="date muted">{formatDate(headMsg.internalDate || headMsg.envelope.date)}</span>
                            </span>
                            <span class="subject truncate">
                                {#if headIsTracked}
                                    <span class="spy-mark" title="Open-tracking notification" aria-label="Tracking notification"><Icon name="spy" size={12} /></span>
                                {/if}
                                {#if headDanger >= 3}
                                    <span class="danger-badge" data-level={headDanger}>{headDanger === 4 ? 'CRITICAL' : 'HIGH'}</span>
                                {/if}
                                {#if headCatPill}
                                    <span
                                        class={`cat-pill ${CAT_META[headCatPill].tone}`}
                                        title={`${CAT_META[headCatPill].label} — AI categorised`}
                                    >
                                        <span class="cat-emoji" aria-hidden="true">{CAT_META[headCatPill].emoji}</span>
                                        <span class="cat-label">{CAT_META[headCatPill].label}</span>
                                    </span>
                                {/if}
                                {#if headMsg.mailbox}
                                    <span class="folder-badge" title={`From folder: ${headMsg.mailbox}`}>
                                        <Icon name="folder" size={10} />
                                        <span>{headMsg.mailbox.split('/').slice(-1)[0] || headMsg.mailbox}</span>
                                    </span>
                                {/if}
                                {headMsg.envelope.subject || '(no subject)'}
                            </span>
                        </span>
                        <span class="row-actions" role="presentation">
                            {#if isThread}
                                <button
                                    type="button"
                                    class={`icon-btn thread-toggle ${isExpanded ? 'open' : ''}`}
                                    title={isExpanded ? 'Collapse thread' : 'Expand thread'}
                                    aria-label={isExpanded ? 'Collapse thread' : 'Expand thread'}
                                    aria-expanded={isExpanded}
                                    onclick={(e) => { e.stopPropagation(); toggleThread(t.id); }}
                                >
                                    <Icon name="chevronRight" size={14} />
                                </button>
                            {/if}
                            <button
                                type="button"
                                class={`icon-btn ${headIsStarred ? 'star-on' : ''}`}
                                title={headIsStarred ? 'Remove star' : 'Star'}
                                aria-label={headIsStarred ? 'Remove star' : 'Star'}
                                onclick={(e) => { e.stopPropagation(); onStar(headMsg.uid); }}
                            >
                                <Icon name={headIsStarred ? 'starFilled' : 'star'} size={15} />
                            </button>
                            <button
                                type="button"
                                class="icon-btn"
                                title={headIsUnread ? 'Mark as read' : 'Mark as unread'}
                                aria-label={headIsUnread ? 'Mark as read' : 'Mark as unread'}
                                onclick={(e) => { e.stopPropagation(); onUnread(headMsg.uid); }}
                            >
                                <Icon name="mail" size={15} />
                            </button>
                            <button
                                type="button"
                                class="icon-btn"
                                title="Archive (e)"
                                aria-label="Archive"
                                onclick={(e) => { e.stopPropagation(); onArchive(headMsg.uid); }}
                            >
                                <Icon name="archive" size={15} />
                            </button>
                            <button
                                type="button"
                                class="icon-btn danger"
                                title="Move to Trash"
                                aria-label="Move to Trash"
                                onclick={(e) => { e.stopPropagation(); onTrash(headMsg.uid); }}
                            >
                                <Icon name="trash" size={15} />
                            </button>
                        </span>
                    </div>

                    {#if isExpanded}
                        <ul class="thread-children" aria-label="Earlier messages in this thread">
                            {#each t.messages.slice(1) as childMsg (childMsg.uid)}
                                {@const childUnread = unread(childMsg.flags)}
                                {@const childStarred = flagged(childMsg.flags)}
                                {@const childSender = senderShort(childMsg.envelope.from)}
                                {@const childEmail = childMsg.envelope.from?.[0]?.address || ''}
                                {@const childName = childMsg.envelope.from?.[0]?.name || null}
                                <li>
                                    <div
                                        class="row child-row"
                                        class:unread={childUnread}
                                        class:selected={ui.selectedUid === childMsg.uid}
                                        class:starred={childStarred}
                                        role="button"
                                        tabindex="0"
                                        onclick={() => selectRow(childMsg.uid)}
                                        onkeydown={(e) => { rowKey(e, childMsg.uid); openCtxKeyboard(e, childMsg.uid); }}
                                        oncontextmenu={(e) => openCtx(e, childMsg.uid)}
                                        data-testid={`msg-row-child-${childMsg.uid}`}
                                    >
                                        <span class="thread-spine" aria-hidden="true"></span>
                                        <Avatar email={childEmail} name={childName} size={26} title={childSender} />
                                        <span class="row-main">
                                            <span class="row-top">
                                                <span class="from truncate">{childSender}</span>
                                                {#if childMsg.hasAttachments}
                                                    <span class="row-attachment-mark"><Icon name="paperclip" size={11} /></span>
                                                {/if}
                                                <span class="date muted">{formatDate(childMsg.internalDate || childMsg.envelope.date)}</span>
                                            </span>
                                            <span class="subject truncate muted">{childMsg.envelope.subject || '(no subject)'}</span>
                                        </span>
                                        <span class="row-actions">
                                            <button
                                                type="button"
                                                class={`icon-btn ${childStarred ? 'star-on' : ''}`}
                                                title={childStarred ? 'Remove star' : 'Star'}
                                                aria-label={childStarred ? 'Remove star' : 'Star'}
                                                onclick={(e) => { e.stopPropagation(); onStar(childMsg.uid); }}
                                            >
                                                <Icon name={childStarred ? 'starFilled' : 'star'} size={13} />
                                            </button>
                                        </span>
                                    </div>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </li>
            {/each}
            {#if appendingMore}
                <li class="rows-loading" aria-live="polite">
                    <span class="spinner"></span>
                    <span class="muted small">Loading more…</span>
                </li>
            {/if}
        </ul>
    {/if}

    {#if totalPages > 1}
        <footer class="list-footer">
            <button
                type="button"
                class="btn btn-ghost"
                disabled={ui.messagesPage <= 0}
                onclick={() => onPageChange(ui.messagesPage - 1)}
            >
                <Icon name="chevronLeft" size={14} /> Prev
            </button>
            <span class="muted">Page {ui.messagesPage + 1} / {totalPages}</span>
            <button
                type="button"
                class="btn btn-ghost"
                disabled={ui.messagesPage + 1 >= totalPages}
                onclick={() => onPageChange(ui.messagesPage + 1)}
            >
                Next <Icon name="chevronRight" size={14} />
            </button>
        </footer>
    {/if}

    <EventsScanPanel
        messages={ui.messages}
        open={eventsScanOpen}
        onClose={() => (eventsScanOpen = false)}
    />

    <!-- Mounted only while a message is held, so the dialog's onMount
         (which probes the rules API, outbound webhooks and the mailbox
         list) fires once per open rather than on every list render. -->
    {#if ruleFromMessage}
        <RuleFromMessageDialog
            message={ruleFromMessage}
            onClose={() => (ruleFromMessage = null)}
        />
    {/if}

    <!-- Slow folder-switch overlay. Frosted glass over the rows area so
         the user can't confuse leftover mail from the previous folder with
         what's about to load. Only renders after ~280ms of loading — fast
         folders never flash. The header is kept above the overlay so the
         folder name visibly changes before anything else does. -->
    {#if loadingSlow && ui.messagesLoading}
        <div class="folder-load-overlay" aria-hidden="true" data-testid="folder-load-overlay">
            <div class="folder-load-card" role="status" aria-live="polite">
                <span class="folder-load-spinner"></span>
                <span class="folder-load-label">Loading <strong>{prettyName(ui.selectedPath)}</strong>…</span>
            </div>
        </div>
    {/if}
</section>

<!-- Escape handling for the whole context menu.

     Two things make this fiddly:
       1. Layout registers a document-level Escape handler that clears the
          selection and closes the reading pane. Without capture phase, our
          Escape and Layout's both run and one Escape press nukes three
          things. Capturing here gets in front of it.
       2. Capture runs BEFORE the submenu's own Escape handler, so this
          handler would otherwise always win and close the entire menu on
          the first press — killing the two-stage close. Hence the
          `submenuOpen()` guard: while the folder submenu is open we return
          untouched and let MenuSubmenu consume the key at the target.

     Net behaviour: Escape in the submenu closes the submenu only; Escape
     anywhere else in the menu closes the whole menu. Svelte allows one
     <svelte:window> per component, so this shares the element that already
     handled click/right-click dismissal. -->
<svelte:window
    onclick={closeCtx}
    oncontextmenu={(e) => {
        if (ctx && !(e.target as HTMLElement)?.closest?.('.row')) closeCtx();
    }}
    onkeydowncapture={(e) => {
        if (!ctx) return;
        if (e.key === 'Escape') {
            // Stand down while the folder submenu is showing so MenuSubmenu
            // can consume it at the target (its own handler runs after this
            // capture pass). The second Escape — submenu now shut, guard now
            // false — falls through and closes the whole menu.
            if (submenuOpen()) return;
            e.preventDefault();
            e.stopPropagation();
            closeCtx();
            return;
        }
        // Arrow/Home/End are stopPropagation'd inside ctxMenuKey because
        // Layout registers a BUBBLE-phase keydown on document that uses
        // ArrowUp/ArrowDown to move the message selection. preventDefault
        // alone would NOT stop it: the event still reaches document's
        // bubble listener, so a single ArrowDown would both walk the menu
        // and change which message is open behind it.
        ctxMenuKey(e);
    }}
/>

{#if ctx}
    {@const m = rowOf(ctx.uid)}
    {#if m}
        {@const isUnread = unread(m.flags)}
        {@const isFlagged = flagged(m.flags)}
        <!-- The position attributes are written by placeCtx() once the menu
             is measurable, not from ctx.x/ctx.y directly: the menu is
             position:fixed, so its final spot depends on how big it turned
             out to be, which cannot be known before it is in the document.
             Until that first measurement lands ctxPos is null and the menu
             gets no top/left at all, so it renders at the viewport origin
             for a single frame — .msg-ctx-unplaced hides that frame rather
             than flashing the whole menu into the top-left corner. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- The ul's onclick only shields inside-clicks from the
             <svelte:window> close handler above; all interactivity lives in
             the menuitem buttons and all keyboard handling (Escape, arrows,
             Home/End) is the window capture handler above, so there is no
             key event for this container to take. -->
        <ul
            class={ctxPos ? 'msg-ctx' : 'msg-ctx msg-ctx-unplaced'}
            role="menu"
            bind:this={ctxEl}
            aria-label="Message actions"
            style={ctxPos ? `top: ${ctxPos.top}px; left: ${ctxPos.left}px;` : undefined}
            onclick={(e) => e.stopPropagation()}
            oncontextmenu={(e) => e.preventDefault()}
            data-testid="msg-ctx"
        >
            <li><button type="button" role="menuitem" onclick={() => { selectRow(ctx!.uid); closeCtx(); }}>
                <Icon name="mail" size={12} /> Open
            </button></li>
            <li><button type="button" role="menuitem" onclick={() => { onStar(ctx!.uid); closeCtx(); }}>
                <Icon name={isFlagged ? 'starFilled' : 'star'} size={12} /> {isFlagged ? 'Unstar' : 'Star'}
            </button></li>
            <li><button type="button" role="menuitem" onclick={() => { onUnread(ctx!.uid); closeCtx(); }}>
                <Icon name="eye" size={12} /> Mark as {isUnread ? 'read' : 'unread'}
            </button></li>
            <li class="sep"></li>
            <li><button type="button" role="menuitem" onclick={() => { onArchive(ctx!.uid); closeCtx(); }}>
                <Icon name="archive" size={12} /> Archive
            </button></li>
            <!-- `openRuleFromMessage(m)` must run BEFORE `closeCtx()`. The other
                 items in this menu call closeCtx() last, and that order matters:
                 closeCtx() nulls `ctx` synchronously, so a handler that reads
                 ctx afterwards throws "Cannot read properties of null". Passing
                 the already-resolved `m` first sidesteps that entirely. -->
            <li><button type="button" role="menuitem" onclick={() => { openRuleFromMessage(m); closeCtx(); }}>
                <Icon name="filter" size={12} /> Create rule from message
            </button></li>
            {#if onMove && ui.mailboxes.length}
                {@const bulkN = ui.selected.has(ctx.uid) ? ui.selected.size : 0}
                <!-- The folder list lives in a submenu, NOT inline. Dumping
                     every folder into the parent made the context menu taller
                     than the message list it was opened from; one chevron row
                     keeps the menu a fixed handful of actions no matter how
                     many mailboxes the account has. The submenu renders the
                     full list (no .slice cap) in a scrolling, edge-flipping
                     panel — see MenuSubmenu.svelte. -->
                <MenuSubmenu
                    label={bulkN > 1 ? `Move ${bulkN} selected to…` : 'Move to…'}
                    icon="move"
                    items={moveTargets}
                    onSelect={moveTo}
                    testid="ctx-move"
                />
            {/if}
            <!-- "Send to external webhook" — the persistent version of
                 "always send from this sender". Sits directly under "Create
                 rule from message" because it IS one: a from-contains rule
                 with a webhook action, created with the values the user has
                 already indicated by right-clicking instead of a form to
                 refill. Its own submenu rather than inline items because the
                 webhook count belongs to the user, not to us, and inlining
                 it would make this menu's height unbounded — same reasoning
                 as "Move to…" above.

                 The trigger is shown whenever the message has a From
                 address, even with zero webhooks configured: the empty
                 panel says where to make one. Hiding the trigger instead
                 would mean the user has no way to discover the feature
                 exists. The genuinely hidden case is a message with no
                 From address at all, where there is no rule to key on. -->
            {#if m.envelope.from?.[0]?.address}
                <MenuSubmenu
                    label="Send to external webhook…"
                    icon="globe"
                    items={webhookItems ?? []}
                    emptyText={webhookLoading ? 'Loading your webhooks…' : webhookNote}
                    onSelect={sendSenderToWebhook}
                    onOpen={loadWebhookTargets}
                    testid="ctx-webhook"
                />
            {/if}
            <li class="sep"></li>
            {#if onBlockSender}
                <!-- Both wider patterns are derived from the row's own From
                     header — no fetch, and `m` is already resolved above, so
                     these are one string build per menu open.
                     The patterns are passed as ARGUMENTS, not as a mode flag:
                     Layout still owns the single confirm → blockSender →
                     toast → error flow and names whatever pattern it is
                     handed, so there is no second copy of that flow here.
                     Each item disappears when its pattern is unavailable — no
                     From address, an IP literal, or a host that is already its
                     own root (`example.com`) — rather than offering an entry
                     that can only fail. Plain "Block sender" stays
                     unconditional: Layout reports a missing address itself. -->
                {@const ctxFrom = m.envelope.from?.[0]?.address ?? null}
                {@const domPat = domainPattern(ctxFrom)}
                {@const rootPat = rootDomainPattern(ctxFrom)}
                <li><button type="button" role="menuitem" class="danger" onclick={() => { onBlockSender!(ctx!.uid); closeCtx(); }}>
                    <Icon name="spam" size={12} /> Block sender
                </button></li>
                {#if domPat}
                    <li><button type="button" role="menuitem" class="danger" title={`Block every sender at ${domPat}`} onclick={() => { onBlockSender!(ctx!.uid, domPat); closeCtx(); }}>
                        <Icon name="spam" size={12} /> Block domain
                    </button></li>
                {/if}
                {#if rootPat}
                    <li><button type="button" role="menuitem" class="danger" title={`Block every sender under ${rootPat}`} onclick={() => { onBlockSender!(ctx!.uid, rootPat); closeCtx(); }}>
                        <Icon name="spam" size={12} /> Block root domain
                    </button></li>
                {/if}
            {/if}
            <li><button type="button" role="menuitem" class="danger" onclick={() => { onTrash(ctx!.uid); closeCtx(); }}>
                <Icon name="trash" size={12} /> Move to Trash
            </button></li>
        </ul>
    {/if}
{/if}

<style>
    .list {
        border-right: 1px solid var(--border-subtle);
        background: var(--bg-base);
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        position: relative;
        overflow-x: hidden;
    }
    /* Glassy folder-switch overlay. Sits over the rows area only — the
       header is below in the DOM but rendered above (z-index) so the
       folder name still changes immediately. Pointer-events none so the
       user can still scroll if cached rows happen to be visible. */
    .folder-load-overlay {
        position: absolute;
        inset: 0;
        z-index: 5;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 86px;
        background: color-mix(in srgb, var(--bg-base) 55%, transparent);
        backdrop-filter: blur(8px) saturate(135%);
        -webkit-backdrop-filter: blur(8px) saturate(135%);
        animation: folder-load-fade-in 220ms ease-out;
        pointer-events: none;
    }
    .folder-load-card {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 9px 16px 9px 12px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
        border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border-subtle));
        box-shadow:
            0 6px 20px color-mix(in srgb, var(--accent) 18%, transparent),
            0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent) inset;
        color: var(--text-primary);
        font-size: 12.5px;
        font-weight: 500;
    }
    .folder-load-card strong { font-weight: 700; }
    .folder-load-spinner {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
        border-top-color: var(--accent);
        animation: folder-load-spin 0.85s linear infinite;
    }
    @keyframes folder-load-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
    }
    @keyframes folder-load-spin {
        to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
        .folder-load-overlay { animation: none; }
        .folder-load-spinner { animation: none; }
    }
    .list-header {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 16px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-surface);
    }
    .list-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title-folder {
        font-weight: 700;
        font-size: 15px;
        letter-spacing: -0.01em;
        color: var(--text-primary);
    }
    .search-tag {
        padding: var(--pill-padding);
        background: var(--bg-tag);
        border-radius: var(--radius-sm);
        font-size: 12px;
        color: var(--text-tertiary);
    }
    .list-meta {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 12px;
    }
    /* Glowing accent button for the AI inbox briefing — sweeps a subtle
     * shimmer across itself so the eye finds it even at a glance. */
    .ai-summary-btn {
        color: var(--accent-text);
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 18%, transparent),
            color-mix(in srgb, var(--accent) 8%, transparent));
        border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
        font-weight: 600;
        position: relative;
        overflow: hidden;
        animation: ai-sum-breathe 3s ease-in-out infinite;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent);
        padding: 2px 7px;
        font-size: 11px;
        gap: 3px;
    }
    .ai-summary-btn::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(120deg,
            transparent 30%,
            color-mix(in srgb, white 38%, transparent) 50%,
            transparent 70%);
        transform: translateX(-100%);
        animation: ai-sum-sweep 4.5s ease-in-out infinite;
        pointer-events: none;
    }
    .ai-summary-btn:hover {
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 26%, transparent),
            color-mix(in srgb, var(--accent) 14%, transparent));
        color: var(--accent-text);
    }
    @keyframes ai-sum-breathe {
        0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent), 0 0 0 0 color-mix(in srgb, var(--accent) 30%, transparent); }
        50%      { box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent), 0 0 8px 2px color-mix(in srgb, var(--accent) 32%, transparent); }
    }
    @keyframes ai-sum-sweep {
        0%, 60% { transform: translateX(-100%); }
        100%    { transform: translateX(220%); }
    }
    @media (prefers-reduced-motion: reduce) {
        .ai-summary-btn { animation: none; }
        .ai-summary-btn::before { display: none; }
    }
    .filter-chips {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 6px 14px;
        background: var(--bg-surface);
        border-bottom: 1px solid var(--border-subtle);
        overflow-x: auto;
        scrollbar-width: none;
    }
    .filter-chips::-webkit-scrollbar { display: none; }

    /* Background-crawl progress strip — sits under the chip row while the
     * crawler is paging through the rest of the mailbox to satisfy a
     * filter or search. Thin, unobtrusive, but signals that work is in
     * flight so the user doesn't think the filter is broken. */
    .scan-strip {
        flex: 0 0 auto;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 5px 14px 8px;
        background: var(--bg-surface);
        border-bottom: 1px solid var(--border-subtle);
        font-size: 11.5px;
        color: var(--text-tertiary);
    }
    .scan-strip .scan-label {
        display: inline-flex;
        align-items: center;
        gap: 8px;
    }
    .scan-strip .scan-counter {
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        font-weight: 600;
    }
    .scan-strip .scan-bar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 2px;
        background: linear-gradient(90deg,
            var(--accent),
            color-mix(in srgb, var(--accent) 50%, #d268f4));
        width: var(--pct, 0%);
        transition: width 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
        box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 50%, transparent);
    }
    .chip {
        flex: 0 0 auto;
        padding: 5px 12px;
        border-radius: 999px;
        background: transparent;
        color: var(--text-secondary);
        font-size: 12.5px;
        font-weight: 500;
        border: 1px solid transparent;
        transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
    }
    .chip:hover { background: var(--bg-hover); color: var(--text-primary); transform: translateY(-0.5px); }
    .chip { transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast), transform 120ms ease; }
    .chip.active {
        background: var(--accent-soft);
        color: var(--accent-text);
        border-color: color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        font-weight: 600;
    }
    .select-all-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .cat-quick-spacer {
        flex: 0 0 1px;
        align-self: stretch;
        margin: 4px 4px;
        background: var(--border-subtle);
    }
    .cat-quick-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11.5px;
        text-transform: capitalize;
    }
    .cat-quick-chip .cat-quick-count {
        font-variant-numeric: tabular-nums;
        background: rgba(255, 255, 255, 0.55);
        border-radius: 999px;
        padding: 0 6px;
        font-size: 10.5px;
        font-weight: 700;
    }
    :global(html.dark) .cat-quick-chip .cat-quick-count,
    :global([data-theme="dark"]) .cat-quick-chip .cat-quick-count {
        background: rgba(255, 255, 255, 0.1);
    }

    /* Inline per-category action group: [chip][read][archive][trash].
       The chip + buttons share a tinted card so it reads as one unit. */
    .cat-quick-group {
        display: inline-flex;
        align-items: stretch;
        gap: 0;
        border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
        border-radius: 999px;
        overflow: hidden;
        background: var(--bg-surface);
    }
    .cat-quick-group .cat-quick-chip {
        border: 0;
        border-radius: 999px 0 0 999px;
        background: transparent;
    }
    .cat-quick-group .cat-act {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        padding: 0;
        border: 0;
        border-left: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        background: transparent;
        color: inherit;
        cursor: pointer;
        transition: background var(--transition-fast), color var(--transition-fast);
    }
    .cat-quick-group .cat-act:hover {
        background: color-mix(in srgb, currentColor 14%, transparent);
    }
    .cat-quick-group .cat-act.danger:hover {
        background: var(--danger-soft);
        color: var(--danger);
    }
    .cat-quick-group .cat-act:disabled { opacity: 0.45; cursor: not-allowed; }
    .cat-quick-group .cat-act:last-child { border-radius: 0 999px 999px 0; }
    .check-mini {
        width: 14px;
        height: 14px;
        border-radius: 4px;
        border: 1.5px solid color-mix(in srgb, currentColor 55%, transparent);
        background: var(--bg-canvas, #fff);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 140ms ease, border-color 140ms ease;
    }
    .select-all-chip.active .check-mini {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--text-on-accent, #fff);
    }

    /* Compact AI icon-button group sitting at the start of the chip row.
       Each child keeps its own per-button accent (magic gradient / glow)
       but shares the same square footprint so the trio reads as one cluster. */
    .ai-action-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-right: 4px;
    }
    .ai-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border-radius: 8px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-surface);
        color: var(--text-secondary);
        cursor: pointer;
        flex-shrink: 0;
        transition: background var(--transition-fast), color var(--transition-fast), filter 120ms ease, transform 80ms ease;
    }
    .ai-icon-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
        transform: translateY(-0.5px);
    }
    .ai-icon-btn.ai-summary-btn {
        color: white;
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 80%, transparent),
            color-mix(in srgb, var(--accent) 55%, transparent));
        border-color: color-mix(in srgb, var(--accent) 50%, transparent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .ai-icon-btn.ai-summary-btn:hover {
        filter: brightness(1.08);
        color: white;
    }
    /* Calendar scan — same brightness as briefing/sort, plus a subtle
     * sparkle pip that orbits the icon so it reads as the "extra magic"
     * affordance in the trio. */
    .ai-icon-btn.calendar-scan-btn {
        position: relative;
        color: white;
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 80%, transparent),
            color-mix(in srgb, #d268f4 55%, transparent));
        border-color: color-mix(in srgb, var(--accent) 50%, transparent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent);
        overflow: hidden;
    }
    .ai-icon-btn.calendar-scan-btn:hover {
        filter: brightness(1.08);
        color: white;
    }
    .ai-icon-btn.calendar-scan-btn::before {
        /* Diagonal shimmer band — matches the briefing button's animation
         * tone but slightly slower so the trio reads as varied. */
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(120deg,
            transparent 30%,
            color-mix(in srgb, white 42%, transparent) 50%,
            transparent 70%);
        transform: translateX(-100%);
        animation: cal-spark-sweep 5.2s ease-in-out infinite;
        pointer-events: none;
    }
    .ai-icon-btn.calendar-scan-btn .cal-spark {
        position: absolute;
        top: 4px;
        right: 4px;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: white;
        box-shadow: 0 0 6px 2px rgba(255, 255, 255, 0.85);
        animation: cal-spark-twinkle 1.8s ease-in-out infinite;
        pointer-events: none;
    }
    @keyframes cal-spark-sweep {
        0%, 60% { transform: translateX(-100%); }
        100%    { transform: translateX(220%); }
    }
    @keyframes cal-spark-twinkle {
        0%, 100% { opacity: 0.35; transform: scale(0.85); }
        50%      { opacity: 1;    transform: scale(1.25); }
    }
    @media (prefers-reduced-motion: reduce) {
        .ai-icon-btn.calendar-scan-btn::before { display: none; }
        .ai-icon-btn.calendar-scan-btn .cal-spark { animation: none; opacity: 0.7; }
    }
    /* Magic-btn / ai-summary-btn keep their gradient + animations, but we
       square them off and shrink them to match the icon group. Rules below
       override the wider defaults further down the file. */
    .ai-action-group .magic-btn,
    .ai-action-group .ai-summary-btn {
        width: 28px;
        height: 28px;
        padding: 0;
        gap: 0;
        border-radius: 8px;
        font-size: 12px;
    }

    /* Magic-style AI sort button — visually distinct from the regular chips
       so it reads as "this is something special the AI does for you". */
    .magic-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 11px;
        font-size: 12px;
        font-weight: 600;
        color: white;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--accent), #d268f4);
        border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
        box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent);
        cursor: pointer;
        flex-shrink: 0;
        transition: filter 120ms ease, transform 80ms ease;
    }
    .magic-btn:hover { filter: brightness(1.08); transform: translateY(-0.5px); }
    .magic-btn:active { transform: translateY(0); }
    .magic-btn.active {
        box-shadow:
            0 2px 8px color-mix(in srgb, var(--accent) 50%, transparent),
            0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent);
    }
    .magic-btn.loading { animation: magic-pulse 1.4s ease-in-out infinite; }
    @keyframes magic-pulse {
        0%, 100% { filter: brightness(1); }
        50%      { filter: brightness(1.15) saturate(1.2); }
    }

    /* Glass-morph progress card for AI sort. Sticks until the run
     * completes; the user clicking elsewhere doesn't dismiss it. */
    .ai-sort-glass {
        position: relative;
        margin: 0 12px 8px;
        padding: 10px 14px 12px;
        border-radius: 14px;
        background:
            linear-gradient(135deg,
                color-mix(in srgb, var(--accent) 16%, transparent),
                color-mix(in srgb, #d268f4 12%, transparent) 60%,
                color-mix(in srgb, var(--accent) 8%, transparent));
        backdrop-filter: blur(14px) saturate(1.4);
        -webkit-backdrop-filter: blur(14px) saturate(1.4);
        border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        box-shadow:
            0 8px 24px -8px color-mix(in srgb, var(--accent) 35%, transparent),
            inset 0 1px 0 rgba(255, 255, 255, 0.45);
        color: var(--text-primary);
        font-size: 12.5px;
        overflow: hidden;
    }
    .ai-sort-glass::before {
        /* Slow rainbow shimmer — ties the visual tone to the magic-btn
         * gradient without being noisy. */
        content: '';
        position: absolute;
        inset: -50% -10% auto -10%;
        height: 200%;
        background: conic-gradient(
            from 0deg,
            transparent 0deg,
            color-mix(in srgb, var(--accent) 14%, transparent) 60deg,
            transparent 120deg,
            color-mix(in srgb, #d268f4 18%, transparent) 200deg,
            transparent 280deg,
            color-mix(in srgb, var(--accent) 14%, transparent) 360deg);
        opacity: 0.55;
        animation: glass-spin 8s linear infinite;
        pointer-events: none;
        z-index: 0;
    }
    @keyframes glass-spin { to { transform: rotate(360deg); } }
    .ai-sort-glass > * { position: relative; z-index: 1; }
    .glass-row {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .glass-head { margin-bottom: 8px; }
    .glass-spacer { flex: 1; }
    .glass-title { font-weight: 700; letter-spacing: 0.01em; }
    .glass-counter, .glass-elapsed {
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        padding: 2px 7px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.45);
        border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .glass-detail {
        font-size: 11.5px;
        color: var(--text-secondary);
        margin-top: 6px;
    }
    .glass-spinner {
        display: inline-flex;
        gap: 4px;
        align-items: center;
    }
    .glass-spinner .orb {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: linear-gradient(135deg, var(--accent), #d268f4);
        box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 70%, transparent);
        animation: glass-bounce 1.05s ease-in-out infinite;
    }
    .glass-spinner .orb:nth-child(2) { animation-delay: 0.12s; }
    .glass-spinner .orb:nth-child(3) { animation-delay: 0.24s; }
    @keyframes glass-bounce {
        0%, 80%, 100% { transform: translateY(0); opacity: 0.55; }
        40%           { transform: translateY(-4px); opacity: 1; }
    }
    .glass-bar {
        position: relative;
        height: 6px;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.35);
        overflow: hidden;
    }
    .glass-fill {
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: var(--pct, 8%);
        background: linear-gradient(90deg, var(--accent), #d268f4);
        box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 60%, transparent);
        transition: width 280ms cubic-bezier(0.25, 0.8, 0.25, 1);
        border-radius: 3px;
    }
    .glass-fill::after {
        /* Diagonal stripe that travels along the fill so even at low
         * percentages the bar reads as live, not stuck. */
        content: '';
        position: absolute;
        inset: 0;
        background-image: linear-gradient(
            45deg,
            rgba(255, 255, 255, 0.35) 25%,
            transparent 25%,
            transparent 50%,
            rgba(255, 255, 255, 0.35) 50%,
            rgba(255, 255, 255, 0.35) 75%,
            transparent 75%);
        background-size: 14px 14px;
        animation: glass-stripe 700ms linear infinite;
    }
    @keyframes glass-stripe { to { background-position: 14px 0; } }
    @media (prefers-reduced-motion: reduce) {
        .ai-sort-glass::before,
        .glass-spinner .orb,
        .glass-fill::after { animation: none; }
    }
    :global(html.dark) .ai-sort-glass,
    :global([data-theme="dark"]) .ai-sort-glass {
        box-shadow:
            0 8px 24px -8px color-mix(in srgb, var(--accent) 35%, transparent),
            inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }
    :global(html.dark) .glass-counter,
    :global(html.dark) .glass-elapsed,
    :global([data-theme="dark"]) .glass-counter,
    :global([data-theme="dark"]) .glass-elapsed {
        background: rgba(255, 255, 255, 0.06);
    }
    :global(html.dark) .glass-bar,
    :global([data-theme="dark"]) .glass-bar {
        background: rgba(255, 255, 255, 0.08);
    }

    .ai-sort-suggest {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        margin: 0 12px 8px;
        font-size: 12.5px;
        background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--accent) 12%, var(--bg-surface)),
            color-mix(in srgb, #d268f4 8%, var(--bg-surface))
        );
        border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        border-radius: 10px;
        color: var(--text-primary);
        animation: slide-fade-in 280ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .ai-sort-suggest > span { flex: 1; min-width: 0; }
    .suggest-btn {
        flex-shrink: 0;
        font-size: 11.5px;
        font-weight: 600;
        padding: 4px 10px;
        border-radius: 999px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        cursor: pointer;
    }
    .suggest-btn.primary {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
    }
    .suggest-btn.primary:hover { filter: brightness(1.05); }
    .suggest-btn:hover { background: var(--bg-hover); }
    @keyframes slide-fade-in {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
    }
    .rows {
        flex: 1;
        overflow-y: auto;
        /* A row whose content momentarily exceeds the column — a long
         * subject before ellipsis is applied, a badge appearing, the
         * crawler appending rows — would otherwise open a horizontal
         * scrollbar at the foot of the pane. Because that happens on a
         * timer, the scrollbar didn't just appear, it pulsed. Rows are
         * meant to truncate, never to scroll sideways. */
        overflow-x: hidden;
        list-style: none;
        margin: 0;
        padding: 0;
        min-width: 0;
    }
    .rows-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 16px;
        color: var(--text-tertiary);
    }
    /* Right-click context menu — same shape as the folder menu in Sidebar.svelte. */
    .msg-ctx {
        position: fixed;
        list-style: none;
        margin: 0;
        padding: 4px;
        min-width: 220px;
        max-height: 70vh;
        overflow-y: auto;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 200;
        animation: fade-in 120ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    /* The single frame between mount and the first placeCtx() measurement.
       position:fixed with no top/left resolves to the viewport origin, so
       without this the menu visibly jumps from the top-left corner to the
       pointer on every right-click. Hidden rather than opacity:0, so it
       cannot be clicked or tabbed into at the wrong place either. */
    .msg-ctx-unplaced { visibility: hidden; }
    .msg-ctx li { list-style: none; }
    .msg-ctx li.sep { height: 1px; margin: 4px 0; background: var(--border-subtle); }
    .msg-ctx button {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 10px;
        font-size: 12.5px;
        text-align: left;
        border-radius: var(--radius-xs);
        color: var(--text-primary);
    }
    .msg-ctx button:hover { background: var(--bg-hover); }
    .msg-ctx button.danger { color: var(--danger); }
    .msg-ctx button.danger:hover { background: var(--danger-soft); }
    .row {
        display: grid;
        grid-template-columns: 32px 1fr auto;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 11px 16px 11px 18px;
        text-align: left;
        border-bottom: 1px solid var(--border-subtle);
        transition: background-color var(--transition-fast), box-shadow var(--transition-fast);
        cursor: pointer;
        position: relative;
    }
    /* Density: compact = ~28px row height. Comfortable = default. */
    :global(.shell[data-density="compact"]) .row { padding: 6px 16px 6px 18px; }
    :global(.shell[data-density="compact"]) .avatar-slot { width: 26px; height: 26px; }
    :global(.shell[data-density="compact"]) .avatar { width: 26px; height: 26px; font-size: 11px; }
    :global(.shell[data-density="compact"]) .row-main { gap: 0; }
    :global(.shell[data-density="compact"]) .row .from { font-size: 12.5px; }
    :global(.shell[data-density="compact"]) .row .subject { font-size: 12.5px; }
    .row:hover {
        background: var(--bg-hover);
        transform: translateY(-0.5px);
        z-index: 1;
    }
    .row {
        transition: background-color var(--transition-fast), box-shadow var(--transition-fast), transform 120ms ease;
    }
    .row.selected {
        background: var(--bg-selected);
        box-shadow: inset 3px 0 0 var(--accent);
    }
    .row.unread { background: var(--bg-surface); }
    /* "Fresh": arrived in the last 10 minutes. Soft sparkly halo so the
       user instantly spots brand-new mail without any extra UI element. */
    .row.fresh {
        position: relative;
        background:
            radial-gradient(120% 220% at 0% 50%,
                color-mix(in srgb, var(--accent) 18%, transparent) 0%,
                transparent 55%),
            var(--bg-surface);
        animation: fresh-pulse 2.4s ease-in-out infinite;
    }
    .row.fresh::after {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image:
            radial-gradient(circle at 12% 26%, color-mix(in srgb, var(--accent) 80%, white) 0 1.4px, transparent 2px),
            radial-gradient(circle at 32% 78%, color-mix(in srgb, var(--accent) 70%, white) 0 1.2px, transparent 2px),
            radial-gradient(circle at 78% 18%, color-mix(in srgb, #d268f4 70%, white) 0 1.2px, transparent 2px),
            radial-gradient(circle at 92% 64%, color-mix(in srgb, var(--accent) 80%, white) 0 1.4px, transparent 2px);
        opacity: 0.85;
        animation: fresh-twinkle 1.8s ease-in-out infinite;
    }
    @keyframes fresh-pulse {
        0%, 100% { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 70%, transparent); }
        50%      { box-shadow: inset 3px 0 0 var(--accent), 0 0 14px color-mix(in srgb, var(--accent) 22%, transparent); }
    }
    @keyframes fresh-twinkle {
        0%, 100% { opacity: 0.35; transform: scale(0.9); }
        50%      { opacity: 0.95; transform: scale(1.1); }
    }
    @media (prefers-reduced-motion: reduce) {
        .row.fresh, .row.fresh::after { animation: none; }
    }
    /* Read rows get a subtle inset bezel — like a softly-pressed button.
     * Distinguishes them from the punchier unread rows without making
     * them look 'disabled'. */
    .row:not(.unread):not(.selected) {
        background: linear-gradient(180deg,
            color-mix(in srgb, var(--bg-base) 96%, var(--text-tertiary)) 0%,
            var(--bg-base) 60%);
        box-shadow:
            inset 0 1px 1px color-mix(in srgb, var(--text-primary) 5%, transparent),
            inset 0 -1px 0 color-mix(in srgb, var(--text-primary) 2%, transparent);
        color: var(--text-secondary);
    }
    .row:not(.unread):not(.selected) .from,
    .row:not(.unread):not(.selected) .subject {
        font-weight: 400;
        color: var(--text-secondary);
    }
    .row:not(.unread):not(.selected) .preview {
        color: var(--text-tertiary);
    }
    .unread-dot {
        position: absolute;
        left: 6px;
        top: 50%;
        transform: translateY(-50%);
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: transparent;
    }
    .row.unread .unread-dot {
        background: var(--unread-dot);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--unread-dot) 22%, transparent);
    }
    .avatar-slot {
        position: relative;
        width: 32px; height: 32px;
        padding: 0;
        border-radius: 50%;
        flex: 0 0 auto;
        background: transparent;
        /* Flex-center the avatar so it always sits dead-centre over
         * the absolutely-positioned check ring. Without this the
         * inline-block button layout would baseline-align the avatar
         * a hair down/right of the ring. */
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
    }
    .avatar {
        width: 32px; height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        color: #ffffff;
        font-size: 12px;
        font-weight: 600;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
        transition: opacity 100ms ease;
    }
    .check {
        position: absolute;
        inset: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        color: var(--text-on-accent);
        background: linear-gradient(135deg,
            var(--accent),
            color-mix(in srgb, var(--accent) 70%, #ffffff));
        opacity: 0;
        transform: scale(0.85);
        transition: opacity 140ms ease, transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1);
        pointer-events: none;
        box-shadow:
            0 0 0 2px var(--bg-canvas, #fff),
            0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .check :global(svg) {
        transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
        transform: scale(0);
    }
    .avatar-slot:hover .check { opacity: 0.92; transform: scale(0.95); }
    .avatar-slot:hover .avatar { opacity: 0.35; }
    .avatar-slot:hover .check :global(svg) { transform: scale(0.85); }
    .avatar-slot.is-checked .check { opacity: 1; transform: scale(1); }
    .avatar-slot.is-checked .check :global(svg) { transform: scale(1); }
    .avatar-slot.is-checked .avatar { opacity: 0; }
    /* Subtle ring on the row when bulk-selected — pairs nicely with
     * the chunky check + matches the row hover treatment. */
    .row.bulk-selected {
        background: linear-gradient(90deg,
            color-mix(in srgb, var(--accent) 18%, var(--bg-surface)),
            var(--accent-soft) 60%);
        box-shadow: inset 3px 0 0 var(--accent);
    }
    .row.bulk-selected:hover { background: color-mix(in srgb, var(--accent) 22%, var(--bg-surface)); }
    /* Starred rows get a subtle rotating yellow glow that travels around
     * the border — like a soft lighthouse beam highlighting importance. */
    /* Tracking (spy) rows — bright green glow like a live surveillance indicator. */
    .row.spy-tracked {
        position: relative;
        background: linear-gradient(90deg, color-mix(in srgb, #10b981 10%, var(--bg-surface)) 0%, var(--bg-surface) 50%);
        box-shadow: inset 4px 0 0 #10b981, inset 0 0 14px color-mix(in srgb, #10b981 10%, transparent);
        animation: spy-pulse-glow 2.4s ease-in-out infinite;
    }
    .spy-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        vertical-align: middle;
        width: 18px;
        height: 18px;
        margin-right: 4px;
        color: #fff;
        background: #10b981;
        border-radius: 50%;
        box-shadow: 0 0 6px color-mix(in srgb, #10b981 50%, transparent);
    }
    .row.spy-tracked .subject {
        color: #6ee7b7;
        font-weight: 700;
    }
    @keyframes spy-pulse-glow {
        0%, 100% {
            box-shadow: inset 4px 0 0 #10b981, inset 0 0 14px color-mix(in srgb, #10b981 10%, transparent), 0 0 0 0 transparent;
        }
        50% {
            box-shadow: inset 4px 0 0 #10b981, inset 0 0 22px color-mix(in srgb, #10b981 20%, transparent), 0 0 10px -2px color-mix(in srgb, #10b981 30%, transparent);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .row.spy-tracked { animation: none; }
    }

    /* Notification rows — system alerts (Jellyfin etc) and our own
       open-tracking notices. Compact accent strip, hide from-name, lift
       the subject as the headline. */
    .row.notice-row {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--accent) 6%, var(--bg-surface)) 0%,
            var(--bg-surface) 60%
        );
        box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 60%, transparent);
    }
    .row.notice-row .from { display: none; }
    .row.notice-row .subject {
        font-weight: 700;
        color: var(--text-primary);
    }
    .row.notice-row.spy-tracked {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--warning, #d97706) 10%, var(--bg-surface)) 0%,
            var(--bg-surface) 60%
        );
        box-shadow: inset 3px 0 0 color-mix(in srgb, var(--warning, #d97706) 70%, transparent);
        animation: none;
    }
    .row.sms-row {
        background: linear-gradient(
            90deg,
            color-mix(in srgb, #16a34a 10%, var(--bg-surface)) 0%,
            var(--bg-surface) 60%
        );
        box-shadow: inset 3px 0 0 #16a34a;
    }
    .sms-avatar {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: linear-gradient(135deg, #16a34a, #0d8f43);
        color: white;
        flex-shrink: 0;
    }

    /* AI sort category accents — left stripe so the category reads at a
       glance in a long list without crowding the row layout.
       human → red (extreme relevance, real person)
       important → amber
       marketing → blue (per spec)
       info → no stripe (default neutral) */
    /* Family — warm pink/rose, our top tier. Sits above "human" in
     * priority; visually distinct so the user spots a parent / sibling
     * email at a glance even in a crowded list. */
    .row.ai-cat-family {
        box-shadow: inset 3px 0 0 #ec4899;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, #ec4899 12%, var(--bg-surface)) 0%,
            var(--bg-surface) 55%
        );
    }
    .row.ai-cat-human {
        box-shadow: inset 3px 0 0 #dc2626;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, #dc2626 9%, var(--bg-surface)) 0%,
            var(--bg-surface) 50%
        );
    }
    .row.ai-cat-important {
        box-shadow: inset 3px 0 0 #d97706;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, #d97706 8%, var(--bg-surface)) 0%,
            var(--bg-surface) 50%
        );
    }
    .row.ai-cat-marketing {
        box-shadow: inset 3px 0 0 #2563eb;
        background: linear-gradient(
            90deg,
            color-mix(in srgb, #2563eb 8%, var(--bg-surface)) 0%,
            var(--bg-surface) 50%
        );
    }
    /* .row.ai-cat-info is deliberately unstyled — an info-category row gets
       no tint or marker; this was an intentionally empty ruleset. */
    .row.starred {
        position: relative;
        animation: star-orbit-glow 3s linear infinite;
    }
    @keyframes star-orbit-glow {
        0%, 100% {
            box-shadow:
                inset 0 0 10px color-mix(in srgb, var(--star) 5%, transparent),
                -2px -2px 8px -2px color-mix(in srgb, var(--star) 22%, transparent),
                2px 2px 2px -2px transparent;
        }
        25% {
            box-shadow:
                inset 0 0 10px color-mix(in srgb, var(--star) 5%, transparent),
                2px -2px 8px -2px color-mix(in srgb, var(--star) 22%, transparent),
                -2px 2px 2px -2px transparent;
        }
        50% {
            box-shadow:
                inset 0 0 10px color-mix(in srgb, var(--star) 5%, transparent),
                2px 2px 8px -2px color-mix(in srgb, var(--star) 22%, transparent),
                -2px -2px 2px -2px transparent;
        }
        75% {
            box-shadow:
                inset 0 0 10px color-mix(in srgb, var(--star) 5%, transparent),
                -2px 2px 8px -2px color-mix(in srgb, var(--star) 22%, transparent),
                2px -2px 2px -2px transparent;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .row.starred { animation: none; }
    }
    /* AI danger-level glows — thick borders + background tints + subject colours.
     * Designed to be impossible to miss at a glance. */
    .row.danger-4 {
        background: linear-gradient(90deg, color-mix(in srgb, #ef4444 18%, var(--bg-surface)) 0%, var(--bg-surface) 60%);
        box-shadow: inset 4px 0 0 #ef4444, inset 0 0 20px color-mix(in srgb, #ef4444 12%, transparent);
        animation: danger-pulse-4 2s ease-in-out infinite;
    }
    .row.danger-3 {
        background: linear-gradient(90deg, color-mix(in srgb, #f97316 14%, var(--bg-surface)) 0%, var(--bg-surface) 55%);
        box-shadow: inset 4px 0 0 #f97316, inset 0 0 16px color-mix(in srgb, #f97316 10%, transparent);
        animation: danger-pulse-3 2.4s ease-in-out infinite;
    }
    .row.danger-2 {
        background: linear-gradient(90deg, color-mix(in srgb, #eab308 10%, var(--bg-surface)) 0%, var(--bg-surface) 50%);
        box-shadow: inset 4px 0 0 #eab308, inset 0 0 12px color-mix(in srgb, #eab308 8%, transparent);
        animation: danger-pulse-2 2.8s ease-in-out infinite;
    }
    .row.danger-1 {
        background: linear-gradient(90deg, color-mix(in srgb, #22c55e 8%, var(--bg-surface)) 0%, var(--bg-surface) 45%);
        box-shadow: inset 4px 0 0 #22c55e, inset 0 0 10px color-mix(in srgb, #22c55e 6%, transparent);
        animation: danger-pulse-1 3.2s ease-in-out infinite;
    }
    .row.danger-4 .subject { color: #fca5a5; font-weight: 700; }
    .row.danger-3 .subject { color: #fdba74; font-weight: 700; }
    .row.danger-2 .subject { color: #fde047; font-weight: 600; }
    .row.danger-1 .subject { color: #86efac; font-weight: 600; }
    .danger-badge {
        display: inline-flex;
        align-items: center;
        vertical-align: middle;
        margin-right: 5px;
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.04em;
        line-height: 1.4;
    }
    /* Folder badge — only stamped on rows during all-folders search.
       Keeps the user oriented when the same hit could be in any of N
       mailboxes. */
    .folder-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        vertical-align: middle;
        margin-right: 6px;
        padding: 1px 6px 1px 4px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        line-height: 1.4;
        background: color-mix(in srgb, var(--accent) 14%, transparent);
        color: var(--accent);
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .folder-badge :global(svg) { opacity: 0.85; }

    /* Category pill — drives the colour treatment for AI sort. Each
     * row gets one of these so the user can see at a glance which
     * bucket the model put it in (humans, important, purchase,
     * notification, marketing, info). */
    .cat-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 7px 1px 5px;
        border-radius: 999px;
        font-size: 10.5px;
        font-weight: 600;
        line-height: 1.4;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        flex-shrink: 0;
        border: 1px solid transparent;
        white-space: nowrap;
    }
    .cat-pill .cat-emoji { font-size: 11px; }
    /* Family — pink/rose. Sits at the top of the visual stack so a
     * parent / sibling email is impossible to miss. */
    .cat-pill.cat-family {
        background: linear-gradient(135deg,
            color-mix(in srgb, #ec4899 28%, var(--bg-surface)),
            color-mix(in srgb, #ec4899 12%, var(--bg-surface)));
        color: #9d174d;
        border-color: color-mix(in srgb, #ec4899 36%, transparent);
    }
    .cat-pill.cat-human {
        background: linear-gradient(135deg,
            color-mix(in srgb, #22c55e 22%, var(--bg-surface)),
            color-mix(in srgb, #22c55e 8%, var(--bg-surface)));
        color: #126b35;
        border-color: color-mix(in srgb, #22c55e 28%, transparent);
    }
    .cat-pill.cat-important {
        background: linear-gradient(135deg,
            color-mix(in srgb, #f59e0b 22%, var(--bg-surface)),
            color-mix(in srgb, #f59e0b 8%, var(--bg-surface)));
        color: #7c4a00;
        border-color: color-mix(in srgb, #f59e0b 30%, transparent);
    }
    .cat-pill.cat-purchase {
        background: linear-gradient(135deg,
            color-mix(in srgb, #8b5cf6 22%, var(--bg-surface)),
            color-mix(in srgb, #8b5cf6 8%, var(--bg-surface)));
        color: #4d2dab;
        border-color: color-mix(in srgb, #8b5cf6 30%, transparent);
    }
    .cat-pill.cat-notification {
        background: linear-gradient(135deg,
            color-mix(in srgb, #3b82f6 22%, var(--bg-surface)),
            color-mix(in srgb, #3b82f6 8%, var(--bg-surface)));
        color: #1d4ed8;
        border-color: color-mix(in srgb, #3b82f6 30%, transparent);
    }
    .cat-pill.cat-marketing {
        background: linear-gradient(135deg,
            color-mix(in srgb, #94a3b8 22%, var(--bg-surface)),
            color-mix(in srgb, #94a3b8 8%, var(--bg-surface)));
        color: #475569;
        border-color: color-mix(in srgb, #94a3b8 30%, transparent);
    }
    .cat-pill.cat-info {
        background: var(--bg-surface-alt);
        color: var(--text-tertiary);
        border-color: var(--border-subtle);
    }
    :global(html.dark) .cat-pill.cat-family,
    :global([data-theme="dark"]) .cat-pill.cat-family { color: #f9a8d4; }
    :global(html.dark) .cat-pill.cat-human,
    :global([data-theme="dark"]) .cat-pill.cat-human { color: #7be3a4; }
    :global(html.dark) .cat-pill.cat-important,
    :global([data-theme="dark"]) .cat-pill.cat-important { color: #fcd34d; }
    :global(html.dark) .cat-pill.cat-purchase,
    :global([data-theme="dark"]) .cat-pill.cat-purchase { color: #c4b5fd; }
    :global(html.dark) .cat-pill.cat-notification,
    :global([data-theme="dark"]) .cat-pill.cat-notification { color: #93c5fd; }
    :global(html.dark) .cat-pill.cat-marketing,
    :global([data-theme="dark"]) .cat-pill.cat-marketing { color: #cbd5e1; }

    .danger-badge[data-level="4"] {
        background: #ef4444;
        color: #fff;
        box-shadow: 0 0 6px color-mix(in srgb, #ef4444 50%, transparent);
    }
    .danger-badge[data-level="3"] {
        background: #f97316;
        color: #fff;
        box-shadow: 0 0 4px color-mix(in srgb, #f97316 40%, transparent);
    }
    @keyframes danger-pulse-4 {
        0%, 100% { box-shadow: inset 4px 0 0 #ef4444, inset 0 0 20px color-mix(in srgb, #ef4444 12%, transparent), 0 0 0 0 transparent; }
        50%      { box-shadow: inset 4px 0 0 #ef4444, inset 0 0 28px color-mix(in srgb, #ef4444 22%, transparent), 0 0 12px -2px color-mix(in srgb, #ef4444 30%, transparent); }
    }
    @keyframes danger-pulse-3 {
        0%, 100% { box-shadow: inset 4px 0 0 #f97316, inset 0 0 16px color-mix(in srgb, #f97316 10%, transparent), 0 0 0 0 transparent; }
        50%      { box-shadow: inset 4px 0 0 #f97316, inset 0 0 22px color-mix(in srgb, #f97316 18%, transparent), 0 0 10px -2px color-mix(in srgb, #f97316 25%, transparent); }
    }
    @keyframes danger-pulse-2 {
        0%, 100% { box-shadow: inset 4px 0 0 #eab308, inset 0 0 12px color-mix(in srgb, #eab308 8%, transparent), 0 0 0 0 transparent; }
        50%      { box-shadow: inset 4px 0 0 #eab308, inset 0 0 18px color-mix(in srgb, #eab308 14%, transparent), 0 0 8px -2px color-mix(in srgb, #eab308 20%, transparent); }
    }
    @keyframes danger-pulse-1 {
        0%, 100% { box-shadow: inset 4px 0 0 #22c55e, inset 0 0 10px color-mix(in srgb, #22c55e 6%, transparent), 0 0 0 0 transparent; }
        50%      { box-shadow: inset 4px 0 0 #22c55e, inset 0 0 14px color-mix(in srgb, #22c55e 10%, transparent), 0 0 6px -2px color-mix(in srgb, #22c55e 15%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) {
        .row.danger-1, .row.danger-2, .row.danger-3, .row.danger-4 { animation: none; }
    }

    /* Scam (was: phishing) risk rows — deep purple/violet wash so
     * scams are visually distinct from spam (amber). The two warnings
     * mean different things and shouldn't share a palette. */
    .row.phishing-risk {
        position: relative;
        background: linear-gradient(90deg, color-mix(in srgb, #7c3aed 10%, var(--bg-surface)) 0%, var(--bg-surface) 55%);
        box-shadow: inset 4px 0 0 #7c3aed, inset 0 0 10px color-mix(in srgb, #7c3aed 10%, transparent);
    }
    .row.phishing-risk .subject { color: #c4b5fd; font-weight: 600; }
    .row.phishing-risk::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 12%;
        width: 2px;
        height: 18px;
        border-radius: 50%;
        background: linear-gradient(to top, color-mix(in srgb, #a78bfa 70%, transparent), transparent);
        filter: blur(1.5px);
        opacity: 0;
        animation: stinky-wisp 2.4s ease-out infinite;
        pointer-events: none;
    }
    .row.phishing-risk::before {
        content: '';
        position: absolute;
        bottom: 0;
        left: 28%;
        width: 2px;
        height: 14px;
        border-radius: 50%;
        background: linear-gradient(to top, color-mix(in srgb, #8b5cf6 60%, transparent), transparent);
        filter: blur(1.5px);
        opacity: 0;
        animation: stinky-wisp 2.1s ease-out infinite 0.7s;
        pointer-events: none;
    }
    @keyframes stinky-wisp {
        0%   { transform: translateY(0) scaleX(1) scaleY(0.3); opacity: 0; }
        15%  { opacity: 0.7; }
        50%  { transform: translateY(-10px) scaleX(1.4) scaleY(1.2) translateX(3px); opacity: 0.45; }
        100% { transform: translateY(-22px) scaleX(2) scaleY(2) translateX(-2px); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
        .row.phishing-risk::after, .row.phishing-risk::before { animation: none; opacity: 0.35; }
    }

    /* Spam risk rows — amber wash with a left rail. Visually distinct
     * from scam (purple) so a glance tells you which problem the row
     * has. Spam = annoying; scam = dangerous. */
    .row.spam-risk:not(.phishing-risk) {
        background: linear-gradient(90deg, color-mix(in srgb, #f59e0b 9%, var(--bg-surface)) 0%, var(--bg-surface) 55%);
        box-shadow: inset 4px 0 0 #f59e0b, inset 0 0 8px color-mix(in srgb, #f59e0b 8%, transparent);
    }
    .row.spam-risk:not(.phishing-risk) .subject {
        color: #d97706;
        font-weight: 500;
    }

    .row-main {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .row-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        min-width: 0;
    }
    .from {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
        min-width: 0;
    }
    .row.unread .from { font-weight: 700; }
    .date { font-size: 12px; flex: 0 0 auto; }
    /* Paperclip glyph next to the date when bodyStructure showed at least
     * one attachment. Subtle — meant to be quickly scannable, not loud. */
    .row-attachment-mark {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--text-tertiary);
    }
    .row.unread .row-attachment-mark { color: var(--text-secondary); }

    /* Thread badge — small count chip on the head row of multi-message
     * conversations. Reads similar to gmail's "(3)" but tighter. */
    .thread-count {
        flex: 0 0 auto;
        font-size: 10.5px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--bg-tag);
        color: var(--text-secondary);
        line-height: 1.5;
    }
    .row.unread .thread-count {
        background: color-mix(in srgb, var(--accent) 20%, var(--bg-tag));
        color: var(--accent-text);
    }
    .thread-toggle {
        transition: transform 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .thread-toggle.open { transform: rotate(90deg); }

    .thread-children {
        list-style: none;
        margin: 0;
        padding: 0 0 4px 0;
        background: color-mix(in srgb, var(--text-tertiary) 4%, transparent);
        border-bottom: 1px solid var(--border-subtle);
    }
    .thread-children .row.child-row {
        position: relative;
        padding-left: 38px;
        gap: 8px;
        font-size: 13px;
        opacity: 0.92;
        box-shadow: inset 0 0 12px color-mix(in srgb, var(--accent) 8%, transparent);
    }
    .thread-children .row.child-row:hover {
        opacity: 1;
        box-shadow: inset 0 0 16px color-mix(in srgb, var(--accent) 12%, transparent);
    }
    /* The vertical "spine" hanging off the parent row's avatar so the
     * branch reads as a child of the head row. */
    .thread-spine {
        position: absolute;
        left: 24px;
        top: -2px;
        bottom: -2px;
        width: 2px;
        background: linear-gradient(180deg,
            transparent,
            color-mix(in srgb, var(--accent) 40%, var(--border-subtle)) 18%,
            color-mix(in srgb, var(--accent) 40%, var(--border-subtle)) 82%,
            transparent);
        border-radius: 1px;
    }
    .thread-children .subject { font-size: 12.5px; }
    .subject {
        font-size: 13px;
        color: var(--text-secondary);
    }
    .row.unread .subject { color: var(--text-primary); font-weight: 600; }
    .row-actions {
        position: absolute;
        right: 14px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 2px 6px;
        background: linear-gradient(90deg, transparent 0, var(--bg-hover) 16px, var(--bg-hover) 100%);
        border-radius: var(--radius-sm);
        opacity: 0;
        pointer-events: none;
        transition: opacity var(--transition-fast);
    }
    .row:hover .row-actions,
    .row:focus-within .row-actions {
        opacity: 1;
        pointer-events: auto;
    }
    .row:hover.selected .row-actions {
        background: linear-gradient(90deg, transparent 0, var(--bg-selected) 16px, var(--bg-selected) 100%);
    }
    .icon-btn {
        padding: 6px;
        border-radius: var(--radius-xs);
        color: var(--text-tertiary);
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .icon-btn:hover { background: var(--accent-soft); color: var(--accent-text); }
    .icon-btn.danger:hover { background: var(--danger-soft); color: var(--danger); }
    .icon-btn.star-on {
        color: var(--star);
        opacity: 1;
        background: color-mix(in srgb, var(--star) 10%, transparent);
        animation: star-glow 2.4s ease-in-out infinite;
    }
    .row .icon-btn.star-on { opacity: 1; }
    @keyframes star-glow {
        0%, 100% {
            box-shadow: 0 0 0 0 color-mix(in srgb, var(--star) 0%, transparent),
                        inset 0 0 0 0 color-mix(in srgb, var(--star) 0%, transparent);
        }
        50% {
            box-shadow: 0 0 8px 2px color-mix(in srgb, var(--star) 35%, transparent),
                        inset 0 0 6px 1px color-mix(in srgb, var(--star) 15%, transparent);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .icon-btn.star-on { animation: none; }
    }
    /* Gentle gold halo around the filled star SVG so the eye lands on it. */
    .icon-btn.star-on :global(svg) {
        filter:
            drop-shadow(0 0 3px color-mix(in srgb, var(--star) 80%, transparent))
            drop-shadow(0 0 8px color-mix(in srgb, var(--star) 45%, transparent));
        animation: star-breathe 2.6s ease-in-out infinite;
    }
    @keyframes star-breathe {
        0%, 100% { filter:
            drop-shadow(0 0 3px color-mix(in srgb, var(--star) 80%, transparent))
            drop-shadow(0 0 8px color-mix(in srgb, var(--star) 45%, transparent));
        }
        50%      { filter:
            drop-shadow(0 0 5px color-mix(in srgb, var(--star) 95%, transparent))
            drop-shadow(0 0 14px color-mix(in srgb, var(--star) 55%, transparent));
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .icon-btn.star-on :global(svg) { animation: none; }
    }
    .state {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 32px 24px;
    }
    .state.empty p { font-size: 13px; }
    .state.error {
        color: var(--danger);
        background: var(--danger-soft);
        margin: 16px;
        border-radius: var(--radius-md);
    }
    .list-footer {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 16px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface);
        font-size: 12px;
    }

    /* Client-side rule animation: while a rule is running on a row
     * (.rule-running), an indigo shimmer sweeps across it so the user
     * sees the AI is doing something. When the action finishes
     * (.rule-popping), the row scales down + slides out with a
     * glassy fade — feels like the message is "lifted away" by an
     * invisible hand. The actual list refresh then drops it for real. */
    .row.rule-running {
        position: relative;
        background: linear-gradient(
            90deg,
            transparent 0%,
            color-mix(in srgb, var(--accent) 12%, transparent) 50%,
            transparent 100%);
        background-size: 200% 100%;
        animation: rule-shimmer 1.6s ease-in-out infinite;
    }
    .row.rule-popping {
        animation: rule-pop 360ms cubic-bezier(0.4, 0.0, 1, 1) forwards;
        pointer-events: none;
    }
    @keyframes rule-shimmer {
        0%   { background-position: 100% 50%; }
        100% { background-position: -100% 50%; }
    }
    @keyframes rule-pop {
        0%   { transform: scale(1) translateX(0);   opacity: 1; filter: blur(0); }
        40%  { transform: scale(1.02) translateX(0); opacity: 0.85; }
        100% { transform: scale(0.6) translateX(40px); opacity: 0; filter: blur(2px); }
    }
    @media (prefers-reduced-motion: reduce) {
        .row.rule-running { animation: none; }
        .row.rule-popping { animation: none; opacity: 0.4; }
    }
</style>
