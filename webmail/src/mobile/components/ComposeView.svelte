<script lang="ts">
    import { onMount } from 'svelte';
    import { mobileState, goBack, showToast } from '../lib/store.svelte';
    import { authState } from '../../lib/auth.svelte';
    import { sendStub, getSendFromAddresses, type SendAttachment } from '../../lib/api';
    import { trackSent } from '../../lib/sent-status.svelte';
    import { settings, pickFromName, setDisplayName, deriveNameFromAddress, aiAvailable } from '../../lib/settings.svelte';
    import { ReplySuggest, DraftSparkle, htmlToPlainText } from '../../lib/reply-suggest.svelte';
    import { addressBook } from '../../lib/address-book.svelte';
    import { formatFullDate } from '../../lib/format';
    import Icon from '../../components/Icon.svelte';

    let to = $state('');
    let cc = $state('');
    let bcc = $state('');
    let from = $state(settings.defaultFromAddress || authState.activeUser || '');
    let subject = $state('');
    let body = $state('');
    let sending = $state(false);
    let showCc = $state(false);
    let sendFromOptions = $state<string[]>([]);
    let attachments = $state<SendAttachment[]>([]);
    let showFromPicker = $state(false);
    // Tracking pixel parity with desktop. Defaults to settings.trackOpensDefault.
    let trackOpens = $state(settings.trackOpensDefault);

    function pickImage(source: 'camera' | 'gallery') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        if (source === 'camera') input.capture = 'environment';
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result as string;
                const comma = dataUrl.indexOf(',');
                const content = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
                attachments = [...attachments, {
                    filename: file.name,
                    contentType: file.type || 'image/jpeg',
                    content
                }];
            };
            reader.readAsDataURL(file);
        };
        input.click();
    }

    function removeAttachment(idx: number) {
        attachments = attachments.filter((_, i) => i !== idx);
    }

    const replyTo = $derived(mobileState.composeReplyTo);
    const mode = $derived(mobileState.composeMode);

    // htmlToPlainText now lives in lib/reply-suggest.svelte, shared with
    // the desktop compose window.

    function pickReplyFrom(): string {
        const fallback = settings.defaultFromAddress || authState.activeUser || '';
        if (!replyTo || mode === 'forward') return fallback;
        const known = new Set<string>();
        if (fallback) known.add(fallback.toLowerCase());
        for (const a of sendFromOptions) known.add(a.toLowerCase());
        for (const list of [replyTo.envelope.to || [], replyTo.envelope.cc || []]) {
            for (const a of list) {
                const addr = (a.address || '').toLowerCase();
                if (addr && known.has(addr)) return a.address!;
            }
        }
        return fallback;
    }

    $effect(() => {
        if (replyTo && mode !== 'new') {
            // Build the subject in a local and assign once at the end.
            // Assigning to `subject` and then reading it back made the
            // effect depend on its own output, so every keystroke in the
            // subject field re-ran this block and overwrote whatever the
            // user had typed into the body.
            let nextSubject = replyTo.envelope.subject || '';
            if (!nextSubject.toLowerCase().startsWith('re:') && mode !== 'forward') {
                nextSubject = 'Re: ' + nextSubject;
            }
            // HTML-only emails have no text part; fall back to stripping HTML.
            const sourceText = replyTo.text || htmlToPlainText(replyTo.html || '');
            if (mode === 'forward') {
                nextSubject = nextSubject.toLowerCase().startsWith('fwd:') ? nextSubject : 'Fwd: ' + nextSubject;
                // envelope.date is the raw RFC-2822 header; format it the same
                // way desktop compose does so the forwarded block reads like a
                // mail client.
                body = `\n\n--- Forwarded message ---\nFrom: ${replyTo.envelope.from?.map((a) => a.name || a.address).join(', ')}\nDate: ${formatFullDate(replyTo.internalDate || replyTo.envelope.date)}\nSubject: ${replyTo.envelope.subject}\n\n${sourceText}`;
            } else {
                // envelope.date is the raw RFC-2822 header; format it the same
                // way desktop compose does so the quote reads like a mail client.
                body = `\n\nOn ${formatFullDate(replyTo.internalDate || replyTo.envelope.date)}, ${replyTo.envelope.from?.[0]?.name || replyTo.envelope.from?.[0]?.address} wrote:\n\n${sourceText}`;
            }
            if (mode === 'reply' || mode === 'replyAll') {
                to = replyTo.envelope.from?.map((a) => a.address).filter(Boolean).join(', ') || '';
            }
            if (mode === 'replyAll') {
                const all = [
                    ...(replyTo.envelope.to || []),
                    ...(replyTo.envelope.cc || [])
                ].map((a) => a.address).filter(Boolean);
                cc = all.join(', ');
            }
            from = pickReplyFrom();
            subject = nextSubject;
        }
    });

    async function handleSend() {
        // Recipient is required; an empty subject is fine (matches desktop
        // compose, and the server accepts it).
        if (!to.trim()) return;
        sending = true;
        try {
            const fromName = pickFromName(from || authState.activeUser || '');
            const result = await sendStub({
                to: to.split(',').map((s) => s.trim()).filter(Boolean),
                cc: showCc ? cc.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
                bcc: showCc ? bcc.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
                from: from.trim() || undefined,
                fromName,
                subject: subject.trim(),
                text: body,
                inReplyTo: mode !== 'new' && replyTo?.envelope.messageId ? replyTo.envelope.messageId : undefined,
                attachments: attachments.length ? attachments : undefined,
                trackOpens: trackOpens || undefined,
            });
            if (result.sent) {
                if (result.messageId) {
                    trackSent({ messageId: result.messageId, subject: subject.trim(), to: to.split(',').map((s) => s.trim()).filter(Boolean).join(', ') });
                }
                showToast('success', 'Message sent');
                goBack();
            } else {
                showToast('error', 'Send failed');
            }
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Send failed');
        } finally {
            sending = false;
        }
    }

    function handleClose() {
        goBack();
    }

    onMount(async () => {
        // Consume launch-intent prefill (Web Share Target, manifest
        // shortcut, mailto: protocol). One-shot — clear immediately so
        // the next compose doesn't replay these values.
        if (mobileState.composePrefillTo || mobileState.composePrefillSubject || mobileState.composePrefillBody) {
            if (mobileState.composePrefillTo) to = mobileState.composePrefillTo;
            if (mobileState.composePrefillSubject) subject = mobileState.composePrefillSubject;
            if (mobileState.composePrefillBody) body = mobileState.composePrefillBody;
            mobileState.composePrefillTo = '';
            mobileState.composePrefillSubject = '';
            mobileState.composePrefillBody = '';
        }
        try {
            const res = await getSendFromAddresses();
            if (res.addresses.length) {
                const seen = new Set<string>();
                sendFromOptions = res.addresses.filter((a) => {
                    const lower = a.toLowerCase();
                    if (seen.has(lower)) return false;
                    seen.add(lower);
                    return true;
                });
            }
        } catch { /* silent fallback */ }
        const fallbackFrom = settings.defaultFromAddress || authState.activeUser || '';
        if (!from) {
            from = fallbackFrom;
        } else if (replyTo && mode !== 'new' && mode !== 'forward' && from === fallbackFrom) {
            // The prefill effect picked `from` before sendFromOptions was
            // populated, so an alias match silently missed. Re-pick now —
            // but only while `from` still holds the untouched fallback, so
            // a manual pick is never stomped. Do NOT re-run the prefill
            // effect; it also assigns to/subject/body and would destroy
            // user edits.
            from = pickReplyFrom();
        }
    });

    const fromPickerList = $derived(() => {
        const list = [...sendFromOptions];
        const primary = authState.activeUser;
        if (primary && !list.some((a) => a.toLowerCase() === primary.toLowerCase())) {
            list.unshift(primary);
        }
        return list;
    });

    // --- AI reply suggestion strip -----------------------------------------
    // The request machinery — gates, one-in-flight + regen cooldown,
    // abort on unmount/supersede, seq-dropped responses — is
    // single-sourced in lib/reply-suggest.svelte, shared with desktop
    // Compose.svelte. This view keeps the mobile seams: the textarea
    // prepend insert, the accent-ring sparkle, and the strip markup.
    const replySuggest = new ReplySuggest({
        mode: () => mode,
        replyTo: () => replyTo
    });
    const draftSparkle = new DraftSparkle();

    /** Accept by PREPENDING above whatever is already in the body — the
     *  reply prefill leaves the quoted original below a blank line, and the
     *  user types above it, so the suggestion lands where the caret was
     *  going. Replacing the body would delete words the user typed while
     *  the model was thinking. */
    function acceptReplySuggest() {
        const text = replySuggest.accept();
        if (!text) return;
        body = text + '\n\n' + body.replace(/^\n+/, '');
        draftSparkle.flash();
    }

    // The hard-off can be flipped while this view is open. Abort, hide,
    // and never re-fire: the master switch is the privacy control.
    $effect(() => {
        if (settings.aiFeatures) return;
        replySuggest.dismiss();
    });

    onMount(() => {
        // Fire only after the view is up, on its own macrotask, so the
        // suggestion request never queues behind the alias lookup in the
        // main onMount and never delays first paint or the first keystroke.
        const t = setTimeout(() => { void replySuggest.request({ regen: false }); }, 0);
        return () => {
            clearTimeout(t);
            replySuggest.abort();
        };
    });
