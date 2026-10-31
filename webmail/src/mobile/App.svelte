<script lang="ts">
    import { authState, startExpiryWatch } from '../lib/auth.svelte';
    import { probeCapabilities } from '../lib/settings.svelte';
    import { initImapSync } from '../lib/ai-threads.svelte';
    import { doctor, installErrorDoctor } from '../lib/error-doctor.svelte';
    import { mobileState, navigate, goBack, installAndroidBackHandler, resetMobileState } from './lib/store.svelte';
    import { cancelMobilePendingSend } from './lib/compose-undo-send.svelte';
    import { setAppBadge, onResume } from './lib/native-bridge';
    import { onMount } from 'svelte';
    import LoginView from './components/LoginView.svelte';
    import InboxView from './components/InboxView.svelte';
    import MessageView from './components/MessageView.svelte';
    import ComposeView from './components/ComposeView.svelte';
    import FoldersView from './components/FoldersView.svelte';
    import SettingsView from './components/SettingsView.svelte';
    import AiChatView from './components/AiChatView.svelte';
    import DriveView from './components/DriveView.svelte';
    import BottomNav from './components/BottomNav.svelte';
    import BackgroundTaskFloater from '../components/BackgroundTaskFloater.svelte';
    import PwaUpdatePrompt from '../components/PwaUpdatePrompt.svelte';
    import MobileMailShortcutHelp from './components/MobileMailShortcutHelp.svelte';
    import { settings, setTesseractOcrInstalled, setPhishingScanOcrInline } from '../lib/settings.svelte';
    import { shouldUseMobileTabletSplit } from '../lib/mobile-tablet-reading-pane';
    import { getMobileViewportWidth } from './lib/viewport.svelte';
    import TabletMailShell from './components/TabletMailShell.svelte';
    import { warmupTesseract } from '../lib/tesseract-ocr';
    import { resolveMobileMailShortcut } from '../lib/mobile-mail-keyboard-shortcuts';
    import { dispatchMobileMailShortcut } from './lib/mail-shortcut-handlers.svelte';

    let mobileShortcutHelpOpen = $state(false);

    const views: Record<string, any> = {
        inbox: InboxView,
        message: MessageView,
        compose: ComposeView,
        folders: FoldersView,
        settings: SettingsView,
        ai: AiChatView,
        drive: DriveView,
    };

    // Svelte 5: dynamic components are just capitalized tags — no
    // `<svelte:component>` wrapper. The AI tab is gone from the bottom
    // nav when AI is hard-off, so `view === 'ai'` can still be reached
    // from a stale history entry or a notification tap. Redirect to the
    // inbox rather than rendering an AI surface the user switched off.
    const CurrentView = $derived(
        mobileState.view === 'ai' && !settings.aiFeatures ? InboxView : views[mobileState.view]
    );

    const tabletMailSplit = $derived(
        shouldUseMobileTabletSplit(settings.readingPaneLayout, getMobileViewportWidth())
    );

    const showTabletMailShell = $derived(tabletMailSplit && mobileState.view === 'inbox');

    let prevTabletSplit = $state(false);

    // Phone ↔ tablet width: swap between split inbox and full-screen reader.
    $effect(() => {
        const split = tabletMailSplit;
        if (split === prevTabletSplit) return;
        if (split && mobileState.view === 'message') {
            mobileState.view = 'inbox';
        } else if (
            !split
            && mobileState.view === 'inbox'
            && mobileState.selectedUid != null
            && (mobileState.detail || mobileState.detailLoading)
        ) {
            navigate('message');
        }
        prevTabletSplit = split;
    });

    $effect(() => {
        if (authState.activeUser) {
            probeCapabilities();
            initImapSync();
        }
    });

    // Never let one account's lists / open message / drafts outlive its
    // session (logout, expiry, account switch). A null → user login keeps
    // state so a launch intent captured before sign-in survives.
    let lastUser = authState.activeUser;
    $effect(() => {
        const user = authState.activeUser;
        if (user === lastUser) return;
        const hadUser = lastUser !== null;
        lastUser = user;
        if (hadUser) resetMobileState();
    });

    onMount(() => {
        const stop = startExpiryWatch();
        const stopBack = installAndroidBackHandler();
        // Mirror the OS resume event into reactive state so any view can
        // refresh on app return without each one wiring its own listener.
        const stopResume = onResume(() => { mobileState.resumeTick++; });
        handleLaunchIntent();
        autoActivateOcr();
        const showShortcuts = () => { mobileShortcutHelpOpen = true; };
        window.addEventListener('webmail:mobile-show-shortcut-help', showShortcuts);
        // Settings + trusted-senders sync from the hidden IMAP folder.
        import('../lib/settings-sync').then((m) => m.startSync()).catch(() => { /* */ });
        return () => {
            stop();
            stopBack();
            stopResume();
            window.removeEventListener('webmail:mobile-show-shortcut-help', showShortcuts);
        };
    });

    // First-launch OCR bring-up. The mobile PWA gets the most value
    // from inline-image OCR for scam scans (people screenshot links
    // to dodge keyword filters). We auto-enable both toggles on the
    // first launch and warm up the worker in the background — the
    // ~3 MB WASM download is amortised on a wifi network in the
    // user's first few minutes, before they hit a phishy email and
    // it'd otherwise stall a scan. We gate on a one-shot localStorage
    // flag so subsequent logins don't override an explicit "off"
    // choice the user made later.
    function autoActivateOcr() {
        if (typeof window === 'undefined') return;
        try {
            if (localStorage.getItem('webmail.ocr-bootstrap.v1') === '1') return;
            localStorage.setItem('webmail.ocr-bootstrap.v1', '1');
            // Only auto-enable if the user hasn't already turned them
            // on (idempotent) and the device looks online — skip on
            // explicit offline mode so we don't burn a tiny data plan.
            if (!navigator.onLine) return;
            if (!settings.tesseractOcrInstalled) setTesseractOcrInstalled(true);
            if (!settings.phishingScanOcrInline) setPhishingScanOcrInline(true);
            // Warm up after a short delay so it doesn't compete with
            // the first paint of the inbox.
            setTimeout(() => { void warmupTesseract().catch(() => { /* */ }); }, 4000);
        } catch { /* localStorage unavailable — give up silently */ }
    }

    // Pick up launch-time intents — manifest shortcut (?compose=1),
    // Web Share Target (?share_text=…), or mailto: protocol handler
    // (?mailto=mailto:…). Strips the params after consuming so a
    // page reload doesn't replay the intent on top of the user's work.
    function handleLaunchIntent() {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        const wantsCompose = params.has('compose') || params.has('share_text') || params.has('share_url') || params.has('share_title') || params.has('mailto');
        if (!wantsCompose) return;

        // Build a draft from whichever set of params is present. The
        // share-target lines feed the body; mailto: takes over the
        // recipient + subject if it's a parsable URL.
        const lines: string[] = [];
        const t = params.get('share_title');
        const txt = params.get('share_text');
        const u = params.get('share_url');
        if (t) lines.push(t);
        if (txt) lines.push(txt);
        if (u) lines.push(u);

        let to = '';
        let subject = '';
        const mailto = params.get('mailto');
        if (mailto) {
            try {
                const url = new URL(mailto);
                if (url.protocol === 'mailto:') {
                    to = decodeURIComponent(url.pathname || '');
                    const sp = url.searchParams;
                    subject = sp.get('subject') || '';
                    const body = sp.get('body') || '';
                    if (body) lines.push(body);
                }
            } catch { /* malformed mailto — ignore */ }
        }

        mobileState.composeReplyTo = null;
        mobileState.composeMode = 'new';
        mobileState.composePrefillTo = to;
        mobileState.composePrefillSubject = subject;
        mobileState.composePrefillBody = lines.filter(Boolean).join('\n\n');
        navigate('compose');

        // Strip the launch params so a refresh doesn't re-trigger.
        try {
            const cleanUrl = window.location.pathname;
            window.history.replaceState({ view: 'compose' }, '', cleanUrl);
        } catch { /* */ }
    }

    // Reflect the inbox unread count on the launcher icon. Badging
    // API is best-effort; on platforms that don't support it, this is
    // a no-op. Drops the badge entirely when the count is zero so the
    // user gets the satisfying "all caught up" look.
    $effect(() => {
        const inbox = mobileState.mailboxes.find((m) => m.path === 'INBOX' || m.specialUse === '\\Inbox');
        const unread = inbox?.unseen ?? 0;
        setAppBadge(unread);
    });

    installErrorDoctor();

    function typingInField(target: EventTarget | null): boolean {
        if (!target || !(target instanceof HTMLElement)) return false;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
        return target.isContentEditable;
    }

    async function onMobileMailKey(e: KeyboardEvent) {
        if (!authState.activeUser || e.defaultPrevented) return;
        if (typingInField(e.target)) {
            if (e.key === 'Escape' && mobileShortcutHelpOpen) {
                mobileShortcutHelpOpen = false;
                e.preventDefault();
            }
            return;
        }
        if (e.key === 'Escape') {
            if (mobileShortcutHelpOpen) {
                mobileShortcutHelpOpen = false;
                e.preventDefault();
                return;
            }
            if (mobileState.view === 'message') {
                e.preventDefault();
                goBack();
                return;
            }
            if (mobileState.view === 'compose') return;
        }
        if (mobileState.view === 'compose' || mobileState.view === 'ai') return;

        const action = resolveMobileMailShortcut(e);
        if (!action) return;

        if (action === 'show-help') {
            e.preventDefault();
            mobileShortcutHelpOpen = true;
            return;
        }
        if (action === 'compose-new') {
            e.preventDefault();
            mobileState.composeReplyTo = null;
            mobileState.composeMode = 'new';
            navigate('compose');
            return;
        }

        e.preventDefault();
        await dispatchMobileMailShortcut(action);
    }
