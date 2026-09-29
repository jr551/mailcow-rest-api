// Per-user webmail settings — persisted to localStorage. Currently holds the
// LLM provider override the user picks in the Settings panel. Sent on every
// /v1/ai/* request so the call uses the user's chosen provider/key instead
// of (or as a fallback to) the server's env-default.

import { getAiConfig, getTtsConfig, apiUrl, type AiConfig, type TtsConfig } from './api';
import { getSession, bearerHeader } from './auth.svelte';

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
    /**
     * Master switch for every AI surface (chat bot, AI panel, chat app,
     * voice, AI sort/briefing/calendar-scan, AI folder auto-icon, compose
     * AI helpers, and every AI entry point in Settings itself).
     *
     * IMPORTANT: this is a CLIENT preference, not a server gate. The
     * server's /v1/ai/* routes remain reachable for an authenticated
     * session regardless of this flag, and the browser's own LLM calls
     * (chat/completions to the user's own provider) are obviously not
     * something a server could police either. "Hard off" here means hard
     * off in the UI: no affordance is rendered, so nothing is triggered
     * by clicking around. We deliberately do NOT try to make the server
     * trust a client flag — that would be security theatre.
     */
    aiFeatures: boolean;
    density: Density;
    listFilter: ListFilter;
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
    /** Fetch remote images through /v1/proxy/image so the sender's CDN never
     *  sees the user's IP, user-agent, or connection time. ON by default:
     *  remote images are always allowed, so this flag only decides HOW they
     *  are fetched — turning it off makes the browser talk to the sender's
     *  host directly, which gives away your address.
     *
     *  Note what it does NOT hide: that the message was opened, at what
     *  time, and for how long. A tracking pixel served through the proxy
     *  still records the read on the sender's side, and the proxy caches
     *  the response for 24h. Privacy-facts.ts states this in the UI. */
    proxyImages: boolean;
    /** When true, sessions are persisted to localStorage so the user stays
     *  signed in across browser restarts without relying on the "remember me"
     *  credential vault. */
    permanentSignIn: boolean;
    phishingScan: boolean;
    /** Default the spy/track-opens toggle in Compose to ON. */
    trackOpensDefault: boolean;
    /** When true, Compose asks the AI for a subject as soon as the user
     *  blurs the body (not just when they hit Send). Off by default — it
     *  costs LLM tokens for every draft so opt-in. */
    aiSuggestSubjectOnBlur: boolean;
    /** When true, opening a Reply / Reply-all offers a suggested reply
     *  computed by the AI, in a strip above the editor. Opt-in: it costs
     *  one LLM call per reply draft opened, and "let the model write my
     *  mail" is not something to opt anyone into. The strip is inert —
     *  nothing reaches the body until the user presses Accept.
     *
     *  This is subordinate to aiFeatures, not a peer of it: the master
     *  switch is the privacy control, so Compose refuses to fire at all
     *  when AI is hard-off regardless of what this says. */
    aiSuggestReply: boolean;
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
    /** The Outlook skin deliberately keeps the top bar sparse (its extras
     *  CSS hides the chip outright), so that skin needs a separate opt-in.
     *  Off by default: a user who never asked for the chip on OWA should
     *  not find it silently there. */
    weatherChipOutlook: boolean;
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
    /** Collapse the left sidebar — the narrow app rail (Mail / Calendar /
     *  AI / Drive), not the folder box list next to it. Toggled from the
     *  topbar panel button, remembered here so a hidden rail survives
     *  reloads. */
    hideSidebar: boolean;
    /** Check a link's destination with VirusTotal before opening it.
     *
     *  DEFAULT ON, which is a considered choice rather than an oversight:
     *  the failure mode of "off" is a user who clicks a phishing link with
     *  no prompt, and the prompt is one keypress to dismiss. The failure
     *  mode of "on" is a third party learning which links you follow — real,
     *  and the reason the switch exists and the AI hard-off suppresses this
     *  along with every other AI-adjacent feature. A user who wants no
     *  third-party disclosure at all sets aiFeatures=false, which is a
     *  stronger statement than any per-feature toggle. */
    linkSafetyCheck: boolean;
}


