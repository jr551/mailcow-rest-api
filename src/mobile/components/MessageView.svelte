<script lang="ts">
    import { mobileState, goBack, showToast, pushOverlay } from '../lib/store.svelte';
    import { authState, setSession } from '../../lib/auth.svelte';
    import {
        modifyFlags,
        moveMessage,
        deleteMessage,
        sendStub,
        getRawMessage,
        ApiError,
        type SendAttachment,
        attachmentUrl
    } from '../../lib/api';
    import { formatFullDate, formatAddressList, senderShort } from '../../lib/format';
    import { sanitizeHtml, buildIframeSrcDoc } from '../../lib/sanitize';
    import { proxyImagesInHtml, isProxyHealthy } from '../../lib/image-proxy';
    import { hasRemoteImages, isImageTrusted, trustImagesFromSender } from '../../lib/image-trust';
    import { settings } from '../../lib/settings.svelte';
    import { scanEmailForPhishing, getCachedScan, envelopeToHeaders, type PhishingScanResult } from '../../lib/phishing-scan';
    import { isTrustedSender } from '../../lib/spam-feedback.svelte';
    import Icon from '../../components/Icon.svelte';
    import DriveFolderPicker from '../../components/drive/DriveFolderPicker.svelte';
    import { saveAttachmentToDrive, loadDriveConfig } from '../../lib/drive.svelte';
    import Avatar from '../../components/Avatar.svelte';

    const msg = $derived(mobileState.detail);
    const loading = $derived(mobileState.detailLoading);
    const error = $derived(mobileState.detailError);

    let allowImages = $state(false);
    let proxiedSrcDoc = $state<string | null>(null);
    let hasRemote = $state(false);
    let iframeSrc = $state('');
    let proxyAbort: AbortController | null = null;
    let proxyActive = $state(false);
    let iframeEl: HTMLIFrameElement | undefined = $state();
    let preEl: HTMLPreElement | undefined = $state();
    let headersOpen = $state(false);
    let headersLoading = $state(false);
    let headersText = $state('');
    let folderPickerAtt = $state<{ id: string; filename?: string | null } | null>(null);
    let folderPickerBlob = $state<Blob | null>(null);
    let driveSaving = $state<Record<string, boolean>>({});

    // --- Phishing scan -----------------------------------------------
    let phishingScanning = $state(false);
    let phishingResult = $state<PhishingScanResult | null>(null);
    let phishingDismissed = $state(false);
    let phishingAbort: AbortController | null = null;

    $effect(() => {
        const m = msg;
        const path = mobileState.selectedPath;
        if (!m || !path) {
            phishingResult = null;
            phishingDismissed = false;
            phishingScanning = false;
            if (phishingAbort) { phishingAbort.abort(); phishingAbort = null; }
            return;
        }
        phishingDismissed = false;
        phishingResult = null;
        if (phishingAbort) { phishingAbort.abort(); }
        phishingAbort = new AbortController();

        const cached = getCachedScan(path, m.uid);
        if (cached) {
            phishingResult = cached;
            phishingScanning = false;
            return;
        }

        if (isTrustedSender(m.envelope.from?.[0]?.address)) {
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
        const from = m.envelope.from?.[0];
        const to = m.envelope.to?.[0];
        scanEmailForPhishing(path, m.uid, {
            subject: m.envelope.subject || '',
            from: from ? `${from.name || ''} <${from.address}>`.trim() : '',
            to: to ? `${to.name || ''} <${to.address}>`.trim() : '',
            body: m.text || '',
            html: m.html || '',
            headers: envelopeToHeaders(m.envelope),
            attachments: m.attachments,
            path,
            uid: m.uid
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

    $effect(() => {
        const html = msg?.html;
        const text = msg?.text;
        const fromAddr = msg?.envelope.from?.[0]?.address;
        if (!msg) {
            allowImages = false;
            proxiedSrcDoc = null;
            hasRemote = false;
            iframeSrc = '';
            proxyActive = false;
            return;
        }
        const remote = hasRemoteImages(html);
        hasRemote = remote;
        // When proxyImages is on, we auto-allow remote images so they can be
        // routed through the privacy proxy without bothering the user.
        const shouldAllow = settings.alwaysAllowImages || settings.proxyImages || isImageTrusted(fromAddr) || !remote;
        allowImages = shouldAllow;
        proxyActive = shouldAllow && settings.proxyImages && remote;

        // Sanitize
        const safe = sanitizeHtml(html || '', { allowRemoteImages: shouldAllow });
        const theme: 'light' | 'dark' = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        const baseDoc = buildIframeSrcDoc(safe, theme);
        iframeSrc = baseDoc;
        proxiedSrcDoc = null;

        // Proxy images if allowed and enabled
        if (shouldAllow && settings.proxyImages && remote && isProxyHealthy() && html) {
            if (proxyAbort) proxyAbort.abort();
            const ctrl = new AbortController();
            proxyAbort = ctrl;
            proxyImagesInHtml(baseDoc, ctrl.signal).then((rewritten) => {
                if (ctrl.signal.aborted) return;
                proxiedSrcDoc = rewritten;
            }).catch(() => { /* leave unproxied */ });
        }

        // For text emails, ensure <pre> fills available viewport space
        if (text && !html && preEl) {
            requestAnimationFrame(() => {
                if (!preEl) return;
                preEl.style.minHeight = getAvailableContentHeight() + 'px';
            });
        }

        return () => {
            if (proxyAbort) { proxyAbort.abort(); proxyAbort = null; }
        };
    });

    function getAvailableContentHeight(): number {
        const msgBody = document.querySelector('.msg-body-wrap');
        const meta = document.querySelector('.msg-meta');
        const attachments = document.querySelector('.attachments');
        if (!msgBody || !meta) return 300;

        const msgBodyRect = msgBody.getBoundingClientRect();
        const metaRect = meta.getBoundingClientRect();
        const attachmentsRect = attachments?.getBoundingClientRect();

        const bodyStyle = getComputedStyle(msgBody);
        const paddingBottom = parseFloat(bodyStyle.paddingBottom) || 0;
        const bodyBottom = msgBodyRect.bottom - paddingBottom;

        const metaStyle = getComputedStyle(meta);
        const metaMarginBottom = parseFloat(metaStyle.marginBottom) || 0;
        const contentTop = metaRect.bottom + metaMarginBottom;

        let contentBottom = bodyBottom;
        if (attachments && attachmentsRect) {
            const attachmentsStyle = getComputedStyle(attachments);
            const attachmentsMarginTop = parseFloat(attachmentsStyle.marginTop) || 0;
            contentBottom = attachmentsRect.top - attachmentsMarginTop;
        }

        return Math.max(contentBottom - contentTop, 300);
    }

    function resizeIframe() {
        if (!iframeEl?.contentDocument) return;
        const doc = iframeEl.contentDocument;
        const contentHeight = Math.max(doc.documentElement?.scrollHeight || 0, doc.body?.scrollHeight || 0, 300);
        const availableHeight = getAvailableContentHeight();
        iframeEl.style.height = Math.max(contentHeight, availableHeight) + 'px';
    }

    function loadRemoteImages() {
        allowImages = true;
        const html = msg?.html;
        const theme: 'light' | 'dark' = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        const safe = sanitizeHtml(html || '', { allowRemoteImages: true });
        iframeSrc = buildIframeSrcDoc(safe, theme);
        proxiedSrcDoc = null;
        if (settings.proxyImages && html) {
            if (proxyAbort) proxyAbort.abort();
            const ctrl = new AbortController();
            proxyAbort = ctrl;
            proxyImagesInHtml(iframeSrc, ctrl.signal).then((rewritten) => {
                if (ctrl.signal.aborted) return;
                proxiedSrcDoc = rewritten;
            }).catch(() => {});
        }
    }

    function trustSender() {
        const fromAddr = msg?.envelope.from?.[0]?.address;
        if (!fromAddr) return;
        trustImagesFromSender(fromAddr);
        loadRemoteImages();
        showToast('success', 'Images from this sender will load automatically');
    }

    async function toggleStar() {
        if (!msg) return;
        const isFlagged = msg.flags.includes('\\Flagged');
        try {
            const r = await modifyFlags(mobileState.selectedPath, msg.uid, isFlagged ? { remove: ['\\Flagged'] } : { add: ['\\Flagged'] });
            msg.flags = r.flags;
            const li = mobileState.messages.find((m) => m.uid === msg.uid);
            if (li) li.flags = r.flags;
            showToast('success', isFlagged ? 'Unstarred' : 'Starred');
        } catch {
            showToast('error', 'Failed to update star');
        }
    }

    async function toggleUnread() {
        if (!msg) return;
        const seen = msg.flags.includes('\\Seen');
        try {
            const r = await modifyFlags(mobileState.selectedPath, msg.uid, seen ? { remove: ['\\Seen'] } : { add: ['\\Seen'] });
            msg.flags = r.flags;
            const li = mobileState.messages.find((m) => m.uid === msg.uid);
            if (li) li.flags = r.flags;
            showToast('success', seen ? 'Marked unread' : 'Marked read');
        } catch {
            showToast('error', 'Failed to update read state');
        }
    }

    async function trash() {
        if (!msg) return;
        const from = mobileState.selectedPath;
        const trashBox = mobileState.mailboxes.find((m) => m.specialUse === '\\Trash')?.path || 'Trash';
        try {
            if (from === trashBox) await deleteMessage(from, msg.uid);
            else await moveMessage(from, msg.uid, trashBox);
            mobileState.messages = mobileState.messages.filter((m) => m.uid !== msg.uid);
            mobileState.messagesTotal = Math.max(0, mobileState.messagesTotal - 1);
            showToast('success', from === trashBox ? 'Deleted' : 'Moved to Trash');
            goBack();
        } catch {
            showToast('error', 'Failed to delete');
        }
    }

    async function archive() {
        if (!msg) return;
        const from = mobileState.selectedPath;
        const archiveBox = mobileState.mailboxes.find((m) => m.specialUse === '\\Archive')?.path || 'Archive';
        try {
            await moveMessage(from, msg.uid, archiveBox);
            mobileState.messages = mobileState.messages.filter((m) => m.uid !== msg.uid);
            mobileState.messagesTotal = Math.max(0, mobileState.messagesTotal - 1);
            showToast('success', 'Archived');
            goBack();
        } catch {
            showToast('error', 'Failed to archive');
        }
    }

    async function saveAttToDrive(att: { id: string; filename?: string | null; size?: number | null }) {
        if (!msg) return;
        driveSaving = { ...driveSaving, [att.id]: true };
        try {
            await loadDriveConfig();
            const url = attachmentUrl(mobileState.selectedPath, msg.uid, att.id);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            folderPickerBlob = blob;
            folderPickerAtt = att;
        } catch (err) {
            showToast('error', `Couldn't save to Drive: ${(err as Error).message}`);
        } finally {
            driveSaving = { ...driveSaving, [att.id]: false };
        }
    }

    async function onFolderPicked(path: string) {
        if (!folderPickerAtt || !folderPickerBlob) return;
        const filename = folderPickerAtt.filename || `attachment-${folderPickerAtt.id}`;
        await saveAttachmentToDrive(folderPickerBlob, filename, path);
        folderPickerAtt = null;
        folderPickerBlob = null;
    }

    function reply(mode: 'reply' | 'replyAll' | 'forward' = 'reply') {
        if (!msg) return;
        mobileState.composeReplyTo = msg;
        mobileState.composeMode = mode;
        mobileState.previousView = mobileState.view;
        mobileState.view = 'compose';
    }

    let headersDispose: (() => void) | null = null;

    function closeHeaders() {
        headersOpen = false;
        if (headersDispose) { headersDispose(); headersDispose = null; }
    }

    async function viewHeaders() {
        if (!msg) return;
        headersLoading = true;
        headersOpen = true;
        // Hardware-back closes the headers sheet before leaving the
        // message view.
        headersDispose = pushOverlay('msg-headers-sheet', () => {
            closeHeaders();
            headersDispose = null;
        });
        try {
            const raw = await getRawMessage(mobileState.selectedPath, msg.uid);
            const idx = raw.indexOf('\r\n\r\n');
            headersText = idx !== -1 ? raw.slice(0, idx) : raw.indexOf('\n\n') !== -1 ? raw.slice(0, raw.indexOf('\n\n')) : raw;
        } catch (err) {
            showToast('error', `Couldn't load headers: ${(err as Error).message}`);
            closeHeaders();
        } finally {
            headersLoading = false;
        }
    }

    const fromAddr = $derived(msg?.envelope.from?.[0]);
</script>

<div class="message-view">
    <header class="mheader">
        <button type="button" class="mbtn mbtn-ghost back-btn" onclick={goBack}>
            <Icon name="chevronLeft" size={20} />
            <span>Back</span>
        </button>
        <div class="actions">
            <button type="button" class="mbtn mbtn-ghost action-icon" onclick={toggleStar}>
                <Icon name={msg?.flags.includes('\\Flagged') ? 'starFilled' : 'star'} size={18} />
            </button>
            <button type="button" class="mbtn mbtn-ghost action-icon" onclick={() => reply('reply')}>
                <Icon name="reply" size={18} />
            </button>
        </div>
    </header>

    {#if loading && !msg}
        <div class="mempty">
            <span class="spinner" style="width:28px;height:28px"></span>
            <p class="muted">Loading message…</p>
        </div>
    {:else if error}
        <div class="mempty">
            <Icon name="info" size={32} />
            <p>{error}</p>
            <button class="mbtn mbtn-secondary" onclick={goBack}>Go back</button>
        </div>
    {:else if msg}
        <div class="scroll-y msg-body-wrap">
            <div class="scan-bubble-rail" aria-live="polite">
                {#if phishingScanning && !phishingDismissed}
                    <div class="scan-bubble scan-bubble-scanning" role="status" data-testid="mobile-scam-scanning-bubble">
                        <span class="scam-orb" aria-hidden="true">
                            <span class="scam-orb-ring"></span>
                            <span class="scam-orb-core">🤖</span>
                        </span>
                        <span class="scan-bubble-text"><strong>AI scanning…</strong></span>
                        <button
                            type="button"
                            class="scan-bubble-close"
                            aria-label="Dismiss scan"
                            onclick={() => { phishingDismissed = true; }}
                        ><Icon name="close" size={11} /></button>
                    </div>
                {:else if phishingResult?.isPhishing && (phishingResult?.confidence ?? 0) >= settings.phishingScanConfidenceFloor && !phishingDismissed}
                    <div class="scan-bubble scan-bubble-warn" role="status" data-testid="mobile-phishing-warning-bubble">
                        <Icon name="shieldAlert" size={14} />
                        <span class="scan-bubble-text">
                            <strong>Looks like a scam.</strong>
                            {phishingResult?.reasoning ? phishingResult.reasoning.slice(0, 100) : 'Be careful with links + attachments.'}
                        </span>
                        <button
                            type="button"
                            class="scan-bubble-close"
                            aria-label="Dismiss"
                            onclick={() => { phishingDismissed = true; }}
                        ><Icon name="close" size={11} /></button>
                    </div>
                {/if}
            </div>
            <div class="msg-meta">
                <div class="msg-sender-row">
                    <Avatar email={fromAddr?.address || ''} name={fromAddr?.name || null} size={40} />
                    <div class="sender-info">
                        <div class="sender-name">{senderShort(msg.envelope.from)}</div>
                        <div class="sender-email muted">{fromAddr?.address || ''}</div>
                    </div>
                    <span class="msg-date muted">{formatFullDate(msg.internalDate || msg.envelope.date)}</span>
                </div>
                <h2 class="msg-subject">{msg.envelope.subject || '(no subject)'}</h2>
                <div class="msg-to muted">
                    To: {formatAddressList(msg.envelope.to)}
                </div>
            </div>

            <div class="msg-content" class:blur-remote={hasRemote && !allowImages} class:blurred={phishingResult?.isPhishing && !phishingDismissed}>
                {#if msg.html}
                    <iframe bind:this={iframeEl} srcdoc={proxiedSrcDoc ?? iframeSrc} title="Message body" sandbox="allow-same-origin" frameborder="0" onload={resizeIframe}></iframe>
                {:else if msg.text}
                    <pre bind:this={preEl}>{msg.text}</pre>
                {:else}
                    <p class="muted">(no body)</p>
                {/if}
                {#if hasRemote && !allowImages}
                    <div class="remote-overlay">
                        <Icon name="eyeOff" size={28} />
                        <p>Remote content blocked</p>
                        <button type="button" class="mbtn mbtn-primary" onclick={loadRemoteImages}>Load remote content</button>
                        <button type="button" class="mbtn mbtn-ghost" onclick={trustSender}>Always allow from this sender</button>
                    </div>
                {/if}
                {#if proxyActive}
                    <div class="proxy-badge">
                        <span class="proxy-dot"></span>
                        <span class="proxy-text">Proxy protection on</span>
                    </div>
                {/if}
                {#if settings.phishingScan && phishingResult && !phishingScanning}
                    {@const flagged = phishingResult.isPhishing && phishingResult.confidence >= settings.phishingScanConfidenceFloor}
                    <div
                        class="proxy-badge scam-badge"
                        class:warn={flagged}
                        title={flagged
                            ? `Scam scan: phishing indicators detected (${Math.round(phishingResult.confidence * 100)}%).`
                            : 'Scam scan: clean.'}
                        data-testid="mobile-scam-scanned-badge"
                    >
                        <Icon name={flagged ? 'shieldAlert' : 'shield'} size={11} />
                        <span class="proxy-text">{flagged ? 'Phishing risk' : 'Scam-scanned'}</span>
                    </div>
                    {#if settings.spamSuggest}
                        {@const spamFlagged = phishingResult.isSpam && phishingResult.spamConfidence >= settings.spamSuggestConfidenceFloor}
                        <div
                            class="proxy-badge spam-badge"
                            class:warn={spamFlagged}
                            title={spamFlagged
                                ? `Spam scan: looks like spam (${Math.round(phishingResult.spamConfidence * 100)}%).`
                                : 'Spam scan: clean.'}
                            data-testid="mobile-spam-scanned-badge"
                        >
                            <Icon name={spamFlagged ? 'shieldAlert' : 'shield'} size={11} />
                            <span class="proxy-text">{spamFlagged ? 'Looks like spam' : 'Spam-scanned'}</span>
                        </div>
                    {/if}
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
                            <button type="button" class="mbtn mbtn-primary" onclick={() => phishingDismissed = true} data-testid="phishing-proceed">
                                Proceed anyway
                            </button>
                        </div>
                    </div>
                {/if}
            </div>

            {#if msg.attachments.length}
                <div class="attachments">
                    <span class="muted" style="font-weight:600;font-size:13px;">Attachments</span>
                    {#each msg.attachments as att}
                        <div class="att-row">
                            <Icon name="paperclip" size={14} />
                            <span class="truncate">{att.filename || 'unnamed'}</span>
                            <span class="muted" style="font-size:12px;margin-left:auto;">
                                {att.size ? `${(att.size / 1024).toFixed(1)} KB` : ''}
                            </span>
                        </div>
                        <div class="att-actions">
                            <button type="button" class="att-btn" onclick={() => saveAttToDrive(att)} disabled={driveSaving[att.id]}>
                                {#if driveSaving[att.id]}<span class="spinner" style="width:12px;height:12px;border-width:2px;"></span>{/if}
                                <Icon name="drive" size={13} /> Save to Drive
                            </button>
                            <a class="att-btn" href={attachmentUrl(mobileState.selectedPath, msg.uid, att.id)} download={att.filename || ''}>
                                <Icon name="download" size={13} /> Download
                            </a>
                        </div>
                        {#if folderPickerAtt?.id === att.id}
                            <DriveFolderPicker
                                onSelect={onFolderPicked}
                                onCancel={() => { folderPickerAtt = null; folderPickerBlob = null; }}
                            />
                        {/if}
                    {/each}
                </div>
            {/if}
        </div>

        <div class="msg-toolbar">
            <button type="button" class="toolbar-btn" onclick={() => reply('reply')}>
                <Icon name="reply" size={16} /> Reply
            </button>
            <button type="button" class="toolbar-btn" onclick={() => reply('replyAll')}>
                <Icon name="reply" size={16} /> Reply All
            </button>
            <button type="button" class="toolbar-btn" onclick={() => reply('forward')}>
                <Icon name="send" size={16} /> Forward
            </button>
            <button type="button" class="toolbar-btn icon-only" onclick={archive}>
                <Icon name="archive" size={16} />
            </button>
            <button type="button" class="toolbar-btn icon-only" onclick={viewHeaders} title="View headers" aria-label="View headers">
                <Icon name="fileText" size={16} />
            </button>
            <button type="button" class="toolbar-btn icon-only danger" onclick={trash}>
                <Icon name="trash" size={16} />
            </button>
        </div>

        {#if headersOpen}
            <div class="headers-overlay" onclick={(e) => { if (e.target === e.currentTarget) closeHeaders(); }} role="presentation">
                <div class="headers-sheet" role="dialog" aria-modal="true" aria-label="Message headers">
                    <div class="headers-head">
                        <h3>Message headers</h3>
                        <button type="button" class="mbtn mbtn-ghost" onclick={() => closeHeaders()} aria-label="Close">
                            <Icon name="close" size={18} />
                        </button>
                    </div>
                    <div class="headers-body">
                        {#if headersLoading}
                            <div class="mempty">
                                <span class="spinner" style="width:28px;height:28px"></span>
                                <p class="muted">Loading headers…</p>
                            </div>
                        {:else}
                            <pre class="headers-pre">{headersText}</pre>
                        {/if}
                    </div>
                </div>
            </div>
        {/if}
    {/if}
</div>

<style>
    .message-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        background: var(--bg-base);
    }
    .actions {
        display: flex;
        align-items: center;
        gap: 2px;
    }
    .back-btn {
        padding-left: 4px;
    }
    .action-icon {
        width: 40px;
        height: 40px;
        padding: 0;
        border-radius: 50%;
    }
    .msg-body-wrap {
        flex: 1;
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
    }
    .msg-meta {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 12px;
        padding-bottom: 12px;
        border-bottom: 0.5px solid var(--border-subtle);
    }
    .msg-sender-row {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .sender-info {
        flex: 1;
        min-width: 0;
    }
    .sender-name {
        font-size: 15px;
        font-weight: 600;
        color: var(--text-primary);
        /* Truncate long display names so they don't bleed under the date
           on the right (this was the "header text typing over each other"
           bug). The parent already sets min-width:0. */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .sender-email {
        font-size: 13px;
        font-weight: 400;
        color: var(--text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .msg-date {
        font-size: 12px;
        font-weight: 400;
        color: var(--text-tertiary);
        flex-shrink: 0;
    }
    .msg-subject {
        margin: 0;
        font-size: 17px;
        font-weight: 700;
        line-height: 1.3;
        color: var(--text-primary);
        letter-spacing: -0.01em;
    }
    .msg-to {
        font-size: 13px;
        font-weight: 400;
        color: var(--text-tertiary);
    }
    .msg-content {
        font-size: 16px;
        line-height: 1.45;
        color: var(--text-primary);
        position: relative;
    }
    .msg-content.blur-remote iframe,
    .msg-content.blur-remote pre {
        filter: blur(6px);
        opacity: 0.5;
        user-select: none;
        pointer-events: none;
    }
    .msg-content iframe {
        width: 100%;
        min-height: 300px;
        border: none;
        background: transparent;
    }
    .msg-content pre {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: inherit;
        margin: 0 auto;
        font-size: 15px;
        line-height: 1.5;
        max-width: 760px;
    }
    .remote-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 24px;
        text-align: center;
        color: var(--text-secondary);
    }
    .remote-overlay p {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .proxy-badge {
        position: absolute;
        top: 8px;
        right: 8px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(34, 197, 94, 0.12);
        border: 0.5px solid rgba(34, 197, 94, 0.35);
        font-size: 12px;
        font-weight: 600;
        color: #16a34a;
        pointer-events: none;
        animation: proxyGlow 2s ease-in-out infinite;
    }
    @keyframes proxyGlow {
        0%, 100% { box-shadow: 0 0 4px rgba(34, 197, 94, 0.2); }
        50% { box-shadow: 0 0 12px rgba(34, 197, 94, 0.5); }
    }
    .proxy-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #22c55e;
        box-shadow: 0 0 4px #22c55e;
    }
    .attachments {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 16px;
        padding-top: 12px;
        border-top: 0.5px solid var(--border-subtle);
    }
    .att-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        background: var(--bg-surface);
        border-radius: 8px;
        font-size: 13px;
    }
    .att-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 4px;
        margin-bottom: 8px;
    }
    .att-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 500;
        border-radius: 6px;
        border: none;
        background: var(--bg-hover);
        color: var(--text-primary);
        cursor: pointer;
        text-decoration: none;
        transition: background-color 120ms;
    }
    .att-btn:active {
        background: var(--bg-active);
    }
    .att-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
    .msg-toolbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
        background: var(--bg-surface);
        border-top: 0.5px solid var(--border-subtle);
        overflow-x: auto;
    }
    .toolbar-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 7px 12px;
        font-size: 13px;
        font-weight: 500;
        border-radius: 8px;
        border: none;
        background: var(--bg-hover);
        color: var(--text-primary);
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 120ms;
        flex-shrink: 0;
    }
    .toolbar-btn:active { background: var(--bg-active); }
    .toolbar-btn.icon-only {
        width: 34px;
        height: 34px;
        padding: 0;
        border-radius: 50%;
    }
    .toolbar-btn.danger {
        color: var(--danger);
    }
    .headers-overlay {
        position: fixed;
        inset: 0;
        background: var(--bg-overlay);
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        z-index: 100;
        backdrop-filter: blur(2px);
    }
    .headers-sheet {
        background: var(--bg-surface);
        border-top: 1px solid var(--border-subtle);
        border-radius: 16px 16px 0 0;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: var(--shadow-lg);
    }
    .headers-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 16px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .headers-head h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
    }
    .headers-body {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
        background: var(--bg-base);
    }
    .headers-pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.55;
        color: var(--text-primary);
    }
    .muted { color: var(--text-tertiary); }

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
        border-radius: 12px;
    }
    .phishing-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        max-width: 320px;
        margin: 16px;
        padding: 20px 22px;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(147, 51, 234, 0.35);
        border-radius: 16px;
        box-shadow: 0 18px 36px rgba(88, 28, 135, 0.22), 0 6px 12px rgba(88, 28, 135, 0.12);
        text-align: center;
        color: #4c1d95;
    }
    .phishing-card :global(.icon) {
        color: #7c3aed;
    }
    .phishing-title {
        margin: 0;
        font-size: 16px;
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
        line-height: 1.45;
        color: #581c87;
    }
    .phishing-indicators {
        margin: 0;
        padding: 0 0 0 18px;
        text-align: left;
        font-size: 13px;
        line-height: 1.45;
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
    .msg-content.blurred iframe,
    .msg-content.blurred pre {
        filter: blur(6px);
        opacity: 0.5;
        user-select: none;
        pointer-events: none;
    }

    /* Mobile AI-scan bubble: pinned (sticky) just under the top header,
     * floating over the message meta + body. Mirrors the desktop rail
     * so the user sees the same scan state on either form factor. */
    .scan-bubble-rail {
        position: sticky;
        top: 0;
        z-index: 5;
        margin: 6px 12px 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
        pointer-events: none;
    }
    .scan-bubble-rail:empty { display: none; }
    .scan-bubble-rail > * { pointer-events: auto; }
    .scan-bubble {
        max-width: 100%;
        padding: 8px 12px;
        border-radius: 999px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        line-height: 1.2;
        position: relative;
        overflow: hidden;
        animation: mob-bubble-in 320ms ease-out;
    }
    @keyframes mob-bubble-in {
        from { transform: translateY(-6px); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
    }
    .scan-bubble-scanning {
        background:
            radial-gradient(120% 220% at 0% 0%, rgba(216, 180, 254, 0.42), transparent 60%),
            linear-gradient(135deg, #6d28d9 0%, #8b5cf6 55%, #c4b5fd 100%);
        border: 1px solid color-mix(in srgb, #6d28d9 65%, transparent);
        box-shadow: 0 6px 18px rgba(109, 40, 217, 0.28), inset 0 1px 0 rgba(255,255,255,0.28);
        color: #f5f3ff;
    }
    .scan-bubble-warn {
        background:
            radial-gradient(120% 220% at 100% 0%, rgba(216, 180, 254, 0.55), transparent 55%),
            linear-gradient(135deg, #7c3aed 0%, #a855f7 50%, #d8b4fe 100%);
        border: 1px solid color-mix(in srgb, #7c3aed 65%, transparent);
        box-shadow: 0 6px 18px rgba(124, 58, 237, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.30);
        color: #fdf4ff;
    }
    .scan-bubble :global(svg) { color: currentColor; flex-shrink: 0; }
    .scan-bubble-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .scan-bubble-text strong { margin-right: 4px; }
    .scan-bubble-close {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.20);
        color: #ffffff;
        border: none;
        cursor: pointer;
    }
    .scan-bubble-close:hover { background: rgba(255, 255, 255, 0.32); }
    .scam-orb {
        position: relative;
        width: 22px; height: 22px;
        flex: 0 0 22px;
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
    .scam-orb-core { font-size: 13px; line-height: 1; animation: scam-orb-pulse 2.4s ease-in-out infinite; }
    @keyframes scam-orb-spin { to { transform: rotate(360deg); } }
    @keyframes scam-orb-pulse {
        0%, 100% { transform: scale(1); opacity: 0.92; }
        50%      { transform: scale(1.18); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
        .scam-orb-ring, .scam-orb-core, .scan-bubble { animation: none; }
    }
</style>
