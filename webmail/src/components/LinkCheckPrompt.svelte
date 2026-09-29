<script lang="ts">
    // "Check before you click" confirmation for links inside a message.
    //
    // Extracted out of MessageDetail (5000+ lines) rather than growing it:
    // this is a dialog with its own async lifecycle, its own verdict
    // vocabulary and its own focus trap, none of which belong in the reading
    // pane's markup.
    //
    // TWO RULES this component exists to keep:
    //
    // 1. The user is never trapped. Every path out of here opens the link:
    //    Continue, Enter, Escape, the ✕, or clicking the backdrop. The check
    //    running in the background can add information, it can never gate
    //    the action. A safety prompt that can lock someone out of their own
    //    mail is a bug, not caution.
    //
    // 2. Absence of evidence is not evidence of safety. "Never scanned",
    //    "no results yet", "timed out" and "no key configured" each get
    //    their own plain, non-alarming line. None of them is dressed up as a
    //    pass, because a green tick on an unchecked link is exactly the
    //    false all-clear this feature is meant to prevent.
    //
    // TONE RATIONALE: the overlay is a sheet, not a full-screen block. A
    // confirmed-bad link is worth interrupting for; an unchecked one is not,
    // and treating it as an emergency is how link checkers get switched off
    // wholesale. Hence `danger` styling for malicious/phishing only, `warn`
    // for suspicious, and calm neutral greys for every no-verdict state.

    import { onMount } from 'svelte';
    import { trapFocus } from '../lib/focus-trap';
    import { showToast } from '../lib/store.svelte';
    import Icon from './Icon.svelte';
    import {
        checkLink,
        describeVerdict,
        type LinkCheckResult
    } from '../lib/virustotal';

    interface Props {
        /** The href as the message declared it. */
        url: string;
        /** Text of the clicked anchor, when the frame could read it. */
        label?: string;
        /** Called when the user commits to opening the link. */
        onProceed: (url: string) => void;
        /** Called on any dismissal that is NOT a proceed. */
        onCancel: () => void;
    }
    let { url, label = '', onProceed, onCancel }: Props = $props();

    let dialogEl = $state<HTMLElement | null>(null);
    let result = $state<LinkCheckResult | null>(null);
    let checking = $state(true);

    // A stable render of the destination: the scheme and host tell the story
    // a full URL buries, and a hostile mail routinely hides the real host
    // after a trusted-looking one. Both are shown, never just one.
    const destination = $derived.by(() => {
        try {
            const u = new URL(url);
            const rest = `${u.pathname}${u.search}`;
            return {
                host: u.host,
                insecure: u.protocol === 'http:',
                path: rest === '/' ? '' : rest
            };
        } catch {
            return { host: url, insecure: false, path: '' };
        }
    });

    // `https://` on a link that a phish usually gets wrong is worth naming
    // plainly, and it costs nothing when the link is fine.
    const shownUrl = $derived(destination.path ? `${destination.host}${destination.path}` : destination.host);

    onMount(() => {
        const release = dialogEl ? trapFocus(dialogEl) : () => {};
        // Kick the check off after mount rather than in module body so the
        // dialog paints immediately: the first thing on screen is the
        // destination, which is the part the user actually needs to read.
        const ctrl = new AbortController();
        checkLink(url, { signal: ctrl.signal }).then((r) => {
            if (ctrl.signal.aborted) return;
            result = r;
            checking = false;
        });
        return () => {
            release();
            ctrl.abort();
        };
    });

    function proceed() {
        onProceed(url);
    }

    function handleKey(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
            return;
        }
        // Enter opens the link, so the common case is one keypress — the
        // dialog must never become a speed bump on a link the user has
        // already read in the message above it.
        if (e.key === 'Enter' && !e.shiftKey) {
            const target = e.target as HTMLElement | null;
            // Don't hijack Enter inside the URL text or a button that has its
            // own meaning (Continue is a button; Enter on it would fire twice).
            if (target && (target.tagName === 'BUTTON' || target.tagName === 'A' || target.tagName === 'TEXTAREA')) return;
            e.preventDefault();
            proceed();
        }
    }

    async function copyLink() {
        try {
            await navigator.clipboard.writeText(url);
            showToast('success', 'Link copied');
        } catch {
            showToast('error', 'Could not copy the link');
        }
    }

    const presentation = $derived(result ? describeVerdict(result) : null);
    const danger = $derived(presentation?.tone === 'danger');
</script>

<svelte:window onkeydowncapture={handleKey} />

<div
    class="linkcheck-overlay"
    role="presentation"
    data-testid="linkcheck-overlay"
    onclick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