const defaultLlm: LlmConfig = {
    kind: 'openai',
    preset: 'mistral',
    apiKey: '',
    baseUrl: '',
    model: ''
};

function load(): Settings {
    // Migrate FIRST, then read. The remote-image migration rewrites the
    // stored blob and hands the new bytes back, and every field below is
    // parsed out of THAT — so migrating before the parse is what guarantees
    // the live object and the persisted blob describe the same thing on the
    // very first session after an upgrade. Reading first and migrating
    // afterwards (as the migration it replaces did) left one session where
    // the two disagreed, which is exactly the class of bug the old test
    // suite was written to catch.
    const raw = migrateRemoteImagesAlwaysAllowed(localStorage.getItem(STORAGE_KEY));
    let out: Settings;
    try {
        if (raw) {
            const parsed = JSON.parse(raw);
            out = {
                llm: { ...defaultLlm, ...(parsed.llm || {}) },
                useCustomLlm: !!parsed.useCustomLlm,
                aiFeatures: parsed.aiFeatures !== false,
                density: parsed.density === 'compact' ? 'compact' : 'comfortable',
                listFilter: ['all', 'unread', 'starred', 'attachments', 'ai-sorted'].includes(parsed.listFilter)
                    ? parsed.listFilter : 'all',
                aiSystemPrompt: typeof parsed.aiSystemPrompt === 'string' ? parsed.aiSystemPrompt : '',
                accountChipDisplay: parsed.accountChipDisplay === 'name' ? 'name' : 'email',
                defaultFromAddress: typeof parsed.defaultFromAddress === 'string' ? parsed.defaultFromAddress : '',
                displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
                pageSize: parsed.pageSize === 'unlimited' ? 'unlimited'
                    : (typeof parsed.pageSize === 'number' && parsed.pageSize > 0 && parsed.pageSize <= 1000)
                        ? parsed.pageSize
                        : 25,
                // Remote images are ALWAYS allowed now — there is no
                // `allowImages` decision left in either reader. `proxyImages`
                // survives as the only image knob because it decides HOW an
                // image is fetched, and it must read as ON even for a profile
                // that once stored `false`: with blocking gone, an explicit
                // false would otherwise silently become "load straight from
                // the sender" and hand out the user's IP. The migration
                // below rewrites the stored blob to match, so this line is
                // the fallback for the one session before its rewrite is
                // read back — see migrateRemoteImagesAlwaysAllowed.
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
                aiSuggestReply: parsed.aiSuggestReply !== false,
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
                weatherChip: !!parsed.weatherChip,
                weatherChipOutlook: !!parsed.weatherChipOutlook,
                weatherLatitude: typeof parsed.weatherLatitude === 'number' ? parsed.weatherLatitude : 51.5074,
                weatherLongitude: typeof parsed.weatherLongitude === 'number' ? parsed.weatherLongitude : -0.1278,
                weatherUnits: parsed.weatherUnits === 'fahrenheit' ? 'fahrenheit' : 'celsius',
                calendarTicker: !!parsed.calendarTicker,
                calendarTickerTitles: !!parsed.calendarTickerTitles,
                // The app rail (Mail / Calendar / AI / Drive) is VISIBLE by
                // default. This line read `parsed.hideSidebar !== false`,
                // which defaults to TRUE — and since commit c7ef6fc "true"
                // also means "the rail is collapsed" (it stopped targeting
                // the folder pane and started targeting <AppSwitcher />), so
                // the rail shipped HIDDEN for every user. Default to shown;
                // a user who explicitly collapsed it still has `true` stored
                // and keeps the collapsed rail.
                hideSidebar: parsed.hideSidebar === true,
                // `!== false` so an existing profile that has never heard of
                // this field inherits the on-by-default behaviour, matching a
                // fresh profile. An explicit `false` from a user who turned
                // it off is preserved.
                linkSafetyCheck: parsed.linkSafetyCheck !== false
            };
            // Sanitise the blob on the way past, not just the object we
            // return, so the stale field can't come back via settings-sync.
            migrateStripClientRules(raw);
            return out;
        }
    } catch { /* noop */ }
    return {
        llm: { ...defaultLlm },
        useCustomLlm: false,
        aiFeatures: true,
        density: 'comfortable',
        listFilter: 'all',
        aiSystemPrompt: '',
        accountChipDisplay: 'email',
        defaultFromAddress: '',
        displayName: '',
        pageSize: 25,
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
        aiSuggestReply: true,
        preSendCheck: true,
        composeHistorySummary: true,
        vipAddresses: 'family@delivering.email, family@rowe.net.me',
        weatherChip: false,
        weatherChipOutlook: false,
        weatherLatitude: 51.5074,
        weatherLongitude: -0.1278,
        weatherUnits: 'celsius',
        calendarTicker: false,
        calendarTickerTitles: false,
        // Rail VISIBLE on a fresh profile. See the load() comment: `true`
        // means collapsed, so defaulting it true hid the app rail.
        hideSidebar: false,
        // Link checking defaults on — see the Settings interface note. The
        // AI hard-off in linkCheckEnabled() is the real privacy control.
        linkSafetyCheck: true
    };
}

