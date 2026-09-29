// Client for the server-side VirusTotal link check.
//
// The API key is NOT here and never will be: it lives in the server's
// environment (VIRUSTOTAL_API_KEY) and is attached to the VirusTotal request
// server-side. This module speaks only to our own /v1/link-check route. That
// is not a stylistic choice — a browser-callable VirusTotal key is an
// anonymous quota-burner for anyone who opens devtools.
//
// PRIVACY TRADE-OFF, in the user's terms rather than the API's: turning this
// on means the links you click in an email get sent to VirusTotal. If the
// mail is hostile, a link unique to you turns that into a record of "this
// person opened the message" held by a third party — the same class of leak
// the remote-image proxy exists to stop, aimed at a different host. It is
// off by switch and inert whenever AI features are hard-off.
//
// The verdict is also weaker than "safe". "harmless" means at least one
// engine had an opinion and it was negative; it does not mean clean, and a
// link that is clean now can be flagged tomorrow. The UI copy says so rather
// than showing a green tick.

import { getSession, bearerHeader } from './auth.svelte';
import { apiUrl } from './api';
import { settings } from './settings.svelte';

/** VT's own vocabulary, plus the states that mean "no verdict exists".
 *  `not_found` (never submitted) and `unavailable` (scanners have not
 *  produced results) are kept distinct from `undetected` and above all from
 *  `harmless` — folding any of them into "safe" is the false all-clear this
 *  feature exists to prevent. */
export type LinkVerdict =
    | 'malicious'
    | 'phishing'
    | 'suspicious'
    | 'harmless'
    | 'undetected'
    | 'unavailable'
    | 'not_found'
    | 'timeout'
    | 'error'
    | 'unconfigured';

/** Verdicts the server can actually return. Anything else on the wire is a
 *  contract violation and becomes 'error' rather than being rendered as a
 *  state the UI has no copy for. */
const SERVER_VERDICTS: Record<string, true> = {
    malicious: true,
    phishing: true,
    suspicious: true,
    harmless: true,
    undetected: true,
    unavailable: true,
    not_found: true
};

export interface LinkCheckResult {
    url: string;
    verdict: LinkVerdict;
    malicious: number;
    suspicious: number;
    harmless: number;
    undetected: number;
    timeout: number;
    /** The page title VirusTotal recorded, when it has one. */
    title: string;
    /** Why there is no verdict, for the states that are our own doing
     *  (timeout, HTTP failure, no key). Empty when VT did answer. */
    reason: string;
}

/** A complete result carrying no verdict at all. Six call sites across the
 *  three failure paths, which must agree on shape — a partial literal at
 *  each one is where a missing field becomes a crash in the template. */
function unverified(url: string, verdict: LinkVerdict, reason: string): LinkCheckResult {
    return { url, verdict, malicious: 0, suspicious: 0, harmless: 0, undetected: 0, timeout: 0, title: '', reason };
}

/** How long to wait for the verdict before telling the user it is not coming.
 *
 *  6s. The server itself gives up at 5s, so this is the *client's* budget
 *  being slightly more generous than the server's — the point of a separate
 *  client timeout is that a hung connection, a stalled proxy or a browser
 *  holding the request open cannot leave a spinner on screen forever. The
 *  extra second lets the server's own 502 render as itself rather than
 *  being masked by our timeout message.
 *
 *  It is a ceiling, never a gate: on expiry the prompt says the check did
 *  not finish and the user carries on regardless. A safety prompt that can
 *  trap someone is worse than no prompt. */
export const LINK_CHECK_TIMEOUT_MS = 6000;

/** Is link checking active at all?
 *
 *  Two conditions, and the first is not a preference. `settings.aiFeatures`
 *  is the app's hard off — the switch a user throws when they want no
 *  content leaving the machine to a model provider at all — and this check
 *  is subordinate to it exactly like the phishing scan, the AI panel and
 *  pre-send proofreading. A per-feature toggle that outlived the master
 *  switch would be a privacy control that can be circumvented, which is
 *  worse than not having one.
 *
 *  Note what is NOT checked here: whether the server has a key. That
 *  decides whether a check produces a verdict, not whether the prompt
 *  appears — a user who left the feature on should still see the
 *  destination and a "link checking off" explanation, rather than links
 *  silently opening with no prompt at all. */
export function linkCheckEnabled(): boolean {
    return settings.linkSafetyCheck && settings.aiFeatures;
}

function authHeaders(): Record<string, string> {
    const session = getSession();
    return session ? { authorization: bearerHeader(session) } : {};
}

/** Narrow an untrusted count to a usable number. The wire payload is
 *  attacker-influenced (VT is, but so is anything in front of it), and a
 *  string or NaN reaching the template renders as "NaN vendors". */
function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Parse the route's 200 body. Returns null when the shape is not what the
 *  schema promised, so a changed contract degrades to "check unavailable"
 *  instead of rendering a verdict nobody established. */
function parseVerdict(url: string, body: unknown): LinkCheckResult | null {
    if (!body || typeof body !== 'object' || !('verdict' in body)) return null;
    const b = body as Record<string, unknown>;
    const verdict = b.verdict;
    if (typeof verdict !== 'string' || !SERVER_VERDICTS[verdict]) return null;
    return {
        url: text(b.url) || url,
        verdict: verdict as LinkVerdict,
        malicious: count(b.malicious),
        suspicious: count(b.suspicious),
        harmless: count(b.harmless),
        undetected: count(b.undetected),
        timeout: count(b.timeout),
        title: text(b.title),
        reason: ''
    };
}

