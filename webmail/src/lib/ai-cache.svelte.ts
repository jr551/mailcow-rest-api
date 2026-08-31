// Client-side cache for outbound /chat/completions requests.
//
// Cache key: SHA-256 of (scope | hour-bucket | request-body). The hour
// bucket gives us a natural 1h TTL — when the wall clock crosses an
// hour, the key changes and we re-fetch. No timestamp comparison or
// background eviction needed for correctness; we just sweep older
// hour buckets opportunistically to keep localStorage from growing.
//
// We deliberately scope by *call site* (e.g. 'sort-inbox',
// 'subject-suggest') so identical bodies coming from different surfaces
// can't collide. The hash is never sent off-device.

const PREFIX = 'webmail.ai-cache.v1.';
const MAX_BYTES = 1_500_000;        // ~1.5MB ceiling across all entries
const MAX_ENTRY_BYTES = 64 * 1024;  // 64KB per response — bigger ones aren't cached

interface Entry {
    /** Hour bucket the entry was written in. Used for opportunistic eviction. */
    hour: number;
    /** HTTP status of the cached response. We only cache 2xx. */
    status: number;
    /** Raw response body. Caller parses (usually JSON). */
    text: string;
}

function hourBucket(now = Date.now()): number {
    return Math.floor(now / (60 * 60 * 1000));
}

async function hashKey(scope: string, body: string, hour: number): Promise<string> {
    if (typeof crypto?.subtle?.digest !== 'function') {
        // Fallback: cheap stable hash. Crypto.subtle is unavailable on
        // insecure contexts (http://) — caching there is best-effort
        // and not security-relevant since the body never leaves the
        // browser before being sent over the wire anyway.
        return cheapHash(`${scope}|${hour}|${body}`);
    }
    const enc = new TextEncoder().encode(`${scope}|${hour}|${body}`);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function cheapHash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16).padStart(8, '0');
}

function readEntry(key: string): Entry | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Entry;
        if (typeof parsed?.text !== 'string' || typeof parsed?.hour !== 'number') return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeEntry(key: string, entry: Entry) {
    const payload = JSON.stringify(entry);
    if (payload.length > MAX_ENTRY_BYTES) return; // too big to cache
    try {
        localStorage.setItem(key, payload);
    } catch {
        // Quota — drop a chunk of older keys and retry once. If even that
        // fails we just skip the cache; correctness doesn't depend on it.
        evictOlder(hourBucket(), { dropAll: true });
        try { localStorage.setItem(key, payload); } catch { /* give up */ }
    }
}

/** Drop entries from old hour buckets. dropAll=true ignores the bucket
 *  filter (used as the quota-exceeded last resort). */
function evictOlder(currentHour: number, opts: { dropAll?: boolean } = {}): number {
    let dropped = 0;
    let totalBytes = 0;
    const survivors: { key: string; size: number; hour: number }[] = [];
    try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(PREFIX)) keys.push(k);
        }
        for (const k of keys) {
            const raw = localStorage.getItem(k);
            if (!raw) continue;
            let hour = 0;
            try { hour = (JSON.parse(raw) as Entry).hour || 0; } catch { /* corrupt */ }
            // Anything more than 1 hour old, or unparseable, gets evicted.
            if (opts.dropAll || !hour || currentHour - hour >= 2) {
                localStorage.removeItem(k);
                dropped++;
            } else {
                survivors.push({ key: k, size: raw.length, hour });
                totalBytes += raw.length;
            }
        }
        // If still over the byte ceiling, evict the oldest survivors.
        if (totalBytes > MAX_BYTES) {
            survivors.sort((a, b) => a.hour - b.hour);
            for (const s of survivors) {
                if (totalBytes <= MAX_BYTES) break;
                localStorage.removeItem(s.key);
                totalBytes -= s.size;
                dropped++;
            }
        }
    } catch { /* localStorage disabled / private mode */ }
    return dropped;
}

let lastEvictHour = -1;
function maybeEvict(currentHour: number) {
    if (currentHour === lastEvictHour) return;
    lastEvictHour = currentHour;
    evictOlder(currentHour);
}

export interface CachedFetchResult {
    ok: boolean;
    status: number;
    text: string;
    /** True when served from local cache — never hit the network. */
    cached: boolean;
}

export interface CachedChatCompletionOpts {
    /** Resolved provider base URL, with or without trailing /v1. */
    baseUrl: string;
    /** API key for `Authorization: Bearer ...`. */
    apiKey: string;
    /** Already-stringified request body. Stringified by the caller so
     *  the same JSON-key order produces the same hash. */
    body: string;
    /** Call-site identifier — sort-inbox, subject-suggest, etc. Mixed
     *  into the hash so unrelated surfaces don't share entries. */
    scope: string;
    /** Caller's abort signal, forwarded to fetch. */
    signal?: AbortSignal;
    /** Skip the cache (read AND write) for this call. Useful for
     *  retry-after-error paths. */
    skipCache?: boolean;
}

export async function cachedChatCompletion(opts: CachedChatCompletionOpts): Promise<CachedFetchResult> {
    const hour = hourBucket();
    const baseUrl = opts.baseUrl.replace(/\/+$/, '');

    if (!opts.skipCache) {
        const k = `${PREFIX}${await hashKey(opts.scope, opts.body, hour)}`;
        const hit = readEntry(k);
        if (hit && hit.hour === hour && hit.status >= 200 && hit.status < 300) {
            return { ok: true, status: hit.status, text: hit.text, cached: true };
        }
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${opts.apiKey}`,
            'content-type': 'application/json'
        },
        body: opts.body,
        signal: opts.signal
    });
    const text = await res.text();
    if (!opts.skipCache && res.ok) {
        const k = `${PREFIX}${await hashKey(opts.scope, opts.body, hour)}`;
        writeEntry(k, { hour, status: res.status, text });
    }
    maybeEvict(hour);
    return { ok: res.ok, status: res.status, text, cached: false };
}

/** Drop every cached entry. Exposed for Settings → Clear caches. */
export function clearAiCache(): number {
    let dropped = 0;
    try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(PREFIX)) keys.push(k);
        }
        for (const k of keys) { localStorage.removeItem(k); dropped++; }
    } catch { /* */ }
    return dropped;
}