/* Move every profile out of the blocked state.
 *
 * This migration is the INVERSE of the one it replaces, and it is not a
 * downgrade of it. v0.19.0 made "blocked by default" the shipped rule and
 * used `preRemoteImagesAutoAllowed` to preserve EFFECTIVE behaviour for
 * upgrading profiles. The product decision has since reversed: remote
 * content is always allowed, and fetched through the proxy, because the
 * blocking prompt was showing up on ordinary mail and the user read it as
 * "this mailbox is broken" rather than "this mailbox is private".
 *
 * So the same population that migration protected is exactly the population
 * that is now stuck in the state it preserved: anyone on
 * `alwaysAllowImages: false` keeps a "Load remote content" overlay on every
 * message with images in it, and nothing in the UI ever gets them out of it
 * once the toggle that produced the state is gone. That is the bug the
 * deployed screenshot is showing.
 *
 * Two stored values are rewritten:
 *
 *   `alwaysAllowImages` — deleted outright. The field no longer has any
 *   reader; leaving it behind means settings-sync keeps round-tripping a
 *   value that means nothing, and it is what makes the OLD migration's
 *   marker ambiguous from here on.
 *
 *   `proxyImages` — forced to true. NOT respected even where the profile
 *   stored `false` explicitly, which is the one judgement call here. With
 *   blocking removed, `false` can no longer mean "be strict"; the only
 *   thing left it can mean is "connect to the sender's CDN from the user's
 *   own browser", which hands over their IP, user-agent and connection
 *   timing. Letting a stale `false` survive would mean the release
 *   advertises "always allowed through the proxy" and, for exactly the
 *   users who had turned the proxy off, delivers it direct instead. The
 *   user can still switch it back off in Settings → Privacy at any time,
 *   which is a visible, reversible act; silently not migrating is not.
 *
 * ONE-SHOT, via a stamp. A state predicate ("is the blob already in the
 * shape we want?") looks equivalent and is not: with blocking removed, a
 * stored `proxyImages: false` is a legitimate thing for a user to have —
 * it is the supported way to load images directly — so the predicate can
 * never distinguish "opted out before the upgrade" from "opted out after
 * it", and it would re-proxy them on every single reload. So the marker is
 * the marker, exactly as the migration it replaces used one: stamped the
 * first time it runs, never consulted again.
 *
 * Returns whether it actually changed the blob, and load() uses that to know
 * it is reading post-migration bytes.
 *
 * The stamp is NOT a user-facing setting and is never rendered — see the
 * same warning on the marker this one replaced. */
const REMOTE_IMAGES_MIGRATED_KEY = 'remoteImagesAlwaysAllowed';

