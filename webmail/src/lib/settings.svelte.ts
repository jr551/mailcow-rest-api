// Per-user webmail settings — persisted to localStorage. Currently holds the
// LLM provider override the user picks in the Settings panel. Sent on every
// /v1/ai/* request so the call uses the user's chosen provider/key instead
// of (or as a fallback to) the server's env-default.

import { getAiConfig, getTtsConfig, apiUrl, type AiConfig, type TtsConfig } from './api';
import { getSession } from './auth.svelte';

const STORAGE_KEY = 'webmail.settings.v1';

// PWA / mobile detection. Used to default storage-volatile choices (e.g.
// permanentSignIn) more aggressively on the surface where users get burned
// by browser storage cleanup.
function isMobilePwa(): boolean {
    if (typeof window === 'undefined') return false;
    return window.location.pathname.startsWith('/webmail/mobile/');
}

export type LlmKind = 'openai' | 'anthropic';

export interface LlmConfig {
    kind: LlmKind;
    preset: string;       // 'mistral' | 'openai' | 'groq' | 'ollama' | 'together' | 'perplexity' | 'openrouter' | '' (custom)
    apiKey: string;
    baseUrl: string;
    model: string;
}

export type Density = 'comfortable' | 'compact';
export type ListFilter = 'all' | 'unread' | 'starred' | 'attachments' | 'ai-sorted';

