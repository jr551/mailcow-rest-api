<script lang="ts">
    import { ui, showToast } from '../lib/store.svelte';
    import { markSpam, markTrusted, isTrustedSender } from '../lib/spam-feedback.svelte';
    import { themeState } from '../lib/theme.svelte';
    import { sanitizeHtml, buildIframeSrcDoc, placeholderRemoteImages } from '../lib/sanitize';
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
    import { isImageTrusted, trustImagesFromSender, hasRemoteImages } from '../lib/image-trust';
    import { suggestEmailActions, type EmailAction } from '../lib/email-actions.svelte';
    import { newThread, appendMessage, setTools, requestAutoSend } from '../lib/ai-threads.svelte';
    import { scanEmailForPhishing, getCachedScan, envelopeToHeaders, type PhishingScanResult } from '../lib/phishing-scan';
    import { findSpamFolder } from '../lib/spam-sweep';
    import { listMailboxes, moveMessage } from '../lib/api';
    import type { Attachment, MessageDetail } from '../lib/api';

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

    let allowImages = $state(false);
    let rememberSender = $state(true);
    let showRaw = $state<'auto' | 'text' | 'html'>('auto');
    let moveOpen = $state(false);
    let folderPickerAtt = $state<Attachment | null>(null);
    let folderPickerBlob = $state<Blob | null>(null);

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

    $effect(() => {
        const detail = ui.detail;
        const path = ui.selectedPath;
        // Skip phishing scan on AI conversation messages — they're our own
        // chat history, not inbound mail. Pointless burn of LLM tokens
        // (and the smoke effect was scaring people).
        const isAiThread = path === '.AI Conversations' || path === 'AI Conversations';
        if (!detail || !path || !settings.phishingScan || isAiThread) {
            phishingResult = null;
            phishingDismissed = false;
            spamDismissed = false;
            phishingScanning = false;
            if (phishingAbort) { phishingAbort.abort(); phishingAbort = null; }
            return;
        }
        phishingDismissed = false;
        spamDismissed = false;
        phishingResult = null;
        if (phishingAbort) { phishingAbort.abort(); }
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

        return () => {
            if (phishingAbort) { phishingAbort.abort(); phishingAbort = null; }
        };
    });

    // Auto-allow if the user previously chose "remember for a month" for
    // this sender, or if the master "always allow remote images" setting is
    // on, or if the privacy proxy is on (the upstream CDN can't see the
    // user's IP, so the main reason for the prompt is gone). Reset whenever
    // the user opens a different message.
    $effect(() => {
        const fromAddr = ui.detail?.envelope.from?.[0]?.address || '';
        allowImages = settings.alwaysAllowImages || settings.proxyImages || isImageTrusted(fromAddr);
        rememberSender = true;
    });

    function loadRemoteContent() {
        const fromAddr = ui.detail?.envelope.from?.[0]?.address || '';
        if (rememberSender && fromAddr) {
            trustImagesFromSender(fromAddr);
            showToast('success', `Will load remote content from ${fromAddr} for 30 days.`);
        }
        allowImages = true;
    }

    // --- AI tools popover (5 LLM-generated actions) ---------------------
    let aiToolsOpen = $state(false);
    let aiToolsLoading = $state(false);
    let aiToolsActions = $state<EmailAction[]>([]);
    let aiToolsError = $state<string | null>(null);
    let aiToolsAbort: AbortController | null = null;

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
    function onWindowClick(e: MouseEvent) {
        const target = e.target as HTMLElement;
        if (aiToolsOpen && !target?.closest?.('.ai-tools-wrap')) closeAiTools();
        if (calOptionsOpen && !target?.closest?.('.cal-options-wrap')) closeCalOptions();
    }

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

    // Proxy-rewriting is async (each remote image is a network round-trip),
    // so we maintain a parallel state that lags the synchronous srcDoc by
    // however long the proxy takes. The iframe shows the un-proxied HTML
    // (with images blocked, since allowImages-without-proxy is the same as
    // before) until the rewrite resolves.
    let proxiedSrcDoc = $state<{ uid: number; html: string } | null>(null);
    let proxyAbort: AbortController | null = null;
    let proxyLoading = $state(false);

    const baseSafeHtml = $derived.by(() => {
        if (!ui.detail || !ui.detail.html) return '';
        return sanitizeHtml(ui.detail.html, { allowRemoteImages: allowImages });
    });

    $effect(() => {
        // Re-run whenever the detail changes or the proxy toggle flips.
        const detail = ui.detail;
        const useProxy = settings.proxyImages && allowImages && isProxyHealthy();
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
        const useProxy = settings.proxyImages && allowImages && isProxyHealthy();
        const ready = proxiedSrcDoc && proxiedSrcDoc.uid === ui.detail.uid;
        // While the proxy is still fetching, show placeholders rather than
        // the sender's own URLs: rendering those would leak the read to
        // them, which is exactly what the proxy exists to prevent, and
        // dropping the src outright just yields a broken-image icon.
        const html = useProxy
            ? (ready ? proxiedSrcDoc!.html : placeholderRemoteImages(baseSafeHtml))
            : baseSafeHtml;
        return buildIframeSrcDoc(html, viewerEffectiveTheme());
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
</script>

<svelte:window onclick={onWindowClick} />

<section class="detail" aria-label="Message detail">
    {#if !ui.detail && !ui.detailLoading && !ui.detailError}
        <div class="empty muted">
            <div class="empty-icon" aria-hidden="true">
                <Icon name="mail" size={36} />
            </div>
            <p class="empty-title">Select a message to read</p>
            <p class="empty-hint">
                Tip — use <kbd>j</kbd> / <kbd>k</kbd> to navigate, <kbd>Enter</kbd> to open
            </p>
        </div>
    {:else if ui.detailLoading}
        <div class="empty"><div class="spinner"></div></div>
    {:else if ui.detailError}
        <div class="empty error" role="alert">{ui.detailError}</div>
    {:else if ui.detail}
        {@const d = ui.detail}
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
                    {#if isChatConfigured()}
                        <div class="cal-options-wrap">
                            <button
                                type="button"
                                class="btn btn-secondary ai-cal-btn"
                                onclick={() => suggestEvent(d)}
                                aria-haspopup="menu"
                                aria-expanded={calOptionsOpen}
                                title="Let the AI propose 5 calendar event options for this email"
                                data-testid="suggest-event-btn"
                            >
                                {#if ui.suggestLoading}
                                    <span class="spinner"></span>
                                {:else}
                                    <Icon name="sparkles" size={11} />
                                    <Icon name="calendar" size={11} />
                                {/if}
                                <span>AI Calendar</span>
                            </button>
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
                    {/if}
                    {#if isChatConfigured()}
                        <div class="ai-tools-wrap">
                            <button
                                type="button"
                                class="btn btn-secondary ai-btn-other"
                                onclick={() => openAiTools(d)}
                                aria-haspopup="menu"
                                aria-expanded={aiToolsOpen}
                                data-testid="ai-btn"
                            >
                                <Icon name="wand" size={12} /> Other AI
                            </button>
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
                    {:else if aiAvailable()}
                        <button type="button" class="btn btn-secondary ai-btn-other" onclick={onAi} data-testid="ai-btn">
                            <Icon name="wand" size={12} /> Other AI
                        </button>
                    {:else if capabilities.loaded}
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
                                </li>
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
                                <li class="menu-section">Move to folder</li>
                                {#each ui.mailboxes.filter(m => m.path !== ui.selectedPath) as mb (mb.path)}
                                    <li>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onclick={() => { moveOpen = false; onMove(d.uid, mb.path); }}
                                        >{mb.name || mb.path}</button>
                                    </li>
                                {/each}
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
                        <span
                            class="proxy-badge scam-badge"
                            class:warn={flagged}
                            title={flagged
                                ? `Scam scan: phishing indicators detected (${Math.round(phishingResult.confidence * 100)}%). ${phishingResult.reasoning || ''}`.trim()
                                : `Scam scan: clean (${Math.round((1 - phishingResult.confidence) * 100)}% safe).`}
                            data-testid="scam-scanned-badge"
                        >
                            <Icon name={flagged ? 'shieldAlert' : 'shield'} size={10} />
                            {flagged ? 'Phishing risk' : 'Scam-scanned'}
                        </span>
                        {#if settings.spamSuggest}
                            {@const spamFlagged = phishingResult.isSpam && phishingResult.spamConfidence >= settings.spamSuggestConfidenceFloor}
                            <span
                                class="proxy-badge spam-badge"
                                class:warn={spamFlagged}
                                title={spamFlagged
                                    ? `Spam scan: looks like spam (${Math.round(phishingResult.spamConfidence * 100)}%). ${phishingResult.spamReasoning || ''}`.trim()
                                    : `Spam scan: clean (${Math.round((1 - phishingResult.spamConfidence) * 100)}% likely legitimate).`}
                                data-testid="spam-scanned-badge"
                            >
                                <Icon name={spamFlagged ? 'shieldAlert' : 'shield'} size={10} />
                                {spamFlagged ? 'Looks like spam' : 'Spam-scanned'}
                            </span>
                        {/if}
                    {/if}
                    <div class="seg">
                        <button class:active={showRaw === 'auto'} onclick={() => (showRaw = 'auto')}>HTML</button>
                        <button class:active={showRaw === 'text'} onclick={() => (showRaw = 'text')}>Plain</button>
                    </div>
                </div>
            {/if}
        </header>

        <div class="body" data-testid="detail-body">
            <div class="scan-bubble-rail" aria-live="polite">
                {#if phishingScanning && !phishingDismissed}
                    <div class="scam-bubble scam-bubble-scanning scam-bubble-floating" role="status" data-testid="scam-scanning-bubble">
                        <span class="scam-orb" aria-hidden="true">
                            <span class="scam-orb-ring"></span>
                            <span class="scam-orb-core">🤖</span>
                        </span>
                        <span class="phish-bubble-text">
                            <strong>AI scanning…</strong>
                        </span>
                        <button
                            type="button"
                            class="phish-bubble-close"
                            title="Skip the scan"
                            aria-label="Dismiss scan"
                            onclick={() => { phishingDismissed = true; }}
                        ><Icon name="close" size={11} /></button>
                    </div>
                {:else if phishingResult?.isPhishing && (phishingResult?.confidence ?? 0) >= settings.phishingScanConfidenceFloor && !phishingDismissed}
                    <div class="phishing-bubble phishing-bubble-floating scam-bubble-floating" role="status" data-testid="phishing-warning-bubble">
                        <span class="smoke smoke-1" aria-hidden="true"></span>
                        <span class="smoke smoke-2" aria-hidden="true"></span>
                        <span class="smoke smoke-3" aria-hidden="true"></span>
                        <Icon name="shieldAlert" size={14} />
                        <span class="phish-bubble-text">
                            <strong>Looks like a scam.</strong>
                            {phishingResult?.reasoning ? phishingResult.reasoning.slice(0, 140) : 'Be careful with links + attachments.'}
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
                {:else if phishingResult && !phishingResult.isPhishing && (phishingResult.confidence ?? 0) >= 0.4 && (phishingResult.confidence ?? 0) < settings.phishingScanConfidenceFloor && !phishingDismissed && ((phishingResult.indicators?.length ?? 0) > 0 || phishingResult.reasoning)}
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
                {@const blurred = !allowImages && hasRemoteImages(d.html)}
                <div class="frame-wrap" class:blurred={blurred || (phishingResult?.isPhishing && !phishingDismissed)}>
                    <iframe
                        title="Message body"
                        sandbox="allow-popups allow-popups-to-escape-sandbox"
                        srcdoc={srcDoc}
                        referrerpolicy="no-referrer"
                        class="html-frame"
                        class:blurred
                    ></iframe>
                    {#if blurred}
                        <div class="remote-overlay" data-testid="remote-overlay">
                            <div class="remote-card">
                                <Icon name="eye" size={18} />
                                <h4>This message has remote content</h4>
                                <p>Loading external images can tell the sender you opened it. Load anyway?</p>
                                <button
                                    type="button"
                                    class="btn btn-primary"
                                    onclick={loadRemoteContent}
                                    data-testid="load-remote-content"
                                >Load remote content</button>
                                <label class="remember">
                                    <input
                                        type="checkbox"
                                        bind:checked={rememberSender}
                                        data-testid="remember-sender"
                                    />
                                    <span>Remember for {d.envelope.from?.[0]?.address || 'this sender'} for 30 days</span>
                                </label>
                            </div>
                        </div>
                    {/if}
                </div>
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
                                {#if isImage(att) && allowImages}
                                    <img src={downloadHref(att)} alt="" loading="lazy" />
                                {:else if isImage(att)}
                                    <span class="thumb-icon image" title="Click 'Show external images' to load thumbnails">
                                        <Icon name="eye" size={16} />
                                    </span>
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
    .avatar-lg {
        width: 34px;
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        color: #ffffff;
        font-weight: 600;
        font-size: 14px;
        flex: 0 0 auto;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
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
    .ai-tools-wrap, .cal-options-wrap { position: relative; }
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
    /* Toolbar badges. Each one wears its own colour family so the user
     * can read the row at a glance: green = image proxy, blue = AI scam
     * scan, purple = AI spam scan. The .warn modifier swaps the family
     * for an amber alert tone. */
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
    .proxy-badge.scam-badge {
        color: #1d4ed8;
        background: color-mix(in srgb, #2563eb 14%, transparent);
        border-color: color-mix(in srgb, #2563eb 38%, transparent);
    }
    .proxy-badge.spam-badge {
        color: #6d28d9;
        background: color-mix(in srgb, #7c3aed 14%, transparent);
        border-color: color-mix(in srgb, #7c3aed 38%, transparent);
    }
    :global(html.dark) .proxy-badge.scam-badge,
    :global([data-theme="dark"]) .proxy-badge.scam-badge {
        color: #93c5fd;
        background: color-mix(in srgb, #2563eb 22%, transparent);
        border-color: color-mix(in srgb, #2563eb 50%, transparent);
    }
    :global(html.dark) .proxy-badge.spam-badge,
    :global([data-theme="dark"]) .proxy-badge.spam-badge {
        color: #c4b5fd;
        background: color-mix(in srgb, #7c3aed 22%, transparent);
        border-color: color-mix(in srgb, #7c3aed 50%, transparent);
    }
    .proxy-badge.warn {
        color: var(--warning);
        background: var(--warning-soft);
        border-color: color-mix(in srgb, var(--warning) 35%, transparent);
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
    .remote-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: linear-gradient(to bottom,
            color-mix(in srgb, var(--bg-surface) 30%, transparent),
            color-mix(in srgb, var(--bg-surface) 60%, transparent));
        backdrop-filter: blur(2px);
        animation: fade-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .remote-card {
        max-width: 380px;
        padding: 22px 24px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 10px;
        color: var(--text-primary);
    }
    .remote-card h4 {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        letter-spacing: -0.01em;
    }
    .remote-card p {
        margin: 0 0 4px;
        font-size: 12.5px;
        color: var(--text-secondary);
        line-height: 1.55;
    }
    .remote-card .btn-primary { padding: 8px 18px; font-weight: 600; }
    .remote-card .remember {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--text-tertiary);
        cursor: pointer;
        user-select: none;
    }
    .remote-card .remember input {
        width: 14px;
        height: 14px;
        accent-color: var(--accent);
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
    .reply-group {
        position: relative;
        display: inline-flex;
        align-items: stretch;
    }
    .reply-group .btn { border-radius: var(--radius-sm) 0 0 var(--radius-sm); border-right: 0; }
    .reply-more {
        padding: 0 8px;
        background: var(--bg-surface);
        border: 1px solid var(--border-soft);
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        color: var(--text-secondary);
        transition: background-color var(--transition-fast);
    }
    .reply-more:hover { background: var(--bg-hover); }
    .reply-group .menu kbd {
        font-family: var(--font-mono);
        font-size: 10px;
        padding: 1px 5px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-bottom-width: 2px;
        border-radius: var(--radius-xs);
        color: var(--text-tertiary);
        margin-left: auto;
    }
    .reply-group .menu li button {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
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
    .phishing-sub {
        margin: 0;
        font-size: 13px;
        color: #6b21a8;
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
    .phishing-spinner {
        width: 28px;
        height: 28px;
        border: 3px solid rgba(147, 51, 234, 0.2);
        border-top-color: #7c3aed;
        border-radius: 50%;
        animation: spin 800ms linear infinite;
    }
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
    /* Skip button sits on the WHITE phishing-card, not the dark scrim.
       The earlier "white pill on white card" iteration was invisible.
       Now: high-contrast purple pill with a soft flash. */
    .phishing-skip {
        margin-top: 12px;
        padding: 7px 16px;
        font-size: 12.5px;
        font-weight: 700;
        letter-spacing: 0.01em;
        color: #4c1d95;
        background: white;
        border: 1.5px solid #9333ea;
        border-radius: 999px;
        cursor: pointer;
        animation: phishing-skip-flash 1.8s ease-in-out infinite;
        box-shadow: 0 1px 2px rgba(76, 29, 149, 0.12);
    }
    @keyframes phishing-skip-flash {
        0%, 100% {
            transform: scale(1);
            box-shadow: 0 1px 2px rgba(76, 29, 149, 0.12);
        }
        50% {
            transform: scale(1.04);
            box-shadow: 0 0 0 4px rgba(147, 51, 234, 0.18), 0 1px 2px rgba(76, 29, 149, 0.18);
            background: #f5f3ff;
        }
    }
    .phishing-skip:hover {
        background: #ede9fe;
        animation: none;
        transform: scale(1.03);
    }
    @media (prefers-reduced-motion: reduce) {
        .phishing-skip { animation: none; }
    }
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

    /* Soft floating phishing warning — sits at the top of .body, fades
       in with three rising "smoke" puffs behind it, then auto-dismisses
       after ~8s unless the user clicks ✕ first. */
    .phishing-bubble {
        position: relative;
        margin: 8px 12px 12px;
        padding: 10px 14px;
        display: flex;
        align-items: center;
        gap: 10px;
        background: linear-gradient(
            135deg,
            color-mix(in srgb, #9333ea 18%, var(--bg-surface)),
            color-mix(in srgb, #c084fc 12%, var(--bg-surface))
        );
        border: 1px solid color-mix(in srgb, #9333ea 35%, var(--border-subtle));
        border-radius: 14px;
        color: var(--text-primary);
        font-size: 13px;
        overflow: hidden;
        animation: phish-bubble-in 360ms ease-out, phish-bubble-out 800ms ease-in 7400ms forwards;
    }
    /* Rail of floating AI-scan bubbles: pinned just under the message
     * toolbar, hovering over the body so the user sees the verdict
     * without it pushing the message content down. Sticky so it stays
     * visible while scrolling; rail itself is non-interactive — only
     * the bubbles inside catch clicks. */
    .scan-bubble-rail {
        /* Static, not sticky: as a sticky element it rode over the message
           while the user scrolled, so an optional background scan ended up
           covering the thing it is commenting on. In flow it takes its own
           space at the top and scrolls away like any other banner. */
        position: relative;
        z-index: 5;
        margin: 8px 12px 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        pointer-events: none;
    }
    .scan-bubble-rail:empty { display: none; }
    .scan-bubble-rail > * { pointer-events: auto; }

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
    .phishing-bubble-floating {
        max-width: min(560px, 100%);
        padding: 10px 14px;
        border-radius: 999px;
        background:
            radial-gradient(120% 220% at 100% 0%, rgba(216, 180, 254, 0.55), transparent 55%),
            linear-gradient(135deg, #7c3aed 0%, #a855f7 50%, #d8b4fe 100%);
        border: 1px solid color-mix(in srgb, #7c3aed 65%, transparent);
        box-shadow:
            0 10px 28px rgba(124, 58, 237, 0.30),
            inset 0 1px 0 rgba(255, 255, 255, 0.30);
        color: #fdf4ff;
        font-size: 13.5px;
        animation: phish-bubble-in 360ms ease-out, ghost-bob 4s ease-in-out 360ms infinite;
    }
    /* Scanning state — inviting purple gradient + spinning orb. */
    .scam-bubble-scanning {
        background:
            radial-gradient(120% 220% at 0% 0%, rgba(216, 180, 254, 0.42), transparent 60%),
            linear-gradient(135deg, #6d28d9 0%, #8b5cf6 55%, #c4b5fd 100%);
        border: 1px solid color-mix(in srgb, #6d28d9 65%, transparent);
        box-shadow: 0 10px 28px rgba(109, 40, 217, 0.32), inset 0 1px 0 rgba(255,255,255,0.28);
        color: #f5f3ff;
    }
    .scam-bubble-scanning :global(svg) { color: #f5f3ff; flex-shrink: 0; }
    .scam-orb {
        position: relative;
        width: 26px;
        height: 26px;
        flex: 0 0 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
    .scam-orb-ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid transparent;
        border-top-color: #ede9fe;
        border-right-color: #c4b5fd;
        animation: scam-orb-spin 1s linear infinite;
    }
    .scam-orb-core {
        font-size: 14px;
        line-height: 1;
        animation: scam-orb-pulse 2.4s ease-in-out infinite;
    }
    @keyframes scam-orb-spin { to { transform: rotate(360deg); } }
    @keyframes scam-orb-pulse {
        0%, 100% { transform: scale(1); opacity: 0.92; }
        50%      { transform: scale(1.18); opacity: 1; }
    }
    /* Borderline state — softer indigo-violet, with a slow shimmer
     * sweep so the user notices something nuanced is being said. */
    .scam-bubble-borderline {
        background: linear-gradient(135deg, #4338ca 0%, #6366f1 60%, #a5b4fc 100%);
        border: 1px solid color-mix(in srgb, #4338ca 60%, transparent);
        color: #eef2ff;
        box-shadow: 0 6px 18px rgba(67, 56, 202, 0.26);
    }
    .scam-bubble-borderline :global(svg) { color: #eef2ff; flex-shrink: 0; }
    .scam-shimmer {
        position: absolute;
        inset: 0;
        background: linear-gradient(120deg,
            transparent 0%,
            rgba(255,255,255,0.18) 50%,
            transparent 100%);
        transform: translateX(-100%);
        animation: scam-shimmer 3.6s ease-in-out infinite;
        pointer-events: none;
    }
    @keyframes scam-shimmer {
        0%, 25%   { transform: translateX(-100%); }
        60%, 100% { transform: translateX(100%); }
    }
    /* Common close button on the new bubbles. */
    .scam-bubble-scanning .phish-bubble-close,
    .scam-bubble-borderline .phish-bubble-close {
        background: rgba(255, 255, 255, 0.18);
        color: #ffffff;
    }
    .scam-bubble-scanning .phish-bubble-close:hover,
    .scam-bubble-borderline .phish-bubble-close:hover {
        background: rgba(255, 255, 255, 0.32);
    }
    @media (prefers-reduced-motion: reduce) {
        .scam-orb-ring, .scam-orb-core, .scam-shimmer { animation: none; }
    }
    .phishing-bubble-floating :global(svg) { color: #fdf4ff; }
    .phishing-bubble-floating .phish-bubble-close {
        background: rgba(255, 255, 255, 0.20);
        color: #fdf4ff;
    }
    .phishing-bubble-floating .phish-bubble-close:hover {
        background: rgba(255, 255, 255, 0.32);
    }
    @keyframes ghost-bob {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(-2px); }
    }
    .spam-bubble-floating {
        margin: 12px auto 6px;
        max-width: 560px;
        border-radius: 999px;
        /* Spam wears amber/orange so it never gets confused with the
         * purple AI-scam-scan bubble. Different problem, different
         * shelf. */
        background: linear-gradient(135deg, #b45309 0%, #f59e0b 60%, #fcd34d 100%);
        border: 1px solid color-mix(in srgb, #b45309 60%, transparent);
        color: #1f1300;
        box-shadow: 0 8px 22px rgba(180, 83, 9, 0.28), inset 0 1px 0 rgba(255,255,255,0.25);
        padding: 10px 14px;
    }
    .spam-bubble-floating :global(svg) { color: #4a2900; }
    .phishing-bubble :global(svg) { color: #9333ea; flex-shrink: 0; }
    .phish-bubble-text { flex: 1; min-width: 0; }
    .phish-bubble-close {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: rgba(147, 51, 234, 0.15);
        color: #6b21a8;
        border: none;
        cursor: pointer;
    }
    .phish-bubble-close:hover { background: rgba(147, 51, 234, 0.3); }
    /* Spam suggestion: cooler tone than the phishing warning so the two
       can sit on top of each other without competing visually. Stays
       until dismissed or the user clicks Move. */
    .spam-bubble {
        position: relative;
        margin: 6px 12px 12px;
        padding: 9px 12px;
        display: flex;
        align-items: center;
        gap: 10px;
        background: color-mix(in srgb, #f59e0b 14%, var(--bg-surface));
        border: 1px solid color-mix(in srgb, #f59e0b 35%, var(--border-subtle));
        border-radius: 12px;
        color: var(--text-primary);
        font-size: 13px;
    }
    .spam-bubble :global(svg) { color: #b45309; flex-shrink: 0; }
    .spam-bubble-text { flex: 1; min-width: 0; }
    .spam-bubble-action {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        font: inherit;
        font-weight: 600;
        font-size: 12.5px;
        background: #f59e0b;
        color: #1f1300;
        border: none;
        border-radius: 999px;
        cursor: pointer;
    }
    .spam-bubble-action:hover { background: #d97706; }
    .spam-bubble-action[disabled] { opacity: 0.6; cursor: progress; }
    .spam-bubble-close {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: rgba(245, 158, 11, 0.18);
        color: #92400e;
        border: none;
        cursor: pointer;
    }
    .spam-bubble-close:hover { background: rgba(245, 158, 11, 0.32); }
    .smoke {
        position: absolute;
        bottom: -10px;
        width: 26px; height: 26px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(147, 51, 234, 0.45), rgba(147, 51, 234, 0));
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
    @keyframes phish-bubble-out {
        from { opacity: 1; }
        to   { opacity: 0; transform: translateY(-6px); pointer-events: none; }
    }
    @media (prefers-reduced-motion: reduce) {
        .phishing-bubble { animation: none; }
        .smoke { animation: none; opacity: 0; }
    }
</style>