let configProbe: Promise<boolean> | null = null;

/** Has the operator set a key? Probed once per page load. Resolves false on
 *  any failure — a network blip must not permanently disable the feature for
 *  the rest of the session, so the probe is re-attempted on the next load. */
export function linkCheckConfigured(): Promise<boolean> {
    if (!configProbe) {
        configProbe = fetch(apiUrl('/v1/link-check/config'), { headers: authHeaders() })
            .then(async (res) => {
                if (!res.ok) return false;
                const body: unknown = await res.json();
                return !!(body && typeof body === 'object' && 'configured' in body && body.configured === true);
            })
            .catch(() => false);
    }
    return configProbe;
}

/** Ask the server about a link. Never rejects: every failure comes back as
 *  a state the prompt can render, because a lookup that fails must still
 *  let the user through. */
export async function checkLink(url: string, opts: { signal?: AbortSignal } = {}): Promise<LinkCheckResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);
    // An external abort (the user closed the prompt, switched messages)
    // must survive too, and has to abort the controller this fetch uses.
    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onExternalAbort);
    if (opts.signal?.aborted) controller.abort();

    try {
        const res = await fetch(apiUrl(`/v1/link-check?url=${encodeURIComponent(url)}`), {
            headers: authHeaders(),
            signal: controller.signal
        });

        if (res.status === 501) return unverified(url, 'unconfigured', 'not-configured');
        if (res.status === 429) return unverified(url, 'error', 'rate-limited');
        if (!res.ok) return unverified(url, 'error', `http-${res.status}`);

        const body: unknown = await res.json();
        return parseVerdict(url, body) ?? unverified(url, 'error', 'bad-body');
    } catch (err) {
        // AbortError is either our timeout or the caller's cancellation. The
        // caller-discancelled case never reaches a UI that is still mounted
        // (the prompt is closed by then), so naming it 'timeout' here is
        // harmless and avoids threading a second failure type through for
        // one string.
        const aborted = (err as Error)?.name === 'AbortError';
        return aborted
            ? unverified(url, 'timeout', 'timeout')
            : unverified(url, 'error', text((err as Error)?.message) || 'network');
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onExternalAbort);
    }
}

/** Presentation per verdict. Tone is deliberately three-level rather than a
 *  traffic light: `good` still means "nobody objected", not "safe". */
export interface VerdictPresentation {
    label: string;
    tone: 'danger' | 'warn' | 'good' | 'neutral';
    detail: string;
}

/** A complete sentence about the vendor count, with a count-free fallback.
 *
 *  Needed because VT's own `category` can be set from a partner feed while
 *  `last_analysis_stats` reports zero — so a "malicious" verdict carrying no
 *  counts is a real payload, and rendering that as "0 security vendors flag
 *  this" is a sentence that is both absurd and technically true. The caller
 *  must NOT append its own full stop. */
function vendorCount(n: number, counted: string, uncounted: string): string {
    return n > 0
        ? `${n} ${counted}.`
        : `Flagged by VirusTotal as ${uncounted}, with no vendor count reported.`;
}

export function describeVerdict(r: LinkCheckResult): VerdictPresentation {
    const flagged = r.malicious + r.suspicious;
    switch (r.verdict) {
        case 'phishing':
            return {
                label: 'Known phishing site',
                tone: 'danger',
                detail: vendorCount(flagged, 'security vendors flag this link as phishing', 'a phishing site')
            };
        case 'malicious':
            return {
                label: 'Flagged as malicious',
                tone: 'danger',
                detail: vendorCount(flagged, 'security vendors flag this link as malicious', 'malicious')
            };
        case 'suspicious':
            return {
                label: 'Suspicious',
                tone: 'warn',
                detail: flagged > 0
                    ? `${flagged} vendors flag this link as suspicious — not confirmed, but not clean either.`
                    : 'Flagged as suspicious, with no vendor count reported. Not confirmed, but not clean either.'
            };
        case 'harmless':
            return {
                label: 'No known threats',
                tone: 'good',
                detail: `${r.harmless} vendors checked this link and found nothing. Nobody has objected — that is not a guarantee it is safe.`
            };
        case 'undetected':
            return {
                label: 'Not checked',
                tone: 'neutral',
                detail: 'No vendor has an opinion on this link. That is not the same as being safe.'
            };
        case 'unavailable':
            return {
                label: 'No results yet',
                tone: 'neutral',
                detail: 'A scan was started but has not produced results. Treat this as unchecked.'
            };
        case 'not_found':
            return {
                label: 'Never scanned',
                tone: 'neutral',
                detail: 'Nobody has submitted this link for scanning, so nobody has checked it. This says nothing about whether it is safe.'
            };
        case 'timeout':
            return {
                label: 'Check timed out',
                tone: 'neutral',
                detail: 'The check did not finish in time. You can carry on — the link has not been cleared either way.'
            };
        case 'unconfigured':
            return {
                label: 'Link checking off',
                tone: 'neutral',
                detail: 'This server has no VirusTotal key configured, so links are not being checked.'
            };
        default:
            return {
                label: 'Check unavailable',
                tone: 'neutral',
                detail: 'The link could not be checked right now. You can carry on.'
            };
    }
}