function migrateRemoteImagesAlwaysAllowed(raw: string | null): string | null {
    if (!raw) return raw;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return raw;
        // Already migrated — hands back the untouched blob so a profile the
        // user has since reconfigured is read exactly as they left it.
        if (parsed[REMOTE_IMAGES_MIGRATED_KEY] === true) return raw;
        delete parsed.alwaysAllowImages;
        parsed.proxyImages = true;
        parsed[REMOTE_IMAGES_MIGRATED_KEY] = true;
        const next = JSON.stringify(parsed);
        localStorage.setItem(STORAGE_KEY, next);
        return next;
    } catch { /* not our JSON — load() falls back to defaults anyway */ }
    return raw;
}

/* Client-side rules (the in-browser "move / archive / AI-brief" engine) were
 * deleted wholesale: the builder UI, the runner, and the stored rules. An
 * upgrading user still has `clientRules` sitting in their localStorage blob
 * *and* in the newest IMAP-synced `.storage_webmailsettings` snapshot, which
 * settings-sync would happily merge straight back in. So the blob is
 * sanitised on the local read path here, on the synced read path in
 * settings-sync, and rewritten to localStorage so the delete is durable.
 *
 * Without this the rules would linger invisibly: no UI to remove them, no
 * runner to apply them, and a future re-add of the field would silently
 * re-arm them years later. */
function migrateStripClientRules(raw: string | null) {
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        if (!('clientRules' in parsed)) return;
        delete parsed.clientRules;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    } catch { /* not our JSON — load() falls back to defaults anyway */ }
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

