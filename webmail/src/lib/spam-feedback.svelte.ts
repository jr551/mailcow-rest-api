// Per-user spam / not-spam feedback. Persisted in localStorage and
// echoed back to /v1/ai/phishing-scan on every call so the model
// biases its classification toward what this user has actually
// confirmed in the past. Two flavours:
//   - trusted{Domains,Addresses}: user said "this isn't spam"
//   - spam{Domains,Addresses}:    user said "this is spam"
//
// We cap each list so the prompt stays manageable; older entries
// fall off the end FIFO-style.

const STORE_KEY = 'webmail.spam-feedback.v1';
const MAX_PER_LIST = 200;

export interface SpamFeedback {
    trustedDomains: string[];
    trustedAddresses: string[];
    spamDomains: string[];
    spamAddresses: string[];
}

function empty(): SpamFeedback {
    return { trustedDomains: [], trustedAddresses: [], spamDomains: [], spamAddresses: [] };
}

function read(): SpamFeedback {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return empty();
        const p = JSON.parse(raw);
        return {
            trustedDomains: Array.isArray(p.trustedDomains) ? p.trustedDomains.map(String).slice(0, MAX_PER_LIST) : [],
            trustedAddresses: Array.isArray(p.trustedAddresses) ? p.trustedAddresses.map(String).slice(0, MAX_PER_LIST) : [],
            spamDomains: Array.isArray(p.spamDomains) ? p.spamDomains.map(String).slice(0, MAX_PER_LIST) : [],
            spamAddresses: Array.isArray(p.spamAddresses) ? p.spamAddresses.map(String).slice(0, MAX_PER_LIST) : []
        };
    } catch {
        return empty();
    }
}

function write(s: SpamFeedback) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

const _state = $state<SpamFeedback>(read());
export const spamFeedback = _state;

function normalise(s: string): string {
    return s.trim().toLowerCase();
}
function domainOf(addr: string): string {
    const at = addr.lastIndexOf('@');
    return at < 0 ? '' : addr.slice(at + 1).trim().toLowerCase();
}

function pushUnique(list: string[], value: string) {
    const v = normalise(value);
    if (!v) return;
    // Drop any existing entry so the new one moves to the end
    const idx = list.indexOf(v);
    if (idx >= 0) list.splice(idx, 1);
    list.push(v);
    while (list.length > MAX_PER_LIST) list.shift();
}
function dropFrom(list: string[], value: string) {
    const v = normalise(value);
    const idx = list.indexOf(v);
    if (idx >= 0) list.splice(idx, 1);
}

/** "Not spam" — trust this exact address and remove it from the spam
 *  lists. Never trusts the whole domain: a click on one gmail.com sender
 *  must not switch scanning off for every gmail.com sender. */
export function markTrusted(address: string | null | undefined) {
    if (!address) return;
    const a = normalise(address);
    pushUnique(_state.trustedAddresses, a);
    dropFrom(_state.spamAddresses, a);
    write(_state);
}

// Shared mailbox providers: trusting the domain would trust every stranger on it.
const FREE_MAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
    'aol.com', 'mail.com', 'zoho.com', 'gmx.com', 'gmx.net'
]);

/** Explicit "trust this whole domain" (Settings). Refuses free-mail
 *  providers; returns whether the domain was added. */
export function addTrustedDomain(domain: string | null | undefined): boolean {
    const d = normalise((domain || '').replace(/^@/, ''));
    if (!d || d.includes('@') || FREE_MAIL_DOMAINS.has(d)) return false;
    pushUnique(_state.trustedDomains, d);
    dropFrom(_state.spamDomains, d);
    write(_state);
    return true;
}

/** "This is spam" — add to spam lists and remove from trusted. */
export function markSpam(address: string | null | undefined) {
    if (!address) return;
    const a = normalise(address);
    const d = domainOf(a);
    pushUnique(_state.spamAddresses, a);
    if (d) pushUnique(_state.spamDomains, d);
    dropFrom(_state.trustedAddresses, a);
    if (d) dropFrom(_state.trustedDomains, d);
    write(_state);
}

/** Returns true when the sender (address or its domain) was previously
 *  marked as trusted. The caller decides whether that is enough to skip
 *  the phishing/spam scan (it should not be when SPF/DKIM/DMARC fail). */
export function isTrustedSender(address: string | null | undefined): boolean {
    if (!address) return false;
    const a = normalise(address);
    if (_state.trustedAddresses.includes(a)) return true;
    const d = domainOf(a);
    return !!d && _state.trustedDomains.includes(d);
}

/** Drops a single trusted address. Domain entries are explicit and are
 *  removed separately. Used by Settings UI. */
export function removeTrusted(address: string) {
    dropFrom(_state.trustedAddresses, address);
    write(_state);
}

/** Drops a trusted domain (does not auto-remove individual addresses
 *  in that domain — they may have been added explicitly). */
export function removeTrustedDomain(domain: string) {
    dropFrom(_state.trustedDomains, domain);
    write(_state);
}

/** Snapshot for sending to the server. Returns undefined when every
 *  list is empty so we don't bloat the request body. */
export function feedbackPayload(): SpamFeedback | undefined {
    if (
        _state.trustedDomains.length === 0
        && _state.trustedAddresses.length === 0
        && _state.spamDomains.length === 0
        && _state.spamAddresses.length === 0
    ) return undefined;
    return {
        trustedDomains: [..._state.trustedDomains],
        trustedAddresses: [..._state.trustedAddresses],
        spamDomains: [..._state.spamDomains],
        spamAddresses: [..._state.spamAddresses]
    };
}
