// Network reachability probe for the offline-mode UX.
//
// navigator.onLine lies — it goes true the moment the OS picks up a link
// even when our backend is unreachable (think: hotel wifi captive portal,
// VPN dropout, mailcow stack restarting). We pair it with an active
// /health probe wrapped in a 2-second timeout, then re-probe every 30s
// while we believe we're offline.
//
// The truth lives in `ui.online`. This module flips it. Components react
// via $effect / $derived as usual.

import { ui } from './store.svelte';

const PROBE_URL = '/health';
const PROBE_TIMEOUT_MS = 2000;
const RETRY_INTERVAL_MS = 30_000;

/** Race a fetch of /health against a 2s timeout. Resolves true if /health
 *  returned 2xx within the budget, false otherwise (timeout or network
 *  error). Never throws. */
export async function probeReachable(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    if (typeof fetch === 'undefined') return true;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
    try {
        const res = await fetch(PROBE_URL, {
            method: 'GET',
            cache: 'no-store',
            // Bypass the SW so the probe genuinely tests the network and
            // doesn't get a "cached 200" answer from a previous session.
            // Browsers honour this on top-level fetches.
            credentials: 'omit',
            signal: ctrl?.signal
        });
        return res.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

let watchdogStarted = false;
let retryTimer: ReturnType<typeof setInterval> | null = null;

/** Start the watchdog. Idempotent — calling twice is a no-op. Returns a
 *  stop fn. The watchdog:
 *    1. Probes /health within 2s on start. If it fails, ui.online flips
 *       false right away — UI shows the offline banner + cached data.
 *    2. While ui.online is false, re-probes every 30s. As soon as one
 *       succeeds, flips back to online.
 *    3. Listens to navigator.onLine events too, so a real network drop
 *       is reflected instantly without waiting for the next retry. */
export function startNetworkWatchdog(opts: { onReconnect?: () => void } = {}): () => void {
    if (watchdogStarted) return () => { /* already running */ };
    watchdogStarted = true;

    let stopped = false;
    let lastOnline = ui.online;

    async function tick() {
        if (stopped) return;
        const reachable = await probeReachable();
        if (stopped) return;
        const next = reachable;
        if (next !== ui.online) {
            ui.online = next;
            if (next && !lastOnline && opts.onReconnect) {
                try { opts.onReconnect(); } catch { /* noop */ }
            }
            lastOnline = next;
        }
        scheduleRetry();
    }

    function scheduleRetry() {
        if (retryTimer) clearInterval(retryTimer);
        // Re-probe every 30s. Cheap — /health is a 200-byte JSON.
        retryTimer = setInterval(() => { void tick(); }, RETRY_INTERVAL_MS);
    }

    function onlineEvent() {
        // Browser thinks we're back. Verify with a live probe — if the
        // verify fails the next interval tick will catch it.
        void tick();
    }
    function offlineEvent() {
        if (ui.online) ui.online = false;
        lastOnline = false;
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('online', onlineEvent);
        window.addEventListener('offline', offlineEvent);
    }

    // Kick the first probe immediately. The 2s timeout means worst-case
    // the user sees the offline banner ~2s after app open if the backend
    // is unreachable.
    void tick();

    return () => {
        stopped = true;
        watchdogStarted = false;
        if (retryTimer) clearInterval(retryTimer);
        retryTimer = null;
        if (typeof window !== 'undefined') {
            window.removeEventListener('online', onlineEvent);
            window.removeEventListener('offline', offlineEvent);
        }
    };
}

/** Race a promise against a fixed timeout. The race is "soft" — if the
 *  timeout wins we return null instead of throwing, so the caller can
 *  fall back to a cached value gracefully. */
export async function withTimeout<T>(p: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
    });
    try {
        const result = await Promise.race([p, timeout]);
        return result;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