export interface Settings {
    llm: LlmConfig;
    useCustomLlm: boolean; // when false, server defaults are used (no provider override sent)
    density: Density;
    listFilter: ListFilter;
    /** When true, j/k/r/a/c/s/u/#/etc. are bound to actions globally. Off by default. */
    keyboardShortcuts: boolean;
    /** User-supplied system prompt for the AI surface. Empty → use the built-in default. */
    aiSystemPrompt: string;
    /** What the top-right account chip shows: 'email' or 'name'. */
    accountChipDisplay: 'email' | 'name';
    /** Override From address for new messages. Empty → fall back to the active session user. */
    defaultFromAddress: string;
    /** Friendly display name appended to the From header so recipients
     *  see "John Rowe" <you@…> instead of just the bare local-part. */
    displayName: string;
    /** Page size for the message list. 'unlimited' sends a generous server-side cap (1000). */
    pageSize: number | 'unlimited';
    /** Master override: load remote images for every message, no per-sender prompt. */
    alwaysAllowImages: boolean;
    /** Group messages by thread (References + In-Reply-To, with subject fallback). */
    groupThreads: boolean;
    /** Route remote images through /v1/proxy/image so the upstream host never
     *  sees the user's IP. Has no effect when alwaysAllowImages / per-sender
     *  trust isn't granted (the image still has to be allowed first). */
    proxyImages: boolean;
    /** When true, sessions are persisted to localStorage so the user stays
     *  signed in across browser restarts without relying on the "remember me"
     *  credential vault. */
    permanentSignIn: boolean;
    /** Scan emails for phishing indicators when opening a message. */
    phishingScan: boolean;
    /** Default the spy/track-opens toggle in Compose to ON. */
    trackOpensDefault: boolean;
    /** When true, Compose asks the AI for a subject as soon as the user
     *  blurs the body (not just when they hit Send). Off by default — it
     *  costs LLM tokens for every draft so opt-in. */
    aiSuggestSubjectOnBlur: boolean;
    /** Phishing scan: max wall-clock seconds to wait for the LLM before
     *  giving up. Default 8s. */
    phishingScanTimeoutSec: number;
    /** Phishing scan: extra system-prompt text the user can prepend to
     *  bias the analysis (e.g. "I'm a security researcher, be paranoid"). */
    phishingScanPromptAddendum: string;
    /** Phishing: confidence floor (0..1) below which we don't trip the
     *  smoke effect. */
    phishingScanConfidenceFloor: number;
    /** Master toggle for the bundled tesseract.js OCR engine. When on, the
     *  worker + WASM core are downloaded + warmed up so other features
     *  (currently: phishing scan) can OCR images locally without the
     *  bytes ever leaving the browser. */
    tesseractOcrInstalled: boolean;
    /** When on AND tesseractOcrInstalled is on, the phishing scan OCRs
     *  inline body images (https + data URLs) and folds the extracted
     *  text into the LLM context. Catches phishers who hide their text
     *  in images to evade text-based filters. */
    phishingScanOcrInline: boolean;
    /** Surface the secondary spam classification from the same scan
     *  call. When on, messages flagged as spam (above the floor) get a
     *  "Looks like spam — move to Spam folder?" prompt. The phishing
     *  warning still fires independently. No extra LLM cost — the
     *  classification ships with every phishing-scan response. */
    spamSuggest: boolean;
    /** Confidence floor (0..1) for surfacing the spam prompt. */
    spamSuggestConfidenceFloor: number;
    /** Sweep batch size — how many recent INBOX messages to scan when
     *  the spam sweep fires. Larger = slower + more tokens, smaller =
     *  misses older spam. The standalone "Sweep inbox now" button has
     *  been retired; sweep now piggybacks on AI sort (see below). */
    spamSweepBatchSize: number;
    /** When the user kicks off AI sort, also run the spam sweep over
     *  the same list. Defaults on so spam classification is a no-extra-
     *  click bonus on the sort the user already wanted. */
    aiSortSweepSpam: boolean;
    /** Run a one-shot AI proofread before sending each message. The
     *  model returns at most one suggestion (or nothing); the user
     *  can dismiss with one click. Shift+Send bypasses entirely. */
    preSendCheck: boolean;
    /** Show the AI summary of past correspondence when composing to
     *  a known address. Off-switchable for users who find it noisy. */
    composeHistorySummary: boolean;
    /** Comma-separated VIP addresses (lowercased on parse). Messages
     *  involving these get a family icon next to the avatar with a
     *  "this was sent to/from <address> <vip>" tooltip. */
    vipAddresses: string;
    /** Show the Open-Meteo weather chip in the desktop top bar. */
    weatherChip: boolean;
    /** Latitude for the weather chip. Defaults to London. */
    weatherLatitude: number;
    /** Longitude for the weather chip. */
    weatherLongitude: number;
    /** Temperature units for the weather chip. */
    weatherUnits: 'celsius' | 'fahrenheit';
    /** Show the next-event calendar ticker in the desktop top bar. */
    calendarTicker: boolean;
    /** Show the event's actual title in the global header. Off by default:
     *  the header is visible from Mail, AI, Drive and Settings, so a title
     *  there is on screen during a share or to anyone glancing over. The
     *  ticker still shows timing, which is the useful part. */
    calendarTickerTitles: boolean;
    /** Client-side rules. Run when the inbox list loads — match on
     *  envelope fields and either move the message somewhere, archive
     *  it, or kick off an AI action that pops the row away while it
     *  works. Synced via settings-sync so a rule added on one device
     *  fires on every device. Empty by default. */
    clientRules: ClientRule[];
}

export type ClientRuleConditionType = 'from-contains' | 'subject-contains' | 'to-contains' | 'from-domain';
export type ClientRuleActionType = 'move' | 'archive' | 'trash' | 'mark-read' | 'ai-summarize-archive' | 'ai-brief';

export interface ClientRuleCondition {
    type: ClientRuleConditionType;
    value: string;
}

export interface ClientRuleAction {
    type: ClientRuleActionType;
    folder?: string; // required when type === 'move'
}

export interface ClientRule {
    id: string;
    enabled: boolean;
    name: string;
    condition: ClientRuleCondition;
    action: ClientRuleAction;
}

const defaultLlm: LlmConfig = {
    kind: 'openai',
    preset: 'mistral',
    apiKey: '',
    baseUrl: '',
    model: ''
};

