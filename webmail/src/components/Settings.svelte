<script lang="ts" module>
    // Which section the dialog was last showing. The component is torn down
    // and rebuilt every time Settings opens (Layout unmounts it on close), so
    // component state cannot remember anything — without this, reopening
    // Settings always dumps the user back on Account and they re-navigate
    // from the top of the rail every single time.
    //
    // Module scope rather than localStorage: this is a UI navigation
    // convenience for the current tab, not a preference worth persisting to
    // disk or leaking between browsers.
    //
    // Keyed BY USER, because this module outlives a sign-out. The app keeps
    // running for multi-account sessions — Layout's logout() drops one session
    // and switches to another with no reload — so a single "last section"
    // hands account A's navigation state (Security, say) to account B, who
    // was never there. A per-user map keeps each account's rail position its
    // own, and an unknown account gets the default.
    const NO_USER = '';
    const lastSectionByUser = new Map<string, string>();
    function rememberedSection(user: string | null | undefined): string {
        return lastSectionByUser.get(user == null ? NO_USER : user.toLowerCase()) ?? 'account';
    }
    function rememberSection(user: string | null | undefined, id: string) {
        lastSectionByUser.set(user == null ? NO_USER : user.toLowerCase(), id);
    }
</script>

<script lang="ts">
    // Session status wording.
    //
    // The list used to print "Active · expires just now": the label came
    // from "is this the session we're using", the time from a relative
    // formatter, and nothing reconciled them. A token past its expiry was
    // still described as Active, and a token seconds from expiry read as
    // already gone. Decide both from the same timestamp, and treat the
    // last few minutes as their own state rather than a boundary the
    // relative formatter has to phrase.
    const EXPIRING_SOON_MS = 5 * 60 * 1000;
    function sessionStatus(expiresAt: number, isActive: boolean): string {
        const remaining = expiresAt - Date.now();
        if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
            return isActive ? 'Active · no expiry set' : 'Signed in · no expiry set';
        }
        if (remaining <= 0) return 'Expired — sign in again to continue';
        if (remaining <= EXPIRING_SOON_MS) {
            const mins = Math.max(1, Math.round(remaining / 60000));
            return `Expiring soon · renews or ends in ${mins} min`;
        }
        const label = isActive ? 'Active' : 'Signed in';
        return `${label} · expires ${relativeTime(new Date(expiresAt).toISOString())}`;
    }

    import { onMount } from 'svelte';
    import {
        settings, capabilities, setLlm, setUseCustomLlm, setAiFeatures, setDensity, setGroupThreads, setProxyImages, setPermanentSignIn, setPhishingScan, setTrackOpensDefault, setAiSuggestSubjectOnBlur, setPhishingScanTimeoutSec, setPhishingScanPromptAddendum, setPhishingScanConfidenceFloor,
        setAiSystemPrompt, setAccountChipDisplay,
        aiModels, aiModelsSignature, clearAiModels, loadAiModels,
        setDefaultFromAddress, setDisplayName, deriveNameFromAddress, setPageSize,
        setTesseractOcrInstalled, setPhishingScanOcrInline,
        setSpamSuggest, setSpamSuggestConfidenceFloor, setSpamSweepBatchSize, setAiSortSweepSpam,
        setVipAddresses, setPreSendCheck, setComposeHistorySummary, setAiSuggestReply,
        aiAvailable,
        setCalendarTicker, setCalendarTickerTitles, setWeatherChipOutlook, setLinkSafetyCheck
    } from '../lib/settings.svelte';
    import { warmupTesseract, teardownTesseract } from '../lib/tesseract-ocr';
    import { linkCheckConfigured } from '../lib/virustotal';
    import { showToast } from '../lib/store.svelte';
    import { summarizeMessage } from '../lib/api';
    import { privacySummary } from '../lib/privacy-facts';
    import {
        addressBook, loadAddressBook, addContact, editContact, removeContact,
        filterContacts, clearAddressBook, type Contact
    } from '../lib/address-book.svelte';
    import { trapFocus } from '../lib/focus-trap';
    import { pwa, promptInstall, subscribePush, unsubscribePush, pushSubscriptionStatus, diagnosePush, sendTestPush, type PushDiagnostics } from '../lib/pwa.svelte';
    import { authState, getSession, isRemembered, forgetSavedCreds } from '../lib/auth.svelte';
    import {
        sounds, setMuted, playNotify,
        SOUND_EVENTS, SOUND_PACKS, SOUND_STYLES, packsInStyle,
        setEventPack, resetSoundProfile, previewPack
    } from '../lib/sounds.svelte';
    import { gravatarPref, setGravatarEnabled, clearAvatarCache, myAvatars, setMyAvatar, clearMyAvatar } from '../lib/avatars.svelte';
    import { spamFeedback, markTrusted, removeTrusted, removeTrustedDomain } from '../lib/spam-feedback.svelte';
    import { voicePrefs, setVoiceEnabled, isVoiceAvailable, isSttAvailable } from '../lib/voice.svelte';
    import { SKINS, skinState, setSkin, setCustomAccent, setSemantic, resetSemantics, setCustomCss } from '../lib/skins.svelte';
    import {
        getMailboxInfo, getLogins, getAliases, getTempAliases,
        listBlockedSenders, listAllowedSenders, blockSender, allowSender,
        unblockSender, unallowSender, createTempAlias, deleteTempAlias,
        listBlockedRecipients, blockRecipient, unblockRecipient,
        listMailRules, addMailRule, removeMailRule,
        listAppPasswords, createAppPassword, revokeAppPassword, type AppPassword,
        listWebhookInboxes, createWebhookInbox, revokeWebhookInbox, type WebhookInbox,
        ApiError, type MailboxInfo, type LoginEntry, type AliasEntry,
        type TempAliasEntry, type SenderPolicy,
        type MailRule, type MailRuleConditionType, type MailRuleActionType
    } from '../lib/api';
    import { formatBytes, formatFullDate } from '../lib/format';
    import {
        listOutboundWebhooks, createOutboundWebhook, updateOutboundWebhook,
        deleteOutboundWebhook, testOutboundWebhook, isOutboundWebhooksUnavailable,
        type OutboundWebhook, type TestSendResult
    } from '../lib/outbound-webhooks';
    import {
        parseHeaderLines, formatHeaderLines, MASKED_VALUE,
        type HeaderLineError
    } from '../lib/webhook-header-lines';
    import Icon from './Icon.svelte';
    import Avatar from './Avatar.svelte';
    import { ensureCountry, geoipCache, flagEmoji } from '../lib/geoip.svelte';
    import { takeover, loadTakeover, setTakeoverEnabled, setTakeoverKnobs } from '../lib/takeover.svelte';
    import type { TakeoverSettings } from '../lib/api';
    import type { IconName } from '../lib/icons';

    // Outlook's Settings is a three-column overlay: a category rail on the
    // left, a sub-section list in the middle, one content pane on the right.
    // The middle column's item id doubles as the legacy `settings-tab-<id>`
    // data-testid, so the pre-existing tab ids are preserved verbatim and
    // every spec that clicks `settings-tab-privacy` still lands correctly.
    type SectionId =
        | 'account' | 'security'
        | 'notifications' | 'ai' | 'sounds' | 'appearance' | 'calendar' | 'people'
        | 'message-list' | 'reading-pane' | 'privacy' | 'compose' | 'smart-suggestions'
        | 'mail-rules' | 'sweep' | 'junk'
        | 'filters' | 'forwarding' | 'outbound-hooks';
    type CategoryId = 'account' | 'general' | 'email' | 'calendar' | 'people';

    interface SectionDef {
        id: SectionId;
        label: string;
        icon: IconName;
        /** Words the rail's search box matches against (label is included). */
        keywords: string;
    }

    interface CategoryDef {
        id: CategoryId;
        label: string;
        icon: IconName;
        sections: SectionDef[];
    }

    const CATEGORIES: CategoryDef[] = [
        {
            id: 'account', label: 'Account', icon: 'user',
            sections: [
                { id: 'account', label: 'Account', icon: 'user', keywords: 'profile storage quota alias disposable from address avatar' },
                { id: 'security', label: 'Security', icon: 'shield', keywords: 'password app agent link login session device revoke' }
            ]
        },
        {
            id: 'general', label: 'General', icon: 'monitor',
            sections: [
                { id: 'notifications', label: 'Notifications', icon: 'bell', keywords: 'push install pwa desktop alert' },
                { id: 'ai', label: 'AI', icon: 'sparkles', keywords: 'llm openai anthropic model provider prompt voice chat' },
                { id: 'sounds', label: 'Sounds', icon: 'bell', keywords: 'audio chime event pack mute' },
                { id: 'appearance', label: 'Appearance', icon: 'palette', keywords: 'skin accent colour theme density layout sidebar' }
            ]
        },
        {
            id: 'email', label: 'Email', icon: 'inbox',
            sections: [
                { id: 'message-list', label: 'Message list', icon: 'inbox', keywords: 'page size density group thread chip list' },
                { id: 'reading-pane', label: 'Reading pane', icon: 'eye', keywords: 'avatar gravatar sender preview' },
                { id: 'privacy', label: 'Images & privacy', icon: 'shield', keywords: 'remote image proxy ip tracking' },
                { id: 'compose', label: 'Compose', icon: 'pencil', keywords: 'write send tracker display name from address' },
                { id: 'smart-suggestions', label: 'Smart suggestions', icon: 'sparkles', keywords: 'subject proofread history summary pre-send' },
                { id: 'mail-rules', label: 'Rules', icon: 'filter', keywords: 'sieve block redirect forward copy fileinto move folder stop' },
                { id: 'sweep', label: 'Sweep', icon: 'filter', keywords: 'spam trash batch bulk classify' },
                { id: 'junk', label: 'Junk email', icon: 'shieldAlert', keywords: 'scam phishing ocr trusted spam quarantine' },
                { id: 'filters', label: 'Message handling', icon: 'filter', keywords: 'block allow sender recipient catchall' },
                { id: 'forwarding', label: 'Forwarding and IMAP', icon: 'send', keywords: 'alias imap smtp device connect port' },
                { id: 'outbound-hooks', label: 'Outbound webhooks', icon: 'globe', keywords: 'webhook post url inbound outgoing api' }
            ]
        },
        {
            id: 'calendar', label: 'Calendar', icon: 'calendar',
            sections: [
                { id: 'calendar', label: 'Calendar', icon: 'calendar', keywords: 'ticker event header caldav' }
            ]
        },
        {
            id: 'people', label: 'People', icon: 'user',
            sections: [
                { id: 'people', label: 'People', icon: 'user', keywords: 'vip contact family badge avatar address' }
            ]
        }
    ];

    // Restore wherever THIS USER left off; see the module-scope note above.
    //
    // Validated against the registry, not just cast. The content pane is an
    // if/else-if chain with NO terminal else, so an id that no longer exists
    // renders a completely blank pane — and the rail highlights nothing
    // either, leaving the user stranded in a dialog they cannot read. That is
    // not hypothetical: the 'attachments' and 'conditional-formatting'
    // sections were deleted from this build, and a remembered id pointing at
    // either one is exactly this case. Fall back to the first section so a
    // stale id can never blank the dialog.
    const FIRST_SECTION = CATEGORIES[0].sections[0].id;
    function isSectionId(id: string): id is SectionId {
        return CATEGORIES.some((c) => c.sections.some((sec) => sec.id === id));
    }
    const initialSection = rememberedSection(authState.activeUser);
    let activeSection = $state<SectionId>(
        isSectionId(initialSection) ? initialSection : FIRST_SECTION
    );
    let settingsSearch = $state('');

    // Which category owns the open section, for the breadcrumb. Derived from
    // the registry rather than stored, so a section that moves between
    // categories can't leave a stale label behind.
    const activeCategory = $derived(
        CATEGORIES.find((c) => c.sections.some((s) => s.id === activeSection))
    );

    // Sections that must disappear from the rail when AI is hard-off.
    // 'smart-suggestions' is listed because every row in it spends a model
    // call, so with AI off it is a panel of dead toggles. 'ai' is
    // deliberately ABSENT: it holds the master switch, so hiding it would
    // strand the user with no way to turn AI back on.
    // 'sweep' rides here too: its only trigger is the inbox AI-sort
    // button, so with AI off its two toggles control nothing.
    const AI_GATED_SECTIONS: SectionId[] = ['smart-suggestions', 'sweep'];
    const visibleCategories = $derived(
        !settings.aiFeatures
            ? CATEGORIES.map((c) => ({ ...c, sections: c.sections.filter((s) => !AI_GATED_SECTIONS.includes(s.id)) }))
                .filter((c) => c.sections.length)
            : CATEGORIES
    );

    // If the AI-off transition hides the section the user currently has
    // open, move them somewhere real instead of blanking the panel. The
    // section list is remembered per-user, so this is a genuine state to
    // land in, not a theoretical one.
    $effect(() => {
        if (settings.aiFeatures) return;
        if (AI_GATED_SECTIONS.includes(activeSection)) activeSection = 'ai';
    });
    const activeCategoryLabel = $derived(activeCategory?.label ?? '');

    // The rail's search box filters sections in *every* category, and a hit
    // outside the current category switches to the category that owns it —
    // otherwise typing "sieve" would show a match the user cannot open.
    // Category labels are searchable too, so "email" surfaces the whole group.
    const searchHits = $derived.by(() => {
        const q = settingsSearch.trim().toLowerCase();
        if (!q) return null;
        return visibleCategories.map((c) => {
            // A category-name hit keeps every section: the user asked for the
            // group, not one row inside it.
            const catMatch = `${c.label} ${c.id}`.toLowerCase().includes(q);
            return {
                cat: c,
                sections: catMatch
                    ? c.sections
                    : c.sections.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(q))
            };
        }).filter((r) => r.sections.length);
    });

    function selectSection(s: SectionDef) {
        activeSection = s.id;
        rememberSection(authState.activeUser, s.id);
    }

    // IMAP/SMTP details for the "connect a device" card. These were {@const}
    // tags inside a now-removed {#if true} wrapper; a const tag needs a block
    // parent, and there is no condition left to provide one.
    const deviceEmail = $derived(authState.activeUser || 'you@example.com');
    const deviceDomain = $derived(deviceEmail.split('@')[1] || 'example.com');

    // The Sweep section is a pair of toggles for the inbox AI-sort sweep. The
    // runner that used to live here (scan, list results, bulk-move to
    // Spam/Trash) was removed from the template and never called, so it and
    // its .sweep-* styling were dead weight; the sweep itself still runs from
    // the inbox AI-sort button.

    // --- Privacy panel derived state -----------------------------------------------
    // There is no "are images blocked?" question left to answer: remote
    // images are always allowed, and `settings.proxyImages` — which defaults
    // true and is migrated forward for every upgrading profile — is the only
    // thing that decides how they are fetched. Derived directly from the
    // setting so the state line below always describes what is happening
    // now, with no migration marker in the chain to go stale.
    const imagesProxied = $derived(settings.proxyImages);
    // The AI claims, rebuilt whenever the provider wiring changes (the 30s
    // capability probe assigns capabilities.aiConfig, and settings.llm is
    // user-editable), so the copy can never describe a stale route.
    const aiPrivacy = $derived(privacySummary());


    // --- Collapsible section state -------------------------------------------------
    let showBlockedSenders = $state(true);
    let showAllowedSenders = $state(true);
    let showBlockedRecipients = $state(true);
    let showMailRules = $state(true);
    // Forwarding-alias list is long on catch-all-heavy accounts, so it collapses to a
    // one-line count. Open by default: it's the cheapest thing to scan on the account page.
    let showForwardingAliases = $state(true);
    let showAiAdvanced = $state(false);
    let trustedAddInput = $state('');
    function addTrustedFromInput() {
        const v = trustedAddInput.trim();
        if (!v) return;
        // Bare-domain entries get pushed onto trustedDomains directly
        // (markTrusted assumes a full address). Detect by absence of @.
        if (v.includes('@')) {
            markTrusted(v);
        } else {
            // Simulate "user marked this domain as trusted" — addUnique helper
            // is not exposed, so do via markTrusted on a dummy address.
            markTrusted(`__user__@${v}`);
            // Drop the synthetic address row; keep just the domain.
            removeTrusted(`__user__@${v}`);
        }
        trustedAddInput = '';
    }

    // --- Helpers used by the Account / Security tabs -------------------------------

    function fuelLevel(pct: number): 'ok' | 'warn' | 'danger' {
        if (pct >= 90) return 'danger';
        if (pct >= 70) return 'warn';
        return 'ok';
    }

    function isPrivateIp(ip: string | null | undefined): boolean {
        if (!ip) return false;
        return /^(10\.|192\.168\.|169\.254\.|127\.|172\.(1[6-9]|2\d|3[0-1])\.|fe80:|fc00:|fd[0-9a-f]{2}:|::1$)/i.test(ip);
    }

    function serviceIcon(svc: string | null | undefined): IconName {
        const s = (svc || '').toLowerCase();
        if (s.includes('imap') || s.includes('pop')) return 'inbox';
        if (s.includes('smtp') || s.includes('submission') || s.includes('sieve')) return 'send';
        if (s.includes('caldav') || s.includes('carddav') || s.includes('dav') || s.includes('sogo')) return 'calendar';
        if (s.includes('http') || s.includes('webmail')) return 'globe';
        return 'wifi';
    }

    function relativeTime(iso: string): string {
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return iso;
        const diff = Date.now() - t;
        if (diff < 60_000) return 'just now';
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
        return `${Math.floor(diff / 86_400_000)}d ago`;
    }

    // Start the fuel-gauge fill at 0 so the CSS width transition has
    // something to animate from on the first paint. Flips to true the
    // frame after the storage gauge mounts.
    let fuelArmed = $state(false);
    $effect(() => {
        if (mailboxInfo) requestAnimationFrame(() => { fuelArmed = true; });
    });

    // Kick off country-flag lookups for every login row. Cached results
    // populate geoipCache.codes reactively.
    $effect(() => {
        for (const l of logins) {
            const ip = (l.ip || l.real_rip) as string | undefined;
            if (ip) ensureCountry(ip);
        }
    });

    let copiedIp = $state<string | null>(null);

    // Custom avatar upload — stored as a data URL keyed by the active
    // session's email, no server roundtrip.
    let hasMyAvatar = $derived(!!(authState.activeUser && myAvatars.map[authState.activeUser.toLowerCase()]));

    function pickMyAvatar() {
        if (!authState.activeUser) return;
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
        inp.onchange = () => {
            const f = inp.files?.[0];
            if (!f) return;
            // Resize to 128 px squared to keep localStorage usage in check;
            // gives us crisp HiDPI on a 64-px avatar.
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    const cv = document.createElement('canvas');
                    cv.width = 128; cv.height = 128;
                    const ctx = cv.getContext('2d');
                    if (!ctx) return;
                    // Center-crop square.
                    const s = Math.min(img.width, img.height);
                    const sx = (img.width - s) / 2;
                    const sy = (img.height - s) / 2;
                    ctx.drawImage(img, sx, sy, s, s, 0, 0, 128, 128);
                    const url = cv.toDataURL('image/jpeg', 0.85);
                    setMyAvatar(authState.activeUser!, url);
                    showToast('success', 'Avatar updated.');
                };
                img.src = reader.result as string;
            };
            reader.readAsDataURL(f);
        };
        inp.click();
    }
    function removeMyAvatarHandler() {
        if (!authState.activeUser) return;
        clearMyAvatar(authState.activeUser);
        showToast('success', 'Custom avatar removed.');
    }
    async function copyIp(ip: string) {
        try {
            await navigator.clipboard.writeText(ip);
            copiedIp = ip;
            setTimeout(() => { if (copiedIp === ip) copiedIp = null; }, 1200);
        } catch { /* ignore */ }
    }

    interface Props {
        onClose: () => void;
    }
    let { onClose }: Props = $props();

    let testing = $state(false);
    let testResult = $state<{ ok: boolean; message: string } | null>(null);
    let dialogEl: HTMLDivElement | undefined = $state();
    let pushStatus = $state<'subscribed' | 'denied' | 'default' | 'unsupported' | 'loading'>('loading');
    let pushDiag = $state<PushDiagnostics | null>(null);
    let pushTestSending = $state(false);
    let pushDiagOpen = $state(false);

    async function refreshPushDiag() {
        pushDiag = await diagnosePush();
    }

    async function handleTestPush() {
        const token = getSession()?.token;
        if (!token) { showToast('error', 'Sign in first'); return; }
        pushTestSending = true;
        try {
            const r = await sendTestPush(token);
            if (r.ok) showToast('success', 'Test notification sent — check your phone or browser.');
            else showToast('error', r.reason || 'Test push failed');
        } finally {
            pushTestSending = false;
        }
        await refreshPushDiag();
    }

    // Account / Privacy data — loaded lazily when those sections become
    // visible. Mailcow DB endpoints can be unavailable (DB not configured)
    // so each loader silently degrades.
    let mailboxInfo = $state<MailboxInfo | null>(null);
    let logins = $state<LoginEntry[]>([]);
    let aliases = $state<AliasEntry[]>([]);
    let tempAliases = $state<TempAliasEntry[]>([]);
    let blocked = $state<SenderPolicy[]>([]);
    let allowed = $state<SenderPolicy[]>([]);
    let blockedRecipients = $state<string[]>([]);
    let mailcowDbUnavailable = $state(false);

    // Agent access links: a pasteable URL carrying a 24-hour token an agent
    // can use as a bearer credential. Backed by the app-password store with
    // no IP pin — the point is handing it to something whose network you
    // don't control, so scoping would just break it.
    let appPasswords = $state<AppPassword[]>([]);
    let appPasswordsUnavailable = $state(false);
    let agentLinkBusy = $state(false);
    let agentLink = $state<string | null>(null);
    let agentLinkCopied = $state(false);

    async function loadAppPasswords() {
        try {
            const r = await listAppPasswords();
            appPasswords = r.appPasswords;
            appPasswordsUnavailable = false;
        } catch (e) {
            // 404 when the server has the feature off (no credential key).
            appPasswordsUnavailable = e instanceof ApiError && e.status === 404;
        }
    }

    async function createAgentLink() {
        agentLinkBusy = true;
        try {
            const created = await createAppPassword({
                label: `agent-link ${new Date().toISOString().slice(0, 16)}`,
                ipRanges: ['0.0.0.0/0', '::/0'],
                expiresInDays: 1
            });
            // The token rides in the fragment so it never hits a server log.
            agentLink = `${location.origin}/#agent=${created.token}`;
            agentLinkCopied = false;
            await loadAppPasswords();
        } catch (e) {
            showToast('error', e instanceof ApiError ? e.message : 'Could not create the link');
        } finally {
            agentLinkBusy = false;
        }
    }

    async function copyAgentLink() {
        if (!agentLink) return;
        try {
            await navigator.clipboard.writeText(agentLink);
            agentLinkCopied = true;
            setTimeout(() => { agentLinkCopied = false; }, 2000);
        } catch { /* clipboard blocked — the field is selectable */ }
    }

    async function removeAppPassword(id: string, label: string) {
        if (!confirm(`Revoke "${label}"? Anything using it stops working immediately.`)) return;
        try {
            await revokeAppPassword(id);
            await loadAppPasswords();
            showToast('success', 'Revoked');
        } catch {
            showToast('error', 'Could not revoke');
        }
    }

    // Webhook inboxes: user-minted URLs that turn a POST into an email in
    // this mailbox. The URL is shown once, on creation.
    let webhookInboxes = $state<WebhookInbox[]>([]);
    let webhookLimit = $state(0);
    let webhooksUnavailable = $state(false);
    let whLabel = $state('');
    let whCreating = $state(false);
    let whError = $state('');
    let whNewUrl = $state<string | null>(null);
    let whUrlCopied = $state(false);

    async function loadWebhookInboxes() {
        try {
            const r = await listWebhookInboxes();
            webhookInboxes = r.inboxes;
            webhookLimit = r.limit;
            webhooksUnavailable = false;
        } catch (e) {
            webhooksUnavailable = e instanceof ApiError && e.status === 404;
        }
    }

    async function submitWebhookInbox() {
        whError = '';
        if (!whLabel.trim()) { whError = 'Give it a name so you can tell it apart later.'; return; }
        whCreating = true;
        try {
            const created = await createWebhookInbox({ label: whLabel.trim() });
            whNewUrl = created.url;
            whUrlCopied = false;
            whLabel = '';
            await loadWebhookInboxes();
        } catch (e) {
            whError = e instanceof ApiError ? e.message : 'Could not create the webhook inbox.';
        } finally {
            whCreating = false;
        }
    }

    async function removeWebhookInbox(id: string, label: string) {
        if (!confirm(`Revoke "${label}"? POSTs to its URL stop arriving immediately.`)) return;
        try {
            await revokeWebhookInbox(id);
            await loadWebhookInboxes();
            showToast('success', 'Webhook inbox revoked');
        } catch {
            showToast('error', 'Could not revoke that webhook inbox');
        }
    }

    async function copyWebhookUrl() {
        if (!whNewUrl) return;
        try {
            await navigator.clipboard.writeText(whNewUrl);
            whUrlCopied = true;
            setTimeout(() => { whUrlCopied = false; }, 2000);
        } catch { /* clipboard blocked — the field is selectable */ }
    }

    let blockInput = $state('');
    let allowInput = $state('');
    let blockRecipientInput = $state('');
    let creatingAlias = $state(false);

    // ── Address book (Slice A) ──
    //
    // The list is derived from the store, not copied into component state,
    // so an edit made in Compose (or a contact harvested while this dialog
    // is open) shows up here without an explicit refresh.
    let contactSearch = $state('');
    let contactNameInput = $state('');
    let contactAddrInput = $state('');
    let contactNoteInput = $state('');
    let contactError = $state<string | null>(null);
    let contactSaving = $state(false);
    /** uid being edited inline, or null when the form is adding a new one. */
    let contactEditing = $state<string | null>(null);

    const contactRows = $derived(filterContacts(contactSearch));

    async function saveContact() {
        contactError = null;
        const address = contactAddrInput.trim();
        if (!address) { contactError = 'Enter an email address'; return; }
        if (contactEditing) {
            // An edit is awaited so the form only closes on a real outcome:
            // if it fails, the fields keep the user's typing and the error
            // explains why, rather than the row silently reverting.
            contactSaving = true;
            try {
                const res = await editContact(contactEditing, {
                    address,
                    name: contactNameInput,
                    note: contactNoteInput
                });
                if (!res.ok) { contactError = res.error; return; }
            } finally {
                contactSaving = false;
            }
        } else {
            // An add is synchronous: the row is on screen and the write is
            // fire-and-forget, so the form resets immediately and a second
            // contact can be typed without waiting on the network.
            const res = addContact({ address, name: contactNameInput, note: contactNoteInput });
            if (!res.ok) { contactError = res.error; return; }
        }
        resetContactForm();
    }

    function resetContactForm() {
        contactEditing = null;
        contactNameInput = '';
        contactAddrInput = '';
        contactNoteInput = '';
        contactError = null;
    }

    function startEditContact(c: Contact) {
        contactEditing = c.uid;
        contactNameInput = c.name || '';
        contactAddrInput = c.address;
        contactNoteInput = c.note || '';
        contactError = null;
    }

    async function deleteContactRow(uid: string) {
        await removeContact(uid);
        if (contactEditing === uid) resetContactForm();
    }

    /** "Last seen" as a short relative phrase; 0 means never in their mail. */
    function contactSeen(c: Contact): string {
        if (!c.lastSeen) return 'not seen in mail';
        const days = Math.floor((Date.now() - c.lastSeen) / 86400000);
        if (days <= 0) return 'seen today';
        if (days === 1) return 'seen yesterday';
        if (days < 30) return `seen ${days} days ago`;
        if (days < 365) return `seen ${Math.floor(days / 30)} months ago`;
        return `seen ${Math.floor(days / 365)} years ago`;
    }

    // v0.3.2 mail-rules — unified blocks / redirects / copies via Sieve.
    // The legacy `blockedRecipients` list above remains in the UI for the
    // "block this address fast" path; the rules list shows everything
    // including redirects + copies.
    let mailRules = $state<MailRule[]>([]);
    let mailRulesUnavailable = $state(false);
    let ruleConditionType = $state<MailRuleConditionType>('from-contains');
    let ruleConditionValue = $state('');
    let ruleConditionHeader = $state('');
    let ruleActionType = $state<MailRuleActionType>('discard');
    let ruleActionTo = $state('');
    let ruleSaving = $state(false);
    let ruleActionFolder = $state('');
    let ruleActionWebhookId = $state('');

    // Outbound webhooks — the targets rules' "send to webhook" action points
    // at. Loaded with the rest of the account data; a 404/501 means the
    // server predates the feature, so the panel hides instead of erroring.
    let outboundHooks = $state<OutboundWebhook[]>([]);
    let outboundLimit = $state(0);
    let outboundUnavailable = $state(false);
    let owUrl = $state('');
    let owLabel = $state('');
    let owKeep = $state(true);
    let owPrepend = $state('');
    let owSaving = $state(false);
    // Custom request headers for the next webhook, as raw `Name: value`
    // lines in one box.
    //
    // This replaces a name/value repeater, and the reason is the input, not
    // the aesthetics: nobody configuring a webhook is composing two fields,
    // they are holding one line somebody else wrote them —
    // `Authorization: Bearer crsr_…` — and the repeater made them re-type
    // it, then press "Add header", for every one. Parsing at submit keeps
    // the box a plain textarea (native multi-line paste, native undo,
    // native caret) and leaves nothing to get wrong per row.
    let owHeaderText = $state('');
    // Per-line problems, resolved only on submit or on demand.
    //
    // Deliberately NOT a $derived: the box is typed into continuously, and
    // a live "line 2 is reserved" while the user is still halfway through
    // typing `Content-Type` is noise, not help. The same reasons the old
    // row UI was replaced apply to error timing. Re-checked on every
    // input so the moment they fix a line the message goes away.
    let owHeaderErrors = $state<HeaderLineError[]>([]);
    let owHeaderIgnored = $state<HeaderLineError[]>([]);
    function recheckOwHeaders() {
        const p = parseHeaderLines(owHeaderText);
        owHeaderErrors = p.errors;
        owHeaderIgnored = p.ignored;
        return p;
    }
    // The signing secret comes back exactly once, on creation. Hold it so the
    // user can copy it — the server never lists it again.
    let owNewSecret = $state<{ id: string; secret: string } | null>(null);

    // Per-webhook header editing.
    //
    // The stored list cannot be edited in place for credentials — the
    // server returns `{ Authorization: '•••' }` and keeps the real value
    // forever — so editing a stored webhook is necessarily "retype the
    // values you want to keep, the rest are dropped on save". That is a
    // contract, not a limitation of this UI, and the editor says so while
    // it is open instead of after the save has already discarded something.
    let owEditId = $state<string | null>(null);
    let owEditText = $state('');
    let owEditErrors = $state<HeaderLineError[]>([]);
    let owEditSaving = $state(false);
    function openOwHeaderEditor(w: OutboundWebhook) {
        owEditId = w.id;
        owEditText = formatHeaderLines(w.headers);
        owEditErrors = [];
    }
    function closeOwHeaderEditor() {
        owEditId = null;
        owEditText = '';
        owEditErrors = [];
    }
    // Per-webhook state for the panel below. With a 100-webhook limit a flat
    // list is unusable, so the list is filterable and the result of the last
    // test send is kept per webhook — a test is the answer to "why isn't this
    // firing?", and losing it the moment the user scrolls away is why the
    // first version of this section had no test at all.
    let owSearch = $state('');
    let owBusyId = $state<string | null>(null);
    let owTestResult = $state<Record<string, TestSendResult>>({});
    let owExpandedId = $state<string | null>(null);
    // The list is open by default — "is anything configured?" is the question
    // people arrive with, and an empty collapsed section answers it with
    // nothing. The create form is closed by default: it is five inputs and a
    // header editor nobody opens unless they already know what they're adding.
    let showOwList = $state(true);
    let showOwCreate = $state(false);

    // Search is over label + URL because those are the two things a user
    // knows; header names come back from the server but a search over them
    // would return rows whose visible text doesn't contain the query, which
    // reads as a bug rather than a feature.
    const owVisibleHooks = $derived.by(() => {
        const q = owSearch.trim().toLowerCase();
        if (!q) return outboundHooks;
        return outboundHooks.filter(
            (w) => w.label.toLowerCase().includes(q) || w.url.toLowerCase().includes(q)
        );
    });

    // "never" beats "3 days ago" for a webhook that has not run yet: the
    // user's first question is whether a rule has ever pointed at it.
    function owLastUsedLabel(w: OutboundWebhook): string {
        if (!w.lastUsedAt) return 'never delivered to';
        return `last used ${formatFullDate(new Date(w.lastUsedAt).toISOString())}`;
    }

    const RULE_CONDITION_LABELS: Record<MailRuleConditionType, string> = {
        'from-contains': 'From contains',
        'to-contains': 'To contains',
        'subject-contains': 'Subject contains',
        'envelope-to-is': 'Envelope-to is exactly',
        'header-contains': 'Header contains',
        'header-is': 'Header is exactly'
    };
    const RULE_ACTION_LABELS: Record<MailRuleActionType, string> = {
        discard: 'Block (discard)',
        redirect: 'Redirect (forward, no copy)',
        copy: 'Copy (forward + keep)',
        fileinto: 'Move to folder (auto-move)',
        webhook: 'Send to external webhook'
    };

    async function loadAccountData() {
        try {
            const m = await getMailboxInfo();
            mailboxInfo = m;
        } catch (err) {
            if (err instanceof ApiError && err.status >= 500) mailcowDbUnavailable = true;
        }
        try { const r = await getLogins(10); logins = r.logins; } catch { /* skip */ }
        await loadAppPasswords();
        await loadWebhookInboxes();
        await loadOutboundWebhooks();
        try { const r = await getAliases(); aliases = r.aliases; } catch { /* skip */ }
        try { const r = await getTempAliases(); tempAliases = r.aliases; } catch { /* skip */ }
        try { const r = await listBlockedSenders(); blocked = r.list; } catch { /* skip */ }
        try { const r = await listAllowedSenders(); allowed = r.list; } catch { /* skip */ }
        try { const r = await listBlockedRecipients(); blockedRecipients = r.recipients; } catch { /* skip */ }
        try {
            const r = await listMailRules();
            mailRules = r.rules;
        } catch (err) {
            // 404 / endpoint missing → server is pre-v0.3.2; hide the panel.
            if (err instanceof ApiError && err.status === 404) mailRulesUnavailable = true;
        }
    }

    async function doBlock() {
        const s = blockInput.trim();
        if (!s) return;
        if (!confirm(`Block all mail from ${s}?`)) return;
        try {
            const r = await blockSender(s);
            blocked = [...blocked, r];
            blockInput = '';
            showToast('success', `Blocked ${s}`);
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        }
    }

    async function doUnblock(p: SenderPolicy) {
        try {
            await unblockSender(p.prefid);
            blocked = blocked.filter((x) => x.prefid !== p.prefid);
        } catch (err) { showToast('error', (err as Error).message); }
    }

    async function doAllow() {
        const s = allowInput.trim();
        if (!s) return;
        try {
            const r = await allowSender(s);
            allowed = [...allowed, r];
            allowInput = '';
            showToast('success', `Allowed ${s}`);
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        }
    }

    async function doUnallow(p: SenderPolicy) {
        try {
            await unallowSender(p.prefid);
            allowed = allowed.filter((x) => x.prefid !== p.prefid);
        } catch (err) { showToast('error', (err as Error).message); }
    }

    async function doBlockRecipient() {
        const r = blockRecipientInput.trim();
        if (!r) return;
        try {
            await blockRecipient(r);
            blockedRecipients = [...blockedRecipients, r];
            blockRecipientInput = '';
            showToast('success', `Blocked ${r}`);
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        }
    }

    async function doUnblockRecipient(addr: string) {
        try {
            await unblockRecipient(addr);
            blockedRecipients = blockedRecipients.filter((x) => x !== addr);
        } catch (err) { showToast('error', (err as Error).message); }
    }

    function ruleHasTarget(t: MailRuleActionType): boolean {
        return t === 'redirect' || t === 'copy';
    }

    function ruleNeedsFolder(t: MailRuleActionType): boolean {
        return t === 'fileinto';
    }

    function ruleNeedsWebhook(t: MailRuleActionType): boolean {
        return t === 'webhook';
    }

    function ruleHasHeader(t: MailRuleConditionType): boolean {
        return t === 'header-contains' || t === 'header-is';
    }

    function describeRule(r: MailRule): string {
        const c = r.condition;
        const a = r.action;
        const cTxt = ruleHasHeader(c.type)
            ? `${c.header || 'header'} ${c.type === 'header-is' ? 'is' : 'contains'} "${c.value}"`
            : `${RULE_CONDITION_LABELS[c.type] || c.type} "${c.value}"`;
        const aTxt = a.type === 'discard'
            ? 'block'
            : a.type === 'fileinto'
                ? `move → ${a.folder || ''}`
                : a.type === 'webhook'
                    ? `webhook → ${outboundHooks.find((w) => w.id === a.webhookId)?.label || a.webhookId || ''}`
                    : `${a.type} → ${a.to || ''}`;
        return `${cTxt} → ${aTxt}`;
    }

    async function doAddRule() {
        const value = ruleConditionValue.trim();
        if (!value) { showToast('error', 'Condition value is required'); return; }
        if (ruleHasTarget(ruleActionType) && !ruleActionTo.trim()) {
            showToast('error', 'Forward address is required'); return;
        }
        if (ruleNeedsFolder(ruleActionType) && !ruleActionFolder.trim()) {
            showToast('error', 'Destination folder is required'); return;
        }
        if (ruleNeedsWebhook(ruleActionType) && !ruleActionWebhookId) {
            showToast('error', 'Pick an outbound webhook'); return;
        }
        if (ruleHasHeader(ruleConditionType) && !ruleConditionHeader.trim()) {
            showToast('error', 'Header name is required'); return;
        }
        ruleSaving = true;
        try {
            const condition: MailRule['condition'] = { type: ruleConditionType, value };
            if (ruleHasHeader(ruleConditionType)) condition.header = ruleConditionHeader.trim();
            const action: MailRule['action'] = { type: ruleActionType };
            if (ruleHasTarget(ruleActionType)) action.to = ruleActionTo.trim();
            if (ruleNeedsFolder(ruleActionType)) action.folder = ruleActionFolder.trim();
            if (ruleNeedsWebhook(ruleActionType)) action.webhookId = ruleActionWebhookId;
            const name = `${ruleActionType} ${value}`.slice(0, 80);
            const r = await addMailRule({ name, condition, action });
            mailRules = [...mailRules, r];
            ruleConditionValue = '';
            ruleActionTo = '';
            ruleConditionHeader = '';
            showToast('success', 'Rule added');
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        } finally {
            ruleSaving = false;
        }
    }

    async function doRemoveRule(id: string) {
        try {
            await removeMailRule(id);
            mailRules = mailRules.filter((r) => r.id !== id);
        } catch (err) { showToast('error', (err as Error).message); }
    }

    async function loadOutboundWebhooks() {
        try {
            const r = await listOutboundWebhooks();
            outboundHooks = r.webhooks;
            outboundLimit = r.limit;
            if (!ruleActionWebhookId && r.webhooks.length) ruleActionWebhookId = r.webhooks[0].id;
        } catch (err) {
            if (isOutboundWebhooksUnavailable(err)) outboundUnavailable = true;
        }
    }

    async function doCreateOutboundWebhook() {
        const url = owUrl.trim();
        if (!url) { showToast('error', 'Webhook URL is required'); return; }
        // Parse BEFORE saving, and refuse on a bad line.
        //
        // The server would reject the same thing with a 400 naming one
        // header, but by then the user has been told nothing about WHICH
        // line of ten is wrong. Here the message list is per line and the
        // box keeps the text, so the fix is an edit rather than a retype.
        const parsed = recheckOwHeaders();
        if (parsed.errors.length) {
            showToast('error', `${parsed.errors.length} header line${parsed.errors.length === 1 ? '' : 's'} can't be sent — see below the box`);
            return;
        }
        // Nothing parsed at all but the box has text: the user pasted a
        // block we could not read. Sending the webhook with no headers
        // would deliver unauthenticated POSTs to a receiver that expects
        // an Authorization header, so stop and say so instead.
        if (parsed.ignored.length && parsed.empty) {
            showToast('error', 'No header lines found — each line needs "Name: value"');
            return;
        }
        owSaving = true;
        try {
            // Text lines → map at the last possible moment. An empty map is
            // passed as undefined so the field stays absent server-side.
            const headers: Record<string, string> = parsed.headers;
            const w = await createOutboundWebhook({
                url,
                label: owLabel.trim() || url,
                keep: owKeep,
                prepend: owPrepend.trim(),
                headers: Object.keys(headers).length ? headers : undefined
            });
            outboundHooks = [...outboundHooks, w];
            owNewSecret = w.secret ? { id: w.id, secret: w.secret } : null;
            owUrl = ''; owLabel = ''; owPrepend = '';
            // Reset to blank, not to a seeded Authorization row: the old
            // repeater's seed existed so a half-filled row had a name in
            // it, and a paste box has no equivalent. Leaving the previous
            // webhook's bearer token sitting in the form was the one thing
            // that must not survive a successful create.
            owHeaderText = '';
            owHeaderErrors = [];
            owHeaderIgnored = [];
            if (!ruleActionWebhookId) ruleActionWebhookId = w.id;
            showToast('success', 'Webhook added');
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        } finally {
            owSaving = false;
        }
    }

    async function doUpdateOutboundWebhook(w: OutboundWebhook, patch: { keep?: boolean; prepend?: string; headers?: Record<string, string> }) {
        try {
            const u = await updateOutboundWebhook(w.id, patch);
            outboundHooks = outboundHooks.map((x) => (x.id === w.id ? u : x));
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        }
    }

    async function doSaveOwHeaders(w: OutboundWebhook) {
        // `masked: 'reject'` — this save REPLACES the stored map wholesale
        // (the server's update treats any provided map as a full replace),
        // so a `•••` that got through would overwrite a working credential
        // with a literal bullet string and the receiver would start
        // rejecting every delivery. Refuse it in the box instead, where
        // the line is visible, rather than after the write.
        const parsed = parseHeaderLines(owEditText, { masked: 'reject' });
        owEditErrors = parsed.errors;
        if (parsed.errors.length) return;
        owEditSaving = true;
        try {
            await doUpdateOutboundWebhook(w, {
                // null clears; the API distinguishes "unchanged" from
                // "empty", and an empty box means the user wants the
                // headers gone, not left as they are.
                headers: Object.keys(parsed.headers).length ? parsed.headers : {}
            });
            closeOwHeaderEditor();
        } finally {
            owEditSaving = false;
        }
    }

    async function doDeleteOutboundWebhook(w: OutboundWebhook) {
        if (!confirm(`Remove webhook "${w.label}"? Rules pointing at it will stop delivering.`)) return;
        try {
            await deleteOutboundWebhook(w.id);
            outboundHooks = outboundHooks.filter((x) => x.id !== w.id);
            // The rule form's select is bound to this id. Svelte does not
            // re-resolve bind:value when the bound option disappears, so
            // leaving it set means the form still holds the deleted id and
            // the next rule POST is rejected with "No such outbound webhook".
            if (ruleActionWebhookId === w.id) {
                ruleActionWebhookId = outboundHooks[0]?.id ?? '';
            }
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        }
    }

    async function doTestOutboundWebhook(w: OutboundWebhook) {
        // One in flight at a time per webhook; the server enforces a
        // per-webhook-per-minute budget and answers 429, but a button that
        // lets you hammer it until it complains is a bad way to find out.
        owBusyId = w.id;
        try {
            const res = await testOutboundWebhook(w.id);
            owTestResult = { ...owTestResult, [w.id]: res };
            if (res.ok) {
                showToast('success', `${w.label}: HTTP ${res.status} in ${res.elapsedMs} ms`);
            } else {
                // Not an error dialog: the test worked, the receiver said no.
                // The card below carries the detail.
                showToast('info', `${w.label}: receiver answered HTTP ${res.status}`);
            }
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        } finally {
            owBusyId = null;
        }
    }

    async function newTempAlias(permanent: boolean, validityHours = 720) {
        creatingAlias = true;
        try {
            const r = await createTempAlias({
                description: 'Created from webmail',
                validityHours,
                permanent
            });
            tempAliases = [...tempAliases, { address: r.address, validity: r.validity, permanent: r.permanent }];
            showToast('success', `Created ${r.address}`);
        } catch (err) {
            const msg = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
            showToast('error', msg);
        } finally {
            creatingAlias = false;
        }
    }

    async function dropTempAlias(addr: string) {
        try {
            await deleteTempAlias(addr);
            tempAliases = tempAliases.filter((a) => a.address !== addr);
        } catch (err) { showToast('error', (err as Error).message); }
    }

    onMount(() => {
        pushSubscriptionStatus().then((s) => { pushStatus = s; });
        refreshPushDiag();
        loadAccountData();
        if (dialogEl) return trapFocus(dialogEl);
    });

    // The provider catalog follows whichever endpoint is configured. Reacting
    // to the signature (kind + preset + baseUrl + key) rather than to each
    // keystroke means we refetch on a *settled* provider, and never re-ask
    // when the user merely edits the model name.
    //
    // The advanced block is collapsed by default, so gating on
    // `showAiAdvanced` avoids hitting the gateway for a list nobody will see;
    // `activeSection === 'ai'` keeps the request off from other Settings
    // pages, and aiFeatures-off means we must not ask the gateway anything.
    let lastModelsSig: string | null = null;
    $effect(() => {
        const sig = aiModelsSignature();
        const visible = showAiAdvanced && activeSection === 'ai' && settings.aiFeatures;
        if (!visible) {
            // Collapsed, or on another page: drop whatever we were showing
            // rather than leaving a stale provider's models under the field.
            if (lastModelsSig !== null) { clearAiModels(); lastModelsSig = null; }
            return;
        }
        if (sig === lastModelsSig) return;
        lastModelsSig = sig;
        void loadAiModels();
    });

    // The takeover knobs are server state (the assistant runs on the
    // server), so they are fetched, not read from local settings — same
    // gating as the models fetch above: only when the AI section is open.
    $effect(() => {
        if (activeSection === 'ai' && !takeover.loaded && !takeover.unavailable) void loadTakeover();
    });

    async function onTakeoverEnabled(on: boolean) {
        try {
            await setTakeoverEnabled(on);
        } catch (e) {
            showToast('error', (e as Error).message || 'Could not change that setting');
        }
    }

    // Knob edits are validated against the same ranges the server enforces,
    // then snapped and echoed back from the server's effective value. The
    // server is still the enforcer — this is just not to waste a round-trip.
    async function onTakeoverNumber(key: 'maxRepliesPerHour' | 'minDelayMinutes' | 'lookbackHours', raw: string, min: number, max: number) {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n)) return;
        const v = Math.min(Math.max(n, min), max);
        if (v !== n) showToast('info', `Kept between ${min} and ${max} — set to ${v}.`);
        const patch: Partial<TakeoverSettings> = {};
        patch[key] = v;
        try {
            await setTakeoverKnobs(patch);
        } catch (e) {
            showToast('error', (e as Error).message || 'Could not save that setting');
        }
    }

    async function onTakeoverAttachments(on: boolean) {
        try {
            await setTakeoverKnobs({ considerAttachments: on });
        } catch (e) {
            showToast('error', (e as Error).message || 'Could not save that setting');
        }
    }

    async function handleEnableNotifications() {
        const token = getSession()?.token;
        if (!token) {
            showToast('error', 'Sign in first');
            return;
        }
        const r = await subscribePush(token);
        if (r.ok) {
            pushStatus = 'subscribed';
            showToast('success', 'Notifications enabled');
        } else {
            showToast('error', r.reason || 'Could not enable notifications');
            pushStatus = await pushSubscriptionStatus();
        }
    }

    async function handleDisableNotifications() {
        const token = getSession()?.token;
        if (!token) return;
        const r = await unsubscribePush(token);
        if (r.ok) {
            pushStatus = 'default';
            showToast('success', 'Notifications disabled');
        }
    }

    async function handleInstall() {
        const outcome = await promptInstall();
        if (outcome === 'unavailable') {
            showToast('info', 'Install prompt is not available right now. Check the browser address bar.');
        }
    }

    // Whether the server has a VirusTotal key. Probed once, on mount.
    // `linkCheckProbed` is separate from the value because "not probed yet"
    // and "probed, no key" must not render the same line: the first would
    // tell a correctly-configured server it has no key, which is worse than
    // saying nothing for a moment.
    // `vtConfigured` rather than `linkCheckConfigured`, which is the imported
    // probe — a state variable and a function cannot share a name in one
    // component scope.
    let vtConfigured = $state<boolean | null>(null);
    let linkCheckProbed = $state(false);
    $effect(() => {
        let live = true;
        linkCheckConfigured().then((ok) => {
            if (!live) return;
            vtConfigured = ok;
            linkCheckProbed = true;
        });
        return () => { live = false; };
    });

    const PRESETS: { value: string; label: string; help: string }[] = [
        { value: 'mistral', label: 'Mistral', help: 'api.mistral.ai · default for OCR + chat' },
        { value: 'openai', label: 'OpenAI', help: 'api.openai.com · gpt-4o-mini default' },
        { value: 'groq', label: 'Groq', help: 'api.groq.com · Llama 3.1 70B' },
        { value: 'together', label: 'Together AI', help: 'api.together.xyz' },
        { value: 'perplexity', label: 'Perplexity', help: 'api.perplexity.ai' },
        { value: 'openrouter', label: 'OpenRouter', help: 'openrouter.ai · 100+ models' },
        { value: 'ollama', label: 'Ollama (local)', help: 'http://127.0.0.1:11434' },
        { value: '', label: 'Custom OpenAI-compatible', help: 'point at any /chat/completions endpoint' }
    ];

    // Provider URL/model resolution mirrors lib/chat.svelte.ts so the test
    // hits the same endpoint the chat bot uses. Without this, "Use my own
    // provider" would test the server-side /v1/ai/summarize route — which
    // 404s when the imap-rest server has no LLM_API_KEY of its own.
    function resolveProviderBaseUrl(): string {
        const llm = settings.llm;
        if (llm.baseUrl) return llm.baseUrl.replace(/\/+$/, '');
        const presets: Record<string, string> = {
            mistral: 'https://api.mistral.ai/v1',
            openai: 'https://api.openai.com/v1',
            groq: 'https://api.groq.com/openai/v1',
            together: 'https://api.together.xyz/v1',
            ollama: 'http://127.0.0.1:11434/v1',
            perplexity: 'https://api.perplexity.ai',
            openrouter: 'https://openrouter.ai/api/v1'
        };
        return presets[llm.preset] || presets.openai;
    }
    function resolveProviderModel(): string {
        const llm = settings.llm;
        if (llm.model) return llm.model;
        const defaults: Record<string, string> = {
            mistral: 'mistral-small-latest',
            openai: 'gpt-4o-mini',
            groq: 'llama-3.1-70b-versatile',
            together: 'meta-llama/Llama-3-8b-chat-hf',
            ollama: 'llama3.1',
            perplexity: 'llama-3.1-sonar-small-128k-chat',
            openrouter: 'meta-llama/llama-3.1-8b-instruct'
        };
        return defaults[llm.preset] || defaults.openai;
    }

    async function testConnection() {
        testing = true;
        testResult = null;
        try {
            if (settings.useCustomLlm && settings.llm.apiKey) {
                // Direct call to the user's provider — same path as the chat bot.
                const baseUrl = resolveProviderBaseUrl();
                const model = resolveProviderModel();
                const res = await fetch(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${settings.llm.apiKey}`,
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        model,
                        messages: [{ role: 'user', content: 'Reply with the single word "ok".' }],
                        max_tokens: 4000,
                        temperature: 0
                    })
                });
                if (!res.ok) {
                    let detail = `${res.status} ${res.statusText}`;
                    try {
                        const j = await res.json();
                        detail = j?.error?.message || j?.message || detail;
                    } catch { /* not JSON */ }
                    throw new Error(detail);
                }
                const j = await res.json();
                const m = j?.choices?.[0]?.message || {};
                const reasoning = typeof m.reasoning === 'string' ? m.reasoning : '';
                const detailText = Array.isArray(m.reasoning_details)
                    ? m.reasoning_details.map((d: { text?: string }) => d?.text || '').join('').trim()
                    : '';
                const text = (m.content || reasoning || detailText || '').trim() || '(empty reply)';
                testResult = { ok: true, message: `Reply from ${j.model || model}: ${text.slice(0, 80)}` };
            } else {
                // Server-side /v1/ai/summarize — only works when LLM_API_KEY is set on the backend.
                const r = await summarizeMessage('Test connection. Reply with the single word "ok".', 20);
                testResult = { ok: true, message: `Reply from ${r.model}: ${r.content.slice(0, 80)}` };
            }
        } catch (err) {
            testResult = { ok: false, message: err instanceof Error ? err.message : String(err) };
        } finally {
            testing = false;
        }
    }

    function close() {
        if (testResult?.ok) showToast('success', 'Settings saved');
        onClose();
    }

    function applyPreset(preset: string) {
        setLlm({ preset, baseUrl: '', model: '' });
    }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') close(); }} />

<div
    class="overlay"
    onclick={(e) => { if (e.target === e.currentTarget) close(); }}
    role="presentation"
>
    <div
        bind:this={dialogEl}
        class="dialog fade-in"
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settings-modal"
    >
        <header class="head">
            <h2 id="settings-title">Settings</h2>
            <button type="button" class="btn btn-ghost" aria-label="Close" onclick={close}>
                <Icon name="close" size={16} />
            </button>
        </header>

        <div class="body">
            <aside class="tabs settings-rail" role="tablist" aria-label="Settings sections">
                <div class="rail-search">
                    <input
                        type="search"
                        placeholder="Search settings"
                        bind:value={settingsSearch}
                        data-testid="settings-search"
                        aria-label="Search settings"
                    />
                </div>
                {#if searchHits}
                    {#if searchHits.length === 0}
                        <p class="rail-empty muted small" data-testid="settings-search-empty">
                            No settings match “{settingsSearch}”.
                        </p>
                    {/if}
                    {#each searchHits as r (r.cat.id)}
                        <div class="rail-group">
                            <div class="rail-cat muted" data-testid={`settings-group-${r.cat.id}`}>{r.cat.label}</div>
                            {#each r.sections as s (s.id)}
                                <button
                                    type="button"
                                    role="tab"
                                    class="tab"
                                    class:active={activeSection === s.id}
                                    aria-selected={activeSection === s.id}
                                    onclick={() => selectSection(s)}
                                    data-testid={`settings-tab-${s.id}`}
                                >
                                    <Icon name={s.icon} size={15} />
                                    <span>{s.label}</span>
                                </button>
                            {/each}
                        </div>
                    {/each}
                {:else}
                    {#each visibleCategories as cat (cat.id)}
                        <div class="rail-group">
                            <div class="rail-cat muted" data-testid={`settings-group-${cat.id}`}>{cat.label}</div>
                            {#each cat.sections as s (s.id)}
                                <button
                                    type="button"
                                    role="tab"
                                    class="tab"
                                    class:active={activeSection === s.id}
                                    aria-selected={activeSection === s.id}
                                    onclick={() => selectSection(s)}
                                    data-testid={`settings-tab-${s.id}`}
                                >
                                    <Icon name={s.icon} size={15} />
                                    <span>{s.label}</span>
                                </button>
                            {/each}
                        </div>
                    {/each}
                {/if}
            </aside>

            <div class="panel">
                <!-- The rail is a flat wall of ~20 rows; without this the open
                     section loses its context the moment the dialog is wide. -->
                <nav class="crumb" aria-label="Settings location" data-testid="settings-breadcrumb">
                    <span class="crumb-group">{activeCategoryLabel}</span>
                    <!-- Decorative breadcrumb divider. Icon.svelte already sets
                         aria-hidden when no `title` is passed, which is the case
                         here — spelling it out anyway would be redundant, so
                         the real gap was the current page below. -->
                    <Icon name="chevronRight" size={12} />
                    <!-- aria-current marks which crumb is the page you're on.
                         Without it the two spans are an undifferentiated pair of
                         text and a screen reader announces "Account Mail, Mail,
                         Mail" with no idea the second one is where you are. The
                         tab panel it mirrors already says so via aria-selected
                         on the rail button; this is the same information for
                         the reading order. -->
                    <span class="crumb-here" aria-current="page">
                        {CATEGORIES.flatMap((c) => c.sections).find((s) => s.id === activeSection)?.label}
                    </span>
                </nav>
            {#if activeSection === 'account'}
                <section class="tab-section" data-testid="settings-account">
                    <div class="profile-card">
                        <button
                            type="button"
                            class="avatar-upload-btn"
                            onclick={pickMyAvatar}
                            title="Upload your own avatar (stored locally only)"
                            aria-label="Upload your avatar"
                        >
                            <Avatar email={authState.activeUser ?? null} name={mailboxInfo?.name ?? null} size={56} />
                            <span class="avatar-upload-overlay">
                                <Icon name="palette" size={13} />
                            </span>
                        </button>
                        <div class="profile-text">
                            <h3>{mailboxInfo?.name || authState.activeUser || 'Account'}</h3>
                            <p class="profile-email">{authState.activeUser || ''}</p>
                            {#if mailboxInfo}
                                <p class="muted small">
                                    {mailboxInfo.domain ? `${mailboxInfo.domain} · ` : ''}
                                    {mailboxInfo.messages.toLocaleString()} messages
                                    {#if mailboxInfo.created} · since {String(mailboxInfo.created).split(' ')[0]}{/if}
                                </p>
                            {/if}
                            {#if hasMyAvatar}
                                <button type="button" class="btn btn-ghost small" onclick={removeMyAvatarHandler}>
                                    <Icon name="trash" size={11} /> Remove custom avatar
                                </button>
                            {/if}
                        </div>
                    </div>

                    {#if mailboxInfo}
                        {@const unlimited = !mailboxInfo.quota || mailboxInfo.quota <= 0}
                        {@const used = mailboxInfo.quotaUsed || 0}
                        {@const pct = unlimited ? 0 : Math.min(100, mailboxInfo.percentInUse || 0)}
                        {@const lvl = unlimited ? 'ok' : fuelLevel(pct)}
                        <div class={`fuel-card lvl-${lvl}`} class:unlimited data-testid="storage-gauge">
                            <div class="fuel-head">
                                <h4><Icon name="inbox" size={14} /> Mailbox storage</h4>
                                <span class="fuel-pct">{unlimited ? '∞' : `${pct}%`}</span>
                            </div>
                            <div class="fuel-bar" aria-label={unlimited ? 'Unlimited storage' : `${pct}% used`}>
                                <span style={unlimited ? 'width: 100%' : `width: ${fuelArmed ? pct : 0}%`}></span>
                            </div>
                            <div class="fuel-stats">
                                <strong>{formatBytes(used)}</strong>
                                <span class="muted">{unlimited ? 'used · unlimited quota' : `of ${formatBytes(mailboxInfo.quota)}`}</span>
                                {#if !unlimited}
                                    <span class="muted dot">·</span>
                                    <span class="muted">{formatBytes(Math.max(0, mailboxInfo.quota - used))} free</span>
                                {/if}
                            </div>
                        </div>
                    {/if}

                    <!--
                        Rendered whenever the DB answered (aliases.length OR mailcowDbUnavailable) so the
                        collapsed state is reachable/announceable by tests and screen readers; the old
                        `{#if aliases.length}` wrapper only existed to hide an empty <ul>.
                    -->
                    {#if aliases.length || mailcowDbUnavailable}
                        <div class="card">
                            <button
                                type="button"
                                class="collapse-header"
                                onclick={() => showForwardingAliases = !showForwardingAliases}
                                aria-expanded={showForwardingAliases}
                                data-testid="forwarding-aliases-toggle"
                            >
                                <span>
                                    <Icon name="at" size={13} /> Forwarding to you
                                    <span class="count">{aliases.length}</span>
                                </span>
                                <Icon name={showForwardingAliases ? 'chevronUp' : 'chevronDown'} size={14} />
                            </button>
                            {#if showForwardingAliases}
                                <div class="collapse-body">
                                    {#if aliases.length}
                                        <p class="muted small">
                                            Aliases that deliver straight into this mailbox. Disabled ones still
                                            show below so you can spot what's been switched off.
                                        </p>
                                        <ul class="alias-chips" data-testid="alias-chips">
                                            {#each aliases as a (a.address)}
                                                <li class={`alias-chip ${a.active ? '' : 'inactive'}`}>
                                                    <span class="alias-chip-icon" aria-hidden="true">
                                                        <Icon name="at" size={11} />
                                                    </span>
                                                    <span class="alias-chip-addr truncate">{a.address}</span>
                                                    {#if !a.active}<span class="alias-chip-badge">inactive</span>{/if}
                                                </li>
                                            {/each}
                                        </ul>
                                    {:else if mailcowDbUnavailable}
                                        <p class="muted small" data-testid="forwarding-aliases-empty">
                                            Aliases can't be listed — the mailcow DB isn't reachable from this
                                            server. See the warning below.
                                        </p>
                                    {:else}
                                        <p class="muted small" data-testid="forwarding-aliases-empty">
                                            No forwarding aliases are pointed at this mailbox yet. Create one below.
                                        </p>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    {/if}

                    {#if mailcowDbUnavailable}
                        <div class="banner warn">
                            <Icon name="info" size={14} />
                            <span>Mailcow DB isn't configured (no <code>MAILCOW_DB_PASS</code>) — usage stats and aliases unavailable.</span>
                        </div>
                    {/if}

                    <div class="card">
                        <h4><Icon name="send" size={13} /> Default From address</h4>
                        <p class="muted small">
                            Used as the From for new messages. When you reply, the From auto-matches
                            whichever of your addresses received the original — this is just the
                            fallback when no match applies.
                        </p>
                        <input
                            type="email"
                            class="default-from"
                            placeholder={authState.activeUser || 'you@example.com'}
                            value={settings.defaultFromAddress}
                            oninput={(e) => setDefaultFromAddress((e.currentTarget as HTMLInputElement).value)}
                            data-testid="settings-default-from"
                        />
                    </div>

                    <div class="card">
                        <h4><Icon name="at" size={13} /> Disposable &amp; permanent aliases</h4>
                        <p class="muted small">
                            Spawn a fresh address that forwards to your inbox. Useful for one-shot signups
                            — kill the alias and the spam stops, no inbox rules required.
                        </p>
                        <div class="add-row">
                            <button
                                type="button"
                                class="btn btn-secondary"
                                disabled={creatingAlias}
                                onclick={() => newTempAlias(false, 168)}
                                data-testid="temp-alias-7d"
                            >+ 7-day</button>
                            <button
                                type="button"
                                class="btn btn-secondary"
                                disabled={creatingAlias}
                                onclick={() => newTempAlias(false, 720)}
                                data-testid="temp-alias-30d"
                            >+ 30-day</button>
                            <button
                                type="button"
                                class="btn btn-secondary"
                                disabled={creatingAlias}
                                onclick={() => newTempAlias(true, 8760)}
                                data-testid="temp-alias-permanent"
                            >+ Permanent</button>
                        </div>
                    </div>

                    {#if tempAliases.length}
                        <div class="card">
                            <h4>Active aliases <span class="count">{tempAliases.length}</span></h4>
                            <ul class="alias-rows" data-testid="temp-aliases-list">
                                {#each tempAliases as a (a.address)}
                                    <li>
                                        <span class="alias-addr truncate">{a.address}</span>
                                        <span class="muted small">
                                            {a.permanent ? 'permanent' :
                                                a.validity ? `expires ${formatFullDate(new Date(a.validity * 1000).toISOString())}` : ''}
                                        </span>
                                        <button
                                            type="button"
                                            class="btn btn-ghost"
                                            onclick={() => dropTempAlias(a.address)}
                                            aria-label={`Delete ${a.address}`}
                                        >
                                            <Icon name="trash" size={13} />
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        </div>
                    {/if}
                </section>

            {:else if activeSection === 'security'}
                <section class="tab-section" data-testid="settings-security">
                    <div class="card">
                        <h4><Icon name="key" size={13} /> This device</h4>
                        {#if authState.activeUser && isRemembered(authState.activeUser)}
                            <p class="muted small">
                                Credentials kept locally so this session renews silently before it expires.
                                The CalDAV calendar also relies on this — Sign out + back in if you turn it off.
                            </p>
                            <div class="card-actions">
                                <button
                                    type="button"
                                    class="btn btn-ghost"
                                    onclick={() => {
                                        forgetSavedCreds(authState.activeUser!);
                                        showToast('success', "Forgot credentials. You'll be signed out at session expiry.");
                                    }}
                                    data-testid="settings-forget-device"
                                ><Icon name="logout" size={13} /> Forget device</button>
                            </div>
                        {:else}
                            <p class="muted small">
                                Not enabled. Sign out and back in with "Stay signed in" checked to keep this device authorized
                                (also required for the calendar — SOGo needs your password).
                            </p>
                        {/if}
                    </div>

                    <div class="card">
                        <h4><Icon name="lock" size={13} /> Permanent sign-in</h4>
                        <p class="muted small">
                            When on, your session is saved to localStorage so you stay signed in across
                            browser restarts — even without the "Stay signed in" checkbox at login.
                            Uses the same encrypted credential vault plus a persistent session backup.
                        </p>
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Keep me signed in permanently</strong>
                                <span class="muted">Stores an extra session backup in localStorage with large cookie persistence.</span>
                            </div>
                            <label class="toggle compact">
                                <input
                                    type="checkbox"
                                    checked={settings.permanentSignIn}
                                    onchange={(e) => setPermanentSignIn((e.currentTarget as HTMLInputElement).checked)}
                                    data-testid="settings-permanent-signin"
                                />
                                <span>{settings.permanentSignIn ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                    </div>

                    {#if authState.sessions.length}
                        <div class="card">
                            <h4><Icon name="user" size={13} /> Signed-in accounts ({authState.sessions.length})</h4>
                            <ul class="session-list">
                                {#each authState.sessions as s (s.user)}
                                    <li>
                                        <Avatar email={s.user} size={28} />
                                        <div class="session-text">
                                            <span class="session-user">{s.user}</span>
                                            <span class="muted small" title={new Date(s.expiresAt).toLocaleString()}>
                                                {sessionStatus(s.expiresAt, s.user === authState.activeUser)}
                                            </span>
                                        </div>
                                        {#if s.user === authState.activeUser}
                                            <span class="active-pill"><Icon name="check" size={11} /> Active</span>
                                        {/if}
                                    </li>
                                {/each}
                            </ul>
                        </div>
                    {/if}

                    {#if !appPasswordsUnavailable}
                        <div class="card" data-testid="settings-agent-link">
                            <h4><Icon name="key" size={13} /> Agent access link</h4>
                            <p class="muted small">
                                A pasteable link that gives an agent (MCP client, script, CI job) access to
                                your mailbox for 24 hours — no mailbox password, no IP pinning. The token
                                rides in the URL fragment so it never reaches a server log.
                            </p>

                            {#if agentLink}
                                <div class="ap-token" data-testid="agent-link-token">
                                    <p class="small"><strong>Copy this now — it is not shown again.</strong></p>
                                    <div class="ap-token-row">
                                        <input class="ap-token-input" readonly value={agentLink} onclick={(e) => (e.currentTarget as HTMLInputElement).select()} />
                                        <button type="button" class="btn btn-secondary" onclick={copyAgentLink}>
                                            <Icon name={agentLinkCopied ? 'check' : 'copy'} size={12} />
                                            {agentLinkCopied ? 'Copied' : 'Copy'}
                                        </button>
                                    </div>
                                    <p class="muted small">
                                        Paste it to the agent — it reads the token after <code>#agent=</code>
                                        and uses it as a bearer credential. Expires in 24 h.
                                    </p>
                                    <button type="button" class="btn btn-ghost" onclick={() => { agentLink = null; }}>Done</button>
                                </div>
                            {/if}

                            {#if appPasswords.length}
                                <ul class="ap-rows">
                                    {#each appPasswords as ap (ap.id)}
                                        <li class="ap-row" data-testid="app-password-row">
                                            <div class="ap-main">
                                                <span class="ap-label">{ap.label}</span>
                                                <span class="ap-ranges">{ap.ipRanges.join(', ')}</span>
                                            </div>
                                            <div class="ap-meta muted small">
                                                {#if ap.lastUsedAt}
                                                    Last used {formatFullDate(new Date(ap.lastUsedAt).toISOString())}{ap.lastUsedIp ? ` from ${ap.lastUsedIp}` : ''}
                                                {:else}
                                                    Never used
                                                {/if}
                                                {#if ap.expiresAt}
                                                    · expires {formatFullDate(new Date(ap.expiresAt).toISOString())}
                                                {/if}
                                            </div>
                                            <button
                                                type="button"
                                                class="btn ap-revoke"
                                                onclick={() => removeAppPassword(ap.id, ap.label)}
                                            >Revoke</button>
                                        </li>
                                    {/each}
                                </ul>
                            {:else}
                                <p class="muted small">No active links.</p>
                            {/if}

                            <button
                                type="button"
                                class="btn btn-primary"
                                disabled={agentLinkBusy}
                                onclick={createAgentLink}
                                data-testid="create-agent-link"
                            >{agentLinkBusy ? 'Creating…' : 'Create 24-hour agent link'}</button>
                        </div>
                    {/if}

                    {#if !webhooksUnavailable}
                        <div class="card" data-testid="settings-webhook-inboxes">
                            <h4><Icon name="inbox" size={13} /> Webhook inboxes</h4>
                            <p class="muted small">
                                Give a service a URL — anything it POSTs lands in your INBOX as an email.
                                Optional <code>?subject=</code> or <code>X-Webhook-Subject</code> sets the subject.
                            </p>

                            {#if whNewUrl}
                                <div class="ap-token" data-testid="webhook-inbox-url">
                                    <p class="small"><strong>Copy this now — it is not shown again.</strong></p>
                                    <div class="ap-token-row">
                                        <input class="ap-token-input" readonly value={whNewUrl} onclick={(e) => (e.currentTarget as HTMLInputElement).select()} />
                                        <button type="button" class="btn btn-secondary" onclick={copyWebhookUrl}>
                                            <Icon name={whUrlCopied ? 'check' : 'copy'} size={12} />
                                            {whUrlCopied ? 'Copied' : 'Copy'}
                                        </button>
                                    </div>
                                    <p class="muted small">POST any body to it — JSON, form data, plain text.</p>
                                    <button type="button" class="btn btn-ghost" onclick={() => { whNewUrl = null; }}>Done</button>
                                </div>
                            {/if}

                            {#if webhookInboxes.length}
                                <ul class="ap-rows">
                                    {#each webhookInboxes as wh (wh.id)}
                                        <li class="ap-row" data-testid="webhook-inbox-row">
                                            <div class="ap-main">
                                                <span class="ap-label">{wh.label}</span>
                                            </div>
                                            <div class="ap-meta muted small">
                                                {#if wh.lastUsedAt}
                                                    Last delivery {formatFullDate(new Date(wh.lastUsedAt).toISOString())}
                                                {:else}
                                                    Never used
                                                {/if}
                                            </div>
                                            <button
                                                type="button"
                                                class="btn ap-revoke"
                                                onclick={() => removeWebhookInbox(wh.id, wh.label)}
                                            >Revoke</button>
                                        </li>
                                    {/each}
                                </ul>
                            {:else}
                                <p class="muted small">No webhook inboxes yet.</p>
                            {/if}

                            {#if webhookLimit && webhookInboxes.length >= webhookLimit}
                                <p class="muted small">You have reached the limit of {webhookLimit}. Revoke one to create another.</p>
                            {:else}
                                <div class="ap-form">
                                    <label class="ap-field">
                                        <span class="small">Name</span>
                                        <input bind:value={whLabel} placeholder="Uptime monitor" maxlength="100" data-testid="webhook-inbox-label" />
                                    </label>
                                    {#if whError}<p class="ap-error small">{whError}</p>{/if}
                                    <button
                                        type="button"
                                        class="btn btn-primary"
                                        disabled={whCreating}
                                        onclick={submitWebhookInbox}
                                        data-testid="create-webhook-inbox"
                                    >{whCreating ? 'Creating…' : 'Create webhook inbox'}</button>
                                </div>
                            {/if}
                        </div>
                    {/if}

                    {#if logins.length}
                        <div class="card">
                            <h4><Icon name="clock" size={13} /> Recent logins</h4>
                            <p class="muted small">Connections made by this account in the last few days.</p>
                            <ul class="login-rows">
                                {#each logins.slice(0, 10) as l, i (i)}
                                    {@const ip = (l.ip || l.real_rip || '') as string}
                                    {@const time = (l.time || l.datetime || '') as string}
                                    {@const priv = isPrivateIp(ip)}
                                    {@const ok = l.success === undefined ? true : !!l.success}
                                    {@const code = ip in geoipCache.codes ? geoipCache.codes[ip] : null}
                                    {@const flag = flagEmoji(code)}
                                    <li class={`login-row ${ok ? 'ok' : 'fail'}`} data-testid="login-row">
                                        <span class={`status-dot ${ok ? 'ok' : 'fail'}`} aria-hidden="true"></span>
                                        <span class="login-svc"><Icon name={serviceIcon(l.service)} size={12} /> {l.service || '?'}</span>
                                        <span class="login-time">{time ? formatFullDate(String(time)) : '—'}</span>
                                        <span class="login-ip" title={priv ? 'LAN / container IP — exact value hidden' : (code ? `${ip} · ${code}` : ip || '')}>
                                            {#if priv}
                                                <Icon name="wifi" size={11} />
                                            {:else if flag}
                                                <span class="login-flag" aria-label={code || ''}>{flag}</span>
                                            {:else}
                                                <Icon name="globe" size={11} />
                                            {/if}
                                            {#if priv}
                                                <span class="ip-text muted">unknown</span>
                                            {:else}
                                                <span class="ip-text">{ip || '?'}</span>
                                                {#if ip}
                                                    <button
                                                        type="button"
                                                        class="ip-copy"
                                                        aria-label="Copy IP"
                                                        onclick={() => copyIp(ip)}
                                                    ><Icon name={copiedIp === ip ? 'check' : 'copy'} size={11} /></button>
                                                {/if}
                                            {/if}
                                        </span>
                                        <span class="badges">
                                            {#if priv}<span class="badge int">internal</span>{/if}
                                            {#if l.app_password}<span class="badge"><Icon name="key" size={10} /> app pw</span>{/if}
                                            {#if !ok}<span class="badge danger">failed</span>{/if}
                                        </span>
                                    </li>
                                {/each}
                            </ul>
                        </div>
                    {/if}
                </section>

            {:else if activeSection === 'privacy'}
                <section class="tab-section" data-testid="settings-privacy">
                    <h3>Privacy</h3>
                    <p class="muted small">Image loading and tracker behaviour. AI scam scan &amp; spam settings live in their own tab.</p>

                    <div class="card">
                        <h4><Icon name="eye" size={13} /> Image handling</h4>

                        <!-- The state line describes what THIS profile is
                             actually doing. There is no blocking state any
                             more, so there is nothing to derive but the one
                             setting that remains — and the copy is written to
                             be true in BOTH of its branches, including the
                             honest limit of what proxying hides. See
                             privacy-facts.ts for the citable version of the
                             same claim. -->
                        <p class="muted small privacy-state" data-testid="privacy-image-state">
                            <Icon name={imagesProxied ? 'shield' : 'info'} size={12} />
                            {#if imagesProxied}
                                Remote images <strong>always load</strong>, and are fetched
                                through <code>/v1/proxy/image</code> so the sender’s CDN
                                never sees your IP address, user-agent, or connection time.
                            {:else}
                                Remote images <strong>always load</strong>, but this browser
                                fetches them <strong>directly from the sender</strong>, which
                                does see your IP address. Turn the proxy back on below.
                            {/if}
                        </p>

                        <!-- What the proxy does NOT hide, stated here rather
                             than left to be assumed. A tracking pixel still
                             reaches the sender's host through us and still
                             records that this mailbox opened this message,
                             when; the proxy also caches the response for 24h
                             (src/routes/image-proxy.js:193), widening that
                             window rather than narrowing it. Overstating
                             this is precisely how a privacy panel starts
                             lying. -->
                        <p class="muted small">
                            Be clear about what that does and does not achieve: it hides
                            <em>who</em> fetched an image, not <em>that you read the message</em>.
                            The sender still records the open, and can often tell it came from
                            us rather than from you. Images are also cached on our server for
                            24 hours, and fetches are subject to a daily cap.
                        </p>

                        <div class="form-row">
                            <div class="row-text">
                                <strong>Load images through the privacy proxy</strong>
                                <span class="muted">
                                    Recommended. On = your browser never contacts the sender’s image
                                    host directly. Off = images still load, but from your own
                                    connection, which gives away your IP address.
                                </span>
                            </div>
                            <label class="toggle compact" class:spy-on={settings.proxyImages}>
                                <input
                                    type="checkbox"
                                    checked={settings.proxyImages}
                                    onchange={(e) => setProxyImages((e.currentTarget as HTMLInputElement).checked)}
                                    data-testid="settings-proxy-images"
                                />
                                <span>{settings.proxyImages ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                    </div>

                    <!-- What the AI can see.

                         Every claim below lives in lib/privacy-facts.ts next to
                         the code it was verified against, and the copy branches
                         on how this account actually reaches its model: through
                         our own proxy (where the server scrubs a second time) or
                         straight to a provider (where it cannot). The copy is
                         deliberately candid about that difference — telling a
                         direct-to-provider user they get server-side
                         redaction would be false, and a privacy panel that
                         lies is worse than none. -->
                    <div class="card" data-testid="settings-ai-privacy">
                        <h4><Icon name="sparkles" size={13} /> What the AI can see</h4>
                        <p class="muted small">
                            {#if settings.aiFeatures}
                                Your AI features send real parts of your mail to a language model, so
                                it is worth being precise about what. Right now they reach
                                <strong>{aiPrivacy.destination}</strong>.
                            {:else}
                                AI features are off, so nothing from your mail is being sent
                                anywhere. The list below is what would leave the browser if you
                                turned them back on — they would reach
                                <strong>{aiPrivacy.destination}</strong>.
                            {/if}
                        </p>
                        <ul class="privacy-facts">
                            {#each aiPrivacy.facts as fact (fact.id)}
                                <li>
                                    <Icon name="check" size={12} />
                                    <span>
                                        {fact.claim}
                                        <code class="privacy-cite" title="Verified against {fact.source}">{fact.source}</code>
                                    </span>
                                </li>
                            {/each}
                        </ul>
                        <p class="muted small privacy-footnote">
                            Redaction is pattern-matching, not a guarantee: it removes the shapes
                            credentials actually take, so a secret in an unusual format can still
                            get through. Treat anything sensitive the same way you would treat a
                            message you forwarded to a stranger.
                        </p>
                    </div>

                </section>

            {:else if activeSection === 'junk'}
                <section class="tab-section" data-testid="settings-phishing">
                    <h3>AI scam scan &amp; spam</h3>
                    <p class="muted small">Pre-flight AI scans that flag scams and junk mail when you open a message.</p>

                    <div class="card">
                        <h4><Icon name="shieldAlert" size={13} /> AI scam scan &amp; spam</h4>
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>AI scam scan: check every email for scams &amp; spam</strong>
                                <span class="muted">
                                    When opening a message, the AI inspects the subject, sender, headers,
                                    and body for scam red flags (phishing, lookalikes, urgency tactics) as
                                    well as bulk-mail/spam patterns. Results are cached for 7 days. Scams
                                    show a purple top-of-email bubble; spam shows an amber "Move to Spam"
                                    suggestion below.
                                </span>
                            </div>
                            <label class="toggle compact">
                                <input
                                    type="checkbox"
                                    checked={settings.phishingScan}
                                    onchange={(e) => setPhishingScan((e.currentTarget as HTMLInputElement).checked)}
                                    data-testid="settings-phishing-scan"
                                />
                                <span>{settings.phishingScan ? 'On' : 'Off'}</span>
                            </label>
                        </div>

                        {#if settings.phishingScan}
                            <div class="phish-knobs">
                                <label class="field">
                                    <span class="lbl">
                                        Max scan time
                                        <strong class="lbl-val">{settings.phishingScanTimeoutSec}s</strong>
                                    </span>
                                    <input
                                        type="range"
                                        min="2" max="30" step="1"
                                        value={settings.phishingScanTimeoutSec}
                                        oninput={(e) => setPhishingScanTimeoutSec(Number((e.currentTarget as HTMLInputElement).value))}
                                        data-testid="settings-phishing-timeout"
                                    />
                                    <span class="muted small">Bail on the LLM call after this many seconds. Faster = more false-negatives; slower = more cost.</span>
                                </label>

                                <label class="field">
                                    <span class="lbl">
                                        Confidence floor for warning
                                        <strong class="lbl-val">{Math.round(settings.phishingScanConfidenceFloor * 100)}%</strong>
                                    </span>
                                    <input
                                        type="range"
                                        min="0.3" max="0.95" step="0.05"
                                        value={settings.phishingScanConfidenceFloor}
                                        oninput={(e) => setPhishingScanConfidenceFloor(Number((e.currentTarget as HTMLInputElement).value))}
                                        data-testid="settings-phishing-floor"
                                    />
                                    <span class="muted small">Below this, we don't trip the smoke effect or block the email — keeps the noise down.</span>
                                </label>

                                <label class="field">
                                    <span class="lbl">Extra prompt instructions</span>
                                    <textarea
                                        rows="3"
                                        maxlength="500"
                                        placeholder="e.g. I'm a security researcher, lean strict on financial-services lookalikes."
                                        value={settings.phishingScanPromptAddendum}
                                        oninput={(e) => setPhishingScanPromptAddendum((e.currentTarget as HTMLTextAreaElement).value)}
                                        data-testid="settings-phishing-prompt"
                                    ></textarea>
                                    <span class="muted small">Prepended to the system prompt sent to the AI. Up to 500 chars.</span>
                                </label>

                                <div class="form-row" style="padding:0;border:none;background:none;margin-top:8px;">
                                    <div class="row-text">
                                        <strong>OCR inline body images (enhanced scan)</strong>
                                        <span class="muted">
                                            When the message has remote or data-URL images, OCR them
                                            locally via tesseract.js and feed the extracted text into
                                            the scan. Catches phishers who hide their copy in images
                                            to evade text-based filters.
                                            {#if !settings.tesseractOcrInstalled}
                                                <em>Enable the OCR engine above first.</em>
                                            {/if}
                                        </span>
                                    </div>
                                    <label class="toggle compact">
                                        <input
                                            type="checkbox"
                                            checked={settings.phishingScanOcrInline}
                                            disabled={!settings.tesseractOcrInstalled}
                                            onchange={(e) => setPhishingScanOcrInline((e.currentTarget as HTMLInputElement).checked)}
                                            data-testid="settings-phishing-ocr-inline"
                                        />
                                        <span>{settings.phishingScanOcrInline ? 'On' : 'Off'}</span>
                                    </label>
                                </div>

                                <div class="form-row" style="padding:0;border:none;background:none;margin-top:10px;">
                                    <div class="row-text">
                                        <strong>Suggest moving spam to Spam folder</strong>
                                        <span class="muted">
                                            The same scan also classifies bulk/marketing slop. When it
                                            spots spam, we offer a one-click "Move to Spam" prompt
                                            below the message header. No extra LLM cost.
                                        </span>
                                    </div>
                                    <label class="toggle compact">
                                        <input
                                            type="checkbox"
                                            checked={settings.spamSuggest}
                                            onchange={(e) => setSpamSuggest((e.currentTarget as HTMLInputElement).checked)}
                                            data-testid="settings-spam-suggest"
                                        />
                                        <span>{settings.spamSuggest ? 'On' : 'Off'}</span>
                                    </label>
                                </div>

                                {#if settings.spamSuggest}
                                    <label class="field">
                                        <span class="lbl">
                                            Spam confidence floor
                                            <strong class="lbl-val">{Math.round(settings.spamSuggestConfidenceFloor * 100)}%</strong>
                                        </span>
                                        <input
                                            type="range"
                                            min="0.3" max="0.95" step="0.05"
                                            value={settings.spamSuggestConfidenceFloor}
                                            oninput={(e) => setSpamSuggestConfidenceFloor(Number((e.currentTarget as HTMLInputElement).value))}
                                            data-testid="settings-spam-floor"
                                        />
                                        <span class="muted small">Below this, we don't surface the spam prompt — keeps the noise down for borderline newsletters.</span>
                                    </label>

                                {/if}

                            </div>
                        {/if}
                    </div>

                    <div class="card">
                        <h4><Icon name="eye" size={13} /> Local OCR engine (tesseract.js)</h4>
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Install + warm up tesseract.js</strong>
                                <span class="muted">
                                    Bundles the in-browser OCR engine (~3 MB WASM core + a one-off
                                    ~12 MB English language download cached in IndexedDB). Once on,
                                    the phishing scan can OCR inline images locally —
                                    image bytes never leave your browser.
                                </span>
                            </div>
                            <label class="toggle compact">
                                <input
                                    type="checkbox"
                                    checked={settings.tesseractOcrInstalled}
                                    onchange={async (e) => {
                                        const on = (e.currentTarget as HTMLInputElement).checked;
                                        setTesseractOcrInstalled(on);
                                        if (on) {
                                            showToast('info', 'Downloading OCR engine + language data — first time only.');
                                            try {
                                                await warmupTesseract();
                                                showToast('success', 'OCR engine ready.');
                                            } catch {
                                                showToast('error', 'Could not initialise OCR engine.');
                                                setTesseractOcrInstalled(false);
                                            }
                                        } else {
                                            await teardownTesseract();
                                        }
                                    }}
                                    data-testid="settings-tesseract-install"
                                />
                                <span>{settings.tesseractOcrInstalled ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                    </div>

                    <!-- Link safety. Sits in the same section as the scam
                         scan because it is the same kind of thing: a
                         pre-flight check on a message before you act on it.
                         It is NOT a sub-toggle of the scan above — it has its
                         own switch and is independent of the scan toggle. It
                         IS subordinate to AI features, though:
                         linkCheckEnabled() requires settings.aiFeatures, so
                         turning AI off disables link checking too. That is
                         deliberate — the hard-off must not be circumvented by
                         a feature that still ships the URL somewhere — and it
                         is why the card reads as inert rather than claiming
                         to work. -->
                    <div class="card">
                        <h4><Icon name="shield" size={13} /> Link safety</h4>
                        {#if !settings.aiFeatures}
                            <p class="muted small" data-testid="settings-linkcheck-ai-off">
                                Unavailable while AI features are off. Link checking asks a
                                third party about the links you open, so it is treated the
                                same way as the other AI-adjacent features.
                            </p>
                        {:else}
                            {#if linkCheckProbed && !vtConfigured}
                                <p class="muted small" data-testid="settings-linkcheck-nokey">
                                    This server has no VirusTotal key configured, so nothing is
                                    being checked. Set <code>VIRUSTOTAL_API_KEY</code> on the
                                    server and restart it to turn this on. Until then links open
                                    normally, without a prompt.
                                </p>
                            {/if}
                            <div class="form-row" style="padding:0;border:none;background:none;">
                                <div class="row-text">
                                    <strong>Check links before opening them</strong>
                                    <span class="muted">
                                        Clicking a link in a message asks this server to look the
                                        destination up with VirusTotal first, and shows you the
                                        result before anything opens. The server holds the API key;
                                        the browser never sees it.
                                        <br /><br />
                                        <strong>What this gives up:</strong> every link you click is
                                        sent to VirusTotal. That is a privacy leak of its own — if
                                        the message is hostile, a link unique to you turns into a
                                        record that you opened it, held by a third party. It is the
                                        same trade the image proxy makes, pointed at a different host.
                                        <br /><br />
                                        <strong>What it does not give you:</strong> a clean result is
                                        not a guarantee. It means nobody has objected to that exact
                                        link yet, and a link can be flagged after you have already
                                        opened it. Links nobody has ever scanned report as unchecked,
                                        never as safe. Turning AI features off switches this off too.
                                    </span>
                                </div>
                                <label class="toggle compact">
                                    <input
                                        type="checkbox"
                                        checked={settings.linkSafetyCheck}
                                        disabled={!settings.aiFeatures}
                                        onchange={(e) => setLinkSafetyCheck((e.currentTarget as HTMLInputElement).checked)}
                                        data-testid="settings-link-safety"
                                    />
                                    <span>{settings.linkSafetyCheck ? 'On' : 'Off'}</span>
                                </label>
                            </div>
                        {/if}
                    </div>

                    <div class="card">
                        <h4><Icon name="shield" size={13} /> Trusted senders</h4>
                        <div class="form-row" style="padding:0;border:none;background:none;flex-direction:column;align-items:stretch;gap:8px;">
                            <div class="row-text">
                                <strong>Skip the AI scan for people you trust</strong>
                                <span class="muted">
                                    Mail from any address or domain on this list opens straight away — no LLM
                                    call, no purple bubble, no token spend. Senders land here when you click
                                    "Trust this sender" on a scam-scan bubble or "Not spam" on a spam
                                    suggestion. Add or remove them by hand below.
                                </span>
                            </div>
                            <div style="display:flex;gap:8px;align-items:center;">
                                <input
                                    type="text"
                                    bind:value={trustedAddInput}
                                    placeholder="someone@example.com or example.com"
                                    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTrustedFromInput(); } }}
                                    style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);font-family:inherit;"
                                    data-testid="settings-trusted-input"
                                />
                                <button type="button" class="btn btn-secondary" onclick={addTrustedFromInput} data-testid="settings-trusted-add">Add</button>
                            </div>
                            {#if spamFeedback.trustedAddresses.length === 0 && spamFeedback.trustedDomains.length === 0}
                                <p class="muted small" style="margin:0;">No trusted senders yet.</p>
                            {:else}
                                {#if spamFeedback.trustedAddresses.length > 0}
                                    <div>
                                        <div class="muted small" style="margin-bottom:4px;">Addresses</div>
                                        <ul class="trusted-list" data-testid="settings-trusted-addresses">
                                            {#each spamFeedback.trustedAddresses as a (a)}
                                                <li>
                                                    <span class="truncate">{a}</span>
                                                    <button type="button" class="trusted-remove" aria-label={`Remove ${a}`} onclick={() => removeTrusted(a)}>
                                                        <Icon name="close" size={12} />
                                                    </button>
                                                </li>
                                            {/each}
                                        </ul>
                                    </div>
                                {/if}
                                {#if spamFeedback.trustedDomains.length > 0}
                                    <div>
                                        <div class="muted small" style="margin-bottom:4px;">Domains</div>
                                        <ul class="trusted-list" data-testid="settings-trusted-domains">
                                            {#each spamFeedback.trustedDomains as d (d)}
                                                <li>
                                                    <span class="truncate">{d}</span>
                                                    <button type="button" class="trusted-remove" aria-label={`Remove ${d}`} onclick={() => removeTrustedDomain(d)}>
                                                        <Icon name="close" size={12} />
                                                    </button>
                                                </li>
                                            {/each}
                                        </ul>
                                    </div>
                                {/if}
                            {/if}
                        </div>
                    </div>
                </section>

            {:else if activeSection === 'compose'}
                <section class="tab-section" data-testid="settings-compose">
                    <h3>Compose</h3>
                    <p class="muted small">Defaults applied to every new message you send.</p>

                    <div class="card">
                        <h4><Icon name="spy" size={13} /> Invisible Tracker</h4>
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Default new messages to tracked</strong>
                                <span class="muted">
                                    When on, the spy icon in Compose starts pre-enabled — every
                                    message you send will include an invisible 1×1 pixel that
                                    notifies you on first open. Per-message override still works.
                                </span>
                            </div>
                            <label class="toggle compact">
                                <input
                                    type="checkbox"
                                    checked={settings.trackOpensDefault}
                                    onchange={(e) => setTrackOpensDefault((e.currentTarget as HTMLInputElement).checked)}
                                    data-testid="settings-track-default"
                                />
                                <span>{settings.trackOpensDefault ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                    </div>

                    <div class="card">
                        <h4><Icon name="at" size={13} /> Default From address</h4>
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Address</strong>
                                <span class="muted">
                                    Picked first when composing a brand-new message (replies still
                                    auto-match the address you received on). Leave blank to use
                                    your account's primary address.
                                </span>
                            </div>
                            <input
                                type="email"
                                value={settings.defaultFromAddress}
                                placeholder={authState.activeUser || 'you@example.com'}
                                oninput={(e) => setDefaultFromAddress((e.currentTarget as HTMLInputElement).value.trim())}
                                style="min-width:220px;padding:6px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);font-family:inherit;"
                                data-testid="settings-default-from"
                            />
                        </div>
                    </div>

                    <div class="card">
                        <h4><Icon name="user" size={13} /> Display name</h4>
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Friendly name</strong>
                                <span class="muted">
                                    Shown to recipients next to your address — e.g.
                                    <code>Jane Smith &lt;jane@example.com&gt;</code>. Leave blank
                                    and we'll fall back to a Title-Cased version of the local
                                    part of your address so a bare email never goes out alone.
                                    Also editable inline in Compose.
                                </span>
                            </div>
                            <input
                                type="text"
                                value={settings.displayName}
                                placeholder={deriveNameFromAddress(settings.defaultFromAddress || authState.activeUser || '') || 'Your name'}
                                oninput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)}
                                style="min-width:220px;padding:6px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);font-family:inherit;"
                                data-testid="settings-display-name"
                            />
                        </div>
                    </div>
                </section>

            {:else if activeSection === 'filters'}
                <section class="tab-section" data-testid="settings-filters">
                    <h3>Filters &amp; blocks</h3>
                    <p class="muted small">Block / allow specific senders + recipients, manage server-side Sieve rules.</p>

                    <div class="filter-block">
                        <button
                            type="button"
                            class="collapse-header"
                            onclick={() => showBlockedSenders = !showBlockedSenders}
                            aria-expanded={showBlockedSenders}
                        >
                            <span>
                                <Icon name="shield" size={13} /> Blocked senders
                                <span class="count">{blocked.length}</span>
                            </span>
                            <Icon name={showBlockedSenders ? 'chevronUp' : 'chevronDown'} size={14} />
                        </button>
                        {#if showBlockedSenders}
                            <div class="collapse-body">
                                <div class="add-row">
                                    <input
                                        type="text"
                                        placeholder="someone@example.com or *@spam.example"
                                        bind:value={blockInput}
                                        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doBlock(); }}}
                                        data-testid="block-input"
                                    />
                                    <button type="button" class="btn btn-secondary" onclick={doBlock} data-testid="block-add">Block</button>
                                </div>
                                {#if blocked.length}
                                    <ul class="chip-list" data-testid="blocked-list">
                                        {#each blocked as p (p.prefid)}
                                            <li class="policy-chip">
                                                <span>{p.sender}</span>
                                                <button type="button" aria-label={`Unblock ${p.sender}`} onclick={() => doUnblock(p)}>
                                                    <Icon name="close" size={12} />
                                                </button>
                                            </li>
                                        {/each}
                                    </ul>
                                {/if}
                            </div>
                        {/if}
                    </div>

                    <div class="filter-block">
                        <button
                            type="button"
                            class="collapse-header"
                            onclick={() => showAllowedSenders = !showAllowedSenders}
                            aria-expanded={showAllowedSenders}
                        >
                            <span>
                                <Icon name="check" size={13} /> Allowed senders
                                <span class="count">{allowed.length}</span>
                            </span>
                            <Icon name={showAllowedSenders ? 'chevronUp' : 'chevronDown'} size={14} />
                        </button>
                        {#if showAllowedSenders}
                            <div class="collapse-body">
                                <div class="add-row">
                                    <input
                                        type="text"
                                        placeholder="newsletter@example.com"
                                        bind:value={allowInput}
                                        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doAllow(); }}}
                                        data-testid="allow-input"
                                    />
                                    <button type="button" class="btn btn-secondary" onclick={doAllow} data-testid="allow-add">Allow</button>
                                </div>
                                {#if allowed.length}
                                    <ul class="chip-list" data-testid="allowed-list">
                                        {#each allowed as p (p.prefid)}
                                            <li class="policy-chip allow">
                                                <span>{p.sender}</span>
                                                <button type="button" aria-label={`Remove ${p.sender}`} onclick={() => doUnallow(p)}>
                                                    <Icon name="close" size={12} />
                                                </button>
                                            </li>
                                        {/each}
                                    </ul>
                                {/if}
                            </div>
                        {/if}
                    </div>

                    <div class="filter-block">
                        <button
                            type="button"
                            class="collapse-header"
                            onclick={() => showBlockedRecipients = !showBlockedRecipients}
                            aria-expanded={showBlockedRecipients}
                        >
                            <span>
                                <Icon name="eyeOff" size={13} /> Blocked recipients
                                <span class="count">{blockedRecipients.length}</span>
                            </span>
                            <Icon name={showBlockedRecipients ? 'chevronUp' : 'chevronDown'} size={14} />
                        </button>
                        {#if showBlockedRecipients}
                            <div class="collapse-body">
                                <p class="muted small">
                                    Block addresses you receive at — useful for catch-all domains where spam targets
                                    a single dead address. Uses a Sieve script that rejects matching messages.
                                    You can only block addresses that route to your inbox (mailbox, alias, catch-all,
                                    or temp alias).
                                </p>
                                <div class="add-row">
                                    <input
                                        type="email"
                                        placeholder="dead-address@example.com"
                                        bind:value={blockRecipientInput}
                                        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doBlockRecipient(); }}}
                                        data-testid="block-recipient-input"
                                    />
                                    <button type="button" class="btn btn-secondary" onclick={doBlockRecipient} data-testid="block-recipient-add">Block</button>
                                </div>
                                {#if blockedRecipients.length}
                                    <ul class="chip-list" data-testid="blocked-recipients-list">
                                        {#each blockedRecipients as addr (addr)}
                                            <li class="policy-chip">
                                                <span>{addr}</span>
                                                <button type="button" aria-label={`Unblock ${addr}`} onclick={() => doUnblockRecipient(addr)}>
                                                    <Icon name="close" size={12} />
                                                </button>
                                            </li>
                                        {/each}
                                    </ul>
                                {/if}
                            </div>
                        {/if}
                    </div>

                </section>

            {:else if activeSection === 'mail-rules'}
                <section class="tab-section" data-testid="settings-mail-rules">
                    <h3>Mail rules</h3>
                    <p class="muted small">
                        Server-side Sieve rules — blocks, redirects, copies, auto-move into a
                        folder, and delivery to an outbound webhook.
                    </p>

                    {#if !mailRulesUnavailable}
                        <div class="filter-block" data-testid="mail-rules-block">
                            <button
                                type="button"
                                class="collapse-header"
                                onclick={() => showMailRules = !showMailRules}
                                aria-expanded={showMailRules}
                            >
                                <span>
                                    <Icon name="filter" size={13} /> Server-side rules
                                    <span class="count">{mailRules.length}</span>
                                </span>
                                <Icon name={showMailRules ? 'chevronUp' : 'chevronDown'} size={14} />
                            </button>
                            {#if showMailRules}
                                <div class="collapse-body">
                                    <p class="muted small">
                                        Unified blocks, redirects, and copies. A redirect forwards
                                        without keeping a copy; a copy forwards <em>and</em> keeps
                                        the message in your inbox. SOGo rules you've created
                                        elsewhere are preserved.
                                    </p>

                                    <div class="rule-form" data-testid="rule-form">
                                        <label class="rule-row">
                                            <span class="rule-label">When</span>
                                            <select bind:value={ruleConditionType} data-testid="rule-condition-type">
                                                {#each Object.keys(RULE_CONDITION_LABELS) as t (t)}
                                                    <option value={t}>{RULE_CONDITION_LABELS[t as MailRuleConditionType]}</option>
                                                {/each}
                                            </select>
                                        </label>
                                        {#if ruleHasHeader(ruleConditionType)}
                                            <label class="rule-row">
                                                <span class="rule-label">Header</span>
                                                <input
                                                    type="text"
                                                    placeholder="X-List-ID"
                                                    bind:value={ruleConditionHeader}
                                                    data-testid="rule-condition-header"
                                                />
                                            </label>
                                        {/if}
                                        <label class="rule-row">
                                            <span class="rule-label">Value</span>
                                            <input
                                                type="text"
                                                placeholder="example.com"
                                                bind:value={ruleConditionValue}
                                                data-testid="rule-condition-value"
                                            />
                                        </label>
                                        <label class="rule-row">
                                            <span class="rule-label">Then</span>
                                            <select bind:value={ruleActionType} data-testid="rule-action-type">
                                                {#each Object.keys(RULE_ACTION_LABELS) as t (t)}
                                                    <option value={t}>{RULE_ACTION_LABELS[t as MailRuleActionType]}</option>
                                                {/each}
                                            </select>
                                        </label>
                                        {#if ruleHasTarget(ruleActionType)}
                                            <label class="rule-row">
                                                <span class="rule-label">Forward to</span>
                                                <input
                                                    type="email"
                                                    placeholder="someone@elsewhere.example"
                                                    bind:value={ruleActionTo}
                                                    data-testid="rule-action-to"
                                                />
                                            </label>
                                        {/if}
                                        {#if ruleNeedsFolder(ruleActionType)}
                                            <label class="rule-row">
                                                <span class="rule-label">Folder</span>
                                                <input
                                                    type="text"
                                                    placeholder="Archive"
                                                    bind:value={ruleActionFolder}
                                                    data-testid="rule-action-folder"
                                                />
                                            </label>
                                        {/if}
                                        {#if ruleNeedsWebhook(ruleActionType)}
                                            {#if outboundHooks.length === 0}
                                                <p class="muted small">
                                                    No outbound webhooks yet — create one under
                                                    <em>Outbound webhooks</em> first.
                                                </p>
                                            {:else}
                                                <label class="rule-row">
                                                    <span class="rule-label">Webhook</span>
                                                    <select bind:value={ruleActionWebhookId} data-testid="rule-action-webhook">
                                                        {#each outboundHooks as w (w.id)}
                                                            <option value={w.id}>{w.label} — {w.url}</option>
                                                        {/each}
                                                    </select>
                                                </label>
                                            {/if}
                                        {/if}
                                        <div class="rule-actions">
                                            <button
                                                type="button"
                                                class="btn btn-primary"
                                                disabled={ruleSaving}
                                                onclick={doAddRule}
                                                data-testid="rule-add"
                                            >{ruleSaving ? 'Saving…' : 'Add rule'}</button>
                                        </div>
                                    </div>

                                    {#if mailRules.length}
                                        <ul class="rule-cards" data-testid="rule-list">
                                            {#each mailRules as r (r.id)}
                                                {@const cTxt = ruleHasHeader(r.condition.type)
                                                    ? `${r.condition.header || 'header'} ${r.condition.type === 'header-is' ? 'is' : 'contains'}`
                                                    : (RULE_CONDITION_LABELS[r.condition.type] || r.condition.type)}
                                                <li class={`rule-card rule-${r.action.type}`} data-testid={`rule-item-${r.id}`}>
                                                    <div class="rule-card-head">
                                                        <span class={`rule-badge rule-${r.action.type}`}>
                                                            {#if r.action.type === 'discard'}
                                                                <Icon name="trash" size={11} /> Block
                                                            {:else if r.action.type === 'redirect'}
                                                                <Icon name="send" size={11} /> Redirect
                                                            {:else if r.action.type === 'fileinto'}
                                                                <Icon name="inbox" size={11} /> Move
                                                            {:else if r.action.type === 'webhook'}
                                                                <Icon name="globe" size={11} /> Webhook
                                                            {:else}
                                                                <Icon name="reply" size={11} /> Copy
                                                            {/if}
                                                        </span>
                                                        <span class="rule-name truncate" title={r.name}>{r.name || '(unnamed rule)'}</span>
                                                        <button
                                                            type="button"
                                                            class="rule-remove"
                                                            aria-label={`Remove rule ${r.name}`}
                                                            title="Remove rule"
                                                            onclick={() => doRemoveRule(r.id)}
                                                            data-testid={`rule-remove-${r.id}`}
                                                        ><Icon name="trash" size={12} /></button>
                                                    </div>
                                                    <div class="rule-card-body">
                                                        <div class="rule-clause">
                                                            <span class="rule-when">When</span>
                                                            <span class="rule-cond">{cTxt}</span>
                                                            <code class="rule-val">{r.condition.value}</code>
                                                        </div>
                                                        <div class="rule-clause">
                                                            <span class="rule-when">Then</span>
                                                            {#if r.action.type === 'discard'}
                                                                <span class="rule-action-text">silently discard the message</span>
                                                            {:else if r.action.type === 'redirect'}
                                                                <span class="rule-action-text">forward to</span>
                                                                <code class="rule-val">{r.action.to}</code>
                                                                <span class="rule-action-text muted">— no copy kept</span>
                                                            {:else if r.action.type === 'fileinto'}
                                                                <span class="rule-action-text">move to folder</span>
                                                                <code class="rule-val">{r.action.folder}</code>
                                                            {:else if r.action.type === 'webhook'}
                                                                <span class="rule-action-text">send to webhook</span>
                                                                <code class="rule-val">{outboundHooks.find((w) => w.id === r.action.webhookId)?.label || r.action.webhookId}</code>
                                                            {:else}
                                                                <span class="rule-action-text">forward a copy to</span>
                                                                <code class="rule-val">{r.action.to}</code>
                                                                <span class="rule-action-text muted">— original stays in inbox</span>
                                                            {/if}
                                                        </div>
                                                    </div>
                                                </li>
                                            {/each}
                                        </ul>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    {/if}

                </section>

            {:else if activeSection === 'appearance'}
                <section class="tab-section">
                    <h3>Appearance</h3>
                    <p class="muted small">Window chrome, colour skin, and the accent palette.</p>

                <h4 class="section-head"><Icon name="monitor" size={13} /> Layout</h4>

                <div class="form-row">
                    <div class="row-text">
                        <strong>Top-right chip</strong>
                        <span class="muted">
                            What the account button at the top of the window shows — your full
                            name (with a person icon) or your email address (with an @ icon).
                        </span>
                    </div>
                    <div class="seg" role="radiogroup" aria-label="Account chip display">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={settings.accountChipDisplay === 'email'}
                            class:active={settings.accountChipDisplay === 'email'}
                            onclick={() => setAccountChipDisplay('email')}
                            data-testid="settings-chip-email"
                        >Email</button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={settings.accountChipDisplay === 'name'}
                            class:active={settings.accountChipDisplay === 'name'}
                            onclick={() => setAccountChipDisplay('name')}
                            data-testid="settings-chip-name"
                        >Name</button>
                    </div>
                </div>

                <div class="form-row">
                    <div class="row-text">
                        <strong>Weather chip in the top bar</strong>
                        <span class="muted">
                            The Outlook skin leaves the top bar clear to match the real
                            client's chrome, so the weather chip is hidden there by
                            default. Turn this on to keep it anyway. Other skins always
                            follow the general weather setting.
                        </span>
                    </div>
                    <label class="toggle compact">
                        <input
                            type="checkbox"
                            checked={settings.weatherChipOutlook}
                            onchange={(e) => setWeatherChipOutlook((e.currentTarget as HTMLInputElement).checked)}
                            data-testid="settings-weather-outlook"
                        />
                        <span>{settings.weatherChipOutlook ? 'On' : 'Off'}</span>
                    </label>
                </div>

                <h4 class="appearance-skin-title" data-testid="settings-skins">Accent &amp; skin</h4>
                <p class="muted small">
                    Pick a skin, then layer any accent colour you like over it.
                    Your dark/light theme keeps working — this only retints the palette.
                </p>
                <div class="skins-grid" role="radiogroup" aria-label="Skin">
                    {#each SKINS as s (s.id)}
                        <button
                            type="button"
                            role="radio"
                            class="skin-tile"
                            class:active={skinState.skinId === s.id}
                            aria-checked={skinState.skinId === s.id}
                            title={s.description}
                            onclick={() => setSkin(s.id)}
                            data-testid={`skin-${s.id}`}
                        >
                            <span class="swatch" style={`background:${s.swatch}`} aria-hidden="true"></span>
                            <span class="skin-meta">
                                <strong>{s.label}</strong>
                                <span class="muted small">{s.description}</span>
                            </span>
                        </button>
                    {/each}

                    <label class="skin-tile custom" class:active={skinState.accentOverride !== null}>
                        <span
                            class="swatch"
                            style={`background:${skinState.customAccent}`}
                            aria-hidden="true"
                        ></span>
                        <span class="skin-meta">
                            <strong>Accent colour</strong>
                            <span class="muted small">Layer any hue over this skin.</span>
                        </span>
                        <input
                            type="color"
                            value={skinState.customAccent}
                            oninput={(e) => setCustomAccent((e.currentTarget as HTMLInputElement).value)}
                            data-testid="skin-custom-input"
                            aria-label="Custom accent colour"
                        />
                    </label>
                </div>

                <!-- Shown once the user has either layered an accent or touched a
                     semantic colour: before that the chips would be noise. -->
                {#if skinState.accentOverride !== null || skinState.semanticsEdited}
                    <div class="semantic-colours" data-testid="semantic-colours">
                        <h4 class="appearance-skin-title">Semantic colours</h4>
                        <p class="muted small">Override the accent-derived defaults for errors, successes, warnings and stars.</p>
                        <div class="colour-row">
                            <label class="colour-chip">
                                <span class="swatch" style={`background:${skinState.semantics.danger}`}></span>
                                <span class="lbl">Danger</span>
                                <input
                                    type="color"
                                    value={skinState.semantics.danger}
                                    oninput={(e) => setSemantic({ danger: (e.currentTarget as HTMLInputElement).value })}
                                    aria-label="Danger colour"
                                />
                            </label>
                            <label class="colour-chip">
                                <span class="swatch" style={`background:${skinState.semantics.success}`}></span>
                                <span class="lbl">Success</span>
                                <input
                                    type="color"
                                    value={skinState.semantics.success}
                                    oninput={(e) => setSemantic({ success: (e.currentTarget as HTMLInputElement).value })}
                                    aria-label="Success colour"
                                />
                            </label>
                            <label class="colour-chip">
                                <span class="swatch" style={`background:${skinState.semantics.warning}`}></span>
                                <span class="lbl">Warning</span>
                                <input
                                    type="color"
                                    value={skinState.semantics.warning}
                                    oninput={(e) => setSemantic({ warning: (e.currentTarget as HTMLInputElement).value })}
                                    aria-label="Warning colour"
                                />
                            </label>
                            <label class="colour-chip">
                                <span class="swatch" style={`background:${skinState.semantics.star}`}></span>
                                <span class="lbl">Star</span>
                                <input
                                    type="color"
                                    value={skinState.semantics.star}
                                    oninput={(e) => setSemantic({ star: (e.currentTarget as HTMLInputElement).value })}
                                    aria-label="Star colour"
                                />
                            </label>
                        </div>
                        <button
                            type="button"
                            class="btn btn-ghost small"
                            onclick={resetSemantics}
                            data-testid="reset-semantic-colours"
                        >
                            <Icon name="refresh" size={12} /> Reset defaults
                        </button>
                    </div>
                {/if}

                <div class="card">
                    <h4><Icon name="palette" size={13} /> Custom CSS</h4>
                    <p class="muted small" style="margin-top:0;">
                        Drop in any CSS to nudge the look — selectors target the live SPA. Persists in your browser; up to 50 KB.
                    </p>
                    <textarea
                        rows="8"
                        spellcheck="false"
                        placeholder="/* e.g. :root accent override */"
                        value={skinState.customCss}
                        oninput={(e) => setCustomCss((e.currentTarget as HTMLTextAreaElement).value)}
                        style="width:100%;font-family:var(--font-mono);font-size:12.5px;padding:10px 12px;background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);color:var(--text-primary);resize:vertical;line-height:1.5;"
                        data-testid="settings-custom-css"
                    ></textarea>
                    {#if skinState.customCss}
                        <button
                            type="button"
                            class="btn btn-ghost"
                            onclick={() => setCustomCss('')}
                            style="margin-top:6px;"
                        >Clear</button>
                    {/if}
                </div>
                </section>

            {:else if activeSection === 'sounds'}
                <section class="tab-section" data-testid="settings-sounds">
                    <h3>Sounds</h3>
                    <p class="muted small">Per-event audio cues. Pick a preset for each, or set "Silent" to leave it off.</p>

                <div class="form-row">
                    <div class="row-text">
                        <strong>Sounds</strong>
                        <span class="muted">
                            Soft chime on new mail in the foreground, and a swoosh when a message sends.
                        </span>
                    </div>
                    <div class="sound-controls">
                        <button
                            type="button"
                            class="btn btn-ghost"
                            onclick={() => playNotify()}
                            disabled={sounds.muted}
                            title="Play sample"
                            data-testid="settings-sound-preview"
                        >
                            <Icon name="info" size={13} /> Test
                        </button>
                        <label class="toggle compact">
                            <input
                                type="checkbox"
                                checked={!sounds.muted}
                                onchange={(e) => setMuted(!(e.currentTarget as HTMLInputElement).checked)}
                                data-testid="settings-sound-toggle"
                            />
                            <span>{sounds.muted ? 'Off' : 'On'}</span>
                        </label>
                    </div>
                </div>

                    <div class="card">
                        <h4><Icon name="bell" size={13} /> Per-event sounds</h4>
                        <p class="muted small" style="margin-top:0;">
                            Two knockoff families, grouped. Outlook is restrained and stays out of
                            your way; Gmail is warmer and more percussive, so it gets noticed.
                            Both are approximations, not recordings — the webmail ships no audio
                            files. Picking a pack also plays it.
                        </p>
                        <ul class="sound-rows">
                            {#each SOUND_EVENTS as ev (ev.id)}
                                <li class="sound-row">
                                    <div class="sound-meta">
                                        <strong>{ev.label}</strong>
                                        <span class="muted small">{ev.description}</span>
                                    </div>
                                    <!-- SOUND_STYLES/packsInStyle, not a literal
                                         list: this used to hardcode the four original
                                         ids, so 'ting' and 'blip' existed in the
                                         module and in the stored profile but could
                                         never be picked here. Grouping is PRESENTATION
                                         ONLY — every pack stays visible and
                                         reachable at once rather than hiding behind
                                         a style selector, because a style switch
                                         would strand a profile that already mixes
                                         families (and would have made the newest
                                         packs unreachable by default). -->
                                    <div class="sound-groups">
                                        {#each SOUND_STYLES as styleDef (styleDef.id)}
                                            {@const group = packsInStyle(styleDef.id)}
                                            {#if group.length}
                                                <div class="sound-group">
                                                    <span class="sound-group-lbl" title={styleDef.blurb}>
                                                        {styleDef.label}
                                                    </span>
                                                    <div
                                                        class="sound-pills"
                                                        role="radiogroup"
                                                        aria-label={`${ev.label} — ${styleDef.label}`}
                                                        data-testid={`settings-sound-${ev.id}-group-${styleDef.id}`}
                                                    >
                                                        {#each group as pack (pack.id)}
                                                            <button
                                                                type="button"
                                                                role="radio"
                                                                class="sound-pill"
                                                                class:active={sounds.profile[ev.id] === pack.id}
                                                                aria-checked={sounds.profile[ev.id] === pack.id}
                                                                title={pack.blurb}
                                                                onclick={() => { setEventPack(ev.id, pack.id); previewPack(pack.id); }}
                                                                data-testid={`settings-sound-${ev.id}-${pack.id}`}
                                                            >{pack.label}</button>
                                                        {/each}
                                                    </div>
                                                </div>
                                            {/if}
                                        {/each}
                                    </div>
                                </li>
                            {/each}
                        </ul>
                        <button
                            type="button"
                            class="btn btn-ghost"
                            onclick={resetSoundProfile}
                            style="margin-top:8px;"
                        ><Icon name="refresh" size={12} /> Reset defaults</button>
                    </div>
                </section>

            {:else if activeSection === 'ai'}
                <section class="tab-section">
                    <!-- Hard-off state is stated first and plainly.
                         Reasoning: the rest of this section configures a
                         provider, and someone who has switched AI off does
                         not want to be reasoning about presets and API
                         keys. What they need is (a) to know the app is
                         in that state and (b) one obvious way back.

                         The provider controls below deliberately STAY
                         rendered when AI is off: they are harmless, they
                         preserve the configuration the user set up, and
                         hiding them would turn "turn AI back on" into a
                         scavenger hunt. For the same reason this section
                         is never hidden — it is the only route back to
                         the master switch. -->
                    {#if !settings.aiFeatures}
                        <div class="banner warn" data-testid="ai-hard-off-notice">
                            <Icon name="info" size={14} />
                            <span>
                                AI is off. The AI tab, chat bot, AI panel, voice chat, AI sort,
                                inbox briefing and every AI suggestion are hidden, and nothing is
                                sent to any model.
                            </span>
                        </div>
                    {:else}
                        <h3>AI provider</h3>
                        <p class="muted small">
                            Powers the chat bot, "Add to calendar", and (if the server has its own key) Summarize/Draft/Translate.
                            Your key stays in this browser; the chat bot calls the provider directly.
                        </p>
                    {/if}

                    <!-- Master switch, stated as STATE not as an action.

                         It used to be a bare checkbox labelled "Turn off
                         all AI features" with `checked={aiFeatures}` — so
                         with AI on, the box was ticked AND the text read
                         as an instruction to untick it. Two sentences
                         disagreeing on screen, on the one control that
                         governs every other AI surface.

                         Now it matches the convention the rest of this
                         panel uses (see proxyImages at ~L1906 and every
                         other `.toggle.compact`): the label names the
                         subject, the pill states On/Off. The consequence
                         lives in the sub-line, where it can be two
                         sentences long without fighting the control. -->
                    <div class="form-row ai-master-row">
                        <div class="row-text">
                            <strong>AI features</strong>
                            <span class="muted">
                                Master switch for every AI surface. Off hides the AI tab, chat bot,
                                AI panel, voice chat, AI sort, inbox briefing, reply suggestions
                                and every other AI entry point — nothing is sent to a model. Your
                                provider settings below are kept, so turning it back on needs no
                                reconfiguration.
                            </span>
                        </div>
                        <label class="toggle compact">
                            <input
                                type="checkbox"
                                checked={settings.aiFeatures}
                                onchange={(e) => setAiFeatures((e.currentTarget as HTMLInputElement).checked)}
                                data-testid="settings-ai-features"
                            />
                            <span>{settings.aiFeatures ? 'On' : 'Off'}</span>
                        </label>
                    </div>

                    <!-- Server-side assistant takeover. Deliberately NOT
                         gated on the client AI switch above: it runs on the
                         server and would keep drafting if this browser's AI
                         were off, so hiding it here would leave a server-side
                         actor with no off switch. Every draft stops at the
                         same approval email as any API send — nothing is
                         ever sent on the assistant's own say-so. -->
                    <div class="card" data-testid="settings-takeover">
                        <h4><Icon name="sparkles" size={13} /> AI assistant takeover</h4>
                        {#if takeover.unavailable}
                            <p class="muted small">Not available on this server.</p>
                        {:else}
                            {#if !settings.aiFeatures && takeover.status?.enabled}
                                <div class="banner warn" data-testid="takeover-ai-off-warning">
                                    <Icon name="info" size={14} />
                                    <span>
                                        AI is off in this browser, but this server-side assistant is
                                        still drafting replies. Turn it off below if that is not what
                                        you want.
                                    </span>
                                </div>
                            {/if}
                            <div class="form-row" style="padding:0;border:none;background:none;">
                                <div class="row-text">
                                    <strong>Let the assistant draft replies</strong>
                                    <span class="muted">
                                        The assistant looks at unread mail that seems to need a reply,
                                        drafts in your voice, and stops for your approval — it never
                                        sends on its own. Each draft waits for your approval and
                                        expires if you do not decide within an hour. Replies it sends
                                        are signed "This reply came from my AI assistant."
                                    </span>
                                </div>
                                <label class="toggle compact">
                                    <input
                                        type="checkbox"
                                        checked={takeover.status?.enabled ?? false}
                                        disabled={takeover.busy}
                                        onchange={(e) => onTakeoverEnabled((e.currentTarget as HTMLInputElement).checked)}
                                        data-testid="settings-takeover-enabled"
                                    />
                                    <span>{takeover.status?.enabled ? 'On' : 'Off'}</span>
                                </label>
                            </div>
                            <div class="form-row" style="padding:0;border:none;background:none;">
                                <div class="row-text">
                                    <strong>Replies per hour (max)</strong>
                                    <span class="muted">
                                        Hard cap, enforced on the server. 0 pauses drafting completely.
                                    </span>
                                </div>
                                <input
                                    type="number"
                                    min="0"
                                    max="24"
                                    step="1"
                                    value={takeover.status?.maxRepliesPerHour ?? 1}
                                    disabled={takeover.busy}
                                    onchange={(e) => onTakeoverNumber('maxRepliesPerHour', (e.currentTarget as HTMLInputElement).value, 0, 24)}
                                    data-testid="settings-takeover-rate"
                                />
                            </div>
                            <div class="form-row" style="padding:0;border:none;background:none;">
                                <div class="row-text">
                                    <strong>Minimum delay (minutes)</strong>
                                    <span class="muted">
                                        Wait at least this long before a draft is submitted for
                                        approval. Hard floor of 5 — the delay rides on top of your
                                        approval, never instead of it.
                                    </span>
                                </div>
                                <input
                                    type="number"
                                    min="5"
                                    max="1440"
                                    step="1"
                                    value={takeover.status?.minDelayMinutes ?? 5}
                                    disabled={takeover.busy}
                                    onchange={(e) => onTakeoverNumber('minDelayMinutes', (e.currentTarget as HTMLInputElement).value, 5, 1440)}
                                    data-testid="settings-takeover-delay"
                                />
                            </div>
                            <div class="form-row" style="padding:0;border:none;background:none;">
                                <div class="row-text">
                                    <strong>Look-back (hours)</strong>
                                    <span class="muted">
                                        How far back to look for unanswered mail.
                                    </span>
                                </div>
                                <input
                                    type="number"
                                    min="1"
                                    max="720"
                                    step="1"
                                    value={takeover.status?.lookbackHours ?? 24}
                                    disabled={takeover.busy}
                                    onchange={(e) => onTakeoverNumber('lookbackHours', (e.currentTarget as HTMLInputElement).value, 1, 720)}
                                    data-testid="settings-takeover-lookback"
                                />
                            </div>
                            <div class="form-row" style="padding:0;border:none;background:none;">
                                <div class="row-text">
                                    <strong>Consider attachments</strong>
                                    <span class="muted">
                                        Read attachments when deciding whether a reply is needed.
                                    </span>
                                </div>
                                <label class="toggle compact">
                                    <input
                                        type="checkbox"
                                        checked={takeover.status?.considerAttachments ?? false}
                                        disabled={takeover.busy}
                                        onchange={(e) => onTakeoverAttachments((e.currentTarget as HTMLInputElement).checked)}
                                        data-testid="settings-takeover-attachments"
                                    />
                                    <span>{takeover.status?.considerAttachments ? 'On' : 'Off'}</span>
                                </label>
                            </div>
                        {/if}
                    </div>

                {#if capabilities.caps && !capabilities.caps.configured}
                    <div class="banner warn">
                        <Icon name="info" size={14} />
                        <span>
                            Server has no LLM configured. The chat bot and Add-to-calendar still work
                            (they talk to your provider directly); the email AI panel buttons won't.
                        </span>
                    </div>
                {:else if capabilities.caps?.configured}
                    <div class="banner ok">
                        <Icon name="info" size={14} />
                        <span>
                            Mailserver proxy → <code>{capabilities.caps.preset || capabilities.caps.kind}</code>
                            {capabilities.caps.model ? ` · ${capabilities.caps.model}` : ''}
                        </span>
                    </div>
                {/if}

                <label class="toggle">
                    <input
                        type="checkbox"
                        checked={settings.useCustomLlm}
                        onchange={(e) => setUseCustomLlm((e.currentTarget as HTMLInputElement).checked)}
                        data-testid="settings-use-custom"
                    />
                    <span>Use a local LLM</span>
                </label>
                <p class="muted small" style="margin:-4px 0 8px 26px;">
                    Point it at your own Ollama or other OpenAI-compatible server — it runs
                    client-side, so your mail never leaves this browser for AI features.
                </p>

                <div class="form" class:disabled={!settings.useCustomLlm}>
                    <div class="row">
                        <span class="lbl">Type</span>
                        <div class="seg" role="radiogroup" aria-label="Provider type">
                            <button
                                type="button"
                                role="radio"
                                aria-checked={settings.llm.kind === 'openai'}
                                class:active={settings.llm.kind === 'openai'}
                                onclick={() => setLlm({ kind: 'openai' })}
                            >OpenAI-compatible</button>
                            <button
                                type="button"
                                role="radio"
                                aria-checked={settings.llm.kind === 'anthropic'}
                                class:active={settings.llm.kind === 'anthropic'}
                                onclick={() => setLlm({ kind: 'anthropic', preset: '' })}
                            >Anthropic</button>
                        </div>
                    </div>

                    {#if settings.llm.kind === 'openai'}
                        <div class="row">
                            <span class="lbl">Preset</span>
                            <select
                                value={settings.llm.preset}
                                onchange={(e) => applyPreset((e.currentTarget as HTMLSelectElement).value)}
                                data-testid="settings-preset"
                            >
                                {#each PRESETS as p (p.value)}
                                    <option value={p.value}>{p.label}</option>
                                {/each}
                            </select>
                        </div>
                        <div class="hint">
                            {PRESETS.find((p) => p.value === settings.llm.preset)?.help || ''}
                        </div>
                    {/if}

                    <button
                        type="button"
                        class="collapse-header small"
                        onclick={() => showAiAdvanced = !showAiAdvanced}
                        aria-expanded={showAiAdvanced}
                        data-testid="settings-ai-advanced"
                    >
                        <span><Icon name="key" size={13} /> Advanced provider settings</span>
                        <Icon name={showAiAdvanced ? 'chevronUp' : 'chevronDown'} size={14} />
                    </button>

                    {#if showAiAdvanced}
                        <div class="collapse-body" style="gap:10px;">
                            <div class="row">
                                <span class="lbl">API key</span>
                                <input
                                    type="password"
                                    placeholder={settings.llm.kind === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                                    autocomplete="off"
                                    spellcheck="false"
                                    value={settings.llm.apiKey}
                                    oninput={(e) => setLlm({ apiKey: (e.currentTarget as HTMLInputElement).value })}
                                    data-testid="settings-key"
                                />
                            </div>

                            <div class="row">
                                <span class="lbl">Base URL</span>
                                <input
                                    type="text"
                                    placeholder={settings.llm.kind === 'anthropic'
                                        ? 'https://api.anthropic.com/v1'
                                        : settings.llm.preset
                                            ? '(preset default)'
                                            : 'https://your-llm.example/v1'}
                                    value={settings.llm.baseUrl}
                                    oninput={(e) => setLlm({ baseUrl: (e.currentTarget as HTMLInputElement).value })}
                                    data-testid="settings-base-url"
                                />
                            </div>

                            <div class="row">
                                <span class="lbl">Model</span>
                                <input
                                    type="text"
                                    placeholder={settings.llm.kind === 'anthropic'
                                        ? 'claude-haiku-4-5-20251001'
                                        : settings.llm.preset
                                            ? '(preset default)'
                                            : 'gpt-4o-mini'}
                                    value={settings.llm.model}
                                    list="llm-model-suggestions"
                                    oninput={(e) => setLlm({ model: (e.currentTarget as HTMLInputElement).value })}
                                    data-testid="settings-model"
                                />
                                <!-- Everything below the input spans the value
                                     column. The row is a `96px 1fr` grid, so
                                     each additional child would otherwise be
                                     auto-placed into the 96px label column —
                                     which is why the status hint renders one
                                     word per line. A nested grid carries the
                                     same two columns instead. -->
                                <div class="row-body">
                                <!-- Free-form input still wins: a gateway may
                                     serve a model it doesn't advertise, and an
                                     operator's private deployment will never
                                     be in a hardcoded list. The datalist is
                                     fed from the provider's own catalog via
                                     /v1/ai/models, so the suggestions are what
                                     this gateway will actually accept — which
                                     is what a hand-kept list can never be, and
                                     why that list went stale the moment a
                                     provider renamed a model. -->
                                <datalist id="llm-model-suggestions">
                                    {#each aiModels.models as m (m.id)}
                                        <option value={m.id}>{m.owned_by ? `${m.id} — ${m.owned_by}` : m.id}</option>
                                    {/each}
                                </datalist>
                                <!-- Grouped choices, on top of the datalist.
                                     The datalist is the field's own suggestion
                                     mechanism and cannot express headings, so
                                     the Free / Value surfaces get real buttons
                                     below. They are *also* still in the
                                     datalist: a surface is a model id, and the
                                     datalist must keep offering it for typing. -->
                                {#if aiModels.groups.some((g) => g.models.length > 0)}
                                    <div class="model-groups" data-testid="settings-model-groups">
                                        {#each aiModels.groups as g (g.modelId)}
                                            <div class="model-group">
                                                <span class="model-group-label">{g.label}</span>
                                                <div class="chip-list">
                                                    {#each g.models as m (m.id)}
                                                        <button
                                                            type="button"
                                                            class="model-group-chip"
                                                            class:selected={settings.llm.model === m.id}
                                                            onclick={() => setLlm({ model: m.id })}
                                                            title={m.id}
                                                            data-testid={`settings-model-group-${g.modelId.split('/').pop()}`}
                                                        >{m.id}</button>
                                                    {/each}
                                                </div>
                                                {#if !g.membershipKnown}
                                                    <!-- Say what we do not know
                                                         rather than implying an
                                                         exhaustive list: this
                                                         gateway publishes the
                                                         surface but not what is
                                                         behind it. -->
                                                    <span class="model-group-note">Select {g.modelId} to use this surface.</span>
                                                {/if}
                                            </div>
                                        {/each}
                                    </div>
                                {/if}
                                <!-- OSS / no-key case: no gateway, so no groups
                                     and no catalog. An empty bordered box would
                                     read as a broken control, so say the one
                                     thing that actually helps. -->
                                {#if aiModels.loaded && !aiModels.loading && !aiModels.error && aiModels.models.length === 0}
                                    <p class="hint" data-testid="settings-model-empty">
                                        This install has no AI provider configured, so there are no
                                        models to choose from. Add an OpenAI-compatible endpoint
                                        and API key above, or type any model name here.
                                    </p>
                                {/if}
                                <!-- State is stated out loud. A silently empty
                                     dropdown is indistinguishable from a gateway
                                     that simply has no models, and the user is
                                     left guessing which one it is.

                                     The zero-model branch is suppressed while the
                                     empty-state paragraph above is showing:
                                     both would say the same thing, and two
                                     consecutive lines reading "no models… you
                                     can still type a model name" is noise. The
                                     testid stays on the element either way, so
                                     nothing observes a missing node. -->
                                <div class="hint" data-testid="settings-model-status">
                                    {#if aiModels.loading}
                                        <span class="spinner"></span> Loading models from the gateway…
                                    {:else if aiModels.error}
                                        {aiModels.error} You can still type a model name.
                                    {:else if !aiModels.loaded}
                                        Open the provider's model list…
                                    {:else if aiModels.models.length === 0}
                                        <!-- replaced by settings-model-empty -->
                                    {:else}
                                        {aiModels.models.length} model{aiModels.models.length === 1 ? '' : 's'} available from this gateway.
                                    {/if}
                                </div>
                                </div>
                            </div>
                        </div>
                    {/if}
                </div>
                <!-- Live model round-trips, gated on the master switch: with
                     AI off there is nothing to test, and clicking would spend
                     tokens proving a connection to a surface that's disabled.
                     The provider fields above stay visible — they are inert
                     config, not AI activity. -->
                {#if settings.aiFeatures}
                <div class="actions">
                    <button
                        type="button"
                        class="btn btn-secondary"
                        onclick={testConnection}
                        disabled={testing}
                        data-testid="settings-test"
                    >
                        {#if testing}<span class="spinner"></span>{/if}
                        <Icon name="sparkles" size={14} /> Test connection
                    </button>
                    {#if testResult}
                        <span class={`test-result ${testResult.ok ? 'ok' : 'err'}`} data-testid="settings-test-result">
                            {testResult.ok ? '✓' : '×'} {testResult.message}
                        </span>
                    {/if}
                </div>

                <h4 class="appearance-skin-title" style="margin-top: 8px;">System prompt</h4>
                <p class="muted small">
                    Override the assistant's persona for the full-screen AI tab. Leave blank
                    to use the built-in default ("personal AI inside the user's webmail",
                    concise, markdown). Changes apply on the next message.
                </p>
                <textarea
                    rows="5"
                    placeholder="e.g. You are a brisk research analyst. Keep replies under 200 words; cite sources when you use the web."
                    bind:value={settings.aiSystemPrompt}
                    onchange={(e) => setAiSystemPrompt((e.currentTarget as HTMLTextAreaElement).value)}
                    data-testid="settings-system-prompt"
                    class="prompt-area"
                ></textarea>

                <h4 class="appearance-skin-title" style="margin-top: 12px;">Reply suggestions</h4>
                <p class="muted small">
                    When you open a Reply, the AI drafts an opening you can accept, edit
                    or throw away. It runs in the background — typing is never interrupted.
                </p>
                <div class="form-row">
                    <div class="row-text">
                        <strong>Suggest a reply when I hit Reply</strong>
                        <span class="muted">
                            {#if !aiAvailable()}
                                No model configured yet, so this stays disabled.
                            {:else}
                                One draft per reply you open. The suggestion sits above the editor until
                                you accept, ignore or refresh it — nothing reaches your message until you
                                press Accept, and what you've already typed is always kept.
                            {/if}
                        </span>
                    </div>
                    <label class="toggle compact">
                        <input
                            type="checkbox"
                            checked={settings.aiSuggestReply}
                            disabled={!aiAvailable()}
                            onchange={(e) => setAiSuggestReply((e.currentTarget as HTMLInputElement).checked)}
                            data-testid="settings-ai-suggest-reply"
                        />
                        <span>{settings.aiSuggestReply ? 'On' : 'Off'}</span>
                    </label>
                </div>

                <h4 class="appearance-skin-title" style="margin-top: 12px;">Voice chat</h4>
                <p class="muted small">
                    When on, the AI chat reads assistant replies aloud and the
                    mic button auto-sends what you say. Off by default — leave
                    it that way unless you want every reply spoken.
                </p>
                <div class="form-row">
                    <div class="row-text">
                        <strong>Speak replies &amp; auto-send dictation</strong>
                        <span class="muted">
                            {#if !isVoiceAvailable() && !isSttAvailable()}
                                Your browser doesn't expose speech APIs — this stays disabled.
                            {:else if !isVoiceAvailable()}
                                Mic input works, but this browser can't synthesize speech.
                            {:else if !isSttAvailable()}
                                TTS works, but this browser doesn't expose mic input.
                            {:else}
                                Uses the browser's built-in speech engines (no third-party API).
                            {/if}
                        </span>
                    </div>
                    <label class="toggle compact">
                        <input
                            type="checkbox"
                            checked={voicePrefs.enabled}
                            disabled={!isVoiceAvailable() && !isSttAvailable()}
                            onchange={(e) => setVoiceEnabled((e.currentTarget as HTMLInputElement).checked)}
                            data-testid="settings-voice-toggle"
                        />
                        <span>{voicePrefs.enabled ? 'On' : 'Off'}</span>
                    </label>
                </div>
                {/if}
                </section>

            {:else if activeSection === 'notifications'}
                <section class="tab-section">
                    <h3>App &amp; notifications</h3>
                    <p class="muted small">Install Webmail as a desktop app and turn on push notifications for new mail.</p>

                <div class="form-row">
                    <div class="row-text">
                        <strong>Install on this device</strong>
                        <span class="muted">
                            {#if pwa.installed}
                                Already installed.
                            {:else if pwa.available}
                                Available — gets you a dedicated app window.
                            {:else}
                                Use your browser's "Install app" button. Some browsers only show it after a few visits.
                            {/if}
                        </span>
                    </div>
                    <button
                        type="button"
                        class="btn btn-secondary"
                        disabled={!pwa.available || pwa.installed}
                        onclick={handleInstall}
                        data-testid="settings-install"
                    >
                        <Icon name="download" size={14} />
                        {pwa.installed ? 'Installed' : 'Install app'}
                    </button>
                </div>

                <div class="form-row">
                    <div class="row-text">
                        <strong>New-mail notifications</strong>
                        <span class="muted">
                            {#if pushStatus === 'unsupported'}
                                {#if /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches}
                                    iOS only delivers web push to installed PWAs.
                                    Tap the Safari Share button → "Add to Home Screen", open the app from your home screen, then come back here to enable notifications.
                                {:else}
                                    Your browser doesn't support push notifications.
                                {/if}
                            {:else if pushStatus === 'denied'}
                                Permission was denied. Grant it in your browser's site settings.
                            {:else if pushStatus === 'subscribed'}
                                Subscribed. You'll see a desktop banner when new mail arrives.
                            {:else}
                                Get a desktop banner the moment mail lands in your inbox.
                            {/if}
                        </span>
                    </div>
                    {#if pushStatus === 'subscribed'}
                        <button
                            type="button"
                            class="btn btn-ghost"
                            onclick={handleDisableNotifications}
                            data-testid="settings-notifications-off"
                        >Turn off</button>
                    {:else}
                        <button
                            type="button"
                            class="btn btn-secondary"
                            disabled={pushStatus === 'unsupported' || pushStatus === 'denied' || pushStatus === 'loading'}
                            onclick={handleEnableNotifications}
                            data-testid="settings-notifications-on"
                        >Enable</button>
                    {/if}
                </div>

                <div class="form-row">
                    <div class="row-text">
                        <strong>Push diagnostics</strong>
                        <span class="muted">
                            {#if pushDiag}
                                {pushDiag.summary}
                            {:else}
                                Loading diagnostics…
                            {/if}
                        </span>
                    </div>
                    <div class="push-actions">
                        <button
                            type="button"
                            class="btn btn-secondary"
                            disabled={pushTestSending || pushStatus !== 'subscribed'}
                            onclick={handleTestPush}
                            data-testid="settings-push-test"
                        >
                            {#if pushTestSending}<span class="spinner"></span>{/if}
                            Send test
                        </button>
                        <button
                            type="button"
                            class="btn btn-ghost"
                            onclick={async () => { await refreshPushDiag(); pushDiagOpen = !pushDiagOpen; }}
                            data-testid="settings-push-details"
                        >{pushDiagOpen ? 'Hide details' : 'Details'}</button>
                    </div>
                </div>

                {#if pushDiagOpen && pushDiag}
                    <ul class="push-diag-list" data-testid="settings-push-diag">
                        <li class:ok={pushDiag.secureContext}>HTTPS context: {pushDiag.secureContext ? 'yes' : 'no'}</li>
                        <li class:ok={pushDiag.notificationsSupported}>Notifications API: {pushDiag.notificationsSupported ? 'supported' : 'unsupported'}</li>
                        <li class:ok={pushDiag.pushSupported}>Push API: {pushDiag.pushSupported ? 'supported' : 'unsupported'}</li>
                        <li class:ok={pushDiag.permission === 'granted'}>Permission: {pushDiag.permission}</li>
                        <li class:ok={pushDiag.serviceWorkerRegistered}>Service worker registered: {pushDiag.serviceWorkerRegistered ? 'yes' : 'no'}</li>
                        <li class:ok={pushDiag.serviceWorkerActive}>Service worker active: {pushDiag.serviceWorkerActive ? 'yes' : 'no'}</li>
                        <li class:ok={pushDiag.hasSubscription}>Subscription: {pushDiag.hasSubscription ? 'active' : 'none'}</li>
                        <li class:ok={pushDiag.serverVapidConfigured}>Server VAPID key: {pushDiag.serverVapidConfigured ? 'configured' : 'missing'}</li>
                        <li class:ok={pushDiag.standalone} class:neutral={!pushDiag.standalone}>Running as installed PWA: {pushDiag.standalone ? 'yes' : 'no (browser tab)'}</li>
                    </ul>
                {/if}
                </section>

            {:else if activeSection === 'message-list'}
                <section class="tab-section" data-testid="settings-message-list">
                    <h3>Message list</h3>
                    <p class="muted small">How many messages load at once, whether they group into threads, and how dense each row is.</p>
                    <h4 class="section-head"><Icon name="inbox" size={13} /> List</h4>
                <div class="form-row">
                    <div class="row-text">
                        <strong>Page size</strong>
                        <span class="muted">
                            How many messages the inbox loads at once. Unlimited fetches up to
                            1000 in one shot — fine for short folders, slow for huge archives.
                        </span>
                    </div>
                    <div class="seg seg-narrow" role="radiogroup" aria-label="Page size">
                        {#each [25, 50, 100, 250] as n (n)}
                            <button
                                type="button"
                                role="radio"
                                aria-checked={settings.pageSize === n}
                                class:active={settings.pageSize === n}
                                onclick={() => setPageSize(n)}
                                data-testid={`settings-page-${n}`}
                            >{n}</button>
                        {/each}
                        <button
                            type="button"
                            role="radio"
                            aria-checked={settings.pageSize === 'unlimited'}
                            class:active={settings.pageSize === 'unlimited'}
                            onclick={() => setPageSize('unlimited')}
                            data-testid="settings-page-unlimited"
                        >∞</button>
                    </div>
                </div>
                <div class="form-row">
                    <div class="row-text">
                        <strong>Group messages by thread</strong>
                        <span class="muted">
                            Conversations collapse into one row showing the latest reply and a count.
                            Off shows every message as its own row, gmail's "newest first, no grouping" view.
                        </span>
                    </div>
                    <label class="toggle compact">
                        <input
                            type="checkbox"
                            checked={settings.groupThreads}
                            onchange={(e) => setGroupThreads((e.currentTarget as HTMLInputElement).checked)}
                            data-testid="settings-group-threads"
                        />
                        <span>{settings.groupThreads ? 'On' : 'Off'}</span>
                    </label>
                </div>
                <div class="form-row">
                    <div class="row-text">
                        <strong>List density</strong>
                        <span class="muted">Comfortable shows avatars + subjects on two lines. Compact packs ~2× more rows in the same height.</span>
                    </div>
                    <div class="seg" role="radiogroup" aria-label="Density">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={settings.density === 'comfortable'}
                            class:active={settings.density === 'comfortable'}
                            onclick={() => setDensity('comfortable')}
                            data-testid="settings-density-comfortable"
                        >Comfortable</button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={settings.density === 'compact'}
                            class:active={settings.density === 'compact'}
                            onclick={() => setDensity('compact')}
                            data-testid="settings-density-compact"
                        >Compact</button>
                    </div>
                </div>
                </section>
            {:else if activeSection === 'reading-pane'}
                <section class="tab-section" data-testid="settings-reading-pane">
                    <h3>Reading pane</h3>
                    <p class="muted small">Sender avatars and how the opened message looks.</p>
                    <h4 class="section-head"><Icon name="eye" size={13} /> Avatars</h4>
                <div class="form-row">
                    <div class="row-text">
                        <strong>Gravatar avatars</strong>
                        <span class="muted">
                            Look up sender avatars from Gravatar (a SHA-256 of each sender's
                            email is sent to gravatar.com). Falls back to the sender domain's
                            favicon, then a coloured initial.
                        </span>
                    </div>
                    <div class="sound-controls">
                        <button
                            type="button"
                            class="btn btn-ghost"
                            onclick={() => clearAvatarCache()}
                            title="Clear cached avatars"
                            data-testid="settings-avatars-clear"
                        >Clear cache</button>
                        <label class="toggle compact">
                            <input
                                type="checkbox"
                                checked={gravatarPref.on}
                                onchange={(e) => setGravatarEnabled((e.currentTarget as HTMLInputElement).checked)}
                                data-testid="settings-avatars-toggle"
                            />
                            <span>{gravatarPref.on ? 'On' : 'Off'}</span>
                        </label>
                    </div>
                </div>
                </section>
            {:else if activeSection === 'forwarding'}
                <section class="tab-section" data-testid="settings-forwarding">
                    <h3>Forwarding and IMAP</h3>
                    <p class="muted small">Add this mailbox to a mail client, or hand its mail on to other systems.</p>
                    <div class="card">
                        <h4><Icon name="wifi" size={13} /> Connect a device</h4>
                        <p class="muted small">
                            Use these settings to add this account to Apple Mail, Outlook, Thunderbird, or any IMAP client.
                        </p>
                        <div class="device-config">
                            <div class="config-block">
                                <strong>Incoming (IMAP)</strong>
                                <div class="config-row"><span>Server</span><code>mail.{deviceDomain}</code></div>
                                <div class="config-row"><span>Port</span><code>993</code></div>
                                <div class="config-row"><span>Security</span><code>SSL/TLS</code></div>
                                <div class="config-row"><span>Username</span><code>{deviceEmail}</code></div>
                            </div>
                            <div class="config-block">
                                <strong>Outgoing (SMTP)</strong>
                                <div class="config-row"><span>Server</span><code>mail.{deviceDomain}</code></div>
                                <div class="config-row"><span>Port</span><code>587</code></div>
                                <div class="config-row"><span>Security</span><code>STARTTLS</code></div>
                                <div class="config-row"><span>Username</span><code>{deviceEmail}</code></div>
                            </div>
                        </div>
                        <div class="card-actions">
                            <button
                                type="button"
                                class="btn btn-ghost small"
                                onclick={() => {
                                    const text = `IMAP: mail.${deviceDomain}:993 SSL/TLS\nSMTP: mail.${deviceDomain}:587 STARTTLS\nUsername: ${deviceEmail}`;
                                    navigator.clipboard.writeText(text).then(() => showToast('success', 'Settings copied to clipboard'));
                                }}
                            >
                                <Icon name="copy" size={11} /> Copy all
                            </button>
                        </div>
                    </div>

                </section>
            {:else if activeSection === 'sweep' && settings.aiFeatures}
                <section class="tab-section" data-testid="settings-sweep">
                    <h3>Sweep</h3>
                    <p class="muted small">Bulk spam &amp; phishing classification alongside AI sort.</p>
                                <div class="form-row" style="padding:0;border:none;background:none;margin-top:10px;">
                                    <div class="row-text">
                                        <strong>Sweep alongside AI sort</strong>
                                        <span class="muted">
                                            When you click the AI sort button on the inbox, also
                                            sweep the same list for spam &amp; phishing. Surfaces
                                            a "Move N to Spam / Trash" banner so you can clean
                                            up in one click. Reuses the cached scan results, so
                                            no extra LLM cost beyond the sort itself.
                                        </span>
                                    </div>
                                    <label class="toggle compact">
                                        <input
                                            type="checkbox"
                                            checked={settings.aiSortSweepSpam}
                                            onchange={(e) => setAiSortSweepSpam((e.currentTarget as HTMLInputElement).checked)}
                                            data-testid="settings-ai-sort-sweep"
                                        />
                                        <span>{settings.aiSortSweepSpam ? 'On' : 'Off'}</span>
                                    </label>
                                </div>

                                {#if settings.aiSortSweepSpam}
                                    <label class="field">
                                        <span class="lbl">
                                            Sweep batch size
                                            <strong class="lbl-val">{settings.spamSweepBatchSize} msg</strong>
                                        </span>
                                        <input
                                            type="range"
                                            min="10" max="200" step="10"
                                            value={settings.spamSweepBatchSize}
                                            oninput={(e) => setSpamSweepBatchSize(Number((e.currentTarget as HTMLInputElement).value))}
                                            data-testid="settings-sweep-batch"
                                        />
                                        <span class="muted small">How many recent INBOX messages to scan per sweep. Larger = catches older spam, slower the first time.</span>
                                    </label>
                                {/if}
                </section>
            {:else if activeSection === 'smart-suggestions' && settings.aiFeatures}
                <!-- All three rows here spend a model call (subject
                     suggestion, pre-send proofread, recipient history),
                     so the whole section is inert when AI is hard-off.
                     It is hidden outright — including its nav entry —
                     because unlike the AI section it holds no master
                     switch, so there would be no reason to navigate to
                     it. The AI section stays reachable precisely because
                     it IS the way back. -->
                <section class="tab-section" data-testid="settings-smart-suggestions">
                    <h3>Smart suggestions</h3>
                    <p class="muted small">Client-side AI helpers — subject suggestions and the pre-send sanity check.</p>
                    <div class="card">
                        <h4><Icon name="sparkles" size={13} /> AI subject suggestion</h4>
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Suggest a subject as I leave the body</strong>
                                <span class="muted">
                                    When the body has content and the subject is empty, ask the AI
                                    for one and offer it inline (purple chip with Use / Decline).
                                    When off, the suggestion only fires if you click Send with no
                                    subject. Each suggestion costs LLM tokens.
                                </span>
                            </div>
                            <label class="toggle compact">
                                <input
                                    type="checkbox"
                                    checked={settings.aiSuggestSubjectOnBlur}
                                    onchange={(e) => setAiSuggestSubjectOnBlur((e.currentTarget as HTMLInputElement).checked)}
                                    data-testid="settings-ai-subject-blur"
                                />
                                <span>{settings.aiSuggestSubjectOnBlur ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                    </div>

                    <div class="form-row">
                        <div class="row-text">
                            <strong>Pre-send check</strong>
                            <span class="muted">
                                Before send, scan the draft for empty subjects, missing attachments
                                ("attached" with no file), and leftover placeholders.
                            </span>
                        </div>
                        <label class="toggle compact">
                            <input
                                type="checkbox"
                                checked={settings.preSendCheck}
                                onchange={(e) => setPreSendCheck((e.currentTarget as HTMLInputElement).checked)}
                                data-testid="settings-pre-send-check"
                            />
                            <span>{settings.preSendCheck ? 'On' : 'Off'}</span>
                        </label>
                    </div>
                    <div class="form-row">
                        <div class="row-text">
                            <strong>Compose history summary</strong>
                            <span class="muted">
                                When replying, summarize the thread above the compose box so the AI
                                has context.
                            </span>
                        </div>
                        <label class="toggle compact">
                            <input
                                type="checkbox"
                                checked={settings.composeHistorySummary}
                                onchange={(e) => setComposeHistorySummary((e.currentTarget as HTMLInputElement).checked)}
                                data-testid="settings-history-summary"
                            />
                            <span>{settings.composeHistorySummary ? 'On' : 'Off'}</span>
                        </label>
                    </div>
                </section>
            {:else if activeSection === 'outbound-hooks'}
                <section class="tab-section" data-testid="settings-outbound-hooks">
                    <h3>Outbound webhooks</h3>
                    <p class="muted small">
                        Hand matching mail to an external service — the inverse of webhook inboxes.
                        Point a mail rule's "Send to external webhook" action at one of these; the
                        payload carries the parsed headers, the body, and gzip+base64 attachments.
                    </p>

                    <!-- The header editor, shared by the create form and the per-webhook
                         editor below.

                         One implementation, not two, because the two boxes have to agree:
                         they share a parser, they share the exact same failure mode (a
                         line that cannot go on the wire), and a user who learns the
                         create box has to unlearn nothing to use the other one. The
                         `id` parameter is what makes the <label> real rather than
                         decorative — a placeholder is not an accessible name, and it
                         disappears the moment the box has content, which is always. -->
                    {#snippet owHeaderBox(id: string, value: string, onInput: (v: string) => void, errors: HeaderLineError[], ignored: HeaderLineError[], helpId: string)}
                        <label class="ow-headers-label" for={`${id}-headers`}>Request headers, one per line</label>
                        <textarea
                            id={`${id}-headers`}
                            class="ow-headers-input"
                            rows="4"
                            spellcheck="false"
                            autocomplete="off"
                            autocapitalize="off"
                            placeholder={'Authorization: Bearer …\nX-Api-Key: …'}
                            aria-describedby={helpId}
                            aria-invalid={errors.length ? 'true' : undefined}
                            {value}
                            oninput={(e) => onInput((e.currentTarget as HTMLTextAreaElement).value)}
                            data-testid={`${id}-headers`}
                        ></textarea>
                        <p class="muted small" id={helpId}>
                            Paste the header lines as they are — <code>Authorization: Bearer …</code>.
                            One per line; blank lines and <code>#</code> comments are ignored.
                            Values are stored encrypted and never shown again.
                        </p>
                        <!-- Per line, addressed by its number in the box, so a bad line
                             is a thing you can find rather than a form that failed.
                             role="alert" so a screen reader announces it when the
                             validation runs on save. -->
                        {#if errors.length}
                            <ul class="ow-headers-errors" role="alert" data-testid={`${id}-header-errors`}>
                                {#each errors as e (e.line + e.message)}
                                    <li><strong>Line {e.line}:</strong> {e.message}</li>
                                {/each}
                            </ul>
                        {/if}
                        {#if ignored.length}
                            <p class="muted small" data-testid={`${id}-header-ignored`}>
                                Ignored: {ignored.map((e) => `line ${e.line} (${e.message})`).join('; ')}
                            </p>
                        {/if}
                    {/snippet}
                    {#if owNewSecret}
                        <div class="card" data-testid="ow-secret-card">
                            <h4><Icon name="key" size={13} /> Signing secret — shown once</h4>
                            <p class="muted small">
                                Your receiver verifies each POST with this. It is not stored
                                anywhere you can read it back, so copy it now.
                            </p>
                            <div class="form-row" style="padding:0;border:none;background:none;gap:8px;">
                                <input
                                    type="text"
                                    readonly
                                    value={owNewSecret.secret}
                                    data-testid="ow-secret-value"
                                    style="flex:1;font-family:var(--font-mono,monospace);"
                                />
                                <button
                                    type="button"
                                    class="btn"
                                    onclick={() => { navigator.clipboard?.writeText(owNewSecret!.secret); showToast('success', 'Secret copied'); }}
                                    data-testid="ow-secret-copy"
                                >Copy</button>
                                <button
                                    type="button"
                                    class="btn"
                                    onclick={() => { owNewSecret = null; }}
                                    data-testid="ow-secret-dismiss"
                                >Done</button>
                            </div>
                        </div>
                    {/if}
                    <!-- Existing webhooks lead the section. It reads the wrong way round to
                         put "add another" above the list: with a 100-webhook allowance the
                         form is a wall of inputs and the thing the user came to look at is
                         the list. The count sits in the header, so the section still says
                         what is configured while it is collapsed. -->
                    <div class="filter-block" data-testid="ow-list-block">
                        <button
                            type="button"
                            class="collapse-header"
                            onclick={() => (showOwList = !showOwList)}
                            aria-expanded={showOwList}
                            data-testid="ow-list-toggle"
                        >
                            <span><Icon name="globe" size={13} /> Configured webhooks</span>
                            <span class="count">
                                {outboundHooks.length}{#if outboundLimit}&nbsp;/&nbsp;{outboundLimit}{/if}
                            </span>
                            <Icon name={showOwList ? 'chevronUp' : 'chevronDown'} size={14} />
                        </button>
                        {#if showOwList}
                            <div class="collapse-body">
                                {#if outboundHooks.length > 8}
                                    <!-- Only once the list is long enough to need it: a filter box
                                         for three rows is clutter, for a hundred it is essential. -->
                                    <div class="add-row">
                                        <input
                                            type="search"
                                            placeholder="Filter by name or URL"
                                            bind:value={owSearch}
                                            aria-label="Filter webhooks by name or URL"
                                            data-testid="ow-search"
                                        />
                                        <span class="muted small">{owVisibleHooks.length} shown</span>
                                    </div>
                                {/if}
                            </div>
                        {/if}
                    </div>

                    <!-- The create form is its own collapsible too, and closed by default:
                         adding a webhook is a deliberate act, while arriving here is usually
                         "why didn't that fire?". -->
                    {#if !outboundUnavailable}
                        <div class="filter-block">
                            <button
                                type="button"
                                class="collapse-header"
                                onclick={() => (showOwCreate = !showOwCreate)}
                                aria-expanded={showOwCreate}
                                data-testid="ow-create-toggle"
                            >
                                <span><Icon name="plus" size={13} /> Add a webhook</span>
                                <Icon name={showOwCreate ? 'chevronUp' : 'chevronDown'} size={14} />
                            </button>
                            {#if showOwCreate}
                            <div class="collapse-body">
                            <div class="rule-form">
                                <label class="rule-row">
                                    <span class="rule-label">URL</span>
                                    <input type="url" placeholder="https://agent.example/hook" bind:value={owUrl} data-testid="ow-url" />
                                </label>
                                <label class="rule-row">
                                    <span class="rule-label">Name</span>
                                    <input type="text" placeholder="My agent" bind:value={owLabel} data-testid="ow-label" />
                                </label>
                                <label class="rule-row">
                                    <span class="rule-label">Prepend</span>
                                    <input type="text" placeholder="Context for the receiver (optional)" bind:value={owPrepend} data-testid="ow-prepend" />
                                </label>
                                <label class="rule-row">
                                    <span class="rule-label">Keep</span>
                                    <span class="muted small"><input type="checkbox" bind:checked={owKeep} data-testid="ow-keep" /> keep the message in the mailbox after sending</span>
                                </label>
                                <!-- Stacked rather than a plain .rule-row: the header editor is
                                     a multi-line box, and .rule-row is a two-column grid
                                     whose second track is sized for a single control. -->
                                <div class="rule-row rule-row-stack">
                                    <span class="rule-label">Headers</span>
                                    <div class="ow-headers">
                                        {@render owHeaderBox('ow', owHeaderText, (v) => { owHeaderText = v; recheckOwHeaders(); }, owHeaderErrors, owHeaderIgnored, 'ow-headers-help')}
                                    </div>
                                </div>
                                <div class="rule-actions">
                                    <button type="button" class="btn btn-primary" disabled={owSaving} onclick={doCreateOutboundWebhook} data-testid="ow-create">
                                        {owSaving ? 'Creating…' : 'Add webhook'}
                                    </button>
                                </div>
                            </div>
                            </div>
                            {/if}
                        </div>
                    {/if}

                    {#if !outboundUnavailable}
                        <div class="filter-block" data-testid="ow-list-block">
                            {#if owVisibleHooks.length}
                                <ul class="rule-cards" data-testid="ow-list">
                                    {#each owVisibleHooks as w (w.id)}
                                        <li class="rule-card" data-testid={`ow-item-${w.id}`}>
                                            <div class="rule-card-head">
                                                <span class="rule-badge"><Icon name="globe" size={11} /> Webhook</span>
                                                <span class="rule-name truncate" title={w.url}>{w.label}</span>
                                                <button type="button" class="rule-remove" aria-label={`Remove webhook ${w.label}`} title="Remove webhook" onclick={() => doDeleteOutboundWebhook(w)} data-testid={`ow-remove-${w.id}`}><Icon name="trash" size={12} /></button>
                                            </div>
                                            <div class="rule-card-body">
                                                <div class="rule-clause"><code class="rule-val truncate" title={w.url}>{w.url}</code></div>
                                                <!-- Last-used is the first thing anyone asks about a
                                                     webhook ("is it even firing?"), and the raw
                                                     epoch millisecond the server returns is
                                                     useless at a glance. -->
                                                <div class="rule-clause muted small" data-testid={`ow-lastused-${w.id}`}>
                                                    {owLastUsedLabel(w)}
                                                </div>
                                                <div class="rule-clause">
                                                    <label class="muted small">
                                                        <input type="checkbox" checked={w.keep} onchange={(e) => doUpdateOutboundWebhook(w, { keep: (e.currentTarget as HTMLInputElement).checked })} data-testid={`ow-keep-${w.id}`} />
                                                        keep message in mailbox
                                                    </label>
                                                </div>
                                                {#if owEditId === w.id}
                                                    <!-- Editing a stored webhook's headers.

                                                         The box is seeded by formatHeaderLines from
                                                         the server's response, which is names with
                                                         '•••' values and nothing else. Saving is a
                                                         FULL REPLACE, so a save that left the
                                                         bullets in place would replace a working
                                                         bearer token with the literal string '•••'
                                                         and the receiver would 401 every delivery
                                                         with nothing on screen to explain it. So:
                                                         the mask is spelled out as a mask, the
                                                         parser refuses to send it, and the note
                                                         says plainly that a value nobody can read
                                                         back has to be retyped. -->
                                                    <div class="ow-headers ow-headers-edit" data-testid={`ow-headers-editor-${w.id}`}>
                                                        {@render owHeaderBox(`ow-${w.id}`, owEditText, (v) => { owEditText = v; owEditErrors = parseHeaderLines(v, { masked: 'reject' }).errors; }, owEditErrors, [], `ow-${w.id}-headers-help`)}
                                                        <p class="ow-headers-mask-note">
                                                            <Icon name="alertCircle" size={12} />
                                                            <!-- One <span> for the whole sentence.
                                                                 The <p> is display:flex so the icon
                                                                 can sit beside the text, which makes
                                                                 every bare text node AND every <code>
                                                                 a flex item — left unwrapped, the
                                                                 prose flowed as three ragged columns
                                                                 instead of one paragraph. -->
                                                            <span>
                                                                Saved values are write-only: the server keeps them
                                                                encrypted and can never show them again, so a stored
                                                                header comes back as <code>{MASKED_VALUE}</code>. A
                                                                line still showing <code>{MASKED_VALUE}</code> is the
                                                                real stored secret, not an empty field — to change it,
                                                                type a fresh value over the whole line; to drop the
                                                                header, delete the line.
                                                            </span>
                                                        </p>
                                                        <div class="ow-headers-edit-actions">
                                                            <button
                                                                type="button"
                                                                class="btn btn-primary"
                                                                disabled={owEditSaving}
                                                                onclick={() => doSaveOwHeaders(w)}
                                                                data-testid={`ow-headers-save-${w.id}`}
                                                            >{owEditSaving ? 'Saving…' : 'Save headers'}</button>
                                                            <button
                                                                type="button"
                                                                class="btn btn-ghost"
                                                                onclick={closeOwHeaderEditor}
                                                                data-testid={`ow-headers-cancel-${w.id}`}
                                                            >Cancel</button>
                                                        </div>
                                                    </div>
                                                {:else if w.headers && Object.keys(w.headers).length}
                                                    <!-- Values are masked server-side ('•••'); only the
                                                         names are meaningful. The editor below is the
                                                         honest way to change them: the values have to
                                                         be retyped because the server will not give
                                                         them back, and the editor says so while it is
                                                         still open. -->
                                                    <div class="rule-clause muted small" data-testid={`ow-headers-${w.id}`}>
                                                        Headers: {Object.keys(w.headers).join(', ')}
                                                        <button
                                                            type="button"
                                                            class="btn btn-ghost"
                                                            onclick={() => openOwHeaderEditor(w)}
                                                            data-testid={`ow-headers-edit-${w.id}`}
                                                        >Edit</button>
                                                    </div>
                                                {:else}
                                                    <div class="rule-clause muted small">
                                                        Headers: none
                                                        <button
                                                            type="button"
                                                            class="btn btn-ghost"
                                                            onclick={() => openOwHeaderEditor(w)}
                                                            data-testid={`ow-headers-edit-${w.id}`}
                                                        >Add</button>
                                                    </div>
                                                {/if}
                                                <input
                                                    type="text"
                                                    class="ow-prepend-edit"
                                                    value={w.prepend}
                                                    placeholder="Prepend text sent above the quoted message (optional)"
                                                    onchange={(e) => doUpdateOutboundWebhook(w, { prepend: (e.currentTarget as HTMLInputElement).value })}
                                                    data-testid={`ow-prepend-${w.id}`}
                                                />
                                                <div class="ow-card-actions">
                                                    <button
                                                        type="button"
                                                        class="btn"
                                                        disabled={owBusyId === w.id}
                                                        onclick={() => doTestOutboundWebhook(w)}
                                                        data-testid={`ow-test-${w.id}`}
                                                    >{owBusyId === w.id ? 'Sending…' : 'Send test'}</button>
                                                    <button
                                                        type="button"
                                                        class="btn btn-ghost"
                                                        onclick={() => (owExpandedId = owExpandedId === w.id ? null : w.id)}
                                                        aria-expanded={owExpandedId === w.id}
                                                        data-testid={`ow-details-${w.id}`}
                                                    >{owExpandedId === w.id ? 'Hide details' : 'Details'}</button>
                                                    <!-- The rule's target id. An implementation detail,
                                                         but a user hand-building a rule through the
                                                         API needs it and hunting it elsewhere is
                                                         miserable. -->
                                                    <code class="ow-id" title="Mail rules reference this webhook by id">{w.id}</code>
                                                </div>
                                                {#if owExpandedId === w.id}
                                                    <dl class="ow-details" data-testid={`ow-details-body-${w.id}`}>
                                                        <div><dt>Prepend</dt><dd>{w.prepend || '— none —'}</dd></div>
                                                        <div><dt>Rule action</dt><dd><code>{JSON.stringify({ type: 'webhook', webhookId: w.id })}</code></dd></div>
                                                        <div><dt>Mailbox</dt><dd><code>{w.mailbox}</code> — hidden; matching mail is parked here until delivered</dd></div>
                                                    </dl>
                                                {/if}
                                                {#if owTestResult[w.id]}
                                                    {@const r = owTestResult[w.id]}
                                                    <div
                                                        class="ow-test-result"
                                                        class:ow-test-ok={r.ok}
                                                        data-testid={`ow-test-result-${w.id}`}
                                                    >
                                                        <div class="ow-test-status">
                                                            <Icon name={r.ok ? 'check' : 'alertCircle'} size={13} />
                                                            <strong>HTTP {r.status}</strong>
                                                            <span class="muted">{r.elapsedMs} ms</span>
                                                            <span class="muted">{r.truncated ? 'first 300 chars' : 'full reply'}</span>
                                                            <button
                                                                type="button"
                                                                class="btn btn-ghost"
                                                                onclick={() => {
                                                                    const next = { ...owTestResult };
                                                                    delete next[w.id];
                                                                    owTestResult = next;
                                                                }}
                                                                aria-label="Dismiss test result"
                                                                data-testid={`ow-test-dismiss-${w.id}`}
                                                            ><Icon name="close" size={12} /></button>
                                                        </div>
                                                        <!-- pre-wrap, not truncated: an HTML error page or a
                                                             JSON body is the thing being debugged, and the
                                                             server already bounded it at 300 chars. -->
                                                        {#if r.reply}
                                                            <pre class="ow-test-reply" data-testid={`ow-test-reply-${w.id}`}>{r.reply}</pre>
                                                        {:else}
                                                            <p class="muted small">The receiver sent no body.</p>
                                                        {/if}
                                                    </div>
                                                {/if}
                                            </div>
                                        </li>
                                    {/each}
                                </ul>
                            {:else if owSearch.trim()}
                                <p class="muted small" data-testid="ow-list-empty">
                                    No webhook matches “{owSearch.trim()}”.
                                </p>
                            {:else}
                                <p class="muted small">No outbound webhooks yet.</p>
                            {/if}
                        </div>
                    {/if}
                </section>
            {:else if activeSection === 'calendar'}
                <section class="tab-section" data-testid="settings-calendar">
                    <h3>Calendar</h3>
                    <p class="muted small">
                        The next-event ticker in the desktop top bar. The Outlook skin
                        leaves the top bar clear, so the ticker stays hidden there.
                    </p>

                    <div class="card">
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Show the calendar ticker</strong>
                                <span class="muted">Your next event, in the top bar.</span>
                            </div>
                            <label class="toggle compact">
                                <input
                                    type="checkbox"
                                    checked={settings.calendarTicker}
                                    onchange={(e) => setCalendarTicker(e.currentTarget.checked)}
                                    data-testid="settings-calendar-ticker"
                                />
                                <span>{settings.calendarTicker ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                    </div>

                    <div class="card">
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Show event titles</strong>
                                <span class="muted">Off shows the time only.</span>
                            </div>
                            <label class="toggle compact">
                                <input
                                    type="checkbox"
                                    checked={settings.calendarTickerTitles}
                                    onchange={(e) => setCalendarTickerTitles(e.currentTarget.checked)}
                                    data-testid="settings-calendar-titles"
                                />
                                <span>{settings.calendarTickerTitles ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                    </div>
                </section>
            {:else if activeSection === 'people'}
                <section class="tab-section" data-testid="settings-people">
                    <h3>People</h3>
                    <p class="muted small">Who counts as family, and how they're marked in the list.</p>

                    <div class="card">
                        <h4>👨‍👩‍👧 VIP addresses</h4>
                        <div class="form-row" style="padding:0;border:none;background:none;flex-direction:column;align-items:stretch;gap:6px;">
                            <div class="row-text">
                                <strong>Family / VIP address list</strong>
                                <span class="muted">
                                    Comma-separated. Messages sent to or from any of these addresses
                                    get a small family badge next to the sender avatar with a hover
                                    tooltip identifying the VIP address.
                                </span>
                            </div>
                            <input
                                type="text"
                                value={settings.vipAddresses}
                                oninput={(e) => setVipAddresses((e.currentTarget as HTMLInputElement).value)}
                                placeholder="family@example.com, partner@example.com"
                                spellcheck="false"
                                autocomplete="off"
                                data-testid="settings-vip-addresses"
                            />
                        </div>
                    </div>

                    <!--
                        Address book. Stored on the server in a hidden IMAP
                        folder so it follows the user between devices.
                        addressBook.error is set when that path is unusable;
                        the banner says so rather than leaving the user to
                        assume their contacts are synced when they are only
                        in this browser.

                        The add form doubles as the editor: Edit on a row
                        loads it into the same fields, so there is one place
                        to learn rather than a dialog per row.
                    -->
                    <div class="card">
                        <h4><Icon name="user" size={13} /> Contacts</h4>

                        {#if addressBook.error}
                            <p class="muted small" role="status" data-testid="contacts-store-warning">
                                <strong>Not syncing.</strong> Your contacts are kept in this browser
                                instead of on the server, so they will not follow you to another
                                device. Reason: {addressBook.error}
                            </p>
                        {:else if addressBook.loading}
                            <p class="muted small">Loading contacts…</p>
                        {:else}
                            <p class="muted small">
                                Stored on the server in a hidden folder, so they follow you to every
                                device. {addressBook.contacts.length}
                                {addressBook.contacts.length === 1 ? 'contact' : 'contacts'}.
                            </p>
                        {/if}

                        <div class="add-row" style="margin-top:8px;">
                            <input
                                type="text"
                                placeholder="Name (optional)"
                                bind:value={contactNameInput}
                                data-testid="contact-name-input"
                            />
                            <input
                                type="text"
                                placeholder="email@example.com"
                                bind:value={contactAddrInput}
                                spellcheck="false"
                                autocomplete="off"
                                onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveContact(); } }}
                                data-testid="contact-address-input"
                            />
                        </div>
                        <div class="add-row">
                            <input
                                type="text"
                                placeholder="Note (optional) — where you met, what they do"
                                bind:value={contactNoteInput}
                                onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveContact(); } }}
                                data-testid="contact-note-input"
                            />
                            <button
                                type="button"
                                class="btn btn-secondary"
                                disabled={contactSaving}
                                onclick={saveContact}
                                data-testid="contact-save"
                            >{contactEditing ? 'Save' : 'Add'}</button>
                            {#if contactEditing}
                                <button
                                    type="button"
                                    class="btn btn-ghost"
                                    onclick={resetContactForm}
                                    data-testid="contact-cancel"
                                >Cancel</button>
                            {/if}
                        </div>
                        {#if contactError}
                            <p class="err small" role="alert" data-testid="contact-error">{contactError}</p>
                        {/if}

                        {#if contactRows.length > 6}
                            <input
                                type="search"
                                placeholder="Search contacts"
                                bind:value={contactSearch}
                                style="width:100%;margin-top:8px;"
                                data-testid="contact-search"
                            />
                        {/if}

                        {#if contactRows.length}
                            <ul class="contact-list" data-testid="contact-list">
                                {#each contactRows as c (c.uid + c.address)}
                                    <li
                                        class="contact-row"
                                        class:editing={contactEditing === c.uid}
                                        data-testid="contact-row"
                                    >
                                        <div class="row-text">
                                            <strong>{c.name || c.address}</strong>
                                            {#if c.name}<span class="contact-addr">{c.address}</span>{/if}
                                            <span class="muted">
                                                {contactSeen(c)}{c.count > 1 ? ` · ${c.count} mentions` : ''}
                                            </span>
                                            {#if c.note}<span class="muted small">{c.note}</span>{/if}
                                        </div>
                                        <div class="rule-actions">
                                            <button
                                                type="button"
                                                class="btn btn-ghost small"
                                                onclick={() => startEditContact(c)}
                                                data-testid="contact-edit"
                                            ><Icon name="pencil" size={11} /> Edit</button>
                                            <button
                                                type="button"
                                                class="btn btn-ghost small"
                                                aria-label={`Delete ${c.name || c.address}`}
                                                onclick={() => deleteContactRow(c.uid)}
                                                data-testid="contact-delete"
                                            ><Icon name="trash" size={11} /></button>
                                        </div>
                                    </li>
                                {/each}
                            </ul>
                        {:else if contactSearch}
                            <p class="muted small" data-testid="contact-empty">Nothing matches “{contactSearch}”.</p>
                        {:else}
                            <p class="muted small" data-testid="contact-empty">
                                No contacts yet. Send some mail, or add one above.
                            </p>
                        {/if}

                        <div class="rule-actions" style="margin-top:8px;">
                            <button
                                type="button"
                                class="btn btn-ghost small"
                                onclick={() => loadAddressBook()}
                                disabled={addressBook.loading}
                                data-testid="contact-reload"
                            ><Icon name="refresh" size={11} /> Reload from server</button>
                        </div>
                    </div>
                </section>
            {/if}
            </div>
        </div>

        <footer class="foot">
            <p class="muted">
                Tip — these settings live only in your browser. They sync nowhere; clear your
                browser data and they'll vanish.
            </p>
            <button type="button" class="btn btn-primary" onclick={close} data-testid="settings-done">Done</button>
        </footer>
    </div>
</div>

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: var(--bg-overlay);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        z-index: 60;
        backdrop-filter: blur(2px);
    }
    .dialog {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(820px, calc(100% - 40px));
        height: min(640px, calc(100vh - 40px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 20px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .head h2 { margin: 0; font-size: 16px; letter-spacing: -0.01em; }
    .body {
        flex: 1;
        min-height: 0;
        display: grid;
        /* 236 px fits the longest labels ("Conditional formatting",
           "Outbound webhooks") at 13 px without clipping — 200 px truncated
           them mid-word. */
        grid-template-columns: 236px 1fr;
        overflow: hidden;
    }
    .tabs {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 12px 8px;
        background: var(--bg-surface-alt);
        border-right: 1px solid var(--border-subtle);
        overflow-y: auto;
    }
    .rail-search { padding: 4px 4px 10px; }
    .rail-empty { padding: 10px 12px; line-height: 1.45; }
    .rail-search input {
        width: 100%;
        padding: 7px 10px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        background: var(--bg-canvas);
        color: var(--text-primary);
        font: inherit;
        font-size: 12.5px;
    }
    .rail-group { display: flex; flex-direction: column; gap: 2px; }
    .rail-cat {
        font-size: 10.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        padding: 12px 12px 4px;
    }
    .tab {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
        border-radius: var(--radius-sm);
        cursor: pointer;
        text-align: left;
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .tab:hover { background: var(--bg-hover); color: var(--text-primary); }
    .tab.active {
        background: var(--accent-soft);
        color: var(--accent-text);
        font-weight: 600;
    }
    .panel {
        padding: 22px 26px 16px;
        overflow-y: auto;
        min-width: 0;
    }
    /* Group / section trail. Pulls up against the panel padding so it reads
     * as chrome above the section rather than another setting inside it. */
    .crumb {
        display: flex;
        align-items: center;
        gap: 5px;
        margin: -6px 0 14px;
        font-size: 11px;
        color: var(--text-tertiary);
    }
    .crumb-group {
        text-transform: uppercase;
        letter-spacing: 0.07em;
        font-weight: 700;
    }
    .crumb-here {
        color: var(--text-secondary);
        font-weight: 600;
    }
    .tab-section { display: flex; flex-direction: column; gap: 14px; }
    .tab-section > h3 {
        margin: 0;
        font-size: 17px;
        font-weight: 700;
        letter-spacing: -0.015em;
    }
    .tab-section > p.muted { margin: 0 0 4px; }
    .card {
        padding: 14px 16px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .card h4 {
        margin: 0;
        font-size: 12.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .card-actions { display: flex; gap: 6px; }

    /* App passwords */
    .ap-rows { list-style: none; margin: 8px 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .ap-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 2px 10px;
        align-items: center;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-subtle);
    }
    .ap-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .ap-label { font-weight: 600; font-size: 13px; }
    .ap-ranges {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px;
        color: var(--text-secondary);
        overflow-wrap: anywhere;
    }
    .ap-meta { grid-column: 1 / 2; font-size: 11.5px; }
    .ap-revoke {
        grid-column: 2; grid-row: 1 / span 2;
        color: var(--danger); border-color: var(--danger-soft);
        font-size: 11.5px; padding: 3px 10px;
    }
    .ap-revoke:hover { background: var(--danger-soft); }

    .ap-form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    .ap-field { display: flex; flex-direction: column; gap: 3px; }
    .ap-field input {
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-input, var(--bg-subtle));
        color: var(--text-primary);
        font-size: 13px;
    }
    .ap-error { color: var(--danger); margin: 0; }

    .ap-token {
        margin: 8px 0;
        padding: 10px;
        border: 1px solid var(--accent);
        border-radius: 8px;
        background: var(--bg-subtle);
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-start;
    }
    .ap-token p { margin: 0; }
    .ap-token-row { display: flex; gap: 6px; width: 100%; }
    .ap-token-input {
        flex: 1;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-input, var(--bg-base));
        color: var(--text-primary);
    }
    .profile-card {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 16px;
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 8%, var(--bg-surface-alt)),
            var(--bg-surface-alt));
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
    }
    .profile-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .profile-text h3 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
    .profile-text p { margin: 0; font-size: 12.5px; color: var(--text-secondary); }
    .profile-text .profile-email { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
    .fuel-card {
        padding: 14px 16px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .fuel-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .fuel-head h4 {
        margin: 0;
        font-size: 12.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .fuel-pct {
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums;
        color: var(--accent-text);
    }
    .fuel-card.lvl-warn .fuel-pct { color: var(--warning); }
    .fuel-card.lvl-danger .fuel-pct { color: var(--danger); }
    .fuel-bar {
        position: relative;
        height: 10px;
        background: var(--bg-base);
        border-radius: 5px;
        border: 1px solid var(--border-subtle);
        overflow: hidden;
    }
    .fuel-bar span {
        display: block;
        height: 100%;
        position: relative;
        background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 50%, var(--warning)));
        /* Width comes in over ~700ms so the bar visibly fills on first paint
         * (looks intentional, not janky). */
        transition: width 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
        box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent);
    }
    /* Subtle highlight that sweeps across the fill so the gauge looks
     * "alive" without being noisy. */
    .fuel-bar span::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(255, 255, 255, 0.45) 50%,
            transparent 100%
        );
        transform: translateX(-100%);
        animation: fuel-shimmer 2.6s ease-in-out infinite;
    }
    @keyframes fuel-shimmer {
        0%   { transform: translateX(-100%); }
        60%  { transform: translateX(180%); }
        100% { transform: translateX(180%); }
    }
    .fuel-card.lvl-warn .fuel-bar span { background: linear-gradient(90deg, color-mix(in srgb, var(--warning) 60%, var(--bg-base)), var(--warning)); box-shadow: 0 0 8px color-mix(in srgb, var(--warning) 50%, transparent); }
    .fuel-card.lvl-danger .fuel-bar span { background: linear-gradient(90deg, #ef6464, var(--danger)); box-shadow: 0 0 8px color-mix(in srgb, var(--danger) 60%, transparent); }
    /* Unlimited: the fill is a moving stripe pattern instead of a fixed
     * percentage, signalling "no cap" without lying with a 100% bar. */
    .fuel-card.unlimited .fuel-bar span {
        background: repeating-linear-gradient(
            -45deg,
            color-mix(in srgb, var(--accent) 35%, transparent),
            color-mix(in srgb, var(--accent) 35%, transparent) 8px,
            color-mix(in srgb, var(--accent) 12%, transparent) 8px,
            color-mix(in srgb, var(--accent) 12%, transparent) 16px
        );
        background-size: 22.6px 22.6px; /* sqrt(2) * 16px so the stripes scroll seamlessly */
        animation: fuel-stripe-scroll 1.6s linear infinite;
        box-shadow: none;
    }
    .fuel-card.unlimited .fuel-bar span::after { display: none; }
    @keyframes fuel-stripe-scroll {
        0%   { background-position: 0 0; }
        100% { background-position: 22.6px 0; }
    }
    .fuel-card.unlimited .fuel-pct {
        font-size: 26px;
        font-weight: 700;
        line-height: 1;
        color: var(--accent-text);
        letter-spacing: 0;
    }
    @media (prefers-reduced-motion: reduce) {
        .fuel-bar span::after,
        .fuel-card.unlimited .fuel-bar span { animation: none; }
        .fuel-bar span { transition: none; }
    }
    .fuel-stats {
        display: flex;
        align-items: baseline;
        gap: 6px;
        font-size: 12.5px;
    }
    .fuel-stats strong { font-weight: 600; font-variant-numeric: tabular-nums; }
    .fuel-stats .dot { opacity: 0.5; }
    .alias-chips {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }
    .alias-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px 5px 6px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        font-size: 12px;
        max-width: 100%;
        transition: border-color var(--transition-fast), background-color var(--transition-fast);
    }
    .alias-chip:hover {
        border-color: color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-base));
    }
    .alias-chip-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: var(--accent-soft);
        color: var(--accent-text);
        flex: 0 0 auto;
    }
    .alias-chip-addr {
        font-family: var(--font-mono);
        font-size: 11.5px;
        color: var(--text-primary);
        max-width: 280px;
    }
    .alias-chip.inactive { opacity: 0.55; }
    .alias-chip.inactive .alias-chip-addr { text-decoration: line-through; }
    .alias-chip-badge {
        font-size: 9.5px;
        padding: 1px 6px;
        background: var(--bg-tag);
        color: var(--text-tertiary);
        border-radius: 8px;
        text-transform: uppercase;
        font-weight: 700;
        letter-spacing: 0.05em;
    }
    .session-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .session-list li {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 0;
    }
    .session-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .session-user { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
    .active-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--accent-soft);
        color: var(--accent-text);
        border-radius: 999px;
    }
    .device-config {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin: 8px 0;
    }
    @media (max-width: 640px) {
        .device-config { grid-template-columns: 1fr; }
    }
    .config-block {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 12px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        font-size: 12px;
    }
    .config-block strong {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--text-secondary);
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
    }
    .config-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
    }
    .config-row span {
        color: var(--text-tertiary);
        font-size: 11.5px;
    }
    .config-row code {
        font-family: var(--font-mono);
        font-size: 11.5px;
        color: var(--text-primary);
        background: var(--bg-surface-alt);
        padding: 2px 6px;
        border-radius: var(--radius-xs);
        border: 1px solid var(--border-subtle);
        overflow-wrap: anywhere;
        max-width: 100%;
    }
    .login-rows {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .login-row {
        display: grid;
        grid-template-columns: 8px auto auto minmax(0, 1fr) minmax(0, auto);
        gap: 10px;
        align-items: center;
        padding: 6px 8px;
        border-radius: var(--radius-sm);
        font-size: 12.5px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        min-width: 0;
    }
    .login-row.fail { background: color-mix(in srgb, var(--danger) 6%, var(--bg-base)); }
    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-tertiary);
    }
    .status-dot.ok { background: var(--success); box-shadow: 0 0 6px color-mix(in srgb, var(--success) 60%, transparent); }
    .status-dot.fail { background: var(--danger); }
    .login-svc {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-weight: 600;
        text-transform: uppercase;
        font-size: 11px;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        min-width: 60px;
    }
    .login-time { color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .login-ip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-family: var(--font-mono);
        font-size: 11px;
        color: var(--text-secondary);
        min-width: 0;
        overflow: hidden;
    }
    .login-ip .ip-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .login-flag {
        font-size: 13px;
        line-height: 1;
        font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
    }
    .ip-copy {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: var(--radius-xs);
        color: var(--text-tertiary);
    }
    .ip-copy:hover { background: var(--bg-hover); color: var(--text-primary); }
    .badges { display: inline-flex; gap: 4px; flex-wrap: wrap; min-width: 0; }
    .badges .badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 7px;
        border-radius: 8px;
        font-size: 10px;
        font-weight: 600;
        background: var(--bg-tag);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .badges .badge.int {
        background: color-mix(in srgb, var(--accent) 12%, var(--bg-base));
        color: var(--accent-text);
    }
    .badges .badge.danger {
        background: var(--danger-soft);
        color: var(--danger);
    }
    .appearance-skin-title {
        margin: 6px 0 0;
        font-size: 12.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
    }
    .prompt-area {
        width: 100%;
        padding: 10px 12px;
        font-family: var(--font-mono);
        font-size: 12.5px;
        line-height: 1.5;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        resize: vertical;
    }
    .prompt-area:focus {
        outline: none;
        border-color: var(--border-focus);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .default-from {
        width: 100%;
        padding: 8px 10px;
        font-size: 13px;
        font-family: var(--font-mono);
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
    }
    .default-from:focus {
        outline: none;
        border-color: var(--border-focus);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .seg-narrow button { padding: 4px 8px; min-width: 32px; font-size: 11.5px; }
    .seg-narrow button:last-child { font-size: 14px; line-height: 1; }
    .avatar-upload-btn {
        position: relative;
        padding: 0;
        border: 0;
        background: transparent;
        border-radius: 50%;
        cursor: pointer;
        flex: 0 0 auto;
    }
    .avatar-upload-overlay {
        position: absolute;
        right: -2px;
        bottom: -2px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: var(--accent);
        color: var(--text-on-accent);
        border-radius: 50%;
        border: 2px solid var(--bg-surface);
        box-shadow: var(--shadow-sm);
        opacity: 0.92;
        transition: transform var(--transition-fast);
    }
    .avatar-upload-btn:hover .avatar-upload-overlay { transform: scale(1.08); }
    .btn.btn-ghost.small { font-size: 11px; padding: 3px 8px; margin-top: 4px; }
    @media (max-width: 720px) {
        .body { grid-template-columns: 1fr; }
        .tabs {
            flex-direction: row;
            border-right: 0;
            border-bottom: 1px solid var(--border-subtle);
            overflow-x: auto;
            padding: 8px;
        }
        .tab { flex: 0 0 auto; padding: 6px 10px; }
        .tab span { font-size: 12px; }
    }
    .foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 12px 20px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    .foot .muted { font-size: 12px; flex: 1; }
    .section-head h3 {
        margin: 0 0 4px;
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.01em;
    }
    .section-head .muted { margin: 0 0 12px; font-size: 12px; line-height: 1.5; }
    /* h4-style subsection divider used inside the Appearance tab. The icon
     * sits before the label and picks up the accent so each group is
     * visually anchored against the same colour as the active tab pill. */
    h4.section-head {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 18px 0 6px;
        padding: 0 0 4px;
        font-size: 11.5px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border-subtle);
    }
    h4.section-head :global(svg) { color: var(--accent); flex-shrink: 0; }
    h4.section-head:first-of-type { margin-top: 6px; }
    .banner {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: var(--radius-md);
        font-size: 12px;
        margin-bottom: 12px;
    }
    .banner.warn { background: var(--warning-soft); color: color-mix(in srgb, var(--warning) 80%, var(--text-primary)); }
    .banner.ok { background: var(--accent-soft); color: var(--accent-text); }
    .banner code { font-family: var(--font-mono); }
    .toggle {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
    }
    .toggle input { width: 16px; height: 16px; accent-color: var(--accent); }
    .form {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        transition: opacity var(--transition-fast);
    }
    .form.disabled { opacity: 0.55; pointer-events: none; }
    .row { display: grid; grid-template-columns: 96px 1fr; align-items: center; gap: 10px; }
    .lbl {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
    }
    .row input, .row select { width: 100%; }
    .seg {
        display: inline-flex;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 2px;
        gap: 0;
    }
    .seg button {
        flex: 1;
        padding: 6px 12px;
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
    .hint {
        font-size: 11px;
        color: var(--text-tertiary);
        padding-left: 106px;
        margin-top: -4px;
    }
    /* The Model row carries a field plus a datalist, grouped chips, an empty
       state and a status line — five children, which is four too many for a
       two-column grid, and every one past the second is auto-placed into the
       96px label cell. That is what made the status line wrap one word per
       line. Nesting the trailing blocks in their own single-column grid and
       pinning it to column 2 places every one of them deliberately. */
    .row-body {
        grid-column: 2;
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
        min-width: 0;
    }
    /* .hint carries a 106px left gutter so it aligns under a field that lives
       in a two-column row. Inside .row-body the block is ALREADY in the value
       column, so that gutter would indent the text a second time; cancel it. */
    .row-body .hint { padding-left: 0; margin-top: 0; }
    /* Grouped model choices. Lives in .row-body's single column, so it lines
       up with the field's value column rather than under the label. */
    .model-groups {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .model-group {
        display: flex;
        flex-direction: column;
        gap: 5px;
    }
    .model-group-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
    }
    .model-group-note {
        font-size: 11px;
        color: var(--text-tertiary);
    }
    .model-group-chip {
        font: inherit;
        font-size: 12px;
        font-family: var(--font-mono, monospace);
        padding: 4px 9px;
        border-radius: 999px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-base);
        color: var(--text-secondary);
        cursor: pointer;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        transition: border-color var(--transition-fast), background-color var(--transition-fast), color var(--transition-fast);
    }
    .model-group-chip:hover {
        border-color: color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-base));
        color: var(--text-primary);
    }
    /* The selected state is accent-filled rather than a border change: with a
       577-model catalog these chips sit in a dense row and a one-pixel hint is
       easy to lose, while the filled chip is the same shape the user clicked
       everywhere else in Settings. */
    .model-group-chip.selected {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--text-on-accent);
        font-weight: 600;
    }
    @media (prefers-reduced-motion: reduce) {
        .model-group-chip { transition: none; }
    }
    .actions {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 16px;
        flex-wrap: wrap;
    }
    .test-result {
        font-size: 12px;
        max-width: 380px;
        line-height: 1.5;
    }
    .test-result.ok { color: var(--success); }
    .test-result.err { color: var(--danger); }
    .form-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 0;
        flex-wrap: wrap;
    }
    .form-row + .form-row { border-top: 1px solid var(--border-subtle); }
    /* The AI master switch leads the section and is the only control that
       removes most of the UI, so it gets a top rule of its own rather
       than borrowing the "another row in a list" treatment the .form-row
       pairs below it use. */
    .ai-master-row {
        margin: 0 0 4px;
        padding: 12px 0;
        border-top: 1px solid var(--border-subtle);
    }
    .ai-master-row + .form-row { border-top: none; padding-top: 0; }
    .row-text {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .row-text strong { font-size: 13px; font-weight: 600; }
    .row-text .muted { font-size: 12px; line-height: 1.45; }
    .toggle.compact { margin: 0; gap: 6px; font-size: 12px; }
    .toggle.compact input { width: 14px; height: 14px; }
    /* Red glow when privacy proxy is active — security signal, not accent. */
    .toggle.spy-on span {
        color: #ff5b6b;
        font-weight: 600;
        text-shadow: 0 0 8px rgba(255, 91, 107, 0.55);
        animation: spy-pulse 2.6s ease-in-out infinite;
    }
    @keyframes spy-pulse {
        0%, 100% { text-shadow: 0 0 6px rgba(255, 91, 107, 0.40); }
        50%      { text-shadow: 0 0 14px rgba(255, 91, 107, 0.75); }
    }
    @media (prefers-reduced-motion: reduce) {
        .toggle.spy-on span { animation: none; }
    }
    /* --- Privacy panel --------------------------------------------------- */
    /* The state line is a status sentence, not a toggle: it needs to read
       as prose with a small leading glyph, and must wrap cleanly on a
       narrow pane rather than running the icon onto its own line. */
    .privacy-state {
        display: flex;
        align-items: flex-start;
        gap: 7px;
        margin: 0 0 4px;
        line-height: 1.45;
    }
    .privacy-state :global(svg) { flex: 0 0 auto; margin-top: 2px; }
    .privacy-state strong { color: var(--text-primary); }
    /* The claim list. Generous leading because these are sentences the user
       is meant to actually read, not a feature matrix. */
    .privacy-facts {
        list-style: none;
        margin: 10px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 9px;
    }
    .privacy-facts li {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        line-height: 1.5;
        color: var(--text-secondary);
    }
    .privacy-facts li :global(svg) { flex: 0 0 auto; margin-top: 3px; opacity: 0.75; }
    /* The provenance of each claim, rendered small and monospaced. It is
       load-bearing, not decoration: it is how a future change that breaks a
       claim gets found instead of quietly shipping a lie. */
    .privacy-cite {
        display: block;
        margin-top: 3px;
        font-size: 10.5px;
        color: var(--text-tertiary);
        opacity: 0.75;
        word-break: break-word;
        user-select: all;
    }
    .privacy-footnote { margin: 12px 0 0; padding-top: 10px; border-top: 1px dashed var(--border-subtle); }
    .sound-controls { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
    /* Phishing scan extra knobs that appear under the on/off toggle. */
    .phish-knobs {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px dashed var(--border-subtle);
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    .phish-knobs .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .phish-knobs .lbl {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .phish-knobs .lbl-val {
        color: var(--accent-text);
        font-variant-numeric: tabular-nums;
        font-weight: 700;
    }
    .phish-knobs input[type=range] {
        width: 100%;
        accent-color: var(--accent);
    }
    .phish-knobs textarea {
        width: 100%;
        font-family: inherit;
        font-size: 12.5px;
        padding: 8px 10px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        resize: vertical;
    }
    .phish-knobs textarea:focus {
        outline: none;
        border-color: var(--accent);
    }
    .push-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .push-diag-list {
        list-style: none;
        margin: 8px 0 0;
        padding: 8px 12px;
        font-size: 12.5px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .push-diag-list li {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 0;
        color: var(--danger, #dc2626);
    }
    .push-diag-list li::before {
        content: '✕';
        font-weight: 700;
    }
    .push-diag-list li.ok {
        color: var(--text-secondary);
    }
    .push-diag-list li.ok::before {
        content: '✓';
        color: var(--success);
    }
    .push-diag-list li.neutral { color: var(--text-tertiary); }
    .push-diag-list li.neutral::before { content: '·'; color: var(--text-tertiary); }
    /* Sounds tab — per-event preset rows. */
    .sound-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .sound-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: center;
        padding: 8px 0;
        border-bottom: 1px dashed var(--border-subtle);
    }
    .sound-row:last-child { border-bottom: none; }
    .sound-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    /* Each style gets its own block, so the two families read as two
       labelled groups rather than one undifferentiated wall of pills.
       .sound-groups is a column because the row is a 1fr/auto grid —
       stacking keeps the label column from being squeezed to nothing. */
    .sound-groups { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
    .sound-group { display: flex; align-items: center; gap: 6px; }
    .sound-group-lbl {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text-tertiary);
        white-space: nowrap;
    }
    .sound-pills { display: inline-flex; gap: 4px; flex-shrink: 0; }
    .sound-pill {
        padding: 4px 10px;
        font-size: 11.5px;
        font-weight: 600;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        color: var(--text-secondary);
        cursor: pointer;
    }
    .sound-pill:hover { background: var(--bg-hover); color: var(--text-primary); }
    .sound-pill.active {
        background: var(--accent);
        color: var(--text-on-accent, white);
        border-color: var(--accent);
    }
    @media (max-width: 560px) {
        .sound-row { grid-template-columns: 1fr; }
        .sound-groups { align-items: stretch; }
        .sound-group { flex-wrap: wrap; }
        .sound-pills { flex-wrap: wrap; }
    }
    .filter-block { padding: 10px 0; border-top: 1px solid var(--border-subtle); }
    .filter-block:first-of-type { border-top: 0; }
    .filter-block h4 {
        margin: 0 0 8px;
        font-size: 12.5px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .filter-block .count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--bg-tag);
        color: var(--text-tertiary);
        font-size: 10px;
        font-weight: 700;
    }
    .add-row {
        display: flex;
        gap: 6px;
        margin-bottom: 8px;
    }
    .add-row input { flex: 1; }
    /* Contact rows. A list rather than chips because a contact has a name, an
     * address, a note and provenance ("seen 3 days ago · 12 mentions") —
     * four facts do not fit on one pill line, and truncating them would hide
     * the very thing that distinguishes a saved contact from a bare address
     * harvested from a message. */
    .contact-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .contact-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: var(--radius-xs);
    }
    .contact-row:hover { background: var(--bg-hover); }
    /* The row being edited is tinted so it is obvious which one the form
     * above will overwrite — otherwise an edit looks like an add. */
    .contact-row.editing {
        background: color-mix(in srgb, var(--accent) 8%, transparent);
    }
    .contact-row .row-text { flex: 1; min-width: 0; }
    .contact-addr {
        font-family: var(--font-mono);
        font-size: 11.5px;
        color: var(--text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .chip-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }
    .policy-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 4px 4px 10px;
        border-radius: 999px;
        background: var(--danger-soft);
        color: var(--danger);
        font-size: 12px;
        font-family: var(--font-mono);
        max-width: 100%;
        overflow: hidden;
    }
    .policy-chip span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .policy-chip.allow {
        background: var(--success-soft);
        color: var(--success);
    }
    .policy-chip button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        color: inherit;
        opacity: 0.7;
    }
    .policy-chip button:hover { opacity: 1; background: rgba(0, 0, 0, 0.1); }

    .rule-form {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin: 8px 0 10px;
        padding: 10px 12px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
    }
    .rule-row {
        display: grid;
        grid-template-columns: 100px 1fr;
        align-items: center;
        gap: 8px;
        font-size: 12px;
    }
    .rule-row .rule-label {
        font-weight: 600;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 11px;
    }
    /* Stacked variant: the label sits on its own line above a tall editor,
     * and centres on the first row rather than floating mid-block. */
    .rule-row-stack {
        align-items: start;
        grid-template-columns: 100px 1fr;
    }
    /* The paste box. One block: a real <label> above a monospaced textarea,
     * the format hint under it, and the per-line error list below that.
     * min-width: 0 so the monospaced textarea can shrink inside the
     * 1fr grid track instead of forcing the dialog wider. */
    .ow-headers { min-width: 0; }
    .ow-headers-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-tertiary);
    }
    .ow-headers-input {
        width: 100%;
        /* Monospaced because the content IS a wire format: a bearer token
         * read in a proportional face hides the characters that matter,
         * and these lines are compared by eye against a provider's docs. */
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 12px;
        line-height: 1.5;
        padding: 7px 9px;
        background: var(--bg-base);
        color: var(--text-primary);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        /* resize: vertical only — a horizontally resizable textarea
         * fights the two-column .rule-row grid instead of helping. */
        resize: vertical;
        white-space: pre;
        overflow-wrap: normal;
        overflow-x: auto;
    }
    .ow-headers-input:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
    }
    .ow-headers p code {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    }
    /* Per-line errors. Indented with a left rule rather than a background
     * wash: the box itself is the thing being complained about, and a red
     * panel around it hides the lines it is talking about. */
    .ow-headers-errors {
        margin: 0;
        padding: 0 0 0 10px;
        list-style: none;
        border-left: 2px solid var(--danger);
        color: var(--danger);
        font-size: 11.5px;
        display: flex;
        flex-direction: column;
        gap: 3px;
    }
    /* The write-only contract, stated where the masks are visible. Warm
     * neutral rather than a warning colour: nothing is wrong, the value is
     * simply unreadable, and a red box here would read as an error state
     * on a form that is working exactly as designed. */
    .ow-headers-mask-note {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        margin: 0;
        font-size: 11.5px;
        line-height: 1.45;
        color: var(--text-secondary);
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 6px 8px;
    }
    .ow-headers-mask-note :global(svg) { flex: none; margin-top: 2px; }
    /* The prose span is the one text flex item; the <code> elements are
     * inside it, so they flow as inline text and the sentence wraps as a
     * paragraph. flex: 1 also gives it min-width: 0, so a long unmasked
     * token inside it cannot stretch the card. */
    .ow-headers-mask-note > span { flex: 1; min-width: 0; }
    .ow-headers-mask-note code {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        background: var(--bg-base);
        border-radius: var(--radius-xs);
        padding: 0 3px;
    }
    .ow-headers-edit { margin-top: 6px; }
    .ow-headers-edit-actions { display: flex; gap: 6px; }
    .ow-headers-edit-actions .btn { flex: none; }
    .rule-row select, .rule-row input {
        padding: 5px 8px;
        font-size: 12px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        color: var(--text-primary);
    }
    .rule-actions { display: flex; justify-content: flex-end; margin-top: 4px; }
    .rule-cards {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .trusted-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }
    .trusted-list li {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 4px 3px 10px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        font-size: 12px;
        max-width: 100%;
    }
    .trusted-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        background: transparent;
        color: var(--text-tertiary);
        border: 0;
        border-radius: 50%;
        cursor: pointer;
    }
    .trusted-remove:hover { background: var(--bg-hover); color: var(--text-primary); }
    .rule-card {
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-left: 3px solid var(--border-soft);
        border-radius: var(--radius-md);
        padding: 10px 12px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    .rule-card:hover { box-shadow: var(--shadow-sm); }
    .rule-card.rule-discard { border-left-color: var(--danger); }
    .rule-card.rule-redirect { border-left-color: var(--accent); }
    .rule-card.rule-copy { border-left-color: var(--warning); }
    .rule-card-head {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .rule-name {
        font-size: 12.5px;
        font-weight: 600;
        flex: 1;
        min-width: 0;
        color: var(--text-primary);
    }
    .rule-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: var(--radius-sm);
        color: var(--text-tertiary);
        opacity: 0;
        transition: opacity var(--transition-fast), background-color var(--transition-fast), color var(--transition-fast);
    }
    .rule-card:hover .rule-remove { opacity: 1; }
    .rule-remove:hover { background: var(--danger-soft); color: var(--danger); }
    .rule-card-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .rule-clause {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 6px;
        font-size: 12.5px;
        line-height: 1.55;
        color: var(--text-secondary);
    }
    .rule-when {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 40px;
        padding: 1px 8px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--bg-tag);
        color: var(--text-tertiary);
        border-radius: 999px;
    }
    .rule-cond {
        font-weight: 500;
        color: var(--text-primary);
    }
    .rule-val {
        font-family: var(--font-mono);
        font-size: 11.5px;
        padding: 2px 8px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        color: var(--text-primary);
    }
    .rule-action-text { color: var(--text-secondary); }
    .rule-action-text.muted { color: var(--text-tertiary); font-size: 11.5px; }
    .rule-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px 2px 6px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .rule-badge.rule-discard { background: var(--danger-soft); color: var(--danger); }
    .rule-badge.rule-redirect { background: var(--accent-soft); color: var(--accent-text); }
    .rule-badge.rule-copy { background: color-mix(in srgb, var(--warning) 14%, var(--bg-surface-alt)); color: var(--warning); }

    /* Free-text prefix prepended to webhook payloads. It shipped with a class
     * and no rule, so it rendered as a bare unstyled text box inside the
     * webhook card. Match the .rule-clause inputs it sits next to. */
    .ow-prepend-edit {
        width: 100%;
        font-family: inherit;
        font-size: 12px;
        padding: 5px 8px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        color: var(--text-primary);
    }
    .ow-prepend-edit:focus {
        outline: none;
        border-color: var(--accent);
    }
    .ow-prepend-edit::placeholder { color: var(--text-tertiary); }

    /* Per-card actions: test send and details sit on one line, with the
       webhook id pushed to the right so it never reads as another control. */
    .ow-card-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 2px;
    }
    .ow-card-actions .btn { flex: none; }
    .ow-id {
        margin-left: auto;
        font-family: var(--font-mono);
        font-size: 10.5px;
        color: var(--text-tertiary);
        background: none;
        border: 0;
        padding: 0;
    }
    /* Details panel: a definition list, because every row really is a
       term/value pair and a grid of divs would need the same rules. */
    .ow-details {
        display: grid;
        gap: 4px;
        margin: 4px 0 0;
        padding: 8px 10px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        font-size: 11.5px;
    }
    .ow-details > div {
        display: grid;
        grid-template-columns: 90px minmax(0, 1fr);
        gap: 8px;
        align-items: baseline;
    }
    .ow-details dt {
        color: var(--text-tertiary);
        font-weight: 600;
        text-transform: uppercase;
        font-size: 9.5px;
        letter-spacing: 0.04em;
    }
    .ow-details dd {
        margin: 0;
        color: var(--text-secondary);
        min-width: 0;
        overflow-wrap: anywhere;
    }
    .ow-details code {
        font-family: var(--font-mono);
        font-size: 11px;
    }
    /* Test result: the point of the whole panel is seeing what the receiver
       said, so the reply gets its own block in monospace and wraps rather
       than truncating — the server already capped it at 300 characters. */
    .ow-test-result {
        border: 1px solid var(--danger-soft);
        background: var(--danger-soft);
        border-radius: var(--radius-xs);
        padding: 7px 9px;
        display: flex;
        flex-direction: column;
        gap: 5px;
    }
    .ow-test-result.ow-test-ok {
        border-color: var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    .ow-test-status {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11.5px;
        color: var(--text-primary);
        flex-wrap: wrap;
    }
    .ow-test-status .muted { font-size: 10.5px; }
    .ow-test-status .btn-ghost { margin-left: auto; }
    .ow-test-reply {
        margin: 0;
        max-height: 140px;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-family: var(--font-mono);
        font-size: 11px;
        line-height: 1.45;
        color: var(--text-secondary);
    }

    .alias-rows {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .alias-rows li {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto 28px;
        align-items: center;
        gap: 10px;
        padding: 4px 0;
    }
    .small { font-size: 11px; }
    .skins-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 8px;
    }
    .skin-tile {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        text-align: left;
        cursor: pointer;
        transition: border-color var(--transition-fast), background-color var(--transition-fast);
        position: relative;
    }
    .skin-tile:hover { background: var(--bg-hover); }
    .skin-tile.active {
        border-color: var(--accent);
        box-shadow: 0 0 0 1px var(--accent) inset;
    }
    .skin-tile .swatch {
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 1px solid var(--border-subtle);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
    }
    .skin-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
    }
    .skin-meta strong { font-size: 12.5px; font-weight: 600; }
    .skin-meta .muted {
        font-size: 11px;
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
    }
    .skin-tile.custom { cursor: default; }
    .skin-tile.custom input[type="color"] {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
        border: 0;
        padding: 0;
        background: transparent;
    }
    .semantic-colours {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
    }
    .semantic-colours .appearance-skin-title { margin: 0; }
    .colour-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
    }
    .colour-chip {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: border-color var(--transition-fast);
        position: relative;
    }
    .colour-chip:hover { border-color: var(--border-soft); }
    .colour-chip .swatch {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: 1px solid var(--border-subtle);
        flex: 0 0 auto;
    }
    .colour-chip .lbl {
        font-size: 12px;
        font-weight: 500;
        color: var(--text-secondary);
    }
    .colour-chip input[type="color"] {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
        border: 0;
        padding: 0;
        background: transparent;
    }
    .semantic-colours .btn.small {
        align-self: flex-start;
        font-size: 11.5px;
        padding: 5px 10px;
    }

    /* Collapsible section headers */
    .collapse-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: 10px 0;
        background: transparent;
        border: none;
        color: var(--text-primary);
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        text-align: left;
        transition: color var(--transition-fast);
    }
    .collapse-header:hover { color: var(--accent-text); }
    .collapse-header span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .collapse-header .count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--bg-tag);
        color: var(--text-tertiary);
        font-size: 10px;
        font-weight: 700;
    }
    .collapse-header.small {
        padding: 6px 0;
        font-size: 11.5px;
        color: var(--text-secondary);
    }
    .collapse-header.small:hover { color: var(--accent-text); }
    .collapse-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 4px 0 8px;
        animation: fade-in 180ms ease;
    }
    @keyframes fade-in {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
        .collapse-body { animation: none; }
    }
</style>
