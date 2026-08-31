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
        settings, capabilities, setLlm, setUseCustomLlm, setDensity, setAlwaysAllowImages, setGroupThreads, setProxyImages, setPermanentSignIn, setPhishingScan, setTrackOpensDefault, setAiSuggestSubjectOnBlur, setPhishingScanTimeoutSec, setPhishingScanPromptAddendum, setPhishingScanConfidenceFloor,
        setKeyboardShortcuts, setAiSystemPrompt, setAccountChipDisplay,
        setDefaultFromAddress, setDisplayName, deriveNameFromAddress, setPageSize,
        addClientRule, updateClientRule, removeClientRule,
        type ClientRuleConditionType, type ClientRuleActionType,
        setTesseractOcrInstalled, setPhishingScanOcrInline,
        setSpamSuggest, setSpamSuggestConfidenceFloor, setSpamSweepBatchSize, setAiSortSweepSpam,
        setVipAddresses
    } from '../lib/settings.svelte';
    import { runSpamSweep, bulkMove, type SweepCandidate } from '../lib/spam-sweep';
    import { warmupTesseract, teardownTesseract } from '../lib/tesseract-ocr';
    import { showToast } from '../lib/store.svelte';
    import { summarizeMessage } from '../lib/api';
    import { trapFocus } from '../lib/focus-trap';
    import { pwa, promptInstall, subscribePush, unsubscribePush, pushSubscriptionStatus, diagnosePush, sendTestPush, type PushDiagnostics } from '../lib/pwa.svelte';
    import { authState, getSession, isRemembered, forgetSavedCreds } from '../lib/auth.svelte';
    import {
        sounds, setMuted, playNotify,
        SOUND_EVENTS, setEventPack, resetSoundProfile, previewPack,
        type SoundPack
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
        ApiError, type MailboxInfo, type LoginEntry, type AliasEntry,
        type TempAliasEntry, type SenderPolicy,
        type MailRule, type MailRuleConditionType, type MailRuleActionType
    } from '../lib/api';
    import { formatBytes, formatFullDate } from '../lib/format';
    import Icon from './Icon.svelte';
    import Avatar from './Avatar.svelte';
    import { ensureCountry, geoipCache, flagEmoji } from '../lib/geoip.svelte';
    import type { IconName } from '../lib/icons';

    type TabId = 'account' | 'security' | 'privacy' | 'phishing' | 'filters' | 'mail-rules' | 'compose' | 'appearance' | 'sounds' | 'ai' | 'notifications';
    let activeTab = $state<TabId>('account');

    // Sweep state lives at the top so the runner survives tab switches.
    let sweepRunning = $state(false);
    let sweepProgressText = $state('');
    let sweepResults = $state<SweepCandidate[] | null>(null);
    let sweepDestSpam = $state<string | null>(null);
    let sweepDestTrash = $state<string | null>(null);
    let sweepAbort: AbortController | null = null;
    let sweepBulkBusy = $state(false);

    async function startSweep() {
        if (sweepRunning) return;
        sweepRunning = true;
        sweepResults = null;
        sweepProgressText = 'Starting…';
        sweepAbort?.abort();
        sweepAbort = new AbortController();
        try {
            const out = await runSpamSweep({
                signal: sweepAbort.signal,
                onProgress: (p) => {
                    sweepProgressText = `Scanned ${p.scanned}/${p.total} — ${p.flagged} flagged`;
                }
            });
            sweepResults = out.candidates;
            sweepDestSpam = out.spamPath;
            sweepDestTrash = out.trashPath;
            sweepProgressText = `Done. ${out.candidates.length} flagged.`;
        } catch (err) {
            sweepProgressText = (err as Error).message || 'Sweep failed';
        } finally {
            sweepRunning = false;
        }
    }

    function cancelSweep() {
        sweepAbort?.abort();
        sweepRunning = false;
        sweepProgressText = 'Cancelled.';
    }

    async function applySweep(kind: 'spam' | 'phishing') {
        if (!sweepResults || sweepBulkBusy) return;
        const dest = kind === 'spam' ? sweepDestSpam : sweepDestTrash;
        if (!dest) {
            showToast('error', kind === 'spam' ? 'No Spam folder found.' : 'No Trash folder found.');
            return;
        }
        const items = sweepResults
            .filter((c) => kind === 'spam' ? c.isSpam && !c.isPhishing : c.isPhishing)
            .map((c) => ({ path: c.path, uid: c.uid }));
        if (items.length === 0) return;
        sweepBulkBusy = true;
        try {
            const r = await bulkMove(items, dest);
            showToast('success', `Moved ${r.moved} message${r.moved === 1 ? '' : 's'} to ${dest}${r.failed ? ` (${r.failed} failed)` : ''}.`);
            // Drop the moved rows from the result list so the user doesn't
            // see "5 flagged" while they're already gone.
            sweepResults = sweepResults.filter((c) => !items.some((i) => i.uid === c.uid));
        } finally {
            sweepBulkBusy = false;
        }
    }

    // Tabs in the order they read top-to-bottom. Privacy and Filters are
    // separate now — privacy is image-loading + tracker behaviour;
    // filters is the blocked/allowed sender + recipient + sieve rule list.
    const TABS: { id: TabId; label: string; icon: IconName }[] = [
        { id: 'account', label: 'Account', icon: 'user' },
        { id: 'security', label: 'Security', icon: 'shield' },
        { id: 'privacy', label: 'Privacy', icon: 'eye' },
        { id: 'phishing', label: 'AI scam scan', icon: 'shieldAlert' },
        { id: 'filters', label: 'Filters & blocks', icon: 'filter' },
        { id: 'mail-rules', label: 'Mail rules', icon: 'filter' },
        { id: 'compose', label: 'Compose', icon: 'pencil' },
        { id: 'appearance', label: 'Appearance', icon: 'palette' },
        { id: 'sounds', label: 'Sounds', icon: 'bell' },
        { id: 'ai', label: 'AI', icon: 'sparkles' },
        { id: 'notifications', label: 'Notifications', icon: 'bell' }
    ];

    // --- Collapsible section state -------------------------------------------------
    let showBlockedSenders = $state(true);
    let showAllowedSenders = $state(true);
    let showBlockedRecipients = $state(true);
    let showMailRules = $state(true);
    let showAiAdvanced = $state(false);
    let trustedAddInput = $state('');
    let showClientRules = $state(true);

    let clientRuleConditionType = $state<ClientRuleConditionType>('from-domain');
    let clientRuleConditionValue = $state('');
    let clientRuleActionType = $state<ClientRuleActionType>('archive');
    let clientRuleActionFolder = $state('');

    function doAddClientRule() {
        const value = clientRuleConditionValue.trim();
        if (!value) { showToast('error', 'Condition value is required'); return; }
        if (clientRuleActionType === 'move' && !clientRuleActionFolder.trim()) {
            showToast('error', 'Folder is required for Move actions'); return;
        }
        const name = `${clientRuleConditionType.replace('-', ' ')} "${value}" → ${clientRuleActionType.replace(/-/g, ' ')}`.slice(0, 100);
        addClientRule({
            name,
            condition: { type: clientRuleConditionType, value },
            action: clientRuleActionType === 'move'
                ? { type: 'move', folder: clientRuleActionFolder.trim() }
                : { type: clientRuleActionType }
        });
        clientRuleConditionValue = '';
        clientRuleActionFolder = '';
        showToast('success', 'Rule added — will fire on the next inbox load.');
    }

    function doResetSeen() {
        const user = authState.activeUser || '';
        if (!user) return;
        import('../lib/client-rules').then((mod) => {
            mod.clearSeenCache(user);
            showToast('info', 'Cleared rule-history cache. Next inbox load will re-run rules over recent messages.');
        });
    }
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
    let blockInput = $state('');
    let allowInput = $state('');
    let blockRecipientInput = $state('');
    let creatingAlias = $state(false);

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
        copy: 'Copy (forward + keep)'
    };

    async function loadAccountData() {
        try {
            const m = await getMailboxInfo();
            mailboxInfo = m;
        } catch (err) {
            if (err instanceof ApiError && err.status >= 500) mailcowDbUnavailable = true;
        }
        try { const r = await getLogins(10); logins = r.logins; } catch { /* skip */ }
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
            : `${a.type} → ${a.to || ''}`;
        return `${cTxt} → ${aTxt}`;
    }

    async function doAddRule() {
        const value = ruleConditionValue.trim();
        if (!value) { showToast('error', 'Condition value is required'); return; }
        if (ruleHasTarget(ruleActionType) && !ruleActionTo.trim()) {
            showToast('error', 'Forward address is required'); return;
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
            <aside class="tabs" role="tablist" aria-label="Settings sections">
                {#each TABS as t (t.id)}
                    <button
                        type="button"
                        role="tab"
                        class="tab"
                        class:active={activeTab === t.id}
                        aria-selected={activeTab === t.id}
                        onclick={() => (activeTab = t.id)}
                        data-testid={`settings-tab-${t.id}`}
                    >
                        <Icon name={t.icon} size={15} />
                        <span>{t.label}</span>
                    </button>
                {/each}
            </aside>

            <div class="panel">
            {#if activeTab === 'account'}
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

                    {#if aliases.length}
                        <div class="card">
                            <h4><Icon name="at" size={13} /> Forwarding to you ({aliases.length})</h4>
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

            {:else if activeTab === 'security'}
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

                    <div class="card">
                        <h4><Icon name="wifi" size={13} /> Connect a device</h4>
                        <p class="muted small">
                            Use these settings to add this account to Apple Mail, Outlook, Thunderbird, or any IMAP client.
                        </p>
                        {#if true}
                            {@const deviceEmail = authState.activeUser || 'you@example.com'}
                            {@const deviceDomain = deviceEmail.split('@')[1] || 'example.com'}
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
                        {/if}
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

            {:else if activeTab === 'privacy'}
                <section class="tab-section" data-testid="settings-privacy">
                    <h3>Privacy</h3>
                    <p class="muted small">Image loading and tracker behaviour. AI scam scan &amp; spam settings live in their own tab.</p>

                    <div class="card">
                        <h4><Icon name="eye" size={13} /> Image handling</h4>
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Route images through privacy proxy</strong>
                                <span class="muted">
                                    Loads every remote image via /v1/proxy/image so the sender's CDN
                                    never sees your IP, user-agent, or open time. Subject to the
                                    server-side daily cap (default 100&nbsp;MB).
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
                        <div class="form-row">
                            <div class="row-text">
                                <strong>Always allow remote images</strong>
                                <span class="muted">
                                    Skip the per-message "Load remote content?" prompt and load images
                                    for every email. Convenient, but lets senders see when you've opened
                                    their message via tracking pixels.
                                </span>
                            </div>
                            <label class="toggle compact">
                                <input
                                    type="checkbox"
                                    checked={settings.alwaysAllowImages}
                                    onchange={(e) => setAlwaysAllowImages((e.currentTarget as HTMLInputElement).checked)}
                                    data-testid="settings-always-allow-images"
                                />
                                <span>{settings.alwaysAllowImages ? 'On' : 'Off'}</span>
                            </label>
                        </div>
                    </div>

                </section>

            {:else if activeTab === 'phishing'}
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

            {:else if activeTab === 'compose'}
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

            {:else if activeTab === 'filters'}
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

            {:else if activeTab === 'mail-rules'}
                <section class="tab-section" data-testid="settings-mail-rules">
                    <h3>Mail rules</h3>
                    <p class="muted small">
                        Server-side Sieve rules — unified blocks, redirects, and copies, plus
                        client-side rules for moving messages and assigning AI actions.
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

                    <div class="filter-block" data-testid="client-rules-block">
                        <button
                            type="button"
                            class="collapse-header"
                            onclick={() => showClientRules = !showClientRules}
                            aria-expanded={showClientRules}
                        >
                            <span>
                                <Icon name="sparkles" size={13} /> Client-side rules
                                <span class="count">{settings.clientRules.length}</span>
                            </span>
                            <Icon name={showClientRules ? 'chevronUp' : 'chevronDown'} size={14} />
                        </button>
                        {#if showClientRules}
                            <div class="collapse-body">
                                <p class="muted small">
                                    Run when the inbox loads in this browser. The matching message
                                    is moved to a folder, archived, trashed, marked read, or
                                    handed to an AI action. Rows pop away with a shimmer once the
                                    action finishes — async in the background. Stored locally and
                                    synced across your devices via the hidden settings folder.
                                </p>

                                <div class="rule-form" data-testid="client-rule-form">
                                    <label class="rule-row">
                                        <span class="rule-label">When</span>
                                        <select bind:value={clientRuleConditionType}>
                                            <option value="from-contains">From contains</option>
                                            <option value="from-domain">From domain is</option>
                                            <option value="subject-contains">Subject contains</option>
                                            <option value="to-contains">To contains</option>
                                        </select>
                                    </label>
                                    <label class="rule-row">
                                        <span class="rule-label">Value</span>
                                        <input
                                            type="text"
                                            placeholder={clientRuleConditionType === 'from-domain' ? 'example.com' : 'newsletter'}
                                            bind:value={clientRuleConditionValue}
                                        />
                                    </label>
                                    <label class="rule-row">
                                        <span class="rule-label">Then</span>
                                        <select bind:value={clientRuleActionType}>
                                            <option value="archive">Archive (move to Archive)</option>
                                            <option value="trash">Send to Trash</option>
                                            <option value="mark-read">Mark as read</option>
                                            <option value="move">Move to specific folder</option>
                                            <option value="ai-summarize-archive">AI summarize, then archive</option>
                                            <option value="ai-brief">AI brief into AI Conversations + archive</option>
                                        </select>
                                    </label>
                                    {#if clientRuleActionType === 'move'}
                                        <label class="rule-row">
                                            <span class="rule-label">Folder</span>
                                            <input
                                                type="text"
                                                placeholder="e.g. Receipts"
                                                bind:value={clientRuleActionFolder}
                                            />
                                        </label>
                                    {/if}
                                    <div class="rule-actions">
                                        <button type="button" class="btn btn-primary" onclick={doAddClientRule}>Add rule</button>
                                    </div>
                                </div>

                                {#if settings.clientRules.length}
                                    <ul class="rule-cards" data-testid="client-rule-list">
                                        {#each settings.clientRules as r (r.id)}
                                            <li class="rule-card" data-testid={`client-rule-${r.id}`}>
                                                <div class="rule-card-head">
                                                    <span class={`rule-badge rule-${r.action.type}`}>
                                                        {#if r.action.type === 'archive'}
                                                            <Icon name="archive" size={11} /> Archive
                                                        {:else if r.action.type === 'trash'}
                                                            <Icon name="trash" size={11} /> Trash
                                                        {:else if r.action.type === 'mark-read'}
                                                            <Icon name="eye" size={11} /> Mark read
                                                        {:else if r.action.type === 'move'}
                                                            <Icon name="folder" size={11} /> Move
                                                        {:else}
                                                            <Icon name="sparkles" size={11} /> AI
                                                        {/if}
                                                    </span>
                                                    <span class="rule-name truncate" title={r.name}>{r.name}</span>
                                                    <label class="toggle compact" style="margin-left:auto;">
                                                        <input
                                                            type="checkbox"
                                                            checked={r.enabled}
                                                            onchange={(e) => updateClientRule(r.id, { enabled: (e.currentTarget as HTMLInputElement).checked })}
                                                        />
                                                        <span>{r.enabled ? 'On' : 'Off'}</span>
                                                    </label>
                                                    <button
                                                        type="button"
                                                        class="rule-remove"
                                                        aria-label={`Remove rule ${r.name}`}
                                                        title="Remove rule"
                                                        onclick={() => removeClientRule(r.id)}
                                                    ><Icon name="trash" size={12} /></button>
                                                </div>
                                                <div class="rule-card-body">
                                                    <div class="rule-clause">
                                                        <span class="rule-when">When</span>
                                                        <span class="rule-cond">{r.condition.type.replace('-', ' ')}</span>
                                                        <code class="rule-val">{r.condition.value}</code>
                                                    </div>
                                                    <div class="rule-clause">
                                                        <span class="rule-when">Then</span>
                                                        <span class="rule-action-text">{r.action.type.replace(/-/g, ' ')}</span>
                                                        {#if r.action.folder}<code class="rule-val">{r.action.folder}</code>{/if}
                                                    </div>
                                                </div>
                                            </li>
                                        {/each}
                                    </ul>
                                {:else}
                                    <p class="muted small">No client-side rules yet.</p>
                                {/if}

                                <div style="margin-top:12px;">
                                    <button type="button" class="btn btn-ghost" onclick={doResetSeen}>
                                        Re-run rules from scratch
                                    </button>
                                    <span class="muted small" style="margin-left:8px;">Forgets which messages have already been processed by rules in this browser.</span>
                                </div>
                            </div>
                        {/if}
                    </div>
                </section>

            {:else if activeTab === 'appearance'}
                <section class="tab-section">
                    <h3>Appearance &amp; behaviour</h3>
                    <p class="muted small">Layout, density, sounds, sender avatars, and the accent palette.</p>

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

                <h4 class="section-head"><Icon name="key" size={13} /> Input</h4>

                <div class="form-row">
                    <div class="row-text">
                        <strong>Keyboard shortcuts</strong>
                        <span class="muted">
                            j/k to navigate, r/a/f to reply, c to compose, # to trash, ? for help.
                            Off by default to avoid surprising key presses when a search field loses focus.
                        </span>
                    </div>
                    <label class="toggle compact">
                        <input
                            type="checkbox"
                            checked={settings.keyboardShortcuts}
                            onchange={(e) => setKeyboardShortcuts((e.currentTarget as HTMLInputElement).checked)}
                            data-testid="settings-shortcuts-toggle"
                        />
                        <span>{settings.keyboardShortcuts ? 'On' : 'Off'}</span>
                    </label>
                </div>

                <h4 class="section-head" data-testid="settings-privacy-heading"><Icon name="shield" size={13} /> Reading</h4>

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

                <h4 class="section-head"><Icon name="eye" size={13} /> Display</h4>

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

                <h4 class="section-head"><Icon name="bell" size={13} /> Sounds &amp; avatars</h4>

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

                <h4 class="appearance-skin-title" data-testid="settings-skins">Accent &amp; skin</h4>
                <p class="muted small">
                    Pick a colour skin or dial in your own accent and semantic colours.
                    Your dark/light theme keeps working — skins only retint the palette.
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

                    <label class="skin-tile custom" class:active={skinState.skinId === 'custom'}>
                        <span
                            class="swatch"
                            style={`background:${skinState.customAccent}`}
                            aria-hidden="true"
                        ></span>
                        <span class="skin-meta">
                            <strong>Custom</strong>
                            <span class="muted small">Pick any hue — derived shades fill in.</span>
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

                {#if skinState.skinId === 'custom'}
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

            {:else if activeTab === 'sounds'}
                <section class="tab-section" data-testid="settings-sounds">
                    <h3>Sounds</h3>
                    <p class="muted small">Per-event audio cues. Pick a preset for each, or set "Silent" to leave it off.</p>

                    <div class="card">
                        <div class="form-row" style="padding:0;border:none;background:none;">
                            <div class="row-text">
                                <strong>Master mute</strong>
                                <span class="muted">Overrides every event below.</span>
                            </div>
                            <label class="toggle compact">
                                <input
                                    type="checkbox"
                                    checked={!sounds.muted}
                                    onchange={(e) => setMuted(!(e.currentTarget as HTMLInputElement).checked)}
                                    data-testid="settings-sounds-master"
                                />
                                <span>{sounds.muted ? 'Muted' : 'On'}</span>
                            </label>
                        </div>
                    </div>

                    <div class="card">
                        <h4><Icon name="bell" size={13} /> Per-event sounds</h4>
                        <ul class="sound-rows">
                            {#each SOUND_EVENTS as ev (ev.id)}
                                <li class="sound-row">
                                    <div class="sound-meta">
                                        <strong>{ev.label}</strong>
                                        <span class="muted small">{ev.description}</span>
                                    </div>
                                    <div class="sound-pills" role="radiogroup" aria-label={ev.label}>
                                        {#each ['chime', 'soft', 'sci-fi', 'silent'] as pack (pack)}
                                            <button
                                                type="button"
                                                class="sound-pill"
                                                class:active={sounds.profile[ev.id] === pack}
                                                onclick={() => { setEventPack(ev.id, pack as SoundPack); previewPack(pack as SoundPack); }}
                                                data-testid={`settings-sound-${ev.id}-${pack}`}
                                            >{pack === 'sci-fi' ? 'Sci-fi' : pack[0].toUpperCase() + pack.slice(1)}</button>
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

            {:else if activeTab === 'ai'}
                <section class="tab-section">
                    <h3>AI provider</h3>
                    <p class="muted small">
                        Powers the chat bot, "Add to calendar", and (if the server has its own key) Summarize/Draft/Translate.
                        Your key stays in this browser; the chat bot calls the provider directly.
                    </p>

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
                            Server default: <code>{capabilities.caps.preset || capabilities.caps.kind}</code>
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
                    <span>Use my own provider</span>
                </label>

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
                                <!-- Free-form input still wins, but datalist gives a
                                     one-tap pick for the few hundred models that
                                     actually exist. Saved a lot of "Invalid model:
                                     …deepseek-v4-flash…" mistypes. -->
                                <datalist id="llm-model-suggestions">
                                    {#if settings.llm.preset === 'openrouter'}
                                        <option value="deepseek/deepseek-chat-v3-0324">DeepSeek Chat v3 (general)</option>
                                        <option value="deepseek/deepseek-r1">DeepSeek R1 (reasoning)</option>
                                        <option value="deepseek/deepseek-r1-distill-llama-70b">DeepSeek R1 distill — Llama 70B</option>
                                        <option value="anthropic/claude-haiku-4-5">Anthropic Claude Haiku 4.5</option>
                                        <option value="anthropic/claude-sonnet-4-6">Anthropic Claude Sonnet 4.6</option>
                                        <option value="openai/gpt-4o-mini">OpenAI GPT-4o mini</option>
                                        <option value="openai/gpt-4.1-mini">OpenAI GPT-4.1 mini</option>
                                        <option value="meta-llama/llama-3.1-70b-instruct">Llama 3.1 70B Instruct</option>
                                        <option value="qwen/qwen-2.5-72b-instruct">Qwen 2.5 72B Instruct</option>
                                        <option value="google/gemini-2.0-flash-001">Gemini 2.0 Flash</option>
                                    {:else if settings.llm.preset === 'openai'}
                                        <option value="gpt-4o-mini">GPT-4o mini (cheap, fast)</option>
                                        <option value="gpt-4o">GPT-4o</option>
                                        <option value="gpt-4.1-mini">GPT-4.1 mini</option>
                                        <option value="o4-mini">o4-mini (reasoning)</option>
                                    {:else if settings.llm.preset === 'mistral'}
                                        <option value="mistral-small-latest">Mistral Small (latest)</option>
                                        <option value="mistral-medium-latest">Mistral Medium (latest)</option>
                                        <option value="mistral-large-latest">Mistral Large (latest)</option>
                                        <option value="codestral-latest">Codestral (latest)</option>
                                    {:else if settings.llm.preset === 'groq'}
                                        <option value="llama-3.1-70b-versatile">Llama 3.1 70B Versatile</option>
                                        <option value="llama-3.1-8b-instant">Llama 3.1 8B Instant</option>
                                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                                    {:else if settings.llm.kind === 'anthropic'}
                                        <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                                        <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
                                        <option value="claude-opus-4-7">Claude Opus 4.7</option>
                                    {/if}
                                </datalist>
                            </div>
                        </div>
                    {/if}
                </div>

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
                </section>

            {:else if activeTab === 'notifications'}
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
        grid-template-columns: 200px 1fr;
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
    .fuel-card.lvl-warn .fuel-pct { color: #d18c1d; }
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
        background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 50%, #d268f4));
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
    .fuel-card.lvl-warn .fuel-bar span { background: linear-gradient(90deg, #f6b94d, #d18c1d); box-shadow: 0 0 8px rgba(209, 140, 29, 0.5); }
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
    .section {
        padding: 4px 0 16px;
    }
    .section + .section {
        border-top: 1px solid var(--border-subtle);
        padding-top: 16px;
    }
    .form-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 0;
        flex-wrap: wrap;
    }
    .form-row + .form-row { border-top: 1px solid var(--border-subtle); }
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
    .sound-controls { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
    .quota {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 4px;
        flex: 0 0 auto;
        min-width: 200px;
    }
    .quota-bar {
        width: 200px;
        height: 6px;
        background: var(--bg-base);
        border-radius: 3px;
        overflow: hidden;
        border: 1px solid var(--border-subtle);
    }
    .quota-bar span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 50%, #d268f4));
        transition: width 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .quota-text { font-size: 11px; }
    .alias-list { padding: 8px 0; }
    .alias-list .list-head {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        margin-bottom: 6px;
    }
    .alias-list ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .alias-list .alias-addr {
        font-family: var(--font-mono);
        font-size: 12px;
        background: var(--bg-base);
        padding: 2px 8px;
        border-radius: var(--radius-xs);
        display: inline-block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .logins li {
        display: grid;
        grid-template-columns: 8px 1fr auto auto auto;
        gap: 8px;
        align-items: center;
        font-size: 12px;
    }
    .logins .status {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--text-tertiary);
    }
    .logins .status.ok { background: var(--success); }
    .logins .status.fail { background: var(--danger); }
    .logins .login-time { color: var(--text-secondary); }
    .logins .badge {
        font-size: 10px;
        padding: 1px 6px;
        background: var(--bg-tag);
        border-radius: 8px;
    }
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
    .sweep-block {
        margin-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .sweep-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
    }
    .sweep-status { font-variant-numeric: tabular-nums; }
    .sweep-list {
        list-style: none;
        margin: 0;
        padding: 6px 0 0;
        max-height: 240px;
        overflow-y: auto;
        border-top: 1px dashed var(--border-subtle);
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .sweep-list li {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 8px;
        align-items: center;
        font-size: 12.5px;
        padding: 4px 6px;
        border-radius: var(--radius-sm);
    }
    .sweep-list li:hover { background: var(--bg-hover); }
    .sweep-tag {
        font-size: 10.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 2px 7px;
        border-radius: 999px;
    }
    .sweep-tag.spam { background: rgba(245, 158, 11, 0.18); color: #b45309; }
    .sweep-tag.phish { background: rgba(147, 51, 234, 0.18); color: #6b21a8; }
    .sweep-from { font-size: 11.5px; max-width: 200px; }
    .sweep-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .sweep-empty { margin: 6px 0 0; }
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
        color: #059669;
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
    .rule-card.rule-copy { border-left-color: #d18c1d; }
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
    .rule-badge.rule-copy { background: color-mix(in srgb, #d18c1d 14%, var(--bg-surface-alt)); color: #d18c1d; }

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
