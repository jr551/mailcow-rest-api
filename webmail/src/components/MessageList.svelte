<script lang="ts">
    import { ui, toggleSelected, selectAllVisible, clearSelection } from '../lib/store.svelte';
    import { formatDate, senderShort, isTrackingEmail, isNotificationMessage, isSmsMessage } from '../lib/format';
    import { capabilities } from '../lib/settings.svelte';
    import Avatar from './Avatar.svelte';
    import VipBadge from './VipBadge.svelte';
    import { settings, setListFilter, isVipAddress, type ListFilter } from '../lib/settings.svelte';
    import { aiAvailable } from '../lib/settings.svelte';
    import { getCachedScan } from '../lib/phishing-scan';
    import Icon from './Icon.svelte';
    import { buildThreads, type Thread } from '../lib/threads';
    import { type InboxSortRanking } from '../lib/api';
    import { sortInboxClient } from '../lib/sort-inbox-client';
    import type { MessageListItem } from '../lib/api';
    import { playSortDone, playClick } from '../lib/sounds.svelte';
    import { runSpamSweep, bulkMove, findArchiveFolder, findTrashFolder, type SweepCandidate } from '../lib/spam-sweep';
    import { listMailboxes, modifyFlags } from '../lib/api';
    import { showToast } from '../lib/store.svelte';
    import EventsScanPanel from './EventsScanPanel.svelte';

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
        onBlockSender?: (uid: number) => void;
    }
    let {
        onSelect, onStar, onUnread, onTrash, onArchive,
        onPageChange, onMarkFolderRead, onSummariseAndMarkRead, onLoadMore,
        effectivePageSize = 25, appendingMore = false,
        scanState = null,
        onMove, onBlockSender
    }: Props = $props();

    // Right-click context menu on a row.
    let ctx = $state<{ uid: number; x: number; y: number } | null>(null);
    function openCtx(e: MouseEvent, uid: number) {
        e.preventDefault();
        e.stopPropagation();
        ctx = { uid, x: e.clientX, y: e.clientY };
    }
    function closeCtx() { ctx = null; }
    function rowOf(uid: number) {
        return ui.messages.find((m) => m.uid === uid);
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
             previous spans showed inline. -->
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

        {#if settings.listFilter === 'ai-sorted' && aiRankings.length > 0 && ui.messagesTotal > 0}
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

    {#if suggestAiSort}
        <div class="ai-sort-suggest" role="status" data-testid="ai-sort-suggest">
            <Icon name="sparkles" size={12} />
            <span>You have a lot of unread mail. Want the AI to surface what's important?</span>
            <button type="button" class="suggest-btn primary" onclick={acceptSuggestion}>View AI sorted</button>
            <button type="button" class="suggest-btn" onclick={dismissSuggestion}>Not now</button>
        </div>
    {/if}

    {#if aiSortLoading || aiSortProgress || sweepRunning}
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
                        onkeydown={(e) => rowKey(e, headMsg.uid)}
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
                                        onkeydown={(e) => rowKey(e, childMsg.uid)}
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

<svelte:window
    onclick={closeCtx}
    oncontextmenu={(e) => {
        if (ctx && !(e.target as HTMLElement)?.closest?.('.row')) closeCtx();
    }}
/>

{#if ctx}
    {@const m = rowOf(ctx.uid)}
    {#if m}
        {@const isUnread = unread(m.flags)}
        {@const isFlagged = flagged(m.flags)}
        <ul
            class="msg-ctx"
            role="menu"
            style={`top: ${ctx.y}px; left: ${ctx.x}px;`}
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
            {#if onMove && ui.mailboxes.length}
                {@const bulkN = ui.selected.has(ctx.uid) ? ui.selected.size : 0}
                <li class="sub-head">{bulkN > 1 ? `Move ${bulkN} selected to…` : 'Move to…'}</li>
                {#each ui.mailboxes.filter((mb) => mb.path !== ui.selectedPath).slice(0, 8) as mb (mb.path)}
                    <li><button type="button" role="menuitem" onclick={async () => {
                        const dest = mb.path;
                        closeCtx();
                        if (bulkN > 1) {
                            await bulkMoveSelected(dest);
                        } else {
                            onMove!(ctx!.uid, dest);
                        }
                    }}>
                        <Icon name="folder" size={12} /> {mb.name || mb.path}
                    </button></li>
                {/each}
            {/if}
            <li class="sep"></li>
            {#if onBlockSender}
                <li><button type="button" role="menuitem" class="danger" onclick={() => { onBlockSender!(ctx!.uid); closeCtx(); }}>
                    <Icon name="spam" size={12} /> Block sender
                </button></li>
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
    .header-action {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 6px;
        font-size: 11px;
        color: var(--text-secondary);
        border-radius: var(--radius-xs);
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .header-action:hover { background: var(--bg-hover); color: var(--text-primary); }
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
    .msg-ctx li { list-style: none; }
    .msg-ctx li.sep { height: 1px; margin: 4px 0; background: var(--border-subtle); }
    .msg-ctx li.sub-head {
        padding: 8px 10px 4px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
    }
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
    .row.ai-cat-info {
        /* leave alone */
    }
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
