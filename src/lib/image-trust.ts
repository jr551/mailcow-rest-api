// Per-sender "load remote images" memory. When the user clicks "Load
// remote content" on a message and ticks the remember box, we persist
// that sender for 30 days; future messages from them auto-load images
// without prompting.
//
// Stored as { [emailLower]: untilEpochMs }. Capped at 200 entries with
// LRU-by-recency eviction.

const STORAGE_KEY = 'webmail.image-trust.v1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

type Vault = Record<string, number>;

function read(): Vault {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        return JSON.parse(raw) as Vault;
    } catch { return {}; }
}

function write(v: Vault) {
    try {
        // Evict expired entries opportunistically; cap to MAX_ENTRIES by
        // keeping the most-recently-set timestamps.
        const now = Date.now();
        let entries = Object.entries(v).filter(([, until]) => until > now);
        if (entries.length > MAX_ENTRIES) {
            entries.sort((a, b) => b[1] - a[1]);
            entries = entries.slice(0, MAX_ENTRIES);
        }
        const trimmed: Vault = {};
        for (const [k, t] of entries) trimmed[k] = t;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch { /* quota / disabled */ }
}

function key(email: string): string {
    return email.trim().toLowerCase();
}

export function isImageTrusted(email: string | null | undefined): boolean {
    if (!email) return false;
    const v = read();
    const until = v[key(email)];
    return !!until && until > Date.now();
}

export function trustImagesFromSender(email: string, days = 30) {
    if (!email) return;
    const v = read();
    v[key(email)] = Date.now() + days * 24 * 60 * 60 * 1000;
    write(v);
}

export function forgetImagesFromSender(email: string) {
    if (!email) return;
    const v = read();
    delete v[key(email)];
    write(v);
}

export function clearImageTrust() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
}

// Quick heuristic — does the HTML reference any remote image source? We
// can't load the iframe just to check; doing it on the raw HTML is good
// enough for the gate. False positives just mean we show the prompt;
// false negatives mean we don't blur an email that probably doesn't
// need blurring (no remote refs to phone home).
export function hasRemoteImages(html: string | null | undefined): boolean {
    if (!html) return false;
    // Strip data: + cid: + relative paths so they don't count.
    return /<img\b[^>]*\ssrc\s*=\s*["']?https?:\/\//i.test(html)
        || /\bbackground(?:-image)?\s*:\s*url\(\s*["']?https?:\/\//i.test(html);
}
