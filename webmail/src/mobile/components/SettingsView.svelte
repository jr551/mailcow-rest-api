<script lang="ts">
    import { apiUrl } from '../../lib/api';
    import { onMount } from 'svelte';
    import { navigate, showToast, resetMobileState } from '../lib/store.svelte';
    import { authState, logoutRemote, setSession, bearerHeader, getSession } from '../../lib/auth.svelte';
    import { pwa, promptInstall, subscribePush, unsubscribePush, pushSubscriptionStatus } from '../../lib/pwa.svelte';
    import {
        settings, capabilities, setProxyImages, setDefaultFromAddress,
        setDensity, setGroupThreads, setPageSize, setAccountChipDisplay,
        setLlm, setUseCustomLlm, setAiFeatures,
        setPhishingScan, setTrackOpensDefault, setAiSuggestSubjectOnBlur, setDisplayName, setUndoSendSeconds,
        setPhishingScanTimeoutSec, setPhishingScanPromptAddendum, setPhishingScanConfidenceFloor,
        setTesseractOcrInstalled, setPhishingScanOcrInline
    } from '../../lib/settings.svelte';
    import { warmupTesseract, teardownTesseract } from '../../lib/tesseract-ocr';
    import { sounds, setMuted } from '../../lib/sounds.svelte';
    import { gravatarPref, setGravatarEnabled } from '../../lib/avatars.svelte';
    import { spamFeedback, markTrusted, addTrustedDomain, removeTrusted, removeTrustedDomain } from '../../lib/spam-feedback.svelte';
    import {
        getSendFromAddresses, summarizeMessage, createTempAlias, deleteTempAlias, getTempAliases,
        listMailRules, addMailRule, removeMailRule,
        type TempAliasEntry, type MailRule, type MailRuleConditionType,
        formatMailRuleConditionSummary
    } from '../../lib/api';
    import Icon from '../../components/Icon.svelte';
    import Toggle from './Toggle.svelte';
    import { themeState, setTheme, effectiveTheme } from '../../lib/theme.svelte';
    import { MOBILE_THEME_OPTIONS } from '../../lib/mobile-appearance';
    import { MAIL_SKIP_LINK_TEXT, MOBILE_LANDMARK_ROWS } from '../../lib/mobile-mail-landmarks';
    import { MOBILE_COMPOSE_LANDMARK_ROWS } from '../../lib/mobile-compose-landmarks';

    // Mail rules — minimal port of the desktop block. Mobile keeps to
    // contains-only conditions to avoid a deep dropdown stack on phones.
    const RULE_TYPES: { value: MailRuleConditionType; label: string }[] = [
        { value: 'from-contains',    label: 'From contains' },
        { value: 'to-contains',      label: 'To contains' },
        { value: 'subject-contains', label: 'Subject contains' }
    ];
    let mailRules = $state<MailRule[]>([]);
    let mailRulesLoading = $state(false);
    let mailRulesError = $state<string | null>(null);
    let newRuleType = $state<MailRuleConditionType>('from-contains');
    let newRuleValue = $state('');
    let newRuleAction = $state<'discard' | 'redirect'>('discard');
    let newRuleRedirectTo = $state('');
    let savingRule = $state(false);

    let trustedAddInput = $state('');
    function addTrustedFromInput() {
        const v = trustedAddInput.trim();
        if (!v) return;
        if (v.includes('@')) {
            markTrusted(v);
        } else if (!addTrustedDomain(v)) {
            showToast('error', 'Free-mail providers cannot be trusted as a whole domain. Add the exact address instead.');
            return;
        }
        trustedAddInput = '';
    }

    async function refreshMailRules() {
        mailRulesLoading = true;
        mailRulesError = null;
        try {
            const r = await listMailRules();
            mailRules = r.rules || [];
        } catch (err) {
            mailRulesError = (err as Error).message || 'Could not load rules';
        } finally {
            mailRulesLoading = false;
        }
    }

    async function addRule() {
        const value = newRuleValue.trim();
        if (!value || savingRule) return;
        if (newRuleAction === 'redirect' && !newRuleRedirectTo.trim()) {
            showToast('error', 'Forward target email is required');
            return;
        }
        savingRule = true;
        try {
            const cond = { type: newRuleType, value };
            const action = newRuleAction === 'discard'
                ? { type: 'discard' as const }
                : { type: 'redirect' as const, to: newRuleRedirectTo.trim() };
            const ruleName = `${newRuleType.replace('-', ' ')} "${value}" → ${action.type}`;
            await addMailRule({ name: ruleName, condition: cond, action });
            newRuleValue = '';
            newRuleRedirectTo = '';
            await refreshMailRules();
            showToast('success', 'Rule added');
        } catch (err) {
            showToast('error', 'Failed to add rule', err);
        } finally {
            savingRule = false;
        }
    }

    async function dropRule(id: string) {
        try {
            await removeMailRule(id);
            await refreshMailRules();
            showToast('success', 'Rule removed');
        } catch (err) {
            showToast('error', 'Failed to remove rule', err);
        }
    }

    let pushStatus = $state<'subscribed' | 'denied' | 'default' | 'unsupported'>('unsupported');
    let pushLoading = $state(false);
    let androidApp = $state<{ version: string; builtAt: string } | null>(null);
    const isInTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    let sendFromOptions = $state<string[]>([]);
    let aiTesting = $state(false);
    let aiTestResult = $state<{ ok: boolean; message: string } | null>(null);
    // AI Provider section is collapsed by default; expand persists locally
    // so power users don't have to re-open it on every visit.
    let showAiProvider = $state<boolean>((() => {
        try { return localStorage.getItem('webmail.mobile.settings.showAi') === '1'; } catch { return false; }
    })());
    $effect(() => {
        try { localStorage.setItem('webmail.mobile.settings.showAi', showAiProvider ? '1' : '0'); } catch { /* noop */ }
    });
    let tempAliases = $state<TempAliasEntry[]>([]);
    let creatingAlias = $state(false);

    const PRESETS: { value: string; label: string }[] = [
        { value: 'mistral', label: 'Mistral' },
        { value: 'openai', label: 'OpenAI' },
        { value: 'groq', label: 'Groq' },
        { value: 'together', label: 'Together AI' },
        { value: 'perplexity', label: 'Perplexity' },
        { value: 'openrouter', label: 'OpenRouter' },
        { value: 'ollama', label: 'Ollama (local)' },
        { value: '', label: 'Custom' }
    ];

    function applyPreset(preset: string) {
        setLlm({ preset, baseUrl: '', model: '' });
    }

    function resolveProviderBaseUrl(): string {
        const llm = settings.llm;
        if (llm.baseUrl) return llm.baseUrl.replace(/\/+$/, '');
        const urls: Record<string, string> = {
            mistral: 'https://api.mistral.ai/v1',
            openai: 'https://api.openai.com/v1',
            groq: 'https://api.groq.com/openai/v1',
            together: 'https://api.together.xyz/v1',
            ollama: 'http://127.0.0.1:11434/v1',
            perplexity: 'https://api.perplexity.ai',
            openrouter: 'https://openrouter.ai/api/v1'
        };
        return urls[llm.preset] || urls.openai;
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

    async function testAiConnection() {
        aiTesting = true;
        aiTestResult = null;
        try {
            if (settings.useCustomLlm && settings.llm.apiKey) {
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
                    try { const j = await res.json(); detail = j?.error?.message || j?.message || detail; } catch { /* noop */ }
                    throw new Error(detail);
                }
                const j = await res.json();
                const text = (j?.choices?.[0]?.message?.content || '').trim() || '(empty reply)';
                aiTestResult = { ok: true, message: `Reply from ${j.model || model}: ${text.slice(0, 80)}` };
            } else {
                const r = await summarizeMessage('Test connection. Reply with the single word "ok".', 20);
                aiTestResult = { ok: true, message: `Reply from ${r.model}: ${r.content.slice(0, 80)}` };
            }
        } catch (err) {
            aiTestResult = { ok: false, message: err instanceof Error ? err.message : String(err) };
        } finally {
            aiTesting = false;
        }
    }

    async function checkPush() {
        pushStatus = await pushSubscriptionStatus();
    }

    async function togglePush() {
        const session = authState.activeUser ? authState.sessions.find((s) => s.user === authState.activeUser) : null;
        if (!session) return;
        pushLoading = true;
        try {
            if (pushStatus === 'subscribed') {
                const r = await unsubscribePush(session.token);
                if (r.ok) {
                    showToast('success', 'Push notifications disabled');
                    pushStatus = 'default';
                } else {
                    showToast('error', 'Failed to disable push');
                }
            } else {
                const r = await subscribePush(session.token);
                if (r.ok) {
                    showToast('success', 'Push notifications enabled');
                    pushStatus = 'subscribed';
                } else {
                    showToast('error', 'Failed to enable push', r.reason);
                }
            }
        } finally {
            pushLoading = false;
        }
    }

    async function installApp() {
        const outcome = await promptInstall();
        if (outcome === 'accepted') showToast('success', 'App installed');
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
            showToast('error', "Couldn't create alias", err);
        } finally {
            creatingAlias = false;
        }
    }

    async function dropTempAlias(addr: string) {
        try {
            await deleteTempAlias(addr);
            tempAliases = tempAliases.filter((a) => a.address !== addr);
        } catch (err) {
            showToast('error', "Couldn't delete alias", err);
        }
    }

    function logout() {
        logoutRemote();
        setSession(null);
        resetMobileState();
        navigate('inbox');
        showToast('info', 'Signed out');
    }

    onMount(async () => {
        checkPush();
        try {
            const res = await getSendFromAddresses();
            if (res.addresses.length) sendFromOptions = res.addresses;
        } catch { /* silent fallback */ }
        try {
            const res = await getTempAliases();
            tempAliases = res.aliases;
        } catch { /* silent fallback */ }
        // Clear app badge when opening settings
        if (navigator.clearAppBadge) {
            try { navigator.clearAppBadge(); } catch { /* non-fatal */ }
        }
        try {
            const session = getSession();
            const res = await fetch(apiUrl('/v1/app/android/version.json'), {
                headers: session ? { authorization: bearerHeader(session) } : {}
            });
            if (res.ok) {
                const meta = await res.json();
                androidApp = { version: meta.version, builtAt: meta.builtAt };
            }
        } catch { /* silent — endpoint absent or 404 */ }
        // Lazy-load mail rules so this expensive Sieve fetch only fires
        // when the user opens Settings, not on every app boot.
        void refreshMailRules();
    });