function load(): Settings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                llm: { ...defaultLlm, ...(parsed.llm || {}) },
                useCustomLlm: !!parsed.useCustomLlm,
                density: parsed.density === 'compact' ? 'compact' : 'comfortable',
                listFilter: ['all', 'unread', 'starred', 'attachments', 'ai-sorted'].includes(parsed.listFilter)
                    ? parsed.listFilter : 'all',
                keyboardShortcuts: !!parsed.keyboardShortcuts,
                aiSystemPrompt: typeof parsed.aiSystemPrompt === 'string' ? parsed.aiSystemPrompt : '',
                accountChipDisplay: parsed.accountChipDisplay === 'name' ? 'name' : 'email',
                defaultFromAddress: typeof parsed.defaultFromAddress === 'string' ? parsed.defaultFromAddress : '',
                displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
                pageSize: parsed.pageSize === 'unlimited' ? 'unlimited'
                    : (typeof parsed.pageSize === 'number' && parsed.pageSize > 0 && parsed.pageSize <= 1000)
                        ? parsed.pageSize
                        : 25,
                alwaysAllowImages: !!parsed.alwaysAllowImages,
                groupThreads: parsed.groupThreads !== false,
                proxyImages: parsed.proxyImages !== false,
                // Mobile defaults this to true on first launch — iOS PWA
                // storage is too volatile to leave perma-signin opt-in.
                permanentSignIn: parsed.permanentSignIn === undefined
                    ? isMobilePwa()
                    : !!parsed.permanentSignIn,
                phishingScan: parsed.phishingScan !== false,
                trackOpensDefault: !!parsed.trackOpensDefault,
                aiSuggestSubjectOnBlur: !!parsed.aiSuggestSubjectOnBlur,
                phishingScanTimeoutSec: typeof parsed.phishingScanTimeoutSec === 'number' && parsed.phishingScanTimeoutSec > 0
                    ? Math.min(60, parsed.phishingScanTimeoutSec) : 8,
                phishingScanPromptAddendum: typeof parsed.phishingScanPromptAddendum === 'string'
                    ? parsed.phishingScanPromptAddendum.slice(0, 500) : '',
                phishingScanConfidenceFloor: typeof parsed.phishingScanConfidenceFloor === 'number'
                    ? Math.max(0, Math.min(1, parsed.phishingScanConfidenceFloor)) : 0.7,
                tesseractOcrInstalled: !!parsed.tesseractOcrInstalled,
                phishingScanOcrInline: !!parsed.phishingScanOcrInline,
                spamSuggest: parsed.spamSuggest !== false,
                spamSuggestConfidenceFloor: typeof parsed.spamSuggestConfidenceFloor === 'number'
                    ? Math.max(0, Math.min(1, parsed.spamSuggestConfidenceFloor)) : 0.7,
                spamSweepBatchSize: typeof parsed.spamSweepBatchSize === 'number' && parsed.spamSweepBatchSize > 0
                    ? Math.min(200, Math.max(10, Math.round(parsed.spamSweepBatchSize))) : 50,
                aiSortSweepSpam: parsed.aiSortSweepSpam !== false,
                preSendCheck: parsed.preSendCheck !== false,
                composeHistorySummary: parsed.composeHistorySummary !== false,
                vipAddresses: typeof parsed.vipAddresses === 'string'
                    ? parsed.vipAddresses
                    : 'family@delivering.email, family@rowe.net.me',
                weatherChip: parsed.weatherChip !== false,
                weatherLatitude: typeof parsed.weatherLatitude === 'number' ? parsed.weatherLatitude : 51.5074,
                weatherLongitude: typeof parsed.weatherLongitude === 'number' ? parsed.weatherLongitude : -0.1278,
                weatherUnits: parsed.weatherUnits === 'fahrenheit' ? 'fahrenheit' : 'celsius',
                calendarTicker: parsed.calendarTicker !== false,
                calendarTickerTitles: !!parsed.calendarTickerTitles,
                clientRules: Array.isArray(parsed.clientRules)
                    ? parsed.clientRules.filter(isValidClientRule)
                    : []
            };
        }
    } catch { /* noop */ }
    return {
        llm: { ...defaultLlm },
        useCustomLlm: false,
        density: 'comfortable',
        listFilter: 'all',
        keyboardShortcuts: false,
        aiSystemPrompt: '',
        accountChipDisplay: 'email',
        defaultFromAddress: '',
        displayName: '',
        pageSize: 25,
        alwaysAllowImages: false,
        groupThreads: true,
        proxyImages: true,
        permanentSignIn: isMobilePwa(),
        phishingScan: true,
        trackOpensDefault: false,
        aiSuggestSubjectOnBlur: false,
        phishingScanTimeoutSec: 8,
        phishingScanPromptAddendum: '',
        phishingScanConfidenceFloor: 0.7,
        tesseractOcrInstalled: false,
        phishingScanOcrInline: false,
        spamSuggest: true,
        spamSuggestConfidenceFloor: 0.7,
        spamSweepBatchSize: 50,
        aiSortSweepSpam: true,
        preSendCheck: true,
        composeHistorySummary: true,
        vipAddresses: 'family@delivering.email, family@rowe.net.me',
        weatherChip: true,
        weatherLatitude: 51.5074,
        weatherLongitude: -0.1278,
        weatherUnits: 'celsius',
        calendarTicker: true,
        calendarTickerTitles: false,
        clientRules: []
    };
}

