// Lightweight IP → country lookup for the access-log flags. Uses
// ipapi.co's free per-IP endpoint (no API key, returns the ISO 3166-1
// alpha-2 country code as plain text). Results are cached in
// localStorage for 60 days so repeat IPs don't hit the network.
//
// Privacy note: each unique public IP from the user's access log is
// sent to ipapi.co the first time we see it. Private RFC-1918 ranges
// short-circuit and never leave the browser.

const CACHE_KEY = 'webmail.geoip.v1';
const TTL_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

interface CacheEntry {
    code: string | null; // ISO alpha-2, null when lookup failed/private
    ts: number;
}
type Cache = Record<string, CacheEntry>;

function readCache(): Cache {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        return raw ? (JSON.parse(raw) as Cache) : {};
    } catch { return {}; }
}

function writeCache(c: Cache) {
    try {
        const now = Date.now();
        let entries = Object.entries(c).filter(([, v]) => v && now - v.ts < TTL_MS);
        if (entries.length > MAX_ENTRIES) {
            entries.sort((a, b) => b[1].ts - a[1].ts);
            entries = entries.slice(0, MAX_ENTRIES);
        }
        const trimmed: Cache = {};
        for (const [k, v] of entries) trimmed[k] = v;
        localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
    } catch { /* quota */ }
}

function isPrivateOrSpecial(raw: string): boolean {
    if (!raw) return true;
    // Anything that is not made of IP characters is never sent anywhere.
    if (!/^[0-9a-f:.]+$/i.test(raw)) return true;
    // An IPv4-mapped IPv6 address is judged by the IPv4 inside it.
    const ip = raw.replace(/^::ffff:/i, '');
    return /^(10\.|192\.168\.|169\.254\.|127\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[0-1])\.|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:|::1$|::$)/i.test(ip);
}

/** Convert ISO 3166-1 alpha-2 country code to a flag emoji. "GB" → 🇬🇧 */
export function flagEmoji(code: string | null | undefined): string {
    if (!code) return '';
    const c = code.trim().toUpperCase();
    if (c.length !== 2 || !/^[A-Z]{2}$/.test(c)) return '';
    const a = 0x1F1E6;
    return String.fromCodePoint(a + (c.charCodeAt(0) - 65), a + (c.charCodeAt(1) - 65));
}

/** Cache state — readable by components for reactive rendering. */
const _state = $state<{ codes: Record<string, string | null> }>({ codes: {} });
export const geoipCache = _state;

// Hot-load cached entries on import.
{
    const c = readCache();
    const now = Date.now();
    for (const [ip, e] of Object.entries(c)) {
        if (now - e.ts < TTL_MS) _state.codes[ip] = e.code;
    }
}

const inflight = new Set<string>();
// A rate limit or network error says nothing about the IP, so it is not
// cached: just not retried for a while.
const RETRY_AFTER_MS = 10 * 60 * 1000;
const retryAt = new Map<string, number>();

/** Kick off a lookup for an IP. Result lands in geoipCache.codes[ip]. */
export function ensureCountry(ip: string | null | undefined): void {
    if (!ip || inflight.has(ip)) return;
    if (ip in _state.codes) return; // cached (success or null)
    if ((retryAt.get(ip) ?? 0) > Date.now()) return;
    if (isPrivateOrSpecial(ip)) {
        _state.codes[ip] = null;
        return;
    }
    inflight.add(ip);
    fetch(`https://ipapi.co/${encodeURIComponent(ip)}/country/`, { mode: 'cors' })
        .then(async (r) => {
            if (!r.ok) throw new Error(`geoip ${r.status}`);
            const txt = (await r.text()).trim();
            return /^[A-Z]{2}$/.test(txt) ? txt : null;
        })
        .then((code) => {
            _state.codes[ip] = code;
            const c = readCache();
            c[ip] = { code, ts: Date.now() };
            writeCache(c);
        })
        .catch(() => { retryAt.set(ip, Date.now() + RETRY_AFTER_MS); })
        .finally(() => { inflight.delete(ip); });
}