export function setAiFeatures(on: boolean) {
    state.aiFeatures = on;
    // Leaving 'ai-sorted' selected while AI is off would render a
    // category-grouped list nobody can regenerate (the sort button that
    // drives it is gone). Fall back to the unfiltered list so the user
    // is never stranded on a view with no visible way out. The mobile
    // shell keeps its own filter in mobile/lib/store.svelte and resets
    // it from an $effect there rather than reaching across that layer
    // from here.
    if (!on && state.listFilter === 'ai-sorted') state.listFilter = 'all';
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


export function setPageSize(size: number | 'unlimited') {
    state.pageSize = size;
    persist(state);
}


export function setGroupThreads(on: boolean) {
    state.groupThreads = on;
    persist(state);
}

/* Turning this OFF is the only remaining way to make the browser talk to a
 * sender's CDN directly, which reveals the user's IP. Images still load —
 * there is no blocking path left — so this is a routing choice, not a
 * permission one, and the Privacy panel says so. */

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

export function setAiSuggestReply(on: boolean) {
    state.aiSuggestReply = on;
    persist(state);
}

export function setVipAddresses(s: string) {
    state.vipAddresses = s;
    persist(state);
}

/** Parse the user's VIP address list into a normalised set. Empty
 *  strings, whitespace, and casing are tolerated. */
function vipAddressSet(): Set<string> {
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

export function setWeatherChipOutlook(on: boolean) {
    state.weatherChipOutlook = on;
    persist(state);
}

export function setHideSidebar(on: boolean) {
    state.hideSidebar = on;
    persist(state);
}

export function setLinkSafetyCheck(on: boolean) {
    state.linkSafetyCheck = on;
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
    if (!state.aiFeatures) return false;
    if (!capState.caps) return false;
    if (capState.caps.configured) return true;
    if (capState.caps.allowClientOverride && state.useCustomLlm && state.llm.apiKey) return true;
    return false;
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

// --- Provider model catalog -------------------------------------------------
//
// The Settings model field is a <datalist> combobox: free-form typing still
// wins (a gateway may serve a model it never indexed, and the operator may
// have a private deployment), but offering the gateway's actual list stops
// "Invalid model: …" mistypes. The list is fetched *through* the server
// because the provider key must never reach the browser.

export interface AiModel {
    id: string;
    owned_by?: string;
}

// A named model surface the gateway publishes (`rowe/free`, `rowe/value`).
//
// Why a group and not a tier: the catalogue carries no pricing or tier field
// on the model entries, so the client cannot honestly sort 577 models into
// "free" and "value" — any prefix heuristic (a `:free` suffix, a zero price)
// is a guess that rots the day the gateway renames a provider or a
// subscription model starts costing money. The gateway already publishes its
// own grouping as a first-class model id, and that id is a real model: a
// completion against `rowe/free` returns a normal chat response. So the
// honest unit is the surface itself, and membership is whatever the gateway
// reports is behind it.
export interface AiModelGroup {
    /** Gateway model id of the surface, e.g. `rowe/free`. Also selectable. */
    modelId: string;
    /** Human label for the group heading. */
    label: string;
    /**
     * Models the gateway reports as served under this surface. Falls back to
     * the surface id alone with `membershipKnown: false` on any gateway that
     * does not report membership: the surface is still selectable, we just do
     * not pretend to enumerate what is behind it.
     */
    models: AiModel[];
    membershipKnown: boolean;
}

// The two surfaces the UI groups. The gateway also publishes
// `rowe/freerotator`, `rowe/valuerotator`, `rowe/vision` and `rowe/court`;
// those stay ordinary datalist entries, because a rotator and a vision tier
// are not tiers and putting them under a heading called "Free" would be a
// lie of the same kind a pricing heuristic would be.
const AI_GROUP_SURFACES: ReadonlyArray<{ family: string; slug: string; label: string }> = [
    { family: 'rowe', slug: 'free', label: 'Free' },
    { family: 'rowe', slug: 'value', label: 'Value' }
];

// Is this catalog entry one of the grouped surfaces?
//
// Fussy because it has to be. The server reduces the provider's catalog to
// `{ id, owned_by }` (normalizeModelList, src/llm/index.js), so the
// `normalized_name`, `pricing` and context-window fields that mark a surface
// in the raw gateway payload never survive the hop. Two things are left to
// match on, and both are needed:
//
//   * the surface family (`rowe`), so `deepseek/deepseek-flash` — which does
//     carry `normalized_name` upstream and would match a shape test — and
//     `openrouter/free` are excluded;
//   * the surface slug exactly, so `rowe/freerotator` and `rowe/vision`, which
//     share the family, stay out of a heading that would mislabel them.
//
// `openrouter/free` is the case that rules out matching on the slug alone: it
// is a real OpenRouter id for a free-tier model, and an `owner/slug` test
 // picks it up as a surface.
export function isGroupSurface(m: AiModel): boolean {
    return AI_GROUP_SURFACES.some((s) => m.id === `${s.family}/${s.slug}`);
}

// Build the group list from a fetched catalog. Both groups are always
// returned so the section keeps a stable shape instead of appearing and
// disappearing as catalogs change; a group is marked "membership unknown"
// when the gateway did not describe it.
export function buildModelGroups(models: AiModel[], surfaces: Record<string, unknown> | null): AiModelGroup[] {
    const known = (slug: string): string[] | null => {
        const raw = surfaces?.[slug];
        return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id !== '') : null;
    };
    return AI_GROUP_SURFACES.map(({ family, slug, label }) => {
        // Take the id this gateway actually published, so the choice is not
        // hardcoded to one gateway's namespace.
        const surface = models.find((m) => m.id === `${family}/${slug}`) ?? null;
        const members = known(slug);
        return {
            modelId: surface?.id ?? `${family}/${slug}`,
            label,
            models: members
                ? members.map((id) => models.find((m) => m.id === id) ?? { id })
                : surface ? [surface] : [],
            membershipKnown: members !== null
        };
    });
}

export const aiModels = $state<{
    models: AiModel[];
    loading: boolean;
    /** Non-null when the last attempt failed; shown verbatim under the field. */
    error: string | null;
    /** True once a request for the *current* signature has settled (ok or not). */
    loaded: boolean;
    /**
     * The Free / Value grouping derived from `models`. Part of this state
     * object rather than a parallel store so it shares `clearAiModels` and
     * the token machinery: a second store would need its own cancellation and
     * would survive a preset switch still holding the previous gateway's
     * group names — exactly the staleness the token exists to prevent.
     */
    groups: AiModelGroup[];
}>({ models: [], loading: false, error: null, loaded: false, groups: buildModelGroups([], null) });

// Monotonic token. Every fetch bumps it; a response whose token is stale is
// dropped. Without this, switching preset twice quickly lets the first
// provider's catalog land last and populate the list with the wrong models.
let modelsToken = 0;
let modelsAbort: AbortController | null = null;

// Identifies the provider the current `aiModels` describe. The Settings
// component re-fetches when this changes — preset and base URL are the two
// inputs that determine which gateway we should be asking.
export function aiModelsSignature(): string {
    if (!state.useCustomLlm) return 'server';
    return [state.llm.kind, state.llm.preset, state.llm.baseUrl, state.llm.apiKey].join('|');
}

// Discard the catalog. Called when the signature changes so the panel can
// show a spinner rather than the previous gateway's model names. The groups
// reset on the same path: a stale "Free" heading pointing at another
// gateway's surfaces is worse than no heading, because it looks authoritative.
export function clearAiModels() {
    modelsToken++;
    modelsAbort?.abort();
    modelsAbort = null;
    aiModels.models = [];
    aiModels.groups = buildModelGroups([], null);
    aiModels.error = null;
    aiModels.loaded = false;
    aiModels.loading = false;
}

// Fetch the provider's model list. Never throws: every outcome is reflected
// in `aiModels` so the field can show loading / empty / error honestly. A
// silently empty dropdown is the failure mode worth avoiding — a user who
// can't tell "no models" from "the fetch broke" will just type a guess.
export async function loadAiModels(): Promise<void> {
    modelsAbort?.abort();
    const controller = new AbortController();
    modelsAbort = controller;
    const token = ++modelsToken;

    aiModels.loading = true;
    aiModels.error = null;
    aiModels.loaded = false;

    // Mirrors aiProviderOverride(): only the fields the user actually filled
    // in, and only when they've opted into their own provider. Otherwise the
    // server probes its own configured gateway.
    const params = new URLSearchParams();
    const ov = aiProviderOverride();
    if (ov) {
        if (ov.kind) params.set('kind', ov.kind);
        if (ov.preset) params.set('preset', ov.preset);
        if (ov.baseUrl) params.set('baseUrl', ov.baseUrl);
        if (ov.apiKey) params.set('apiKey', ov.apiKey);
    }
    const qs = params.toString();

    try {
        const session = getSession();
        const res = await fetch(apiUrl(`/v1/ai/models${qs ? `?${qs}` : ''}`), {
            headers: session ? { authorization: bearerHeader(session) } : {},
            signal: controller.signal
        });
        if (token !== modelsToken) return; // a newer fetch superseded us
        if (!res.ok) {
            aiModels.models = [];
            aiModels.groups = buildModelGroups([], null);
            aiModels.error = res.status === 501
                ? 'No API key configured for AI on the server.'
                : `Could not load models (HTTP ${res.status}).`;
        } else {
            const body = await res.json() as { models?: unknown; error?: unknown; surfaces?: unknown };
            if (token !== modelsToken) return; // json() is an await too
            aiModels.models = Array.isArray(body.models)
                ? body.models.filter((m): m is AiModel =>
                    !!m && typeof (m as AiModel).id === 'string' && (m as AiModel).id !== '')
                : [];
            // Membership is optional in the response: a gateway that only
            // publishes a flat catalog answers without `surfaces`, and the
            // groups then render as selectable surfaces with an honest
            // "not listed" note rather than pretending to enumerate.
            aiModels.groups = buildModelGroups(
                aiModels.models,
                body.surfaces !== null && typeof body.surfaces === 'object' && !Array.isArray(body.surfaces)
                    ? body.surfaces as Record<string, unknown>
                    : null
            );
            // The server reports upstream trouble as a 200 with `error` set
            // (see the route) — surface it rather than rendering an empty box.
            aiModels.error = typeof body.error === 'string' && body.error ? body.error : null;
        }
    } catch (err) {
        if (token !== modelsToken) return;
        // An aborted request is our own cancellation, not a failure to report.
        if ((err as Error)?.name === 'AbortError') return;
        aiModels.models = [];
        aiModels.groups = buildModelGroups([], null);
        aiModels.error = (err as Error)?.message || 'Could not reach the server for the model list.';
    } finally {
        if (token === modelsToken) {
            aiModels.loading = false;
            aiModels.loaded = true;
        }
    }
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
