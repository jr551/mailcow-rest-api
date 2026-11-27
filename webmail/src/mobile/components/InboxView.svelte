<script lang="ts">
    import { onMount } from 'svelte';
    import { mobileState, navigate, showToast, pushOverlay } from '../lib/store.svelte';
    import { authState, tryRenewSession } from '../../lib/auth.svelte';
    import {
        listMailboxes,
        listMessages,
        getMessage,
        modifyFlags,
        deleteMessage,
        moveMessage,
        ApiError,
        type Mailbox,
        type MessageListItem,
        type MessageDetail
    } from '../../lib/api';
    import { formatDate, senderShort, isTrackingEmail } from '../../lib/format';
    import { sortInboxClient, type InboxSortRanking } from '../../lib/sort-inbox-client';
    import { settings } from '../../lib/settings.svelte';
    import Icon from '../../components/Icon.svelte';
    import Avatar from '../../components/Avatar.svelte';
    import SwipeableRow from './SwipeableRow.svelte';
    import MessageActionSheet from './MessageActionSheet.svelte';
    import LatencyChip from '../../components/LatencyChip.svelte';
    import { playClick } from '../../lib/sounds.svelte';

    let searchInput = $state('');
    let searchDebounce: ReturnType<typeof setTimeout> | null = null;

    const SERVER_CAP = 100;
    let appending = $state(false);
    let observedUser = authState.activeUser;
    let accountEpoch = 0;
    let mailboxSeq = 0;
    let refreshSeq = 0;
    let appendSeq = 0;
    let detailSeq = 0;
    let actionSheetSeq = 0;
    let detailAbort: AbortController | null = null;

    function stillOwner(user: string | null, epoch: number): boolean {
        return !!user && authState.activeUser === user && observedUser === user && accountEpoch === epoch;
    }

    $effect(() => {
        const user = authState.activeUser;
        if (user === observedUser) return;
        observedUser = user;
        accountEpoch += 1;
        mailboxSeq += 1;
        refreshSeq += 1;
        appendSeq += 1;
        detailSeq += 1;
        actionSheetSeq += 1;
        detailAbort?.abort(new DOMException('Active account changed', 'AbortError'));
        detailAbort = null;
        cancelGlobalSearch();
        aiSortAbort?.abort(new DOMException('Active account changed', 'AbortError'));
        aiSortAbort = null;
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = null;
        searchInput = '';
        appending = false;
        isRefreshing = false;
        pullDelta = 0;
        aiSortLoading = false;
        aiSortError = null;
        aiRankings = [];
        lastSortedKey = '';
        ruleAnimUids = new Set();
        ruleDoneUids = new Set();
        actionSheetOpen = false;
        actionSheetMsg = null;
        actionSheetDetail = null;
        actionSheetDetailLoading = false;
        if (actionSheetDispose) {
            actionSheetDispose();
            actionSheetDispose = null;
        }
        mobileState.mailboxes = [];
        mobileState.mailboxesLoading = false;
        mobileState.selectedPath = 'INBOX';
        mobileState.messages = [];
        mobileState.messagesTotal = 0;
        mobileState.messagesLoading = false;
        mobileState.messagesError = null;
        mobileState.search = '';
        mobileState.searchScope = 'folder';
        mobileState.selectedUid = null;
        mobileState.detail = null;
        mobileState.detailLoading = false;
        mobileState.detailError = null;
        if (user) {
            void refreshMailboxes();
            void refreshMessages(true);
        }
    });

    // Pull-to-refresh state
    let listEl: HTMLDivElement | undefined = $state();
    let pullStartY = 0;
    let pullDelta = $state(0);
    let isPulling = $state(false);
    let isRefreshing = $state(false);
    const PULL_THRESHOLD = 72;

    // Client-side rule pop-away state — same protocol as desktop.
    let ruleAnimUids = $state(new Set<number>());
    let ruleDoneUids = $state(new Set<number>());
    function onRule(e: Event) {
        const ev = e as CustomEvent<{ path: string; uid: number; phase: 'start' | 'done' | 'error' }>;
        if (!ev.detail) return;
        const { uid, phase } = ev.detail;
        if (phase === 'start') {
            const next = new Set(ruleAnimUids); next.add(uid); ruleAnimUids = next;
        } else if (phase === 'done') {
            const next = new Set(ruleDoneUids); next.add(uid); ruleDoneUids = next;
            setTimeout(() => {
                const a = new Set(ruleAnimUids); a.delete(uid); ruleAnimUids = a;
                const b = new Set(ruleDoneUids); b.delete(uid); ruleDoneUids = b;
            }, 600);
        } else {
            const a = new Set(ruleAnimUids); a.delete(uid); ruleAnimUids = a;
        }
    }

    // Rows from an all-folders search carry their source mailbox; every
    // per-row action must target that folder, and uids only identify a
    // row together with it.
    const rowPath = (msg: MessageListItem) => msg.mailbox ?? mobileState.selectedPath;
    const rowKey = (msg: MessageListItem) => `${msg.mailbox ?? ''}:${msg.uid}`;
    const findRow = (msg: MessageListItem) => mobileState.messages.find((m) => rowKey(m) === rowKey(msg));
    const detailMatchesRow = (path: string, uid: number) =>
        mobileState.selectedPath === path && mobileState.detail?.uid === uid;
    const dropRow = (msg: MessageListItem) => {
        mobileState.messages = mobileState.messages.filter((m) => rowKey(m) !== rowKey(msg));
        mobileState.messagesTotal = Math.max(0, mobileState.messagesTotal - 1);
    };
    async function refreshMailboxes() {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser) return;
        const seq = ++mailboxSeq;
        const stillCurrent = () => stillOwner(user, epoch) && seq === mailboxSeq;
        mobileState.mailboxesLoading = true;
        try {
            const fresh = await listMailboxes({ counts: true });
            if (!stillCurrent()) return;
            mobileState.mailboxes = fresh;
        } catch (err) {
            // Don't ever drop the session on 401 — most often the server
            // just got redeployed and lost its pool. Try a silent renewal
            // via stored creds; if that succeeds, retry once. If not,
            // surface a toast so the user can re-login on their own
            // schedule rather than getting kicked back to the login screen.
            if (!stillCurrent()) return;
            if (err instanceof ApiError && err.status === 401) {
                if (await tryRenewSession(user) && stillCurrent()) {
                    try {
                        const fresh = await listMailboxes({ counts: true });
                        if (stillCurrent()) mobileState.mailboxes = fresh;
                    } catch { /* fall through */ }
                } else if (stillCurrent()) {
                    showToast('error', 'Session lost — re-open the app or sign in again.');
                }
            }
        } finally {
            if (stillCurrent()) mobileState.mailboxesLoading = false;
        }
    }

    async function refreshMessages(reset = false) {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser) return;
        // An all-folders result set must not collapse to the single folder
        // that happens to be selected.
        if (mobileState.searchScope === 'all' && (mobileState.search || '').trim()) return searchAllFolders();
        const seq = ++refreshSeq;
        const path = mobileState.selectedPath;
        const search = mobileState.search || undefined;
        const stillCurrent = () =>
            stillOwner(user, epoch)
            && seq === refreshSeq
            && mobileState.selectedPath === path
            && mobileState.search === (search || '')
            && mobileState.searchScope === 'folder';
        if (reset) mobileState.messages = [];
        mobileState.messagesLoading = true;
        mobileState.messagesError = null;
        try {
            const r = await listMessages(path, {
                page: 0,
                pageSize: SERVER_CAP,
                search,
            });
            if (!stillCurrent()) return;
            mobileState.messages = r.messages;
            mobileState.messagesTotal = r.total;
            // (client-rules pass removed — settings.clientRules deleted by Settings refactor)
        } catch (err) {
            if (!stillCurrent()) return;
            mobileState.messagesError = err instanceof Error ? err.message : 'Failed to load messages';
            if (err instanceof ApiError && err.status === 401) {
                if (await tryRenewSession(user) && stillCurrent()) {
                    try {
                        const r = await listMessages(path, {
                            page: 0,
                            pageSize: SERVER_CAP,
                            search,
                        });
                        if (stillCurrent()) {
                            mobileState.messages = r.messages;
                            mobileState.messagesTotal = r.total;
                            mobileState.messagesError = null;
                        }
                    } catch { /* keep the original error visible */ }
                } else if (stillCurrent()) {
                    showToast('error', 'Session lost — re-open the app or sign in again.');
                }
            }
        } finally {
            if (stillOwner(user, epoch) && seq === refreshSeq) mobileState.messagesLoading = false;
        }
    }

    async function loadMore() {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser) return;
        if (appending || mobileState.messagesLoading) return;
        if (mobileState.messages.length >= mobileState.messagesTotal) return;
        const nextPage = Math.floor(mobileState.messages.length / SERVER_CAP);
        const path = mobileState.selectedPath;
        const search = mobileState.search || undefined;
        const seq = ++appendSeq;
        const stillCurrent = () =>
            stillOwner(user, epoch)
            && seq === appendSeq
            && path === mobileState.selectedPath
            && search === (mobileState.search || '')
            && mobileState.searchScope === 'folder';
        appending = true;
        try {
            const r = await listMessages(path, {
                page: nextPage,
                pageSize: SERVER_CAP,
                search,
            });
            if (!stillCurrent()) return;
            const seen = new Set(mobileState.messages.map((m) => m.uid));
            const fresh = r.messages.filter((m) => !seen.has(m.uid));
            mobileState.messages = [...mobileState.messages, ...fresh];
            mobileState.messagesTotal = r.total;
        } catch {
            if (stillCurrent()) showToast('error', "Couldn't load more messages");
        }
        finally {
            if (seq === appendSeq && stillOwner(user, epoch)) appending = false;
        }
    }

    async function selectMessage(msg: MessageListItem) {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser) return;
        const seq = ++detailSeq;
        detailAbort?.abort();
        const controller = new AbortController();
        detailAbort = controller;
        playClick();
        const uid = msg.uid;
        mobileState.selectedUid = uid;
        mobileState.detail = null;
        mobileState.detailError = null;
        mobileState.detailLoading = true;
        // In all-folders search the row carries its source mailbox; switch
        // selectedPath so detail/flags/move target the right folder.
        if (mobileState.searchScope === 'all') cancelGlobalSearch();
        if (mobileState.searchScope === 'all' && msg.mailbox && mobileState.selectedPath !== msg.mailbox) {
            mobileState.selectedPath = msg.mailbox;
        }
        const path = mobileState.selectedPath;
        const stillCurrent = () =>
            stillOwner(user, epoch)
            && seq === detailSeq
            && mobileState.selectedPath === path
            && mobileState.selectedUid === uid;
        navigate('message');
        try {
            const fresh = await getMessage(path, uid, { signal: controller.signal });
            if (!stillCurrent()) return;
            mobileState.detail = fresh;
            if (fresh.flags && !fresh.flags.includes('\\Seen')) {
                const r = await modifyFlags(path, uid, { add: ['\\Seen'] });
                if (!stillCurrent()) return;
                fresh.flags = r.flags;
                const li = findRow(msg);
                if (li) li.flags = r.flags;
            }
        } catch (err) {
            if (stillCurrent()) mobileState.detailError = err instanceof Error ? err.message : 'Failed to load message';
        } finally {
            if (stillCurrent()) mobileState.detailLoading = false;
            if (detailAbort === controller) detailAbort = null;
        }
    }

    async function toggleStar(msg: MessageListItem) {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser || !findRow(msg)) return;
        const li = findRow(msg);
        if (!li) return;
        const path = rowPath(li);
        const key = rowKey(li);
        const isFlagged = li.flags.includes('\\Flagged');
        try {
            const r = await modifyFlags(path, li.uid, isFlagged ? { remove: ['\\Flagged'] } : { add: ['\\Flagged'] });
            if (!stillOwner(user, epoch)) return;
            const current = mobileState.messages.find((m) => rowKey(m) === key);
            if (current) current.flags = r.flags;
            if (detailMatchesRow(path, li.uid)) {
                mobileState.detail!.flags = r.flags;
            }
        } catch {
            if (stillOwner(user, epoch)) showToast('error', "Couldn't update star");
        }
    }

    async function trashMessage(msg: MessageListItem) {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser) return;
        const from = rowPath(msg);
        const trashBox = mobileState.mailboxes.find((m) => m.specialUse === '\\Trash')?.path || 'Trash';
        try {
            if (from === trashBox) await deleteMessage(from, msg.uid);
            else await moveMessage(from, msg.uid, trashBox);
            if (!stillOwner(user, epoch)) return;
            dropRow(msg);
            showToast('success', from === trashBox ? 'Deleted' : 'Moved to Trash');
        } catch {
            if (stillOwner(user, epoch)) showToast('error', 'Failed to delete');
        }
    }

    async function archiveMessage(msg: MessageListItem) {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser) return;
        const archiveBox = mobileState.mailboxes.find((m) => m.specialUse === '\\Archive')?.path || 'Archive';
        const from = rowPath(msg);
        try {
            await moveMessage(from, msg.uid, archiveBox);
            if (!stillOwner(user, epoch)) return;
            dropRow(msg);
            showToast('success', 'Archived');
        } catch {
            if (stillOwner(user, epoch)) showToast('error', 'Failed to archive');
        }
    }

    function onSearch(value: string) {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser) return;
        searchInput = value;
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            if (!stillOwner(user, epoch)) return;
            mobileState.search = searchInput.trim();
            // Typing always reverts to current-folder scope; users have to
            // tap "All folders" again deliberately.
            if (mobileState.searchScope === 'all') {
                cancelGlobalSearch();
                mobileState.searchScope = 'folder';
            }
            refreshMessages(true);
        }, 300);
    }

    // ----- Global (all-folders) search -----------------------------------
    let globalAbort: AbortController | null = null;
    let globalSearchSeq = 0;
    let globalScan = $state<{ scanned: number; total: number } | null>(null);

    function cancelGlobalSearch() {
        globalSearchSeq += 1;
        if (globalAbort) { globalAbort.abort(); globalAbort = null; }
        globalScan = null;
        mobileState.messagesLoading = false;
    }

    async function searchAllFolders() {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        const q = (mobileState.search || '').trim();
        if (!user || user !== observedUser || !q) return;
        cancelGlobalSearch();
        mobileState.searchScope = 'all';
        const ctrl = new AbortController();
        globalAbort = ctrl;
        const seq = globalSearchSeq;
        const stillCurrent = () =>
            stillOwner(user, epoch)
            && globalSearchSeq === seq
            && globalAbort === ctrl
            && mobileState.searchScope === 'all'
            && (mobileState.search || '').trim() === q;
        const folders = (mobileState.mailboxes || [])
            .filter((m) => !m.flags?.some((f) => /\\Noselect/i.test(f)))
            .map((m) => m.path);
        const aggregated: MessageListItem[] = [];
        const seen = new Set<string>();
        mobileState.messages = [];
        mobileState.messagesTotal = 0;
        mobileState.messagesError = null;
        mobileState.messagesLoading = true;
        globalScan = { scanned: 0, total: folders.length };
        try {
            for (let i = 0; i < folders.length; i++) {
                if (!stillCurrent()) break;
                const path = folders[i];
                try {
                    const r = await listMessages(path, { page: 0, pageSize: SERVER_CAP, search: q });
                    if (!stillCurrent()) break;
                    for (const msg of r.messages) {
                        const k = `${path} ${msg.uid}`;
                        if (seen.has(k)) continue;
                        seen.add(k);
                        aggregated.push({ ...msg, mailbox: path });
                    }
                    mobileState.messages = [...aggregated];
                    mobileState.messagesTotal = aggregated.length;
                } catch { /* per-folder errors non-fatal */ }
                if (!stillCurrent()) break;
                globalScan = { scanned: i + 1, total: folders.length };
            }
        } finally {
            if (stillOwner(user, epoch) && globalAbort === ctrl) {
                mobileState.messagesLoading = false;
                globalAbort = null;
                setTimeout(() => {
                    if (stillOwner(user, epoch) && globalSearchSeq === seq && !globalAbort) globalScan = null;
                }, 1500);
            }
        }
    }

    function exitGlobalSearch() {
        cancelGlobalSearch();
        mobileState.searchScope = 'folder';
        refreshMessages(true);
    }

    function onScroll(e: Event) {
        const el = e.currentTarget as HTMLDivElement;
        const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
        if (remaining < 160) loadMore();
    }

    // Pull-to-refresh handlers
    function onTouchStart(e: TouchEvent) {
        if (!listEl || listEl.scrollTop > 1) return;
        pullStartY = e.touches[0].clientY;
        isPulling = true;
    }

    function onTouchMove(e: TouchEvent) {
        if (!isPulling) return;
        const dy = e.touches[0].clientY - pullStartY;
        if (dy > 0) {
            // Apply resistance so it feels like a rubber band
            pullDelta = Math.min(dy * 0.45, 140);
        } else {
            pullDelta = 0;
        }
    }

    function onTouchEnd() {
        if (!isPulling) return;
        isPulling = false;
        if (pullDelta >= PULL_THRESHOLD && !isRefreshing) {
            const user = authState.activeUser;
            const epoch = accountEpoch;
            isRefreshing = true;
            pullDelta = PULL_THRESHOLD;
            Promise.all([refreshMessages(true), refreshMailboxes()]).finally(() => {
                if (!stillOwner(user, epoch)) return;
                isRefreshing = false;
                pullDelta = 0;
            });
        } else {
            pullDelta = 0;
        }
    }

    function unread(flags: string[]) {
        return !flags.includes('\\Seen');
    }

    function flagged(flags: string[]) {
        return flags.includes('\\Flagged');
    }

    // AI inbox-sort state.
    let aiSortLoading = $state(false);
    let aiSortError = $state<string | null>(null);
    let aiRankings = $state<InboxSortRanking[]>([]);
    let aiSortAbort: AbortController | null = null;

    // UID set of the last list we actually sent to the model. The effect
    // re-runs on every mutation of mobileState.messages — the 60s mailbox
    // refresh, pull-to-refresh, a message being marked read — and each run
    // used to fire a fresh LLM sort. Desktop removed the same pattern for
    // burning the user's budget without their consent; here the user has
    // opted in by choosing the ai-sorted filter, so we keep the automatic
    // sort but only when the set of messages genuinely changed.
    let lastSortedKey = '';

    $effect(() => {
        // AI hard-off: the ai-sorted segment is not rendered, so a stale
        // filter value must not keep re-firing a paid sort behind the
        // scenes. Reset to the plain list rather than silently doing work.
        if (!settings.aiFeatures) {
            aiSortAbort?.abort();
            aiSortAbort = null;
            if (mobileState.filter === 'ai-sorted') mobileState.filter = 'all';
            aiSortError = null;
            aiRankings = [];
            lastSortedKey = '';
            return;
        }
        if (mobileState.filter !== 'ai-sorted') {
            aiSortAbort?.abort();
            aiSortAbort = null;
            aiSortError = null;
            return;
        }
        const msgs = mobileState.messages;
        if (msgs.length === 0) {
            aiSortAbort?.abort();
            aiSortAbort = null;
            aiRankings = [];
            lastSortedKey = '';
            return;
        }
        const key = msgs.map((m) => m.uid).sort((a, b) => a - b).join(',');
        if (key === lastSortedKey) return;
        lastSortedKey = key;
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser) return;
        aiSortAbort?.abort();
        const controller = new AbortController();
        aiSortAbort = controller;
        const stillSorting = () =>
            stillOwner(user, epoch) && aiSortAbort === controller && !controller.signal.aborted;
        aiSortLoading = true;
        aiSortError = null;
        sortInboxClient(msgs.map((m) => ({
            uid: m.uid,
            subject: m.envelope.subject || undefined,
            from: m.envelope.from,
            to: m.envelope.to,
            date: m.envelope.date || m.internalDate || undefined
        })))
            .then((res) => { if (stillSorting()) aiRankings = res.rankings; })
            .catch((err) => {
                if (stillSorting() && (err as Error)?.name !== 'AbortError') {
                    aiSortError = err instanceof Error ? err.message : 'AI sort failed';
                }
            })
            .finally(() => {
                if (stillSorting()) {
                    aiSortLoading = false;
                    aiSortAbort = null;
                }
            });
    });

    function dangerLevel(uid: number): number {
        const r = aiRankings.find((x) => x.uid === uid);
        // Match desktop: 1-5 scale collapsed to legacy 1-4 colour bands.
        return r ? Math.max(1, Math.min(4, r.level >= 5 ? 4 : r.level)) : 0;
    }
    function aiCategory(uid: number): 'human' | 'family' | 'important' | 'purchase' | 'notification' | 'marketing' | 'info' | null {
        const r = aiRankings.find((x) => x.uid === uid);
        if (!r) return null;
        if (r.human) return 'human';
        return r.category ?? null;
    }

    // Same bucket order as MessageList: human → important → info → marketing.
    const CAT_RANK: Record<string, number> = { human: 0, important: 1, info: 2, marketing: 3 };
    const filtered = $derived.by(() => {
        const f = mobileState.filter;
        let base = mobileState.messages;
        if (f === 'unread') base = mobileState.messages.filter((m) => !m.flags.includes('\\Seen'));
        else if (f === 'starred') base = mobileState.messages.filter((m) => m.flags.includes('\\Flagged'));
        if (f !== 'ai-sorted' || aiRankings.length === 0) return base;
        const indexFor = new Map<number, number>();
        aiRankings.forEach((r, i) => indexFor.set(r.uid, i));
        const rankFor = (uid: number) => aiRankings.find((x) => x.uid === uid) ?? null;
        return [...base].sort((a, b) => {
            const ra = rankFor(a.uid);
            const rb = rankFor(b.uid);
            const catA = (ra?.human ? 'human' : ra?.category) || 'info';
            const catB = (rb?.human ? 'human' : rb?.category) || 'info';
            const cdiff = (CAT_RANK[catA] ?? 9) - (CAT_RANK[catB] ?? 9);
            if (cdiff !== 0) return cdiff;
            const lvlDiff = (rb?.level ?? 0) - (ra?.level ?? 0);
            if (lvlDiff !== 0) return lvlDiff;
            return (indexFor.get(a.uid) ?? Infinity) - (indexFor.get(b.uid) ?? Infinity);
        });
    });

    const currentFolder = $derived(
        mobileState.mailboxes.find((m) => m.path === mobileState.selectedPath)
    );

    const unreadCount = $derived(currentFolder?.unseen ?? 0);

    // Long-press action sheet state
    let actionSheetOpen = $state(false);
    let actionSheetMsg: MessageListItem | null = $state(null);
    let actionSheetDetail: MessageDetail | null = $state(null);
    let actionSheetDetailLoading = $state(false);
    let actionSheetDispose: (() => void) | null = null;

    async function openActionSheet(msg: MessageListItem) {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser) return;
        const key = rowKey(msg);
        const seq = ++actionSheetSeq;
        const stillCurrent = () =>
            stillOwner(user, epoch)
            && seq === actionSheetSeq
            && actionSheetOpen
            && actionSheetMsg !== null
            && rowKey(actionSheetMsg) === key;
        actionSheetMsg = msg;
        actionSheetOpen = true;
        actionSheetDetail = null;
        actionSheetDetailLoading = true;
        // Register with the back-button stack so Android-back closes the
        // sheet first instead of leaving the inbox view entirely.
        actionSheetDispose = pushOverlay('inbox-action-sheet', () => {
            actionSheetSeq += 1;
            actionSheetOpen = false;
            actionSheetMsg = null;
            actionSheetDetail = null;
            actionSheetDetailLoading = false;
            actionSheetDispose = null;
        });
        try {
            const fresh = await getMessage(rowPath(msg), msg.uid);
            if (!stillCurrent()) return;
            actionSheetDetail = fresh;
        } catch {
            // Sheet stays open for the non-detail actions; Summarize is
            // already guarded by `if (!detail)` inside MessageActionSheet,
            // so a failed fetch cannot trigger a paid call on an empty body.
            if (stillCurrent()) showToast('error', "Couldn't load message details");
        } finally {
            if (stillCurrent()) actionSheetDetailLoading = false;
        }
    }

    function closeActionSheet() {
        actionSheetSeq += 1;
        actionSheetOpen = false;
        actionSheetMsg = null;
        actionSheetDetail = null;
        actionSheetDetailLoading = false;
        if (actionSheetDispose) { actionSheetDispose(); actionSheetDispose = null; }
    }

    async function actionToggleRead(msg: MessageListItem) {
        const user = authState.activeUser;
        const epoch = accountEpoch;
        if (!user || user !== observedUser || !findRow(msg)) return;
        const path = rowPath(msg);
        const key = rowKey(msg);
        const seen = msg.flags.includes('\\Seen');
        try {
            const r = await modifyFlags(path, msg.uid, seen ? { remove: ['\\Seen'] } : { add: ['\\Seen'] });
            if (!stillOwner(user, epoch)) return;
            const current = mobileState.messages.find((m) => rowKey(m) === key);
            if (current) current.flags = r.flags;
            if (detailMatchesRow(path, msg.uid)) {
                mobileState.detail!.flags = r.flags;
            }
            showToast('success', seen ? 'Marked unread' : 'Marked read');
        } catch {
            if (stillOwner(user, epoch)) showToast('error', 'Failed to update read state');
        }
    }

    onMount(() => {
        refreshMailboxes();
        // Coming back from a message keeps an all-folders result set as is.
        if (!(mobileState.searchScope === 'all' && mobileState.messages.length > 0)) refreshMessages();
        const interval = setInterval(refreshMailboxes, 60_000);
        window.addEventListener('webmail:client-rule', onRule);
        return () => {
            clearInterval(interval);
            window.removeEventListener('webmail:client-rule', onRule);
            if (searchDebounce) clearTimeout(searchDebounce);
            cancelGlobalSearch();
        };
    });

    // Re-fetch inbox state every time the user returns to the app.
    // Skip the initial mount tick (resumeTick === 0) since onMount
    // already kicked off the load.
    let lastResumeTick = 0;
    $effect(() => {
        if (mobileState.resumeTick === lastResumeTick) return;
        lastResumeTick = mobileState.resumeTick;
        if (mobileState.resumeTick > 0) {
            refreshMailboxes();
            refreshMessages();
        }
    });