</script>

<div class="settings-view">
    <header class="mheader">
        <h1>Settings</h1>
    </header>

    <div class="settings-body scroll-y">
        <p class="ios-section-title"><Icon name="user" size={13} /> Account</p>
        <div class="ios-list">
            <div class="ios-row">
                <span class="row-label">Signed in as</span>
                <span class="row-value truncate">{authState.activeUser}</span>
            </div>
            {#if sendFromOptions.length > 1}
                <div class="ios-row" style="padding: 6px 16px;">
                    <span class="row-label" style="flex-shrink:0">Default From</span>
                    <select
                        class="from-select"
                        value={settings.defaultFromAddress || authState.activeUser || ''}
                        onchange={(e) => setDefaultFromAddress((e.currentTarget as HTMLSelectElement).value)}
                    >
                        {#each sendFromOptions as addr}
                            <option value={addr}>{addr}</option>
                        {/each}
                    </select>
                </div>
            {/if}
        </div>

        <p class="ios-section-title"><Icon name="at" size={13} /> Aliases</p>
        <div class="ios-list">
            <div class="ios-row" style="flex-wrap:wrap;gap:6px;">
                <button
                    type="button"
                    class="btn btn-secondary small"
                    disabled={creatingAlias}
                    onclick={() => newTempAlias(false, 168)}
                >+ 7-day</button>
                <button
                    type="button"
                    class="btn btn-secondary small"
                    disabled={creatingAlias}
                    onclick={() => newTempAlias(false, 720)}
                >+ 30-day</button>
                <button
                    type="button"
                    class="btn btn-secondary small"
                    disabled={creatingAlias}
                    onclick={() => newTempAlias(true, 8760)}
                >+ Permanent</button>
            </div>
            {#each tempAliases as a (a.address)}
                <div class="ios-row">
                    <span class="row-value truncate" style="font-family:var(--font-mono);font-size:13px;">{a.address}</span>
                    <span class="muted small">{a.permanent ? 'permanent' : 'temp'}</span>
                    <button type="button" class="btn btn-ghost" aria-label={`Delete alias ${a.address}`} onclick={() => dropTempAlias(a.address)}>
                        <Icon name="trash" size={14} />
                    </button>
                </div>
            {/each}
        </div>

        <p class="ios-section-title"><Icon name="palette" size={13} /> Appearance</p>
        <div class="ios-list">
            <div class="ios-row theme-row">
                <div class="toggle-info">
                    <span class="row-label">Theme</span>
                    <span class="muted small">Auto follows your device; Light and Dark match Outlook on the web. Showing <strong>{effectiveTheme()}</strong> now.</span>
                </div>
            </div>
            <div class="ios-row theme-segments-row">
                <div class="segments theme-segments" role="group" aria-label="Theme">
                    {#each MOBILE_THEME_OPTIONS as mode (mode.value)}
                        <button
                            type="button"
                            class="segment"
                            class:active={themeState.theme === mode.value}
                            aria-pressed={themeState.theme === mode.value}
                            data-testid={mode.testId}
                            onclick={() => setTheme(mode.value)}
                        >{mode.label}</button>
                    {/each}
                </div>
            </div>
            <div class="ios-row toggle-row">
                <div class="toggle-info">
                    <span class="row-label">Compact density</span>
                    <span class="muted small">Pack more rows into the message list</span>
                </div>
                <Toggle checked={settings.density === 'compact'} label="Compact density" onToggle={() => setDensity(settings.density === 'compact' ? 'comfortable' : 'compact')} />
            </div>
            <div class="ios-row toggle-row">
                <div class="toggle-info">
                    <span class="row-label">Group threads</span>
                    <span class="muted small">Collapse conversations into one row; open a thread to see the Outlook-style stack on mobile</span>
                </div>
                <Toggle checked={settings.groupThreads} label="Group threads" onToggle={() => setGroupThreads(!settings.groupThreads)} />
            </div>
            <div class="ios-row">
                <button
                    type="button"
                    class="btn btn-secondary"
                    style="width:100%;"
                    data-testid="mobile-settings-keyboard-shortcuts"
                    onclick={() => window.dispatchEvent(new Event('webmail:mobile-show-shortcut-help'))}
                >
                    <Icon name="monitor" size={16} /> Keyboard shortcuts
                </button>
            </div>
            <div class="ios-row">
                <div class="toggle-info">
                    <span class="row-label">External keyboard</span>
                    <span class="muted small">Press <strong>?</strong> in the inbox for the shortcut list (tablet or Bluetooth keyboard).</span>
                </div>
            </div>
            <div class="ios-row">
                <div class="toggle-info">
                    <span class="row-label">Focused inbox</span>
                    <span class="muted small">INBOX uses Focused and Other tabs (same as desktop). Your last tab is remembered.</span>
                </div>
            </div>
            <div class="ios-row">
                <div class="toggle-info">
                    <span class="row-label">Follow-up flags</span>
                    <span class="muted small">Long-press a message → <strong>Flag for follow-up</strong> (Today, Tomorrow, This week). Due dates stay on this device; the star syncs via IMAP.</span>
                </div>
            </div>
            <div class="ios-row toggle-row">
                <div class="toggle-info">
                    <span class="row-label">Sounds</span>
                    <span class="muted small">Chime on new mail, swoosh on send</span>
                </div>
                <Toggle checked={!sounds.muted} label="Sounds" onToggle={() => setMuted(!sounds.muted)} />
            </div>
            <div class="ios-row toggle-row">
                <div class="toggle-info">
                    <span class="row-label">Gravatar avatars</span>
                    <span class="muted small">Look up sender portraits</span>
                </div>
                <Toggle checked={gravatarPref.on} label="Gravatar avatars" onToggle={() => setGravatarEnabled(!gravatarPref.on)} />
            </div>
        </div>

        <p class="ios-section-title"><Icon name="monitor" size={13} /> Accessibility</p>
        <div class="ios-list">
            <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:8px;">
                <span class="row-label">Landmarks &amp; tab order</span>
                <p class="muted small" style="margin:0;">
                    The mobile inbox exposes Outlook-style regions for screen readers. Tab order follows the layout:
                    command bar → app tabs → message list → reading pane. Press Tab on the inbox to reveal
                    <strong>{MAIL_SKIP_LINK_TEXT}</strong>.
                </p>
                <ul class="landmark-list muted small" style="margin:0;padding-left:18px;" data-testid="mobile-settings-landmarks">
                    {#each MOBILE_LANDMARK_ROWS as row}
                        <li><strong>{row.region}</strong> — {row.description}</li>
                    {/each}
                </ul>
                <p class="muted small" style="margin:8px 0 0;">
                    When you open a message on mobile, focus moves to the <strong>Reading pane</strong> landmark
                    so screen readers land on the message body region (same pattern as compose focusing <strong>To</strong>).
                </p>
                <p class="muted small" style="margin:8px 0 0;">
                    When you compose on mobile, screen readers get a dedicated <strong>Compose message</strong> region
                    with labelled field and action areas; focus moves to the <strong>To</strong> field when compose opens.
                </p>
                <ul class="landmark-list muted small" style="margin:4px 0 0;padding-left:18px;" data-testid="mobile-settings-compose-landmarks">
                    {#each MOBILE_COMPOSE_LANDMARK_ROWS as row}
                        <li><strong>{row.region}</strong> — {row.description}</li>
                    {/each}
                </ul>
            </div>
        </div>

        <p class="ios-section-title"><Icon name="shield" size={13} /> Privacy</p>
        <div class="ios-list">
            <div class="ios-row toggle-row">
                <div class="toggle-info">
                    <span class="row-label">Load images via the privacy proxy</span>
                    <span class="muted small">Remote images always load; this fetches them through our server so the sender's CDN never sees your IP</span>
                </div>
                <Toggle checked={settings.proxyImages} label="Load images via the privacy proxy" onToggle={() => setProxyImages(!settings.proxyImages)} />
            </div>
            <!-- The "Always allow images" row is gone because there is no
                 blocking any more — remote content always loads. The single
                 row above is the whole of the mobile remote-content story
                 and it matches the desktop panel exactly: images load, and
                 this decides whether they are proxied. -->
            <div class="ios-row toggle-row">
                <div class="toggle-info">
                    <span class="row-label">Phishing detection</span>
                    <span class="muted small">Scan opened messages for phishing patterns</span>
                </div>
                <Toggle checked={settings.phishingScan} label="Phishing detection" onToggle={() => setPhishingScan(!settings.phishingScan)} />
            </div>
            {#if settings.phishingScan}
                <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:6px;padding-top:10px;">
                    <span class="row-label" style="display:flex;justify-content:space-between;">
                        Max scan time
                        <span class="muted small">{settings.phishingScanTimeoutSec}s</span>
                    </span>
                    <input
                        type="range" min="2" max="30" step="1"
                        value={settings.phishingScanTimeoutSec}
                        oninput={(e) => setPhishingScanTimeoutSec(Number((e.currentTarget as HTMLInputElement).value))}
                        style="accent-color: var(--accent); width: 100%;"
                    />
                </div>
                <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                    <span class="row-label" style="display:flex;justify-content:space-between;">
                        Confidence floor
                        <span class="muted small">{Math.round(settings.phishingScanConfidenceFloor * 100)}%</span>
                    </span>
                    <input
                        type="range" min="0.3" max="0.95" step="0.05"
                        value={settings.phishingScanConfidenceFloor}
                        oninput={(e) => setPhishingScanConfidenceFloor(Number((e.currentTarget as HTMLInputElement).value))}
                        style="accent-color: var(--accent); width: 100%;"
                    />
                </div>
                <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                    <span class="row-label">Extra prompt instructions</span>
                    <textarea
                        rows="3" maxlength="500"
                        placeholder="e.g. Lean strict on financial-services lookalikes"
                        value={settings.phishingScanPromptAddendum}
                        oninput={(e) => setPhishingScanPromptAddendum((e.currentTarget as HTMLTextAreaElement).value)}
                        style="font: inherit; padding: 8px 10px; background: var(--bg-base); border: 1px solid var(--border-soft); border-radius: var(--radius-sm); color: var(--text-primary); resize: vertical;"
                    ></textarea>
                </div>
                <div class="ios-row toggle-row">
                    <div class="toggle-info">
                        <span class="row-label">OCR inline images</span>
                        <span class="muted small">
                            Enhanced scan: tesseract.js reads body images locally so phishers can't hide text inside them.
                            {#if !settings.tesseractOcrInstalled}<em>Install OCR engine below first.</em>{/if}
                        </span>
                    </div>
                    <Toggle checked={settings.phishingScanOcrInline} label="OCR inline images" disabled={!settings.tesseractOcrInstalled} onToggle={() => setPhishingScanOcrInline(!settings.phishingScanOcrInline)} />
                </div>
            {/if}
            <div class="ios-row toggle-row">
                <div class="toggle-info">
                    <span class="row-label">Local OCR engine (tesseract.js)</span>
                    <span class="muted small">~3 MB WASM core + a one-off ~12 MB language download. All OCR runs in your browser.</span>
                </div>
                <Toggle checked={settings.tesseractOcrInstalled} label="Local OCR engine (tesseract.js)" onToggle={async () => {
                        const next = !settings.tesseractOcrInstalled;
                        setTesseractOcrInstalled(next);
                        if (next) {
                            showToast('info', 'Downloading OCR engine — first time only.');
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
                    }} />
            </div>
        </div>

        <p class="ios-section-title"><Icon name="shield" size={13} /> Trusted senders</p>
        <div class="ios-list">
            <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                <div class="toggle-info" style="margin-bottom:2px;">
                    <span class="row-label">Skip the AI scan for people you trust</span>
                    <span class="muted small">Mail from these addresses or domains opens straight away — no LLM call. Tap "Trust this sender" on a scam bubble or add manually below.</span>
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <input
                        type="text"
                        bind:value={trustedAddInput}
                        placeholder="someone@example.com or example.com"
                        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTrustedFromInput(); } }}
                        style="flex:1;font:inherit;padding:8px 10px;background:var(--bg-base);border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--text-primary);"
                        data-testid="settings-trusted-input"
                    />
                    <button type="button" class="mbtn mbtn-secondary" style="padding:6px 14px;" onclick={addTrustedFromInput}>Add</button>
                </div>
            </div>
            {#if spamFeedback.trustedAddresses.length === 0 && spamFeedback.trustedDomains.length === 0}
                <div class="ios-row"><span class="muted small">No trusted senders yet.</span></div>
            {:else}
                {#each spamFeedback.trustedAddresses as a (a)}
                    <div class="ios-row" style="gap:8px;">
                        <span class="truncate" style="flex:1;font-size:13px;">{a}</span>
                        <button type="button" class="ios-row-btn" aria-label={`Remove ${a}`} onclick={() => removeTrusted(a)}>
                            <Icon name="trash" size={14} />
                        </button>
                    </div>
                {/each}
                {#each spamFeedback.trustedDomains as d (d)}
                    <div class="ios-row" style="gap:8px;">
                        <span class="truncate" style="flex:1;font-size:13px;">@{d}</span>
                        <button type="button" class="ios-row-btn" aria-label={`Remove ${d}`} onclick={() => removeTrustedDomain(d)}>
                            <Icon name="trash" size={14} />
                        </button>
                    </div>
                {/each}
            {/if}
        </div>

        <p class="ios-section-title"><Icon name="pencil" size={13} /> Compose</p>
        <div class="ios-list">
            <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                <div class="toggle-info" style="margin-bottom:2px;">
                    <span class="row-label">Display name</span>
                    <span class="muted small">Shown next to your address — e.g. "Jane Smith &lt;jane@…&gt;". Leave blank to fall back to the local part of your address.</span>
                </div>
                <input
                    type="text"
                    value={settings.displayName}
                    oninput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)}
                    placeholder={authState.activeUser ? authState.activeUser.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Your name'}
                    autocomplete="off"
                    spellcheck="false"
                    style="font:inherit;padding:8px 10px;background:var(--bg-base);border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--text-primary);"
                    data-testid="settings-display-name"
                />
            </div>
            <div class="ios-row toggle-row">
                <div class="toggle-info">
                    <span class="row-label">Default to tracked</span>
                    <span class="muted small">New messages start with the spy pixel pre-enabled</span>
                </div>
                <Toggle checked={settings.trackOpensDefault} label="Default to tracked" onToggle={() => setTrackOpensDefault(!settings.trackOpensDefault)} />
            </div>
            <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                <div class="toggle-info" style="margin-bottom:2px;">
                    <span class="row-label">Save draft</span>
                    <span class="muted small">Compose includes an explicit <strong>Save draft</strong> button (and <strong>Ctrl+S</strong> with a hardware keyboard). Drafts append to your IMAP Drafts folder with the <strong>\\Draft</strong> flag, even when SMTP send is disabled.</span>
                </div>
            </div>
            <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                <div class="toggle-info" style="margin-bottom:2px;">
                    <span class="row-label">Discard confirmation</span>
                    <span class="muted small">Closing compose with unsaved changes opens an Outlook-style sheet: <strong>Keep editing</strong>, <strong>Save draft</strong>, or <strong>Discard</strong>. Hardware back uses the same prompt.</span>
                </div>
            </div>
            <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                <div class="toggle-info" style="margin-bottom:2px;">
                    <span class="row-label">Undo send</span>
                    <span class="muted small">Delay sending so you can tap Undo on the toast (0–30 seconds, same as desktop).</span>
                </div>
                <input
                    type="number"
                    min="0"
                    max="30"
                    step="1"
                    value={settings.undoSendSeconds}
                    oninput={(e) => setUndoSendSeconds(Number((e.currentTarget as HTMLInputElement).value))}
                    data-testid="settings-undo-send-seconds"
                    style="font:inherit;padding:8px 10px;background:var(--bg-base);border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--text-primary);width:5rem;"
                />
            </div>
            <div class="ios-row toggle-row">
                <div class="toggle-info">
                    <span class="row-label">AI subject on blur</span>
                    <span class="muted small">Suggest a subject the moment you leave the body</span>
                </div>
                <Toggle checked={settings.aiSuggestSubjectOnBlur} label="AI subject on blur" onToggle={() => setAiSuggestSubjectOnBlur(!settings.aiSuggestSubjectOnBlur)} />
            </div>
        </div>

        <p class="ios-section-title"><Icon name="filter" size={13} /> Mail rules</p>
        <div class="ios-list">
            {#if mailRulesLoading && mailRules.length === 0}
                <div class="ios-row"><span class="muted small">Loading rules…</span></div>
            {:else if mailRulesError}
                <div class="ios-row"><span class="muted small" style="color:var(--danger);">{mailRulesError}</span></div>
            {/if}
            {#each mailRules as r (r.id)}
                <div class="ios-row" style="align-items:center;gap:8px;">
                    <div style="flex:1;min-width:0;">
                        <span class="row-label truncate" style="display:block;">{r.name}</span>
                        <span class="muted small">{formatMailRuleConditionSummary(r.condition)} → {r.action.type}{r.action.type === 'redirect' && r.action.to ? ` ${r.action.to}` : ''}</span>
                    </div>
                    <button
                        type="button"
                        class="ios-row-btn"
                        title={`Remove rule "${r.name}"`}
                        aria-label={`Remove rule "${r.name}"`}
                        onclick={() => dropRule(r.id)}
                    ><Icon name="trash" size={14} /></button>
                </div>
            {/each}
            {#if mailRules.length === 0 && !mailRulesLoading && !mailRulesError}
                <div class="ios-row"><span class="muted small">No rules yet — add one below.</span></div>
            {/if}
            <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:8px;padding-top:10px;border-top:1px dashed var(--border-soft);">
                <select bind:value={newRuleType} style="font:inherit;padding:7px 10px;background:var(--bg-base);border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--text-primary);">
                    {#each RULE_TYPES as t (t.value)}
                        <option value={t.value}>{t.label}</option>
                    {/each}
                </select>
                <input
                    type="text"
                    placeholder="contains this text…"
                    bind:value={newRuleValue}
                    style="font:inherit;padding:8px 10px;background:var(--bg-base);border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--text-primary);"
                />
                <select bind:value={newRuleAction} style="font:inherit;padding:7px 10px;background:var(--bg-base);border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--text-primary);">
                    <option value="discard">Discard (silently drop)</option>
                    <option value="redirect">Redirect to another address</option>
                </select>
                {#if newRuleAction === 'redirect'}
                    <input
                        type="email"
                        placeholder="forward-to@example.com"
                        bind:value={newRuleRedirectTo}
                        style="font:inherit;padding:8px 10px;background:var(--bg-base);border:1px solid var(--border-soft);border-radius:var(--radius-sm);color:var(--text-primary);"
                    />
                {/if}
                <button
                    type="button"
                    onclick={addRule}
                    disabled={savingRule || !newRuleValue.trim()}
                    style="padding:9px 14px;background:var(--accent);color:var(--text-on-accent);border:none;border-radius:var(--radius-sm);font-weight:600;cursor:pointer;"
                >
                    {savingRule ? 'Adding…' : 'Add rule'}
                </button>
            </div>
        </div>

        <!-- AI provider section is collapsed by default — server-side LLM
             "just works" for the vast majority. Power users can expand to
             swap in their own key. -->
        <button
            type="button"
            class="ios-section-title collapse-btn"
            onclick={() => (showAiProvider = !showAiProvider)}
            aria-expanded={showAiProvider}
        >
            <span><Icon name="sparkles" size={13} /> AI Provider {settings.useCustomLlm ? '· custom' : ''}</span>
            <Icon name={showAiProvider ? 'chevronUp' : 'chevronDown'} size={14} />
        </button>
        {#if showAiProvider}
            <div class="ios-list">
                <!-- Master switch, first row so it reads as the control for
                     everything below rather than another provider setting.
                     On = AI enabled; the hint says what switching it off
                     removes. -->
                <div class="ios-row toggle-row">
                    <div class="toggle-info">
                        <span class="row-label">AI features</span>
                        <span class="muted small">Switch off to hide the AI tab, AI buttons and every suggestion</span>
                    </div>
                    <Toggle checked={settings.aiFeatures} label="AI features" testid="settings-ai-features" onToggle={() => setAiFeatures(!settings.aiFeatures)} />
                </div>
                {#if !settings.aiFeatures}
                    <div class="ios-row" style="align-items:flex-start;flex-direction:column;gap:4px;">
                        <span class="muted small">AI is off. The provider settings below are kept, but nothing uses them until you turn AI back on.</span>
                    </div>
                {/if}
                {#if capabilities.caps && !capabilities.caps.configured}
                    <div class="ios-row" style="align-items:flex-start;flex-direction:column;gap:4px;">
                        <span class="muted small">Server has no LLM configured. Set your own provider below to use AI chat.</span>
                    </div>
                {/if}
                <div class="ios-row toggle-row">
                    <div class="toggle-info">
                        <span class="row-label">Use my own provider</span>
                        <span class="muted small">Calls provider directly from this device</span>
                    </div>
                    <Toggle checked={settings.useCustomLlm} label="Use my own provider" onToggle={() => setUseCustomLlm(!settings.useCustomLlm)} />
                </div>
                {#if settings.useCustomLlm}
                    <div class="ios-row" style="padding: 6px 16px;flex-direction:column;align-items:stretch;gap:6px;">
                        <span class="row-label">Preset</span>
                        <select class="from-select" value={settings.llm.preset} onchange={(e) => applyPreset((e.currentTarget as HTMLSelectElement).value)}>
                            {#each PRESETS as p}<option value={p.value}>{p.label}</option>{/each}
                        </select>
                    </div>
                    <div class="ios-row" style="padding: 6px 16px;flex-direction:column;align-items:stretch;gap:6px;">
                        <span class="row-label">API key</span>
                        <input type="password" class="ai-input" placeholder="sk-…" autocomplete="off" spellcheck="false" value={settings.llm.apiKey} oninput={(e) => setLlm({ apiKey: (e.currentTarget as HTMLInputElement).value })} />
                    </div>
                    <div class="ios-row" style="padding: 6px 16px;flex-direction:column;align-items:stretch;gap:6px;">
                        <span class="row-label">Base URL</span>
                        <input type="text" class="ai-input" placeholder={settings.llm.preset ? '(preset default)' : 'https://your-llm.example/v1'} value={settings.llm.baseUrl} oninput={(e) => setLlm({ baseUrl: (e.currentTarget as HTMLInputElement).value })} />
                    </div>
                    <div class="ios-row" style="padding: 6px 16px;flex-direction:column;align-items:stretch;gap:6px;">
                        <span class="row-label">Model</span>
                        <input type="text" class="ai-input" placeholder={settings.llm.preset ? '(preset default)' : 'gpt-4o-mini'} value={settings.llm.model} oninput={(e) => setLlm({ model: (e.currentTarget as HTMLInputElement).value })} />
                    </div>
                    <!-- A live model round-trip, so it follows the master
                         switch: with AI off the row would spend tokens on a
                         connection nothing can use. -->
                    {#if settings.aiFeatures}
                    <div class="ios-row" style="padding: 6px 16px;flex-direction:column;align-items:stretch;gap:6px;">
                        <button type="button" class="mbtn mbtn-secondary" disabled={aiTesting} onclick={testAiConnection}>
                            {aiTesting ? 'Testing…' : 'Test connection'}
                        </button>
                        {#if aiTestResult}
                            <span class="muted small" style={aiTestResult.ok ? 'color:var(--success);' : 'color:var(--danger);'}>
                                {aiTestResult.message}
                            </span>
                        {/if}
                    </div>
                    {/if}
                {/if}
            </div>
        {/if}

        <p class="ios-section-title"><Icon name="bell" size={13} /> Notifications</p>
        <div class="ios-list">
            {#if pushStatus === 'unsupported'}
                <div class="ios-row" style="flex-direction:column;align-items:flex-start;gap:6px;">
                    {#if /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches}
                        <span class="row-label">Install the app to enable push</span>
                        <span class="muted small">
                            iOS only delivers web push to installed PWAs. Tap the Safari Share button →
                            <strong>Add to Home Screen</strong>, open the app from your home screen,
                            then come back here to enable notifications.
                        </span>
                    {:else}
                        <span class="row-label">Push notifications not supported</span>
                        <span class="muted small">Your browser doesn't expose the Push API.</span>
                    {/if}
                </div>
            {:else}
                <div class="ios-row toggle-row">
                    <div class="toggle-info">
                        <span class="row-label">New-mail push</span>
                        <span class="muted small">Get notified when new messages arrive</span>
                    </div>
                    <Toggle checked={pushStatus === 'subscribed'} label="New-mail push" disabled={pushLoading || pushStatus === 'denied'} onToggle={togglePush} />
                </div>
                {#if pushStatus === 'denied'}
                    <div class="ios-row">
                        <span class="muted small">Permission denied — enable notifications in your browser settings.</span>
                    </div>
                {/if}
            {/if}
        </div>

        <p class="ios-section-title"><Icon name="download" size={13} /> App</p>
        <div class="ios-list">
            {#if pwa.available}
                <button type="button" class="ios-row" onclick={installApp}>
                    <span class="row-label">Install app</span>
                    <Icon name="download" size={16} />
                </button>
            {:else if pwa.installed}
                <div class="ios-row">
                    <span class="muted">App is installed</span>
                </div>
            {/if}
            {#if androidApp && !isInTauri}
                <a class="ios-row android-row" href="{apiUrl('/v1/app/android.apk')}" download>
                    <div class="toggle-info">
                        <span class="row-label">Get the Android app</span>
                        <span class="muted small">v{androidApp.version} — sideload .apk for photo backup</span>
                    </div>
                    <Icon name="download" size={16} />
                </a>
            {:else if androidApp && isInTauri}
                <div class="ios-row">
                    <div class="toggle-info">
                        <span class="row-label">Android app</span>
                        <span class="muted small">v{androidApp.version}</span>
                    </div>
                    <Icon name="check" size={16} />
                </div>
            {/if}
        </div>

        <div class="logout-wrap">
            <button type="button" class="logout-btn" onclick={logout}>
                Sign Out
            </button>
        </div>
    </div>
</div>

<style>
    .settings-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }
    .settings-body {
        flex: 1;
        padding: 0 0 24px;
        display: flex;
        flex-direction: column;
        gap: 0;
    }
    .settings-body > .ios-section-title,
    .settings-body > .ios-list {
        flex-shrink: 0;
    }
    .ios-section-title {
        font-size: 13px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        color: var(--text-tertiary);
        margin: 24px 16px 6px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    /* Tappable section title — used to collapse advanced sections (e.g. AI
       Provider) so the default settings list stays uncluttered. */
    button.ios-section-title.collapse-btn {
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        width: calc(100% - 32px);
        justify-content: space-between;
    }
    button.ios-section-title.collapse-btn > span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .ios-list {
        display: flex;
        flex-direction: column;
        background: var(--bg-surface);
        border-radius: 12px;
        overflow: hidden;
        margin: 0 16px;
    }
    .ios-list .ios-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 11px 16px;
        background: transparent;
        border: none;
        width: 100%;
        text-align: left;
        cursor: pointer;
        font-size: 16px;
        color: var(--text-primary);
        transition: background-color 80ms;
        min-height: 44px;
    }
    .ios-list .ios-row:not(:last-child) {
        border-bottom: 0.5px solid var(--border-subtle);
    }
    .ios-list .ios-row:active { background: var(--bg-hover); }
    .ios-list a.ios-row {
        text-decoration: none;
        color: inherit;
    }
    .android-row .toggle-info { gap: 2px; }
    .ios-list .ios-row .row-label {
        flex: 1;
        font-weight: 400;
        min-width: 0;
    }
    .ios-list .ios-row .row-value {
        color: var(--text-tertiary);
        font-size: 15px;
    }
    .toggle-row {
        justify-content: space-between;
        gap: 12px;
    }
    .toggle-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
    }
    .theme-row {
        flex-direction: column;
        align-items: stretch;
        gap: 4px;
    }
    .theme-segments-row {
        padding-top: 0;
        padding-bottom: 10px;
    }
    .theme-segments {
        width: 100%;
    }
    .small { font-size: 13px; }
    .muted { color: var(--text-tertiary); }
    .from-select {
        flex: 1;
        padding: 6px 28px 6px 8px;
        border-radius: 8px;
        border: none;
        background: var(--bg-hover);
        color: var(--text-primary);
        font-size: 15px;
        appearance: none;
        -webkit-appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7380' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 8px center;
        text-align: right;
        cursor: pointer;
    }
    .ai-input {
        width: 100%;
        padding: 8px 10px;
        border-radius: 8px;
        border: 0.5px solid var(--border-soft);
        background: var(--bg-base);
        color: var(--text-primary);
        font-size: 15px;
        outline: none;
    }
    .ai-input:focus {
        border-color: var(--accent);
    }
    .logout-wrap {
        margin-top: 24px;
        padding: 0 16px;
    }
    .logout-btn {
        width: 100%;
        padding: 12px;
        font-size: 17px;
        font-weight: 600;
        border-radius: 12px;
        border: none;
        background: var(--bg-surface);
        color: var(--danger);
        cursor: pointer;
        transition: background-color 120ms;
    }
    .logout-btn:active { background: var(--danger-soft); }
    .btn.small {
        font-size: 13px;
        padding: 5px 10px;
    }
</style>
