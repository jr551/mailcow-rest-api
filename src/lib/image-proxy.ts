// Rewrites remote <img src="https://..."> tags in a chunk of email HTML to
// embedded data: URLs fetched through /v1/proxy/image. The point is that
// the upstream host (typical tracking pixel / CDN) never sees the user's
// IP — the server fetches and caches it on the user's behalf, and the
// browser just inlines the result.
//
// Why data: URLs and not blob: URLs? The email body is rendered inside a
// sandboxed iframe with a unique opaque origin, which can't read blob URLs
// created by the parent. Data URLs work fine cross-origin.

import { getSession } from './auth.svelte';
import { showToast } from './store.svelte';
import { apiUrl } from './api';

const REMOTE_IMG_RE = /<img\b([^>]*?)\bsrc\s*=\s*("https?:[^"]*"|'https?:[^']*'|https?:[^\s>]+)/gi;

let warnedThisSession = false;
let proxyHealthy = true;
let healthCheckTimer: ReturnType<typeof setTimeout> | null = null;

function markProxyUnhealthy() {
    if (proxyHealthy) {
        proxyHealthy = false;
        if (!warnedThisSession) {
            warnedThisSession = true;
            showToast('info', 'Image proxy cap reached — loading images directly until it resets. Your IP is visible to senders.');
        }
    }
    // Retry health check in 60s.
    if (healthCheckTimer) clearTimeout(healthCheckTimer);
    healthCheckTimer = setTimeout(() => { proxyHealthy = true; }, 60_000);
}

export function isProxyHealthy(): boolean {
    return proxyHealthy;
}

function unquote(v: string): string {
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    return v;
}

// Remember URLs the proxy has already refused. The message-detail effect
// re-runs whenever a background timer rewrites a store it reads (session
// renewal, capability probe), and without this every re-run re-requested
// every failed image — production logs showed the same >1 MB image being
// re-fetched every ~30 s for as long as the message stayed open. Server-side
// caching alone doesn't help: the request still crosses the wire.
//
// Keyed by URL, capped so a long session can't grow it without bound.
const failedUrls = new Map<string, number>();
const FAILED_TTL_MS = 30 * 60 * 1000;
const FAILED_MAX = 500;

function isKnownBad(url: string): boolean {
    const at = failedUrls.get(url);
    if (at === undefined) return false;
    if (Date.now() - at > FAILED_TTL_MS) {
        failedUrls.delete(url);
        return false;
    }
    return true;
}

function markBad(url: string) {
    if (failedUrls.size >= FAILED_MAX) {
        // Cheap eviction: drop the oldest insertion (Map preserves order).
        const oldest = failedUrls.keys().next();
        if (!oldest.done) failedUrls.delete(oldest.value);
    }
    failedUrls.set(url, Date.now());
}

async function fetchAsDataUrl(url: string, signal?: AbortSignal): Promise<string | null> {
    if (isKnownBad(url)) return null;
    const session = getSession();
    const headers: Record<string, string> = {};
    if (session) headers.authorization = `Bearer ${session.token}`;
    let res: Response;
    try {
        res = await fetch(apiUrl(`/v1/proxy/image?url=${encodeURIComponent(url)}`), {
            headers,
            signal
        });
    } catch {
        return null; // network / abort — leave the original src in place
    }
    if (res.status === 429) {
        markProxyUnhealthy();
        return null;
    }
    if (!res.ok) {
        // 4xx is a property of the image (too large, wrong type, gone) and
        // won't change on retry; 5xx we also back off on, since the server
        // negatively caches these for hours anyway.
        markBad(url);
        return null;
    }
    if (!proxyHealthy) proxyHealthy = true; // recovered
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(r.error);
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
    });
}

/**
 * For each `<img src="https://...">` in `html`, fetch via the privacy proxy
 * and substitute the response as a data: URL. Sources that fail (proxy cap,
 * MIME blocked, network error) are left untouched so the user's mail client
 * still degrades to direct loading rather than rendering a broken image.
 *
 * Cancellable via the AbortSignal — the in-flight fetches are aborted and
 * the partial result is returned so a fast message-switch doesn't strand
 * the iframe with stale content.
 */
export async function proxyImagesInHtml(
    html: string,
    signal?: AbortSignal
): Promise<string> {
    if (!html) return html;
    // Collect every unique remote URL so we only fetch each one once.
    const urls = new Set<string>();
    REMOTE_IMG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REMOTE_IMG_RE.exec(html)) !== null) {
        urls.add(unquote(m[2]));
    }
    if (!urls.size) return html;

    const replacements = new Map<string, string>();
    // Cap parallel fetches so a 50-image newsletter doesn't open 50 sockets.
    const queue = Array.from(urls);
    const CONCURRENCY = 6;
    async function worker() {
        while (queue.length) {
            if (signal?.aborted) return;
            const url = queue.shift();
            if (!url) return;
            const dataUrl = await fetchAsDataUrl(url, signal);
            if (dataUrl) replacements.set(url, dataUrl);
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));

    // Rewrite. We do this with a re-scan so multiple references to the same
    // URL all get the same data: URL.
    return html.replace(REMOTE_IMG_RE, (full, attrs, srcExpr) => {
        const original = unquote(srcExpr);
        const dataUrl = replacements.get(original);
        if (!dataUrl) return full;
        return `<img ${attrs}src="${dataUrl}"`;
    });
}