</script>

<div class="compose-view">
    <header class="mheader">
        <button type="button" class="mbtn mbtn-ghost close-btn" data-testid="compose-close" aria-label="Close" onclick={handleClose}>
            <Icon name="close" size={20} />
        </button>
        <h1>{mode === 'new' ? 'New Message' : mode === 'reply' ? 'Reply' : mode === 'replyAll' ? 'Reply All' : 'Forward'}</h1>
        <button type="button" class="mbtn mbtn-primary" disabled={sending || !to.trim()} onclick={handleSend}>
            {#if sending}<span class="spinner" style="width:16px;height:16px"></span>{/if}
            {sending ? 'Sending…' : 'Send'}
        </button>
    </header>

    <div class="compose-fields scroll-y">
        <div class="field-group">
            <div class="field">
                <span class="field-label">From</span>
                <button type="button" class="from-select" onclick={() => showFromPicker = true}>
                    <span class="truncate">{from || authState.activeUser || 'Select…'}</span>
                    <Icon name="chevronDown" size={14} />
                </button>
            </div>
            <label class="field">
                <span class="field-label">Name</span>
                <input
                    type="text"
                    value={settings.displayName}
                    oninput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)}
                    placeholder={deriveNameFromAddress(from || authState.activeUser || '') || 'Display name'}
                    autocomplete="off"
                    spellcheck="false"
                    data-testid="compose-from-name"
                />
            </label>
            <label class="field">
                <span class="field-label">To</span>
                <input
                    type="email"
                    placeholder="recipient@example.com"
                    bind:value={to}
                    list="mc-to-suggestions"
                    autocomplete="email"
                    inputmode="email"
                />
            </label>
            {#if showCc}
                <label class="field">
                    <span class="field-label">Cc</span>
                    <input type="text" placeholder="cc@example.com" bind:value={cc} list="mc-to-suggestions" autocomplete="email" />
                </label>
                <label class="field">
                    <span class="field-label">Bcc</span>
                    <input type="text" placeholder="bcc@example.com" bind:value={bcc} list="mc-to-suggestions" autocomplete="email" />
                </label>
            {/if}
            <!-- Shared datalist driven by the local address book (populated
                 from every envelope we render). Mobile keyboards surface
                 these as picker suggestions above the keyboard. -->
            <datalist id="mc-to-suggestions">
                {#each addressBook.contacts.slice().sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 50) as c (c.address)}
                    <option value={c.address}>{c.name ? `${c.name} <${c.address}>` : c.address}</option>
                {/each}
            </datalist>
            <button type="button" class="cc-toggle" onclick={() => showCc = !showCc}>
                {showCc ? 'Hide Cc/Bcc' : 'Cc/Bcc'}
            </button>
            <label class="field">
                <span class="field-label">Subject</span>
                <input type="text" placeholder="Subject" bind:value={subject} />
            </label>
        </div>

        <!-- AI reply suggestion strip. Render-gated on settings.aiFeatures
             in addition to the request guard in replySuggest.request(): the
             request guard alone is enough for privacy, but a strip left on
             screen after the master switch flips would lie about state. -->
        {#if settings.aiFeatures && (replySuggest.loading || replySuggest.suggestion || replySuggest.error)}
            <div class="draft-sugg" role="status" aria-live="polite" data-testid="compose-reply-suggest">
                <Icon name="sparkles" size={15} />
                {#if replySuggest.loading}
                    <span class="draft-sugg-text muted">Drafting a reply you can keep or throw away…</span>
                    <span class="spinner" style="width:14px;height:14px"></span>
                    <button
                        type="button"
                        class="draft-sugg-btn"
                        onclick={replySuggest.dismiss}
                        aria-label="Dismiss"
                        data-testid="compose-reply-suggest-cancel"
                    ><Icon name="close" size={14} /></button>
                {:else if replySuggest.suggestion}
                    <span class="draft-sugg-text" data-testid="compose-reply-suggest-text">{replySuggest.suggestion}</span>
                    <div class="draft-sugg-actions">
                        <button
                            type="button"
                            class="draft-sugg-btn accept"
                            onclick={acceptReplySuggest}
                            data-testid="compose-reply-suggest-accept"
                        >Use</button>
                        <button
                            type="button"
                            class="draft-sugg-btn"
                            onclick={() => void replySuggest.request({ regen: true })}
                            aria-label="Suggest another reply"
                            data-testid="compose-reply-suggest-regen"
                        ><Icon name="refresh" size={14} /></button>
                        <button
                            type="button"
                            class="draft-sugg-btn"
                            onclick={replySuggest.dismiss}
                            aria-label="Discard reply suggestion"
                            data-testid="compose-reply-suggest-dismiss"
                        ><Icon name="close" size={14} /></button>
                    </div>
                {:else}
                    <span class="draft-sugg-text muted">{replySuggest.error}</span>
                    <button
                        type="button"
                        class="draft-sugg-btn"
                        onclick={replySuggest.dismiss}
                        aria-label="Dismiss"
                        data-testid="compose-reply-suggest-cancel"
                    ><Icon name="close" size={14} /></button>
                {/if}
            </div>
        {/if}

        <textarea
            class="body-input"
            class:sparkle={draftSparkle.tick > 0}
            placeholder="Write your message…"
            bind:value={body}
        ></textarea>

        {#if attachments.length}
            <div class="attach-tray">
                {#each attachments as att, i}
                    <div class="attach-chip">
                        <Icon name="paperclip" size={12} />
                        <span class="truncate">{att.filename}</span>
                        <button type="button" class="attach-remove" onclick={() => removeAttachment(i)} aria-label="Remove attachment">
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                {/each}
            </div>
        {/if}

        <div class="compose-actions">
            <button type="button" class="action-btn" onclick={() => pickImage('camera')} title="Take photo" aria-label="Take photo">
                <Icon name="camera" size={18} />
            </button>
            <button type="button" class="action-btn" onclick={() => pickImage('gallery')} title="Add photo" aria-label="Add photo">
                <Icon name="image" size={18} />
            </button>
            <button
                type="button"
                class="action-btn spy-btn"
                class:on={trackOpens}
                onclick={() => { trackOpens = !trackOpens; }}
                title={trackOpens ? 'Tracking on — you\'ll be notified when this is opened' : 'Enable open-tracking pixel'}
                aria-pressed={trackOpens}
                data-testid="mobile-compose-spy"
            >
                <Icon name="spy" size={18} />
            </button>
        </div>
    </div>
</div>

{#if showFromPicker}
    <!-- Tap-outside-to-close is a pointer convenience; the sheet's close
         button is the accessible dismiss path. -->
    <div class="sheet-backdrop" role="presentation" onclick={() => showFromPicker = false}></div>
    <div class="picker-sheet slide-up">
        <div class="picker-header">
            <h2>From</h2>
            <button type="button" class="mbtn mbtn-ghost" onclick={() => showFromPicker = false} aria-label="Close">
                <Icon name="close" size={18} />
            </button>
        </div>
        <div class="picker-list">
            {#each fromPickerList() as addr}
                <button
                    type="button"
                    class="picker-row"
                    class:active={from === addr}
                    onclick={() => { from = addr; showFromPicker = false; }}
                >
                    <span class="truncate">{addr}</span>
                    {#if from === addr}<Icon name="check" size={16} />{/if}
                </button>
            {/each}
        </div>
    </div>
{/if}

<style>
    .compose-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        background: var(--bg-base);
    }
    .compose-fields {
        /* min-height:0 + overflow-y:auto are what keeps the scrolling
           confined to this region — without them, long bodies spill
           past the parent and shove .compose-actions off-screen,
           which is why the bottom bar appeared to "scroll away". */
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0;
        padding: 0;
    }
    .field-group {
        display: flex;
        flex-direction: column;
        background: var(--bg-surface);
        padding: 0 16px;
        border-bottom: 0.5px solid var(--border-subtle);
    }
    .field {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 0;
        border-bottom: 0.5px solid var(--border-subtle);
    }
    .field:last-of-type {
        border-bottom: none;
    }
    .field .field-label {
        font-size: 15px;
        font-weight: 400;
        color: var(--text-secondary);
        min-width: 48px;
        flex-shrink: 0;
    }
    .field input {
        flex: 1;
        border: none;
        background: transparent;
        padding: 4px 0;
        font-size: 16px;
        line-height: 1.3;
        outline: none;
        color: var(--text-primary);
    }
    .from-select {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        border: none;
        padding: 8px 12px;
        font-size: 16px;
        line-height: 1.3;
        outline: none;
        color: var(--text-primary);
        cursor: pointer;
        background: var(--bg-hover);
        border-radius: 8px;
        min-height: 40px;
        width: 100%;
        font-family: inherit;
    }
    .picker-sheet {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        max-height: 70vh;
        background: var(--bg-surface);
        border-radius: 16px 16px 0 0;
        z-index: 100;
        display: flex;
        flex-direction: column;
        padding-bottom: env(safe-area-inset-bottom);
        animation: slide-up 260ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
    }
    .picker-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 0.5px solid var(--border-subtle);
    }
    .picker-header h2 {
        margin: 0;
        font-size: 17px;
        font-weight: 700;
    }
    .picker-list {
        overflow-y: auto;
        padding: 8px 0;
    }
    .picker-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 12px 16px;
        background: transparent;
        border: none;
        width: 100%;
        text-align: left;
        font-size: 16px;
        color: var(--text-primary);
        cursor: pointer;
        transition: background-color 80ms;
    }
    .picker-row:active { background: var(--bg-hover); }
    .picker-row.active { color: var(--accent); font-weight: 600; }
    .cc-toggle {
        align-self: flex-start;
        font-size: 13px;
        font-weight: 500;
        color: var(--accent-text);
        background: transparent;
        border: none;
        padding: 6px 0;
        cursor: pointer;
    }
    .body-input {
        flex: 1;
        border: none;
        background: transparent;
        padding: 12px 16px;
        font-size: 16px;
        line-height: 1.45;
        resize: none;
        outline: none;
        color: var(--text-primary);
        font-family: inherit;
        min-height: 120px;
    }
    .attach-tray {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 8px 16px;
    }
    .attach-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 10px;
        background: var(--bg-surface);
        border: 0.5px solid var(--border-soft);
        border-radius: 8px;
        font-size: 13px;
        color: var(--text-primary);
        max-width: 100%;
    }
    .attach-chip .truncate {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 180px;
    }
    .attach-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        padding: 2px;
        cursor: pointer;
        color: var(--text-tertiary);
    }
    .compose-actions {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 8px 16px calc(8px + env(safe-area-inset-bottom));
        background: var(--bg-surface);
        border-top: 0.5px solid var(--border-subtle);
        margin-top: auto;
    }
    .action-btn {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-hover);
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        transition: background-color 120ms;
    }
    .action-btn:active {
        background: var(--bg-active);
    }
    .action-btn.spy-btn.on {
        background: linear-gradient(135deg, #dc2626, #9333ea);
        color: #fff;
    }
    .close-btn {
        min-width: 44px;
        min-height: 44px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
        position: relative;
        z-index: 2;
    }
    .close-btn :global(svg),
    .close-btn :global(.icon) {
        pointer-events: none;
    }
    .close-btn:active {
        background: var(--bg-hover);
        border-radius: 10px;
    }

    /* AI reply suggestion strip — sits between the header fields and the
       body textarea. Palette mirrors the desktop .draft-sugg strip
       (accent-tinted card), sized for thumbs: 30px targets instead of the
       desktop's 22px, and the action buttons drop to their own trailing
       row via flex-wrap instead of squeezing beside the text. */
    .draft-sugg {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 8px;
        margin: 8px 16px;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-surface));
        border: 0.5px solid color-mix(in srgb, var(--accent) 22%, var(--border-subtle));
        border-radius: 12px;
        font-size: 14px;
        line-height: 1.45;
        color: var(--text-primary);
    }
    .draft-sugg > :global(svg) { flex-shrink: 0; margin-top: 2px; color: var(--accent-text); }
    .draft-sugg-text {
        flex: 1;
        min-width: 0;
        white-space: pre-wrap;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 4;
        line-clamp: 4;
        -webkit-box-orient: vertical;
    }
    .draft-sugg-actions {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .draft-sugg-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        height: 30px;
        padding: 0 10px;
        border-radius: 8px;
        border: 0.5px solid var(--border-subtle);
        background: var(--bg-surface);
        color: var(--text-secondary);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
    }
    .draft-sugg-btn :global(svg) { margin-top: 0; }
    .draft-sugg-btn:active { background: var(--bg-active); }
    .draft-sugg-btn.accept {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--bg-base);
    }
    .draft-sugg-btn.accept:active { filter: brightness(1.06); }

    /* The sparkle flash: a one-shot accent ring + soft background tint on
       the textarea for ~1.4s after a suggestion is inserted. A ::after
       sheen like desktop's can't be used — <textarea> is a replaced
       element and never renders pseudo-elements — so the sweep is done on
       background-image instead (a 3×-wide accent band whose position is
       animated across the field, behind the text). Ends fully
       transparent, so removing the class snaps to a clean state. */
    .body-input.sparkle {
        animation: draft-sparkle-m 1.4s cubic-bezier(0.2, 0.7, 0.2, 1) 1,
                   draft-sheen-m 1.4s ease-out 1;
        background-image: linear-gradient(
            115deg,
            transparent 0%,
            transparent 42%,
            color-mix(in srgb, var(--accent) 10%, transparent) 47%,
            color-mix(in srgb, var(--accent) 26%, transparent) 50%,
            color-mix(in srgb, var(--accent) 10%, transparent) 53%,
            transparent 58%,
            transparent 100%
        );
        background-size: 300% 100%;
        background-repeat: no-repeat;
    }
    @keyframes draft-sheen-m {
        0%   { background-position: 100% 0; }
        100% { background-position: 0% 0; }
    }
    @keyframes draft-sparkle-m {
        0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
        30%  { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 45%, transparent); }
        100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) {
        /* Defence in depth: DraftSparkle.flash() already no-ops, but if the
           class is ever present under reduced motion the static band must
           not sit parked over the text. */
        .body-input.sparkle { animation: none; background-image: none; }
    }
</style>
