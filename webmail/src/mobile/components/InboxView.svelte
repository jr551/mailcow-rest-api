<script lang="ts">
    import { onMount } from 'svelte';
    import { mobileState, navigate, showToast, pushOverlay } from '../lib/store.svelte';
    import { tryRenewSession } from '../../lib/auth.svelte';
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
    import { settings, setInboxTab, setListFilter, isVipAddress } from '../../lib/settings.svelte';
    import { authState } from '../../lib/auth.svelte';
    import { filterMessagesByOutlookFilter } from '../../lib/list-quick-filters';
    import { filterMessagesByInboxTab } from '../../lib/focused-inbox';
    import {
        followUpDueLabel,
        getFollowUpDueMs,
        type FollowUpPresetId,
    } from '../../lib/message-follow-up';
    import {
        hydrateMessageFollowUp,
        followUpOverlay,
        setFollowUpDue,
        clearFollowUpDue,
    } from '../../lib/message-follow-up.svelte';
    import {
        filterOutSnoozedMessages,
        sortWithPinnedFirst,
        type SnoozePresetId,
    } from '../../lib/message-pin-snooze';
    import {
        hydrateMessagePinSnooze,
        pinSnoozeOverlay,
        snoozeMessage,
        tickPinSnoozeOverlay,
        toggleMessagePin,
    } from '../../lib/message-pin-snooze.svelte';
    import { mobileRowIsPinned } from '../../lib/mobile-message-pin';
    import {
        senderAddressFromMessage,
        senderDisplayLabel,
        senderSweepConfirmText,
        type SenderSweepAction,
    } from '../../lib/message-sender-sweep';
    import { resolveSenderSweepTargets } from '../../lib/message-sender-sweep-fetch';
    import { bulkMove, findArchiveFolder, findTrashFolder } from '../../lib/spam-sweep';
    import Icon from '../../components/Icon.svelte';
    import Avatar from '../../components/Avatar.svelte';
    import SwipeableRow from './SwipeableRow.svelte';
    import MessageActionSheet from './MessageActionSheet.svelte';
    import SenderSweepDialog from '../../components/SenderSweepDialog.svelte';
    import MobileQuickFilterBar from './MobileQuickFilterBar.svelte';
    import LatencyChip from '../../components/LatencyChip.svelte';
    import { playClick } from '../../lib/sounds.svelte';
    import { findThreadForUid } from '../../lib/conversation-view';
    import { setMobileMailShortcutHandler } from '../lib/mail-shortcut-handlers.svelte';
    import { shouldUseMobileTabletSplit } from '../../lib/mobile-tablet-reading-pane';
    import { getMobileViewportWidth } from '../lib/viewport.svelte';
    import {
        buildCategoryFlagUpdate,
        applyCategoryToFlags,
        categoryFromFlags,
        MESSAGE_CATEGORY_BY_ID,
        type MessageCategoryId
    } from '../../lib/message-categories';
    import { mobileRowCategory } from '../../lib/mobile-message-category';
    import {
        hydrateMessageCategories,
        messageCategoryOverlay,
        setMessageCategoryOverlay
    } from '../../lib/message-categories.svelte';
    import type { SavedMailSearch } from '../../lib/saved-mail-searches';
    import {
        savedMailSearches,
        addSavedMailSearch,
        deleteSavedMailSearch,
        recordSavedMailSearchUse
    } from '../../lib/saved-mail-searches.svelte';
    import { shouldShowMobileSavedSearchPanel } from '../../lib/mobile-saved-search-panel';
    import {
        OWA_SEARCH_CATEGORIES,
        mailQueryForCategory,
        shouldRunMailSearch,
        searchPlaceholderForCategory,
        type SearchCategory
    } from '../../lib/search-category';
    import { loadAddressBook, searchContacts, contactNameFor } from '../../lib/address-book.svelte';
    import { translateNaturalLanguageSearch } from '../../lib/natural-language-search.client';
    import { shouldTranslateNlSearchQuery } from '../../lib/natural-language-search';
    import {
        MAIL_COMMAND_BAR_LABEL,
        MAIL_MESSAGE_LIST_LABEL,
        MAIL_MESSAGE_LIST_LANDMARK_ID,
        MAIL_SKIP_LINK_TEXT,
        focusMobileMessageListLandmark
    } from '../../lib/mobile-mail-landmarks';

    function focusMessageListLandmark(e?: MouseEvent) {
        e?.preventDefault();
        focusMobileMessageListLandmark();
    }

    let searchInput = $state('');
    let searchInputEl: HTMLInputElement | undefined = $state();
    let searchDebounce: ReturnType<typeof setTimeout> | null = null;
    let searchResolveGen = 0;
    let nlSearchResolving = $state(false);
    let lastNlSearchTranslation = $state<string | null>(null);
    let searchPanelOpen = $state(false);
    let saveSearchFormOpen = $state(false);
    let saveSearchDraftName = $state('');

    const canSaveCurrentSearch = $derived.by(() => {
        if (mobileState.searchCategory !== 'mail') return false;
        return (searchInput || mobileState.search || '').trim().length > 0;
    });
    const peopleSearchActive = $derived(
        mobileState.searchCategory === 'people' && searchInput.trim().length > 0
    );
    const peopleSearchResults = $derived.by(() => {
        if (mobileState.searchCategory !== 'people') return [];
        return searchContacts(searchInput, 12);
    });
    const mobileSearchPlaceholder = $derived(
        searchPlaceholderForCategory(
            mobileState.searchCategory,
            !!(settings.naturalLanguageSearch && settings.aiFeatures)
        )
    );
    const showMobileSearchPanel = $derived(
        shouldShowMobileSavedSearchPanel(
            searchPanelOpen,
            savedMailSearches.items.length,
            canSaveCurrentSearch,
            saveSearchFormOpen,
            peopleSearchActive
        )
    );

    const SERVER_CAP = 100;
    let appending = $state(false);

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
    const dropRow = (msg: MessageListItem) => {
        mobileState.messages = mobileState.messages.filter((m) => rowKey(m) !== rowKey(msg));
        mobileState.messagesTotal = Math.max(0, mobileState.messagesTotal - 1);
    };
    const detailIsRow = (msg: MessageListItem) =>
        mobileState.detail?.uid === msg.uid && rowPath(msg) === mobileState.selectedPath;

    async function refreshMailboxes() {
        mobileState.mailboxesLoading = true;
        try {
            const fresh = await listMailboxes({ counts: true });
            mobileState.mailboxes = fresh;
        } catch (err) {
            // Don't ever drop the session on 401 — most often the server
            // just got redeployed and lost its pool. Try a silent renewal
            // via stored creds; if that succeeds, retry once. If not,
            // surface a toast so the user can re-login on their own
            // schedule rather than getting kicked back to the login screen.
            if (err instanceof ApiError && err.status === 401) {
                if (await tryRenewSession()) {
                    try {
                        mobileState.mailboxes = await listMailboxes({ counts: true });
                    } catch { /* fall through */ }
                } else {
                    showToast('error', 'Session lost — re-open the app or sign in again.');
                }
            }
        } finally {
            mobileState.mailboxesLoading = false;
        }
    }

    async function refreshMessages(reset = false) {
        // An all-folders result set must not collapse to the single folder
        // that happens to be selected.
        if (mobileState.searchScope === 'all' && (mobileState.search || '').trim()) return searchAllFolders();
        if (reset) mobileState.messages = [];
        mobileState.messagesLoading = true;
        mobileState.messagesError = null;
        try {
            const r = await listMessages(mobileState.selectedPath, {
                page: 0,
                pageSize: SERVER_CAP,
                search: mobileState.search || undefined,
            });
            mobileState.messages = r.messages;
            mobileState.messagesTotal = r.total;
            // (client-rules pass removed — settings.clientRules deleted by Settings refactor)
        } catch (err) {
            mobileState.messagesError = err instanceof Error ? err.message : 'Failed to load messages';
            if (err instanceof ApiError && err.status === 401) {
                if (await tryRenewSession()) {
                    try {
                        const r = await listMessages(mobileState.selectedPath, {
                            page: 0,
                            pageSize: SERVER_CAP,
                            search: mobileState.search || undefined,
                        });
                        mobileState.messages = r.messages;
                        mobileState.messagesTotal = r.total;
                        mobileState.messagesError = null;
                    } catch { /* keep the original error visible */ }
                } else {
                    showToast('error', 'Session lost — re-open the app or sign in again.');
                }
            }
        } finally {
            mobileState.messagesLoading = false;
        }
    }

    async function loadMore() {
        if (appending || mobileState.messagesLoading) return;
        if (mobileState.messages.length >= mobileState.messagesTotal) return;
        const nextPage = Math.floor(mobileState.messages.length / SERVER_CAP);
        appending = true;
        try {
            const r = await listMessages(mobileState.selectedPath, {
                page: nextPage,
                pageSize: SERVER_CAP,
                search: mobileState.search || undefined,
            });
            const seen = new Set(mobileState.messages.map((m) => m.uid));
            const fresh = r.messages.filter((m) => !seen.has(m.uid));
            mobileState.messages = [...mobileState.messages, ...fresh];
            mobileState.messagesTotal = r.total;
        } catch {
            showToast('error', "Couldn't load more messages");
        }
        finally { appending = false; }
    }

    function resetConversationStack() {
        mobileState.conversationStack = null;
        mobileState.conversationDetails = {};
        mobileState.conversationLoading = false;
    }

    async function loadConversationStackForSelection(path: string, uid: number) {
        resetConversationStack();
        if (!settings.groupThreads) return;
        const thread = findThreadForUid(mobileState.messages, uid);
        if (!thread || thread.count <= 1) return;
        mobileState.conversationStack = {
            threadId: thread.id,
            uids: thread.messages.map((m) => m.uid)
        };
        mobileState.conversationLoading = true;
        const details: Record<number, MessageDetail> = {};
        const threadId = thread.id;
        try {
            await Promise.all(
                thread.messages.map(async (m) => {
                    try {
                        details[m.uid] = await getMessage(path, m.uid);
                    } catch {
                        /* sibling bodies are best-effort */
                    }
                })
            );
            if (mobileState.selectedUid === uid && mobileState.conversationStack?.threadId === threadId) {
                mobileState.conversationDetails = details;
            }
        } finally {
            if (mobileState.selectedUid === uid) mobileState.conversationLoading = false;
        }
    }

    async function selectMessage(msg: MessageListItem) {
        playClick();
        const uid = msg.uid;
        mobileState.selectedUid = uid;
        mobileState.detail = null;
        mobileState.detailError = null;
        mobileState.detailLoading = true;
        resetConversationStack();
        // In all-folders search the row carries its source mailbox; switch
        // selectedPath so detail/flags/move target the right folder.
        if (mobileState.searchScope === 'all' && msg.mailbox && mobileState.selectedPath !== msg.mailbox) {
            mobileState.selectedPath = msg.mailbox;
        }
        const path = mobileState.selectedPath;
        if (!shouldUseMobileTabletSplit(settings.readingPaneLayout, getMobileViewportWidth())) {
            navigate('message');
        }
        try {
            const fresh = await getMessage(path, uid);
            mobileState.detail = fresh;
            void loadConversationStackForSelection(path, uid);
            if (fresh.flags && !fresh.flags.includes('\\Seen')) {
                const r = await modifyFlags(path, uid, { add: ['\\Seen'] });
                fresh.flags = r.flags;
                const li = findRow(msg);
                if (li) li.flags = r.flags;
            }
        } catch (err) {
            mobileState.detailError = err instanceof Error ? err.message : 'Failed to load message';
        } finally {
            mobileState.detailLoading = false;
        }
    }

    async function toggleStar(msg: MessageListItem) {
        const li = findRow(msg);
        if (!li) return;
        const path = rowPath(li);
        const isFlagged = li.flags.includes('\\Flagged');
        try {
            const r = await modifyFlags(path, li.uid, isFlagged ? { remove: ['\\Flagged'] } : { add: ['\\Flagged'] });
            li.flags = r.flags;
            if (mobileState.detail && detailIsRow(li)) mobileState.detail.flags = r.flags;
            if (isFlagged) clearFollowUpDue(path, li.uid);
            else setFollowUpDue(path, li.uid, 'no-date');
        } catch {
            showToast('error', "Couldn't update star");
        }
    }

    async function trashMessage(msg: MessageListItem) {
        const from = rowPath(msg);
        const trashBox = mobileState.mailboxes.find((m) => m.specialUse === '\\Trash')?.path || 'Trash';
        try {
            if (from === trashBox) await deleteMessage(from, msg.uid);
            else await moveMessage(from, msg.uid, trashBox);
            dropRow(msg);
            showToast('success', from === trashBox ? 'Deleted' : 'Moved to Trash');
        } catch {
            showToast('error', 'Failed to delete');
        }
    }

    async function archiveMessage(msg: MessageListItem) {
        const archiveBox = mobileState.mailboxes.find((m) => m.specialUse === '\\Archive')?.path || 'Archive';
        try {
            await moveMessage(rowPath(msg), msg.uid, archiveBox);
            dropRow(msg);
            showToast('success', 'Archived');
        } catch {
            showToast('error', 'Failed to archive');
        }
    }

    function onSearch(value: string) {
        searchInput = value;
        if (mobileState.searchCategory === 'people' && value.trim()) {
            searchPanelOpen = true;
        }
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => applySearchFromInput(), 300);
    }

    function setSearchCategory(category: SearchCategory) {
        if (mobileState.searchCategory === category) return;
        mobileState.searchCategory = category;
        searchPanelOpen = true;
        if (searchDebounce) clearTimeout(searchDebounce);
        applySearchFromInput();
    }

    async function applySearchFromInput() {
        const gen = ++searchResolveGen;
        if (!shouldRunMailSearch(mobileState.searchCategory)) {
            lastNlSearchTranslation = null;
            mobileState.search = '';
            if (mobileState.searchScope === 'all') {
                cancelGlobalSearch();
                mobileState.searchScope = 'folder';
            }
            mobileState.messages = [];
            mobileState.messagesTotal = 0;
            mobileState.messagesLoading = false;
            return;
        }
        let q = searchInput.trim();
        lastNlSearchTranslation = null;

        if (
            shouldTranslateNlSearchQuery(q, mobileState.searchCategory, {
                aiFeatures: settings.aiFeatures,
                naturalLanguageSearch: settings.naturalLanguageSearch
            })
        ) {
            nlSearchResolving = true;
            try {
                const translated = await translateNaturalLanguageSearch(q);
                if (gen !== searchResolveGen) return;
                if (translated) {
                    lastNlSearchTranslation = translated;
                    q = translated;
                }
            } finally {
                if (gen === searchResolveGen) nlSearchResolving = false;
            }
        }

        q = mailQueryForCategory(q, mobileState.searchCategory);
        mobileState.search = q;
        if (mobileState.searchScope === 'all') {
            cancelGlobalSearch();
            mobileState.searchScope = 'folder';
        }
        refreshMessages(true);
    }

    function composeToContact(address: string) {
        searchPanelOpen = false;
        mobileState.composeReplyTo = null;
        mobileState.composeMode = 'new';
        mobileState.composePrefillTo = address;
        navigate('compose');
    }

    // ----- Global (all-folders) search -----------------------------------
    let globalAbort: AbortController | null = null;
    let globalScan = $state<{ scanned: number; total: number } | null>(null);

    function cancelGlobalSearch() {
        if (globalAbort) { globalAbort.abort(); globalAbort = null; }
        globalScan = null;
    }

    async function searchAllFolders() {
        const q = (mobileState.search || '').trim();
        if (!q) return;
        cancelGlobalSearch();
        mobileState.searchScope = 'all';
        const ctrl = new AbortController();
        globalAbort = ctrl;
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
                if (ctrl.signal.aborted) break;
                const path = folders[i];
                try {
                    const r = await listMessages(path, { page: 0, pageSize: SERVER_CAP, search: q });
                    if (ctrl.signal.aborted) break;
                    for (const msg of r.messages) {
                        const k = `${path} ${msg.uid}`;
                        if (seen.has(k)) continue;
                        seen.add(k);
                        aggregated.push({ ...msg, mailbox: path });
                    }
                    mobileState.messages = [...aggregated];
                    mobileState.messagesTotal = aggregated.length;
                } catch { /* per-folder errors non-fatal */ }
                globalScan = { scanned: i + 1, total: folders.length };
            }
        } finally {
            mobileState.messagesLoading = false;
            if (globalAbort === ctrl) globalAbort = null;
            setTimeout(() => { if (!globalAbort) globalScan = null; }, 1500);
        }
    }

    function exitGlobalSearch() {
        cancelGlobalSearch();
        mobileState.searchScope = 'folder';
        refreshMessages(true);
    }

    function startSaveCurrentSearch() {
        const q = (searchInput || mobileState.search || '').trim();
        if (!q) return;
        saveSearchFormOpen = true;
        saveSearchDraftName = q.slice(0, 40);
        searchPanelOpen = true;
    }

    function confirmSaveCurrentSearch() {
        const q = (searchInput || mobileState.search || '').trim();
        if (!q) return;
        const scope = mobileState.searchScope === 'all' ? 'all' : 'folder';
        const name = saveSearchDraftName.trim() || q;
        const entry = addSavedMailSearch(name, q, scope);
        if (!entry) return;
        saveSearchFormOpen = false;
        saveSearchDraftName = '';
        showToast('success', 'Search saved');
    }

    function cancelSaveSearchForm() {
        saveSearchFormOpen = false;
        saveSearchDraftName = '';
    }

    async function applySavedMailSearch(entry: SavedMailSearch) {
        recordSavedMailSearchUse(entry.id);
        searchInput = entry.query;
        searchPanelOpen = false;
        saveSearchFormOpen = false;
        if (searchDebounce) clearTimeout(searchDebounce);
        mobileState.search = entry.query.trim();
        if (entry.scope === 'all') {
            await searchAllFolders();
            return;
        }
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
            isRefreshing = true;
            pullDelta = PULL_THRESHOLD;
            Promise.all([refreshMessages(true), refreshMailboxes()]).finally(() => {
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
            if (settings.listFilter === 'ai-sorted') setListFilter('all');
            aiSortError = null;
            aiRankings = [];
            lastSortedKey = '';
            return;
        }
        if (settings.listFilter !== 'ai-sorted') {
            aiSortError = null;
            return;
        }
        const msgs = mobileState.messages;
        if (msgs.length === 0) {
            aiRankings = [];
            lastSortedKey = '';
            return;
        }
        const key = msgs.map((m) => m.uid).sort((a, b) => a - b).join(',');
        if (key === lastSortedKey) return;
        lastSortedKey = key;
        aiSortLoading = true;
        aiSortError = null;
        sortInboxClient(msgs.map((m) => ({
            uid: m.uid,
            subject: m.envelope.subject || undefined,
            from: m.envelope.from,
            to: m.envelope.to,
            date: m.envelope.date || m.internalDate || undefined
        })))
            .then((res) => { aiRankings = res.rankings; })
            .catch((err) => { aiSortError = err instanceof Error ? err.message : 'AI sort failed'; })
            .finally(() => { aiSortLoading = false; });
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
        const f = settings.listFilter;
        const userEmail = authState.activeUser ?? '';
        let base = filterMessagesByOutlookFilter(mobileState.messages, f, { userEmail });
        if (showInboxTabs) {
            base = filterMessagesByInboxTab(base, settings.inboxTab, { isVip: isVipAddress });
        }
        void pinSnoozeOverlay();
        void pinSnoozeNow;
        const mailboxPath = mobileState.selectedPath;
        base = filterOutSnoozedMessages(base, mailboxPath, pinSnoozeOverlay(), pinSnoozeNow);
        const sort = f === 'ai-sorted' ? 'date-desc' : settings.listSort;
        if (f !== 'ai-sorted' || aiRankings.length === 0) {
            return sortWithPinnedFirst(base, mailboxPath, pinSnoozeOverlay(), sort);
        }
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

    const showInboxTabs = $derived(
        !(mobileState.search || '').trim()
        && mobileState.searchScope !== 'all'
        && (mobileState.selectedPath || '').toUpperCase() === 'INBOX'
    );

    const unreadCount = $derived(
        mobileState.mailboxes.find((m) => m.path === 'INBOX' || m.specialUse === '\\Inbox')?.unseen ?? 0
    );

    // Long-press action sheet state
    let actionSheetOpen = $state(false);
    let actionSheetMsg: MessageListItem | null = $state(null);
    let actionSheetDetail: MessageDetail | null = $state(null);
    let actionSheetDetailLoading = $state(false);
    let actionSheetDispose: (() => void) | null = null;

    async function openActionSheet(msg: MessageListItem) {
        actionSheetMsg = msg;
        actionSheetOpen = true;
        actionSheetDetail = null;
        actionSheetDetailLoading = true;
        // Register with the back-button stack so Android-back closes the
        // sheet first instead of leaving the inbox view entirely.
        actionSheetDispose = pushOverlay('inbox-action-sheet', () => {
            actionSheetOpen = false;
            actionSheetMsg = null;
            actionSheetDetail = null;
            actionSheetDispose = null;
        });
        try {
            const fresh = await getMessage(rowPath(msg), msg.uid);
            actionSheetDetail = fresh;
        } catch {
            // Sheet stays open for the non-detail actions; Summarize is
            // already guarded by `if (!detail)` inside MessageActionSheet,
            // so a failed fetch cannot trigger a paid call on an empty body.
            showToast('error', "Couldn't load message details");
        } finally {
            actionSheetDetailLoading = false;
        }
    }

    function closeActionSheet() {
        actionSheetOpen = false;
        actionSheetMsg = null;
        actionSheetDetail = null;
        if (actionSheetDispose) { actionSheetDispose(); actionSheetDispose = null; }
    }

    let followUpNow = $state(Date.now());
    let pinSnoozeNow = $state(Date.now());
    let mobileSweepBusy = $state(false);
    let senderSweepDialogMessage = $state<MessageListItem | null>(null);

    function openMobileSenderSweepDialog(msg: MessageListItem) {
        closeActionSheet();
        senderSweepDialogMessage = msg;
    }

    function rowFollowUpHint(uid: number, isFlagged: boolean): string | null {
        if (!isFlagged) return null;
        void followUpOverlay();
        const due = getFollowUpDueMs(followUpOverlay(), mobileState.selectedPath, uid);
        return followUpDueLabel(due, followUpNow);
    }

    function rowMessageCategory(msg: MessageListItem): MessageCategoryId | null {
        void messageCategoryOverlay();
        return mobileRowCategory(mobileState.selectedPath, msg, messageCategoryOverlay());
    }

    function rowIsPinned(msg: MessageListItem): boolean {
        void pinSnoozeOverlay();
        return mobileRowIsPinned(pinSnoozeOverlay(), mobileState.selectedPath, msg);
    }

    function togglePin(msg: MessageListItem) {
        const path = rowPath(msg);
        const wasPinned = mobileRowIsPinned(pinSnoozeOverlay(), mobileState.selectedPath, msg);
        toggleMessagePin(path, msg.uid);
        showToast('success', wasPinned ? 'Unpinned' : 'Pinned to top');
    }

    async function applyMessageCategory(msg: MessageListItem, category: MessageCategoryId | null) {
        const li = findRow(msg);
        if (!li) return;
        const path = rowPath(li);
        const op = buildCategoryFlagUpdate(li.flags, category);
        let flags = li.flags;
        try {
            if (Object.keys(op).length) {
                const r = await modifyFlags(path, li.uid, op);
                flags = r.flags;
            } else {
                flags = applyCategoryToFlags(li.flags, category);
            }
        } catch {
            flags = applyCategoryToFlags(li.flags, category);
            setMessageCategoryOverlay(path, li.uid, category);
            showToast('error', 'Category saved locally only');
        }
        li.flags = flags;
        if (mobileState.detail && detailIsRow(li)) mobileState.detail.flags = flags;
        if (categoryFromFlags(flags)) {
            setMessageCategoryOverlay(path, li.uid, null);
        } else {
            setMessageCategoryOverlay(path, li.uid, category);
        }
        showToast('success', category ? 'Category updated' : 'Category cleared');
    }

    async function applyFollowUpFlag(msg: MessageListItem, preset: FollowUpPresetId | 'clear') {
        const li = findRow(msg);
        if (!li) return;
        const path = rowPath(li);
        if (preset === 'clear') {
            clearFollowUpDue(path, li.uid);
            if (!li.flags.includes('\\Flagged')) return;
            try {
                const r = await modifyFlags(path, li.uid, { remove: ['\\Flagged'] });
                li.flags = r.flags;
                if (mobileState.detail && detailIsRow(li)) mobileState.detail.flags = r.flags;
                showToast('success', 'Follow-up flag cleared');
            } catch {
                showToast('error', 'Failed to clear flag');
            }
            return;
        }
        setFollowUpDue(path, li.uid, preset);
        if (li.flags.includes('\\Flagged')) {
            showToast('success', 'Follow-up date updated');
            return;
        }
        try {
            const r = await modifyFlags(path, li.uid, { add: ['\\Flagged'] });
            li.flags = r.flags;
            if (mobileState.detail && detailIsRow(li)) mobileState.detail.flags = r.flags;
            showToast('success', 'Flagged for follow-up');
        } catch {
            showToast('error', 'Failed to set follow-up flag');
        }
    }

    async function actionToggleRead(msg: MessageListItem) {
        const seen = msg.flags.includes('\\Seen');
        try {
            const r = await modifyFlags(rowPath(msg), msg.uid, seen ? { remove: ['\\Seen'] } : { add: ['\\Seen'] });
            msg.flags = r.flags;
            if (mobileState.detail && detailIsRow(msg)) {
                mobileState.detail.flags = r.flags;
            }
            showToast('success', seen ? 'Marked unread' : 'Marked read');
        } catch {
            showToast('error', 'Failed to update read state');
        }
    }

    function applySnooze(msg: MessageListItem, preset: SnoozePresetId) {
        const path = rowPath(msg);
        snoozeMessage(path, msg.uid, preset);
        pinSnoozeNow = Date.now();
        showToast('success', 'Message snoozed — it will return when the reminder is due.');
    }

    async function runMobileSenderSweep(
        msg: MessageListItem,
        action: SenderSweepAction,
        opts: { skipConfirm?: boolean } = {}
    ): Promise<boolean> {
        if (mobileSweepBusy) return false;
        const sender = senderAddressFromMessage(msg);
        if (!sender) {
            showToast('error', 'No sender address on this message.');
            return false;
        }
        const label = senderDisplayLabel(msg);
        const path = rowPath(msg);
        mobileSweepBusy = true;
        let targets: MessageListItem[] = [];
        try {
            targets = await resolveSenderSweepTargets(path, sender, action);
        } catch (err) {
            showToast('error', `Sweep failed: ${err instanceof Error ? err.message : 'unknown error'}`);
            mobileSweepBusy = false;
            return false;
        }
        if (targets.length === 0) {
            showToast('info', action === 'keep-latest'
                ? `Only one message from ${label} is in this folder.`
                : `No messages from ${label} to sweep.`);
            mobileSweepBusy = false;
            return false;
        }
        if (!opts.skipConfirm && !window.confirm(senderSweepConfirmText(action, targets.length, label))) {
            mobileSweepBusy = false;
            return false;
        }
        let dest: string | null = null;
        try {
            dest = action === 'archive-all'
                ? findArchiveFolder(mobileState.mailboxes)
                : findTrashFolder(mobileState.mailboxes);
        } catch { /* handled below */ }
        if (!dest) {
            showToast('error', action === 'archive-all'
                ? 'No Archive folder found.'
                : 'No Trash folder found.');
            mobileSweepBusy = false;
            return false;
        }
        const items = targets.map((t) => ({ path, uid: t.uid }));
        try {
            const r = await bulkMove(items, dest);
            const verb = action === 'archive-all' ? 'Archived' : 'Moved to Trash';
            showToast(r.failed ? 'error' : 'success',
                `${verb} ${r.moved} message${r.moved === 1 ? '' : 's'}${r.failed ? ` (${r.failed} failed)` : ''}.`);
            const movedUids = new Set(r.movedItems.map((i) => i.uid));
            mobileState.messages = mobileState.messages.filter((m) => !movedUids.has(m.uid));
            mobileState.messagesTotal = Math.max(0, mobileState.messagesTotal - r.moved);
            mobileSweepBusy = false;
            return !r.failed;
        } catch {
            showToast('error', 'Sweep failed');
            mobileSweepBusy = false;
            return false;
        }
    }

    function keyboardActiveMessage(): MessageListItem | null {
        if (mobileState.listKeyboardUid != null) {
            const m = filtered.find((r) => r.uid === mobileState.listKeyboardUid);
            if (m) return m;
        }
        if (mobileState.selectedUid != null) {
            return filtered.find((r) => r.uid === mobileState.selectedUid) ?? null;
        }
        return filtered[0] ?? null;
    }

    function moveKeyboardSelection(dir: 'next' | 'prev') {
        const rows = filtered;
        if (rows.length === 0) return;
        let idx = mobileState.listKeyboardUid != null
            ? rows.findIndex((m) => m.uid === mobileState.listKeyboardUid)
            : -1;
        if (idx < 0) idx = 0;
        else idx = dir === 'next' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
        mobileState.listKeyboardUid = rows[idx].uid;
        requestAnimationFrame(() => {
            document.querySelector(`[data-testid="msg-row-${rows[idx].uid}"]`)?.scrollIntoView({ block: 'nearest' });
        });
    }

    async function keyboardMarkRead(wantRead: boolean) {
        const msg = keyboardActiveMessage();
        if (!msg) return;
        const seen = msg.flags.includes('\\Seen');
        if (wantRead === seen) return;
        await actionToggleRead(msg);
    }

    $effect(() => {
        if (mobileState.view !== 'inbox') {
            for (const a of [
                'focus-search', 'navigate-next', 'navigate-prev', 'open-message',
                'archive', 'delete', 'mark-read', 'mark-unread', 'toggle-flag',
            ] as const) {
                setMobileMailShortcutHandler(a, null);
            }
            return;
        }
        setMobileMailShortcutHandler('focus-search', () => { searchInputEl?.focus(); });
        setMobileMailShortcutHandler('navigate-next', () => moveKeyboardSelection('next'));
        setMobileMailShortcutHandler('navigate-prev', () => moveKeyboardSelection('prev'));
        setMobileMailShortcutHandler('open-message', () => {
            const msg = keyboardActiveMessage();
            if (msg) void selectMessage(msg);
        });
        setMobileMailShortcutHandler('archive', () => {
            const msg = keyboardActiveMessage();
            if (msg) void archiveMessage(msg);
        });
        setMobileMailShortcutHandler('delete', () => {
            const msg = keyboardActiveMessage();
            if (msg) void trashMessage(msg);
        });
        setMobileMailShortcutHandler('mark-read', () => { void keyboardMarkRead(true); });
        setMobileMailShortcutHandler('mark-unread', () => { void keyboardMarkRead(false); });
        setMobileMailShortcutHandler('toggle-flag', () => { void keyboardToggleFlag(); });
        return () => {
            for (const a of [
                'focus-search', 'navigate-next', 'navigate-prev', 'open-message',
                'archive', 'delete', 'mark-read', 'mark-unread', 'toggle-flag',
            ] as const) {
                setMobileMailShortcutHandler(a, null);
            }
        };
    });

    async function keyboardToggleFlag() {
        const msg = keyboardActiveMessage();
        if (!msg) return;
        await toggleStar(msg);
    }

    onMount(() => {
        hydrateMessageFollowUp();
        hydrateMessagePinSnooze();
        hydrateMessageCategories();
        void loadAddressBook();
        followUpNow = Date.now();
        pinSnoozeNow = Date.now();
        const followUpTick = setInterval(() => { followUpNow = Date.now(); }, 60_000);
        const pinSnoozeTick = setInterval(() => {
            pinSnoozeNow = Date.now();
            tickPinSnoozeOverlay(pinSnoozeNow);
        }, 30_000);
        refreshMailboxes();
        // Coming back from a message keeps an all-folders result set as is.
        if (!(mobileState.searchScope === 'all' && mobileState.messages.length > 0)) refreshMessages();
        const interval = setInterval(refreshMailboxes, 60_000);
        window.addEventListener('webmail:client-rule', onRule);
        return () => {
            clearInterval(interval);
            clearInterval(followUpTick);
            clearInterval(pinSnoozeTick);
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
    <a
        href={`#${MAIL_MESSAGE_LIST_LANDMARK_ID}`}
        class="mobile-skip-link"
        data-testid="mobile-mail-skip-link"
        onclick={focusMessageListLandmark}
    >{MAIL_SKIP_LINK_TEXT}</a>
    <header class="mheader" role="banner" aria-label={MAIL_COMMAND_BAR_LABEL}>
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

    <div class="msearch-wrap">
        <div
            class="msearch-category-tabs"
            role="tablist"
            aria-label="Search category"
            data-testid="mobile-search-category-tabs"
        >
            {#each OWA_SEARCH_CATEGORIES as cat (cat.id)}
                <button
                    type="button"
                    role="tab"
                    class="msearch-category-tab"
                    class:active={mobileState.searchCategory === cat.id}
                    aria-selected={mobileState.searchCategory === cat.id}
                    onclick={() => setSearchCategory(cat.id)}
                    data-testid={`mobile-search-category-${cat.id}`}
                >{cat.label}</button>
            {/each}
        </div>
        {#if nlSearchResolving}
            <span class="msearch-nl-status muted small" data-testid="mobile-search-nl-pending">Translating…</span>
        {:else if lastNlSearchTranslation}
            <span
                class="msearch-nl-status muted small"
                data-testid="mobile-search-nl-hint"
                title="Translated to tag syntax"
            >
                as {lastNlSearchTranslation}
            </span>
        {/if}
        <div class="msearch">
            <input
                bind:this={searchInputEl}
                type="search"
                placeholder={mobileSearchPlaceholder}
                aria-label="Search mail"
                aria-expanded={showMobileSearchPanel}
                data-testid="mobile-search-input"
                value={searchInput}
                oninput={(e) => onSearch((e.currentTarget as HTMLInputElement).value)}
                onfocus={() => (searchPanelOpen = true)}
                onblur={(e) => {
                    const next = e.relatedTarget as Node | null;
                    if (next && e.currentTarget.closest('.msearch-wrap')?.contains(next)) return;
                    setTimeout(() => (searchPanelOpen = false), 150);
                }}
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
        {#if showMobileSearchPanel}
            <div
                class="msearch-panel scroll-y"
                role="group"
                aria-label="Saved searches"
                data-testid="mobile-search-suggest"
                onfocusout={(e) => {
                    const next = e.relatedTarget as Node | null;
                    if (!next || !e.currentTarget.closest('.msearch-wrap')?.contains(next)) {
                        searchPanelOpen = false;
                    }
                }}
            >
                {#if peopleSearchActive}
                    <div class="msearch-panel-hint">People</div>
                    {#if peopleSearchResults.length === 0}
                        <p class="msearch-people-empty muted small">No matching contacts — try a name or email.</p>
                    {:else}
                        {#each peopleSearchResults as contact (contact.address)}
                            <button
                                type="button"
                                class="msearch-people-chip"
                                onmousedown={(e) => e.preventDefault()}
                                onclick={() => composeToContact(contact.address)}
                                data-testid="mobile-search-people-result"
                            >
                                <Avatar email={contact.address} name={contact.name} size={28} />
                                <span class="msearch-people-text">
                                    <span class="msearch-people-name">{contact.name || contactNameFor(contact.address) || contact.address}</span>
                                    <span class="msearch-people-addr muted small">{contact.address}</span>
                                </span>
                            </button>
                        {/each}
                    {/if}
                {:else if savedMailSearches.items.length > 0}
                    <div class="msearch-panel-hint">Saved searches</div>
                    {#each savedMailSearches.items as saved (saved.id)}
                        <div class="msearch-saved-row">
                            <button
                                type="button"
                                class="msearch-saved-chip"
                                onmousedown={(e) => e.preventDefault()}
                                onclick={() => void applySavedMailSearch(saved)}
                                data-testid={`saved-search-${saved.id}`}
                            >
                                <span class="msearch-saved-name">{saved.name}</span>
                                <span class="msearch-saved-query">{saved.query}</span>
                                {#if saved.scope === 'all'}
                                    <span class="msearch-saved-scope">All folders</span>
                                {/if}
                            </button>
                            <button
                                type="button"
                                class="msearch-saved-remove"
                                title="Remove saved search"
                                aria-label={`Remove saved search ${saved.name}`}
                                onmousedown={(e) => e.preventDefault()}
                                onclick={() => deleteSavedMailSearch(saved.id)}
                                data-testid={`saved-search-remove-${saved.id}`}
                            >
                                <Icon name="close" size={14} />
                            </button>
                        </div>
                    {/each}
                {/if}
                {#if saveSearchFormOpen}
                    <div class="msearch-save-form" data-testid="search-save-form">
                        <label class="msearch-save-label" for="mobile-search-save-name">Name this search</label>
                        <input
                            id="mobile-search-save-name"
                            type="text"
                            class="msearch-save-input"
                            bind:value={saveSearchDraftName}
                            data-testid="search-save-name"
                        />
                        <div class="msearch-save-actions">
                            <button type="button" class="mbtn mbtn-secondary" onclick={confirmSaveCurrentSearch} data-testid="search-save-confirm">Save</button>
                            <button type="button" class="mbtn mbtn-ghost" onclick={cancelSaveSearchForm} data-testid="search-save-cancel">Cancel</button>
                        </div>
                    </div>
                {:else if canSaveCurrentSearch}
                    <button
                        type="button"
                        class="msearch-save-trigger"
                        onmousedown={(e) => e.preventDefault()}
                        onclick={startSaveCurrentSearch}
                        data-testid="search-save-trigger"
                    >
                        <Icon name="star" size={16} />
                        <span>Save this search</span>
                    </button>
                {/if}
            </div>
        {/if}
    </div>
    {#if globalScan}
        <div class="global-scan" aria-live="polite">
            <span class="muted small">Searching every folder · {globalScan.scanned} / {globalScan.total}</span>
            <span class="scan-bar" aria-hidden="true" style={`--pct: ${Math.min(100, Math.round((globalScan.scanned / Math.max(1, globalScan.total)) * 100))}%;`}></span>
        </div>
    {/if}

    {#if mobileState.searchCategory === 'files' && (mobileState.search || '').trim()}
        <div class="msearch-files-scope" data-testid="mobile-search-files-scope">Attachments only</div>
    {/if}

    {#if showInboxTabs}
        <nav class="inbox-tabs" aria-label="Inbox view" data-testid="inbox-tabs">
            <button
                type="button"
                class="inbox-tab"
                class:active={settings.inboxTab === 'focused'}
                aria-pressed={settings.inboxTab === 'focused'}
                onclick={() => setInboxTab('focused')}
                data-testid="inbox-tab-focused"
            >Focused</button>
            <button
                type="button"
                class="inbox-tab"
                class:active={settings.inboxTab === 'other'}
                aria-pressed={settings.inboxTab === 'other'}
                onclick={() => setInboxTab('other')}
                data-testid="inbox-tab-other"
            >Other</button>
        </nav>
    {/if}

    <MobileQuickFilterBar />

    <!-- The touch handlers drive pull-to-refresh / swipe gestures — pointer
         enhancements over a plain content list, not a widget. -->
    <div
        class="list scroll-y mobile-mail-landmark-list"
        role="region"
        tabindex="-1"
        id={MAIL_MESSAGE_LIST_LANDMARK_ID}
        aria-label={MAIL_MESSAGE_LIST_LABEL}
        data-testid="mobile-mail-landmark-message-list"
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
        {:else if !mobileState.messagesLoading && filtered.length === 0 && showInboxTabs && mobileState.messages.length > 0}
            <div class="mempty" data-testid="inbox-tab-empty">
                <Icon name="inbox" size={40} />
                <p>
                    {#if settings.inboxTab === 'other'}
                        Nothing in <strong>Other</strong> right now. Newsletters and bulk mail land here.
                    {:else}
                        Nothing in <strong>Focused</strong> right now.
                    {/if}
                </p>
                <button
                    type="button"
                    class="mbtn mbtn-secondary"
                    onclick={() => setInboxTab(settings.inboxTab === 'focused' ? 'other' : 'focused')}
                >
                    Switch to {settings.inboxTab === 'focused' ? 'Other' : 'Focused'}
                </button>
            </div>
        {:else if !mobileState.messagesLoading && mobileState.messages.length === 0}
            <div class="mempty">
                <Icon name="inbox" size={40} />
                <p>{mobileState.search ? 'No matches found.' : 'This folder is empty.'}</p>
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
                {@const dlevel = settings.listFilter === 'ai-sorted' ? dangerLevel(msg.uid) : 0}
                {@const followUpHint = rowFollowUpHint(msg.uid, isStarred)}
                {@const rowCategory = rowMessageCategory(msg)}
                {@const rowPinned = rowIsPinned(msg)}
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
                    <div
                        class="msg-row"
                        data-testid={`msg-row-${msg.uid}`}
                        data-category={rowCategory ?? ''}
                        data-follow-up={followUpHint ?? ''}
                        data-pinned={rowPinned ? 'true' : 'false'}
                        class:unread={isUnread}
                        class:pinned={rowPinned}
                        class:fresh={isFresh}
                        class:spy-tracked={isTracked}
                        class:danger-1={dlevel === 1}
                        class:danger-2={dlevel === 2}
                        class:danger-3={dlevel === 3}
                        class:danger-4={dlevel === 4}
                        class:selected={mobileState.selectedUid === msg.uid}
                        class:rule-running={ruleAnimUids.has(msg.uid)}
                        class:rule-popping={ruleDoneUids.has(msg.uid)}
                        class:keyboard-focus={mobileState.listKeyboardUid === msg.uid}
                    >
                        {#if rowCategory}
                            <span
                                class="category-stripe"
                                style={`background: ${MESSAGE_CATEGORY_BY_ID[rowCategory].color}`}
                                title={MESSAGE_CATEGORY_BY_ID[rowCategory].label}
                                aria-hidden="true"
                                data-testid={`msg-category-${msg.uid}`}
                            ></span>
                        {/if}
                        <Avatar {email} {name} size={40} />
                        <div class="msg-body">
                            <div class="msg-top">
                                <span class="msg-from truncate" class:bold={isUnread}>{sender}</span>
                                {#if followUpHint}
                                    <span class="follow-up-due" title={followUpHint} data-testid={`msg-follow-up-${msg.uid}`}>{followUpHint}</span>
                                {/if}
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
                        {#if rowPinned}
                            <span class="pin-mark" data-testid={`msg-pin-mark-${msg.uid}`} title="Pinned"><Icon name="pin" size={14} /></span>
                        {/if}
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
        onFollowUp={(preset) => applyFollowUpFlag(sheetMsg, preset)}
        onToggleRead={() => actionToggleRead(sheetMsg)}
        onArchive={() => archiveMessage(sheetMsg)}
        onTrash={() => trashMessage(sheetMsg)}
        onSnooze={(preset) => applySnooze(sheetMsg, preset)}
        onOpenSweepDialog={() => openMobileSenderSweepDialog(sheetMsg)}
        onCategory={(cat) => applyMessageCategory(sheetMsg, cat === 'clear' ? null : cat)}
        onTogglePin={() => togglePin(sheetMsg)}
        isPinned={rowIsPinned(sheetMsg)}
        currentCategory={rowMessageCategory(sheetMsg)}
    />
{/if}

{#if senderSweepDialogMessage}
    <SenderSweepDialog
        message={senderSweepDialogMessage}
        folderPath={rowPath(senderSweepDialogMessage)}
        busy={mobileSweepBusy}
        onClose={() => (senderSweepDialogMessage = null)}
        onRunOneTime={(action) => runMobileSenderSweep(senderSweepDialogMessage!, action, { skipConfirm: true })}
    />
{/if}

<style>
    .inbox-view {
        position: relative;
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }
    .mobile-skip-link {
        position: absolute;
        left: 8px;
        top: 8px;
        z-index: 100;
        padding: 8px 12px;
        border-radius: var(--radius-sm, 8px);
        background: var(--bg-elevated);
        color: var(--text-primary);
        border: 1px solid var(--border-strong);
        font-size: 13px;
        font-weight: 600;
        text-decoration: none;
        transform: translateY(-160%);
        transition: transform 0.15s ease;
    }
    .mobile-skip-link:focus {
        transform: translateY(0);
        outline: 2px solid var(--accent);
        outline-offset: 2px;
    }
    .mobile-mail-landmark-list:focus {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
    }
    .inbox-tabs {
        flex: 0 0 auto;
        display: flex;
        gap: 0;
        padding: 0 12px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-surface);
    }
    .inbox-tab {
        position: relative;
        padding: 10px 14px 8px;
        border: none;
        background: transparent;
        font: inherit;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-secondary);
        cursor: pointer;
        border-radius: 0;
    }
    .inbox-tab:active {
        background: color-mix(in srgb, var(--accent) 8%, transparent);
    }
    .inbox-tab.active {
        color: var(--accent-text);
    }
    .inbox-tab.active::after {
        content: '';
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: 0;
        height: 2px;
        border-radius: 2px 2px 0 0;
        background: var(--accent);
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
    /* Fresh: arrived in the last 10 minutes — sparkly halo so the user
       spots brand-new mail without scanning timestamps. */
    .msg-row.fresh {
        position: relative;
        background:
            radial-gradient(120% 220% at 0% 50%,
                color-mix(in srgb, var(--accent) 16%, transparent) 0%,
                transparent 55%),
            var(--bg-surface);
        animation: fresh-pulse-mobile 2.4s ease-in-out infinite;
    }
    .msg-row.fresh::after {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image:
            radial-gradient(circle at 14% 28%, color-mix(in srgb, var(--accent) 75%, white) 0 1.4px, transparent 2px),
            radial-gradient(circle at 30% 76%, color-mix(in srgb, var(--accent) 65%, white) 0 1.2px, transparent 2px),
            radial-gradient(circle at 76% 22%, color-mix(in srgb, #d268f4 65%, white) 0 1.2px, transparent 2px),
            radial-gradient(circle at 90% 66%, color-mix(in srgb, var(--accent) 75%, white) 0 1.4px, transparent 2px);
        opacity: 0.85;
        animation: fresh-twinkle-mobile 1.8s ease-in-out infinite;
    }
    @keyframes fresh-pulse-mobile {
        0%, 100% { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 70%, transparent); }
        50%      { box-shadow: inset 3px 0 0 var(--accent), 0 0 12px color-mix(in srgb, var(--accent) 22%, transparent); }
    }
    @keyframes fresh-twinkle-mobile {
        0%, 100% { opacity: 0.4; transform: scale(0.92); }
        50%      { opacity: 0.95; transform: scale(1.08); }
    }
    @media (prefers-reduced-motion: reduce) {
        .msg-row.fresh, .msg-row.fresh::after { animation: none; }
    }
    .msg-row {
        position: relative;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        background: var(--bg-surface);
        border-bottom: 0.5px solid var(--border-subtle);
        transition: background-color 80ms;
        min-height: 68px;
    }
    .msg-row.selected {
        background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface));
        box-shadow: inset 3px 0 0 var(--accent);
    }
    .category-stripe {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        pointer-events: none;
    }
    .msg-row.danger-4 { animation: danger-pulse-4 2.2s ease-in-out infinite; }
    .msg-row.danger-3 { animation: danger-pulse-3 2.6s ease-in-out infinite; }
    .msg-row.danger-2 { animation: danger-pulse-2 3s ease-in-out infinite; }
    .msg-row.danger-1 { animation: danger-pulse-1 3.4s ease-in-out infinite; }
    @keyframes danger-pulse-4 {
        0%, 100% { box-shadow: inset 3px 0 0 color-mix(in srgb, #ef4444 70%, transparent); }
        50%      { box-shadow: inset 3px 0 0 color-mix(in srgb, #ef4444 95%, transparent), 0 0 10px -2px color-mix(in srgb, #ef4444 22%, transparent); }
    }
    @keyframes danger-pulse-3 {
        0%, 100% { box-shadow: inset 3px 0 0 color-mix(in srgb, #f97316 60%, transparent); }
        50%      { box-shadow: inset 3px 0 0 color-mix(in srgb, #f97316 85%, transparent), 0 0 8px -2px color-mix(in srgb, #f97316 18%, transparent); }
    }
    @keyframes danger-pulse-2 {
        0%, 100% { box-shadow: inset 3px 0 0 color-mix(in srgb, #eab308 55%, transparent); }
        50%      { box-shadow: inset 3px 0 0 color-mix(in srgb, #eab308 80%, transparent), 0 0 6px -2px color-mix(in srgb, #eab308 15%, transparent); }
    }
    @keyframes danger-pulse-1 {
        0%, 100% { box-shadow: inset 3px 0 0 color-mix(in srgb, #22c55e 50%, transparent); }
        50%      { box-shadow: inset 3px 0 0 color-mix(in srgb, #22c55e 75%, transparent), 0 0 6px -2px color-mix(in srgb, #22c55e 12%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) {
        .msg-row.danger-1, .msg-row.danger-2, .msg-row.danger-3, .msg-row.danger-4 { animation: none; }
        .msg-row.danger-4 { box-shadow: inset 3px 0 0 color-mix(in srgb, #ef4444 80%, transparent); }
        .msg-row.danger-3 { box-shadow: inset 3px 0 0 color-mix(in srgb, #f97316 70%, transparent); }
        .msg-row.danger-2 { box-shadow: inset 3px 0 0 color-mix(in srgb, #eab308 65%, transparent); }
        .msg-row.danger-1 { box-shadow: inset 3px 0 0 color-mix(in srgb, #22c55e 60%, transparent); }
    }
    .msg-row.spy-tracked {
        animation: spy-pulse-glow 2.8s ease-in-out infinite;
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
        color: color-mix(in srgb, #10b981 75%, var(--text-secondary));
        font-weight: 600;
    }
    @keyframes spy-pulse-glow {
        0%, 100% {
            box-shadow: inset 3px 0 0 color-mix(in srgb, #10b981 55%, transparent);
        }
        50% {
            box-shadow:
                inset 3px 0 0 color-mix(in srgb, #10b981 90%, transparent),
                0 0 10px -2px color-mix(in srgb, #10b981 25%, transparent);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .msg-row.spy-tracked { animation: none; }
        .msg-row.spy-tracked {
            box-shadow: inset 3px 0 0 color-mix(in srgb, #10b981 70%, transparent);
        }
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
    .follow-up-due {
        font-size: 11px;
        font-weight: 500;
        color: var(--accent);
        flex-shrink: 0;
        max-width: 42%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
    .pin-mark {
        color: var(--accent, #0078d4);
        flex-shrink: 0;
    }
    .msg-row.pinned {
        background: color-mix(in srgb, var(--accent, #0078d4) 6%, transparent);
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

    /* Client-side rule animation: shimmer while running, pop-away on
     * completion. Mirrors the desktop treatment so the user sees the
     * same effect on either form factor. */
    .msg-row.rule-running {
        position: relative;
        background: linear-gradient(
            90deg,
            transparent 0%,
            color-mix(in srgb, var(--accent) 14%, transparent) 50%,
            transparent 100%);
        background-size: 200% 100%;
        animation: rule-shimmer 1.6s ease-in-out infinite;
    }
    .msg-row.rule-popping {
        animation: rule-pop 360ms cubic-bezier(0.4, 0.0, 1, 1) forwards;
        pointer-events: none;
    }
    .msg-row.keyboard-focus {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
        border-radius: 8px;
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
        .msg-row.rule-running { animation: none; }
        .msg-row.rule-popping { animation: none; opacity: 0.4; }
    }
</style>
