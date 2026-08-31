// Native-feel bridges for the mobile PWA. Each helper feature-detects
// at call time and silently no-ops on unsupported platforms — the
// callers don't have to wrap every use in `if (in browser && API exists)`.
//
//   - setAppBadge / clearAppBadge — Badging API (Chrome on Android,
//     Edge on Windows, Safari on macOS Sonoma+). Reflects the
//     unread-count on the launcher icon when installed.
//   - vibrate — short-form haptic patterns for swipe + error events.
//     iOS Safari ignores the API but Android implements it.
//   - onResume — fires the supplied callback whenever the document
//     transitions from hidden → visible (return-to-foreground or
//     unlocking the phone). Useful for auto-refresh.
//   - acquireWakeLock — keeps the screen awake during voice chat /
//     reading on the inbox. Auto-releases on visibility hide; the
//     returned disposer releases manually.

type NavigatorWithBadge = Navigator & {
    setAppBadge?: (n: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
};

export async function setAppBadge(count: number): Promise<void> {
    if (typeof navigator === 'undefined') return;
    const nav = navigator as NavigatorWithBadge;
    try {
        if (count > 0 && typeof nav.setAppBadge === 'function') {
            await nav.setAppBadge(count);
        } else if (count <= 0 && typeof nav.clearAppBadge === 'function') {
            await nav.clearAppBadge();
        }
    } catch { /* unsupported / blocked — ignore */ }
}

export async function clearAppBadge(): Promise<void> {
    if (typeof navigator === 'undefined') return;
    const nav = navigator as NavigatorWithBadge;
    try {
        if (typeof nav.clearAppBadge === 'function') await nav.clearAppBadge();
    } catch { /* */ }
}

// Pattern names tuned for the actions they live in. Keep these stingy
// so the device doesn't buzz on every interaction — only the moments
// where a hardware acknowledgement is genuinely useful.
const VIBE_PATTERNS = {
    /** Quick tick for a confirmed swipe (archive / delete). */
    tick: [12],
    /** Two-step buzz for an error toast or rejected action. */
    error: [25, 60, 25],
    /** Soft success tap for an apply-bulk-action. */
    success: [10, 40, 10],
    /** Long-press confirmation. */
    longPress: [30]
} as const;

export function vibrate(pattern: keyof typeof VIBE_PATTERNS | number | number[]): void {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    const value = typeof pattern === 'string' ? VIBE_PATTERNS[pattern]
        : (Array.isArray(pattern) ? pattern : [pattern]);
    try { navigator.vibrate(value); } catch { /* */ }
}

// Resume hook. Returns a disposer that unsubscribes. The visibility
// API fires "visible" on tab-switch, app-resume, and unlock; debounce
// is the caller's job (most callers want a single refresh per resume).
export function onResume(cb: () => void): () => void {
    if (typeof document === 'undefined') return () => {};
    const handler = () => {
        if (document.visibilityState === 'visible') cb();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
}

interface WakeLockSentinelLike { release: () => Promise<void>; addEventListener: (ev: string, fn: () => void) => void; }
type NavigatorWithWakeLock = Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike>; };
};

export async function acquireWakeLock(): Promise<() => void> {
    if (typeof navigator === 'undefined') return () => {};
    const nav = navigator as NavigatorWithWakeLock;
    if (!nav.wakeLock) return () => {};
    let sentinel: WakeLockSentinelLike | null = null;
    try {
        sentinel = await nav.wakeLock.request('screen');
    } catch {
        return () => {};
    }
    // Auto-reacquire after a hidden→visible cycle: the OS releases
    // wake-locks when the tab is backgrounded, and we want it back the
    // moment the user returns. Safe to call on a sentinel that's
    // already released; if the user already disposed the wake lock we
    // skip via the released flag.
    let released = false;
    const reacquire = async () => {
        if (released || !nav.wakeLock || document.visibilityState !== 'visible') return;
        try { sentinel = await nav.wakeLock.request('screen'); } catch { /* */ }
    };
    document.addEventListener('visibilitychange', reacquire);
    return () => {
        released = true;
        document.removeEventListener('visibilitychange', reacquire);
        if (sentinel) { sentinel.release().catch(() => {}); sentinel = null; }
    };
}