</script>

<div class="inbox-view">
    <header class="mheader">
        <div class="header-left">
            <button type="button" class="mbtn mbtn-ghost" aria-label="Refresh folder" title="Refresh" onclick={() => { refreshMessages(true); refreshMailboxes(); }}>
                <Icon name="refresh" size={18} />
            </button>
            <LatencyChip />
        </div>
        <h1>
            {currentFolder?.name || currentFolder?.path || 'Inbox'}
            {#if unreadCount > 0}
                <span class="badge">{unreadCount}</span>
            {/if}
        </h1>
        <button type="button" class="mbtn mbtn-ghost" data-testid="compose-btn" aria-label="Compose new message" title="Compose" onclick={() => {
            mobileState.composeReplyTo = null;
            mobileState.composeMode = 'new';
            navigate('compose');
        }}>
            <Icon name="plus" size={20} />
        </button>
    </header>

    <div class="msearch">
        <input
            type="search"
            placeholder="Search"
            aria-label="Search mail"
            value={searchInput}
            oninput={(e) => onSearch((e.currentTarget as HTMLInputElement).value)}
        />
        {#if (mobileState.search || '').trim()}
            {#if mobileState.searchScope === 'all'}
                <button type="button" class="search-scope-btn active" onclick={exitGlobalSearch}>
                    <Icon name="close" size={11} />
                    <span>All</span>
                </button>
            {:else}
                <button type="button" class="search-scope-btn" onclick={searchAllFolders}>
                    <Icon name="folder" size={11} />
                    <span>All folders</span>
                </button>
            {/if}
        {/if}
    </div>
    {#if globalScan}
        <div class="global-scan" aria-live="polite">
            <span class="muted small">Searching every folder · {globalScan.scanned} / {globalScan.total}</span>
            <span class="scan-bar" aria-hidden="true" style={`--pct: ${Math.min(100, Math.round((globalScan.scanned / Math.max(1, globalScan.total)) * 100))}%;`}></span>
        </div>
    {/if}

    <div class="segments" style="margin: 8px 16px 0;">
        {#each (settings.aiFeatures ? ['all','unread','starred','ai-sorted'] : ['all','unread','starred']) as f}
            <button
                type="button"
                class="segment"
                class:active={mobileState.filter === f}
                aria-pressed={mobileState.filter === f}
                onclick={() => { mobileState.filter = f as any; }}
            >
                {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : f === 'starred' ? 'Starred' : 'AI sort'}
            </button>
        {/each}
    </div>

    <!-- The touch handlers drive pull-to-refresh / swipe gestures — pointer
         enhancements over a plain content list, not a widget. -->
    <div
        class="list scroll-y"
        role="presentation"
        bind:this={listEl}
        onscroll={onScroll}
        ontouchstart={onTouchStart}
        ontouchmove={onTouchMove}
        ontouchend={onTouchEnd}
    >
        <div class="pull-indicator" style="height: {pullDelta}px; opacity: {pullDelta > 5 ? 1 : 0};">
            <div class="pull-content">
                {#if isRefreshing}
                    <span class="spinner" style="width:20px;height:20px"></span>
                    <span class="muted small">Refreshing…</span>
                {:else if pullDelta >= PULL_THRESHOLD}
                    <span class="muted small">Release to refresh</span>
                {:else}
                    <span class="muted small">Pull to refresh</span>
                {/if}
            </div>
        </div>
        {#if mobileState.messagesError}
            <div class="mempty">
                <Icon name="info" size={32} />
                <p>{mobileState.messagesError}</p>
                <button class="mbtn mbtn-secondary" onclick={() => refreshMessages(true)}>Retry</button>
            </div>
        {:else if mobileState.messagesLoading && mobileState.messages.length === 0}
            <div class="mempty" role="status" data-testid="mobile-inbox-loading">
                <span class="spinner" style="width:24px;height:24px" aria-hidden="true"></span>
                <p>Loading messages…</p>
            </div>
        {:else if !mobileState.messagesLoading && mobileState.messages.length === 0}
            <div class="mempty">
                <Icon name="inbox" size={40} />
                <p>
                    {#if mobileState.search}
                        No matches found.
                    {:else if mobileState.filter === 'unread'}
                        No unread messages here.
                    {:else if mobileState.filter === 'starred'}
                        No starred messages here.
                    {:else}
                        This folder is empty.
                    {/if}
                </p>
            </div>
        {:else}
            {#if settings.aiFeatures && aiSortLoading}
                <div class="load-more">
                    <span class="spinner" style="width:18px;height:18px"></span>
                    <span class="muted">AI sorting…</span>
                </div>
            {:else if aiSortError}
                <div class="mempty error" role="alert">
                    <p>{aiSortError}</p>
                </div>
            {/if}
            {#each filtered as msg (rowKey(msg))}
                {@const isUnread = unread(msg.flags)}
                {@const isStarred = flagged(msg.flags)}
                {@const sender = senderShort(msg.envelope.from)}
                {@const email = msg.envelope.from?.[0]?.address || ''}
                {@const name = msg.envelope.from?.[0]?.name || null}
                {@const isTracked = isTrackingEmail(msg.envelope.subject)}
                {@const dlevel = mobileState.filter === 'ai-sorted' ? dangerLevel(msg.uid) : 0}
                <SwipeableRow
                    onOpen={() => selectMessage(msg)}
                    onSwipeRight={() => toggleStar(msg)}
                    onSwipeLeft={() => trashMessage(msg)}
                    onLongPress={() => openActionSheet(msg)}
                    rightLabel={isStarred ? 'Unstar' : 'Star'}
                    leftLabel="Trash"
                    label={`${isUnread ? 'Unread, ' : ''}${isStarred ? 'Starred, ' : ''}${sender}, ${msg.envelope.subject || '(no subject)'}`}
                    rightColor="var(--star)"
                    leftColor="var(--danger)"
                >
                    {@const isFresh = (() => { const t = Date.parse(msg.internalDate || msg.envelope.date || ''); return !Number.isNaN(t) && (Date.now() - t < 10 * 60 * 1000); })()}
                    <div class="msg-row" class:unread={isUnread} class:fresh={isFresh} class:spy-tracked={isTracked} class:danger-1={dlevel === 1} class:danger-2={dlevel === 2} class:danger-3={dlevel === 3} class:danger-4={dlevel === 4} class:rule-running={ruleAnimUids.has(msg.uid)} class:rule-popping={ruleDoneUids.has(msg.uid)}>
                        <Avatar {email} {name} size={40} />
                        <div class="msg-body">
                            <div class="msg-top">
                                <span class="msg-from truncate" class:bold={isUnread}>{sender}</span>
                                <span class="msg-date">{formatDate(msg.internalDate || msg.envelope.date)}</span>
                            </div>
                            <div class="msg-subject truncate" class:bold={isUnread}>
                                {#if isUnread}<span class="dot"></span>{/if}
                                {#if isTracked}
                                    <span class="spy-mark" title="Open-tracking notification" aria-label="Tracking notification"><Icon name="spy" size={12} /></span>
                                {/if}
                                {#if msg.mailbox}
                                    <span class="folder-badge" title={`In: ${msg.mailbox}`}>{msg.mailbox.split('/').slice(-1)[0] || msg.mailbox}</span>
                                {/if}
                                {msg.envelope.subject || '(no subject)'}
                            </div>
                        </div>
                        {#if isStarred}
                            <span class="star-mark"><Icon name="starFilled" size={14} /></span>
                        {/if}
                    </div>
                </SwipeableRow>
            {/each}
            {#if appending}
                <div class="load-more">
                    <span class="spinner" style="width:18px;height:18px"></span>
                    <span class="muted">Loading…</span>
                </div>
            {/if}
        {/if}
    </div>
</div>

{#if actionSheetOpen && actionSheetMsg}
    {@const sheetMsg = actionSheetMsg}
    <MessageActionSheet
        msg={sheetMsg}
        detail={actionSheetDetail}
        isOpen={actionSheetOpen}
        onClose={closeActionSheet}
        onOpen={() => selectMessage(sheetMsg)}
        onReply={() => {
            mobileState.composeReplyTo = actionSheetDetail;
            mobileState.composeMode = 'reply';
            navigate('compose');
        }}
        onToggleStar={() => toggleStar(sheetMsg)}
        onToggleRead={() => actionToggleRead(sheetMsg)}
        onArchive={() => archiveMessage(sheetMsg)}
        onTrash={() => trashMessage(sheetMsg)}
    />
{/if}

<style>
    .inbox-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }
    .header-left {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 20px;
        padding: 0 6px;
        border-radius: 10px;
        background: var(--accent);
        color: var(--text-on-accent);
        font-size: 12px;
        font-weight: 600;
        margin-left: 5px;
        vertical-align: middle;
    }
    .list {
        flex: 1;
        padding: 0;
        overscroll-behavior-y: contain;
        touch-action: pan-y;
    }
    .pull-indicator {
        overflow: hidden;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        transition: height 180ms ease, opacity 180ms ease;
    }
    .pull-content {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding-bottom: 10px;
        height: 56px;
        flex-shrink: 0;
    }
    /* Fresh mail gets a quiet accent rail, not an animated halo. */
    .msg-row.fresh {
        background: var(--bg-surface);
        box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 70%, transparent);
    }
    .msg-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        background: var(--bg-surface);
        border-bottom: 0.5px solid var(--border-subtle);
        transition: background-color 80ms;
        min-height: 68px;
    }
    .msg-row.danger-4,
    .msg-row.danger-3 {
        background: color-mix(in srgb, #ef4444 8%, var(--bg-surface));
        box-shadow: inset 3px 0 0 #ef4444;
    }
    .msg-row.danger-2 {
        background: color-mix(in srgb, #eab308 7%, var(--bg-surface));
        box-shadow: inset 3px 0 0 #eab308;
    }
    .msg-row.danger-1 {
        background: color-mix(in srgb, #22c55e 6%, var(--bg-surface));
        box-shadow: inset 3px 0 0 #22c55e;
    }
    .msg-row.spy-tracked {
        box-shadow: inset 3px 0 0 color-mix(in srgb, #10b981 55%, var(--border-subtle));
    }
    .spy-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        vertical-align: middle;
        width: 14px;
        height: 14px;
        margin-right: 3px;
        color: #10b981;
        background: color-mix(in srgb, #10b981 12%, transparent);
        border-radius: 50%;
    }
    .msg-row.spy-tracked .msg-subject {
        color: var(--text-primary);
        font-weight: 600;
    }
    .msg-row:active { background: var(--bg-hover); }
    .msg-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
    }
    .msg-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
    }
    .msg-from {
        font-size: 15px;
        font-weight: 400;
        color: var(--text-primary);
        /* min-width:0 lets the flex child shrink below its intrinsic
           text width so the trailing .msg-date doesn't get pushed off
           or overlap when the sender name is long. */
        min-width: 0;
        flex: 1 1 auto;
    }
    .msg-from.bold { font-weight: 600; }
    .msg-date {
        font-size: 12px;
        font-weight: 400;
        color: var(--text-tertiary);
        flex-shrink: 0;
    }
    .msg-subject {
        font-size: 14px;
        font-weight: 400;
        color: var(--text-secondary);
        line-height: 1.35;
    }
    .msg-subject.bold { font-weight: 500; color: var(--text-primary); }
    .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--unread-dot);
        margin-right: 5px;
        vertical-align: middle;
    }
    .star-mark {
        color: var(--star);
        flex-shrink: 0;
    }
    .load-more {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 16px;
        color: var(--text-tertiary);
        font-size: 13px;
    }

    /* Running rules use a static accent rail; completion keeps a brief
     * exit transition so the row's removal remains understandable. */
    .msg-row.rule-running {
        background: color-mix(in srgb, var(--accent) 9%, var(--bg-surface));
        box-shadow: inset 3px 0 0 var(--accent);
    }
    .msg-row.rule-popping {
        animation: rule-pop 360ms cubic-bezier(0.4, 0.0, 1, 1) forwards;
        pointer-events: none;
    }
    @keyframes rule-pop {
        0%   { transform: scale(1) translateX(0);   opacity: 1; filter: blur(0); }
        40%  { transform: scale(1.02) translateX(0); opacity: 0.85; }
        100% { transform: scale(0.6) translateX(40px); opacity: 0; filter: blur(2px); }
    }
    @media (prefers-reduced-motion: reduce) {
        .msg-row.rule-popping { animation: none; opacity: 0.4; }
    }
</style>
