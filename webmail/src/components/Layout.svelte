<script lang="ts">
    import { onMount } from 'svelte';
    import { authState, setSession, logoutRemote, startExpiryWatch, switchTo, removeSession, setAddingAccount } from '../lib/auth.svelte';
    import { ui, showToast, clearToast } from '../lib/store.svelte';
    import { recordView } from '../lib/recent-views.svelte';
    import {
        listMailboxes,
        listMessages,
        getMessage,
        modifyFlags,
        deleteMessage,
        moveMessage,
        createMailbox,
        renameMailbox,
        deleteMailbox,
        getMailboxInfo,
        getLogins,
        apiUrl,
        ApiError,
        type MailboxInfo,
        type LoginEntry,
        type MessageListItem
    } from '../lib/api';
    import Icon from './Icon.svelte';
    import Sidebar from './Sidebar.svelte';
    import MessageList from './MessageList.svelte';
    import MessageDetail from './MessageDetail.svelte';
    import Compose from './Compose.svelte';
    import AiPanel from './AiPanel.svelte';
    import ThemeToggle from './ThemeToggle.svelte';
    import Settings from './Settings.svelte';
    import HelpDialog from './HelpDialog.svelte';
    import SetupGuide from './SetupGuide.svelte';
    import InboxSummary from './InboxSummary.svelte';
    import LatencyChip from './LatencyChip.svelte';
    import WeatherChip from './WeatherChip.svelte';
    import CalendarTicker from './CalendarTicker.svelte';
    import BulkProgress from './BulkProgress.svelte';
    import BackgroundTaskFloater from './BackgroundTaskFloater.svelte';
    import PwaUpdatePrompt from './PwaUpdatePrompt.svelte';
    import type { InboxMessageInput } from '../lib/inbox-summary';
    import ChatBot from './ChatBot.svelte';
    import CalendarApp from './calendar/CalendarApp.svelte';
    import EventModal from './calendar/EventModal.svelte';
    import AppSwitcher from './AppSwitcher.svelte';
    import ChatApp from './ai/ChatApp.svelte';
    import VoiceChat from './ai/VoiceChat.svelte';
    import DriveApp from './drive/DriveApp.svelte';
    import ShortcutPopup from './ShortcutPopup.svelte';
    import ShortcutEmbed from './ShortcutEmbed.svelte';
    import BulkBar from './BulkBar.svelte';
    import { getShortcuts, blockSender as apiBlockSender, type Shortcut } from '../lib/api';
    import { shortcutsItems, embeddedShortcut, popupShortcut } from '../lib/shortcuts-store';
    import { probeCapabilities, settings, setHideSidebar } from '../lib/settings.svelte';
    import { initImapSync, newThread as newAiThread, appendMessage as appendAiMessage, requestAutoSend as requestAutoSendAi } from '../lib/ai-threads.svelte';
    import { toggleSelected, clearSelection, selectAllVisible } from '../lib/store.svelte';
    import * as cache from '../lib/cache';
    import { startNetworkWatchdog, withTimeout } from '../lib/network-watchdog.svelte';
    import { playNotify, playSent, playClick, primeAudio, sounds, setMuted } from '../lib/sounds.svelte';
    import { pwa, promptInstall } from '../lib/pwa.svelte';
    import { recordEnvelope } from '../lib/address-book.svelte';
    import { ensureCountry, geoipCache, flagEmoji } from '../lib/geoip.svelte';
    import { myAvatars } from '../lib/avatars.svelte';
    import Avatar from './Avatar.svelte';
    import { sentStatusState, resumePolling, dismissSent, clearOldSent } from '../lib/sent-status.svelte';
    import { isVoiceAvailable, isSttAvailable } from '../lib/voice.svelte';
    import type { MessageDetail as MessageDetailType } from '../lib/api';

    // Page size resolves dynamically from settings.pageSize. 'unlimited'
    // sends a generous cap server-side rather than truly streaming all
    // of IMAP at once (the route's pageSize hard-cap is 1000).
    // Server caps pageSize at 100 per request. We honour the user's
    // chosen size up to the cap; larger choices (and 'unlimited') page
    // in batches of 100 — the message list auto-loads more as the user
    // scrolls toward the end.
    const SERVER_PAGE_CAP = 100;
    function pageSize(): number {
        const v = settings.pageSize;
        if (typeof v === 'number' && v > 0) return Math.min(v, SERVER_PAGE_CAP);
        if (v === 'unlimited') return SERVER_PAGE_CAP;
        return 25;
    }
    function targetTotal(): number {
        const v = settings.pageSize;
        if (v === 'unlimited') return Number.POSITIVE_INFINITY;
        if (typeof v === 'number' && v > 0) return v;
        return 25;
    }

    // Hard time budget for the FIRST paint of mailboxes / message list.
    // Past this we render whatever cache had and flip ui.online = false
    // — the watchdog re-probes every 30s and seamlessly upgrades back
    // when the network returns. Late-arriving fetches still update the
    // view, so a slow link recovers without forcing the user to refresh.
    const FIRST_LOAD_BUDGET_MS = 2000;

    // Mobile-PWA test, used to gate behaviour we only want on phones
    // (full-folder prefetch, sticky-session defaults).
    function isMobilePwa(): boolean {
        return typeof window !== 'undefined' && window.location.pathname.startsWith('/webmail/mobile/');
    }

    // Drain the rest of the visible folder into the cache so the mobile
    // PWA can browse offline. Pages are fetched 100 at a time with a
    // small inter-page delay so we don't hammer the server, capped so a
    // 100k-message folder doesn't burn the user's data plan.
    let prefetchInflight = false;
    async function prefetchFolderPages(path: string, search: string | undefined) {
        if (prefetchInflight) return;
        prefetchInflight = true;
        const HARD_CAP = 1000;       // never prefetch more than this many envelopes
        const PER_PAGE = SERVER_PAGE_CAP;
        const PAUSE_MS = 250;
        try {
            // We start from page 1 (page 0 is what the user just loaded).
            for (let page = 1; page * PER_PAGE < HARD_CAP; page++) {
                if (path !== ui.selectedPath) break; // user navigated away
                if (!ui.online) break;
                const r = await listMessages(path, { page, pageSize: PER_PAGE, search }).catch(() => null);
                if (!r) break;
                cache.putMessageList(currentUser(), path, page, search, r);
                if (r.messages.length < PER_PAGE) break; // we've drained the folder
                await new Promise((res) => setTimeout(res, PAUSE_MS));
            }
        } finally {
            prefetchInflight = false;
        }
    }
    let searchInput = $state('');
    let searchSuggestOpen = $state(false);
    let searchInputEl: HTMLInputElement | null = $state(null);

    // Available search tag tokens. Each one inserts as `key:` into the
    // input and re-focuses so the user can type the value next.
    const SEARCH_TAGS: { key: string; label: string; sample: string; group: 'header' | 'state' }[] = [
        { key: 'from',    label: 'From sender',          sample: 'from:alice@…',    group: 'header' },
        { key: 'to',      label: 'To recipient',         sample: 'to:bob@…',        group: 'header' },
        { key: 'cc',      label: 'CC recipient',         sample: 'cc:carol@…',      group: 'header' },
        { key: 'subject', label: 'Subject contains',     sample: 'subject:invoice', group: 'header' },
        { key: 'body',    label: 'Body contains',        sample: 'body:"two words"', group: 'header' },
        { key: 'has',     label: 'Has attachment',       sample: 'has:attachment',  group: 'state' },
        { key: 'is',      label: 'Read / unread / starred', sample: 'is:unread',     group: 'state' }
    ];

    // Suggestions filter on the partial token the cursor is currently in.
    // Empty input = show every tag. Typing "fr" narrows to from. Typing
    // "from:" hides the suggestion list (the user is now in value-typing
    // mode; re-shows when they hit space).
    let visibleTags = $derived.by(() => {
        const v = searchInput;
        const pos = searchInputEl?.selectionStart ?? v.length;
        // Find the token at the cursor.
        const before = v.slice(0, pos);
        const tail = before.match(/(\S*)$/);
        const partial = (tail ? tail[1] : '').toLowerCase();
        if (partial.includes(':')) return [];
        if (!partial) return SEARCH_TAGS;
        return SEARCH_TAGS.filter((t) => t.key.startsWith(partial));
    });

    function insertTag(key: string) {
        const v = searchInput;
        const pos = searchInputEl?.selectionStart ?? v.length;
        // Replace the trailing partial token at the cursor, or append at end.
        const before = v.slice(0, pos);
        const after = v.slice(pos);
        const m = before.match(/(.*?)(\S*)$/);
        const head = m ? m[1] : before;
        const next = `${head}${key}:`;
        searchInput = `${next}${after}`;
        // Re-focus the input + put the cursor right after the colon.
        queueMicrotask(() => {
            if (searchInputEl) {
                searchInputEl.focus();
                const cursor = next.length;
                searchInputEl.setSelectionRange(cursor, cursor);
            }
        });
        searchSuggestOpen = true;
        // Don't fire a search yet — the value half is still empty.
    }

    // Mailbox info (name, quota, etc.) is loaded once and used to drive
    // the top-right account chip in 'name' display mode.
    let mailboxInfo = $state<MailboxInfo | null>(null);

    // Last-login warning. We compare the two most-recent rows from the
    // SASL log; if the second-most-recent is from a different IP it's
    // worth flagging. The banner auto-hides 2 minutes after first paint
    // unless the user dismisses it sooner.
    let lastLoginWarning = $state<{ ip: string; service: string; time: string; flag: string } | null>(null);
    let lastLoginDismissed = $state(false);
    function dismissLastLoginWarning() { lastLoginDismissed = true; }

    // Tracks which sent-row is expanded to show its DSN diagnostic.
    let sentExpanded = $state<string | null>(null);
    let myAvatar = $derived((authState.activeUser ? myAvatars.map[authState.activeUser.toLowerCase()] : null) || null);

    // Server health ping. Round-trip /health every 15 s and surface the
    // latency in the topbar (with a radar pulse). Slow/offline states
    // colour the indicator amber/red.
    let serverPingMs = $state<number | null>(null);
    let serverPingState = $state<'live' | 'slow' | 'offline'>('live');
    async function pingServer() {
        const t0 = performance.now();
        try {
            const res = await fetch(apiUrl('/health'), { cache: 'no-store' });
            const dt = Math.round(performance.now() - t0);
            if (!res.ok) { serverPingState = 'offline'; serverPingMs = null; return; }
            serverPingMs = dt;
            serverPingState = dt > 800 ? 'slow' : 'live';
        } catch {
            serverPingState = 'offline';
            serverPingMs = null;
        }
    }
    let searchDebounce: ReturnType<typeof setTimeout> | null = null;
    let installDismissed = $state(loadInstallDismissed());
    let accountMenuOpen = $state(false);

    // Resizable panes. Each is persisted as a pixel width; the detail
    // pane absorbs whatever's left. Bounded so neither goes unusable.
    const PANE_KEYS = {
        sidebar: 'webmail.layout.sidebar-width',
        list: 'webmail.layout.list-width'
    };
    const SIDEBAR_MIN = 180;
    const SIDEBAR_MAX = 360;
    const LIST_MIN = 280;
    const LIST_MAX = 720;
    function loadWidth(key: string, def: number, lo: number, hi: number): number {
        try {
            const raw = localStorage.getItem(key);
            const n = raw ? parseInt(raw, 10) : 0;
            return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def;
        } catch { return def; }
    }
    let sidebarWidth = $state(loadWidth(PANE_KEYS.sidebar, 232, SIDEBAR_MIN, SIDEBAR_MAX));
    let listWidth = $state(loadWidth(PANE_KEYS.list, 380, LIST_MIN, LIST_MAX));
    $effect(() => { try { localStorage.setItem(PANE_KEYS.sidebar, String(sidebarWidth)); } catch { /* noop */ } });
    $effect(() => { try { localStorage.setItem(PANE_KEYS.list, String(listWidth)); } catch { /* noop */ } });

    let dragging = $state(false);
    function makeDragger(getCurrent: () => number, setCurrent: (n: number) => void, lo: number, hi: number) {
        return (e: PointerEvent) => {
            dragging = true;
            const startX = e.clientX;
            const startW = getCurrent();
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            const move = (ev: PointerEvent) => {
                const w = startW + (ev.clientX - startX);
                setCurrent(Math.min(hi, Math.max(lo, w)));
            };
            const up = (ev: PointerEvent) => {
                dragging = false;
                (e.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        };
    }
    const SIDEBAR_DEFAULT = 232;
    const LIST_DEFAULT = 380;

    // Keyboard handling shared by both splitters.
    //
    // Arrow keys were bound but the event kept its default, so the browser
    // scrolled the pane instead of (or as well as) resizing. Home/End had
    // no binding at all, and neither splitter reported a value — a
    // focusable separator defaults to aria-valuenow=50, which is why both
    // announced "50" regardless of where they actually sat.
    function splitterKeys(
        e: KeyboardEvent,
        get: () => number,
        set: (n: number) => void,
        min: number,
        max: number,
        dflt: number
    ) {
        const step = e.shiftKey ? 48 : 16;
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = get() - step;
        else if (e.key === 'ArrowRight') next = get() + step;
        else if (e.key === 'Home') next = min;
        else if (e.key === 'End') next = max;
        else if (e.key === 'Enter' || e.key === ' ') next = dflt;
        if (next === null) return;
        e.preventDefault();
        set(Math.max(min, Math.min(max, next)));
    }

    // Percentage of the splitter's own travel, so the announced value
    // describes this pane rather than an arbitrary constant.
    function splitterValue(current: number, min: number, max: number): number {
        if (max <= min) return 50;
        return Math.round(((current - min) / (max - min)) * 100);
    }

    const startSidebarDrag = makeDragger(() => sidebarWidth, (n) => (sidebarWidth = n), SIDEBAR_MIN, SIDEBAR_MAX);
    const startDrag = makeDragger(() => listWidth, (n) => (listWidth = n), LIST_MIN, LIST_MAX);

    // --- Mailbox CRUD (right-click in Sidebar) -------------------------
    async function createFolder(parent: string | null) {
        const fresh = prompt(parent ? `New subfolder under "${parent}":` : 'New folder name:');
        if (!fresh) return;
        const delim = ui.mailboxes[0]?.delimiter || '/';
        const path = parent ? `${parent}${delim}${fresh}` : fresh;
        await createMailbox(path);
        await refreshMailboxes();
        showToast('success', `Folder created: ${path}`);
    }
    async function renameFolder(oldPath: string, newPath: string) {
        await renameMailbox(oldPath, newPath);
        if (ui.selectedPath === oldPath) ui.selectedPath = newPath;
        await refreshMailboxes();
        showToast('success', `Renamed to ${newPath}`);
    }
    async function deleteFolder(path: string) {
        await deleteMailbox(path);
        if (ui.selectedPath === path) {
            ui.selectedPath = 'INBOX';
            await refreshMessages({ resetPage: true });
        }
        await refreshMailboxes();
        showToast('success', `Deleted ${path}`);
    }

    // "Not now" is remembered for a cooldown rather than forever, so the
    // offer can resurface eventually without the banner permanently
    // occupying a strip of an information-dense mail UI. The old boolean
    // value is honoured as a dismissal so upgrading doesn't re-nag.
    const INSTALL_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
    function loadInstallDismissed(): boolean {
        try {
            const raw = localStorage.getItem('webmail.install-banner-dismissed');
            if (!raw) return false;
            if (raw === '1') return true;
            const at = Number(raw);
            if (!Number.isFinite(at)) return false;
            return Date.now() - at < INSTALL_COOLDOWN_MS;
        } catch { return false; }
    }

    async function handleInstallClick() {
        const outcome = await promptInstall();
        if (outcome === 'accepted') {
            installDismissed = true;
        }
    }

    $effect(() => {
        if (installDismissed) {
            try { localStorage.setItem('webmail.install-banner-dismissed', String(Date.now())); } catch { /* noop */ }
        }
    });

    function currentUser(): string {
        return authState.activeUser || '';
    }

    async function refreshMailboxes() {
        // Stale-while-revalidate: render cached list instantly if present
        // (allow stale entries — folder structure rarely changes, so a
        // 30-day-old list is still better than blank), then refetch in
        // the background and replace.
        const cached = cache.getMailboxes(currentUser(), { allowStale: true });
        if (cached && cached.length) ui.mailboxes = cached;
        ui.mailboxesLoading = true;
        // The 2s race + offline flip is mobile-PWA-only. Desktop has a
        // stable connection profile and slow IMAP folders (5-10s for
        // big mailboxes) were noisily flagging the app "offline" even
        // when nothing was actually wrong.
        const isMobile = isMobilePwa();
        const fetchP = listMailboxes({ counts: true }).catch((err) => {
            if (err instanceof ApiError && err.status === 401) setSession(null);
            throw err;
        });
        const fresh = isMobile
            ? await withTimeout(fetchP, FIRST_LOAD_BUDGET_MS).catch(() => null)
            : await fetchP.catch(() => null);
        try {
            if (fresh) {
                ui.mailboxes = fresh;
                cache.putMailboxes(currentUser(), fresh);
            } else if (isMobile && (!cached || !cached.length)) {
                // Mobile only: no fresh, no cache → flip offline so the
                // PWA can show its offline UX. Desktop stays "online"
                // and just reports the underlying error normally.
                ui.online = false;
            }
        } finally {
            ui.mailboxesLoading = false;
        }
    }

    // Tracks the request shape currently rendered in `ui.messages`. Lets
    // refreshMessages tell "user just switched folders" from "user clicked
    // refresh on the same folder", which matters because we want to clear
    // the stale list on a folder switch when no cache is available — so the
    // glassy overlay covers blank space rather than the wrong folder's mail.
    let messagesShownFor: { user: string; path: string; page: number; search: string | undefined } | null = null;
    // Unread / starred / attachment filtering happens on the server.
    //
    // These used to be applied client-side, which meant the whole mailbox
    // had to be crawled into memory before the filter could mean anything:
    // hundreds of rows mounted, a bulk-selection count that climbed past
    // the page size, and a paginator describing a different data set than
    // the one on screen. IMAP can answer all three directly, so the filter
    // rides along with the search and pagination behaves normally.
    function filterToken(): string {
        switch (settings.listFilter) {
            case 'unread': return 'is:unread';
            case 'starred': return 'is:starred';
            case 'attachments': return 'has:attachment';
            default: return '';
        }
    }
    function effectiveSearch(): string | undefined {
        const parts = [ui.search || '', filterToken()].map((p) => p.trim()).filter(Boolean);
        return parts.length ? parts.join(' ') : undefined;
    }

    async function refreshMessages(opts: { resetPage?: boolean; force?: boolean } = {}) {
        if (opts.resetPage) ui.messagesPage = 0;
        const search = effectiveSearch();

        // Show cached list (allow stale on first paint — anything beats
        // blank when the user just opened the app on the train) right away.
        const user = currentUser();
        let cacheHit = false;
        if (!opts.force) {
            const cached = cache.getMessageListStale(user, ui.selectedPath, ui.messagesPage, search);
            if (cached) {
                ui.messages = cached.messages;
                ui.messagesTotal = cached.total;
                messagesShownFor = { user, path: ui.selectedPath, page: ui.messagesPage, search };
                cacheHit = true;
            }
        }
        // Folder switch with no cache → clear the stale list so the user
        // doesn't see the previous folder's mail under the loading overlay.
        const isSwitch = !messagesShownFor
            || messagesShownFor.user !== user
            || messagesShownFor.path !== ui.selectedPath
            || messagesShownFor.search !== search;
        if (!cacheHit && isSwitch) {
            ui.messages = [];
            ui.messagesTotal = 0;
        }

        ui.messagesLoading = true;
        ui.messagesError = null;
        // Snapshot the request shape so a late-arriving fetch can't
        // stomp the view if the user navigated between folders during
        // the 2s race.
        const reqPath = ui.selectedPath;
        const reqPage = ui.messagesPage;
        const reqUser = currentUser();
        // 2s budget on mobile PWA only — desktop has stable connectivity
        // so slow IMAP folders (5-10s for huge mailboxes) shouldn't
        // flag the app as "offline" or surface a scary error banner.
        const isMobile = isMobilePwa();
        // The network promise is *not* aborted; if it eventually returns
        // we still replace (in cache, and in the view if the user is
        // still on this folder), so offline → online recovery is seamless.
        const fetchP = listMessages(reqPath, { page: reqPage, pageSize: pageSize(), search });
        // Mobile races the 2s budget; desktop just awaits the real call.
        const r = isMobile
            ? await withTimeout(fetchP, FIRST_LOAD_BUDGET_MS).catch(() => null)
            : await fetchP.catch((err) => {
                if (err instanceof ApiError && err.status === 401) setSession(null);
                ui.messagesError = describe(err, 'Failed to load messages');
                return null;
            });
        if (isMobile) {
            // Late-arriving network response replaces the cached paint.
            fetchP.then((late) => {
                if (!late) return;
                cache.putMessageList(reqUser, reqPath, reqPage, search, late);
                if (!ui.online) ui.online = true;
                if (ui.selectedPath === reqPath && ui.messagesPage === reqPage && currentUser() === reqUser) {
                    ui.messages = late.messages;
                    ui.messagesTotal = late.total;
                    messagesShownFor = { user: reqUser, path: reqPath, page: reqPage, search };
                }
            }).catch(() => { /* offline; watchdog handles the flag */ });
        }
        try {
            if (r) {
                ui.messages = r.messages;
                ui.messagesTotal = r.total;
                messagesShownFor = { user, path: reqPath, page: reqPage, search };
                cache.putMessageList(currentUser(), ui.selectedPath, ui.messagesPage, search, r);
                for (const m of r.messages) {
                    recordEnvelope(m.envelope.from);
                    recordEnvelope(m.envelope.to);
                    recordEnvelope(m.envelope.cc);
                }
                if (!ui.online) ui.online = true;
                // Client-side rules pass: matches anything new against
                // the user's rules and pops the row away while the
                // action runs (move / archive / AI summarize-archive).
                // Best-effort — never throws back into the refresh.
                if (settings.clientRules.length > 0 && ui.selectedPath.toUpperCase() === 'INBOX') {
                    import('../lib/client-rules').then((mod) => {
                        return mod.runClientRules({
                            user: currentUser(),
                            path: ui.selectedPath,
                            messages: r.messages,
                            mailboxes: ui.mailboxes
                        });
                    }).catch(() => { /* swallow */ });
                }
                // On mobile, after the first page lands, drain the rest
                // of the folder in the background so the whole inbox is
                // available offline.
                if (isMobile && ui.messages.length < ui.messagesTotal) {
                    void prefetchFolderPages(ui.selectedPath, search);
                }
            } else if (isMobile) {
                // Mobile only — flip offline + show the cache-empty
                // banner. Desktop already populated messagesError above
                // with the actual underlying error (if any).
                if (ui.online) ui.online = false;
                if (ui.messages.length === 0) {
                    ui.messagesError = 'Offline — no cached messages for this folder yet.';
                }
            }
        } catch (err) {
            ui.messagesError = describe(err, 'Failed to load messages');
            if (err instanceof ApiError && err.status === 401) setSession(null);
        } finally {
            ui.messagesLoading = false;
        }
    }

    // Infinite-scroll loader. The server caps pageSize at 100, so when
    // the user picks a bigger size (or 'unlimited') we silently fetch
    // additional pages and append. MessageList calls this when it's
    // scrolled near the bottom — and the crawler below uses it to drain
    // the entire mailbox when a non-trivial filter is active.
    let appendingMore = $state(false);
    async function loadMoreMessages() {
        if (appendingMore || ui.messagesLoading) return;
        if (ui.messages.length >= ui.messagesTotal) return;
        if (ui.messages.length >= targetTotal()) return;
        const nextPage = Math.floor(ui.messages.length / SERVER_PAGE_CAP);
        const search = ui.search || undefined;
        appendingMore = true;
        try {
            const r = await listMessages(ui.selectedPath, {
                page: nextPage,
                pageSize: SERVER_PAGE_CAP,
                search
            });
            const seen = new Set(ui.messages.map((m) => m.uid));
            const fresh = r.messages.filter((m) => !seen.has(m.uid));
            ui.messages = [...ui.messages, ...fresh];
            ui.messagesTotal = r.total;
            for (const m of fresh) {
                recordEnvelope(m.envelope.from);
                recordEnvelope(m.envelope.to);
                recordEnvelope(m.envelope.cc);
            }
        } catch { /* fail silently for the auto-loader */ }
        finally { appendingMore = false; }
    }

    // ----- Background crawler ------------------------------------------------
    // For big mailboxes the user-visible filter (attachments / unread / starred
    // / search) only sees the first page worth of messages — anything beyond
    // page 1 simply isn't loaded yet, so the filter looks broken. The crawler
    // pages through the rest of the mailbox in the background, updating a
    // progress strip in the list header. Cancels on folder change.
    let scanState = $state<{ scanned: number; total: number; reason: string } | null>(null);
    let scanAbort: AbortController | null = null;

    function cancelScan() {
        if (scanAbort) {
            scanAbort.abort();
            scanAbort = null;
        }
        scanState = null;
    }

    async function scanAllPages(reason: string) {
        // Re-entrancy: cancel any in-flight scan first.
        cancelScan();
        const ctrl = new AbortController();
        scanAbort = ctrl;
        const search = ui.search || undefined;
        const path = ui.selectedPath;
        // Initial guess at total — gets refined after the first response.
        const total = Math.max(ui.messagesTotal || 0, ui.messages.length);
        scanState = { scanned: ui.messages.length, total, reason };
        try {
            while (!ctrl.signal.aborted) {
                if (ui.selectedPath !== path) break;
                if (ui.messages.length >= ui.messagesTotal) break;
                const nextPage = Math.floor(ui.messages.length / SERVER_PAGE_CAP);
                const r = await listMessages(path, {
                    page: nextPage,
                    pageSize: SERVER_PAGE_CAP,
                    search
                });
                if (ctrl.signal.aborted || ui.selectedPath !== path) break;
                const seen = new Set(ui.messages.map((m) => m.uid));
                const fresh = r.messages.filter((m) => !seen.has(m.uid));
                if (!fresh.length) break;
                ui.messages = [...ui.messages, ...fresh];
                ui.messagesTotal = r.total;
                for (const m of fresh) {
                    recordEnvelope(m.envelope.from);
                    recordEnvelope(m.envelope.to);
                    recordEnvelope(m.envelope.cc);
                }
                scanState = { scanned: ui.messages.length, total: r.total, reason };
            }
        } catch { /* silent — partial results are still useful */ }
        finally {
            if (scanAbort === ctrl) {
                scanAbort = null;
                scanState = null;
            }
        }
    }

    // A filter change alters the server query, so the list has to be
    // refetched and the page reset — otherwise page 5 of "all" becomes
    // page 5 of a much shorter unread list, which is usually empty.
    let lastFilterToken = filterToken();
    $effect(() => {
        const token = filterToken();
        if (token === lastFilterToken) return;
        lastFilterToken = token;
        ui.messagesPage = 0;
        void refreshMessages({ resetPage: true });
    });

    // Auto-trigger the crawler when a filter or search would otherwise hide
    // most of the mailbox. We only kick off if there *is* more to load —
    // otherwise the strip would flash on every filter toggle even on small
    // mailboxes.
    $effect(() => {
        const filter = settings.listFilter;
        const sizeMode = settings.pageSize;
        const search = ui.search;
        const path = ui.selectedPath;
        const scope = ui.searchScope;
        // Track these so the effect re-runs when they change.
        void filter; void sizeMode; void search; void path; void scope;
        // The all-folders search runs its own loop and owns the message list.
        if (scope === 'all') { cancelScan(); return; }
        // unread / starred / attachments are server-side filters now, so
        // they page like anything else and must not trigger a full crawl.
        const needsFullScan = sizeMode === 'unlimited';
        if (!needsFullScan) {
            cancelScan();
            return;
        }
        // Wait for the first page to land before crawling.
        if (ui.messagesLoading) return;
        if (ui.messages.length >= ui.messagesTotal) {
            cancelScan();
            return;
        }
        scanAllPages(filter !== 'all' ? filter : (search ? 'search' : 'load'));
    });

    async function selectMessage(uid: number) {
        ui.selectedUid = uid;
        ui.detail = null;
        ui.detailError = null;
        ui.aiSummary = null;
        ui.aiDraft = null;
        ui.aiActions = null;
        ui.aiTranslate = null;
        ui.aiSummaryError = null;
        ui.aiDraftError = null;
        ui.aiActionsError = null;
        ui.aiTranslateError = null;

        // In global-search mode the row carries its own folder; switch
        // selectedPath so the rest of the detail/cache/flag flow targets
        // the right mailbox. We *don't* clear ui.search — the user is
        // mid-investigation and may want to step back to the result list.
        const row = ui.messages.find((m) => m.uid === uid);
        if (ui.searchScope === 'all' && row?.mailbox && ui.selectedPath !== row.mailbox) {
            ui.selectedPath = row.mailbox;
        }

        // Short-circuit for the AI conversations folder — never render
        // the JSON body in the mail viewer (it shows blank). Match by
        // subject (we already have it in the row) and switch to the AI
        // app, no extra fetch needed.
        if (ui.selectedPath === '.AI Conversations' || ui.selectedPath === 'AI Conversations') {
            const row = ui.messages.find((m) => m.uid === uid);
            const wantTitle = (row?.envelope?.subject || '').trim();
            const ai = await import('../lib/ai-threads.svelte');
            const match = ai.aiState.threads.find((t) => t.title === wantTitle)
                ?? ai.aiState.threads.find((t) => t.title.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, '') === wantTitle);
            if (match) ai.selectThread(match.id);
            ui.app = 'ai';
            return;
        }

        // Render cached body instantly if we have it.
        const cachedBody = await cache.getMessageBody(currentUser(), ui.selectedPath, uid);
        if (cachedBody) {
            ui.detail = cachedBody;
        } else {
            ui.detailLoading = true;
        }

        try {
            const fresh = await getMessage(ui.selectedPath, uid);
            ui.detail = fresh;
            cache.putMessageBody(currentUser(), ui.selectedPath, uid, fresh);
            recordEnvelope(fresh.envelope.from);
            recordEnvelope(fresh.envelope.to);
            recordEnvelope(fresh.envelope.cc);
            recordView({
                kind: 'message',
                title: fresh.envelope.subject || '(no subject)',
                detail: fresh.envelope.from?.[0]?.address || undefined
            });
            if (fresh.flags && !fresh.flags.includes('\\Seen')) {
                try {
                    const r = await modifyFlags(ui.selectedPath, uid, { add: ['\\Seen'] });
                    fresh.flags = r.flags;
                    const li = ui.messages.find((m) => m.uid === uid);
                    if (li) li.flags = r.flags;
                    // The list cache is now stale — drop it so next switch refetches.
                    cache.invalidatePath(currentUser(), ui.selectedPath);
                } catch { /* non-fatal */ }
            }
        } catch (err) {
            if (!cachedBody) ui.detailError = describe(err, 'Failed to load message');
        } finally {
            ui.detailLoading = false;
        }
    }

    async function selectMailbox(path: string) {
        if (ui.selectedPath === path && ui.searchScope === 'folder') return;
        // Picking a folder always exits the all-folders aggregate view.
        if (ui.searchScope === 'all') {
            cancelGlobalSearch();
            ui.searchScope = 'folder';
        }
        ui.selectedPath = path;
        ui.selectedUid = null;
        ui.detail = null;
        ui.search = '';
        searchInput = '';
        recordView({ kind: 'folder', title: path });
        await refreshMessages({ resetPage: true });
    }

    async function logout() {
        // Fire-and-forget the server-side logout — server is stateless but
        // logs the call, and we don't want to block the UI on it.
        logoutRemote();
        const user = currentUser();
        if (user) cache.clearAllForUser(user).catch(() => {});
        // Drop just the active account; if other accounts are signed in, the
        // app stays mounted and switches to one of them.
        setSession(null);
        try { sessionStorage.setItem('webmail.logout.recent', String(Date.now())); } catch { /* noop */ }
        Object.assign(ui, {
            mailboxes: [],
            messages: [],
            selectedUid: null,
            detail: null,
            search: '',
            messagesPage: 0
        });
        // If another session remains, refresh into it; otherwise App.svelte
        // routes to the login screen.
        if (authState.activeUser) {
            refreshMailboxes();
            refreshMessages({ resetPage: true });
        }
    }

    async function switchAccount(user: string) {
        if (user === authState.activeUser) return;
        switchTo(user);
        accountMenuOpen = false;
        // Reset UI; cache is user-bucketed so stale-while-revalidate makes
        // the swap feel instant when both accounts have been visited recently.
        Object.assign(ui, {
            mailboxes: [],
            messages: [],
            selectedUid: null,
            detail: null,
            search: '',
            messagesPage: 0
        });
        await refreshMailboxes();
        await refreshMessages({ resetPage: true });
    }

    function addAnotherAccount() {
        accountMenuOpen = false;
        setAddingAccount(true);
    }

    async function signOutAccount(user: string) {
        const wasActive = user === authState.activeUser;
        cache.clearAllForUser(user).catch(() => {});
        removeSession(user);
        accountMenuOpen = false;
        if (wasActive && authState.activeUser) {
            Object.assign(ui, {
                mailboxes: [],
                messages: [],
                selectedUid: null,
                detail: null,
                search: '',
                messagesPage: 0
            });
            await refreshMailboxes();
            await refreshMessages({ resetPage: true });
        }
    }

    // The global field only ever searches mail — there is no calendar,
    // drive or chat index behind it. Rather than let the label imply
    // otherwise while sitting in another app, say "mail" explicitly and
    // switch to Mail as soon as a query is entered, so what the user is
    // told and what happens are the same thing.
    const searchLabel = $derived(
        ui.app === 'mail' ? 'Search mail' : 'Search mail (switches to Mail)'
    );
    const searchPlaceholder = $derived(
        ui.app === 'mail'
            ? 'Search — try from:alice or has:attachment…'
            : 'Search mail — from:alice, has:attachment…'
    );

    function onSearchChange(value: string) {
        searchInput = value;
        if (value.trim() && ui.app !== 'mail') ui.app = 'mail';
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            ui.search = searchInput.trim();
            // Typing a new query falls back to current-folder mode; the
            // user has to click "Search all folders" again deliberately
            // (lest a typo trigger a 20-folder crawl).
            if (ui.searchScope === 'all') {
                cancelGlobalSearch();
                ui.searchScope = 'folder';
            }
            refreshMessages({ resetPage: true });
        }, 300);
    }

    // ----- Global search (across every folder) ---------------------------
    let globalSearchAbort: AbortController | null = null;
    let globalScanState = $state<{ scanned: number; total: number; reason: string } | null>(null);

    function cancelGlobalSearch() {
        if (globalSearchAbort) {
            globalSearchAbort.abort();
            globalSearchAbort = null;
        }
        globalScanState = null;
    }

    async function searchAllFolders() {
        const q = (ui.search || '').trim();
        if (!q) return;
        cancelScan();          // pause the per-folder crawler
        cancelGlobalSearch();  // re-entrant safety
        ui.searchScope = 'all';
        const ctrl = new AbortController();
        globalSearchAbort = ctrl;

        // Pull every selectable mailbox; some servers expose \Noselect parents.
        const folders = (ui.mailboxes || [])
            .filter((m) => !m.flags?.some((f) => /\\Noselect/i.test(f)))
            .map((m) => m.path);
        if (!folders.length) {
            ui.searchScope = 'folder';
            globalSearchAbort = null;
            return;
        }

        const aggregated: MessageListItem[] = [];
        const seenKey = new Set<string>();
        ui.messages = [];
        ui.messagesTotal = 0;
        ui.messagesPage = 0;
        ui.messagesError = null;
        ui.messagesLoading = true;
        globalScanState = { scanned: 0, total: folders.length, reason: 'global-search' };

        try {
            for (let i = 0; i < folders.length; i++) {
                if (ctrl.signal.aborted) break;
                const path = folders[i];
                try {
                    // First page is enough to surface most hits without
                    // hammering. We can iterate further if the user clicks
                    // a "load more" later — but most users don't need
                    // 1000 hits per folder.
                    const r = await listMessages(path, {
                        page: 0,
                        pageSize: SERVER_PAGE_CAP,
                        search: q
                    });
                    if (ctrl.signal.aborted) break;
                    for (const msg of r.messages) {
                        const key = `${path}${msg.uid}`;
                        if (seenKey.has(key)) continue;
                        seenKey.add(key);
                        aggregated.push({ ...msg, mailbox: path });
                        recordEnvelope(msg.envelope.from);
                        recordEnvelope(msg.envelope.to);
                        recordEnvelope(msg.envelope.cc);
                    }
                    // Refresh the visible list as we go so the user sees
                    // hits trickle in rather than waiting for the whole sweep.
                    ui.messages = [...aggregated];
                    ui.messagesTotal = aggregated.length;
                } catch { /* per-folder errors are non-fatal */ }
                globalScanState = { scanned: i + 1, total: folders.length, reason: 'global-search' };
            }
        } finally {
            ui.messagesLoading = false;
            if (globalSearchAbort === ctrl) globalSearchAbort = null;
            // Leave scanState visible briefly so the user sees the final
            // count, then clear it.
            setTimeout(() => {
                if (!globalSearchAbort) globalScanState = null;
            }, 1500);
        }
    }

    function exitGlobalSearch() {
        cancelGlobalSearch();
        ui.searchScope = 'folder';
        refreshMessages({ resetPage: true });
    }

    async function toggleStar(uid: number) {
        const li = ui.messages.find((m) => m.uid === uid);
        if (!li) return;
        const isFlagged = li.flags.includes('\\Flagged');
        try {
            const r = await modifyFlags(ui.selectedPath, uid, isFlagged ? { remove: ['\\Flagged'] } : { add: ['\\Flagged'] });
            li.flags = r.flags;
            if (ui.detail && ui.detail.uid === uid) ui.detail.flags = r.flags;
        } catch (err) {
            showToast('error', describe(err, 'Failed to update star'));
        }
    }

    async function toggleUnread(uid: number) {
        const li = ui.messages.find((m) => m.uid === uid);
        if (!li) return;
        const seen = li.flags.includes('\\Seen');
        try {
            const r = await modifyFlags(ui.selectedPath, uid, seen ? { remove: ['\\Seen'] } : { add: ['\\Seen'] });
            li.flags = r.flags;
            if (ui.detail && ui.detail.uid === uid) ui.detail.flags = r.flags;
        } catch (err) {
            showToast('error', describe(err, 'Failed to update read state'));
        }
    }

    async function trashMessage(uid: number) {
        const trashBox = trashFolderName();
        const from = ui.selectedPath;
        try {
            const isHardDelete = from === trashBox;
            if (isHardDelete) await deleteMessage(from, uid);
            else await moveMessage(from, uid, trashBox);
            ui.messages = ui.messages.filter((m) => m.uid !== uid);
            ui.messagesTotal = Math.max(0, ui.messagesTotal - 1);
            if (ui.selectedUid === uid) {
                ui.selectedUid = null;
                ui.detail = null;
            }
            cache.invalidatePath(currentUser(), from);
            if (!isHardDelete) recordUndo('trash', uid, from, trashBox);
            showToast('success', isHardDelete ? 'Deleted' : 'Moved to Trash');
        } catch (err) {
            showToast('error', describe(err, 'Failed to delete'));
        }
    }

    async function moveTo(uid: number, destPath: string) {
        const from = ui.selectedPath;
        try {
            await moveMessage(from, uid, destPath);
            ui.messages = ui.messages.filter((m) => m.uid !== uid);
            ui.messagesTotal = Math.max(0, ui.messagesTotal - 1);
            if (ui.selectedUid === uid) {
                ui.selectedUid = null;
                ui.detail = null;
            }
            cache.invalidatePath(currentUser(), from);
            recordUndo('move', uid, from, destPath);
            showToast('success', `Moved to ${destPath}`);
        } catch (err) {
            showToast('error', describe(err, 'Failed to move'));
        }
    }

    function openCompose(replyTo?: MessageDetailType | null, mode: 'new' | 'reply' | 'replyAll' | 'forward' = replyTo ? 'reply' : 'new') {
        ui.composeOpen = true;
        ui.composeContext = { replyTo: replyTo || null, mode };
    }

    function archiveFolderName(): string {
        return ui.mailboxes.find((m) => m.specialUse === '\\Archive')?.path || 'Archive';
    }

    function trashFolderName(): string {
        return ui.mailboxes.find((m) => m.specialUse === '\\Trash')?.path || 'Trash';
    }

    function recordUndo(kind: 'trash' | 'archive' | 'move', uid: number, fromPath: string, toPath: string) {
        ui.undo = { kind, uid, fromPath, toPath, ts: Date.now() };
    }

    async function blockSenderForUid(uid: number) {
        const m = ui.messages.find((x) => x.uid === uid);
        const addr = m?.envelope?.from?.[0]?.address;
        if (!addr) {
            showToast('error', 'No sender address on this message');
            return;
        }
        if (!confirm(`Block all mail from ${addr}?`)) return;
        try {
            await apiBlockSender(addr);
            showToast('success', `Blocked ${addr}`);
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg || 'Could not block sender');
        }
    }

    async function archiveMessage(uid: number) {
        const dest = archiveFolderName();
        const from = ui.selectedPath;
        try {
            await moveMessage(from, uid, dest);
            ui.messages = ui.messages.filter((m) => m.uid !== uid);
            ui.messagesTotal = Math.max(0, ui.messagesTotal - 1);
            if (ui.selectedUid === uid) {
                ui.selectedUid = null;
                ui.detail = null;
            }
            cache.invalidatePath(currentUser(), from);
            recordUndo('archive', uid, from, dest);
            showToast('success', 'Archived');
        } catch (err) {
            showToast('error', describe(err, 'Failed to archive'));
        }
    }

    async function performUndo() {
        const u = ui.undo;
        if (!u) return;
        ui.undo = null;
        try {
            await moveMessage(u.toPath, u.uid, u.fromPath);
            cache.invalidatePath(currentUser(), u.fromPath);
            cache.invalidatePath(currentUser(), u.toPath);
            await refreshMessages({ force: true });
            showToast('success', 'Undone');
        } catch (err) {
            showToast('error', describe(err, 'Undo failed'));
        }
    }

    // Bulk actions

    async function bulkMark(seen: boolean) {
        const ids = [...ui.selected];
        if (!ids.length) return;
        for (const uid of ids) {
            try {
                const r = await modifyFlags(ui.selectedPath, uid, seen ? { add: ['\\Seen'] } : { remove: ['\\Seen'] });
                const li = ui.messages.find((m) => m.uid === uid);
                if (li) li.flags = r.flags;
            } catch { /* skip */ }
        }
        cache.invalidatePath(currentUser(), ui.selectedPath);
        clearSelection();
        showToast('success', `${seen ? 'Marked read' : 'Marked unread'}: ${ids.length}`);
    }

    async function bulkArchive() {
        const ids = [...ui.selected];
        if (!ids.length) return;
        const dest = archiveFolderName();
        const from = ui.selectedPath;
        for (const uid of ids) {
            try { await moveMessage(from, uid, dest); } catch { /* skip */ }
        }
        cache.invalidatePath(currentUser(), from);
        clearSelection();
        await refreshMessages({ force: true });
        showToast('success', `Archived ${ids.length}`);
    }

    async function bulkTrash() {
        const ids = [...ui.selected];
        if (!ids.length) return;
        const dest = trashFolderName();
        const from = ui.selectedPath;
        for (const uid of ids) {
            try {
                if (from === dest) await deleteMessage(from, uid);
                else await moveMessage(from, uid, dest);
            } catch { /* skip */ }
        }
        cache.invalidatePath(currentUser(), from);
        clearSelection();
        await refreshMessages({ force: true });
        showToast('success', `Moved to Trash: ${ids.length}`);
    }

    // Inbox briefing — opens the AI summary modal AND marks every visible
    // message as read in the background. The user wanted these two actions
    // bundled into one button so they get the briefing without leaving a
    // pile of unreads behind.
    let inboxSummaryOpen = $state(false);
    let inboxSummarySnapshot = $state<InboxMessageInput[]>([]);
    let voiceModeOpen = $state(false);

    // Window the brief by "since the user last clicked Brief me" so
    // each press shows only what's actually new — without losing
    // already-read emails the user may have skimmed but not actioned.
    const BRIEF_TS_KEY = 'webmail.briefme.lastTs.v1';
    function readBriefTs(path: string): number {
        try {
            const raw = localStorage.getItem(BRIEF_TS_KEY);
            if (!raw) return 0;
            const map = JSON.parse(raw);
            const v = map?.[path];
            return typeof v === 'number' ? v : 0;
        } catch { return 0; }
    }
    function writeBriefTs(path: string, ts: number) {
        try {
            const raw = localStorage.getItem(BRIEF_TS_KEY);
            const map = raw ? JSON.parse(raw) : {};
            map[path] = ts;
            localStorage.setItem(BRIEF_TS_KEY, JSON.stringify(map));
        } catch { /* quota */ }
    }

    async function summariseAndMarkRead() {
        // Window: only include messages newer than the last time the
        // user pressed Brief me on this folder. Include both read AND
        // unread so emails the user opened-but-didn't-action still
        // make the briefing.
        const lastTs = readBriefTs(ui.selectedPath);
        const allVisible = ui.messages.map((m) => {
            const dStr = m.internalDate || m.envelope.date;
            const dMs = dStr ? Date.parse(dStr) : 0;
            return {
                uid: m.uid,
                subject: m.envelope.subject || '',
                from: m.envelope.from?.[0]?.address
                    ? (m.envelope.from[0].name
                        ? `${m.envelope.from[0].name} <${m.envelope.from[0].address}>`
                        : m.envelope.from[0].address)
                    : '',
                date: dStr || null,
                ts: dMs,
                unread: !m.flags.includes('\\Seen'),
                flagged: m.flags.includes('\\Flagged'),
                // List response carries an envelope only — we don't have a body
                // snippet without a fan-out detail fetch. Subject + sender carry
                // most of the signal at triage time.
                snippet: ''
            };
        });
        const windowed = lastTs > 0
            ? allVisible.filter((m) => m.ts === 0 || m.ts >= lastTs)
            : allVisible;
        // Strip the helper `ts` field — the InboxSummary component
        // doesn't know about it.
        inboxSummarySnapshot = windowed.map(({ ts: _ts, ...rest }) => rest);
        // Save the click moment so the next brief windows from here.
        writeBriefTs(ui.selectedPath, Date.now());
        inboxSummaryOpen = true;
        // Don't await — let the modal render immediately while the IMAP
        // flag updates trickle through.
        markFolderRead().catch(() => {});
    }

    async function markFolderRead() {
        const path = ui.selectedPath;
        const unreadIds = ui.messages.filter((m) => !m.flags.includes('\\Seen')).map((m) => m.uid);
        if (!unreadIds.length) {
            showToast('info', 'No unread messages here');
            return;
        }
        for (const uid of unreadIds) {
            try {
                const r = await modifyFlags(path, uid, { add: ['\\Seen'] });
                const li = ui.messages.find((m) => m.uid === uid);
                if (li) li.flags = r.flags;
            } catch { /* skip */ }
        }
        cache.invalidatePath(currentUser(), path);
        cache.invalidateMailboxes(currentUser());
        showToast('success', `${unreadIds.length} marked read`);
        refreshMailboxes();
    }

    function describe(err: unknown, fallback: string): string {
        if (err instanceof ApiError) return err.detail || err.title || fallback;
        if (err instanceof Error) return err.message || fallback;
        return fallback;
    }

    function onKey(e: KeyboardEvent) {
        // Ignore when typing in inputs.
        const target = e.target as HTMLElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            if (e.key === 'Escape') {
                if (ui.composeOpen) ui.composeOpen = false;
                if (ui.aiPanelOpen) ui.aiPanelOpen = false;
            }
            return;
        }
        // Esc, ArrowUp/Down and `?` (help) are always live; the rest of the
        // single-key shortcuts (j/k/r/a/c/s/u/#/e/f/x/z/etc.) are off by
        // default and gated on settings.keyboardShortcuts to avoid trapping
        // people who just want to type in a search field that lost focus.
        const alwaysLive = e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === '?' || e.key === '/';
        if (!alwaysLive && !settings.keyboardShortcuts) return;
        const idx = ui.messages.findIndex((m) => m.uid === ui.selectedUid);
        if (e.key === 'j' || e.key === 'ArrowDown') {
            const next = ui.messages[Math.min(ui.messages.length - 1, idx < 0 ? 0 : idx + 1)];
            if (next) { playClick(); selectMessage(next.uid); }
            e.preventDefault();
        } else if (e.key === 'k' || e.key === 'ArrowUp') {
            const prev = ui.messages[Math.max(0, idx < 0 ? 0 : idx - 1)];
            if (prev) { playClick(); selectMessage(prev.uid); }
            e.preventDefault();
        } else if (e.key === 'Escape') {
            if (ui.composeOpen) ui.composeOpen = false;
            else if (ui.helpOpen) ui.helpOpen = false;
            else if (ui.settingsOpen) ui.settingsOpen = false;
            else if (ui.aiPanelOpen) ui.aiPanelOpen = false;
            else if (ui.selected.size > 0) clearSelection();
            else {
                ui.selectedUid = null;
                ui.detail = null;
            }
        } else if (e.key === 's' && ui.selectedUid != null) {
            toggleStar(ui.selectedUid);
        } else if (e.key === 'u' && ui.selectedUid != null) {
            toggleUnread(ui.selectedUid);
        } else if (e.key === '#' && ui.selectedUid != null) {
            trashMessage(ui.selectedUid);
        } else if (e.key === 'e' && ui.selectedUid != null) {
            archiveMessage(ui.selectedUid);
        } else if (e.key === 'r' && ui.detail) {
            openCompose(ui.detail, 'reply');
        } else if (e.key === 'a' && ui.detail) {
            openCompose(ui.detail, 'replyAll');
        } else if (e.key === 'f' && ui.detail) {
            openCompose(ui.detail, 'forward');
        } else if (e.key === 'x' && ui.selectedUid != null) {
            toggleSelected(ui.selectedUid);
        } else if (e.key === 'c') {
            openCompose();
        } else if (e.key === '/') {
            const el = document.querySelector<HTMLInputElement>('input[data-testid="search-input"]');
            if (el) {
                el.focus();
                e.preventDefault();
            }
        } else if (e.key === '?') {
            ui.helpOpen = true;
            e.preventDefault();
        } else if ((e.key === 'z' || e.key === 'Z') && ui.undo) {
            performUndo();
            e.preventDefault();
        }
    }

    // Track per-folder unread counts so we can detect new mail and chime.
    let lastUnseenByPath: Record<string, number> = {};

    function checkNewMailAndChime() {
        let bumped = false;
        for (const mb of ui.mailboxes) {
            if (mb.path !== 'INBOX' && mb.specialUse !== '\\Inbox') continue;
            const cur = typeof mb.unseen === 'number' ? mb.unseen : 0;
            const prev = lastUnseenByPath[mb.path];
            if (prev !== undefined && cur > prev) bumped = true;
            lastUnseenByPath[mb.path] = cur;
        }
        if (bumped) playNotify();
    }

    async function loadShortcuts() {
        try {
            const r = await getShortcuts();
            shortcutsItems.set(r.shortcuts || []);
        } catch { /* silent — non-fatal */ }
    }

    function handleShortcut(sc: Shortcut) {
        if (sc.mode === 'link') {
            window.open(sc.url, '_blank', 'noopener,noreferrer');
        } else if (sc.mode === 'popup') {
            popupShortcut.set(sc);
        } else if (sc.mode === 'embed') {
            embeddedShortcut.set(sc);
        }
    }

    async function loadMailboxInfo() {
        try {
            const m = await getMailboxInfo();
            mailboxInfo = m;
        } catch { /* mailcow DB optional — silent fallback */ }
    }

    // RFC1918 + loopback + link-local + IPv6 ULA/loopback. A non-WAN address
    // means the request reached imap-rest from inside the LAN/container —
    // useless info to scare the user with, so we skip the banner entirely.
    const PRIVATE_IP_RE = /^(10\.|192\.168\.|169\.254\.|127\.|172\.(1[6-9]|2\d|3[0-1])\.|fe80:|fc00:|fd[0-9a-f]{2}:|::1$)/i;
    function isPrivate(ip: string | null | undefined): boolean {
        return !!ip && PRIVATE_IP_RE.test(ip);
    }

    async function checkLastLogin() {
        try {
            const r = await getLogins(5);
            const list = r.logins || [];
            // [0] is the freshest = the current session. [1] is the previous.
            const cur = list[0];
            const prev = list[1];
            if (!prev) return;
            const curIp = (cur?.ip || cur?.real_rip || '') as string;
            const prevIp = (prev?.ip || prev?.real_rip || '') as string;
            if (!prevIp || prevIp === curIp) return;
            // Skip the banner for LAN/container IPs — they're not a security
            // signal, just noise from the reverse proxy or local network.
            if (isPrivate(prevIp)) return;
            // Pull country flag if we can
            ensureCountry(prevIp);
            const code = prevIp in geoipCache.codes ? geoipCache.codes[prevIp] : null;
            lastLoginWarning = {
                ip: prevIp,
                service: (prev.service || '?') as string,
                time: (prev.time || prev.datetime || '') as string,
                flag: flagEmoji(code) || ''
            };
            // Auto-hide after 2 minutes of being signed in.
            setTimeout(() => { lastLoginDismissed = true; }, 2 * 60 * 1000);
        } catch { /* mailcow DB unavailable — skip */ }
    }

    onMount(() => {
        // Network watchdog: probes /health within 2s on app open, retries
        // every 30s while we believe we're offline. ui.online is the
        // single source of truth for the offline banner + cached-mode UI.
        // On reconnect, force-refresh the visible folder so the user
        // sees fresh state right away (the periodic poll would catch up
        // within 60s anyway, but instant feels much nicer). Mobile-PWA
        // only — desktop's network is stable and the probe was just
        // surfacing false alarms.
        const stopWatchdog = isMobilePwa() ? startNetworkWatchdog({
            onReconnect: () => {
                refreshMailboxes().catch(() => { /* noop */ });
                refreshMessages({ force: true }).catch(() => { /* noop */ });
            }
        }) : (() => { /* desktop: no watchdog */ });
        refreshMailboxes();
        refreshMessages();
        probeCapabilities();
        initImapSync();
        // Settings & trusted-senders sync via the hidden IMAP folder.
        // Best-effort: never blocks the UI on failure.
        import('../lib/settings-sync').then((m) => m.startSync()).catch(() => { /* offline / unsupported */ });
        // Skip the probe while the tab is hidden or the browser knows it's
        // offline. It used to run unconditionally forever, so a backgrounded
        // or disconnected tab generated a failed /v1/ai/config every 30s —
        // which is most of the "Failed to fetch" noise in the error log, and
        // enough consecutive failures to trip the maintenance overlay on a
        // user who had simply lost wifi.
        const capTimer = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return;
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
            void probeCapabilities();
        }, 30_000);
        loadShortcuts();
        loadMailboxInfo();
        checkLastLogin();
        // Resume in-flight delivery polls from the previous session and
        // garbage-collect anything past the 24h window.
        clearOldSent();
        resumePolling();
        pingServer();
        const pingTimer = setInterval(pingServer, 15_000);
        const handler = (e: KeyboardEvent) => onKey(e);
        document.addEventListener('keydown', handler);
        // Outside-click closes account menu.
        const onDocClick = (e: MouseEvent) => {
            if (!accountMenuOpen) return;
            const target = e.target as HTMLElement;
            if (!target.closest('.user-wrap')) accountMenuOpen = false;
        };
        document.addEventListener('click', onDocClick);

        // Audio context can't start without a user gesture. Wire one-time
        // primer so the first click anywhere unlocks the AudioContext.
        const prime = () => { primeAudio(); window.removeEventListener('pointerdown', prime); };
        window.addEventListener('pointerdown', prime, { once: true });

        // Foreground new-mail polling (every 60s). Refreshes mailbox
        // unread counts AND the visible message list, then chimes if
        // INBOX gained messages. Skipped while the tab is hidden so we
        // don't waste IMAP calls on a backgrounded session.
        const pollInterval = setInterval(async () => {
            if (document.hidden) return;
            await refreshMailboxes();
            // Refresh the list view too — without this, the user sat
            // on the inbox and never saw new mail land. force=true
            // bypasses the 30s server-side cache so a freshly arrived
            // message is visible within one poll cycle.
            try { await refreshMessages({ force: true }); } catch { /* */ }
            checkNewMailAndChime();
        }, 60_000);

        // Service Worker push events relayed to the page (via postMessage).
        // We refresh BOTH the mailbox list (for the unread-count bump in
        // the sidebar) AND the visible message list (so the new mail
        // shows up at the top without waiting for the 60s poll). The
        // refreshMessages call also writes through to the offline cache
        // so the new mail is browseable when the user later goes
        // offline — required for the "fix cache when we get a
        // notification" promise.
        let onSwMsg: ((e: MessageEvent) => void) | null = null;
        if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
            onSwMsg = (e: MessageEvent) => {
                if (e.data && e.data.type === 'webmail-new-mail') {
                    playNotify();
                    refreshMailboxes();
                    void refreshMessages({ force: true });
                }
            };
            navigator.serviceWorker.addEventListener('message', onSwMsg);
        }

        const stopExpiryWatch = startExpiryWatch();
        return () => {
            document.removeEventListener('keydown', handler);
            document.removeEventListener('click', onDocClick);
            clearInterval(pollInterval);
            clearInterval(pingTimer);
            clearInterval(capTimer);
            if (onSwMsg) navigator.serviceWorker.removeEventListener('message', onSwMsg);
            window.removeEventListener('pointerdown', prime);
            stopWatchdog();
            stopExpiryWatch();
        };
    });

    // Auto-clear toast after 4s
    $effect(() => {
        if (!ui.toast) return;
        const t = setTimeout(clearToast, 4000);
        return () => clearTimeout(t);
    });

    // Live document title — shows unread count when away from inbox so
    // standalone-PWA window titles + browser tabs surface new mail.
    $effect(() => {
        const inbox = ui.mailboxes.find((m) => m.path === 'INBOX' || m.specialUse === '\\Inbox');
        const n = inbox?.unseen ?? 0;
        const surface = ui.app === 'calendar' ? 'Calendar' : ui.app === 'ai' ? 'AI' : ui.app === 'drive' ? 'Drive' : 'Inbox';
        document.title = n > 0 ? `(${n}) ${surface} · Webmail` : `${surface} · Webmail`;
    });
