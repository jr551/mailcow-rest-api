// Tracks "is the imap-rest server up?" — flips true when the error
// doctor sees >=2 5xx responses on /v1/ routes within 30s (or when
// /health stops answering 200), and back to false when a
// fresh health probe succeeds.
//
// MaintenanceOverlay listens to this state and shows a frosted-glass
// "we'll be back" panel with a polling spinner. Browsing-while-down
// is supplied separately by the cached message list.

const WINDOW_MS = 30_000;
const FAIL_THRESHOLD = 2;
const POLL_MS = 10_000;
const PROBE_TIMEOUT_MS = 6_000;

const state = $state<{
    /** True while we believe the server is unreachable. */
    down: boolean;
    /** Last wall-clock the server answered 200. 0 means "never seen". */
    lastOkAt: number;
    /** Wall-clock of the last poll attempt. */
    lastProbeAt: number;
    /** Polling timer id while down. */
    pollTimer: ReturnType<typeof setInterval> | null;
}>({
    down: false,
    lastOkAt: 0,
    lastProbeAt: 0,
    pollTimer: null
});

export const serverHealth = state;

const recent5xx: number[] = [];
function trimWindow(now: number) {
    while (recent5xx.length && now - recent5xx[0] > WINDOW_MS) recent5xx.shift();
}

/** Called by the error doctor whenever a 5xx hits one of our own routes. */
export function noteServer5xx() {
    const now = Date.now();
    trimWindow(now);
    recent5xx.push(now);
    if (recent5xx.length >= FAIL_THRESHOLD && !state.down) {
        markDown();
    }
}

/** Called whenever any /v1/ or /imap-rest/ request succeeds (2xx, 3xx,
 *  even 4xx — we only flip to "down" on connection-level failures or
 *  consistent 5xx, not on 401 etc). */
export function noteServerOk() {
    const now = Date.now();
    state.lastOkAt = now;
    trimWindow(now);
    // Drain the window — recent recoveries shouldn't keep us armed.
    recent5xx.length = 0;
    if (state.down) markUp();
}

function markDown() {
    if (state.down) return;
    state.down = true;
    if (!state.pollTimer) state.pollTimer = setInterval(probe, POLL_MS);
    // Probe immediately so the overlay flicker is short when the server
    // is actually fine and the original 5xx was transient.
    void probe();
}

function markUp() {
    if (!state.down) return;
    state.down = false;
    if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
    }
}

async function probe(): Promise<void> {
    state.lastProbeAt = Date.now();
    for (const path of ['/health', '/imap-rest/health']) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
        try {
            const res = await fetch(path, { signal: ctl.signal, cache: 'no-store' });
            if (res.ok) {
                noteServerOk();
                return;
            }
        } catch {
            // Try the next known deployment path.
        } finally {
            clearTimeout(timer);
        }
    }
}

/** Called once at app boot to wire a passive health probe so the overlay
 *  can also surface when the user reloads onto a degraded server. */
export function startServerHealthPolling() {
    void probe();
}