const VALID_RULE_CONDITION_TYPES: ClientRuleConditionType[] = [
    'from-contains', 'subject-contains', 'to-contains', 'from-domain'
];
const VALID_RULE_ACTION_TYPES: ClientRuleActionType[] = [
    'move', 'archive', 'trash', 'mark-read', 'ai-summarize-archive', 'ai-brief'
];

function isValidClientRule(r: unknown): r is ClientRule {
    if (!r || typeof r !== 'object') return false;
    const rec = r as Record<string, unknown>;
    if (typeof rec.id !== 'string' || typeof rec.name !== 'string') return false;
    if (typeof rec.enabled !== 'boolean') return false;
    const cond = rec.condition as Record<string, unknown> | null;
    if (!cond || typeof cond !== 'object') return false;
    if (!VALID_RULE_CONDITION_TYPES.includes(cond.type as ClientRuleConditionType)) return false;
    if (typeof cond.value !== 'string') return false;
    const act = rec.action as Record<string, unknown> | null;
    if (!act || typeof act !== 'object') return false;
    if (!VALID_RULE_ACTION_TYPES.includes(act.type as ClientRuleActionType)) return false;
    if (act.type === 'move' && typeof act.folder !== 'string') return false;
    return true;
}

function persist(s: Settings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch { /* quota or disabled */ }
}

const state = $state<Settings>(load());

export const settings = state;

export function setLlm(patch: Partial<LlmConfig>) {
    state.llm = { ...state.llm, ...patch };
    persist(state);
}

export function setUseCustomLlm(on: boolean) {
    state.useCustomLlm = on;
    persist(state);
}

export function setDensity(d: Density) {
    state.density = d;
    persist(state);
}

export function setListFilter(f: ListFilter) {
    state.listFilter = f;
    persist(state);
}

export function setKeyboardShortcuts(on: boolean) {
    state.keyboardShortcuts = on;
    persist(state);
}

export function setAiSystemPrompt(prompt: string) {
    state.aiSystemPrompt = prompt;
    persist(state);
}

export function setAccountChipDisplay(mode: 'email' | 'name') {
    state.accountChipDisplay = mode;
    persist(state);
}

export function setDefaultFromAddress(addr: string) {
    state.defaultFromAddress = addr;
    persist(state);
}

export function setDisplayName(name: string) {
    state.displayName = name;
    persist(state);
}

/* Title-cased best guess at a friendly name from an email's local
 * part: "john.rowe@x" → "John Rowe", "jane_smith@x" → "Jane Smith".
 * Used as a fallback when the user hasn't set an explicit display
 * name — better than the recipient seeing a bare address. */