</script>

<svelte:window onkeydown={onMobileMailKey} />

{#if !authState.activeUser}
    <LoginView />
{:else}
    <div class="mobile-shell">
        {#key mobileState.view}
            <div class="view-wrap fade-in">
                {#if showTabletMailShell}
                    <TabletMailShell />
                {:else}
                    <CurrentView />
                {/if}
            </div>
        {/key}
        {#if mobileState.view !== 'message' && mobileState.view !== 'compose'}
            <BottomNav />
        {/if}
    </div>
{/if}

{#if mobileState.toast}
    <div class="mtoast {mobileState.toast.kind}" data-testid="mobile-toast" role={mobileState.toast.kind === 'error' ? 'alert' : 'status'} aria-live={mobileState.toast.kind === 'error' ? 'assertive' : 'polite'}>
        <span>{mobileState.toast.message}</span>
        {#if mobileState.sendUndo && mobileState.toast.ts >= mobileState.sendUndo.ts && mobileState.toast.ts - mobileState.sendUndo.ts < 500}
            <button type="button" class="mtoast-undo" data-testid="mobile-send-undo-btn" onclick={() => cancelMobilePendingSend()}>Undo</button>
        {/if}
    </div>
{/if}

{#if doctor.incident}
    {#await import('../components/ErrorDoctor.svelte') then mod}
        <mod.default />
    {/await}
{/if}
{#if authState.activeUser}
    <BackgroundTaskFloater />
{/if}
<MobileMailShortcutHelp open={mobileShortcutHelpOpen} onClose={() => (mobileShortcutHelpOpen = false)} />
<PwaUpdatePrompt />

<style>
    .mobile-shell {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }
    .view-wrap {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }
</style>