</script>

<div class="shell" data-density={settings.density} data-testid="shell">
    <header class="topbar">
        <button
            type="button"
            class="btn btn-ghost sidebar-toggle"
            title={settings.hideSidebar ? 'Show sidebar' : 'Hide sidebar'}
            aria-label={settings.hideSidebar ? 'Show sidebar' : 'Hide sidebar'}
            aria-pressed={settings.hideSidebar}
            onclick={() => setHideSidebar(!settings.hideSidebar)}
            data-testid="sidebar-toggle"
        >
            <Icon name={settings.hideSidebar ? 'panelLeftOpen' : 'panelLeftClose'} size={16} />
        </button>
        <div class="brand">
            <div class="logo" aria-hidden="true">
                <Icon name="mail" size={18} />
            </div>
            <span class="brand-name">
                <span class="brand-mark">Mail</span><span class="brand-sub">imap-rest</span>
            </span>
        </div>
        <div class="search-wrap">
            <Icon name="search" size={16} />
            <input
                type="search"
                placeholder={searchPlaceholder}
                value={searchInput}
                bind:this={searchInputEl}
                oninput={(e) => { onSearchChange((e.currentTarget as HTMLInputElement).value); searchSuggestOpen = true; }}
                onfocus={() => (searchSuggestOpen = true)}
                onblur={() => setTimeout(() => (searchSuggestOpen = false), 150)}
                aria-label={searchLabel}
                data-testid="search-input"
            />
            {#if (ui.search || '').trim()}
                {#if ui.searchScope === 'all'}
                    <button
                        type="button"
                        class="search-scope-btn active"
                        title="Currently searching every folder. Click to scope back to this folder."
                        onclick={exitGlobalSearch}
                        data-testid="search-scope-folder"
                    >
                        <Icon name="close" size={12} />
                        <span>All folders</span>
                    </button>
                {:else}
                    <button
                        type="button"
                        class="search-scope-btn"
                        title="Search every folder for this query"
                        onclick={searchAllFolders}
                        data-testid="search-scope-all"
                    >
                        <Icon name="folder" size={12} />
                        <span>Search all folders</span>
                    </button>
                {/if}
            {/if}
            {#if searchSuggestOpen && visibleTags.length > 0}
                <div class="search-suggest" role="listbox" data-testid="search-suggest">
                    <div class="search-suggest-hint">Filter with tags:</div>
                    {#each visibleTags as tag (tag.key)}
                        <button
                            type="button"
                            class="search-suggest-chip"
                            onmousedown={(e) => { e.preventDefault(); insertTag(tag.key); }}
                            data-testid={`search-tag-${tag.key}`}
                        >
                            <span class="search-suggest-key">{tag.key}:</span>
                            <span class="search-suggest-label">{tag.label}</span>
                            <span class="search-suggest-sample">{tag.sample}</span>
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
        <div class="header-actions">
            {#if serverPingState === 'offline'}
                <span class="server-ping ping-offline" title="API server unreachable" data-testid="server-ping" aria-label="API offline">
                    <span class="ping-dot"></span>
                    <span class="ping-radar"></span>
                    <span class="ping-label">offline</span>
                </span>
            {:else}
                <LatencyChip />
            {/if}
            {#if settings.weatherChip}
                <WeatherChip
                    latitude={settings.weatherLatitude}
                    longitude={settings.weatherLongitude}
                    units={settings.weatherUnits}
                />
            {/if}
            {#if settings.calendarTicker}
                <CalendarTicker />
            {/if}
            <button
                type="button"
                class="btn btn-ghost"
                title="Refresh"
                aria-label="Refresh"
                onclick={() => refreshMessages()}
                data-testid="refresh-btn"
            >
                <Icon name="refresh" size={16} />
            </button>
            <ThemeToggle />
            <!-- One-click sounds mute. Mirrors the master toggle in
                 Settings → Sounds, but lives in the top bar so it's
                 always reachable mid-flow. -->
            <button
                type="button"
                class="btn btn-ghost"
                title={sounds.muted ? 'Sounds muted — click to unmute' : 'Sounds on — click to mute everything'}
                aria-label={sounds.muted ? 'Unmute sounds' : 'Mute sounds'}
                aria-pressed={sounds.muted}
                onclick={() => setMuted(!sounds.muted)}
                data-testid="sound-mute-btn"
            >
                <Icon name={sounds.muted ? 'volumeOff' : 'volume'} size={16} />
            </button>
            <button
                type="button"
                class="btn btn-ghost"
                title="Settings"
                aria-label="Settings"
                onclick={() => (ui.settingsOpen = true)}
                data-testid="settings-btn"
            >
                <Icon name="settings" size={16} />
            </button>
            <div class="user-wrap">
                <button
                    type="button"
                    class="user"
                    aria-haspopup="menu"
                    aria-expanded={accountMenuOpen}
                    onclick={() => (accountMenuOpen = !accountMenuOpen)}
                    data-testid="account-btn"
                >
                    {#if myAvatar}
                        <Avatar email={authState.activeUser ?? null} name={mailboxInfo?.name ?? null} size={26} />
                    {:else}
                        <span class="user-mark" aria-hidden="true">
                            {#if settings.accountChipDisplay === 'name'}
                                <Icon name="user" size={13} />
                            {:else}
                                <Icon name="at" size={13} />
                            {/if}
                        </span>
                    {/if}
                    <span class="user-email truncate">
                        {#if settings.accountChipDisplay === 'name' && (mailboxInfo?.name || '').trim()}
                            {mailboxInfo!.name}
                        {:else}
                            {authState.activeUser || ''}
                        {/if}
                    </span>
                    {#if authState.sessions.length > 1}
                        <span class="account-count" aria-label={`${authState.sessions.length} accounts`}>
                            {authState.sessions.length}
                        </span>
                    {/if}
                    <svg class="caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                {#if accountMenuOpen}
                    <ul class="account-menu" role="menu" data-testid="account-menu">
                        {#each authState.sessions as s (s.user)}
                            <li class="account-row" role="presentation">
                                <button
                                    type="button"
                                    role="menuitem"
                                    class="account-pick"
                                    class:active={s.user === authState.activeUser}
                                    onclick={() => switchAccount(s.user)}
                                    data-testid={`switch-${s.user}`}
                                >
                                    <span class="account-mark" aria-hidden="true">{s.user[0].toUpperCase()}</span>
                                    <span class="account-info">
                                        <span class="account-email">{s.user}</span>
                                        {#if s.user === authState.activeUser}
                                            <span class="account-sub muted">Active</span>
                                        {:else}
                                            <span class="account-sub muted">Click to switch</span>
                                        {/if}
                                    </span>
                                    {#if s.user === authState.activeUser}
                                        <span class="active-dot" aria-hidden="true"></span>
                                    {/if}
                                </button>
                                <button
                                    type="button"
                                    class="account-signout"
                                    title={`Sign out of ${s.user}`}
                                    aria-label={`Sign out of ${s.user}`}
                                    onclick={() => signOutAccount(s.user)}
                                    data-testid={`signout-${s.user}`}
                                >
                                    <Icon name="logout" size={13} />
                                </button>
                            </li>
                        {/each}
                        <li role="separator" aria-orientation="horizontal" class="account-sep"></li>
                        <li>
                            <button
                                type="button"
                                role="menuitem"
                                onclick={addAnotherAccount}
                                data-testid="account-menu-add"
                            >
                                <Icon name="plus" size={14} /> Add another account
                            </button>
                        </li>
                        <li role="separator" aria-orientation="horizontal" class="account-sep"></li>
                        <li>
                            <button
                                type="button"
                                role="menuitem"
                                onclick={() => { accountMenuOpen = false; ui.settingsOpen = true; }}
                                data-testid="account-menu-settings"
                            >
                                <Icon name="settings" size={14} /> Settings
                            </button>
                        </li>
                        <li>
                            <button
                                type="button"
                                role="menuitem"
                                onclick={() => { accountMenuOpen = false; ui.setupOpen = true; }}
                                data-testid="account-menu-setup"
                            >
                                <Icon name="download" size={14} /> Connect a device
                            </button>
                        </li>
                        <li>
                            <button
                                type="button"
                                role="menuitem"
                                onclick={() => { accountMenuOpen = false; ui.helpOpen = true; }}
                            >
                                <Icon name="info" size={14} /> Keyboard shortcuts
                            </button>
                        </li>
                        <li role="separator" aria-orientation="horizontal" class="account-sep"></li>
                        <li>
                            <button
                                type="button"
                                role="menuitem"
                                onclick={() => { accountMenuOpen = false; logout(); }}
                                data-testid="logout-btn"
                                class="danger"
                            >
                                <Icon name="logout" size={14} /> Sign out{authState.sessions.length > 1 ? ` of ${authState.activeUser}` : ''}
                            </button>
                        </li>
                    </ul>
                {/if}
            </div>
        </div>
    </header>

    {#if lastLoginWarning && !lastLoginDismissed}
        <div class="security-bar" data-testid="last-login-warning">
            <div class="security-msg">
                <Icon name="shield" size={14} />
                <span>
                    <strong>Last sign-in from {lastLoginWarning.flag} <code>{lastLoginWarning.ip}</code></strong>
                    via {lastLoginWarning.service}
                    {#if lastLoginWarning.time}
                        · {lastLoginWarning.time.split(/\s/)[0] || lastLoginWarning.time}
                    {/if}
                    — was that you?
                </span>
            </div>
            <div class="security-actions">
                <button
                    type="button"
                    class="btn btn-ghost"
                    onclick={() => { ui.settingsOpen = true; lastLoginDismissed = true; }}
                    data-testid="last-login-review"
                >Review</button>
                <button
                    type="button"
                    class="btn btn-secondary"
                    onclick={dismissLastLoginWarning}
                    data-testid="last-login-dismiss"
                    aria-label="Dismiss security notice"
                ><Icon name="close" size={13} /></button>
            </div>
        </div>
    {/if}

    {#if pwa.available && !pwa.installed && !installDismissed}
        <div class="install-bar" data-testid="install-banner">
            <div class="install-msg">
                <Icon name="download" size={14} />
                <span>Install as an app — offline access and faster boot.</span>
            </div>
            <div class="install-actions">
                <button type="button" class="btn btn-secondary" onclick={() => { installDismissed = true; }} data-testid="install-dismiss">Not now</button>
                <button type="button" class="btn btn-primary" onclick={handleInstallClick} data-testid="install-confirm">
                    <Icon name="download" size={13} /> Install
                </button>
            </div>
        </div>
    {/if}

    <div class="body">
        <AppSwitcher />
        {#if ui.app === 'calendar'}
            <CalendarApp />
        {:else if ui.app === 'ai'}
            <ChatApp />
        {:else if ui.app === 'drive'}
            <DriveApp />
        {:else}
        {#if !settings.hideSidebar}
        <div class="sidebar-wrap" style={`width: ${sidebarWidth}px`}>
            <Sidebar
                onSelect={selectMailbox}
                onCompose={() => openCompose()}
                onRefresh={async () => { await Promise.all([refreshMailboxes(), refreshMessages({ force: true })]); }}
                onShortcut={handleShortcut}
                onCreate={createFolder}
                onRename={renameFolder}
                onDelete={deleteFolder}
                onDropMessages={async (uids, destPath) => {
                    // Move each uid in turn — keeps the IMAP client linear
                    // and matches the existing single-uid moveTo flow.
                    for (const uid of uids) {
                        try { await moveTo(uid, destPath); }
                        catch { /* keep going for the rest */ }
                    }
                    showToast('success', `Moved ${uids.length} → ${destPath}`);
                }}
            />
        </div>
        <div
            class="pane-resizer sidebar-resizer"
            class:dragging
            onpointerdown={startSidebarDrag}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={splitterValue(sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`Sidebar ${Math.round(sidebarWidth)} pixels`}
            title="Drag to resize · arrows to adjust · double-click to reset"
            tabindex="0"
            ondblclick={() => (sidebarWidth = SIDEBAR_DEFAULT)}
            onkeydown={(e) => splitterKeys(e, () => sidebarWidth, (n) => (sidebarWidth = n), SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT)}
        ></div>
        {/if}
        <main
            class="content"
            class:no-selection={!ui.detail}
            style={`--list-width: ${listWidth}px`}
        >
            {#if $embeddedShortcut}
                <ShortcutEmbed
                    shortcut={$embeddedShortcut}
                    onClose={() => embeddedShortcut.set(null)}
                />
            {:else}
            <MessageList
                onSelect={selectMessage}
                onStar={toggleStar}
                onUnread={toggleUnread}
                onTrash={trashMessage}
                onArchive={archiveMessage}
                onPageChange={(p) => { ui.messagesPage = p; refreshMessages(); }}
                onMarkFolderRead={markFolderRead}
                onSummariseAndMarkRead={summariseAndMarkRead}
                onLoadMore={loadMoreMessages}
                effectivePageSize={pageSize()}
                {appendingMore}
                scanState={globalScanState ?? scanState}
                onMove={moveTo}
                onBlockSender={blockSenderForUid}
            />
            <div
                class="pane-resizer"
                class:dragging
                onpointerdown={startDrag}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize message list"
                aria-valuenow={splitterValue(listWidth, LIST_MIN, LIST_MAX)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={`Message list ${Math.round(listWidth)} pixels`}
                title="Drag to resize · arrows to adjust · double-click to reset"
                tabindex="0"
                ondblclick={() => (listWidth = LIST_DEFAULT)}
                onkeydown={(e) => splitterKeys(e, () => listWidth, (n) => (listWidth = n), LIST_MIN, LIST_MAX, LIST_DEFAULT)}
                data-testid="pane-resizer"
            ></div>
            <MessageDetail
                onReply={(m) => openCompose(m, 'reply')}
                onReplyAll={(m) => openCompose(m, 'replyAll')}
                onForward={(m) => openCompose(m, 'forward')}
                onTrash={trashMessage}
                onArchive={archiveMessage}
                onMove={moveTo}
                onAi={() => (ui.aiPanelOpen = true)}
            />
            {/if}
        </main>
        {#if ui.aiPanelOpen}
            <AiPanel onClose={() => (ui.aiPanelOpen = false)} />
        {/if}
        {/if}
    </div>

    {#if ui.selected.size > 0}
        <BulkBar
            count={ui.selected.size}
            onMarkRead={() => bulkMark(true)}
            onMarkUnread={() => bulkMark(false)}
            onArchive={bulkArchive}
            onTrash={bulkTrash}
            onClear={clearSelection}
            onSelectAll={selectAllVisible}
        />
    {/if}

    {#if ui.composeOpen}
        <Compose onClose={() => (ui.composeOpen = false)} />
    {/if}

    {#if ui.settingsOpen}
        <Settings onClose={() => (ui.settingsOpen = false)} />
    {/if}

    {#if ui.helpOpen}
        <HelpDialog onClose={() => (ui.helpOpen = false)} />
    {/if}

    {#if ui.setupOpen}
        <SetupGuide onClose={() => (ui.setupOpen = false)} />
    {/if}

    {#if !ui.aiPanelOpen && ui.app !== 'ai' && ui.app !== 'drive'}
        <ChatBot composeOpen={ui.composeOpen} />
        {#if isVoiceAvailable() && isSttAvailable()}
            <button
                type="button"
                class="voice-fab"
                class:compose-open={ui.composeOpen}
                onclick={() => voiceModeOpen = true}
                title="Voice chat"
                aria-label="Open voice chat"
                data-testid="voice-fab"
            >
                <Icon name="mic" size={18} />
            </button>
        {/if}
    {/if}

    {#if voiceModeOpen}
        <VoiceChat onClose={() => voiceModeOpen = false} />
    {/if}

    {#if inboxSummaryOpen}
        <InboxSummary
            messages={inboxSummarySnapshot}
            onClose={() => (inboxSummaryOpen = false)}
            onJumpToUid={(uid) => {
                inboxSummaryOpen = false;
                selectMessage(uid);
            }}
            onArchiveSelected={async (uids) => {
                const dest = archiveFolderName();
                const from = ui.selectedPath;
                for (const uid of uids) {
                    try { await moveMessage(from, uid, dest); } catch { /* skip */ }
                }
                cache.invalidatePath(currentUser(), from);
                await refreshMessages({ force: true });
            }}
            onTrashSelected={async (uids) => {
                const dest = trashFolderName();
                const from = ui.selectedPath;
                for (const uid of uids) {
                    try { await moveMessage(from, uid, dest); } catch { /* skip */ }
                }
                cache.invalidatePath(currentUser(), from);
                await refreshMessages({ force: true });
            }}
            onMarkReadSelected={async (uids) => {
                const from = ui.selectedPath;
                for (const uid of uids) {
                    try { await modifyFlags(from, uid, { add: ['\\Seen'] }); } catch { /* skip */ }
                }
                cache.invalidatePath(currentUser(), from);
                await refreshMessages({ force: true });
            }}
            onStarSelected={async (uids) => {
                const from = ui.selectedPath;
                for (const uid of uids) {
                    try { await modifyFlags(from, uid, { add: ['\\Flagged'] }); } catch { /* skip */ }
                }
                cache.invalidatePath(currentUser(), from);
                await refreshMessages({ force: true });
            }}
            onAutoReply={async (uid, label) => {
                // Pull the message body so the AI can reply against the
                // actual email, then open a fresh AI thread seeded with a
                // "draft a reply" prompt + the email context block. The
                // chat UI auto-sends so a draft starts streaming on land.
                inboxSummaryOpen = false;
                try {
                    const msg = await getMessage(ui.selectedPath, uid);
                    const fromName = msg.envelope.from?.[0]?.name || '';
                    const fromAddr = msg.envelope.from?.[0]?.address || '';
                    const bodyText = (msg.text || '').slice(0, 4000);
                    const meta = JSON.stringify({
                        subject: msg.envelope.subject || '',
                        fromName,
                        fromAddr,
                        date: msg.envelope.date || null,
                        preview: bodyText.replace(/\s+/g, ' ').trim().slice(0, 140)
                    });
                    const ctx = [
                        `[[email:${meta}]]`,
                        `Draft a friendly reply to this email. Action context: "${label}". Match the sender\'s tone, end with a clear next step, no markdown.`,
                        '',
                        'Email context:',
                        `Subject: ${msg.envelope.subject || ''}`,
                        `From: ${fromName ? `${fromName} <${fromAddr}>` : fromAddr}`,
                        '',
                        bodyText
                    ].join('\n');
                    const t = newAiThread();
                    appendAiMessage(t.id, { role: 'user', content: ctx });
                    requestAutoSendAi(t.id);
                    ui.app = 'ai';
                } catch (err) {
                    showToast('error', `Couldn\'t open AI reply: ${(err as Error).message}`);
                }
            }}
        />
    {/if}

    {#if ui.suggestedEvent}
        <EventModal
            event={null}
            seed={ui.suggestedEvent}
            onClose={() => (ui.suggestedEvent = null)}
        />
    {/if}

    {#if $popupShortcut}
        <ShortcutPopup
            shortcut={$popupShortcut}
            onClose={() => popupShortcut.set(null)}
        />
    {/if}

    {#if ui.toast}
        <div class={`toast toast-${ui.toast.kind}`} role="status" aria-live="polite" data-testid="toast">
            <span>{ui.toast.message}</span>
            {#if ui.undo && ui.toast.kind === 'success' && /Trash|Archive|Moved/.test(ui.toast.message)}
                <button type="button" class="undo-btn" onclick={performUndo} data-testid="undo-btn">Undo</button>
            {/if}
        </div>
    {/if}

    {#if Object.values(sentStatusState.records).some((r) => !r.dismissed)}
        <div class="sent-tray" aria-label="Recently sent" data-testid="sent-tray">
            {#each Object.values(sentStatusState.records).filter((r) => !r.dismissed).slice(-3) as r (r.messageId)}
                {@const open = sentExpanded === r.messageId}
                <div
                    class={`sent-row sent-${r.status}`}
                    class:sent-found={r.inSentFolder}
                    class:sent-slow={r.sentFolderStatus === 'slow'}
                    class:open
                    class:fading-out={r.fadingOut}
                    data-testid={`sent-${r.messageId}`}
                >
                    <button
                        type="button"
                        class="sent-clickable"
                        onclick={() => (sentExpanded = open ? null : r.messageId)}
                        title={r.details || ''}
                    >
                        <span class="sent-icon" aria-hidden="true">
                            {#if r.inSentFolder}
                                <span class="check-pop"><Icon name="check" size={13} /></span>
                            {:else if r.status === 'pending'}
                                <span class="plane-track">
                                    <span class="plane">
                                        <Icon name="send" size={13} />
                                    </span>
                                </span>
                            {:else if r.status === 'delivered'}
                                <span class="check-pop"><Icon name="check" size={13} /></span>
                            {:else if r.status === 'failed'}
                                <span class="bounce-mark"><Icon name="close" size={13} /></span>
                            {:else if r.status === 'delayed'}
                                <span class="hourglass"><Icon name="clock" size={13} /></span>
                            {:else}
                                <Icon name="info" size={13} />
                            {/if}
                        </span>
                        <span class="sent-text">
                            <span class="sent-status-label">
                                {#if r.inSentFolder}In Sent
                                {:else if r.status === 'pending'}Sending…
                                {:else if r.status === 'delivered'}Delivered
                                {:else if r.status === 'failed'}Bounced
                                {:else if r.status === 'delayed'}Delayed
                                {:else}{r.status}
                                {/if}
                            </span>
                            <span class="sent-subject truncate">{r.subject}</span>
                            <span class="sent-to muted truncate">to {r.to}</span>
                        </span>
                    </button>
                    <button
                        type="button"
                        class="sent-dismiss"
                        aria-label="Dismiss"
                        onclick={() => dismissSent(r.messageId)}
                    ><Icon name="close" size={11} /></button>
                    {#if open}
                        <div class="sent-details" role="region" aria-label="Delivery diagnostic">
                            {#if r.details}
                                <code>{r.details}</code>
                            {:else if r.status === 'pending'}
                                <span class="muted">
                                    {#if r.inSentFolder}
                                        Message confirmed in Sent folder. Waiting for the recipient's mail server. Bounces usually arrive within a minute or two; success notices may never come back at all (Gmail / Outlook don't send them).
                                    {:else if r.sentFolderStatus === 'slow'}
                                        Still looking for the message in your Sent folder. It may take a few more seconds.
                                    {:else}
                                        Checking Sent folder… Waiting for the recipient's mail server. Bounces usually arrive within a minute or two; success notices may never come back at all (Gmail / Outlook don't send them).
                                    {/if}
                                </span>
                            {:else}
                                <span class="muted">No diagnostic returned.</span>
                            {/if}
                            <span class="sent-meta muted small">message-id: {r.messageId}</span>
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>

<BulkProgress />
<BackgroundTaskFloater />
<PwaUpdatePrompt />

{#if !ui.online}
    <div class="net-banner net-offline" role="status" aria-live="polite" data-testid="offline-banner">
        <span class="net-dot offline" aria-hidden="true"></span>
        Offline — sends will fail until you're reconnected. Cached folders + messages still work.
    </div>
{:else if ui.servingCachedApi}
    <div class="net-banner net-cached" role="status" aria-live="polite" data-testid="cached-banner">
        <span class="net-dot cached" aria-hidden="true"></span>
        Showing cached data — reconnecting…
    </div>
{/if}

<style>
    .net-banner {
        position: fixed;
        left: 50%;
        bottom: 14px;
        transform: translateX(-50%);
        z-index: 95;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        font-size: 12.5px;
        font-weight: 500;
        border-radius: 999px;
        backdrop-filter: blur(8px);
        box-shadow: var(--shadow-md);
    }
    .net-banner.net-offline {
        background: var(--danger-soft);
        color: var(--danger);
        border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    }
    .net-banner.net-cached {
        background: var(--warning-soft);
        color: var(--warning);
        border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
    }
    .net-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: currentColor;
        flex: 0 0 auto;
    }
    .net-dot.offline { animation: blink 1.4s ease-in-out infinite; }
    @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
    }

    .shell {
        display: flex;
        flex-direction: column;
        min-height: 100vh;
        min-height: 100dvh;
        background: var(--bg-base);
    }
    .topbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 10px 16px;
        background: var(--bg-surface);
        border-bottom: 1px solid var(--border-subtle);
    }
    .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 220px;
    }
    .logo {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: var(--radius-md);
        background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #d268f4));
        color: var(--text-on-accent);
    }
    .brand-name {
        display: inline-flex;
        flex-direction: column;
        line-height: 1;
        gap: 2px;
    }
    .brand-mark {
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: var(--text-primary);
    }
    .brand-sub {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-tertiary);
    }
    .search-wrap {
        flex: 1;
        max-width: 720px;
        display: flex;
        align-items: center;
        gap: 8px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        padding: 0 12px;
        color: var(--text-tertiary);
        transition: border-color var(--transition-fast), background var(--transition-fast);
        position: relative;
    }
    /* Suggestions float beneath the search input. Show on focus until
       the user blurs (with a tiny grace period so a click can register
       before it closes). Click-down on a chip inserts the tag and
       re-focuses the input — never causes navigation. */
    .search-suggest {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: 0;
        max-height: 320px;
        overflow-y: auto;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: 0 8px 28px rgba(0,0,0,0.18);
        padding: 6px;
        z-index: 50;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .search-suggest-hint {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        padding: 4px 6px;
    }
    .search-suggest-chip {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 10px;
        align-items: center;
        text-align: left;
        padding: 7px 9px;
        font: inherit;
        font-size: 13px;
        background: transparent;
        border: none;
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        cursor: pointer;
    }
    .search-suggest-chip:hover { background: var(--bg-hover); }
    .search-suggest-key {
        font-family: var(--mono, ui-monospace, monospace);
        font-weight: 700;
        color: var(--accent-text);
    }
    .search-suggest-label { color: var(--text-secondary); }
    .search-suggest-sample {
        font-family: var(--mono, ui-monospace, monospace);
        font-size: 11px;
        color: var(--text-tertiary);
    }
    .search-wrap:focus-within {
        border-color: var(--border-focus);
        background: var(--bg-input);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .search-wrap input {
        flex: 1;
        border: none;
        background: transparent;
        padding: 9px 0;
        color: var(--text-primary);
    }
    .search-wrap input:focus { outline: none; box-shadow: none; }
    /* Inline action sitting at the right edge of the search input — toggles
       between current-folder (default) and all-folders (aggregated) search.
       Active state inverts so it reads as "this is the current scope". */
    .search-scope-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
        padding: 4px 9px;
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        background: transparent;
        color: var(--text-secondary);
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
    }
    .search-scope-btn:hover {
        background: color-mix(in srgb, var(--accent) 10%, transparent);
        color: var(--accent);
        border-color: color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
    }
    .search-scope-btn.active {
        background: var(--accent);
        color: var(--bg-elevated);
        border-color: var(--accent);
    }
    .search-scope-btn.active:hover {
        background: color-mix(in srgb, var(--accent) 80%, #000 20%);
    }
    .header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
    }
    .server-ping {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px 4px 18px;
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: var(--text-tertiary);
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
    }
    .server-ping .ping-dot,
    .server-ping .ping-radar {
        position: absolute;
        left: 6px;
        top: 50%;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        transform: translateY(-50%);
    }
    .server-ping .ping-dot { background: var(--success); }
    .server-ping .ping-radar {
        border: 1px solid var(--success);
        animation: radar-pulse 1.8s cubic-bezier(0.2, 0.7, 0.4, 1) infinite;
    }
    @keyframes radar-pulse {
        0%   { transform: translateY(-50%) scale(0.6); opacity: 0.85; }
        80%, 100% { transform: translateY(-50%) scale(2.6); opacity: 0; }
    }
    .server-ping.ping-slow .ping-dot,
    .server-ping.ping-slow .ping-radar { background: #d18c1d; border-color: #d18c1d; }
    .server-ping.ping-slow { color: #d18c1d; }
    .server-ping.ping-offline .ping-dot { background: var(--danger); }
    .server-ping.ping-offline .ping-radar { border-color: var(--danger); animation-duration: 1s; }
    .server-ping.ping-offline { color: var(--danger); }
    @media (max-width: 720px) {
        .server-ping .ping-label { display: none; }
        .server-ping { padding: 4px; width: 22px; }
    }
    @media (prefers-reduced-motion: reduce) {
        .server-ping .ping-radar { animation: none; opacity: 0; }
    }
    .user-wrap { position: relative; }
    .account-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 8px;
        background: var(--bg-tag);
        color: var(--text-tertiary);
        border: 1px solid var(--border-subtle);
        font-size: 9.5px;
        font-weight: 600;
        margin-left: 4px;
    }
    .user {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px 4px 4px;
        border-radius: var(--radius-md);
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        color: var(--text-primary);
        transition: background-color var(--transition-fast), border-color var(--transition-fast);
        cursor: pointer;
    }
    .user:hover { background: var(--bg-hover); border-color: var(--border-soft); }
    .user .caret { color: var(--text-tertiary); margin-left: 2px; }
    .account-menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 240px;
        list-style: none;
        margin: 0;
        padding: 6px;
        /* On light theme, --bg-elevated is pure white which made this card
         * "glow" against the off-white app bg. Mix in a touch of the page
         * surface so it sits gently rather than hovering. Dark theme is
         * unaffected (the mix collapses to roughly the same shade). */
        background: color-mix(in srgb, var(--bg-elevated) 92%, var(--bg-base));
        border: 1px solid var(--border-soft);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 90;
        animation: fade-in 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .account-menu li button[role="menuitem"] {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 10px;
        border-radius: var(--radius-xs);
        color: var(--text-primary);
        font-size: 13px;
        text-align: left;
    }
    .account-menu li button[role="menuitem"]:hover { background: var(--bg-hover); }
    .account-menu li button.danger { color: var(--danger); }
    .account-menu li button.danger:hover { background: var(--danger-soft); }
    .account-row {
        display: flex;
        align-items: stretch;
        gap: 4px;
        padding: 0;
        list-style: none;
    }
    .account-pick {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: var(--radius-xs);
        text-align: left;
        font-size: 13px;
    }
    .account-pick:hover { background: var(--bg-hover); }
    .account-pick.active { background: var(--accent-soft); }
    .account-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .account-info .account-email { font-weight: 600; }
    .account-info .account-sub { font-size: 11px; }
    .active-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--accent);
        flex: 0 0 auto;
    }
    .account-signout {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        margin: 4px 0;
        border-radius: var(--radius-xs);
        color: var(--text-tertiary);
        opacity: 0;
        transition: opacity var(--transition-fast), background-color var(--transition-fast), color var(--transition-fast);
    }
    .account-row:hover .account-signout { opacity: 1; }
    .account-signout:hover { background: var(--danger-soft); color: var(--danger); }
    .account-meta {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px 6px;
    }
    .account-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: var(--accent);
        color: var(--text-on-accent);
        font-weight: 600;
    }
    .account-email { font-size: 13px; font-weight: 600; }
    .account-sub { font-size: 11px; }
    .account-sep {
        height: 1px;
        background: var(--border-subtle);
        margin: 4px 0;
    }
    .user-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        /* Muted grey — the accent-soft was still too loud in the topbar. */
        background: var(--bg-tag);
        color: var(--text-tertiary);
        border: 1px solid var(--border-subtle);
        font-weight: 600;
        font-size: 12px;
    }
    .user-email { max-width: 220px; font-size: 13px; }
    @media (max-width: 720px) {
        .user-email { display: none; }
        .brand-name { display: none; }
    }
    .body {
        flex: 1;
        display: flex;
        min-height: 0;
        position: relative;
    }
    .sidebar-wrap {
        flex: 0 0 auto;
        display: flex;
        min-width: 0;
        min-height: 0;
    }
    .sidebar-wrap > :global(.sidebar) {
        max-width: none !important;
        width: 100%;
    }
    .pane-resizer.sidebar-resizer { flex: 0 0 6px; }
    @media (max-width: 720px) {
        .sidebar-wrap { width: 64px !important; }
        .pane-resizer.sidebar-resizer { display: none; }
    }
    .content {
        flex: 1;
        display: grid;
        grid-template-columns: var(--list-width, 380px) 6px 1fr;
        min-width: 0;
        min-height: 0;
    }
    /* With no message open the reading pane shows only a placeholder, so
       holding most of the width there squeezes sender, subject and the
       filter row for no benefit. Give the space to the list until there is
       something to read; the user's own splitter position still applies as
       the floor. */
    .content.no-selection {
        grid-template-columns: minmax(var(--list-width, 380px), 55%) 6px 1fr;
    }
    .pane-resizer {
        background: transparent;
        cursor: col-resize;
        position: relative;
        z-index: 4;
        border-left: 1px solid var(--border-subtle);
        border-right: 1px solid var(--border-subtle);
        transition: background-color var(--transition-fast);
    }
    .pane-resizer:hover,
    .pane-resizer:focus-visible,
    .pane-resizer.dragging {
        background: color-mix(in srgb, var(--accent) 35%, transparent);
        outline: none;
    }
    /* A 6px divider is a hard pointer target and gives no hint that it can
       be dragged at all. Widen the *hit* area either side without moving
       the layout, and show a grip on hover/focus. */
    .pane-resizer::before {
        content: '';
        position: absolute;
        inset: 0 -5px;
        cursor: col-resize;
    }
    .pane-resizer::after {
        content: '';
        position: absolute;
        top: 50%;
        left: 50%;
        width: 2px;
        height: 28px;
        transform: translate(-50%, -50%);
        border-radius: 2px;
        background: var(--border-strong, var(--border-subtle));
        opacity: 0;
        transition: opacity var(--transition-fast);
    }
    .pane-resizer:hover::after,
    .pane-resizer:focus-visible::after,
    .pane-resizer.dragging::after { opacity: 1; }
    .pane-resizer:focus-visible {
        box-shadow: inset 0 0 0 2px var(--accent);
    }
    @media (max-width: 900px) {
        .content { grid-template-columns: 1fr; }
        .pane-resizer { display: none; }
    }
    .toast {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 14px;
        border-radius: var(--radius-md);
        background: var(--bg-elevated);
        color: var(--text-primary);
        border: 1px solid var(--border-subtle);
        box-shadow: var(--shadow-md);
        font-size: 13px;
        z-index: 100;
        display: flex;
        align-items: center;
        gap: 12px;
        animation: fade-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .toast-error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border-subtle)); }
    .toast-success { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--border-subtle)); }
    .sent-tray {
        position: fixed;
        right: 16px;
        bottom: 76px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-width: 380px;
        width: min(380px, calc(100vw - 32px));
        z-index: 90;
    }
    .sent-row {
        position: relative;
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: stretch;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-left: 3px solid var(--text-tertiary);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        font-size: 12px;
        overflow: hidden;
        animation: fade-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .sent-clickable {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 9px 6px 9px 12px;
        text-align: left;
        min-width: 0;
        background: transparent;
        cursor: pointer;
    }
    .sent-clickable:hover { background: var(--bg-hover); }
    .sent-icon {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: var(--bg-base);
        color: var(--text-tertiary);
    }

    /* Pending → flying-paper-plane animation. The plane drifts L→R inside
     * a fixed runway, leaving a fading trail. Loops while we wait for a
     * DSN. */
    .sent-row.sent-pending { border-left-color: var(--accent); }
    .sent-row.sent-pending .sent-icon {
        background: var(--accent-soft);
        color: var(--accent-text);
        overflow: hidden;
        position: relative;
    }
    .plane-track {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .plane {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        animation: plane-fly 2.4s ease-in-out infinite;
    }
    @keyframes plane-fly {
        0%   { transform: translateX(-110%) rotate(-6deg); opacity: 0; }
        20%  { opacity: 1; }
        50%  { transform: translateX(0) rotate(0deg); opacity: 1; }
        80%  { opacity: 1; }
        100% { transform: translateX(110%) rotate(6deg); opacity: 0; }
    }

    .sent-row.sent-delivered { border-left-color: var(--success); }
    .sent-row.sent-delivered .sent-icon {
        background: color-mix(in srgb, var(--success) 18%, var(--bg-base));
        color: var(--success);
    }
    .check-pop { display: inline-flex; animation: pop-in 320ms cubic-bezier(0.34, 1.56, 0.64, 1); }
    @keyframes pop-in {
        0%   { transform: scale(0) rotate(-30deg); opacity: 0; }
        60%  { transform: scale(1.2) rotate(0deg); opacity: 1; }
        100% { transform: scale(1) rotate(0deg); }
    }

    .sent-row.sent-failed { border-left-color: var(--danger); }
    .sent-row.sent-failed .sent-icon {
        background: var(--danger-soft);
        color: var(--danger);
    }
    .bounce-mark { display: inline-flex; animation: shake 360ms ease-out; }
    @keyframes shake {
        0%, 100% { transform: translateX(0); }
        20%, 60% { transform: translateX(-3px); }
        40%, 80% { transform: translateX(3px); }
    }

    .sent-row.sent-delayed { border-left-color: #d18c1d; }
    .sent-row.sent-delayed .sent-icon {
        background: color-mix(in srgb, #d18c1d 18%, var(--bg-base));
        color: #d18c1d;
    }
    .hourglass { display: inline-flex; animation: tilt 1.6s ease-in-out infinite; }
    @keyframes tilt {
        0%, 100% { transform: rotate(0); }
        50%      { transform: rotate(180deg); }
    }

    /* Found in Sent — green border + gentle fade-out after a few seconds. */
    .sent-row.fading-out {
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 400ms ease, transform 400ms ease;
        pointer-events: none;
    }
    .sent-row.sent-found {
        border-left-color: var(--success);
        animation: sent-found-glow 3s ease-out forwards;
    }
    @keyframes sent-found-glow {
        0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--success) 40%, transparent); }
        20%  { box-shadow: 0 0 14px 2px color-mix(in srgb, var(--success) 25%, transparent); }
        100% { box-shadow: none; }
    }
    .sent-row.sent-found .sent-icon {
        background: color-mix(in srgb, var(--success) 18%, var(--bg-base));
        color: var(--success);
    }
    .sent-row.sent-found .sent-status-label { color: var(--success); }

    /* Slow (>20s) — persistent orange pulse so the user knows something's up. */
    .sent-row.sent-slow {
        border-left-color: #d18c1d;
        animation: sent-slow-pulse 2s ease-in-out infinite;
    }
    @keyframes sent-slow-pulse {
        0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, #d18c1d 25%, transparent); }
        50%      { box-shadow: 0 0 12px 2px color-mix(in srgb, #d18c1d 18%, transparent); }
    }
    .sent-row.sent-slow .sent-status-label { color: #d18c1d; }

    .sent-text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
    }
    .sent-status-label {
        font-size: 9.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
    }
    .sent-row.sent-pending .sent-status-label { color: var(--accent-text); }
    .sent-row.sent-delivered .sent-status-label { color: var(--success); }
    .sent-row.sent-failed .sent-status-label { color: var(--danger); }
    .sent-row.sent-delayed .sent-status-label { color: #d18c1d; }
    .sent-subject { font-weight: 600; color: var(--text-primary); }
    .sent-to { font-size: 11px; }
    .sent-dismiss {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        align-self: stretch;
        color: var(--text-tertiary);
        flex: 0 0 auto;
        border-left: 1px solid var(--border-subtle);
    }
    .sent-dismiss:hover { background: var(--bg-hover); color: var(--text-primary); }
    .sent-details {
        grid-column: 1 / -1;
        padding: 10px 12px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-base);
        display: flex;
        flex-direction: column;
        gap: 4px;
        animation: fade-in 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .sent-details code {
        font-family: var(--font-mono);
        font-size: 11.5px;
        color: var(--text-primary);
        white-space: pre-wrap;
        word-break: break-word;
    }
    .sent-meta {
        font-family: var(--font-mono);
        font-size: 10px;
    }
    @media (prefers-reduced-motion: reduce) {
        .plane, .check-pop, .bounce-mark, .hourglass { animation: none; }
    }
    .undo-btn {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--accent-text);
        padding: 4px 10px;
        border-radius: var(--radius-xs);
        border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
    }
    .undo-btn:hover { background: var(--accent-soft); }
    .install-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        /* Kept tight: this sits above the mailbox and every pixel here is
           one the message list doesn't get. */
        padding: 5px 16px;
        background: linear-gradient(90deg,
            color-mix(in srgb, var(--accent) 8%, var(--bg-surface)),
            color-mix(in srgb, #d268f4 4%, var(--bg-surface)));
        border-bottom: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border-subtle));
        font-size: 12.5px;
    }
    .install-msg {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--text-primary);
    }
    .install-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 0 0 auto;
    }
    .install-actions .btn { padding: 6px 12px; font-size: 12.5px; }
    .security-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 7px 16px;
        background: linear-gradient(90deg,
            color-mix(in srgb, var(--warning, #d18c1d) 12%, var(--bg-surface)),
            color-mix(in srgb, var(--warning, #d18c1d) 4%, var(--bg-surface)));
        border-bottom: 1px solid color-mix(in srgb, var(--warning, #d18c1d) 28%, var(--border-subtle));
        font-size: 12.5px;
        animation: fade-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .security-msg {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--text-primary);
        flex: 1;
        min-width: 0;
    }
    .security-msg code {
        font-family: var(--font-mono);
        font-size: 11.5px;
        padding: 1px 6px;
        background: color-mix(in srgb, var(--text-primary) 8%, transparent);
        border-radius: var(--radius-xs);
    }
    .security-actions { display: flex; gap: 6px; flex: 0 0 auto; }
    .security-actions .btn { padding: 5px 10px; font-size: 12.5px; }

    .voice-fab {
        position: fixed;
        right: 18px;
        bottom: 72px;
        z-index: 60;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 90%, white) 0%,
            var(--accent) 60%,
            color-mix(in srgb, var(--accent) 80%, #d268f4) 100%);
        color: var(--accent-on);
        border: none;
        box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 35%, transparent),
                    0 2px 6px rgba(0,0,0,0.15);
        cursor: pointer;
        transition: transform var(--transition-fast), box-shadow var(--transition-fast),
                    bottom 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .voice-fab.compose-open { bottom: 150px; }
    .voice-fab:hover {
        transform: translateY(-1px) scale(1.05);
        box-shadow: 0 6px 20px color-mix(in srgb, var(--accent) 45%, transparent),
                    0 3px 8px rgba(0,0,0,0.18);
    }
</style>