export function deriveNameFromAddress(addr: string): string {
    const local = (addr || '').split('@')[0] || '';
    return local
        .replace(/[._+-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b(\p{L})(\p{L}*)/gu, (_, h, t) => h.toUpperCase() + t.toLowerCase());
}

/* What the From-name should be on this send, given the chosen from
 * address. Honours the user's saved displayName first, then derives
 * a friendly fallback from the address local part. Returns undefined
 * only if we genuinely have nothing to put there. */
export function pickFromName(fromAddr: string): string | undefined {
    const explicit = state.displayName?.trim();
    if (explicit) return explicit;
    const derived = deriveNameFromAddress(fromAddr);
    return derived || undefined;
}

function newRuleId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return (crypto as { randomUUID: () => string }).randomUUID();
    }
    return `r${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function addClientRule(rule: Omit<ClientRule, 'id' | 'enabled'> & { enabled?: boolean }): ClientRule {
    const next: ClientRule = {
        id: newRuleId(),
        enabled: rule.enabled ?? true,
        name: rule.name,
        condition: { ...rule.condition },
        action: { ...rule.action }
    };
    state.clientRules = [...state.clientRules, next];
    persist(state);
    return next;
}

export function updateClientRule(id: string, patch: Partial<Omit<ClientRule, 'id'>>): void {
    state.clientRules = state.clientRules.map((r) => r.id === id ? { ...r, ...patch } : r);
    persist(state);
}

export function removeClientRule(id: string): void {
    state.clientRules = state.clientRules.filter((r) => r.id !== id);
    persist(state);
}

export function setPageSize(size: number | 'unlimited') {
    state.pageSize = size;
    persist(state);
}

export function setAlwaysAllowImages(on: boolean) {
    state.alwaysAllowImages = on;
    persist(state);
}

export function setGroupThreads(on: boolean) {
    state.groupThreads = on;
    persist(state);
}

export function setProxyImages(on: boolean) {
    state.proxyImages = on;
    persist(state);
}

export function setPermanentSignIn(on: boolean) {
    state.permanentSignIn = on;
    persist(state);
}

export function setPhishingScan(on: boolean) {
    state.phishingScan = on;
    persist(state);
}

export function setTrackOpensDefault(on: boolean) {
    state.trackOpensDefault = on;
    persist(state);
}

export function setAiSuggestSubjectOnBlur(on: boolean) {
    state.aiSuggestSubjectOnBlur = on;
    persist(state);
}

export function setPhishingScanTimeoutSec(s: number) {
    state.phishingScanTimeoutSec = Math.max(2, Math.min(60, Math.round(s)));
    persist(state);
}

export function setPhishingScanPromptAddendum(s: string) {
    state.phishingScanPromptAddendum = (s || '').slice(0, 500);
    persist(state);
}

export function setPhishingScanConfidenceFloor(v: number) {
    state.phishingScanConfidenceFloor = Math.max(0, Math.min(1, v));
    persist(state);
}

export function setTesseractOcrInstalled(on: boolean) {
    state.tesseractOcrInstalled = on;
    // Disabling the engine implicitly disables every feature that uses
    // it — otherwise the user would see a phishing toggle that points
    // to a torn-down worker.
    if (!on) state.phishingScanOcrInline = false;
    persist(state);
}

export function setPhishingScanOcrInline(on: boolean) {
    state.phishingScanOcrInline = on;
    persist(state);
}

export function setSpamSuggest(on: boolean) {
    state.spamSuggest = on;
    persist(state);
}

export function setSpamSuggestConfidenceFloor(v: number) {
    state.spamSuggestConfidenceFloor = Math.max(0, Math.min(1, v));
    persist(state);
}

export function setSpamSweepBatchSize(n: number) {
    state.spamSweepBatchSize = Math.max(10, Math.min(200, Math.round(n)));
    persist(state);
}

export function setAiSortSweepSpam(on: boolean) {
    state.aiSortSweepSpam = on;
    persist(state);
}

export function setPreSendCheck(on: boolean) {
    state.preSendCheck = on;
    persist(state);
}

export function setComposeHistorySummary(on: boolean) {
    state.composeHistorySummary = on;
    persist(state);
}

export function setVipAddresses(s: string) {
    state.vipAddresses = s;
    persist(state);
}

/** Parse the user's VIP address list into a normalised set. Empty
 *  strings, whitespace, and casing are tolerated. */
export function vipAddressSet(): Set<string> {
    const out = new Set<string>();
    for (const part of (state.vipAddresses || '').split(/[\s,;]+/)) {
        const a = part.trim().toLowerCase();
        if (a && a.includes('@')) out.add(a);
    }
    return out;
}

/** Returns the matching VIP address (lowercased) if any of the given
 *  addresses are flagged as VIP. Used to decorate avatars. */
export function isVipAddress(addresses: Array<string | null | undefined>): string | null {
    const vips = vipAddressSet();
    if (!vips.size) return null;
    for (const a of addresses) {
        const v = (a || '').trim().toLowerCase();
        if (v && vips.has(v)) return v;
    }
    return null;
}

export function setWeatherChip(on: boolean) {
    state.weatherChip = on;
    persist(state);
}

export function setWeatherLatLon(lat: number, lon: number) {
    state.weatherLatitude = lat;
    state.weatherLongitude = lon;
    persist(state);
}

export function setWeatherUnits(units: 'celsius' | 'fahrenheit') {
    state.weatherUnits = units;
    persist(state);
}

export function setCalendarTicker(on: boolean) {
    state.calendarTicker = on;
    persist(state);
}

export function setCalendarTickerTitles(on: boolean) {
    state.calendarTickerTitles = on;
    persist(state);
}

export function reset() {
    state.llm = { ...defaultLlm };
    state.useCustomLlm = false;
    state.density = 'comfortable';
    state.listFilter = 'all';
    state.keyboardShortcuts = false;
    state.aiSystemPrompt = '';
    state.accountChipDisplay = 'email';
    state.defaultFromAddress = '';
    state.displayName = '';
    state.pageSize = 25;
    state.alwaysAllowImages = false;
    state.groupThreads = true;
    state.proxyImages = true;
    state.permanentSignIn = false;
    state.phishingScan = true;
    state.trackOpensDefault = false;
    state.tesseractOcrInstalled = false;
    state.phishingScanOcrInline = false;
    persist(state);
}

// Returns the override block to send on /v1/ai/* calls, or undefined when the
// user wants the server default.
export function aiProviderOverride(): LlmConfig | undefined {
    if (!state.useCustomLlm) return undefined;
    const { llm } = state;
    // Only send fields the user actually filled in.
    const out: Partial<LlmConfig> = { kind: llm.kind };
    if (llm.preset) out.preset = llm.preset;
    if (llm.apiKey) out.apiKey = llm.apiKey;
    if (llm.baseUrl) out.baseUrl = llm.baseUrl;
    if (llm.model) out.model = llm.model;
    return out as LlmConfig;
}

// --- Server capability probe ----------------------------------------------

interface AiCapabilities {
    configured: boolean;
    kind: string;
    preset: string;
    model: string;
    allowClientOverride: boolean;
    presets: string[];
}

interface ServerCapabilities {
    ai: boolean;
    ocr: boolean;
    smtp: boolean;
    drive: boolean;
    notificationSenders?: string[];
    smsSenders?: string[];
}


// Last successful aiConfig is cached in localStorage so a transient
// /v1/ai/config failure (e.g. proxy hiccup, deploy-host network blip)
// doesn't make every AI feature think the user is unconfigured. The
// cached key keeps working until the next successful probe overwrites
// it. Two-week ceiling so a deleted-from-server key eventually clears.
const AI_CONFIG_CACHE_KEY = 'webmail.aiConfig.cache.v1';
const AI_CONFIG_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function loadCachedAiConfig(): AiConfig | null {
    try {
        const raw = localStorage.getItem(AI_CONFIG_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { ts: number; cfg: AiConfig };
        if (!parsed?.cfg || !parsed.ts) return null;
        if (Date.now() - parsed.ts > AI_CONFIG_CACHE_TTL_MS) return null;
        return parsed.cfg;
    } catch { return null; }
}

function saveCachedAiConfig(cfg: AiConfig | null) {
    try {
        if (cfg) localStorage.setItem(AI_CONFIG_CACHE_KEY, JSON.stringify({ ts: Date.now(), cfg }));
        else localStorage.removeItem(AI_CONFIG_CACHE_KEY);
    } catch { /* quota / disabled */ }
}

const capState = $state<{
    caps: AiCapabilities | null;
    server: ServerCapabilities | null;
    aiConfig: AiConfig | null;
    ttsConfig: TtsConfig | null;
    loaded: boolean;
}>({
    caps: null,
    server: null,
    // Hydrate from cache so AI features work immediately on a reload
    // even before the probe lands. The probe overwrites with fresh
    // data when it succeeds.
    aiConfig: loadCachedAiConfig(),
    ttsConfig: null,
    loaded: false
});

export const capabilities = capState;

// Replace a capability slot only when its content actually changed.
//
// This runs on a 30s timer. Assigning a fresh object every time — even an
// identical one — invalidated every $effect that reads capabilities.*,
// and several of those effects kick off real work (inbox briefing, AI
// sort, image proxying, phishing scan). The result was a background
// workload that restarted every 30 seconds for as long as the app stayed
// open. Comparing first keeps the reference stable when nothing moved.
function assignIfChanged<K extends keyof typeof capState>(key: K, next: (typeof capState)[K]): boolean {
    try {
        if (JSON.stringify(capState[key]) === JSON.stringify(next)) return false;
    } catch { /* unserializable — fall through and assign */ }
    capState[key] = next;
    return true;
}

export async function probeCapabilities(): Promise<void> {
    try {
        const [aiRes, healthRes, configRes, ttsRes] = await Promise.all([
            fetch(apiUrl('/v1/ai/capabilities')),
            fetch(apiUrl('/health')),
            getAiConfig().catch(() => null),
            getTtsConfig().catch(() => null)
        ]);
        if (aiRes.ok) assignIfChanged('caps', await aiRes.json());
        if (healthRes.ok) {
            const h = await healthRes.json();
            assignIfChanged('server', h.capabilities || { ai: false, ocr: false, smtp: false, drive: false });
        }
        if (configRes) {
            if (assignIfChanged('aiConfig', configRes)) saveCachedAiConfig(configRes);
        }
        // If configRes failed but we have a cached one, keep using it.
        // Only clear the cache when the server explicitly tells us AI
        // isn't configured at all — the 501 path returns null from
        // getAiConfig().catch(), but the capabilities endpoint will set
        // .configured = false; respect that.
        if (!configRes && capState.caps && capState.caps.configured === false) {
            capState.aiConfig = null;
            saveCachedAiConfig(null);
        }
        if (ttsRes) capState.ttsConfig = ttsRes;
    } catch {
        // network blip — treat as no caps available
    } finally {
        capState.loaded = true;
    }
}

// True when the *server-side* /v1/ai/* routes will succeed. The AI panel's
// Summarize/Draft/Actions/Translate buttons all hit those routes, so this
// must reflect server reality — not the client-side ChatBot config (which
// has its own gate via isChatConfigured()).
//
// Conditions:
//   - Server has its own LLM_API_KEY (caps.configured), OR
//   - Server has LLM_ALLOW_CLIENT_OVERRIDE=true AND the user supplied a key
export function aiAvailable(): boolean {
    if (!capState.caps) return false;
    if (capState.caps.configured) return true;
    if (capState.caps.allowClientOverride && state.useCustomLlm && state.llm.apiKey) return true;
    return false;
}

// True when the server exposes a client-usable AI config (via /v1/ai/config).
export function serverAiAvailable(): boolean {
    return !!capState.aiConfig?.configured;
}

// Bearer credential for the server-provided AI endpoint.
//
// The server no longer hands provider keys to the browser: /v1/ai/config
// returns `proxied: true` and a same-origin baseUrl, and we authenticate to
// it with the session token we already hold. Resolved per call rather than
// stored, so a renewed session is picked up immediately and no token is
// ever written to the aiConfig localStorage cache.
export function aiAuthKey(): string {
    const cfg = capState.aiConfig;
    if (cfg?.configured) {
        if (cfg.proxied) return getSession()?.token || '';
        return cfg.apiKey;
    }
    return state.llm.apiKey;
}

// True when the server has SMTP wired up (SMTP_HOST env var is set).
// Before the capabilities probe lands (capState.server === null) we treat
// SMTP as available — the alternative is showing "Sending isn't enabled"
// to every user for the first second of their session, every session,
// because the compose modal can mount before the probe completes. The
// server still rejects bad sends; this only governs the cosmetic hint.
export function smtpAvailable(): boolean {
    if (!capState.server) return true;
    return !!capState.server.smtp;
}
