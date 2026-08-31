<script lang="ts">
    import { onMount } from 'svelte';
    import { ui, showToast } from '../lib/store.svelte';
    import { sendStub, getSendFromAddresses, ApiError } from '../lib/api';
    import { authState } from '../lib/auth.svelte';
    import { formatAddress, formatFullDate } from '../lib/format';
    import { smtpAvailable, settings, setDisplayName, pickFromName } from '../lib/settings.svelte';
    import { playSent } from '../lib/sounds.svelte';
    import { addressBook, recordContact } from '../lib/address-book.svelte';
    import { trackSent } from '../lib/sent-status.svelte';
    import { suggestSubject, suggestSubjects } from '../lib/subject-suggest';
    import { aiAvailable } from '../lib/settings.svelte';
    import { summariseRecipientHistory, type HistorySummary } from '../lib/recipient-history';
    import { preSendCheck } from '../lib/pre-send-check';
    import RichEditor from './editor/RichEditor.svelte';
    import FloatingPanel from './FloatingPanel.svelte';
    import Icon from './Icon.svelte';

    interface Props {
        onClose: () => void;
    }
    let { onClose }: Props = $props();

    const replyTo = ui.composeContext?.replyTo || null;
    const replyMode = ui.composeContext?.mode || (replyTo ? 'reply' : 'new');

    function buildSubject(): string {
        if (!replyTo) return '';
        const subj = replyTo.envelope.subject || '';
        if (replyMode === 'forward') return subj.replace(/^(Fwd:\s*)+/i, '').replace(/^/, 'Fwd: ');
        return subj.replace(/^(Re:\s*)+/i, '').replace(/^/, 'Re: ');
    }

    function buildTo(): string {
        if (!replyTo || replyMode === 'forward') return '';
        return replyTo.envelope.from?.[0]?.address || '';
    }

    function buildCc(): string {
        if (!replyTo || replyMode !== 'replyAll') return '';
        const seen = new Set<string>();
        const fromAddr = replyTo.envelope.from?.[0]?.address;
        if (fromAddr) seen.add(fromAddr.toLowerCase());
        // Filter the active user out so a reply-all doesn't Cc yourself —
        // a quiet bug the new e2e caught.
        const me = (authState.activeUser || '').toLowerCase();
        if (me) seen.add(me);
        const collected: string[] = [];
        for (const a of [...(replyTo.envelope.to || []), ...(replyTo.envelope.cc || [])]) {
            if (!a.address) continue;
            const lower = a.address.toLowerCase();
            if (seen.has(lower)) continue;
            seen.add(lower);
            collected.push(a.address);
        }
        return collected.join(', ');
    }

    function escapeHtml(s: string): string {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function buildBodyHtml(): string {
        if (!replyTo) return '<p></p>';
        const isForward = replyMode === 'forward';
        const heading = isForward
            ? `--- Forwarded message ---<br>From: ${escapeHtml(formatAddress(replyTo.envelope.from?.[0]))}<br>Date: ${escapeHtml(formatFullDate(replyTo.internalDate || replyTo.envelope.date))}<br>Subject: ${escapeHtml(replyTo.envelope.subject || '')}`
            : `On ${escapeHtml(formatFullDate(replyTo.internalDate || replyTo.envelope.date))}, ${escapeHtml(formatAddress(replyTo.envelope.from?.[0]))} wrote:`;
        // HTML-only emails have no text part; fall back to stripping HTML so the
        // quoted body isn't blank.
        const sourceText = replyTo.text || htmlToPlainText(replyTo.html || '');
        const quoted = sourceText
            ? escapeHtml(sourceText).replace(/\n/g, '<br>')
            : '<em>[No text content]</em>';
        return `<p></p><p></p><p>${heading}</p><blockquote><p>${quoted}</p></blockquote>`;
    }

    /** HTML→plain-text fallback we send alongside the rich body so plain
     *  clients still see something readable. Uses DOMParser so attacker-
     *  controlled HTML (e.g. quoted from a malicious sender) can't trigger
     *  resource loads or fire event handlers during parsing. */
    function htmlToPlainText(html: string): string {
        const prepped = html
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<\s*br\s*\/?>/gi, '\n')
            .replace(/<\s*\/?\s*(p|div|li|h[1-6]|blockquote)\b[^>]*>/gi, '\n');
        const doc = new DOMParser().parseFromString(prepped, 'text/html');
        return (doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    let to = $state(buildTo());
    let cc = $state(buildCc());
    let bcc = $state('');
    let subject = $state(buildSubject());
    let body = $state(buildBodyHtml());

    // Empty-subject AI assist: when the user hits Send with no subject, we
    // ask the model for one and show it inline (purple) with Use / Edit /
    // Send anyway buttons. State is per-compose so closing resets it.
    let subjectSuggestion = $state<string | null>(null);
    let subjectSuggesting = $state(false);
    let subjectSuggestError = $state<string | null>(null);

    interface PendingAttachment { filename: string; contentType: string; size: number; content: string }
    let attachments = $state<PendingAttachment[]>([]);

    function fmtSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    function pickFiles() {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.multiple = true;
        inp.onchange = () => {
            const files = Array.from(inp.files || []);
            for (const f of files) {
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result as string;
                    // result is data:<mime>;base64,<data> — strip the prefix.
                    const base64 = result.includes(',') ? result.split(',', 2)[1] : result;
                    attachments = [...attachments, {
                        filename: f.name,
                        contentType: f.type || 'application/octet-stream',
                        size: f.size,
                        content: base64
                    }];
                };
                reader.readAsDataURL(f);
            }
        };
        inp.click();
    }
    function removeAttachment(i: number) {
        attachments = attachments.filter((_, j) => j !== i);
    }
    let showCcBcc = $state(buildCc().length > 0);
    let sending = $state(false);
    // Read-receipt tracker. When on, the server injects a 1×1 pixel into the
    // outbound HTML and emails me when the recipient opens the message. The
    // initial state mirrors settings.trackOpensDefault so users who always
    // want tracking only have to flip it once in Settings.
    let trackOpens = $state(settings.trackOpensDefault);

    // AI history reference. When the To field contains a single valid
    // address, we kick off a one-shot summary of the user's prior
    // exchanges with that contact. Hidden when the user dismisses, the
    // To field changes mid-fetch, or there's no AI provider.
    let historyAddr = $state<string | null>(null);
    let historyLoading = $state(false);
    let historySummary = $state<HistorySummary | null>(null);
    let historyDismissed = $state(false);
    let historyAbort: AbortController | null = null;
    let historyDebounce: ReturnType<typeof setTimeout> | null = null;

    // Pre-send AI check. Held back from sending so the user gets one
    // tap to consider the suggestion. Shift+Send bypasses entirely.
    let preCheckRunning = $state(false);
    let preCheckSuggestion = $state<string | null>(null);
    let preCheckRationale = $state('');
    let preCheckBypass = $state(false);
    // The submit event we held while running the check. After the user
    // resolves the modal we replay the actual send via doSend().
    let pendingSendArgs: { shiftKey: boolean } | null = null;

    // "Review and send" combined flow. When the user clicks the
    // primary send button (and AI is available + not bypassed), we
    // fetch two subject options + the pre-send proofread in parallel
    // and surface them in one modal. The user picks an option (or
    // keeps their own) and confirms — the actual send runs without
    // re-prompting.
    let reviewOpen = $state(false);
    let reviewLoading = $state(false);
    let subjectOptions = $state<string[]>([]);
    let chosenSubjectIdx = $state<number | null>(null);

    function pickPrimaryAddress(toField: string): string | null {
        const first = (toField || '').split(',')[0].trim();
        // Accept "Name <addr>" too — extract bare address.
        const angle = first.match(/<([^>]+)>/);
        const addr = (angle ? angle[1] : first).trim().toLowerCase();
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return addr;
        return null;
    }

    $effect(() => {
        const addr = pickPrimaryAddress(to);
        // Reset state when the user types beyond a recognised email or
        // changes the recipient. The dismissed flag is cleared by-addr
        // so toggling between contacts re-fetches history fresh.
        if (!addr) {
            historyAddr = null;
            historySummary = null;
            historyLoading = false;
            historyDismissed = false;
            if (historyAbort) { historyAbort.abort(); historyAbort = null; }
            return;
        }
        if (addr === historyAddr) return; // already loaded / loading
        historyAddr = addr;
        historySummary = null;
        historyDismissed = false;
        historyLoading = true;
        if (historyAbort) historyAbort.abort();
        historyAbort = new AbortController();
        if (historyDebounce) clearTimeout(historyDebounce);
        historyDebounce = setTimeout(async () => {
            const target = addr;
            try {
                const out = await summariseRecipientHistory(target, { signal: historyAbort!.signal });
                if (historyAbort?.signal.aborted) return;
                if (historyAddr !== target) return;
                historySummary = out;
            } finally {
                if (historyAddr === target) historyLoading = false;
            }
        }, 600);
    });

    // Send-from dropdown (mailbox + permanent + temp aliases). The endpoint
    // returns 5xx if the mailcow DB isn't configured — failure is silent and
    // we fall back to the logged-in user as the only option.
    let sendFromOptions = $state<string[]>([]);
    let wildcardDomains = $state<string[]>([]);

    // Reply-from-matched: if this message was addressed to one of the
    // user's known addresses (e.g. an alias), reply from that address so
    // the conversation stays on the same thread. Glow the To field briefly
    // when we auto-set the From this way.
    function pickReplyFrom(): { addr: string; matched: boolean } {
        const fallback = settings.defaultFromAddress || authState.activeUser || '';
        if (!replyTo || replyMode === 'forward') return { addr: fallback, matched: false };
        const known = new Set<string>();
        if (authState.activeUser) known.add(authState.activeUser.toLowerCase());
        for (const a of sendFromOptions) known.add(a.toLowerCase());
        for (const list of [replyTo.envelope.to || [], replyTo.envelope.cc || []]) {
            for (const a of list) {
                const addr = (a.address || '').toLowerCase();
                if (addr && known.has(addr)) return { addr: a.address!, matched: true };
            }
        }
        return { addr: fallback, matched: false };
    }

    let from = $state(pickReplyFrom().addr || authState.activeUser || '');
    let fromMatched = $state(false);
    let toGlow = $state(false);

    onMount(async () => {
        // Pull a pending attachment handed in from PdfViewer (or any
        // other surface that wants to start a reply with a file).
        if (ui.pendingAttachment) {
            const p = ui.pendingAttachment;
            const base64 = p.dataUrl.includes(',') ? p.dataUrl.split(',', 2)[1] : p.dataUrl;
            // Best-effort size estimate from base64 length.
            const size = Math.floor(base64.length * 0.75);
            attachments = [...attachments, {
                filename: p.filename,
                contentType: p.contentType,
                size,
                content: base64
            }];
            ui.pendingAttachment = null;
        }
        try {
            const res = await getSendFromAddresses();
            if (res.addresses.length) {
                sendFromOptions = res.addresses;
            }
            wildcardDomains = res.wildcardDomains || [];
        } catch { /* mailcow DB optional — silent fallback */ }
        // Re-pick now that we know the user's full address list. If the
        // active user opens a reply addressed to one of their aliases the
        // From swaps to that alias and the To field glows briefly.
        const picked = pickReplyFrom();
        from = picked.addr;
        fromMatched = picked.matched;
        if (picked.matched) {
            toGlow = true;
            setTimeout(() => { toGlow = false; }, 2400);
        }
    });

    const title = replyMode === 'forward' ? 'Forward'
        : replyMode === 'replyAll' ? 'Reply all'
        : replyMode === 'reply' ? 'Reply'
        : 'New message';

    async function fetchSubjectSuggestion() {
        subjectSuggestError = null;
        subjectSuggesting = true;
        try {
            const plain = htmlToPlainText(body);
            const sug = await suggestSubject(plain);
            if (sug) {
                subjectSuggestion = sug;
            } else {
                subjectSuggestError = 'Couldn\'t draft a subject — type one to send.';
            }
        } catch (err) {
            subjectSuggestError = (err as Error).message || 'AI subject failed.';
        } finally {
            subjectSuggesting = false;
        }
    }

    function acceptSubjectSuggestion() {
        if (subjectSuggestion) {
            subject = subjectSuggestion;
            subjectSuggestion = null;
        }
    }

    function declineSubjectSuggestion() {
        subjectSuggestion = null;
        subjectSuggestError = null;
    }

    async function trySend(e: SubmitEvent) {
        e.preventDefault();
        if (!to.trim() || !smtpAvailable()) return;

        const submitter = (e.submitter as HTMLElement | null);
        const shiftBypass = !!(e as unknown as { shiftKey?: boolean }).shiftKey
            || (submitter ? submitter.dataset.shift === 'true' : false);

        // Shift-Send (or no AI configured) → straight to send. Empty
        // subject is fine; the server will accept it.
        if (shiftBypass || !aiAvailable() || preCheckBypass) {
            await doSend();
            return;
        }

        // Combined "Review and send" flow — fetch two subject options
        // and the proofread in parallel, then open one modal where the
        // user picks an option (or keeps their own subject) and
        // confirms. Cheap when both come back fast; the modal opens
        // immediately with a spinner if either is slow.
        await runReviewAndSend();
    }

    async function runReviewAndSend() {
        if (reviewLoading) return;
        reviewOpen = true;
        reviewLoading = true;
        subjectOptions = [];
        chosenSubjectIdx = null;
        preCheckSuggestion = null;
        preCheckRationale = '';

        const wantsSubject = !subject.trim();
        const wantsCheck = settings.preSendCheck !== false;
        const plain = htmlToPlainText(body);
        try {
            const tasks: Promise<unknown>[] = [];
            if (wantsSubject) {
                tasks.push(suggestSubjects(plain).then((opts) => {
                    subjectOptions = opts;
                    if (opts.length > 0) chosenSubjectIdx = 0;
                }).catch(() => { /* leave empty — modal will say "couldn't draft" */ }));
            }
            if (wantsCheck) {
                tasks.push(preSendCheck({
                    subject: subject.trim() || (subjectOptions[0] || ''),
                    body: plain,
                    to,
                    cc: cc || undefined
                }).then((out) => {
                    if (out.suggestion) {
                        preCheckSuggestion = out.suggestion;
                        preCheckRationale = out.rationale;
                    }
                }).catch(() => { /* proofread is best-effort */ }));
            }
            await Promise.all(tasks);
        } finally {
            reviewLoading = false;
        }
    }

    async function confirmReviewAndSend() {
        if (chosenSubjectIdx !== null && subjectOptions[chosenSubjectIdx]) {
            subject = subjectOptions[chosenSubjectIdx];
        }
        reviewOpen = false;
        preCheckSuggestion = null;
        preCheckRationale = '';
        preCheckBypass = true;
        await doSend();
    }

    function cancelReview() {
        reviewOpen = false;
        // Keep the subject options around in case the user re-opens —
        // bypassing the second LLM call. They get cleared on next mount
        // or when the body changes (suggestSubjects caches per-body).
        preCheckSuggestion = null;
        preCheckRationale = '';
    }

    async function doSend() {
        if (!to.trim() || !smtpAvailable()) return;
        sending = true;
        try {
            const toList = to.split(',').map((s) => s.trim()).filter(Boolean);
            const ccList = cc.split(',').map((s) => s.trim()).filter(Boolean);
            const bccList = bcc.split(',').map((s) => s.trim()).filter(Boolean);
            // Harvest every recipient we just typed into the local
            // address book so the next compose autocomplete picks them
            // up without us having to wait for an inbound reply.
            for (const addr of [...toList, ...ccList, ...bccList]) {
                const m = addr.match(/^\s*("?[^"<]*"?)\s*<\s*([^>]+)\s*>\s*$/);
                if (m) recordContact(m[2], m[1].replace(/^"|"$/g, '').trim() || null);
                else recordContact(addr);
            }
            const r = await sendStub({
                to: toList,
                cc: ccList.length ? ccList : undefined,
                bcc: bccList.length ? bccList : undefined,
                from: from.trim() || undefined,
                fromName: pickFromName(from || authState.activeUser || ''),
                subject: subject.trim(),
                html: body,
                text: htmlToPlainText(body),
                inReplyTo: replyTo?.envelope.messageId || undefined,
                trackOpens: trackOpens || undefined,
                attachments: attachments.length
                    ? attachments.map((a) => ({
                        filename: a.filename,
                        contentType: a.contentType,
                        content: a.content
                    }))
                    : undefined
            });
            playSent();
            // Start tracking delivery — we'll hand off to the toast/tray in
            // Layout.svelte which polls /v1/messages/send/:id/status with
            // backoff and updates the badge as the DSN lands.
            if (r?.messageId) {
                trackSent({ messageId: r.messageId, subject: subject.trim(), to: toList.join(', ') });
                showToast('info', 'Sending… we\'ll let you know when it\'s delivered.');
            } else {
                showToast('success', 'Message sent');
            }
            onClose();
        } catch (err) {
            const detail = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', detail || 'Send failed');
        } finally {
            sending = false;
        }
    }
</script>

<FloatingPanel
    title={title + (subject ? ` — ${subject}` : '')}
    storageKey={`compose.${replyMode}`}
    defaultWidth={640}
    defaultHeight={520}
    minWidth={380}
    minHeight={320}
    onClose={onClose}
    testId="compose-modal"
    overlayVisible={sending}
>
    <!-- autocomplete="off" + the password-manager-ignore data attrs keep
         Bitwarden / 1Password / LastPass from injecting login credentials
         into Compose fields. Keep the list= attrs so the native datalist
         autocomplete (recipients, From aliases) still works. -->
    <form
        onsubmit={trySend}
        novalidate
        class="form"
        autocomplete="off"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
    >
        <label class="row">
            <span class="lbl">From</span>
            <div class="from-pair">
                <input
                    type="email"
                    bind:value={from}
                    list="compose-from-options"
                    placeholder={authState.activeUser || 'you@example.com'}
                    autocomplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    data-testid="compose-from"
                />
                <input
                    type="text"
                    class="display-name-inline"
                    value={settings.displayName}
                    oninput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)}
                    placeholder="Display name (optional)"
                    title="Friendly name shown next to your address — saved across sends"
                    autocomplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    data-testid="compose-from-name"
                />
            </div>
            <datalist id="compose-from-options">
                {#if authState.activeUser && !sendFromOptions.includes(authState.activeUser)}
                    <option value={authState.activeUser}></option>
                {/if}
                {#each sendFromOptions as addr (addr)}
                    <option value={addr}></option>
                {/each}
                {#each wildcardDomains as d (d)}
                    <!-- Catch-all stub: the type-anything+@domain hint, lets
                         the browser autocomplete after the local part. -->
                    <option value={`anything@${d}`}></option>
                    <option value={`hello@${d}`}></option>
                    <option value={`signup-${Math.random().toString(36).slice(2,7)}@${d}`}></option>
                {/each}
                <!-- Plus-addressed suggestions: postfix-style sub-tags route
                     back to the user's mailbox without needing a real alias. -->
                {#if authState.activeUser}
                    {@const at = authState.activeUser.indexOf('@')}
                    {#if at > 0}
                        {@const local = authState.activeUser.slice(0, at)}
                        {@const domain = authState.activeUser.slice(at + 1)}
                        <option value={`${local}+work@${domain}`}></option>
                        <option value={`${local}+personal@${domain}`}></option>
                        <option value={`${local}+newsletter@${domain}`}></option>
                    {/if}
                {/if}
            </datalist>
            {#if wildcardDomains.length > 0}
                <div class="from-wildcard-hint" data-testid="compose-from-wildcard">
                    <Icon name="sparkles" size={11} />
                    <span>Catch-all on
                        {#each wildcardDomains as d, i (d)}
                            <button
                                type="button"
                                class="domain-chip"
                                title={`Insert @${d} into the From field`}
                                onclick={() => {
                                    const at = from.indexOf('@');
                                    const local = at > 0 ? from.slice(0, at) : (from || 'me');
                                    from = `${local}@${d}`;
                                }}
                            >@{d}</button>{i < wildcardDomains.length - 1 ? ' ' : ''}
                        {/each}
                        — type anything before the @
                    </span>
                </div>
            {/if}
        </label>
        <label class="row" class:to-glow={toGlow}>
            <span class="lbl">To</span>
            <div class="row-input">
                <input
                    type="text"
                    bind:value={to}
                    list="compose-contacts"
                    placeholder="someone@example.com, …"
                    autocomplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    data-testid="compose-to"
                    required
                />
                {#if !showCcBcc}
                    <button
                        type="button"
                        class="ccbcc-toggle"
                        onclick={() => (showCcBcc = true)}
                        data-testid="compose-show-ccbcc"
                    >Cc / Bcc</button>
                {/if}
            </div>
        </label>

        {#if showCcBcc}
            <label class="row">
                <span class="lbl">Cc</span>
                <input
                    type="text"
                    bind:value={cc}
                    list="compose-contacts"
                    placeholder="optional"
                    autocomplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    data-testid="compose-cc"
                />
            </label>
            <label class="row">
                <span class="lbl">Bcc</span>
                <input
                    type="text"
                    bind:value={bcc}
                    list="compose-contacts"
                    placeholder="optional"
                    autocomplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    data-testid="compose-bcc"
                />
            </label>
        {/if}

        <!-- Address-book autocomplete shared by To/Cc/Bcc. Population is
             passive — every envelope we render gets harvested into the
             local address book. -->
        <datalist id="compose-contacts">
            <!-- Cap to the 8 most-recent / most-frequent contacts; native
                 <datalist> shows everything we hand it and the dropdown
                 grew unmanageable. -->
            {#each addressBook.contacts.slice().sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen).slice(0, 8) as c (c.address)}
                <option value={c.address} label={c.name || ''}></option>
            {/each}
        </datalist>

        <label class="row">
            <span class="lbl">Subject</span>
            <div class="subject-wrap">
                <input
                    type="text"
                    bind:value={subject}
                    autocomplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    data-testid="compose-subject"
                    placeholder={subjectSuggesting ? 'Drafting subject…' : 'Subject (tap the wand for an AI suggestion)'}
                />
                <button
                    type="button"
                    class="wand-btn"
                    title={subjectSuggesting ? 'Drafting…' : 'Generate a subject from the body with AI'}
                    aria-label="Suggest subject with AI"
                    onclick={fetchSubjectSuggestion}
                    disabled={subjectSuggesting}
                    data-testid="compose-subject-wand"
                >
                    {#if subjectSuggesting}<span class="spinner"></span>{:else}<Icon name="wand" size={14} />{/if}
                </button>
            </div>
        </label>
        {#if subjectSuggestion}
            <div class="subj-sugg" role="status" aria-live="polite" data-testid="compose-subject-sugg">
                <Icon name="sparkles" size={12} />
                <span class="sugg-label">AI suggestion:</span>
                <span class="sugg-text">{subjectSuggestion}</span>
                <button type="button" class="sugg-btn accept" onclick={acceptSubjectSuggestion} title="Use this subject" data-testid="compose-subject-accept">Use</button>
                <button type="button" class="sugg-btn decline" onclick={declineSubjectSuggestion} title="Dismiss" data-testid="compose-subject-decline">Decline</button>
            </div>
        {:else if subjectSuggestError}
            <div class="subj-err" role="alert">{subjectSuggestError}</div>
        {/if}

        {#if settings.composeHistorySummary && historyAddr && !historyDismissed}
            <div class="history-panel" data-testid="compose-history-panel">
                <Icon name="sparkles" size={12} />
                {#if historyLoading}
                    <span class="history-text muted">Reading your history with {historyAddr}…</span>
                    <span class="spinner small"></span>
                {:else if historySummary}
                    <span class="history-text">
                        <strong>{historySummary.count} prior message{historySummary.count === 1 ? '' : 's'}</strong>
                        {#if historySummary.oldest && historySummary.newest && historySummary.oldest !== historySummary.newest}
                            ({historySummary.oldest} – {historySummary.newest})
                        {:else if historySummary.newest}
                            (last {historySummary.newest})
                        {/if}
                        — {historySummary.summary}
                    </span>
                {:else}
                    <span class="history-text muted">No prior messages with {historyAddr}.</span>
                {/if}
                <button
                    type="button"
                    class="history-dismiss"
                    title="Hide for this draft"
                    aria-label="Hide history"
                    onclick={() => (historyDismissed = true)}
                ><Icon name="close" size={11} /></button>
            </div>
        {/if}

        <div
            class="body"
            class:reply-mode={replyMode === 'reply' || replyMode === 'replyAll'}
            onfocusout={(e) => {
                // When the user clicks outside the body editor and the
                // setting is on, ask the AI for a subject. The focusout
                // event still fires inside .body when focus moves between
                // the rich editor's child contenteditables, so guard
                // against the new focus target still being inside .body.
                if (!settings.aiSuggestSubjectOnBlur) return;
                if (subject.trim() || subjectSuggestion || subjectSuggesting) return;
                if (htmlToPlainText(body).length < 12) return;
                const next = e.relatedTarget as HTMLElement | null;
                if (next && (e.currentTarget as HTMLElement).contains(next)) return;
                void fetchSubjectSuggestion();
            }}
        >
            <RichEditor
                bind:html={body}
                ghostPlaceholder={replyMode === 'reply' || replyMode === 'replyAll'}
                placeholder={replyMode === 'forward' ? 'Add a note above the forwarded message…'
                    : (replyMode === 'reply' || replyMode === 'replyAll')
                        ? 'Write your reply here — the original message stays quoted below.'
                        : 'Write your message…'}
            />
        </div>
    </form>

    {#if reviewOpen}
        <div class="presend-overlay" role="dialog" aria-modal="true" aria-labelledby="review-title" data-testid="compose-review-modal">
            <div class="presend-card">
                <div class="presend-head">
                    <Icon name="sparkles" size={18} />
                    <h4 id="review-title">Review and send</h4>
                </div>

                {#if reviewLoading}
                    <p class="presend-body"><span class="spinner small"></span> Reviewing your draft…</p>
                {:else}
                    {#if !subject.trim() && subjectOptions.length > 0}
                        <p class="presend-body" style="margin-bottom: 6px;"><strong>Pick a subject:</strong></p>
                        <div class="subject-options" data-testid="compose-review-options">
                            {#each subjectOptions as opt, i (i)}
                                <button
                                    type="button"
                                    class="subject-opt"
                                    class:chosen={chosenSubjectIdx === i}
                                    onclick={() => { chosenSubjectIdx = i; }}
                                    data-testid={`compose-review-option-${i}`}
                                >
                                    <Icon name={chosenSubjectIdx === i ? 'check' : 'sparkles'} size={12} />
                                    <span>{opt}</span>
                                </button>
                            {/each}
                        </div>
                    {:else if !subject.trim()}
                        <p class="presend-body muted small">Couldn't draft a subject — sending without one.</p>
                    {/if}

                    {#if preCheckSuggestion}
                        <div class="presend-rationale-box">
                            <p class="presend-body" style="margin-top: 10px;">
                                <strong>Heads-up:</strong> {preCheckSuggestion}
                            </p>
                            {#if preCheckRationale}
                                <p class="presend-rationale">{preCheckRationale}</p>
                            {/if}
                        </div>
                    {:else if subject.trim() || subjectOptions.length > 0}
                        <p class="presend-body muted small" style="margin-top: 6px;">No issues spotted.</p>
                    {/if}
                {/if}

                <div class="presend-actions">
                    <button
                        type="button"
                        class="btn btn-ghost"
                        onclick={cancelReview}
                        data-testid="compose-review-edit"
                    >Edit draft</button>
                    <button
                        type="button"
                        class="btn btn-primary"
                        disabled={reviewLoading || sending}
                        onclick={confirmReviewAndSend}
                        data-testid="compose-review-send"
                    >
                        <Icon name="send" size={14} />
                        Send
                    </button>
                </div>
                <p class="presend-hint muted small">Tip: hold Shift while clicking Send to skip the review next time.</p>
            </div>
        </div>
    {/if}

    {#snippet footer()}
        {#if attachments.length}
            <ul class="attach-tray" data-testid="compose-attachments">
                {#each attachments as a, i (i)}
                    <li class="attach-chip" title={a.contentType}>
                        <Icon name="paperclip" size={11} />
                        <span class="attach-name truncate">{a.filename}</span>
                        <span class="muted small">{fmtSize(a.size)}</span>
                        <button
                            type="button"
                            class="attach-rm"
                            aria-label={`Remove ${a.filename}`}
                            onclick={() => removeAttachment(i)}
                        ><Icon name="close" size={10} /></button>
                    </li>
                {/each}
            </ul>
        {/if}
        <div class="foot-bar">
            <div class="foot-left">
                <button
                    type="button"
                    class="btn btn-ghost"
                    title="Attach files"
                    aria-label="Attach files"
                    onclick={pickFiles}
                    data-testid="compose-attach-btn"
                >
                    <Icon name="paperclip" size={15} />
                </button>
                <button
                    type="button"
                    class={`btn btn-ghost spy-btn icon-only ${trackOpens ? 'on' : ''}`}
                    title={trackOpens
                        ? 'Invisible Tracker is ON — you\'ll get an email when this message is opened. Click to disable.'
                        : 'Invisible Tracker — get an email when the recipient opens this message.'}
                    aria-label={trackOpens ? 'Disable invisible tracker' : 'Enable invisible tracker'}
                    aria-pressed={trackOpens}
                    onclick={() => { trackOpens = !trackOpens; }}
                    data-testid="compose-spy-btn"
                >
                    <Icon name="spy" size={16} />
                </button>
                {#if trackOpens}
                    <!-- Tracking is invisible to the recipient, so it must be
                         plainly visible to the sender for as long as it is on
                         — an icon that merely looks "active" is too easy to
                         leave enabled without noticing. -->
                    <span class="tracking-note" data-testid="compose-tracking-note">
                        Tracking on — you'll be told when this is opened.
                        <button
                            type="button"
                            class="tracking-off"
                            onclick={() => { trackOpens = false; }}
                        >Turn off</button>
                    </span>
                {/if}
                {#if !smtpAvailable()}
                    <span class="hint" data-testid="compose-status">
                        Sending isn't enabled — your text will be saved as a draft.
                    </span>
                {/if}
            </div>
            <div class="foot-right">
                <button type="button" class="btn btn-ghost" onclick={onClose}>Cancel</button>
                <button
                    type="submit"
                    class="btn btn-primary"
                    onclick={(e) => {
                        const formEl = (e.currentTarget as HTMLButtonElement).closest('[role=dialog]')?.querySelector('form');
                        if (formEl) (formEl as HTMLFormElement).requestSubmit();
                    }}
                    disabled={sending || reviewLoading || !to.trim() || !smtpAvailable()}
                    title={smtpAvailable() ? (aiAvailable() ? 'Review and send (Shift+Click to skip review)' : 'Send') : 'SMTP not configured on the server'}
                    data-testid="compose-send"
                >
                    {#if sending || reviewLoading}<span class="spinner"></span>{/if}
                    <Icon name="send" size={14} />
                    {sending ? 'Sending…'
                        : reviewLoading ? 'Reviewing…'
                        : !smtpAvailable() ? 'Save draft'
                        : aiAvailable() ? 'Review and send'
                        : 'Send'}
                </button>
            </div>
        </div>
    {/snippet}

    {#snippet overlay()}
        <div class="send-overlay" data-testid="compose-sending-overlay">
            <span class="spinner" style="width: 28px; height: 28px; border-width: 3px;"></span>
            <span class="send-label">Sending…</span>
        </div>
    {/snippet}
</FloatingPanel>

<style>
    .form {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
    }
    .row {
        display: grid;
        grid-template-columns: 80px 1fr;
        align-items: center;
        gap: 8px;
        padding: 8px 18px;
        border-bottom: 1px solid var(--border-subtle);
        transition: background-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    /* Glow when the From auto-matched the address the original message
     * was sent to — signals to the user that the reply is going out from
     * the same alias that received it. */
    .row.to-glow {
        background: color-mix(in srgb, var(--accent) 8%, transparent);
        box-shadow: inset 4px 0 0 var(--accent);
        animation: to-glow-pulse 2.4s ease-out;
    }
    @keyframes to-glow-pulse {
        0%   { background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: inset 4px 0 0 var(--accent), 0 0 18px color-mix(in srgb, var(--accent) 30%, transparent); }
        100% { background: transparent; box-shadow: inset 0 0 0 var(--accent); }
    }
    .lbl {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        font-weight: 600;
    }
    .subj-sugg {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 18px 10px;
        border-bottom: 1px solid var(--border-subtle);
        font-size: 12.5px;
        color: #9333ea;  /* purple per the spec — distinct from accent */
        background: color-mix(in srgb, #9333ea 7%, var(--bg-surface));
    }
    .sugg-label { font-weight: 600; flex-shrink: 0; }
    .sugg-text {
        flex: 1;
        min-width: 0;
        font-style: italic;
        color: #9333ea;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .sugg-btn {
        flex-shrink: 0;
        font-size: 11.5px;
        font-weight: 600;
        padding: 3px 9px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, #9333ea 30%, var(--border-subtle));
        background: var(--bg-surface);
        color: #9333ea;
        cursor: pointer;
    }
    .sugg-btn.accept { background: #9333ea; color: white; border-color: #9333ea; }
    .sugg-btn.accept:hover { filter: brightness(1.05); }
    .sugg-btn.decline:hover {
        background: color-mix(in srgb, #9333ea 12%, var(--bg-surface));
    }
    .subj-err {
        padding: 6px 18px 8px;
        border-bottom: 1px solid var(--border-subtle);
        font-size: 12px;
        color: var(--danger, #dc2626);
    }
    /* AI history reference. Sits between the subject row and the body
       editor, kept compact so it never dominates the compose pane. */
    .history-panel {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin: 6px 14px 10px;
        padding: 8px 12px;
        background: color-mix(in srgb, var(--accent) 7%, var(--bg-surface));
        border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border-subtle));
        border-radius: 10px;
        font-size: 12.5px;
        line-height: 1.45;
        color: var(--text-primary);
    }
    .history-panel :global(svg) { flex-shrink: 0; margin-top: 2px; color: var(--accent-text); }
    .history-text { flex: 1; min-width: 0; word-break: break-word; }
    .history-dismiss {
        flex-shrink: 0;
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: transparent;
        color: var(--text-tertiary);
        border: none;
        cursor: pointer;
    }
    .history-dismiss:hover { background: var(--bg-hover); color: var(--text-primary); }
    .spinner.small { width: 12px; height: 12px; border-width: 2px; }
    /* Pre-send modal — sits over the compose pane. Held back from
       scary phishing-overlay treatment because it's just a friendly
       sanity check, not a warning. */
    .presend-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 50;
        padding: 16px;
    }
    .presend-card {
        background: var(--bg-surface);
        border-radius: 14px;
        padding: 18px 22px;
        max-width: 460px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.32);
        border: 1px solid var(--border-subtle);
    }
    .presend-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }
    .presend-head :global(svg) { color: var(--accent-text); }
    .presend-head h4 { margin: 0; font-size: 16px; }
    .presend-body { font-size: 14px; line-height: 1.5; margin: 4px 0 0; }
    .presend-rationale {
        font-size: 12.5px;
        color: var(--text-secondary);
        margin: 8px 0 0;
        font-style: italic;
    }
    .presend-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 16px;
    }
    .presend-hint { margin: 10px 0 0; text-align: right; }
    .subject-options {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 4px;
    }
    .subject-opt {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 11px;
        border-radius: 9px;
        border: 1.5px solid var(--border-subtle);
        background: var(--bg-base);
        color: var(--text-primary);
        font-size: 13.5px;
        text-align: left;
        cursor: pointer;
        transition: background-color var(--transition-fast), border-color var(--transition-fast);
    }
    .subject-opt:hover { background: var(--bg-hover); }
    .subject-opt.chosen {
        border-color: var(--accent);
        background: color-mix(in oklab, var(--accent) 8%, var(--bg-base));
    }
    .subject-opt.chosen :global(svg) { color: var(--accent-text); }
    .presend-rationale-box { margin-top: 6px; }
    .subject-wrap {
        display: flex;
        align-items: stretch;
        gap: 6px;
    }
    .subject-wrap input { flex: 1; min-width: 0; }
    .wand-btn {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: linear-gradient(135deg, var(--accent), #d268f4);
        color: white;
        border: none;
        cursor: pointer;
        box-shadow: 0 1px 3px color-mix(in srgb, var(--accent) 35%, transparent);
        transition: filter 120ms ease, transform 80ms ease;
    }
    .wand-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-0.5px); }
    .wand-btn:active { transform: translateY(0); }
    .wand-btn:disabled { opacity: 0.6; cursor: progress; }
    .wand-btn .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.4);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .from-wildcard-hint {
        grid-column: 2;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 4px;
        font-size: 11.5px;
        color: var(--text-secondary);
    }
    .from-pair {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
        gap: 6px;
        align-items: center;
    }
    .display-name-inline {
        font-style: italic;
        color: var(--text-secondary);
    }
    .display-name-inline::placeholder {
        opacity: 0.7;
    }
    .domain-chip {
        display: inline-flex;
        align-items: center;
        padding: 1px 8px;
        margin: 0 2px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        font-family: var(--font-mono);
        background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface-alt));
        border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border-subtle));
        color: var(--accent-text);
        cursor: pointer;
    }
    .domain-chip:hover {
        background: color-mix(in srgb, var(--accent) 22%, var(--bg-surface-alt));
    }
    .row-input { display: flex; align-items: center; gap: 8px; }
    .row-input input { flex: 1; }
    .ccbcc-toggle {
        font-size: 12px;
        color: var(--text-tertiary);
        padding: 4px 8px;
        border-radius: var(--radius-xs);
    }
    .ccbcc-toggle:hover { background: var(--bg-hover); color: var(--text-primary); }
    .row input,
    .row select {
        border: none;
        background: transparent;
        padding: 6px 4px;
        font-size: 14px;
        width: 100%;
    }
    .row select {
        /* Strip the default OS chevron / border without losing the click area */
        appearance: none;
        -webkit-appearance: none;
        background-image: linear-gradient(45deg, transparent 50%, var(--text-tertiary) 50%),
                          linear-gradient(135deg, var(--text-tertiary) 50%, transparent 50%);
        background-position: calc(100% - 14px) center, calc(100% - 9px) center;
        background-size: 5px 5px, 5px 5px;
        background-repeat: no-repeat;
        padding-right: 24px;
        cursor: pointer;
    }
    .row select option {
        color: var(--text-primary);
        background: var(--bg-surface);
    }
    .row input:focus,
    .row select:focus {
        outline: none;
        border-color: transparent;
        box-shadow: none;
    }
    .body {
        flex: 1;
        min-height: 240px;
        display: flex;
        flex-direction: column;
        padding: 12px 14px 14px;
        background: transparent;
    }
    /* In reply / replyAll modes the editor itself glows for 1.6 s on mount so the
     * user's eye is drawn to the input. The "Write your reply here…" hint now
     * lives inside the editor (ghost-glow placeholder) instead of as a banner. */
    .body.reply-mode :global(.rich-editor) {
        animation: reply-glow 1.6s cubic-bezier(0.2, 0.7, 0.2, 1) 1;
    }
    @keyframes reply-glow {
        0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent); border-color: var(--accent); }
        80%  { box-shadow: 0 0 0 8px color-mix(in srgb, var(--accent) 0%, transparent); }
        100% { box-shadow: 0 0 0 0 transparent; }
    }
    @media (prefers-reduced-motion: reduce) {
        .body.reply-mode :global(.rich-editor) { animation: none; }
    }
    .body-fallback {
        flex: 1;
        min-height: 240px;
        padding: 14px 16px;
        font-family: var(--font-sans);
        font-size: 14.5px;
        line-height: 1.6;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        resize: none;
    }
    .body-fallback:focus {
        outline: none;
        border-color: var(--border-focus);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .foot-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 16px;
    }
    .attach-tray {
        list-style: none;
        margin: 0;
        padding: 6px 14px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        border-top: 1px solid var(--border-subtle);
    }
    .attach-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 4px 4px 10px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        font-size: 11.5px;
        max-width: 280px;
    }
    .attach-name { font-weight: 500; max-width: 180px; }
    .attach-rm {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        color: var(--text-tertiary);
    }
    .attach-rm:hover { background: var(--bg-hover); color: var(--danger); }
    .foot-left {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
    }
    .foot-right { display: flex; align-items: center; gap: 8px; }
    .hint {
        font-size: 12px;
        color: var(--text-tertiary);
        font-style: italic;
        max-width: 320px;
    }
    /* Spy / read-tracker toggle. Off state shows text label so it's
     * unmistakeable; on state glows red so you can't forget it's active. */
    .tracking-note {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--text-secondary);
        background: var(--bg-hover);
        border-radius: 999px;
        padding: 3px 6px 3px 10px;
    }
    .tracking-off {
        border: 0;
        background: transparent;
        color: var(--accent);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 999px;
    }
    .tracking-off:hover { background: var(--bg-surface); }

    .spy-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        position: relative;
        color: var(--text-secondary);
        font-weight: 600;
        font-size: 12.5px;
        padding: 5px 10px;
        border-radius: var(--radius-sm);
        transition: color var(--transition-fast), background var(--transition-fast),
                    box-shadow var(--transition-fast);
    }
    .spy-btn:hover {
        color: var(--text-primary);
        background: var(--bg-hover);
    }
    .spy-label { letter-spacing: 0.01em; }
    /* Red glow rather than the user's accent — tracking is a "watch out"
     * signal, not a positive one, so it should pop regardless of skin. */
    .spy-btn.on {
        color: #ff5b6b;
        background: rgba(255, 80, 96, 0.14);
        box-shadow: 0 0 0 1px rgba(255, 80, 96, 0.45),
                    0 0 12px rgba(255, 80, 96, 0.5);
        animation: spy-pulse 2.6s ease-in-out infinite;
    }
    @keyframes spy-pulse {
        0%, 100% { box-shadow: 0 0 0 1px rgba(255, 80, 96, 0.40),
                              0 0 8px rgba(255, 80, 96, 0.40); }
        50%      { box-shadow: 0 0 0 1px rgba(255, 80, 96, 0.65),
                              0 0 18px rgba(255, 80, 96, 0.70); }
    }
    @media (prefers-reduced-motion: reduce) {
        .spy-btn.on { animation: none; }
    }
    .spy-hint {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: #ff5b6b;
        background: rgba(255, 80, 96, 0.12);
        padding: 2px 8px;
        border-radius: 999px;
    }
    .send-overlay {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        animation: send-overlay-in 220ms ease-out;
    }
    @keyframes send-overlay-in {
        from { opacity: 0; transform: scale(0.96); }
        to { opacity: 1; transform: none; }
    }
    .send-label {
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
        letter-spacing: 0.02em;
    }
</style>
