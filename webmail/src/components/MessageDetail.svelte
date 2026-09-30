<script lang="ts">
    import { fade } from 'svelte/transition';
    import { onDestroy, untrack } from 'svelte';
    import { ui, showToast } from '../lib/store.svelte';
    import { markSpam, markTrusted, isTrustedSender } from '../lib/spam-feedback.svelte';
    import { themeState } from '../lib/theme.svelte';
    import { sanitizeHtml, buildIframeSrcDoc, placeholderRemoteImages } from '../lib/sanitize';
    import { linkCheckShim } from '../lib/sanitize';
    import { linkCheckEnabled } from '../lib/virustotal';
    import LinkCheckPrompt from './LinkCheckPrompt.svelte';
    import { proxyImagesInHtml, isProxyHealthy } from '../lib/image-proxy';
    import { formatFullDate, formatBytes, formatAddress, formatAddressList, isTrackingEmail, isNotificationMessage, isSmsMessage } from '../lib/format';
    import NotificationBubble from './NotificationBubble.svelte';
    import Avatar from './Avatar.svelte';
    import VipBadge from './VipBadge.svelte';
    import { attachmentUrl, ocrAttachmentText, blockSender, allowSender, blockRecipient, getRawMessage, ApiError } from '../lib/api';
    import { saveAttachmentToDrive, driveState, loadDriveConfig } from '../lib/drive.svelte';
    import Icon from './Icon.svelte';
    import DriveFolderPicker from './drive/DriveFolderPicker.svelte';
    import { aiAvailable, capabilities, isVipAddress, settings } from '../lib/settings.svelte';
    import { authState } from '../lib/auth.svelte';
    import { suggestEventFromEmail, suggestCalendarOptions, type CalendarSuggestion } from '../lib/calendar-suggest';
    import { isChatConfigured } from '../lib/chat.svelte';
    import { loadCalendar } from '../lib/calendar.svelte';
    import { hasRemoteImages } from '../lib/image-trust';
    import { suggestEmailActions, type EmailAction } from '../lib/email-actions.svelte';
    import { newThread, appendMessage, setTools, requestAutoSend } from '../lib/ai-threads.svelte';
    import { scanEmailForPhishing, getCachedScan, envelopeToHeaders, type PhishingScanResult } from '../lib/phishing-scan';
    import { findSpamFolder } from '../lib/spam-sweep';
    import { listMailboxes, moveMessage } from '../lib/api';
    import type { Attachment, MessageDetail } from '../lib/api';
    import MenuSubmenu, { type SubmenuItem } from './MenuSubmenu.svelte';

    interface Props {
        onReply: (replyTo: MessageDetail) => void;
        onReplyAll: (replyTo: MessageDetail) => void;
        onForward: (replyTo: MessageDetail) => void;
        onTrash: (uid: number) => void;
        onArchive: (uid: number) => void;
        onMove: (uid: number, dest: string) => void;
        onAi: () => void;
    }
    let { onReply, onReplyAll, onForward, onTrash, onArchive, onMove, onAi }: Props = $props();

    let showRaw = $state<'auto' | 'text' | 'html'>('auto');
    let moveOpen = $state(false);
    let folderPickerAtt = $state<Attachment | null>(null);
    let folderPickerBlob = $state<Blob | null>(null);

    // Folder destinations for the Move submenu. Unbounded by design — the
    // inline list this replaced dumped every mailbox into a 320px max-height
    // dropdown, so a large account silently scrolled past most of its
    // folders. MenuSubmenu renders the full list in a scrolling panel.
    let moveTargets = $derived<SubmenuItem[]>(
        ui.mailboxes
            .filter((m) => m.path !== ui.selectedPath)
            .map((m) => ({ key: m.path, label: m.name || m.path }))
    );

    // Keep the previous message on screen while the next one loads so the
    // pane crossfades instead of flashing a spinner. `shown` only changes
    // once a fresh body has actually arrived.
    let shown = $state<MessageDetail | null>(null);
    $effect(() => {
        if (ui.detail) shown = ui.detail;
    });
    // --- Phishing scan -----------------------------------------------
    let phishingScanning = $state(false);
    let phishingResult = $state<PhishingScanResult | null>(null);
    let phishingDismissed = $state(false);
    let phishingAbort: AbortController | null = null;
    // Spam classification rides the same scan response. Surface a
    // separate dismissable "looks like spam" bubble with a one-click
    // move-to-Spam button when phishing is NOT also flagged (in that
    // case the phishing bubble takes precedence).
    let spamDismissed = $state(false);
    let spamMoving = $state(false);

    async function moveToSpam(d: MessageDetail) {
        const path = ui.selectedPath;
        if (!path) return;
        spamMoving = true;
        try {
            const list = ui.mailboxes && ui.mailboxes.length ? ui.mailboxes : await listMailboxes();
            const dest = findSpamFolder(list);
            if (!dest) {
                showToast('error', 'No Spam/Junk folder found. Create one and try again.');
                return;
            }
            await moveMessage(path, d.uid, dest);
            showToast('success', `Moved to ${dest}.`);
            spamDismissed = true;
            // Tell the parent so the message list refreshes.
            onMove(d.uid, dest);
        } catch {
            showToast('error', 'Could not move the message to Spam.');
        } finally {
            spamMoving = false;
        }
    }
    // Identity of the message the last scan ran for. `ui.detail` is
    // reassigned on every refresh of the SAME message (background sync, a
    // flag change, a re-poll) — not just when the user opens a different
    // one. Re-running the effect on those reassignments cleared
    // `phishingResult`, flipped `phishingScanning` back on and re-ran the
    // overlay animation, which — together with the `{#key d.uid}` remount
    // below — tore down and rebuilt the whole pane. That is the "message
    // collapses and pops back up" the user reported. Bail out when we are
    // already showing the result for this exact message.
    let scannedKey = '';

    // What identifies "a different message": the folder plus the uid.
    // Neither alone is sufficient — a uid is only unique within a
    // mailbox, and the same folder can be re-listed.
    function scanKeyFor(p: string, uid: number | string): string {
        return `${p}::${uid}`;
    }


    $effect(() => {
        const detail = ui.detail;
        const path = ui.selectedPath;
        // Re-listing or re-syncing the message already on screen is not a
        // new scan: leave its result and overlay alone.
        const key = detail && path ? scanKeyFor(path, detail.uid) : '';
        if (key && key === scannedKey) return;
        // A different message (or none): drop any scan still in flight for
        // the old one. This must NOT be an effect teardown — Svelte runs the
        // previous teardown *before* this body, so a teardown that aborted
        // would kill the in-flight scan and then the guard above would
        // decline to restart it, leaving the message permanently unscanned.
        if (phishingAbort) { phishingAbort.abort(); phishingAbort = null; }
        // Skip phishing scan on AI conversation messages — they're our own
        // chat history, not inbound mail. Pointless burn of LLM tokens
        // (and the smoke effect was scaring people).
        const isAiThread = path === '.AI Conversations' || path === 'AI Conversations';
        if (!detail || !path || !settings.phishingScan || isAiThread) {
            phishingResult = null;
            phishingDismissed = false;
            spamDismissed = false;
            phishingScanning = false;
            // Clear the memo too: leaving it set means turning the setting
            // back on for this same open message hits the guard above and
            // never rescans.
            scannedKey = '';
            return;
        }
        phishingDismissed = false;
        spamDismissed = false;
        phishingResult = null;
        // Memoise only once we know we are really scanning.
        scannedKey = key;
        phishingAbort = new AbortController();

        const cached = getCachedScan(path, detail.uid);
        if (cached) {
            phishingResult = cached;
            phishingScanning = false;
            return;
        }

        // Skip the LLM scan entirely for senders the user has already
        // marked trusted — those are people they know, no point burning
        // tokens or making them wait. Synthetic "clean" result keeps the
        // toolbar badge consistent with normal scan flow.
        if (isTrustedSender(detail.envelope.from?.[0]?.address)) {
            phishingResult = {
                isPhishing: false,
                confidence: 0,
                reasoning: 'Trusted sender — scan skipped.',
                indicators: [],
                isSpam: false,
                spamConfidence: 0,
                spamReasoning: '',
                model: 'trusted-skip'
            };
            phishingScanning = false;
            return;
        }

        phishingScanning = true;
        const from = detail.envelope.from?.[0];
        const to = detail.envelope.to?.[0];
        scanEmailForPhishing(path, detail.uid, {
            subject: detail.envelope.subject || '',
            from: from ? `${from.name || ''} <${from.address}>`.trim() : '',
            to: to ? `${to.name || ''} <${to.address}>`.trim() : '',
            body: detail.text || '',
            html: detail.html || '',
            headers: envelopeToHeaders(detail.envelope),
            // SPF / DKIM / DMARC verdicts give the scanner a hard signal
            // — a sender that fails DKIM is overwhelmingly more likely
            // to be spoofed, so the prompt can tilt towards "phishing"
            // without lowering the confidence floor for everyone else.
            auth: detail.auth ?? null,
            // Image attachments are OCR'd off-thread and folded into the
            // body before the scan so phishers who hide their text in
            // images don't slip past the LLM.
            attachments: detail.attachments,
            path,
            uid: detail.uid
        }, { signal: phishingAbort.signal }).then((result) => {
            if (phishingAbort?.signal.aborted) return;
            phishingResult = result;
        }).catch(() => {
            /* silently fail */
        }).finally(() => {
            phishingScanning = false;
        });
    });

    // The effect no longer returns a teardown (see above), so the in-flight
    // scan is cancelled here instead.
    onDestroy(() => {
        if (phishingAbort) { phishingAbort.abort(); phishingAbort = null; }
    });

    // --- link check before opening ---------------------------------------
    //
    // The body iframe reports clicks through postMessage (see linkCheckShim
    // in lib/sanitize.ts for why a script in the frame is unavoidable and
    // why the frame keeps an opaque origin). Three things have to line up
    // for a message to be accepted, and all three are checked here rather
    // than in the shim, because the parent is the side that can be sure:
    //
    //   1. `event.source` is OUR frame. An opaque-origin frame posts with
    //      origin "null", so an `event.origin` check would accept nothing
    //      (and a laxer "allow null" would accept anything). Comparing the
    //      MessagePort to the iframe we rendered is the check that actually
    //      identifies the sender, and it also rejects the other iframes on
    //      this page — the .eml preview has one of its own.
    //   2. The nonce matches the one in the document we just built, so a
    //      stale frame from a previous message cannot speak for this one.
    //   3. The feature is on. Read at handling time, not at build time, so
    //      flipping the switch takes effect without a re-render.
    //
    // This is a UX guard, not a security boundary — nothing here can stop a
    // frame that already defeated the sanitizer from posting a URL of its
    // choosing. What it guarantees is the ordinary case: the link you
    // clicked is the link you are shown, and nothing opens unannounced.
    let bodyFrame = $state<HTMLIFrameElement | null>(null);
    let pendingLink = $state<{ url: string; label: string } | null>(null);
    let linkToken = $state('');

    // Regenerated per message rather than once per mount: `{#key d.uid}`
    // remounts the pane on every message, but a nonce that outlives its
    // document would let an abandoned frame's postMessage be mistaken for
    // the current one.
    $effect(() => {
        const uid = ui.detail?.uid;
        linkToken = uid === undefined ? '' : `lc-${uid}-${Math.random().toString(36).slice(2, 10)}`;
    });

    const bodyShim = $derived(linkCheckEnabled() ? linkCheckShim(linkToken) : '');

    function onFrameMessage(e: MessageEvent) {
        // The frame must exist. Deliberately NOT gated on `pendingLink` —
        // that is the value this handler is about to SET, so guarding on it
        // dropped the first click (pendingLink still null) and the prompt
        // never appeared at all.
        if (!bodyFrame) return;
        // (1) source identity
        if (e.source !== bodyFrame.contentWindow) return;
        const d = e.data;
        if (!d || typeof d !== 'object') return;
        const m = d as Record<string, unknown>;
        if (m.__linkcheck !== 1) return;
        // (2) nonce — the document that produced this message is the one we
        // built, not a frame left over from the previous message.
        if (m.token !== linkToken) return;
        const url = typeof m.url === 'string' ? m.url : '';
        if (!/^https?:\/\//i.test(url)) return;
        // (3) the switch, re-read at handling time
        if (!linkCheckEnabled()) return;
        pendingLink = { url, label: typeof m.label === 'string' ? m.label : '' };
    }

    // The prompt opens the link from the PARENT, not the frame. The frame
    // has already had its navigation cancelled by the shim, so re-firing a
    // click in there is a race; a plain window.open with noopener is both
    // simpler and immune to the frame being re-rendered underneath us.
    function openLinkNow(url: string) {
        pendingLink = null;
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    // Registered in an $effect rather than onMount so the listener is torn
    // down and re-added with the component's lifetime, matching every other
    // subscription in this file.


    $effect(() => {
        window.addEventListener('message', onFrameMessage);
        return () => window.removeEventListener('message', onFrameMessage);
    });


    // --- AI tools popover (5 LLM-generated actions) ---------------------
    let aiToolsOpen = $state(false);
    let aiToolsLoading = $state(false);
    let aiToolsActions = $state<EmailAction[]>([]);
    let aiToolsError = $state<string | null>(null);
    let aiToolsAbort: AbortController | null = null;

    // --- the single AI menu -------------------------------------------------
    // The reading pane used to carry THREE overlapping AI entry points (AI
    // Calendar, "Other AI", "AI tools") side by side, which read as clutter
    // and made none of them look primary. They are now one button whose
    // popover owns all of them. State lives here rather than on the toolbar
    // button so the effect that resets popovers on message change can close
    // it alongside the other two.
    let aiMenuOpen = $state(false);

    async function openAiTools(d: MessageDetail) {
        if (aiToolsOpen) { closeAiTools(); return; }
        aiToolsOpen = true;
        aiToolsLoading = true;
        aiToolsActions = [];
        aiToolsError = null;
        if (aiToolsAbort) aiToolsAbort.abort();
        aiToolsAbort = new AbortController();
        try {
            const fromAddr = d.envelope.from?.[0]?.address || '';
            const fromName = d.envelope.from?.[0]?.name || '';
            const out = await suggestEmailActions({
                subject: d.envelope.subject || '',
                from: fromName ? `${fromName} <${fromAddr}>` : fromAddr,
                body: d.text || stripHtml(d.html || '')
            }, { signal: aiToolsAbort.signal });
            aiToolsActions = out;
        } catch (err) {
            aiToolsError = (err as Error).message || 'Suggest failed';
        } finally {
            aiToolsLoading = false;
        }
    }
    function closeAiTools() {
        aiToolsOpen = false;
        if (aiToolsAbort) aiToolsAbort.abort();
        aiToolsAbort = null;
    }
    /** Toggle the consolidated AI menu. Only one of the three popovers can be
     *  useful at a time, so opening this one closes the other two — a
     *  half-finished LLM request in a popover the user cannot see is worse
     *  than throwing the result away. */
    function toggleAiMenu() {
        aiMenuOpen = !aiMenuOpen;
        if (!aiMenuOpen) return;
        closeCalOptions();
        closeAiTools();
    }

    function onWindowClick(e: MouseEvent) {
        const target = e.target as HTMLElement;
        if (aiToolsOpen && !target?.closest?.('.ai-tools-wrap')) closeAiTools();
        if (calOptionsOpen && !target?.closest?.('.cal-options-wrap')) closeCalOptions();
        if (aiMenuOpen && !target?.closest?.('.ai-menu-wrap')) aiMenuOpen = false;

        // The Move menu had no outside-click dismissal of its own, so it
        // stayed open whenever focus went anywhere else in the window —
        // including a click on the message body. Match the other two.
        // Scoped to the detail pane because `.more` is a generic class name
        // and a document-wide match could latch onto an unrelated element.
        if (moveOpen && !target?.closest?.('.detail-header .more')) moveOpen = false;
    }

    // Any dropdown in the header belongs to the message that was on screen
    // when it was opened. The `{#key d.uid}` block further down remounts the
    // whole pane when the user picks a different message, but the open flags
    // are component-level, so they outlived the remount: opening Move on one
    // message and clicking through to another left the new message's dropdown
    // already open, anchored to nothing. Reset them with the message.
    $effect(() => {
        // Read the dependency FIRST, so this effect is tracked on the selected
        // message and nothing else.
        void ui.selectedUid;
        // Untrack the flag resets below. Reading a $state flag and writing it
        // in the same effect makes the effect depend on that flag too, so a
        // later write re-runs the whole thing. That matters here because
        // Layout's global Escape clears the selection: without the untrack,
        // the Escape that closed the AI menu changed `ui.selectedUid`, which
        // re-ran this effect and closed the menu again as a side effect of
        // clearing the reading pane — so the key handler looked like it
        // worked when it was doing nothing, and a test asserting it passed
        // with the handler deleted. Untracked, the only thing that can re-run
        // this effect is a different message.
        untrack(() => {
            moveOpen = false;
            calOptionsOpen = false;
            closeAiTools();
            aiMenuOpen = false;
        });
    });

    function runAction(a: EmailAction, d: MessageDetail) {
        // Open a fresh AI thread seeded with the email's context + the
        // action's prompt as the first user message. Optionally enable
        // web search for actions that signalled web=true.
        if (a.web) setTools({ webSearch: true });
        const t = newThread();
        const fromName = d.envelope.from?.[0]?.name || '';
        const fromAddr = d.envelope.from?.[0]?.address || '';
        const bodyText = (d.text || stripHtml(d.html || '')).slice(0, 4000);
        // The leading [[email:{...}]] sentinel is parsed out by the chat
        // bubble renderer and shown as a tidy envelope card; the LLM still
        // sees the full block including the body that follows.
        const meta = JSON.stringify({
            subject: d.envelope.subject || '',
            fromName,
            fromAddr,
            date: d.envelope.date || null,
            preview: bodyText.replace(/\s+/g, ' ').trim().slice(0, 140)
        });
        const ctx = [
            `[[email:${meta}]]`,
            a.prompt,
            '',
            'Email context (for your reference, the user just opened this message):',
            `Subject: ${d.envelope.subject || ''}`,
            `From: ${fromName ? `${fromName} <${fromAddr}>` : fromAddr}`,
            '',
            bodyText
        ].join('\n');
        appendMessage(t.id, { role: 'user', content: ctx });
        // Tell ChatApp to fire the LLM as soon as it mounts, so the
        // user lands on a thread that's already streaming a reply.
        requestAutoSend(t.id);
        ui.app = 'ai';
        closeAiTools();
    }
    let ocrText = $state<Record<string, string>>({});
    let ocrLoading = $state<Record<string, boolean>>({});
    let driveLoading = $state<Record<string, boolean>>({});
    let headersOpen = $state(false);
    let headersLoading = $state(false);
    let headersText = $state('');

    async function viewHeaders() {
        if (!ui.detail) return;
        headersLoading = true;
        headersOpen = true;
        try {
            const raw = await getRawMessage(ui.selectedPath, ui.detail.uid);
            const idx = raw.indexOf('\r\n\r\n');
            headersText = idx !== -1 ? raw.slice(0, idx) : raw.indexOf('\n\n') !== -1 ? raw.slice(0, raw.indexOf('\n\n')) : raw;
        } catch (err) {
            showToast('error', `Couldn't load headers: ${(err as Error).message}`);
            headersOpen = false;
        } finally {
            headersLoading = false;
        }
    }

    // Compact date for the message header — same heuristics as the list:
    // today → time, last 6 days → "Tue 4:32 PM", same year → "Apr 28, 4:32 PM",
    // older → "Apr 28, '24, 4:32 PM".
    function compactHeaderDate(iso: string | null): string {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        const sameYear = d.getFullYear() === now.getFullYear();
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        if (sameDay) return time;
        const civilNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const civilD = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const diff = Math.round((civilNow.getTime() - civilD.getTime()) / 86_400_000);
        if (diff >= 1 && diff <= 6) return `${d.toLocaleDateString(undefined, { weekday: 'short' })}, ${time}`;
        if (sameYear) return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
        return `${d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' })}, ${time}`;
    }

    function viewMode(d: MessageDetail | null): 'html' | 'text' | 'empty' {
        if (!d) return 'empty';
        if (showRaw === 'text') return 'text';
        if (showRaw === 'html') return d.html ? 'html' : 'text';
        if (d.html) return 'html';
        if (d.text) return 'text';
        return 'empty';
    }

    function effectiveTheme(t: 'auto' | 'light' | 'dark'): 'light' | 'dark' {
        if (t === 'dark') return 'dark';
        if (t === 'light') return 'light';
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    // Per-message override for the iframe's color scheme. Many marketing
    // emails set white text inside white tables that they expect to flip
    // via prefers-color-scheme — when forced into our dark wrapper they
    // disappear. The user can flip THIS message into light-mode rendering
    // without changing the surrounding app theme.
    let viewerTheme = $state<'auto' | 'light' | 'dark'>('auto');
    $effect(() => {
        // Reset on message change.
        if (ui.detail) viewerTheme = 'auto';
    });
    // Relative luminance (0..1) for #rrggbb / #rgb. Returns null when the
    // value isn't a hex we can reason about, so callers don't over-trigger
    // on rgba()/var().
    function hexLuminance(hex: string): number | null {
        const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
        if (!m) return null;
        let h = m[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        const r = parseInt(h.slice(0, 2), 16) / 255;
        const g = parseInt(h.slice(2, 4), 16) / 255;
        const b = parseInt(h.slice(4, 6), 16) / 255;
        // Quick lin-RGB; close enough to WCAG luminance for our threshold.
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function viewerEffectiveTheme(): 'light' | 'dark' {
        if (viewerTheme !== 'auto') return viewerTheme;
        const html = ui.detail?.html || '';

        // Cheap but useful: collect hex colors next to `color:` (text) and
        // `background[-color]:`/`bgcolor=` (bg) and check if BOTH look dark.
        // If the email itself uses dark text on dark bg, render in light.
        const textHexes: number[] = [];
        const bgHexes: number[] = [];
        for (const m of html.matchAll(/color\s*:\s*(#[0-9a-f]{3,6})\b/gi)) {
            const v = hexLuminance(m[1]);
            if (v !== null) textHexes.push(v);
        }
        for (const m of html.matchAll(/(?:background(?:-color)?\s*:\s*|bgcolor\s*=\s*["']?#?)([0-9a-f]{3,6})\b/gi)) {
            const v = hexLuminance('#' + m[1]);
            if (v !== null) bgHexes.push(v);
        }
        const avg = (xs: number[]) => xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
        const textL = avg(textHexes);
        const bgL = avg(bgHexes);
        // Both dark → force light. Threshold 0.45 matches "anything that
        // isn't comfortably bright". If contrast between text and bg is
        // also poor (< 0.25 luminance gap) we trip even quicker.
        if (textL !== null && bgL !== null) {
            const lowContrast = Math.abs(textL - bgL) < 0.25;
            if ((textL < 0.45 && bgL < 0.45) || (lowContrast && textL < 0.55 && bgL < 0.55)) {
                return 'light';
            }
        }

        // Existing heuristic — when the surrounding app is dark, detect
        // emails that assume a light page (white bg, or no bg + dark text).
        const t = effectiveTheme(themeState.theme);
        if (t !== 'dark') return t;
        const hasLightBg = /background(?:-color)?\s*:\s*(?:#fff(?:fff)?\b|#f[ef][ef]\w*|white|#fff\b)/i.test(html)
            || /bgcolor\s*=\s*["']?#?(?:fff(?:fff)?|f[ef][ef]\w*|white)/i.test(html)
            || /body\b[^>]*\bbgcolor\s*=\s*["']?#?fff/i.test(html);
        const hasDarkText = /#\s*0{3,6}\b|#\s*1[0-9a-f]{5}\b|color\s*:\s*#222\b|color\s*:\s*#333\b|color\s*:\s*black\b/i.test(html);
        const hasAnyBg = /background(?:-color)?\s*:/i.test(html) || /bgcolor=/i.test(html);
        const looksLight = hasLightBg || (hasDarkText && !hasAnyBg);
        return looksLight ? 'light' : 'dark';
    }

    // Remote images are ALWAYS allowed. There is no per-message permission
    // decision left, no "Load remote content" button, and no per-sender
    // 30-day trust to remember: the blocking path and all three of its
    // supporting pieces are gone, because in practice the prompt showed up
    // on ordinary mail and read to users as "this mailbox is broken" rather
    // than "this mailbox is private". What protects the reader is the
    // proxy, which is on by default (settings.svelte.ts
    // migrateRemoteImagesAlwaysAllowed).
    //
    // Proxy-rewriting is async (each remote image is a network round-trip),
    // so we maintain a parallel state that lags the synchronous srcDoc by
    // however long the proxy takes. Until the rewrite resolves the iframe
    // shows placeholders rather than the sender's own URLs — rendering those
    // would leak the read to them, which is the one thing the proxy exists
    // to prevent.
    let proxiedSrcDoc = $state<{ uid: number; html: string } | null>(null);
    let proxyAbort: AbortController | null = null;
    let proxyLoading = $state(false);

    const baseSafeHtml = $derived.by(() => {
        if (!ui.detail || !ui.detail.html) return '';
        // allowRemoteImages is a constant true now. It is still passed
        // explicitly rather than left to the default because sanitizeHtml's
        // default is FALSE, and a reader that silently relied on that
        // default would block every image the moment this call was edited.
        return sanitizeHtml(ui.detail.html, { allowRemoteImages: true });
    });

    $effect(() => {
        // Re-run whenever the detail changes or the proxy toggle flips.
        const detail = ui.detail;
        const useProxy = settings.proxyImages && isProxyHealthy();
        proxyAbort?.abort();
        proxyAbort = null;
        proxyLoading = false;
        if (!detail || !useProxy) {
            proxiedSrcDoc = null;
            return;
        }
        const ctrl = new AbortController();
        proxyAbort = ctrl;
        proxyLoading = true;
        const targetUid = detail.uid;
        proxyImagesInHtml(baseSafeHtml, ctrl.signal)
            .then((rewritten) => {
                if (ctrl.signal.aborted) return;
                proxiedSrcDoc = { uid: targetUid, html: rewritten };
            })
            .catch(() => { /* fall back to direct render */ })
            .finally(() => {
                if (proxyAbort === ctrl) {
                    proxyAbort = null;
                    proxyLoading = false;
                }
            });
        return () => { ctrl.abort(); };
    });

    const srcDoc = $derived.by(() => {
        if (!ui.detail || !ui.detail.html) return '';
        const useProxy = settings.proxyImages && isProxyHealthy();
        const ready = proxiedSrcDoc && proxiedSrcDoc.uid === ui.detail.uid;
        // While the proxy is still fetching, show placeholders rather than
        // the sender's own URLs: rendering those would leak the read to
        // them, which is exactly what the proxy exists to prevent, and
        // dropping the src outright just yields a broken-image icon.
        const html = useProxy
            ? (ready ? proxiedSrcDoc!.html : placeholderRemoteImages(baseSafeHtml))
            : baseSafeHtml;
        // The third argument is the click reporter. It is '' whenever the
        // feature is off, so the frame's document is byte-identical to what
        // it was before link checking existed — no script, no listener, and
        // (because the sandbox attribute is bound to the same condition)
        // no `allow-scripts` either. The switch is therefore genuinely a
        // security-posture switch, not just a UI one.
        return buildIframeSrcDoc(html, viewerEffectiveTheme(), bodyShim);
    });

    async function viewOcr(att: Attachment) {
        if (!ui.detail) return;
        ocrLoading = { ...ocrLoading, [att.id]: true };
        try {
            const text = await ocrAttachmentText(ui.selectedPath, ui.detail.uid, att.id);
            ocrText = { ...ocrText, [att.id]: text };
        } catch (err) {
            const msg = err instanceof ApiError ? err.detail || err.title : (err as Error).message;
            showToast('error', msg || 'OCR failed');
        } finally {
            ocrLoading = { ...ocrLoading, [att.id]: false };
        }
    }

    function isOcrCandidate(att: Attachment): boolean {
        const t = (att.contentType || '').toLowerCase();
        // Inline (Content-Disposition: inline / multipart-related) parts are
        // typically embedded HTML imagery — sender signatures, tracking
        // pixels — and many IMAP servers won't return them as a downloadable
        // part by their MIME path. OCR'ing them produces 404s, so skip.
        if (att.related) return false;
        if (!att.filename) return false;
        return t.startsWith('image/') || t === 'application/pdf';
    }

    function isPdf(att: Attachment): boolean {
        const t = (att.contentType || '').toLowerCase();
        const n = (att.filename || '').toLowerCase();
        return t === 'application/pdf' || n.endsWith('.pdf');
    }

    let pdfPreview = $state<{ id: string; filename: string; bytes: ArrayBuffer } | null>(null);
    let pdfLoading = $state<Record<string, boolean>>({});
    // PDF form-fill state. The banner only shows after the bytes have been
    // fetched + scanned, so big PDFs without forms don't blink the user.
    let pdfFormBanner = $state<{ attId: string; filename: string } | null>(null);
    let pdfFormFiller = $state<{ id: string; filename: string; bytes: ArrayBuffer } | null>(null);
    // Per-uid memo so we don't re-fetch the same PDF when the user toggles
    // panes or jumps back to the same message.
    const pdfFormSeen = new Map<string, boolean>();

    async function fetchAttachmentBytes(att: Attachment): Promise<ArrayBuffer> {
        if (!ui.detail) throw new Error('No message');
        const url = attachmentUrl(ui.selectedPath, ui.detail.uid, att.id);
        const session = (await import('../lib/auth.svelte')).getSession();
        const res = await fetch(url, {
            headers: session ? { authorization: `Bearer ${session.token}` } : {}
        });
        if (!res.ok) throw new Error(`Download ${res.status}`);
        return res.arrayBuffer();
    }

    async function viewPdf(att: Attachment) {
        if (!ui.detail) return;
        pdfLoading = { ...pdfLoading, [att.id]: true };
        try {
            const bytes = await fetchAttachmentBytes(att);
            pdfPreview = { id: att.id, filename: att.filename || 'document.pdf', bytes };
        } catch (err) {
            showToast('error', `Couldn't open PDF: ${(err as Error).message}`);
        } finally {
            pdfLoading = { ...pdfLoading, [att.id]: false };
        }
    }
    function closePdf() { pdfPreview = null; }

    async function openPdfForm(attId: string) {
        if (!ui.detail) return;
        const att = ui.detail.attachments.find((a) => a.id === attId);
        if (!att) return;
        try {
            const bytes = await fetchAttachmentBytes(att);
            pdfFormFiller = { id: attId, filename: att.filename || 'form.pdf', bytes };
        } catch (err) {
            showToast('error', `Couldn't open form: ${(err as Error).message}`);
        }
    }
    function closePdfForm() { pdfFormFiller = null; }

    // Lazily scan the first PDF attachment for an AcroForm. Cap on PDF
    // size so we don't pull a 50 MB scanned manual through the proxy
    // just to discover it isn't a form. Caller deduped via $effect on uid.
    const PDF_SCAN_MAX_BYTES = 8 * 1024 * 1024;
    async function maybeShowPdfFormBanner(d: MessageDetail) {
        pdfFormBanner = null;
        const pdfs = d.attachments.filter(isPdf);
        for (const att of pdfs) {
            const key = `${d.uid}:${att.id}`;
            const memo = pdfFormSeen.get(key);
            if (memo === false) continue; // already scanned, no form
            if (memo === true) {
                pdfFormBanner = { attId: att.id, filename: att.filename || 'form.pdf' };
                return;
            }
            if (att.size && att.size > PDF_SCAN_MAX_BYTES) continue;
            try {
                const bytes = await fetchAttachmentBytes(att);
                const { hasPdfForm } = await import('../lib/pdf-form');
                const has = await hasPdfForm(bytes);
                pdfFormSeen.set(key, has);
                if (has) {
                    pdfFormBanner = { attId: att.id, filename: att.filename || 'form.pdf' };
                    return;
                }
            } catch {
                pdfFormSeen.set(key, false);
            }
        }
    }
    $effect(() => {
        if (ui.detail) {
            void maybeShowPdfFormBanner(ui.detail);
        }
    });

    function isImage(att: Attachment): boolean {
        return (att.contentType || '').toLowerCase().startsWith('image/');
    }

    function isEml(att: Attachment): boolean {
        const t = (att.contentType || '').toLowerCase();
        const n = (att.filename || '').toLowerCase();
        return t === 'message/rfc822' || t === 'application/octet-stream' && n.endsWith('.eml')
            || n.endsWith('.eml');
    }

    let emlPreview = $state<{ id: string; subject: string; from: string; to: string; date: string; text: string; html: string | null } | null>(null);
    let emlLoading = $state<Record<string, boolean>>({});

    async function viewEml(att: Attachment) {
        if (!ui.detail) return;
        emlLoading = { ...emlLoading, [att.id]: true };
        try {
            // Fetch the raw attachment bytes through the existing
            // download endpoint, then parse client-side with eml-parse-js.
            const res = await fetch(attachmentUrl(ui.selectedPath, ui.detail.uid, att.id), {
                headers: authState.activeUser ? { authorization: `Bearer ${(await import('../lib/auth.svelte')).getSession()?.token || ''}` } : {}
            });
            const bytes = await res.text();
            const eml = await import('eml-parse-js');
            // eml-parse-js exposes a callback-style read; wrap in a Promise.
            const parsed = await new Promise<Record<string, unknown>>((resolve, reject) => {
                const fn = (eml as unknown as { readEml: (s: string, cb: (e: Error | null, p: Record<string, unknown>) => void) => void }).readEml;
                fn(bytes, (err, p) => (err ? reject(err) : resolve(p)));
            });
            emlPreview = {
                id: att.id,
                subject: String((parsed.subject as string) || '(no subject)'),
                from: String(((parsed.from as { email?: string; name?: string })?.name) || (parsed.from as { email?: string })?.email || parsed.from || ''),
                to: Array.isArray(parsed.to)
                    ? (parsed.to as { email?: string }[]).map((p) => p.email || '').filter(Boolean).join(', ')
                    : String((parsed.to as { email?: string })?.email || parsed.to || ''),
                date: String((parsed.date as string) || ''),
                text: String((parsed.text as string) || ''),
                html: typeof parsed.html === 'string' ? parsed.html : null
            };
        } catch (err) {
            showToast('error', `Couldn't open .eml: ${(err as Error).message}`);
        } finally {
            emlLoading = { ...emlLoading, [att.id]: false };
        }
    }
    function closeEmlPreview() { emlPreview = null; }

    function downloadHref(att: Attachment): string {
        if (!ui.detail) return '#';
        return attachmentUrl(ui.selectedPath, ui.detail.uid, att.id);
    }
    async function saveAttachmentToDriveFromDetail(att: Attachment) {
        if (!ui.detail) return;
        driveLoading = { ...driveLoading, [att.id]: true };
        try {
            await loadDriveConfig();
            const url = attachmentUrl(ui.selectedPath, ui.detail.uid, att.id);
            const session = (await import('../lib/auth.svelte')).getSession();
            const res = await fetch(url, {
                headers: session ? { authorization: `Bearer ${session.token}` } : {}
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            folderPickerBlob = blob;
            folderPickerAtt = att;
        } catch (err) {
            showToast('error', `Couldn't save to Drive: ${(err as Error).message}`);
        } finally {
            driveLoading = { ...driveLoading, [att.id]: false };
        }
    }

    async function onFolderPicked(path: string) {
        if (!folderPickerAtt || !folderPickerBlob) return;
        const filename = folderPickerAtt.filename || `attachment-${folderPickerAtt.id}`;
        await saveAttachmentToDrive(folderPickerBlob, filename, path);
        folderPickerAtt = null;
        folderPickerBlob = null;
    }

    function UNIQUE_TEST_FUNCTION_XYZ123() {
        return 'UNIQUE_TEST_STRING_XYZ123';
    }

    // True when the recipient list is exactly the logged-in user. We then
    // collapse "to <my email>" into "to me" so the header isn't redundant.
    function isOnlyToMe(list: { name: string | null; address: string | null }[] | undefined): boolean {
        const me = getMe();
        if (!me || !list || list.length !== 1) return false;
        return (list[0].address || '').toLowerCase() === me.toLowerCase();
    }
    async function doBlockSender(addr: string | null | undefined) {
        if (!addr) return;
        if (!confirm(`Block all mail from ${addr}?`)) return;
        moveOpen = false;
        try {
            await blockSender(addr);
            showToast('success', `Blocked ${addr}`);
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg || 'Could not block sender');
        }
    }

    // AI-suggested block: ask the model for the broadest sensible pattern
    // (usually the whole domain, or a subdomain wildcard) and confirm with
    // the user before applying. Falls back to the exact address when AI
    // isn't configured or declines.
    let aiBlockBusy = $state(false);
    async function doAiBlockSender(d: MessageDetail) {
        const addr = d.envelope.from?.[0]?.address;
        if (!addr || aiBlockBusy) return;
        moveOpen = false;
        aiBlockBusy = true;
        try {
            const { suggestBlockPattern } = await import('../lib/block-suggest');
            const suggestion = await suggestBlockPattern({
                from: addr,
                fromName: d.envelope.from?.[0]?.name || '',
                subject: d.envelope.subject || ''
            });
            const pattern = suggestion || addr;
            const scope = pattern === addr ? addr : pattern;
            if (!confirm(`Block all mail matching ${scope}?`)) return;
            await blockSender(pattern);
            showToast('success', `Blocked ${pattern}`);
        } catch (err) {
            // AI unavailable or failed — fall back to the exact address.
            if (confirm(`Couldn't get a suggestion — block ${addr} exactly?`)) {
                try {
                    await blockSender(addr);
                    showToast('success', `Blocked ${addr}`);
                } catch (e2) {
                    const msg = e2 instanceof ApiError ? (e2.detail || e2.title) : (e2 as Error).message;
                    showToast('error', msg || 'Could not block sender');
                }
            }
        } finally {
            aiBlockBusy = false;
        }
    }

    async function doAllowSender(addr: string | null | undefined) {
        if (!addr) return;
        moveOpen = false;
        try {
            await allowSender(addr);
            showToast('success', `Allowed ${addr}`);
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg || 'Could not allow sender');
        }
    }

    async function doBlockRecipient(addr: string | null | undefined) {
        if (!addr) return;
        moveOpen = false;
        try {
            await blockRecipient(addr);
            showToast('success', `Blocked mail to ${addr}`);
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg || 'Could not block recipient');
        }
    }

    function pickCatchallTo(d: { envelope?: { to?: { address: string | null }[] } } | null): string | null {
        const tos = d?.envelope?.to || [];
        const me = (authState.activeUser || '').toLowerCase();
        for (const t of tos) {
            const a = (t.address || '').toLowerCase();
            if (a && a !== me) return t.address;
        }
        return null;
    }

    function getMe(): string {
        return authState.activeUser || '';
    }

    // Old single-event suggest helper kept around for back-compat; the
    // new flow opens a 5-card picker first and only sets ui.suggestedEvent
    // once the user picks one.
    let calOptionsOpen = $state(false);
    let calOptions = $state<CalendarSuggestion[]>([]);
    let calOptionsError = $state<string | null>(null);
    let calOptionsAbort: AbortController | null = null;

    async function suggestEvent(d: MessageDetail) {
        if (ui.suggestLoading) return;
        if (calOptionsOpen) { closeCalOptions(); return; }
        calOptionsOpen = true;
        ui.suggestLoading = true;
        calOptions = [];
        calOptionsError = null;
        if (calOptionsAbort) calOptionsAbort.abort();
        calOptionsAbort = new AbortController();
        try {
            loadCalendar();
            const fromAddr = d.envelope.from?.[0]?.address || '';
            const fromName = d.envelope.from?.[0]?.name || '';
            const opts = await suggestCalendarOptions({
                subject: d.envelope.subject || '',
                from: fromName ? `${fromName} <${fromAddr}>` : fromAddr,
                body: d.text || stripHtml(d.html || '')
            }, { signal: calOptionsAbort.signal });
            calOptions = opts;
        } catch (err) {
            calOptionsError = (err as Error).message || 'Suggest failed';
        } finally {
            ui.suggestLoading = false;
        }
    }
    function closeCalOptions() {
        calOptionsOpen = false;
        if (calOptionsAbort) calOptionsAbort.abort();
        calOptionsAbort = null;
    }
    function pickCalOption(o: CalendarSuggestion) {
        if (!o.start) {
            showToast('info', 'That suggestion has no start time — open EventModal to fill in.');
        }
        ui.suggestedEvent = {
            title: o.title || o.label,
            start: o.start,
            end: o.end || o.start,
            allDay: o.allDay,
            location: o.location,
            description: o.description
        };
        closeCalOptions();
    }
    // Keep the old single-shot path available — handy when the user
    // wants to skip the picker or for unit tests.
    void suggestEventFromEmail;

    // Best-effort plain-text fallback when the message is HTML-only. The
    // sanitizer would be heavy; a tag strip is enough to feed the LLM.
    function stripHtml(html: string): string {
        return html
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 8000);
    }

    // Combined SPF/DKIM/DMARC verdict for the sender chip. Returns the
    // icon to draw + a hover tooltip explaining each check. Padlock when
    // every check that ran passed; skull when any explicit fail; warning
    // dot when nothing's verifiable.
    type AuthOverall = { icon: string; label: string; tone: 'pass' | 'fail' | 'soft' | 'unknown'; tooltip: string };
    function authOverall(auth: NonNullable<MessageDetail['auth']>): AuthOverall {
        const verdicts = [
            { name: 'SPF',   v: auth.spf },
            { name: 'DKIM',  v: auth.dkim },
            { name: 'DMARC', v: auth.dmarc }
        ];
        const ran = verdicts.filter((x) => x.v && x.v !== 'none');
        const failed = ran.filter((x) => x.v === 'fail' || x.v === 'permerror');
        const soft = ran.filter((x) => x.v === 'softfail' || x.v === 'temperror' || x.v === 'neutral');
        const passed = ran.filter((x) => x.v === 'pass');

        const lines = verdicts.map((x) => `${x.name}: ${x.v || 'not checked'}`).join('\n');
        if (failed.length > 0) {
            return {
                icon: '☠',
                label: 'Sender authentication failed',
                tone: 'fail',
                tooltip: `Sender authentication FAILED — treat with extreme caution.\n${lines}`
            };
        }
        if (passed.length > 0 && soft.length === 0) {
            return {
                icon: '🔒',
                label: 'Sender authenticated',
                tone: 'pass',
                tooltip: `Sender passes authentication.\n${lines}`
            };
        }
        if (soft.length > 0) {
            return {
                icon: '⚠',
                label: 'Sender authentication weak',
                tone: 'soft',
                tooltip: `Sender authentication is weak — some checks didn't fully pass.\n${lines}`
            };
        }
        return {
            icon: '?',
            label: 'Sender authentication unknown',
            tone: 'unknown',
            tooltip: `Receiving MTA didn't surface SPF/DKIM/DMARC results for this message.`
        };
    }

    // How many indicator bullets fit in the floating warning bubble
    // before it stops being a glance and becomes a wall of text. The
    // full list is always in the blocking phishing-overlay card, so
    // nothing is lost by capping it here.
    const BUBBLE_INDICATOR_LIMIT = 3;
    const INDICATOR_MAX_CHARS = 120;

    // The model returns `indicators` — its own list of specific red
    // flags — and until now the warning bubble showed only the one-line
    // `reasoning`. A user told "looks like a scam" with no reason can't
    // calibrate: they either trust the verdict blindly or ignore it
    // entirely. The reasons are already being paid for.
    //
    // Trimmed because models occasionally emit a whole paragraph per
    // bullet; a 300-char bullet destroys the bubble's scannability.
    type ScanIndicators = { items: string[]; total: number; overflow: number };
    function scanIndicators(list: string[] | null | undefined): ScanIndicators {
        const all = (Array.isArray(list) ? list : [])
            .map((s) => String(s ?? '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        return {
            items: all.slice(0, BUBBLE_INDICATOR_LIMIT).map((s) => (
                s.length > INDICATOR_MAX_CHARS ? `${s.slice(0, INDICATOR_MAX_CHARS - 1).trimEnd()}…` : s
            )),
            total: all.length,
            overflow: Math.max(0, all.length - BUBBLE_INDICATOR_LIMIT)
        };
    }

    // `confidence` is the model's confidence in its *phishing* call, NOT
    // in the message being safe. So a "clean" verdict at confidence 0.05
    // means "95% sure this isn't phishing" — a strong result — while 0.6
    // means the model is genuinely torn. The old tooltip said "95% safe"
    // for the first case, which is arithmetically right and
    // informationally useless: it presented a decisive result and a
    // coin-flip identically.
    //
    // Both thresholds stay user-tunable and their DEFAULTS are untouched
    // — what counts as flagged is still entirely the floor's job. This
    // only changes how a verdict that did NOT cross the floor is
    // described, so no verdict flips as a result.
    // One threshold, not two. Below this the model is close enough to
    // calling it phishing that the "clean" tick is not earned, even
    // though the floor says don't flag.
    const NEAR_MISS_RATIO = 0.6;

    type ScanClaim = { label: string; detail: string; confident: boolean };
    function scanClaim(
        flagged: boolean,
        confidence: number,
        floor: number,
        positiveWord: string,
        cleanWord: string
    ): ScanClaim {
        const c = Math.max(0, Math.min(1, confidence || 0));
        if (flagged) {
            // Already crossed the floor, so the model was at least that
            // sure — the number means what it looks like it means.
            return {
                label: positiveWord,
                detail: `${Math.round(c * 100)}% confidence this is phishing.`,
                confident: true
            };
        }
        // Not flagged. Two cases were previously rendered identically as
        // a reassuring green tick:
        //   c < threshold  — the model put real weight on "phishing"
        //                     but not enough to cross the floor
        //   c ≈ 0          — the model was decisive that this is clean
        if (c >= floor * NEAR_MISS_RATIO) {
            return {
                label: 'Near miss',
                detail: `${Math.round(c * 100)}% phishing confidence — under your ${Math.round(floor * 100)}% threshold, so not flagged, but closer than a clean result. Read it before clicking anything.`,
                confident: false
            };
        }
        return {
            label: cleanWord,
            detail: `Scanned — model puts phishing odds at ${Math.round(c * 100)}%.`,
            confident: true
        };
    }
</script>

<svelte:window
    onclick={onWindowClick}
    onkeydowncapture={(e) => {
        if (e.key !== 'Escape') return;
        // The AI menu and the two popovers it opens are dismissed by the same
        // Escape contract as the Move menu: swallow the key so Layout's global
        // handler does not also clear the selection and tear down the reading
        // pane the user was reading. Topmost first — a popover opened from
        // the menu sits above it, so that is what Escape should close.
        if (aiToolsOpen) {
            e.preventDefault();
            e.stopPropagation();
            closeAiTools();
            return;
        }
        if (calOptionsOpen) {
            e.preventDefault();
            e.stopPropagation();
            closeCalOptions();
            return;
        }
        if (aiMenuOpen) {
            e.preventDefault();
            e.stopPropagation();
            aiMenuOpen = false;
            return;
        }
        if (!moveOpen) return;
        // Same two-stage Escape contract as the message-list context menu
        // (see MessageList.svelte): while the folder submenu is open, stand
        // down and let MenuSubmenu consume the key at the target, so the
        // FIRST Escape dismisses the submenu and only the second closes the
        // Move menu.
        //
        // Without this, Escape while the Move menu was open fell through to
        // Layout's global handler, which uses Escape to clear the selection
        // and then close the reading pane — so dismissing a dropdown tore
        // down the message you were looking at.
        if (document.querySelector('.detail [data-submenu-open="true"]')) return;
        e.preventDefault();
        e.stopPropagation();
        moveOpen = false;
    }}
/>

<section class="detail" aria-label="Message detail">
    {#if !shown && !ui.detailLoading && !ui.detailError}
        <div class="empty muted">
            <div class="empty-icon" aria-hidden="true">
                <Icon name="mail" size={36} />
            </div>
            <p class="empty-title">Select a message to read</p>
            <p class="empty-hint">
                Tip — use <kbd>j</kbd> / <kbd>k</kbd> to navigate, <kbd>Enter</kbd> to open
            </p>
        </div>
    {:else if !shown && ui.detailLoading}
        <div class="empty"><div class="spinner"></div></div>
    {:else if ui.detailError && !shown}
        <div class="empty error" role="alert">{ui.detailError}</div>
    {:else if shown}
        {@const d = shown}
        {@const _isTrack = isTrackingEmail(d.envelope.subject)}
        {@const _isSms = isSmsMessage({
            from: d.envelope.from,
            smsSenders: capabilities.server?.smsSenders
        })}
        {@const _isNotice = isNotificationMessage({
            from: d.envelope.from,
            subject: d.envelope.subject,
            notificationSenders: capabilities.server?.notificationSenders,
            smsSenders: capabilities.server?.smsSenders
        })}
        {@const _vipFrom = isVipAddress([d.envelope.from?.[0]?.address])}
        {@const _vipTo = _vipFrom ? null : isVipAddress([
            ...((d.envelope.to || []).map((a) => a.address)),
            ...((d.envelope.cc || []).map((a) => a.address))
        ])}
        {#key d.uid}
        <div class="detail-swap" in:fade={{ duration: 140 }}>
        <header class="detail-header">
            <div class="back" >
                <button
                    type="button"
                    class="btn btn-ghost mobile-back"
                    onclick={() => { ui.selectedUid = null; ui.detail = null; }}
                    aria-label="Back to list"
                >
                    <Icon name="chevronLeft" size={16} /> Back
                </button>
            </div>
            {#if _isNotice}
                <div class="notice-head" data-testid="detail-notice">
                    <NotificationBubble
                        subject={d.envelope.subject || '(no subject)'}
                        date={d.internalDate || d.envelope.date}
                        kind={_isSms ? 'sms' : (_isTrack ? 'tracking' : 'alert')}
                    />
                    {#if _isSms}
                        <span class="sms-noreply" title="Replies to SMS-gateway addresses go nowhere — disabled.">
                            <Icon name="info" size={11} /> Reply disabled — SMS gateway
                        </span>
                    {/if}
                </div>
            {/if}
            <h2 class="subject" class:spy-tracked-subject={_isTrack} class:hidden-when-notice={_isNotice} data-testid="detail-subject">
                {#if _isTrack}
                    <span class="spy-mark" title="Open-tracking notification" aria-label="Tracking notification"><Icon name="spy" size={16} /></span>
                {/if}
                {d.envelope.subject || '(no subject)'}
            </h2>
            <div class="meta-row" class:hidden-when-notice={_isNotice}>
                <span class="avatar-with-vip">
                    <Avatar
                        email={d.envelope.from?.[0]?.address}
                        name={d.envelope.from?.[0]?.name}
                        size={44}
                        title={d.envelope.from?.[0]?.name || d.envelope.from?.[0]?.address || undefined}
                    />
                    {#if _vipFrom}
                        <VipBadge match={_vipFrom} direction="from" size={16} />
                    {:else if _vipTo}
                        <VipBadge match={_vipTo} direction="to" size={16} />
                    {/if}
                </span>
                <div class="meta-text">
                    <div class="meta-line">
                        <span class="from-name">{d.envelope.from?.[0]?.name || d.envelope.from?.[0]?.address || '(unknown)'}</span>
                        {#if d.envelope.from?.[0]?.name && d.envelope.from?.[0]?.address}
                            <span class="from-addr muted">&lt;{d.envelope.from[0].address}&gt;</span>
                        {/if}
                        {#if d.auth}
                            {@const overall = authOverall(d.auth)}
                            <span
                                class={`auth-badge auth-${overall.tone}`}
                                title={overall.tooltip}
                                aria-label={overall.label}
                                data-testid="sender-auth-badge"
                            >
                                {#if overall.tone === 'fail'}
                                    <!-- Dripping skull-and-crossbones for SPF/DKIM/DMARC fails.
                                         Two red drips animate falling and growing — meant
                                         to make a forged sender unmissable. -->
                                    <svg class="bloody-skull" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                                        <g class="skull-glyph">
                                            <path d="M12 3c-4.4 0-8 3.4-8 7.6 0 2 .8 3.7 2 5v2c0 .8.6 1.4 1.4 1.4H8v1.5c0 .3.2.5.5.5h2c.3 0 .5-.2.5-.5V19h2v1.5c0 .3.2.5.5.5h2c.3 0 .5-.2.5-.5V19h.6c.8 0 1.4-.6 1.4-1.4v-2c1.2-1.3 2-3 2-5C20 6.4 16.4 3 12 3z" fill="currentColor"/>
                                            <circle cx="9" cy="11" r="1.6" fill="#1a0303"/>
                                            <circle cx="15" cy="11" r="1.6" fill="#1a0303"/>
                                            <path d="M10 16.4l1-1.4 1 1.4 1-1.4 1 1.4" stroke="#1a0303" stroke-width="0.7" stroke-linecap="round" fill="none"/>
                                        </g>
                                        <g class="blood">
                                            <ellipse class="drip drip-l" cx="9" cy="20.5" rx="0.9" ry="1.6" fill="#a30000"/>
                                            <ellipse class="drip drip-r" cx="15" cy="20.5" rx="0.9" ry="1.6" fill="#a30000"/>
                                        </g>
                                    </svg>
                                {:else}
                                    {overall.icon}
                                {/if}
                            </span>
                        {/if}
                    </div>
                    <div class="meta-line muted small">
                        <span class="meta-item meta-date" title={formatFullDate(d.internalDate || d.envelope.date)}>
                            {compactHeaderDate(d.internalDate || d.envelope.date)}
                        </span>
                        {#if !isOnlyToMe(d.envelope.to)}
                            <span class="meta-item">to {formatAddressList(d.envelope.to) || '(undisclosed)'}</span>
                        {:else}
                            <span class="meta-item">to me</span>
                        {/if}
                        {#if d.envelope.cc && d.envelope.cc.length}
                            <span class="meta-item">cc {formatAddressList(d.envelope.cc)}</span>
                        {/if}
                    </div>
                </div>
                <div class="actions">
                    {#if !_isSms}
                    <div class="outlook-replies" role="group" aria-label="Reply actions">
                        <button
                            type="button"
                            class="btn btn-primary reply-btn"
                            onclick={() => onReply(d)}
                            title="Reply (r)"
                            data-testid="reply-btn"
                        >
                            <Icon name="reply" size={14} />
                            <span>Reply</span>
                        </button>
                        <button
                            type="button"
                            class="btn btn-secondary"
                            onclick={() => onReplyAll(d)}
                            title="Reply all (a)"
                            data-testid="reply-all-btn"
                        >
                            <Icon name="reply" size={14} />
                            <span>Reply all</span>
                        </button>
                        <button
                            type="button"
                            class="btn btn-secondary"
                            onclick={() => onForward(d)}
                            title="Forward (f)"
                            data-testid="forward-btn"
                        >
                            <Icon name="send" size={14} />
                            <span>Forward</span>
                        </button>
                    </div>
                    {/if}
                    <!-- ONE AI entry point for the whole reading pane.
                         The toolbar used to carry three overlapping buttons —
                         "AI Calendar", "Other AI" and "AI tools" — which read
                         as clutter and gave the user no hint which was the
                         main one. The single button below opens a menu that
                         lists every AI action, and the two popovers it hands
                         off to keep their own markup (and their own testids)
                         so neither their layout nor their tests had to move.

                         The menu shows when AI is available, which is a
                         superset of the two old conditions: the panel opener
                         keyed off `aiAvailable()` and the popovers off
                         `isChatConfigured()`, and every account that reaches
                         either of those also has AI configured. The calendar
                         item is additionally gated on `isChatConfigured()`
                         because that is what the suggestion request needs. -->
                    {#if settings.aiFeatures && aiAvailable()}
                        <div class="ai-menu-wrap">
                            <button
                                type="button"
                                class="btn btn-secondary ai-btn-other"
                                onclick={toggleAiMenu}
                                aria-haspopup="menu"
                                aria-expanded={aiMenuOpen}
                                title="AI tools, calendar and suggested actions"
                                data-testid="ai-menu-btn"
                            >
                                <Icon name="sparkles" size={12} /> AI
                                <Icon name="chevronDown" size={11} />
                            </button>
                            {#if aiMenuOpen}
                                <div
                                    class="ai-menu-pop"
                                    role="menu"
                                    aria-label="AI actions"
                                    data-testid="ai-menu-pop"
                                    onclick={(e) => e.stopPropagation()}
                                >
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="ai-menu-item"
                                        onclick={() => { aiMenuOpen = false; onAi(); }}
                                        data-testid="ai-tools-btn"
                                    >
                                        <span class="ai-menu-icon"><Icon name="sparkles" size={13} /></span>
                                        <span class="ai-menu-text">
                                            <span class="ai-menu-label">AI tools</span>
                                            <span class="ai-menu-hint muted small">Summarize, draft, translate, actions</span>
                                        </span>
                                    </button>
                                    {#if isChatConfigured()}
                                        <button
                                            type="button"
                                            role="menuitem"
                                            class="ai-menu-item"
                                            onclick={() => { aiMenuOpen = false; void suggestEvent(d); }}
                                            data-testid="suggest-event-btn"
                                        >
                                            <span class="ai-menu-icon"><Icon name="calendar" size={13} /></span>
                                            <span class="ai-menu-text">
                                                <span class="ai-menu-label">Suggest a calendar event</span>
                                                <span class="ai-menu-hint muted small">Propose ways to schedule this email</span>
                                            </span>
                                        </button>
                                    {/if}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="ai-menu-item"
                                        onclick={() => { aiMenuOpen = false; void openAiTools(d); }}
                                        data-testid="ai-other-btn"
                                    >
                                        <span class="ai-menu-icon"><Icon name="wand" size={13} /></span>
                                        <span class="ai-menu-text">
                                            <span class="ai-menu-label">Other AI actions</span>
                                            <span class="ai-menu-hint muted small">Suggested next steps for this email</span>
                                        </span>
                                    </button>
                                </div>
                            {/if}
                            <!-- The two popovers the menu hands off to. They keep
                                 their original bodies, styling and testids; the
                                 menu is now what opens them, so the opener
                                 buttons that used to sit beside it are gone.
                                 They live INSIDE the menu's wrapper so an empty
                                 one does not take a slot in the toolbar's flex
                                 row (it would show up as phantom gap), while
                                 `position: relative` still anchors each to the
                                 AI button. -->
                            <div class="cal-options-wrap">
                            {#if calOptionsOpen}
                                <div
                                    class="cal-options-pop"
                                    role="menu"
                                    data-testid="cal-options-pop"
                                    onclick={(e) => e.stopPropagation()}
                                >
                                    <div class="ai-tools-head">
                                        <div class="ai-tools-title">
                                            <Icon name="calendar" size={13} /> Pick an option
                                        </div>
                                        <button
                                            type="button"
                                            class="ai-tools-close"
                                            aria-label="Close"
                                            onclick={closeCalOptions}
                                        ><Icon name="close" size={12} /></button>
                                    </div>
                                    {#if ui.suggestLoading}
                                        <ul class="ai-tools-list">
                                            {#each [0, 1, 2, 3, 4] as i (i)}
                                                <li>
                                                    <div class="ai-tools-skel" style={`animation-delay: ${i * 80}ms;`}>
                                                        <span class="skel-icon"></span>
                                                        <span class="skel-bar" style={`width: ${[60, 70, 64, 80, 52][i]}%;`}></span>
                                                    </div>
                                                </li>
                                            {/each}
                                        </ul>
                                        <p class="muted small ai-tools-loading-text">
                                            <span class="ai-loading-dot"></span>
                                            Thinking up 5 ways to schedule this…
                                        </p>
                                    {:else if calOptionsError}
                                        <p class="ai-tools-error" role="alert">{calOptionsError}</p>
                                    {:else if calOptions.length === 0}
                                        <p class="muted small">No suggestions.</p>
                                    {:else}
                                        <ul class="ai-tools-list">
                                            {#each calOptions as o, i (i)}
                                                <li>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        class="ai-tools-action"
                                                        onclick={() => pickCalOption(o)}
                                                        data-testid={`cal-option-${i}`}
                                                    >
                                                        <span class="ai-tools-icon" aria-hidden="true">{o.icon || '📅'}</span>
                                                        <span class="ai-tools-action-text">
                                                            <span class="ai-tools-action-title">{o.label}</span>
                                                            {#if o.rationale}
                                                                <span class="ai-tools-action-rationale muted small">{o.rationale}</span>
                                                            {/if}
                                                        </span>
                                                    </button>
                                                </li>
                                            {/each}
                                        </ul>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                        <div class="ai-tools-wrap">
                            {#if aiToolsOpen}
                                <div
                                    class="ai-tools-pop"
                                    role="menu"
                                    data-testid="ai-tools-pop"
                                    onclick={(e) => e.stopPropagation()}
                                >
                                    <div class="ai-tools-head">
                                        <div class="ai-tools-title">
                                            <Icon name="wand" size={13} /> Other AI suggestions
                                        </div>
                                        <button
                                            type="button"
                                            class="ai-tools-close"
                                            aria-label="Close"
                                            onclick={closeAiTools}
                                        ><Icon name="close" size={12} /></button>
                                    </div>
                                    {#if aiToolsLoading}
                                        <!-- 3 shimmer placeholders matching the new compact list. -->
                                        <ul class="ai-tools-list">
                                            {#each [0, 1, 2] as i (i)}
                                                <li>
                                                    <div class="ai-tools-skel" style={`animation-delay: ${i * 80}ms;`}>
                                                        <span class="skel-icon"></span>
                                                        <span class="skel-bar" style={`width: ${[64, 80, 52][i]}%;`}></span>
                                                    </div>
                                                </li>
                                            {/each}
                                        </ul>
                                        <p class="muted small ai-tools-loading-text">
                                            <span class="ai-loading-dot"></span>
                                            Reading the email…
                                        </p>
                                    {:else if aiToolsError}
                                        <p class="ai-tools-error" role="alert">{aiToolsError}</p>
                                    {:else if aiToolsActions.length === 0}
                                        <p class="muted small">No suggestions.</p>
                                    {:else}
                                        <ul class="ai-tools-list">
                                            {#each aiToolsActions as a, i (i)}
                                                <li>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        class="ai-tools-action"
                                                        onclick={() => runAction(a, d)}
                                                        data-testid={`ai-action-${i}`}
                                                    >
                                                        <span class="ai-tools-icon" aria-hidden="true">{a.icon || '✨'}</span>
                                                        <span class="ai-tools-action-text">
                                                            <span class="ai-tools-action-title">{a.title}</span>
                                                            {#if a.web}
                                                                <span class="ai-tools-tag"><Icon name="globe" size={10} /> web</span>
                                                            {/if}
                                                        </span>
                                                    </button>
                                                </li>
                                            {/each}
                                        </ul>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                        </div>
                    {/if}
                    {#if settings.aiFeatures && !aiAvailable() && capabilities.loaded}
                        <button
                            type="button"
                            class="btn btn-secondary ai-btn-setup"
                            onclick={() => (ui.settingsOpen = true)}
                            title="No AI provider configured — open Settings to add yours"
                            data-testid="ai-setup-btn"
                        >
                            <Icon name="sparkles" size={12} /> Set up AI
                        </button>
                    {/if}
                    <button
                        type="button"
                        class="btn btn-ghost"
                        onclick={() => onArchive(d.uid)}
                        title="Archive (e)"
                        aria-label="Archive"
                        data-testid="archive-btn"
                    >
                        <Icon name="archive" size={14} />
                    </button>
                    {#if d.envelope.from?.[0]?.address}
                        <button
                            type="button"
                            class="btn btn-ghost danger-ghost"
                            onclick={() => doBlockSender(d.envelope.from?.[0]?.address)}
                            title={`Block ${d.envelope.from[0].address}`}
                            aria-label={`Block ${d.envelope.from[0].address}`}
                            data-testid="block-sender-quick-btn"
                        >
                            <Icon name="spam" size={14} />
                        </button>
                    {/if}
                    <button
                        type="button"
                        class="btn btn-ghost"
                        onclick={viewHeaders}
                        title="View headers"
                        aria-label="View headers"
                        data-testid="view-headers-btn"
                    >
                        <Icon name="fileText" size={14} />
                    </button>
                    <div class="more">
                        <button
                            type="button"
                            class="btn btn-ghost"
                            onclick={() => (moveOpen = !moveOpen)}
                            aria-haspopup="menu"
                            aria-expanded={moveOpen}
                            data-testid="move-btn"
                        >
                            <Icon name="move" size={14} /> Move
                        </button>
                        {#if moveOpen}
                            <ul class="menu" role="menu">
                                <li class="menu-section">Sender</li>
                                <li>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onclick={() => doBlockSender(d.envelope.from?.[0]?.address)}
                                        data-testid="block-sender-btn"
                                    ><Icon name="spam" size={13} /> Block {d.envelope.from?.[0]?.address || 'sender'}</button>
                                {#if settings.aiFeatures}
                                <li>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        disabled={aiBlockBusy}
                                        onclick={() => doAiBlockSender(d)}
                                        data-testid="ai-block-sender-btn"
                                    ><Icon name="sparkles" size={13} /> {aiBlockBusy ? 'Thinking…' : 'Block senders like this (AI)'}</button>
                                </li>
                                {/if}
                                <li>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onclick={() => doAllowSender(d.envelope.from?.[0]?.address)}
                                        data-testid="allow-sender-btn"
                                    ><Icon name="star" size={13} /> Allow {d.envelope.from?.[0]?.address || 'sender'}</button>
                                </li>
                                {#if pickCatchallTo(d)}
                                    {@const catchallTo = pickCatchallTo(d)}
                                    <li class="menu-section">Recipient (catch-all)</li>
                                    <li>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onclick={() => doBlockRecipient(catchallTo)}
                                            data-testid="block-recipient-btn"
                                        ><Icon name="spam" size={13} /> Block mail to {catchallTo}</button>
                                    </li>
                                {/if}
                                <!-- Same MenuSubmenu as the message-list
                                     context menu, so hover intent, keyboard
                                     handling and edge-flipping are literally
                                     the same code here. The folder list was
                                     previously dumped inline, which made this
                                     menu grow without bound — an account with
                                     40 mailboxes got a 40-item dropdown that
                                     pushed Block/Allow off the bottom of a
                                     320px max-height scroller. -->
                                <MenuSubmenu
                                    label="Move to folder"
                                    icon="move"
                                    items={moveTargets}
                                    onSelect={(path) => { moveOpen = false; onMove(d.uid, path); }}
                                    testid="detail-move"
                                    width={200}
                                />
                            </ul>
                        {/if}
                    </div>
                    <button
                        type="button"
                        class="btn btn-danger"
                        onclick={() => onTrash(d.uid)}
                        title="Move to Trash"
                        aria-label="Move to Trash"
                    >
                        <Icon name="trash" size={14} />
                    </button>
                </div>
            </div>
            {#if d.html}
                <div class="view-toggle">
                    <div class="seg viewer-theme" title="Force a colour scheme on this message">
                        <button
                            class:active={viewerTheme === 'auto'}
                            onclick={() => (viewerTheme = 'auto')}
                            title="Auto"
                        >Auto</button>
                        <button
                            class:active={viewerTheme === 'light'}
                            onclick={() => (viewerTheme = 'light')}
                            aria-label="Render as light"
                            title="Render as light (helpful when an email assumes a white page)"
                        ><Icon name="sun" size={11} /></button>
                        <button
                            class:active={viewerTheme === 'dark'}
                            onclick={() => (viewerTheme = 'dark')}
                            aria-label="Render as dark"
                            title="Render as dark"
                        ><Icon name="moon" size={11} /></button>
                    </div>
                    {#if settings.proxyImages && hasRemoteImages(d.html)}
                        <span class="proxy-badge" class:warn={!isProxyHealthy()} title={isProxyHealthy() ? 'All images safely proxied' : 'Proxy cap reached — images loading directly'}>
                            <Icon name={isProxyHealthy() ? 'shield' : 'info'} size={10} />
                            {isProxyHealthy() ? 'Safely proxied' : 'Proxy limited'}
                        </span>
                    {/if}
                    {#if settings.phishingScan && phishingResult && !phishingScanning}
                        {@const flagged = phishingResult.isPhishing && phishingResult.confidence >= settings.phishingScanConfidenceFloor}
                        {@const phishClaim = scanClaim(flagged, phishingResult.confidence, settings.phishingScanConfidenceFloor, 'Phishing risk', 'Scam-scanned')}
                        <span
                            class="proxy-badge scam-badge"
                            class:warn={flagged}
                            class:hedged={!phishClaim.confident}
                            title={`Scam scan: ${phishClaim.detail}${phishingResult.reasoning ? ` ${phishingResult.reasoning}` : ''}`}
                            data-testid="scam-scanned-badge"
                        >
                            <Icon name={flagged ? 'shieldAlert' : phishClaim.confident ? 'shield' : 'info'} size={10} />
                            {phishClaim.label}
                        </span>
                        {#if settings.spamSuggest}
                            {@const spamFlagged = phishingResult.isSpam && phishingResult.spamConfidence >= settings.spamSuggestConfidenceFloor}
                            {@const spamClaim = scanClaim(spamFlagged, phishingResult.spamConfidence, settings.spamSuggestConfidenceFloor, 'Looks like spam', 'Spam-scanned')}
                            <span
                                class="proxy-badge spam-badge"
                                class:warn={spamFlagged}
                                class:hedged={!spamClaim.confident}
                                title={`Spam scan: ${spamClaim.detail}${phishingResult.spamReasoning ? ` ${phishingResult.spamReasoning}` : ''}`}
                                data-testid="spam-scanned-badge"
                            >
                                <Icon name={spamFlagged ? 'shieldAlert' : spamClaim.confident ? 'shield' : 'info'} size={10} />
                                {spamClaim.label}
                            </span>
                        {/if}
                    {/if}
                    <div class="seg">
                        <button class:active={showRaw === 'auto'} onclick={() => (showRaw = 'auto')}>HTML</button>
                        <button class:active={showRaw === 'text'} onclick={() => (showRaw = 'text')}>Plain</button>
                    </div>
                </div>
            {/if}

            <!-- The scanning state is NOT in the .scan-bubble-rail below,
                 and the reason is the whole point of this component.
                 That rail is `position: absolute; inset-inline: 0; top: 0`
                 over `.body`, and `.scam-bubble-floating` is a pill up to
                 `min(560px, 100%)` wide — so the scan used to sit ON TOP
                 of the first lines of the message for the whole scan. It
                 could not be moved to a hairline at the top edge of the
                 body either: the label and the ✕ still need ~20px of
                 real estate, and 20px of real estate inside `.body` is
                 20px of message text. So it docks into the header
                 chrome row, directly under `.view-toggle`, where it
                 reads as part of the message's own furniture instead of
                 a badge dropped on top of it, and where the body is
                 never covered by a single pixel.
                 Also note this state never blurred the message:
                 `.frame-wrap` gets `class:blurred` from
                 `phishingResult?.isPhishing`, and `phishingResult` is
                 still `null` while scanning (it is only assigned in the
                 `.then` at the end of the scan effect), so the pill was
                 the ONLY thing obstructing the message — which is why
                 the obstruction, not the styling, is what got fixed. -->
            <!-- The row is ALWAYS rendered, holding its height whether or
                 not a scan is running, so `.detail-header` measures
                 identically in both states. A strip that only appeared
                 while scanning would add ~25px to the header at scan
                 start and take it back at scan end — the message would
                 jump down and pop back up, which is the same defect the
                 in-flow era of this bubble was rejected for. The
                 reserved row is a few points of vertical space that is
                 always there; the jumping header was 25px of motion,
                 every message, every time. -->
            <div class="scan-strip-slot" class:active={phishingScanning && !phishingDismissed}>
                {#if phishingScanning && !phishingDismissed}
                    <div class="scan-strip" role="status" data-testid="scam-scanning-bubble" aria-live="polite">
                        <span class="scan-strip-track" aria-hidden="true">
                            <span class="scan-strip-sweep"></span>
                        </span>
                        <span class="scan-strip-text">AI scanning…</span>
                        <button
                            type="button"
                            class="scan-strip-close"
                            title="Skip the scan"
                            aria-label="Dismiss scan"
                            onclick={() => { phishingDismissed = true; }}
                        ><Icon name="close" size={10} /></button>
                    </div>
                {/if}
            </div>
        </header>

        <div class="body" data-testid="detail-body">
            <div class="scan-bubble-rail" aria-live="polite">
                {#if phishingResult?.isPhishing && (phishingResult?.confidence ?? 0) >= settings.phishingScanConfidenceFloor && !phishingDismissed}
                    <!-- {@const} must be a direct child of a block, not of a
                         plain element, so it sits here rather than inside the
                         bubble div. -->
                    {@const ind = scanIndicators(phishingResult?.indicators)}
                    <div class="phishing-bubble phishing-bubble-floating scam-bubble-floating" role="status" data-testid="phishing-warning-bubble">
                        <span class="smoke smoke-1" aria-hidden="true"></span>
                        <span class="smoke smoke-2" aria-hidden="true"></span>
                        <span class="smoke smoke-3" aria-hidden="true"></span>
                        <Icon name="shieldAlert" size={14} />
                        <span class="phish-bubble-stack">
                            <span class="phish-bubble-text">
                                <strong>Looks like a scam.</strong>
                                {phishingResult?.reasoning ? phishingResult.reasoning.slice(0, 140) : 'Be careful with links + attachments.'}
                            </span>
                            {#if ind.total > 0}
                                <!-- The model's own reasons, not just its verdict. A user
                                     who can see WHY is far better placed to judge the
                                     call than one shown only a confidence number. -->
                                <ul class="phish-indicators" data-testid="phish-indicators">
                                    {#each ind.items as indicator}
                                        <li>{indicator}</li>
                                    {/each}
                                </ul>
                                {#if ind.overflow > 0}
                                    <span class="phish-indicators-more" data-testid="phish-indicators-more">+{ind.overflow} more indicator{ind.overflow === 1 ? '' : 's'}</span>
                                {/if}
                            {/if}
                        </span>
                        <button
                            type="button"
                            class="phish-bubble-close"
                            title="Trust this sender — not a scam"
                            aria-label="Mark as trusted"
                            onclick={() => {
                                markTrusted(d.envelope.from?.[0]?.address);
                                phishingDismissed = true;
                                showToast('success', 'Marked as trusted — future mail from this sender won\'t be flagged.');
                            }}
                        ><Icon name="close" size={11} /></button>
                    </div>
                <!-- "Mixed signals" is a CONTINUOUS band, not one starting at a
                     hardcoded 0.4. The old floor here meant a not-phishing
                     verdict at, say, 0.3 that still carried indicators showed
                     the user NOTHING — the model had flagged concerns and we
                     dropped them, which defeats the point of surfacing
                     indicators at all. Any not-phishing result below the
                     user's own floor that carries a reason or an indicator
                     now surfaces. The user's configured floor is still the
                     only threshold that matters; this just removes the dead
                     band underneath it. -->
                {:else if phishingResult && !phishingResult.isPhishing && (phishingResult.confidence ?? 0) < settings.phishingScanConfidenceFloor && !phishingDismissed && ((phishingResult.indicators?.length ?? 0) > 0 || phishingResult.reasoning)}
                    <div class="scam-bubble scam-bubble-borderline scam-bubble-floating" role="status" data-testid="scam-borderline-bubble">
                        <span class="scam-shimmer" aria-hidden="true"></span>
                        <Icon name="shieldAlert" size={14} />
                        <span class="phish-bubble-text">
                            <strong>Mixed signals.</strong>
                            {phishingResult.reasoning ? phishingResult.reasoning.slice(0, 140) : 'Borderline — read carefully before clicking.'}
                        </span>
                        <button
                            type="button"
                            class="phish-bubble-close"
                            title="Got it"
                            aria-label="Dismiss"
                            onclick={() => { phishingDismissed = true; }}
                        ><Icon name="close" size={11} /></button>
                    </div>
                {/if}
                {#if settings.spamSuggest && phishingResult && phishingResult.isSpam && !phishingResult.isPhishing && (phishingResult.spamConfidence ?? 0) >= settings.spamSuggestConfidenceFloor && !spamDismissed}
                    <div class="spam-bubble spam-bubble-floating" role="status" data-testid="spam-suggest-bubble">
                        <Icon name="trash" size={14} />
                        <span class="spam-bubble-text">
                            <strong>Looks like spam.</strong>
                            {phishingResult.spamReasoning ? phishingResult.spamReasoning.slice(0, 120) : 'Move it out of the inbox?'}
                        </span>
                        <button
                            type="button"
                            class="spam-bubble-action"
                            disabled={spamMoving}
                            onclick={() => { markSpam(d.envelope.from?.[0]?.address); moveToSpam(d); }}
                            data-testid="spam-suggest-move-top"
                        >
                            {#if spamMoving}<span class="spinner"></span>{/if}
                            Move to Spam
                        </button>
                        <button
                            type="button"
                            class="spam-bubble-action ghost"
                            title="Tell the AI this isn't spam — future emails from this sender won't be flagged"
                            onclick={() => {
                                markTrusted(d.envelope.from?.[0]?.address);
                                spamDismissed = true;
                                showToast('success', 'Got it — won\'t flag mail from this sender as spam.');
                            }}
                            data-testid="spam-suggest-not-spam"
                        >Not spam</button>
                        <button
                            type="button"
                            class="spam-bubble-close"
                            title="Keep in inbox"
                            aria-label="Dismiss"
                            onclick={() => (spamDismissed = true)}
                        ><Icon name="close" size={11} /></button>
                    </div>
                {/if}
            </div>
            {#if pdfFormBanner}
                <div class="pdf-form-banner" data-testid="pdf-form-banner">
                    <Icon name="filePen" size={14} />
                    <span class="pdf-banner-text">
                        <strong>Fillable PDF form attached.</strong>
                        You can fill <em>{pdfFormBanner.filename}</em> right here.
                    </span>
                    <button
                        type="button"
                        class="btn btn-primary pdf-banner-btn"
                        onclick={() => openPdfForm(pdfFormBanner!.attId)}
                        data-testid="pdf-form-banner-try"
                    >
                        <Icon name="sparkles" size={12} /> Try now
                    </button>
                    <button
                        type="button"
                        class="banner-dismiss"
                        title="Dismiss"
                        aria-label="Dismiss form banner"
                        onclick={() => (pdfFormBanner = null)}
                    >
                        <Icon name="close" size={12} />
                    </button>
                </div>
            {/if}
            {#if viewMode(d) === 'html'}
                <!-- No `blurred` / remote-overlay branch any more: remote
                     images are always allowed, so there is no permission
                     state left for an overlay to describe. The frame only
                     blurs for a confirmed phishing hit. -->
                <div class="frame-wrap" class:blurred={phishingResult?.isPhishing && !phishingDismissed}>
                    <!-- `allow-scripts` is added ONLY while link checking is
                         on, and `allow-same-origin` never is. The shim needs
                         a script to cancel the click at all — a frame without
                         it is inert, and the only signal out of an inert
                         frame is the navigation completing, which is too late
                         to ask about it. Omitting allow-same-origin keeps the
                         frame on an opaque origin, so the script cannot read
                         our DOM, cookies or storage; it can only postMessage.
                         With the feature off, this attribute is byte-for-byte
                         what it was before link checking existed, so the extra
                         capability is opt-in rather than inherited. -->
                    <iframe
                        bind:this={bodyFrame}
                        title="Message body"
                        sandbox={linkCheckEnabled()
                            ? 'allow-popups allow-popups-to-escape-sandbox allow-scripts'
                            : 'allow-popups allow-popups-to-escape-sandbox'}
                        srcdoc={srcDoc}
                        referrerpolicy="no-referrer"
                        class="html-frame"
                    ></iframe>
                </div>

                <!-- The link-check confirmation. Mounted here rather than
                     at the component root so it is scoped to the body view
                     and tears down with it. `onProceed` opens from the
                     parent, because the frame's own click was already
                     cancelled by the shim. -->
                {#if pendingLink}
                    <LinkCheckPrompt
                        url={pendingLink.url}
                        label={pendingLink.label}
                        onProceed={openLinkNow}
                        onCancel={() => (pendingLink = null)}
                    />
                {/if}
            {:else if viewMode(d) === 'text'}
                <pre class="text-body" class:blurred={phishingResult?.isPhishing && !phishingDismissed}>{d.text || '(no text body)'}</pre>
            {:else}
                <div class="muted">(empty body)</div>
            {/if}

            {#if phishingResult?.isPhishing && !phishingDismissed}
                <div class="phishing-overlay" data-testid="phishing-overlay">
                    <div class="phishing-card">
                        <Icon name="shieldAlert" size={32} />
                        <h4 class="phishing-title">Phishing warning</h4>
                        <p class="phishing-reasoning">{phishingResult?.reasoning || 'This email may be a phishing attempt.'}</p>
                        {#if phishingResult?.indicators?.length}
                            <ul class="phishing-indicators">
                                {#each phishingResult.indicators as indicator}
                                    <li>{indicator}</li>
                                {/each}
                            </ul>
                        {/if}
                        <button
                            type="button"
                            class="btn btn-primary"
                            onclick={() => phishingDismissed = true}
                            data-testid="phishing-proceed"
                        >Proceed anyway</button>
                    </div>
                </div>
            {/if}
        </div>

        {#if d.attachments.length}
            <section class="attachments">
                <h3>
                    <Icon name="paperclip" size={13} />
                    <span>{d.attachments.length} {d.attachments.length === 1 ? 'attachment' : 'attachments'}</span>
                </h3>
                <ul>
                    {#each d.attachments as att (att.id)}
                        <li class="attachment">
                            <div class="att-thumb" aria-hidden="true">
                                <!-- These thumbnails are OUR OWN attachments,
                                     served from the mail server, not sender
                                     content — the image-permission gate that
                                     used to sit in front of them only ever
                                     described the message body. -->
                                {#if isImage(att)}
                                    <img src={downloadHref(att)} alt="" loading="lazy" />
                                {:else if (att.contentType || '').toLowerCase() === 'application/pdf'}
                                    <span class="thumb-icon pdf">PDF</span>
                                {:else}
                                    <Icon name="paperclip" size={16} />
                                {/if}
                            </div>
                            <div class="att-main">
                                <span class="att-name truncate" data-testid="attachment-filename-{att.id}">{att.filename || `(part ${att.id})`}</span>
                                <span class="att-meta muted">
                                    {att.contentType || 'application/octet-stream'} · {formatBytes(att.size || 0)}
                                </span>
                            </div>
                            <div class="att-actions">
                                {#if isOcrCandidate(att)}
                                    <button
                                        type="button"
                                        class="btn btn-ghost"
                                        onclick={() => viewOcr(att)}
                                        disabled={ocrLoading[att.id]}
                                    >
                                        {#if ocrLoading[att.id]}<span class="spinner"></span>{/if}
                                        <Icon name="sparkles" size={13} /> OCR
                                    </button>
                                {/if}
                                {#if isEml(att)}
                                    <button
                                        type="button"
                                        class="btn btn-ghost"
                                        onclick={() => viewEml(att)}
                                        disabled={emlLoading[att.id]}
                                        data-testid={`eml-view-${att.id}`}
                                    >
                                        {#if emlLoading[att.id]}<span class="spinner"></span>{/if}
                                        <Icon name="mail" size={13} /> Open
                                    </button>
                                {/if}
                                {#if isPdf(att)}
                                    <button
                                        type="button"
                                        class="btn btn-ghost"
                                        onclick={() => viewPdf(att)}
                                        disabled={pdfLoading[att.id]}
                                        data-testid={`pdf-view-${att.id}`}
                                    >
                                        {#if pdfLoading[att.id]}<span class="spinner"></span>{/if}
                                        <Icon name="eye" size={13} /> Open + draw
                                    </button>
                                {/if}
                                <button
                                    type="button"
                                    class="btn btn-ghost"
                                    onclick={() => saveAttachmentToDriveFromDetail(att)}
                                    disabled={driveLoading[att.id]}
                                >
                                    {#if driveLoading[att.id]}<span class="spinner"></span>{/if}
                                    <Icon name="drive" size={13} /> Save to Drive
                                </button>
                                <a class="btn btn-ghost" href={downloadHref(att)} download={att.filename || ''}>
                                    <Icon name="download" size={13} /> Download
                                </a>
                            </div>
                            {#if folderPickerAtt?.id === att.id}
                                <DriveFolderPicker
                                    onSelect={onFolderPicked}
                                    onCancel={() => { folderPickerAtt = null; folderPickerBlob = null; }}
                                />
                            {/if}
                            {#if ocrText[att.id]}
                                <pre class="ocr-output" data-testid={`ocr-${att.id}`}>{ocrText[att.id]}</pre>
                            {/if}
                        </li>
                    {/each}
                </ul>
            </section>
        {/if}
        </div>
        {/key}
    {/if}
</section>

{#if pdfPreview}
    {#await import('./editor/PdfViewer.svelte') then mod}
        <mod.default
            bytes={pdfPreview.bytes}
            filename={pdfPreview.filename}
            onClose={closePdf}
            onAttach={(file) => {
                ui.pendingAttachment = file;
                closePdf();
                if (ui.detail) onReply(ui.detail);
            }}
        />
    {/await}
{/if}

{#if pdfFormFiller}
    {#await import('./editor/PdfFormFiller.svelte') then mod}
        <mod.default
            bytes={pdfFormFiller.bytes}
            filename={pdfFormFiller.filename}
            onClose={closePdfForm}
            onAttach={(file) => {
                ui.pendingAttachment = file;
                closePdfForm();
                if (ui.detail) onReply(ui.detail);
            }}
        />
    {/await}
{/if}

{#if emlPreview}
    {@const eml = emlPreview}
    <div class="eml-overlay" onclick={(e) => { if (e.target === e.currentTarget) closeEmlPreview(); }} role="presentation">
        <div class="eml-dialog fade-in" role="dialog" aria-modal="true" aria-label="EML preview" data-testid="eml-preview">
            <header class="eml-head">
                <div>
                    <h2 class="eml-title">{eml.subject}</h2>
                    <p class="muted small">
                        From <strong>{eml.from}</strong>
                        {#if eml.to} · to {eml.to}{/if}
                        {#if eml.date} · {eml.date}{/if}
                    </p>
                </div>
                <button type="button" class="btn btn-ghost" onclick={closeEmlPreview} aria-label="Close">
                    <Icon name="close" size={14} />
                </button>
            </header>
            <div class="eml-body">
                {#if eml.html}
                    <iframe
                        title="EML preview"
                        sandbox=""
                        srcdoc={`<style>body{font-family:system-ui,sans-serif;color:#222;padding:16px;}img{max-width:100%}</style>${sanitizeHtml(eml.html, { allowRemoteImages: false })}`}
                        referrerpolicy="no-referrer"
                        class="eml-frame"
                    ></iframe>
                {:else}
                    <pre class="eml-text">{eml.text || '(empty)'}</pre>
                {/if}
            </div>
        </div>
    </div>
{/if}

{#if headersOpen}
    <div class="eml-overlay" onclick={(e) => { if (e.target === e.currentTarget) headersOpen = false; }} role="presentation">
        <div class="eml-dialog fade-in" role="dialog" aria-modal="true" aria-label="Message headers" data-testid="headers-preview">
            <header class="eml-head">
                <h2 class="eml-title">Message headers</h2>
                <button type="button" class="btn btn-ghost" onclick={() => headersOpen = false} aria-label="Close">
                    <Icon name="close" size={14} />
                </button>
            </header>
            <div class="eml-body">
                {#if headersLoading}
                    <div class="empty">
                        <span class="spinner" style="width:28px;height:28px"></span>
                        <p class="muted">Loading headers…</p>
                    </div>
                {:else}
                    <pre class="eml-text headers-text">{headersText}</pre>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .detail {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        background: var(--bg-surface);
    }
    /* Keyed wrapper that fades the new message in over the old one. */
    .detail-swap {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        min-width: 0;
    }
    .empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 40px;
        gap: 12px;
        color: var(--text-tertiary);
        text-align: center;
    }
    .empty.error { color: var(--danger); }
    .empty-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 64px;
        height: 64px;
        border-radius: 50%;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        color: var(--text-tertiary);
    }
    .empty-title {
        margin: 4px 0 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-secondary);
    }
    .empty-hint {
        margin: 0;
        font-size: 12px;
        color: var(--text-tertiary);
    }
    .empty-hint kbd {
        display: inline-block;
        padding: 1px 6px;
        font-family: var(--font-mono);
        font-size: 11px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-bottom-width: 2px;
        border-radius: var(--radius-xs);
        color: var(--text-secondary);
        margin: 0 2px;
    }
    .detail-header {
        flex: 0 0 auto;
        /* Kept deliberately tight: on a 640px-tall window the header used
         * to take half the pane, leaving the message itself ~320px. */
        padding: 12px 20px 10px;
        border-bottom: 1px solid var(--border-subtle);
    }
    /* Notification-bubble layout: hide the avatar+sender block but keep
       the action row visible so the user can still archive/reply. */
    .notice-head {
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
    }
    /* Top-of-body banner shown when an attached PDF has fillable form
       fields. Sits above the iframe so it can't be missed without being
       in-your-face. */
    .pdf-form-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        margin: 0 0 12px;
        background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--accent) 12%, var(--bg-surface)),
            color-mix(in srgb, #d268f4 8%, var(--bg-surface))
        );
        border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        border-radius: 12px;
        font-size: 13px;
        color: var(--text-primary);
    }
    .pdf-banner-text { flex: 1; min-width: 0; }
    .pdf-banner-text em {
        font-style: italic;
        color: var(--accent-text);
    }
    .pdf-banner-btn {
        flex-shrink: 0;
        padding: 5px 12px;
        font-size: 12.5px;
    }
    .banner-dismiss {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px; height: 24px;
        border-radius: 50%;
        background: transparent;
        border: 1px solid transparent;
        color: var(--text-tertiary);
    }
    .banner-dismiss:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    .hidden-when-notice { display: none !important; }
    .sms-noreply {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11.5px;
        color: var(--text-tertiary);
        font-style: italic;
    }
    .mobile-back { display: none; }
    @media (max-width: 900px) {
        .mobile-back { display: inline-flex; margin-bottom: 8px; }
    }
    .subject {
        margin: 0 0 9px;
        font-size: 19px;
        line-height: 1.25;
        letter-spacing: -0.015em;
        font-weight: 700;
        overflow-wrap: break-word;
    }
    .meta-row {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        flex-wrap: wrap;
    }
    .avatar-with-vip {
        position: relative;
        display: inline-flex;
        flex: 0 0 auto;
    }
    .meta-text { flex: 1; min-width: 200px; }
    .meta-line {
        display: flex;
        align-items: baseline;
        gap: 6px;
        flex-wrap: wrap;
        row-gap: 2px;
    }
    .meta-line.small { font-size: 12px; margin-top: 4px; }
    .from-name { font-weight: 600; font-size: 14px; }
    .from-addr { font-size: 12px; }

    /* SPF / DKIM / DMARC indicator next to the sender chip. Passes show
     * a padlock; failures show a skull. Hovering surfaces the per-check
     * verdict so the user can see WHY a sender flagged. */
    .auth-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        line-height: 1;
        padding: 2px 5px;
        border-radius: 999px;
        margin-left: 6px;
        cursor: help;
        white-space: pre-wrap;
        user-select: none;
        border: 1px solid transparent;
    }
    .auth-badge.auth-pass {
        background: color-mix(in srgb, #22c55e 14%, transparent);
        color: #15803d;
        border-color: color-mix(in srgb, #22c55e 28%, transparent);
    }
    .auth-badge.auth-fail {
        background: color-mix(in srgb, #ef4444 16%, transparent);
        color: #b91c1c;
        border-color: color-mix(in srgb, #ef4444 32%, transparent);
        font-weight: 700;
        padding: 0 4px;
    }
    .bloody-skull {
        display: block;
        overflow: visible;
    }
    .bloody-skull .drip {
        transform-origin: center top;
        animation: blood-drip 2.4s cubic-bezier(0.55, 0, 0.7, 1) infinite;
    }
    .bloody-skull .drip-r { animation-delay: 1.05s; }
    @keyframes blood-drip {
        0%   { transform: translateY(-1px) scaleY(0.45); opacity: 0; }
        15%  { transform: translateY(0)    scaleY(0.7);  opacity: 1; }
        65%  { transform: translateY(2.2px) scaleY(1.25); opacity: 1; }
        100% { transform: translateY(5px)  scaleY(1.5); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
        .bloody-skull .drip { animation: none; opacity: 1; }
    }
    .auth-badge.auth-soft {
        background: color-mix(in srgb, #f59e0b 16%, transparent);
        color: #92400e;
        border-color: color-mix(in srgb, #f59e0b 30%, transparent);
    }
    .auth-badge.auth-unknown {
        background: var(--bg-surface-alt, #ececef);
        color: var(--text-tertiary, #6e6e72);
    }
    :global(html.dark) .auth-badge.auth-pass,
    :global([data-theme="dark"]) .auth-badge.auth-pass {
        color: #86efac;
    }
    :global(html.dark) .auth-badge.auth-fail,
    :global([data-theme="dark"]) .auth-badge.auth-fail {
        color: #fca5a5;
    }
    :global(html.dark) .auth-badge.auth-soft,
    :global([data-theme="dark"]) .auth-badge.auth-soft {
        color: #fcd34d;
    }
    .meta-date { font-weight: 500; }
    /* Each meta-item carries its own leading bullet via ::before. When an
     * item wraps to a new line, its bullet wraps with it — no orphans. */
    .meta-item {
        display: inline-flex;
        align-items: center;
    }
    .meta-item + .meta-item::before {
        content: '';
        display: inline-block;
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: var(--text-tertiary);
        margin: 0 8px;
        opacity: 0.85;
    }
    .actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
        flex-wrap: wrap;
    }
    /* Icon-only actions sit shoulder to shoulder and are told apart mostly
       by glyph, so they need a real target and a focus ring that doesn't
       depend on colour alone. */
    .actions :global(.btn) {
        min-height: 32px;
        min-width: 32px;
    }
    .actions :global(.btn:focus-visible) {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
    }
    /* Delete is the one action here that can't be undone from the toolbar.
       Push it away from its neighbours so it can't be caught on the way to
       Move, and give it a slightly larger target. */
    .actions :global(.btn-danger) {
        margin-left: 10px;
        min-width: 38px;
    }
    @media (pointer: coarse) {
        .actions :global(.btn) {
            min-height: 44px;
            min-width: 44px;
        }
    }
    .ai-btn-other {
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--warning) 18%, var(--bg-surface)),
            color-mix(in srgb, var(--warning) 8%, var(--bg-surface)));
        border-color: color-mix(in srgb, var(--warning) 40%, var(--border-subtle));
        color: var(--warning);
        font-weight: 600;
        font-size: 11.5px;
        padding: 5px 10px;
    }
    .ai-btn-other:hover {
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--warning) 28%, var(--bg-surface)),
            color-mix(in srgb, var(--warning) 14%, var(--bg-surface)));
    }
    /* The AI menu shares .ai-tools-pop's box so the three popovers this
     * toolbar can raise read as one family rather than three unrelated
     * surfaces: same elevated background, hairline border, radius, shadow
     * and fade-in. The wrapper is `position: relative` so the menu and the
     * two popovers it hands off to all anchor to the same button. */
    .ai-menu-wrap, .ai-tools-wrap, .cal-options-wrap { position: relative; }
    .ai-menu-pop {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: auto;
        width: 300px;
        max-width: calc(100vw - 24px);
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 30;
        padding: 6px;
        animation: fade-in 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .ai-menu-item {
        display: flex;
        align-items: flex-start;
        gap: 9px;
        width: 100%;
        padding: 7px 8px;
        border-radius: var(--radius-sm);
        text-align: left;
        color: var(--text-primary);
    }
    .ai-menu-item:hover { background: var(--bg-hover); }
    .ai-menu-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .ai-menu-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        margin-top: 1px;
        color: var(--text-tertiary);
    }
    .ai-menu-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }
    .ai-menu-label {
        font-size: 12.5px;
        font-weight: 600;
        line-height: 1.3;
    }
    /* The hint is what tells three similar rows apart at a glance — "AI
     * tools" alone does not say whether it opens a panel, a calendar picker
     * or a suggestion list. */
    .ai-menu-hint {
        font-size: 11px;
        line-height: 1.35;
    }
    .cal-options-pop {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: auto;
        width: 360px;
        max-width: calc(100vw - 24px);
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 30;
        padding: 10px;
        animation: fade-in 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .ai-tools-action-rationale {
        display: block;
        margin-top: 2px;
        line-height: 1.35;
    }
    .ai-tools-pop {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: auto;
        width: 320px;
        max-width: calc(100vw - 24px);
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 30;
        padding: 10px;
        animation: fade-in 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .ai-tools-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
    }
    .ai-tools-title {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
    }
    .ai-tools-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: var(--radius-xs);
        color: var(--text-tertiary);
    }
    .ai-tools-close:hover { background: var(--bg-hover); color: var(--text-primary); }
    /* Moving-glass skeleton rows. The shimmer sweep is a translucent
     * gradient that scrolls left-to-right across each row, with a
     * cascading delay so they don't all flash in unison. */
    .ai-tools-skel {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 14px 12px 12px;
        border-radius: 12px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        overflow: hidden;
        min-height: 76px;
    }
    .ai-tools-skel::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(
            110deg,
            transparent 0%,
            color-mix(in srgb, var(--accent) 22%, transparent) 45%,
            color-mix(in srgb, #d268f4 18%, transparent) 55%,
            transparent 100%
        );
        transform: translateX(-100%);
        animation: skel-shimmer 1.6s ease-in-out infinite;
    }
    @keyframes skel-shimmer {
        0%   { transform: translateX(-100%); }
        100% { transform: translateX(100%); }
    }
    .ai-tools-skel .skel-icon {
        flex: 0 0 auto;
        width: 26px; height: 26px;
        border-radius: 50%;
        background: var(--accent-soft);
    }
    .ai-tools-skel .skel-bar {
        height: 10px;
        border-radius: 5px;
        background: var(--bg-surface-alt);
    }
    .ai-tools-loading-text {
        margin: 6px 0 0;
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .ai-loading-dot {
        display: inline-block;
        width: 6px; height: 6px;
        border-radius: 50%;
        background: var(--accent);
        animation: ai-loading-pulse 1.2s ease-in-out infinite;
    }
    @keyframes ai-loading-pulse {
        0%, 100% { transform: scale(1); opacity: 0.7; }
        50%      { transform: scale(1.4); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
        .ai-tools-skel::after,
        .ai-loading-dot { animation: none; }
    }
    /* AI Add-to-calendar button: glow like the draw button. */
    .ai-cal-btn {
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 18%, var(--bg-surface)),
            color-mix(in srgb, #d268f4 14%, var(--bg-surface)));
        border-color: color-mix(in srgb, var(--accent) 38%, var(--border-subtle));
        color: var(--accent-text);
        font-weight: 600;
        font-size: 11.5px;
        padding: 5px 10px;
        animation: ai-cal-glow 2.4s ease-in-out infinite;
    }
    .ai-cal-btn:hover {
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 28%, var(--bg-surface)),
            color-mix(in srgb, #d268f4 22%, var(--bg-surface)));
    }
    @keyframes ai-cal-glow {
        0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
        50%      { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) {
        .ai-cal-btn { animation: none; }
    }
    .ai-tools-error {
        margin: 4px 0;
        padding: 8px 10px;
        border-radius: var(--radius-sm);
        background: var(--danger-soft);
        color: var(--danger);
        font-size: 12.5px;
    }
    /* "Lego" layout for AI suggestions: a 2-column grid of chunky tiles
     * with rounded corners, a faint gradient, two studs at the top to give
     * the brick-like feel, and a click-press shadow. Skeleton + populated
     * cards share the same grid so layout doesn't shift. */
    .ai-tools-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .ai-tools-action {
        position: relative;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 10px 12px;
        text-align: left;
        border-radius: 10px;
        color: var(--text-primary);
        background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--accent) 6%, var(--bg-surface)),
            var(--bg-surface)
        );
        border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border-subtle));
        transition: transform 100ms ease-out, box-shadow 120ms ease-out, border-color 120ms ease-out, background 120ms ease-out;
    }
    .ai-tools-action:hover {
        transform: translateY(-1px);
        border-color: color-mix(in srgb, var(--accent) 38%, var(--border-subtle));
        box-shadow: 0 6px 14px -6px color-mix(in srgb, var(--accent) 40%, transparent);
        background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--accent) 14%, var(--bg-surface)),
            color-mix(in srgb, var(--accent) 3%, var(--bg-surface))
        );
    }
    .ai-tools-action:active { transform: translateY(0); }
    .ai-tools-icon {
        flex: 0 0 auto;
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        background: color-mix(in srgb, var(--accent) 16%, var(--bg-surface-alt));
        border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
        border-radius: 8px;
        font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
    }
    .ai-tools-action-text {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12.5px;
        min-width: 0;
    }
    .ai-tools-action-title { font-weight: 600; line-height: 1.25; }
    .ai-tools-tag {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 1px 6px;
        font-size: 9.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--bg-tag);
        color: var(--text-tertiary);
        border-radius: 8px;
    }

    .more {
        position: relative;
    }
    .menu {
        position: absolute;
        right: 0;
        top: calc(100% + 4px);
        min-width: 180px;
        max-height: 320px;
        overflow-y: auto;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        list-style: none;
        margin: 0;
        padding: 6px;
        z-index: 5;
    }
    .menu li button {
        width: 100%;
        text-align: left;
        padding: 8px 10px;
        border-radius: var(--radius-xs);
        color: var(--text-primary);
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .menu li button:hover { background: var(--bg-hover); }
    .menu-section {
        padding: 8px 10px 4px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
        font-weight: 700;
    }
    .menu-section:not(:first-child) {
        border-top: 1px solid var(--border-subtle);
        margin-top: 4px;
    }
    .menu li button {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .view-toggle {
        margin-top: 9px;
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
    }
    /* Toolbar badges. The family is chosen by tokens, never by a literal:
     * the two shipped skins (Outlook, Gmail) plus the user's accent layer
     * each repaint --accent/--warning/--danger, and a hardcoded blue here
     * survived the theme switch looking like a third, unowned colour. The
     * severity ladder, quiet → loud:
     *   clean+certain  = --success / --success-soft   (the proxy default)
     *   clean+uncertain = --text-tertiary / --bg-tag   ("I looked, saw a
     *                     maybe") — deliberately NOT green. A 45%-confidence
     *                     pass and a 2%-confidence pass both read "Scam-scanned"
     *                     today, which overstates the first.
     *   flagged         = --danger (phishing) / --warning (spam)
     * `.warn` alone stays amber because the image-proxy badge shares it for
     * "Proxy limited", which is a soft warning and not a danger. The
     * scam/spam variants therefore re-assert their own tone at higher
     * specificity instead of borrowing the shared one. */
    .proxy-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 6px;
        font-size: 9.5px;
        font-weight: 600;
        letter-spacing: 0.03em;
        color: var(--success);
        background: var(--success-soft);
        border: 1px solid color-mix(in srgb, var(--success) 35%, transparent);
        border-radius: 999px;
    }
    /* AI scam scan: the user's accent, so a clean scan reads as "the app
     * checked this" rather than as a safety claim. */
    .proxy-badge.scam-badge {
        color: var(--accent-text);
        background: var(--accent-soft);
        border-color: color-mix(in srgb, var(--accent) 38%, transparent);
    }
    /* AI spam scan: the same amber shelf the spam bubble uses, so the two
     * halves of one scan response share a visual language. */
    .proxy-badge.spam-badge {
        color: var(--warning);
        background: var(--warning-soft);
        border-color: color-mix(in srgb, var(--warning) 38%, transparent);
    }
    .proxy-badge.warn {
        color: var(--warning);
        background: var(--warning-soft);
        border-color: color-mix(in srgb, var(--warning) 35%, transparent);
    }
    /* Confirmed phishing outranks every other badge in the toolbar, so it
     * takes the danger token and a solid border rather than a tint. */
    .proxy-badge.scam-badge.warn {
        color: var(--danger);
        background: var(--danger-soft);
        border-color: color-mix(in srgb, var(--danger) 55%, transparent);
    }
    .proxy-badge.spam-badge.warn {
        color: var(--warning);
        background: var(--warning-soft);
        border-color: color-mix(in srgb, var(--warning) 55%, transparent);
    }
    /* "Scanned, but the model wasn't sure" — see the sibling's
     * `scanClaim`/`class:hedged`. A clean verdict reached below
     * 0.6 × the confidence floor used to render in exactly the same
     * accent pill as a 0.99 one, which overstates the weaker call.
     * Grey, dashed, and icon-swapped (markup picks `info` over
     * `shield`) is enough differentiation; it deliberately does NOT
     * go amber, because amber is this UI's "something is wrong"
     * signal and this is the absence of a result, not a result.
     * `.warn.hedged` is intentionally not a rule: scanClaim only
     * reports low confidence on the *unflagged* branch, so that
     * combination is unreachable and a style for it would be dead. */
    .proxy-badge.hedged {
        color: var(--text-tertiary);
        background: var(--bg-tag);
        border-color: var(--border-soft);
        border-style: dashed;
    }
    .seg {
        display: inline-flex;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 2px;
        margin-left: auto;
    }
    .seg button {
        padding: 4px 10px;
        font-size: 12px;
        border-radius: var(--radius-xs);
        color: var(--text-tertiary);
    }
    .seg button.active {
        background: var(--bg-surface);
        color: var(--text-primary);
        font-weight: 600;
        box-shadow: var(--shadow-sm);
    }
    .body {
        flex: 1;
        overflow-y: auto;
        background: var(--bg-surface);
    }
    .frame-wrap {
        position: relative;
        width: 100%;
        height: 100%;
        /* Low enough to fit inside a short window. At 320px the frame was
         * taller than the space left under the header, so .body scrolled
         * *and* the message scrolled inside it — two nested scrollbars for
         * one document. */
        min-height: 200px;
    }
    .html-frame {
        width: 100%;
        height: 100%;
        min-height: 200px;
        border: none;
        display: block;
        background: var(--bg-surface);
        transition: filter 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .html-frame.blurred {
        filter: blur(6px) saturate(0.85);
        pointer-events: none;
    }
    .text-body {
        white-space: pre-wrap;
        word-wrap: break-word;
        margin: 0 auto;
        padding: 22px 24px 32px;
        max-width: 760px;
        font-family: var(--font-sans);
        font-size: 15px;
        line-height: 1.65;
        color: var(--text-primary);
    }
    .outlook-replies {
        display: inline-flex;
        align-items: stretch;
        gap: 4px;
    }
    .outlook-replies .btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 12.5px;
        font-weight: 600;
        border-radius: var(--radius-sm);
    }
    .outlook-replies .reply-btn {
        background: var(--accent);
        color: var(--text-on-accent);
        box-shadow: var(--shadow-sm);
    }
    .outlook-replies .reply-btn:hover {
        filter: brightness(1.05);
        box-shadow: var(--shadow-md);
    }
    @media (max-width: 720px) {
        .outlook-replies .btn span { display: none; }
        .outlook-replies .btn { padding: 6px 10px; }
    }
    .attachments {
        flex: 0 0 auto;
        padding: 14px 24px 18px;
        border-top: 1px solid var(--border-subtle);
    }
    .attachments h3 {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--text-secondary);
        margin: 0 0 10px;
        letter-spacing: -0.01em;
    }
    .attachments ul {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .attachment {
        display: grid;
        grid-template-columns: 48px 1fr auto;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
    }
    .att-thumb {
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-base);
        border-radius: var(--radius-sm);
        overflow: hidden;
        color: var(--text-tertiary);
    }
    .att-thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .thumb-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.05em;
    }
    .thumb-icon.pdf {
        background: linear-gradient(135deg, #c0392b, #8d2417);
        color: #ffffff;
    }
    .thumb-icon.image {
        background: linear-gradient(135deg, #3498db, #2570a0);
        color: #ffffff;
    }
    .att-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .att-name { font-size: 13px; font-weight: 500; }
    .att-meta { font-size: 11px; }
    .att-actions { display: flex; gap: 4px; }
    .eml-overlay {
        position: fixed; inset: 0;
        background: var(--bg-overlay);
        display: flex; align-items: center; justify-content: center;
        padding: 20px; z-index: 80;
        backdrop-filter: blur(2px);
    }
    .eml-dialog {
        width: min(820px, 100%);
        max-height: calc(100vh - 40px);
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .eml-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 14px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .eml-title {
        margin: 0 0 4px;
        font-size: 16px;
        font-weight: 700;
        letter-spacing: -0.01em;
    }
    .eml-body {
        flex: 1;
        overflow: hidden;
        background: var(--bg-base);
    }
    .eml-frame {
        width: 100%;
        height: 60vh;
        min-height: 320px;
        border: 0;
        background: #fff;
    }
    .eml-text {
        margin: 0;
        padding: 18px 22px;
        white-space: pre-wrap;
        font-family: var(--font-sans);
        font-size: 14px;
        line-height: 1.6;
        max-height: 60vh;
        overflow-y: auto;
    }
    .ocr-output {
        grid-column: 1 / -1;
        margin: 8px 0 0;
        padding: 10px 12px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.55;
        max-height: 280px;
        overflow-y: auto;
        white-space: pre-wrap;
    }
    .headers-text {
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.55;
    }

    /* Phishing overlay */
    .phishing-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(88, 28, 135, 0.35);
        backdrop-filter: blur(8px) saturate(120%);
        -webkit-backdrop-filter: blur(8px) saturate(120%);
        z-index: 10;
        animation: fade-in 220ms ease forwards;
        border-radius: var(--radius-md);
    }
    .phishing-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        max-width: 420px;
        margin: 20px;
        padding: 24px 28px;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(147, 51, 234, 0.35);
        border-radius: var(--radius-lg);
        box-shadow: 0 18px 36px rgba(88, 28, 135, 0.22), 0 6px 12px rgba(88, 28, 135, 0.12);
        text-align: center;
        color: #4c1d95;
    }
    .phishing-card :global(.icon) {
        color: #7c3aed;
    }
    .phishing-title {
        margin: 0;
        font-size: 17px;
        font-weight: 700;
        color: #4c1d95;
    }
    .phishing-reasoning {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        color: #581c87;
    }
    .phishing-indicators {
        margin: 0;
        padding: 0 0 0 18px;
        text-align: left;
        font-size: 13px;
        line-height: 1.5;
        color: #581c87;
    }
    .phishing-indicators li {
        margin-bottom: 4px;
    }
    /* Skip button sits on the WHITE phishing-card, not the dark scrim.
       The earlier "white pill on white card" iteration was invisible.
       Now: high-contrast purple pill with a soft flash. */
    .body {
        position: relative;
    }
    .frame-wrap.blurred .html-frame,
    pre.text-body.blurred {
        filter: blur(6px);
        opacity: 0.5;
        user-select: none;
        pointer-events: none;
    }

    /* Soft floating phishing warning — hovers over the top of .body with
       three rising "smoke" puffs behind it, then fades itself out after
       ~8s unless the user clicks ✕ first. Overlay, not banner: no
       margins, so it takes no space in the flow.

       Tokens, not violet literals. This rule was pinned to #9333ea /
       #c084fc, so a Gmail-red or Outlook-blue user got a purple bubble
       that belonged to no skin in the picker — and because the skins
       paint their palette as INLINE vars on <html>, a literal here is
       also unreachable by any amount of theming. --danger is the
       family the app already reserves for "this is harmful", and it is
       the one that gets repainted per skin AND by the user's semantic
       overrides, so the warning follows the palette it lands in. */
    .phishing-bubble {
        position: relative;
        padding: 10px 14px;
        display: flex;
        align-items: center;
        gap: 10px;
        background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--danger) 18%, var(--bg-surface)),
            color-mix(in srgb, var(--danger) 10%, var(--bg-surface))
        );
        border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border-subtle));
        border-radius: var(--radius-md);
        color: var(--text-primary);
        font-size: 13px;
        overflow: hidden;
        animation: phish-bubble-in 360ms ease-out;
    }
    /* Rail of floating AI-scan bubbles — a real overlay, never a band in
     * the layout.
     *
     * Two earlier shapes both failed and the failures bracket the fix:
     *   sticky — rode along with the scroll, so an *optional* background
     *     scan parked itself on top of the message it was commenting on.
     *   in-flow — took its own space at the top of .body, so the message
     *     jumped down when the scan started and popped back up when the
     *     result replaced the scanning bubble.
     * Absolutely positioned over the body solves both: the bubbles take
     * no space at all (so nothing reflows, ever), and they hold still
     * while the user reads instead of travelling with the scroll. The
     * rail keeps a plain fade-in keyframe rather than the flow-era
     * `translateY(-6px)`, because in a column flex box that transform is
     * what nudged a same-height message down a few pixels mid-animation.
     * The bubble body itself is a fixed max-width pill that fades out on
     * its own (see the auto-dismiss timers in the script), so the overlay
     * is transient by construction — the rail is not a permanent banner.
     * The rail is click-through; only the bubbles catch pointer events. */
    .scan-bubble-rail {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 5;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        pointer-events: none;
        animation: scan-rail-in 260ms ease-out;
    }
    @keyframes scan-rail-in {
        from { opacity: 0; }
        to   { opacity: 1; }
    }
    /* Horizontal margins came from the in-flow era, where they centred the
       bubble in the body's content box. Absolute centering handles that. */
    .scan-bubble-rail > * { pointer-events: auto; margin-inline: 0; }

    /* Overlay-only fade-out: opacity alone. The flow-era `phish-bubble-out`
       also translated, which on a pinned overlay reads as the bubble
       sliding around over the message. */
    @keyframes scan-bubble-out {
        from { opacity: 1; }
        to   { opacity: 0; }
    }

    /* Floating bubble baseline: rounded pill, soft shadow to lift it
     * off the message content. Per-state gradients live below. */
    .scam-bubble-floating {
        max-width: min(560px, 100%);
        padding: 10px 14px;
        border-radius: 999px;
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13.5px;
        position: relative;
        overflow: hidden;
        animation: phish-bubble-in 360ms ease-out;
    }
    /* The loudest thing the scan can say, and the only one that sits over
     * a blurred message body. Severity ladder, quietest → loudest:
     *   scanning   = surface + soft border, no fill   (nothing concluded)
     *   borderline = surface + DASHED warning border   (something to note)
     *   spam       = warning-soft fill                (actionable suggestion)
     *   phishing   = danger-soft fill + solid border  (obvious, unmissable)
     *
     * Every fill mixes toward --bg-surface rather than being a saturated
     * gradient, which is what lets the ink stay --text-primary: a literal
     * gradient forces a fixed light ink (#fdf4ff) that is unreadable the
     * moment a skin's --danger lands light in dark mode, or dark in light
     * mode. Tinting the surface instead means the bubble is legible under
     * all four skin × theme combinations with no ink switch to get wrong. */
    .phishing-bubble-floating {
        max-width: min(560px, 100%);
        padding: 12px 14px;
        border-radius: var(--radius-lg);
        background:
            linear-gradient(
                135deg,
                color-mix(in srgb, var(--danger) 16%, var(--bg-surface)),
                color-mix(in srgb, var(--danger) 8%, var(--bg-surface))
            );
        border: 1px solid color-mix(in srgb, var(--danger) 55%, transparent);
        /* A solid danger bar on the leading edge: the severity is legible
         * from the shape alone, before a word is read. */
        border-left: 4px solid var(--danger);
        box-shadow: var(--shadow-md);
        color: var(--text-primary);
        font-size: 13.5px;
        /* The fade-out has to live on the -floating variant: it is declared
           after `.phishing-bubble`, so the duplicate keyframe list there was
           overriding it and the warning sat on the message forever. */
        animation: phish-bubble-in 360ms ease-out,
                   scan-bubble-out 700ms ease-in 8200ms forwards;
    }
    /* ---- Scanning strip -------------------------------------------------
     * Replaces the round `.scam-orb` pill that used to float over the
     * message. Three things changed at once, all from the same cause:
     * the old element was absolutely positioned INSIDE `.body` and up to
     * 560px wide, so for the whole scan it covered the first lines of
     * the mail.
     *
     * 1. It lives in the header (see the markup comment), so it takes
     *    zero pixels of the message.
     * 2. It is horizontal, because horizontal is how a left-to-right
     *    reader reads "this is progressing". A circle says "busy"; a
     *    sweeping segment on a long thin track says "moving forward",
     *    which is the truthful thing — the scan IS advancing through
     *    the message.
     * 3. No fill, no shadow, no backdrop. A tinted slab at the top of the
     *    body still reads as a badge lying on the mail; a 2px hairline
     *    with a travelling highlight reads as a status line belonging to
     *    the pane, and in a screenshot it is mistaken for a border.
     *
     * Tokens only. `--accent` is repainted per skin AND by the user's
     * semantic overrides, and every mix is toward `--bg-surface` rather
     * than toward a fixed light or dark, so the same declarations hold
     * across all four skin × theme combinations. */
    /* `.scan-strip-slot` reserves the row's height unconditionally. It is
     * the only thing in that 18px, and it is ALWAYS in the DOM, so the
     * header's height is a constant: the message below cannot move when a
     * scan starts or finishes. */
    .scan-strip-slot {
        display: flex;
        align-items: center;
        height: 18px;
        margin-top: 8px;
    }
    .scan-strip {
        display: flex;
        align-items: center;
        gap: 8px;
        /* Must FILL the slot. As a plain flex item the strip would
         * default to `flex: 0 1 auto` and shrink to its label's width,
         * leaving the track sitting on its 24px min-width as a stub
         * rather than a line across the pane — and the horizontal read
         * the user asked for depends on the track having real length. */
        flex: 1 1 auto;
        min-width: 0;
        font-size: 12px;
        line-height: 1.4;
        color: var(--text-secondary);
    }
    /* The track carries the motion; it is the only part that needs to be
     * wide, and `flex: 1` lets the label keep its natural width so the
     * row never wraps on a narrow pane. */
    .scan-strip-track {
        position: relative;
        flex: 1 1 auto;
        min-width: 24px;
        height: 2px;
        border-radius: 999px;
        overflow: hidden;
        background: color-mix(in srgb, var(--accent) 22%, var(--border-subtle));
    }
    .scan-strip-sweep {
        position: absolute;
        inset-block: 0;
        width: 38%;
        border-radius: inherit;
        background: linear-gradient(
            to right,
            transparent,
            var(--accent) 45%,
            var(--accent)
        );
        animation: scan-strip-sweep 1.5s cubic-bezier(0.5, 0, 0.5, 1) infinite;
    }
    @keyframes scan-strip-sweep {
        from { transform: translateX(-100%); }
        to   { transform: translateX(263%); }
    }
    .scan-strip-text { flex: 0 0 auto; white-space: nowrap; }
    .scan-strip-close {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        padding: 0;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: var(--text-tertiary);
        cursor: pointer;
    }
    .scan-strip-close:hover { background: var(--bg-hover); color: var(--text-primary); }
    /* Borderline state — "the model found something but not enough to
     * flag it". It sits BETWEEN the quiet scanning bubble and the
     * danger fill on purpose, so it uses the warning family with a
     * dashed edge: a solid border would be indistinguishable from a
     * real warning at a glance, and a fill as strong as the phishing
     * bubble's would train the user to discount the one that matters. */
    .scam-bubble-borderline {
        background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--warning) 14%, var(--bg-surface)),
            color-mix(in srgb, var(--warning) 7%, var(--bg-surface))
        );
        border: 1px dashed color-mix(in srgb, var(--warning) 55%, transparent);
        color: var(--text-primary);
        box-shadow: var(--shadow-md);
        /* The rail is absolutely positioned over the body, so a bubble that
           never leaves covers the opening lines and swallows clicks. */
        animation: phish-bubble-in 360ms ease-out,
                   scan-bubble-out 700ms ease-in 8200ms forwards;
    }
    .scam-bubble-borderline :global(svg) { color: var(--warning); flex-shrink: 0; }
    /* The shimmer swept a white gradient across the old saturated fill.
     * On a surface-tinted bubble that reads as a grey smear, so it now
     * sweeps the warning token itself and stays faint. */
    .scam-shimmer {
        position: absolute;
        inset: 0;
        background: linear-gradient(120deg,
            transparent 0%,
            color-mix(in srgb, var(--warning) 16%, transparent) 50%,
            transparent 100%);
        transform: translateX(-100%);
        animation: scam-shimmer 3.6s ease-in-out infinite;
        pointer-events: none;
    }
    @keyframes scam-shimmer {
        0%, 25%   { transform: translateX(-100%); }
        60%, 100% { transform: translateX(100%); }
    }
    /* Close buttons, once per bubble tone. These were all `rgba(255,255,255,
     * …)` + white ink, which was correct only because the bubbles used to
     * be saturated light gradients; now that they are surface-tinted, a
     * translucent white chip is invisible on a light skin. Each one
     * inverts against its own surface instead. */
    .phish-bubble-close {
        background: var(--bg-hover);
        color: var(--text-secondary);
    }
    .phish-bubble-close:hover {
        background: var(--bg-active);
        color: var(--text-primary);
    }
    .phishing-bubble-floating .phish-bubble-close {
        background: color-mix(in srgb, var(--danger) 18%, transparent);
        color: var(--text-primary);
    }
    .phishing-bubble-floating .phish-bubble-close:hover {
        background: color-mix(in srgb, var(--danger) 30%, transparent);
    }
    /* ghost-bob is gone. The floating warning used a 4s infinite
     * translateY loop purely to make it feel "alive"; on an overlay that
 * sits over the user's text it never stopped moving, and it was one more
     * infinite animation to suppress for reduced-motion users. The
     * severity is now carried by colour, the solid left bar and the
     * indicator list, none of which need motion. */
    /* Spam suggestion. Deliberately a full-strength but flat warning fill
     * rather than the old saturated orange gradient: the action here is
     * "Move to Spam", which is reversible and one click away, so it should
     * read as a suggestion the user can act on — not as the phishing
     * warning, which sits over a blurred body and demands trust. The
     * pill is square-cornered (`--radius-lg`, not 999px) so the two
     * severities differ in SHAPE as well as colour, which is what keeps
     * them distinguishable for a colour-blind reader. */
    .spam-bubble-floating {
        margin: 12px auto 6px;
        max-width: 560px;
        border-radius: var(--radius-lg);
        /* Same reason as the borderline bubble: it sits over the message. */
        animation: phish-bubble-in 360ms ease-out,
                   scan-bubble-out 700ms ease-in 8200ms forwards;
        background: var(--warning-soft);
        border: 1px solid color-mix(in srgb, var(--warning) 50%, transparent);
        border-left: 4px solid var(--warning);
        color: var(--text-primary);
        box-shadow: var(--shadow-md);
        padding: 10px 14px;
    }
    .spam-bubble-floating :global(svg) { color: var(--warning); }
    .phishing-bubble :global(svg) { color: var(--danger); flex-shrink: 0; }
    .phish-bubble-text { flex: 1; min-width: 0; }
    /* The floating bubble is a flex ROW (icon | text | close), so the
     * reasoning and the indicator list need a column wrapper to stack
     * without pushing the close button out of the bubble. */
    .phish-bubble-stack {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    /* The model's reasons, surfaced in the same bubble as its verdict. */
    .phish-indicators {
        margin: 2px 0 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 12.5px;
        line-height: 1.35;
    }
    .phish-indicators li {
        position: relative;
        padding-left: 14px;
        /* Inherits the bubble's own ink — the floating variant paints a
         * light gradient with #fdf4ff text, the non-floating variant a
         * surface-mixed tint, so a hardcoded colour would be wrong in
         * one of them and unreadable in the other. */
        opacity: 0.92;
    }
    .phish-indicators li::before {
        content: '';
        position: absolute;
        left: 3px;
        top: 0.55em;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.7;
    }
    .phish-indicators-more {
        font-size: 11.5px;
        opacity: 0.75;
    }
    /* A scan that did NOT clear the floor but came close. Deliberately
     * muted rather than alarming: it is not a warning, it is the absence
     * of a clean bill of health, and colouring it like a real flag would
     * train the user to ignore the badge that does matter.
     * Only the border/ink change — the badge keeps the same size and
     * position, so nothing shifts when a scan result lands. */
    .proxy-badge.hedged {
        border-style: dashed;
        border-color: var(--warning, currentColor);
        color: var(--text-secondary);
        opacity: 0.9;
    }
    .phish-bubble-close {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
    }
    /* Spam suggestion: cooler tone than the phishing warning so the two
       can sit on top of each other without competing visually. Stays
       until dismissed or the user clicks Move. */
    .spam-bubble {
        position: relative;
        padding: 9px 12px;
        display: flex;
        align-items: center;
        gap: 10px;
        background: var(--warning-soft);
        border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border-subtle));
        border-radius: var(--radius-md);
        color: var(--text-primary);
        font-size: 13px;
    }
    .spam-bubble :global(svg) { color: var(--warning); flex-shrink: 0; }
    .spam-bubble-text { flex: 1; min-width: 0; }
    /* "Move to Spam" is a solid, filled call to action. The amber ramp
     * is only two stops, so a full-strength --warning fill has no darker
     * --warning-hover to point at; the hover is built from mixing the
     * token toward the surface instead, which stays correct under a
     * repainted semantic palette rather than assuming #d97706. */
    .spam-bubble-action {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        font: inherit;
        font-weight: 600;
        font-size: 12.5px;
        background: var(--warning);
        /* --text-primary rather than a baked dark brown: --warning is a
         * light amber in every shipped skin, and the old #1f1300 was only
         * correct because the bubble behind it was always light. */
        color: var(--text-primary);
        border: none;
        border-radius: 999px;
        cursor: pointer;
    }
    .spam-bubble-action:hover {
        background: color-mix(in srgb, var(--warning) 82%, var(--text-primary));
    }
    .spam-bubble-action[disabled] { opacity: 0.6; cursor: progress; }
    .spam-bubble-close {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--warning) 20%, transparent);
        color: var(--text-primary);
        border: none;
        cursor: pointer;
    }
    .spam-bubble-close:hover {
        background: color-mix(in srgb, var(--warning) 34%, transparent);
    }
    /* The three rising "smoke" puffs behind the phishing warning.
     *
     * On prefers-reduced-motion they are hidden outright (opacity: 0),
     * not merely paused: the keyframe's resting state is opacity 0, so
     * "animation: none" alone would leave them parked at scale(0.7) in
     * whatever opacity the last frame left, and a frozen blur is still a
     * smear over the message text. The existing block already did this
     * correctly for .smoke; it did NOT for the other three, which is
     * what the widened query below fixes. */
    .smoke {
        position: absolute;
        bottom: -10px;
        width: 26px; height: 26px;
        border-radius: 50%;
        /* --danger, matching the bubble the puffs belong to. */
        background: radial-gradient(
            circle,
            color-mix(in srgb, var(--danger) 40%, transparent),
            color-mix(in srgb, var(--danger) 0%, transparent)
        );
        filter: blur(6px);
        animation: phish-smoke 3.2s ease-in-out infinite;
        pointer-events: none;
    }
    .smoke-1 { left: 12%;  animation-delay: 0s;   }
    .smoke-2 { left: 50%;  animation-delay: -1s;  }
    .smoke-3 { left: 80%;  animation-delay: -2s;  }
    @keyframes phish-smoke {
        0%   { transform: translateY(0) scale(0.7); opacity: 0; }
        30%  { opacity: 0.7; }
        100% { transform: translateY(-40px) scale(1.3); opacity: 0; }
    }
    @keyframes phish-bubble-in {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: 1; transform: translateY(0); }
    }
    /* Reduced motion, done properly and in ONE place.
     *
     * The audit this replaces found four real gaps:
     *  1. `.scam-bubble-borderline` and `.spam-bubble-floating`
     *     animate via `phish-bubble-in` + `scan-bubble-out … forwards`,
     *     but the old query only listed `.phishing-bubble` — so for those
     *     two bubbles NOTHING was suppressed. Only the floating PHISHING
     *     bubble was covered. (The third member of that set, the
     *     scanning bubble, no longer exists: it is now the header
     *     `.scan-strip`, which is not a bubble and has no auto-dismiss
     *     animation to preserve — it is removed when the scan resolves.)
     *  2. `animation: none` on the -floating variants also cancelled
     *     `scan-bubble-out`, whose 8.2s delay is the auto-dismiss. The
     *     JS timer still runs, but the element stayed fully opaque and
     *     clickable because the fade no longer existed — so under
     *     reduced motion the warning became PERMANENT. The fix is to
     *     keep the auto-dismiss animation and drop only the decorative
     *     ones.
     *  3. `.scan-bubble-rail` (the `scan-rail-in` fade) was never
     *     listed.
     *  4. `.phishing-skip` and the orb/shimmer had their own separate
     *     query blocks; consolidating means a future bubble cannot be
     *     added and silently left un-animated.
     *
     *
     * The bubbles' auto-dismiss is NOT a JS timer — there is no setTimeout
     * anywhere in this component. The `scan-bubble-out 700ms ease-in
     * 8200ms forwards` animation IS the dismiss. So the per-bubble list
     * below is split rather than blanket-applied:
     *   - decorative (infinite loops) and entrances: cancelled outright.
     *   - the bubbles themselves: keep the auto-dismiss EXACTLY as-is, and
     *     only neutralise the one-shot entrance. Cancelling them made the
     *     warning permanent (it never faded); fast-forwarding the whole
     *     `animation` list with 0.01ms made it flash and vanish instantly.
     *     Both were regressions, and both are avoidable by naming the
     *     entrance animation instead of writing `animation:`. */
    @media (prefers-reduced-motion: reduce) {
        /* Decorative loops and entrances — stop them outright. */
        .smoke,
        .scan-bubble-rail,
        .scan-strip-sweep,
        .scam-shimmer {
            animation: none !important;
        }
        /* The sweep's whole purpose is the travel, so cancelling it would
         * leave an empty track — indistinguishable from a finished scan.
         * Give it a still frame that reads as "in progress" without
         * moving: a striped track, the standard non-animated idiom for
         * indeterminate work. `repeating-linear-gradient` rather than an
         * image so it re-colours with --accent in every skin. */
        .scan-strip-track {
            background: repeating-linear-gradient(
                to right,
                color-mix(in srgb, var(--accent) 55%, transparent) 0 6px,
                transparent 6px 12px
            );
        }
        .scan-strip-sweep { display: none; }
        /* The smoke puffs' resting keyframe is opacity 0, so cancelling
         * leaves them invisible anyway — stated explicitly so a future
         * keyframe edit can't reintroduce frozen blobs over the text. */
        .smoke { opacity: 0; }
        /* Drop ONLY the entrance. The animation shorthand is restated
         * in full because the `phish-bubble-in` entry has to disappear
         * without disturbing the `scan-bubble-out` entry that follows it
         * in the same comma list — a later `animation-name: none` would
         * clear both. */
        .scam-bubble-floating,
        .phishing-bubble,
        .phishing-bubble-floating,
        .scam-bubble-borderline,
        .spam-bubble-floating {
            animation: phish-bubble-in 1ms linear, scan-bubble-out 700ms ease-in 8200ms forwards;
        }
    }
</style>