>
    <div
        bind:this={dialogEl}
        class="linkcheck-dialog"
        class:linkcheck-danger={danger}
        role="dialog"
        aria-modal="true"
        aria-labelledby="linkcheck-title"
        aria-describedby="linkcheck-url"
        data-testid="linkcheck-dialog"
    >
        <div class="linkcheck-status" class:tone-danger={presentation?.tone === 'danger'} class:tone-warn={presentation?.tone === 'warn'} class:tone-good={presentation?.tone === 'good'}>
            {#if checking}
                <span class="linkcheck-spinner" aria-hidden="true"></span>
            {:else if danger}
                <Icon name="shieldAlert" size={16} />
            {:else if presentation?.tone === 'warn'}
                <Icon name="shieldAlert" size={16} />
            {:else}
                <Icon name="shield" size={16} />
            {/if}
            <span data-testid="linkcheck-verdict">
                {#if checking}
                    Checking this link…
                {:else if presentation}
                    {presentation.label}
                {/if}
            </span>
        </div>

        <p id="linkcheck-url" class="linkcheck-url" data-testid="linkcheck-url" title={url}>
            {#if label}<span class="linkcheck-label">{label}</span>{/if}
            <span class="linkcheck-host">{destination.host}</span>
            {#if destination.path}<span class="linkcheck-path">{destination.path}</span>{/if}
        </p>

        <div class="linkcheck-copy">
            {#if checking}
                <span class="muted">Asking VirusTotal, using this server's key. The destination is sent to them as part of the check.</span>
            {:else if presentation}
                <span class="muted">{presentation.detail}</span>
                {#if result?.title}
                    <span class="linkcheck-title">Page title: {result.title}</span>
                {/if}
            {/if}
        </div>

        {#if destination.insecure}
            <p class="linkcheck-note" data-testid="linkcheck-insecure">
                This link is plain <code>http://</code>, so anything you type on it is sent unencrypted.
            </p>
        {/if}

        <div class="linkcheck-actions">
            <button
                type="button"
                class="btn btn-primary"
                onclick={proceed}
                data-testid="linkcheck-continue"
            >
                {#if danger}Open anyway{:else}Continue{/if}
            </button>
            <button
                type="button"
                class="btn btn-secondary"
                onclick={copyLink}
                data-testid="linkcheck-copy"
            >Copy link</button>
            <button
                type="button"
                class="btn btn-ghost"
                onclick={onCancel}
                data-testid="linkcheck-cancel"
            >Cancel</button>
        </div>
    </div>
</div>

<style>
    /* Scoped to this dialog. Deliberately token-only, so it reads correctly
     * in both skins and in light and dark without a single literal colour —
     * the skins that ship their own palettes do not have to know this
     * component exists. */
    .linkcheck-overlay {
        position: fixed;
        inset: 0;
        z-index: 90;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--bg-overlay);
    }
    .linkcheck-dialog {
        width: min(520px, 100%);
        max-height: calc(100vh - 48px);
        overflow-y: auto;
        background: var(--bg-elevated);
        color: var(--text-primary);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    /* Only a confirmed-malicious or phishing destination earns the alarming
     * border. Anything else is a normal dialog, because most clicks are on
     * links nobody has ever reported. */
    .linkcheck-danger {
        border-color: var(--danger);
    }
    .linkcheck-status {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 14px;
        color: var(--text-primary);
    }
    .tone-danger { color: var(--danger); }
    .tone-warn { color: var(--warning); }
    .tone-good { color: var(--success); }
    .linkcheck-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--border-soft);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: linkcheck-spin 700ms linear infinite;
        flex: none;
    }
    @keyframes linkcheck-spin {
        to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
        .linkcheck-spinner { animation-duration: 2.4s; }
    }
    .linkcheck-url {
        margin: 0;
        font-family: var(--font-mono);
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--text-primary);
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 8px 10px;
        word-break: break-all;
    }
    /* The anchor's own text, when we could read it. Sits above the URL and
     * is capped so a marketing mail with a paragraph as its link text cannot
     * push the buttons off screen. */
    .linkcheck-label {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        font-family: inherit;
        color: var(--text-secondary);
        margin-bottom: 4px;
    }
    .linkcheck-path { color: var(--text-secondary); }
    .linkcheck-copy {
        font-size: 13px;
        line-height: 1.5;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .linkcheck-title { color: var(--text-tertiary); font-size: 12px; }
    .linkcheck-note {
        margin: 0;
        font-size: 12.5px;
        color: var(--warning);
    }
    .linkcheck-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
    }
</style>
