<script lang="ts">
    import { onMount } from 'svelte';
    import { ui, showToast } from '../lib/store.svelte';
    import { sendStub, getSendFromAddresses, draftReply, ApiError } from '../lib/api';
    import { authState } from '../lib/auth.svelte';
    import { formatAddress, formatFullDate } from '../lib/format';
    import { smtpAvailable, settings, setDisplayName, pickFromName } from '../lib/settings.svelte';
    import { playSent } from '../lib/sounds.svelte';
    import {
        addressBook, recordContact, searchContacts, contactNameFor,
        type Contact
    } from '../lib/address-book.svelte';
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

    // ─── Recipient pills ─────────────────────────────────────────────────
    // To/Cc/Bcc read like Outlook's token fields: a recipient turns into a
    // pill the moment the user finishes it (Enter, comma, semicolon, or
    // simply leaving the field) and the input then carries only the
    // half-typed tail. The field value itself stays the canonical
    // comma-joined string that doSend() parses, so the pills are purely a
    // view over it — nothing downstream needs to know they exist.
    type RecipField = 'to' | 'cc' | 'bcc';
    // Text already turned into pills, always a whole number of "addr, "
    // entries so the input's value is simply `value.slice(prefix.length)`.
    let recipPrefix = $state<Record<RecipField, string>>({ to: '', cc: '', bcc: '' });
    let activeField = $state<RecipField | null>(null);

    function recipValue(f: RecipField): string {
        return f === 'to' ? to : f === 'cc' ? cc : bcc;
    }
    function setRecipValue(f: RecipField, v: string) {
        if (f === 'to') to = v;
        else if (f === 'cc') cc = v;
        else bcc = v;
    }
    function recipChips(f: RecipField): string[] {
        return recipPrefix[f].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    }
    function recipLive(f: RecipField): string {
        return recipValue(f).slice(recipPrefix[f].length);
    }
    function setRecipChips(f: RecipField, addrs: string[]) {
        const prefix = addrs.map((a) => `${a}, `).join('');
        recipPrefix[f] = prefix;
        setRecipValue(f, prefix);
    }
    /** Promote whatever is being typed into a pill. */
    function commitRecip(f: RecipField) {
        const live = recipLive(f).replace(/[,;]\s*$/, '').trim();
        if (!live) return;
        const existing = recipChips(f);
        // The address is the {#each} key, so a duplicate is a duplicate key:
        // Svelte throws on that in dev, and in prod the keyed map collapses
        // it while the send still goes out twice. Drop the repeat instead.
        if (existing.some((a) => a.toLowerCase() === live.toLowerCase())) {
            setRecipChips(f, existing);
            return;
        }
        setRecipChips(f, [...existing, live]);
    }
    function removeRecip(f: RecipField, addr: string) {
        setRecipChips(f, recipChips(f).filter((a) => a !== addr));
    }
    /** Backspace in an empty field pops the last pill, as in Outlook. */
    function popRecip(f: RecipField) {
        const addrs = recipChips(f);
        if (!addrs.length) return;
        addrs.pop();
        setRecipChips(f, addrs);
    }
    /** Show a contact's friendly name on its pill when we know one. */
    function contactName(addr: string): string {
        return contactNameFor(addr);
    }

    // ── recipient suggestions ──
    //
    // A real dropdown, not <datalist>. The ask was a picker that shows a
    // friendly name AND people from past mail, and a datalist cannot do
    // that: its `label` attribute is rendered inconsistently (Chrome shows
    // it, Firefox and Safari largely ignore it) and there is no way to show
    // a secondary line. So the chips and input stay exactly as they are —
    // free-form typing is untouched — and a listbox is layered underneath.
    //
    // The dropdown is derived, not stored: it is a pure function of the text
    // being typed, so there is no cache to invalidate and no state to get
    // out of step with the input.
    let suggestField = $state<RecipField | null>(null);
    let suggestIndex = $state(0);
    /**
     * The text the open list was built from, captured on every keystroke.
     *
     * Held as its own state rather than re-derived from the input on each
     * render, because the input's value is owned by the chips/prefix
     * machinery and re-reading it mid-render is what made the list fall
     * back to "everything" and lose the filter. Keeping the query next to
     * the list means the two cannot disagree.
     */
    let suggestQuery = $state('');

    const SUGGEST_LIMIT = 8;

    /** The trailing token of the field is the one being typed. */
    function currentToken(f: RecipField): string {
        const q = recipLive(f).trim();
        const comma = q.lastIndexOf(',');
        const semi = q.lastIndexOf(';');
        const cut = Math.max(comma, semi);
        return q.slice(cut + 1).trim();
    }

    function openSuggest(f: RecipField) {
        suggestField = f;
        suggestQuery = currentToken(f);
        suggestIndex = 0;
    }

    function closeSuggest() {
        suggestField = null;
        suggestQuery = '';
        suggestIndex = 0;
    }

    function recipSuggestions(f: RecipField): Contact[] {
        // Never suggest somebody who is already a pill: adding a duplicate
        // address is a no-op that the chip list silently collapses, which
        // reads as the click not working.
        const chosen = new Set(recipChips(f).map((a) => a.toLowerCase()));
        return searchContacts(suggestQuery, SUGGEST_LIMIT)
            .filter((c) => !chosen.has(c.address.toLowerCase()));
    }


    /**
     * Commit a suggested contact, REPLACING the token being typed.
     *
     * The typed text is discarded, not appended to. Slicing at the last
     * separator keeps the completed recipients that came before it, and the
     * whole trailing token after that separator is dropped — otherwise
     * picking "ada@example.com" while "ada@" is in the box produced the
     * recipient "ada@example.comada@", which is an address to nobody.
     */
    function applySuggestion(f: RecipField, c: Contact) {
        const live = recipLive(f);
        const cut = Math.max(live.lastIndexOf(','), live.lastIndexOf(';'));
        const head = cut >= 0 ? live.slice(0, cut + 1) : '';
        setRecipValue(f, head + c.address);
        // The token is now complete, so turn it into a pill immediately
        // rather than waiting for a blur the user may not trigger.
        commitRecip(f);
        closeSuggest();
    }

    /** Secondary line in a suggestion row: where the address came from. */
    function suggestMeta(c: Contact): string {
        if (c.name) return c.address;
        if (c.count > 1) return `${c.address} · seen ${c.count}×`;
        if (c.lastSeen) return c.address;
        return `${c.address} · added by you`;
    }

    function onSuggestKeydown(e: KeyboardEvent, f: RecipField) {
        const list = suggestField === f ? recipSuggestions(f) : [];
        if (!list.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            suggestIndex = (suggestIndex + 1) % list.length;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            suggestIndex = (suggestIndex - 1 + list.length) % list.length;
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            // Only hijack Enter when a row is actually highlighted; a
            // half-typed free-form address must still send on Enter.
            if (e.key === 'Enter' && suggestIndex >= 0 && list[suggestIndex]) {
                e.preventDefault();
                applySuggestion(f, list[suggestIndex]);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeSuggest();
        }
    }

    let subject = $state(buildSubject());
    let body = $state(buildBodyHtml());
    // Handle into the Tiptap instance. Compose's `body` binding is
    // write-only as far as the editor is concerned (RichEditor only pushes
    // HTML out via onUpdate), so anything that needs to put text INTO the
    // document has to go through this.
    let editorApi: { insertHtml?: (html: string) => void } = $state({});

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
    // Tracking lives behind a collapsed "Advanced" row — it's a niche
    // feature and shouldn't sit in the main toolbar.
    let advancedOpen = $state(false);

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

    // ─── AI reply suggestion ────────────────────────────────────────────
    //
    // Opening a Reply asks the model for a starting paragraph and shows it
    // in a strip above the editor. Three properties matter, and each one
    // is load-bearing:
    //
    // 1. IT NEVER BLOCKS. The request is fired from a timer in onMount,
    //    after the window is already on screen and interactive. Nothing is
    //    awaited before render, no field is disabled, and the user can
    //    type, edit and send the whole time it runs. If the model is slow
    //    the user simply never sees the strip.
    //
    // 2. IT IS BOUND TO THE WINDOW. One AbortController, aborted on
    //    unmount and whenever a fresh request supersedes the old one.
    //    Closing the compose mid-generation cancels the HTTP request
    //    rather than leaving it to finish into a component that no longer
    //    exists — which would spend tokens and, worse, write into a dead
    //    $state proxy.
    //
    // 3. IT IS SUBORDINATE TO THE MASTER SWITCH. `replySuggestEligible()`
    //    re-checks settings.aiFeatures on every call, and an $effect
    //    aborts + hides in flight if the user flips AI off while Compose is
    //    open. aiSuggestReply only ever narrows the feature further; it
    //    can never widen it.
    let replySuggest = $state<string | null>(null);
    let replySuggestLoading = $state(false);
    let replySuggestError = $state<string | null>(null);
    // Epoch of the last request we actually let out. A response from a
    // superseded request is dropped rather than shown, so two overlapping
    // generations can't race each other into the strip.
    let replySuggestSeq = 0;
    let replySuggestAbort: AbortController | null = null;
    // Regenerate is a button a thumb can find with the mouse, so it needs
    // the same guard the outbound-webhook test-send uses: one request in
    // flight, and a short cooldown between them. Hammering this spends
    // real tokens per click and tells the user nothing — the model has no
    // notion of "try again harder".
    const REGEN_COOLDOWN_MS = 4000;
    let lastReplySuggestAt = 0;

    /** Every gate, in one place, re-evaluated on each call. */
    function replySuggestEligible(): boolean {
        return (replyMode === 'reply' || replyMode === 'replyAll')
            && !!replyTo
            && settings.aiFeatures
            && settings.aiSuggestReply
            && aiAvailable();
    }

    /** Kill whatever is running. Safe to call when nothing is. */
    function abortReplySuggest() {
        if (replySuggestAbort) {
            replySuggestAbort.abort();
            replySuggestAbort = null;
        }
        replySuggestLoading = false;
    }

    /** The original message as the model should see it: headers plus the
     *  plain-text body. Same shape the AI panel's Draft button sends, so
     *  the model gets a thread it already knows how to reply to. */
    function threadForAi(): string {
        if (!replyTo) return '';
        const env = replyTo.envelope;
        const headers = [
            `From: ${env.from?.[0]?.name || ''} <${env.from?.[0]?.address || ''}>`,
            env.subject ? `Subject: ${env.subject}` : '',
            env.date ? `Date: ${env.date}` : ''
        ].filter(Boolean).join('\n');
        const text = replyTo.text || htmlToPlainText(replyTo.html || '');
        return `${headers}\n\n${text}`;
    }

    async function requestReplySuggest(opts: { regen: boolean }) {
        if (!replySuggestEligible()) return;
        if (replySuggestLoading) return;
        if (opts.regen) {
            const since = Date.now() - lastReplySuggestAt;
            if (since < REGEN_COOLDOWN_MS) return;
        }
        abortReplySuggest();
        lastReplySuggestAt = Date.now();
        const seq = ++replySuggestSeq;
        const controller = new AbortController();
        replySuggestAbort = controller;
        replySuggestLoading = true;
        replySuggestError = null;
        if (opts.regen) replySuggest = null;   // don't leave stale text under a spinner
        try {
            const r = await draftReply(threadForAi(), undefined, { signal: controller.signal });
            // Dropped if the user closed the window, hit refresh, or turned
            // AI off while this was in the air.
            if (seq !== replySuggestSeq || controller.signal.aborted) return;
            const text = (r.content || '').trim();
            if (!text) {
                replySuggestError = 'No suggestion came back — carry on.';
            } else {
                replySuggest = text;
            }
        } catch (err) {
            if (controller.signal.aborted || seq !== replySuggestSeq) return;
            // An aborted fetch throws a DOMException; anything else is a
            // real failure worth a quiet one-liner. Not an error dialog:
            // the user never asked for this, so it must not interrupt.
            replySuggestError = err instanceof ApiError
                ? (err.detail || err.title)
                : 'Couldn\'t draft a reply — carry on.';
        } finally {
            if (seq === replySuggestSeq) {
                replySuggestLoading = false;
                if (replySuggestAbort === controller) replySuggestAbort = null;
            }
        }
    }

    /**
     * Accept the suggestion by INSERTING it above whatever the user has
     * already written, never by replacing the body.
     *
     * A reply is a document the user is already in the middle of typing
     * — the whole point of the feature being async is that they start
     * typing while the model thinks. Overwriting the body at that moment
     * would destroy their words to install the model's, which is the
     * single most infuriating thing this strip could do. Appending keeps
     * both, and the user edits the seam: their paragraph first, the
     * model's opening after it, in that order, which is also the order
     * they read.
     */
    function acceptReplySuggest() {
        const text = replySuggest;
        if (!text) return;
        abortReplySuggest();
        const para = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
            .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
        // Route through Tiptap, not `body = ...`. The bound variable is
        // only read by RichEditor on mount, so writing to it from here
        // updates the state and the visible document never — and the next
        // keystroke reverts it. A blank paragraph first so the suggestion
        // doesn't butt against the last word the user typed.
        if (editorApi.insertHtml) editorApi.insertHtml(`<p></p>${para}`);
        else body = `${body}<p></p>${para}`;
        replySuggest = null;
        replySuggestError = null;
    }

    function dismissReplySuggest() {
        abortReplySuggest();
        replySuggest = null;
        replySuggestError = null;
    }

    // The hard-off can be flipped while this window is open. Abort, hide,
    // and never re-fire: the master switch is the privacy control and a
    // feature added after it was written must not become a way around it.
    $effect(() => {
        if (settings.aiFeatures) return;
        abortReplySuggest();
        replySuggest = null;
        replySuggestError = null;
    });

    function pickPrimaryAddress(toField: string): string | null {
        const first = (toField || '').split(',')[0].trim();
        // Accept "Name <addr>" too — extract bare address.
        const angle = first.match(/<([^>]+)>/);
        const addr = (angle ? angle[1] : first).trim().toLowerCase();
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return addr;
        return null;
    }

    $effect(() => {
        // AI hard-off: the panel is not rendered, so don't spend a model
        // call building a summary nobody can see. Reset the same way an
        // unrecognised recipient does, and abort anything in flight.
        if (!settings.aiFeatures) {
            historyAddr = null;
            historySummary = null;
            historyLoading = false;
            historyDismissed = false;
            if (historyAbort) { historyAbort.abort(); historyAbort = null; }
            return;
        }
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

    // The friendly name to show next to the From address. Reuses
    // pickFromName — the exact helper doSend() uses for the From header —
    // rather than re-deriving a name here, so what the user sees on this
    // row and what the recipient sees in the header cannot drift apart.
    // It already prefers the saved displayName and falls back to a
    // tidied local-part ("john.rowe" → "John Rowe"); when even that is
    // empty we render nothing and the bare address stands alone.
    //
    // Depends on `from` so it tracks the address as the user edits or
    // picks an alias, and on settings.displayName so editing the name in
    // Settings updates this row live.
    let fromName = $derived(pickFromName(from) ?? '');

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

    onMount(() => {
        // Fire the reply suggestion only after this window is up. A
        // setTimeout(0) rather than a bare call at the top of onMount:
        // onMount already awaits getSendFromAddresses above, and a
        // suggestion request queued behind that would sit invisible for
        // as long as the alias lookup takes. Scheduling it as its own
        // macrotask keeps it off the critical path of first paint and of
        // the user's first keystroke either way.
        const t = setTimeout(() => { void requestReplySuggest({ regen: false }); }, 0);
        return () => {
            clearTimeout(t);
            // Unmount is the abort signal. Closing or abandoning the
            // window cancels the request in flight; nothing is written
            // back into a component that no longer exists.
            abortReplySuggest();
        };
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
    defaultWidth={980}
    defaultHeight={720}
    minWidth={420}
    minHeight={420}
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
        <!-- From is a single address line in OWA. The display name and the
             catch-all domain chips are secondary controls, so they moved
             into the Advanced popover rather than sitting on this row.

             The friendly name IS shown here, as a chip beside the address,
             because picking the wrong identity on the one row that decides
             who the mail appears to come from is a real mistake — "which of
             my six aliases is this?" is much easier to answer when your name
             is on screen. It is a SIBLING of the input, never part of its
             value: the input stays a bare type="email" bound to the
             address, which is exactly what doSend() sends and what
             pickFromName() keys off. Putting "John Rowe <a@b>" into the
             field instead would break the send (the server wants an
             address) and would defeat the alias picker. -->
        <div class="hdr-row from-row">
            <span class="hdr-lbl">From</span>
            <div class="from-pair">
                {#if fromName}
                    <span class="from-name" title={`Sending as ${fromName}`} data-testid="compose-from-name-display">
                        {fromName}
                    </span>
                {/if}
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
            </div>
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
        <!-- To row. The chips and the input are one wrapping token field,
             as in OWA — recipients become pills, the input keeps carrying
             whatever is half-typed. -->
        <div class="hdr-row" class:to-glow={toGlow}>
            <span class="hdr-lbl">To</span>
            <div class="token-field" class:filled={recipChips('to').length > 0}>
                {#each recipChips('to') as addr (addr)}
                    <span class="recip-chip" data-testid="compose-to-chip">
                        {#if contactName(addr)}<span class="recip-name">{contactName(addr)}</span>{/if}
                        <span class="recip-addr">{addr}</span>
                        <button
                            type="button"
                            class="recip-x"
                            aria-label={`Remove ${addr}`}
                            title={`Remove ${addr}`}
                            onclick={() => removeRecip('to', addr)}
                            data-testid="compose-to-chip-remove"
                        ><Icon name="close" size={9} /></button>
                    </span>
                {/each}
                <input
                    type="text"
                    value={recipLive('to')}
                    oninput={(e) => { setRecipValue('to', recipPrefix.to + (e.currentTarget as HTMLInputElement).value); openSuggest('to'); }}
                    onkeydown={(e) => {
                        const el = e.currentTarget as HTMLInputElement;
                        if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
                            // A highlighted suggestion wins over committing
                            // the raw text, so arrow-down then Enter picks
                            // the contact rather than typing its address out.
                            if (e.key === 'Enter' && suggestField === 'to' && recipSuggestions('to')[suggestIndex]) {
                                e.preventDefault();
                                applySuggestion('to', recipSuggestions('to')[suggestIndex]);
                                return;
                            }
                            e.preventDefault();
                            commitRecip('to');
                        } else if (e.key === 'Backspace' && !el.value) {
                            popRecip('to');
                        } else {
                            onSuggestKeydown(e, 'to');
                        }
                    }}
                    onfocus={() => { activeField = 'to'; openSuggest('to'); }}
                    onblur={() => {
                        // Delay so a click on a suggestion row lands before
                        // the list is torn down. Without this the mousedown
                        // target disappears and the click never fires.
                        setTimeout(() => { closeSuggest(); }, 120);
                        commitRecip('to');
                        if (activeField === 'to') activeField = null;
                    }}
                    placeholder={recipChips('to').length ? '' : 'Type a name or address'}
                    autocomplete="off"
                    role="combobox"
                    aria-expanded={suggestField === 'to' && recipSuggestions('to').length > 0}
                    aria-autocomplete="list"
                    aria-controls="compose-suggest-list"
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
        </div>

        {#if showCcBcc}
            {#each [{ f: 'cc' as RecipField, label: 'Cc' }, { f: 'bcc' as RecipField, label: 'Bcc' }] as row (row.f)}
                <div class="hdr-row">
                    <span class="hdr-lbl">{row.label}</span>
                    <div class="token-field" class:filled={recipChips(row.f).length > 0}>
                        {#each recipChips(row.f) as addr (addr)}
                            <span class="recip-chip" data-testid={`compose-${row.f}-chip`}>
                                {#if contactName(addr)}<span class="recip-name">{contactName(addr)}</span>{/if}
                                <span class="recip-addr">{addr}</span>
                                <button
                                    type="button"
                                    class="recip-x"
                                    aria-label={`Remove ${addr}`}
                                    title={`Remove ${addr}`}
                                    onclick={() => removeRecip(row.f, addr)}
                                    data-testid={`compose-${row.f}-chip-remove`}
                                ><Icon name="close" size={9} /></button>
                            </span>
                        {/each}
                        <input
                            type="text"
                            value={recipLive(row.f)}
                            oninput={(e) => { setRecipValue(row.f, recipPrefix[row.f] + (e.currentTarget as HTMLInputElement).value); openSuggest(row.f); }}
                            onkeydown={(e) => {
                                const el = e.currentTarget as HTMLInputElement;
                                if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
                                    if (e.key === 'Enter' && suggestField === row.f && recipSuggestions(row.f)[suggestIndex]) {
                                        e.preventDefault();
                                        applySuggestion(row.f, recipSuggestions(row.f)[suggestIndex]);
                                        return;
                                    }
                                    e.preventDefault();
                                    commitRecip(row.f);
                                } else if (e.key === 'Backspace' && !el.value) {
                                    popRecip(row.f);
                                } else {
                                    onSuggestKeydown(e, row.f);
                                }
                            }}
                            onfocus={() => { activeField = row.f; openSuggest(row.f); }}
                            onblur={() => {
                                setTimeout(() => { closeSuggest(); }, 120);
                                commitRecip(row.f);
                                if (activeField === row.f) activeField = null;
                            }}
                            placeholder={recipChips(row.f).length ? '' : row.label}
                            autocomplete="off"
                            role="combobox"
                            aria-expanded={suggestField === row.f && recipSuggestions(row.f).length > 0}
                            aria-autocomplete="list"
                            aria-controls="compose-suggest-list"
                            data-1p-ignore="true"
                            data-lpignore="true"
                            data-bwignore="true"
                            data-testid={`compose-${row.f}`}
                        />
                    </div>
                </div>
            {/each}
        {/if}

        <!--
            Recipient suggestions, shared by To/Cc/Bcc — whichever field is
            focused. One list for three inputs, so the id in aria-controls is
            stable and there is never more than one list on screen.

            Rendered only while a field is focused and something matches, so
            an untouched compose window shows no overlay at all. Positioned
            absolutely under the header block rather than inside the token
            field, because the field wraps as pills are added and an in-field
            list would be clipped by its own overflow.
        -->
        {#if suggestField && recipSuggestions(suggestField).length}
            {@const field = suggestField}
            {@const list = recipSuggestions(field)}
            <ul
                class="recip-suggest"
                id="compose-suggest-list"
                role="listbox"
                aria-label="Recipient suggestions"
                data-testid="compose-suggest-list"
            >
                {#each list as c, i (c.uid + c.address)}
                    <li
                        class="recip-suggest-row"
                        class:on={i === suggestIndex}
                        role="option"
                        aria-selected={i === suggestIndex}
                        onmousedown={(e) => { e.preventDefault(); applySuggestion(field, c); }}
                        onmouseenter={() => (suggestIndex = i)}
                        data-testid="compose-suggest"
                    >
                        <span class="rs-name">{c.name || c.address}</span>
                        <span class="rs-meta">{suggestMeta(c)}</span>
                    </li>
                {/each}
            </ul>
        {/if}

        <!-- Subject: a full-width line under the recipients, the way OWA
             lays it out. The AI wand sits at the far end of the row. -->
        <div class="hdr-row subject-row">
            <span class="hdr-lbl">Subject</span>
            <div class="subject-wrap">
                <input
                    type="text"
                    bind:value={subject}
                    autocomplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    data-testid="compose-subject"
                    placeholder={subjectSuggesting ? 'Drafting subject…' : 'Add a subject'}
                />
                {#if settings.aiFeatures}
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
                {/if}
            </div>
        </div>
        {#if subjectSuggestion && settings.aiFeatures}
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

        {#if settings.aiFeatures && settings.composeHistorySummary && historyAddr && !historyDismissed}
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

        <!-- AI reply suggestion.

             Sits between the recipient block and the editor, in the same
             slot the history panel uses, because that is where the user
             is already looking when they open a reply. Deliberately a
             strip and not a modal: the model call is something the user
             never asked for, and a modal would put a dialog between them
             and a reply they were about to write.

             The loading state reads as ordinary work in progress — a
             spinner beside a quiet label, accent-coloured, no red, no
             warning icon. The one thing this must never look like is a
             failure, because at this point the user has done nothing
             wrong and cannot act on it.

             Gated on settings.aiFeatures in the template as well as in
             requestReplySuggest: the render guard and the request guard
             are deliberately both present. The request guard alone would
             be enough for privacy, but a strip left on screen after the
             master switch flips would be a lie about the app's state. -->
        {#if settings.aiFeatures && (replySuggestLoading || replySuggest || replySuggestError)}
            <div class="draft-sugg" role="status" aria-live="polite" data-testid="compose-reply-suggest">
                <Icon name="sparkles" size={12} />
                {#if replySuggestLoading}
                    <span class="draft-sugg-text muted">
                        Drafting a reply you can keep or throw away…
                    </span>
                    <span class="spinner small"></span>
                    <button
                        type="button"
                        class="draft-sugg-btn"
                        onclick={dismissReplySuggest}
                        title="Dismiss"
                        data-testid="compose-reply-suggest-cancel"
                    ><Icon name="close" size={11} /></button>
                {:else if replySuggest}
                    <span class="draft-sugg-text" data-testid="compose-reply-suggest-text">
                        {replySuggest}
                    </span>
                    <button
                        type="button"
                        class="draft-sugg-btn accept"
                        onclick={acceptReplySuggest}
                        title="Add this to your reply"
                        data-testid="compose-reply-suggest-accept"
                    >Use</button>
                    <button
                        type="button"
                        class="draft-sugg-btn"
                        onclick={() => void requestReplySuggest({ regen: true })}
                        title="Try another wording"
                        aria-label="Suggest another reply"
                        data-testid="compose-reply-suggest-regen"
                    ><Icon name="refresh" size={11} /></button>
                    <button
                        type="button"
                        class="draft-sugg-btn"
                        onclick={dismissReplySuggest}
                        title="Discard this suggestion"
                        aria-label="Discard reply suggestion"
                        data-testid="compose-reply-suggest-dismiss"
                    ><Icon name="close" size={11} /></button>
                {:else}
                    <span class="draft-sugg-text muted">{replySuggestError}</span>
                    <button
                        type="button"
                        class="draft-sugg-btn"
                        onclick={dismissReplySuggest}
                        title="Dismiss"
                        data-testid="compose-reply-suggest-cancel"
                    ><Icon name="close" size={11} /></button>
                {/if}
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
                api={editorApi}
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
        <!-- Action bar. Left side holds the composer's switches (attach,
             tracking, advanced); right side holds the primary pair. The
             layout mirrors OWA's, which keeps Send visually dominant. -->
        <div class="action-bar">
            <div class="action-left">
                <button
                    type="button"
                    class="bar-btn"
                    title="Attach files"
                    aria-label="Attach files"
                    onclick={pickFiles}
                    data-testid="compose-attach-btn"
                >
                    <Icon name="paperclip" size={15} />
                    <span>Attach</span>
                </button>

                <!-- Tracking lives here rather than behind "Advanced": it's a
                     per-message switch the user should be able to see and
                     flip at a glance, and an icon that merely looks active
                     is too easy to leave on without noticing. -->
                <button
                    type="button"
                    class="bar-btn spy-btn"
                    class:on={trackOpens}
                    title={trackOpens
                        ? 'Invisible Tracker is ON — you\'ll get an email when this message is opened. Click to disable.'
                        : 'Invisible Tracker — get an email when the recipient opens this message.'}
                    aria-label={trackOpens ? 'Disable invisible tracker' : 'Enable invisible tracker'}
                    aria-pressed={trackOpens}
                    onclick={() => { trackOpens = !trackOpens; }}
                    data-testid="compose-spy-btn"
                >
                    <Icon name="spy" size={15} />
                    <span class="tracking-note" data-testid="compose-tracking-note">
                        Tracking {trackOpens ? 'on' : 'off'}
                    </span>
                </button>

                <button
                    type="button"
                    class="bar-btn"
                    title="Advanced options"
                    aria-expanded={advancedOpen}
                    onclick={() => { advancedOpen = !advancedOpen; }}
                    data-testid="compose-advanced-btn"
                >
                    <Icon name={advancedOpen ? 'chevronUp' : 'chevronDown'} size={14} />
                    <span>Advanced</span>
                </button>

                {#if advancedOpen}
                    <!-- Advanced holds the From-adjacent controls that would
                         otherwise crowd the address line: the friendly name
                         and the catch-all domain shortcuts. -->
                    <div class="adv-pop" data-testid="compose-advanced-panel">
                        <label class="adv-field">
                            <span class="adv-lbl">Display name</span>
                            <input
                                type="text"
                                class="display-name-inline"
                                value={settings.displayName}
                                oninput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)}
                                placeholder="Shown next to your address"
                                title="Friendly name shown next to your address — saved across sends"
                                autocomplete="off"
                                data-1p-ignore="true"
                                data-lpignore="true"
                                data-bwignore="true"
                                data-testid="compose-from-name"
                            />
                        </label>
                        {#if wildcardDomains.length > 0}
                            <div class="adv-field" data-testid="compose-from-wildcard">
                                <span class="adv-lbl">Catch-all domains</span>
                                <div class="adv-doms">
                                    {#each wildcardDomains as d (d)}
                                        <button
                                            type="button"
                                            class="domain-chip"
                                            title={`Insert @${d} into the From field`}
                                            onclick={() => {
                                                const at = from.indexOf('@');
                                                const local = at > 0 ? from.slice(0, at) : (from || 'me');
                                                from = `${local}@${d}`;
                                            }}
                                        >@{d}</button>
                                    {/each}
                                </div>
                            </div>
                        {/if}
                    </div>
                {/if}

                {#if !smtpAvailable()}
                    <span class="hint" data-testid="compose-status">
                        Sending isn't enabled — your text will be saved as a draft.
                    </span>
                {/if}
            </div>
            <div class="action-right">
                <button
                    type="button"
                    class="btn btn-secondary"
                    data-testid="compose-discard"
                    onclick={onClose}
                >Discard</button>
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
        /* Anchor for the recipient suggestion list. Without a positioned
         * ancestor the absolutely-positioned <ul> resolves against the
         * viewport and renders over the toolbar. */
        position: relative;
    }
    /* Header block. OWA stacks From / To / Cc / Bcc / Subject as full-width
     * lines separated by hairlines, with the label sitting inline at the
     * left rather than in its own column. */
    .hdr-row {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 7px 16px;
        border-bottom: 1px solid var(--border-subtle);
        transition: background-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    .hdr-lbl {
        flex: 0 0 62px;
        padding-top: 6px;
        font-size: 12px;
        color: var(--text-tertiary);
        user-select: none;
    }
    .from-row { align-items: center; }
    .from-pair { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; }
    /* The friendly name, shown before the address on the From row. Sized
       down from the address because it is the label, not the value — the
       address stays the thing you read first. flex: 0 0 auto so a long
       name can never squeeze the input; the row is wide and the name is
       short, but a display name is user-supplied and a 40-character one
       must not eat the field. */
    .from-name {
        flex: 0 0 auto;
        max-width: 45%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary);
    }
    .from-pair input {
        flex: 1;
        min-width: 0;
        border: none;
        background: transparent;
        padding: 4px 2px;
        font-size: 13.5px;
    }
    .from-pair input:focus { outline: none; box-shadow: none; }
    /* Glow when the From auto-matched the address the original message
     * was sent to — signals to the user that the reply is going out from
     * the same alias that received it. */
    .hdr-row.to-glow {
        background: color-mix(in srgb, var(--accent) 8%, transparent);
        box-shadow: inset 4px 0 0 var(--accent);
        animation: to-glow-pulse 2.4s ease-out;
    }
    @keyframes to-glow-pulse {
        0%   { background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: inset 4px 0 0 var(--accent), 0 0 18px color-mix(in srgb, var(--accent) 30%, transparent); }
        100% { background: transparent; box-shadow: inset 0 0 0 var(--accent); }
    }
    /* The token field: chips and the live input share one wrapping line so
     * the field grows downward as recipients are added, like OWA. */
    .token-field {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        padding: 3px 6px;
        border: 1px solid transparent;
        border-radius: var(--radius-xs);
        transition: border-color var(--transition-fast), background-color var(--transition-fast);
    }
    .token-field:focus-within {
        border-color: var(--border-focus);
        background: var(--bg-input);
    }
    .token-field input {
        flex: 1 1 140px;
        min-width: 100px;
        border: none;
        background: transparent;
        padding: 3px 2px;
        font-size: 13.5px;
    }
    .token-field input:focus { outline: none; box-shadow: none; }
    .recip-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 260px;
        padding: 2px 3px 2px 9px;
        border-radius: var(--radius-xs);
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-soft);
        font-size: 12.5px;
        line-height: 1.5;
    }
    .recip-chip:hover { background: var(--bg-hover); }
    .recip-name { font-weight: 600; color: var(--text-primary); }
    .recip-addr {
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .recip-x {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 17px;
        height: 17px;
        border-radius: var(--radius-xs);
        color: var(--text-tertiary);
    }
    .recip-x:hover { background: var(--bg-active); color: var(--text-primary); }
    /* Recipient suggestion dropdown. A real listbox rather than a <datalist>
     * because the ask is a friendly display name plus a secondary line, and
     * <datalist> can only offer one string per option — rendered
     * inconsistently at that, since Firefox and Safari largely ignore the
     * `label` attribute.
     *
     * Anchored to the form rather than to the token field: the field wraps
     * and grows as pills are added, and an in-field list would be clipped by
     * its own overflow. `top` is a fixed offset instead of a percentage
     * because the header rows above it (From, To, and any open Cc/Bcc) have
     * a height that changes with the user's own settings — a percentage of
     * the form would drift as the dialog is resized, whereas a fixed offset
     * always lands just under the recipient block. */
    .recip-suggest {
        position: absolute;
        top: 92px;
        left: 16px;
        right: 16px;
        z-index: 20;
        max-height: 260px;
        overflow-y: auto;
        list-style: none;
        margin: 0;
        padding: 4px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        box-shadow: var(--shadow-md);
    }
    .recip-suggest-row {
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 5px 8px;
        border-radius: var(--radius-xs);
        cursor: pointer;
    }
    .recip-suggest-row.on { background: var(--bg-hover); }
    .rs-name {
        font-size: 13px;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .rs-meta {
        font-size: 11.5px;
        color: var(--text-tertiary);
        font-family: var(--font-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .ccbcc-toggle {
        flex-shrink: 0;
        font-size: 12px;
        color: var(--text-tertiary);
        padding: 3px 7px;
        border-radius: var(--radius-xs);
    }
    .ccbcc-toggle:hover { background: var(--bg-hover); color: var(--text-primary); }
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
    /* AI reply suggestion. A quieter sibling of .subj-sugg: same slot in
       the compose chrome, but the text is a paragraph rather than a
       one-line subject, so it is clamped to two lines instead of
       ellipsised — a suggestion you cannot read is a suggestion you
       cannot judge. Accent-tinted, not purple: the purple subject strip
       is a different feature, and two purple strips stacked in one
       window reads as a bug. Colours are theme variables so both skins
       inherit their own palette rather than a hard-coded hex. */
    .draft-sugg {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin: 6px 14px 8px;
        padding: 8px 10px 8px 12px;
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-surface));
        border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border-subtle));
        border-radius: 10px;
        font-size: 12.5px;
        line-height: 1.45;
        color: var(--text-primary);
    }
    .draft-sugg :global(svg) { flex-shrink: 0; margin-top: 2px; color: var(--accent-text); }
    .draft-sugg-text {
        flex: 1;
        min-width: 0;
        white-space: pre-wrap;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        line-clamp: 3;
        -webkit-box-orient: vertical;
    }
    .draft-sugg-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        height: 22px;
        padding: 0 6px;
        border-radius: var(--radius-xs);
        border: 1px solid var(--border-subtle);
        background: var(--bg-surface);
        color: var(--text-tertiary);
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
    }
    .draft-sugg-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
    .draft-sugg-btn.accept {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--bg-base);
    }
    .draft-sugg-btn.accept:hover { filter: brightness(1.06); }
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
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
    }
    .subject-wrap input {
        flex: 1;
        min-width: 0;
        border: none;
        background: transparent;
        padding: 4px 2px;
        font-size: 13.5px;
    }
    .subject-wrap input:focus { outline: none; box-shadow: none; }
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
    .adv-pop {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        background: var(--bg-surface);
        border: 1px solid var(--border-soft);
        border-radius: var(--radius-sm);
        box-shadow: var(--shadow-md);
    }
    .adv-field { display: flex; flex-direction: column; gap: 4px; }
    .adv-lbl {
        font-size: 11px;
        color: var(--text-tertiary);
        font-weight: 600;
    }
    .adv-field input {
        border: 1px solid var(--border-soft);
        border-radius: var(--radius-xs);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: 13px;
        padding: 5px 8px;
        width: 100%;
    }
    .adv-field input:focus { outline: none; border-color: var(--border-focus); }
    .adv-doms { display: flex; flex-wrap: wrap; gap: 4px; }
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
    /* Action bar. OWA separates the composer's switches from its primary
     * pair with a rule and a lot of space, so Send keeps the eye. */
    .action-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 9px 14px;
    }
    .action-left {
        position: relative;
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
    }
    .action-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .bar-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 9px;
        border-radius: var(--radius-xs);
        color: var(--text-secondary);
        font-size: 12.5px;
        font-weight: 500;
        transition: color var(--transition-fast), background-color var(--transition-fast),
                    box-shadow var(--transition-fast);
    }
    .bar-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
    /* Tracking sits in the action bar as a labelled switch, not as a
     * paragraph wedged under the buttons. Red rather than the accent —
     * it's a "watch out" signal, not a positive one. */
    .spy-btn.on {
        color: var(--danger);
        background: var(--danger-soft);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 45%, transparent);
    }
    .tracking-note { font-weight: 600; }
    .attach-tray {
        list-style: none;
        margin: 0;
        padding: 8px 14px 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
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
    .hint {
        font-size: 12px;
        color: var(--text-tertiary);
        font-style: italic;
        max-width: 320px;
    }
    .hint {
        font-size: 12px;
        color: var(--text-tertiary);
        max-width: 300px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* Red glow rather than the user's accent — tracking is a "watch out"
     * signal, not a positive one, so it should pop regardless of skin. */
    .spy-btn.on {
        color: var(--danger);
        background: var(--danger-soft);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 45%, transparent);
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
