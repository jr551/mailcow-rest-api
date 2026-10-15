'use strict';

// Backoff for repeated failed app-password attempts.
//
// The live log shows a client retrying an expired app password indefinitely:
// every retry costs a database read plus a decrypt, and the client is told
// nothing that would make it stop. Counting failures per key lets us answer
// the next attempt with a 429 and a Retry-After instead of doing that work
// again, which is cheaper for everyone than re-checking.
//
// The map is bounded because this sits on a public endpoint: an attacker who
// can send arbitrary tokens must not be able to grow it without limit. Entries
// whose window has passed are pruned on every write, and once `maxKeys` is
// reached the oldest key is evicted, so the worst case is one entry per live
// key rather than unbounded growth.
//
// The window is fixed from the first failure of a run (not sliding), so
// `retryAfterMs` counts down as the window elapses and a client that backs off
// for that long finds itself unblocked.
function createAuthFailureLimiter({ max = 20, windowMs = 5 * 60_000, maxKeys = 1000 } = {}) {
    // key -> { count, firstAt }
    const entries = new Map();

    // Drop everything whose window has already closed. Called on every write so
    // a burst of one-shot keys cannot accumulate.
    function prune(now) {
        for (const [key, entry] of entries) {
            if (now - entry.firstAt >= windowMs) entries.delete(key);
        }
    }

    function check(key, now) {
        const entry = entries.get(key);
        if (!entry) return { blocked: false, retryAfterMs: 0 };
        const elapsed = now - entry.firstAt;
        if (elapsed >= windowMs) {
            entries.delete(key);
            return { blocked: false, retryAfterMs: 0 };
        }
        if (entry.count < max) return { blocked: false, retryAfterMs: 0 };
        return { blocked: true, retryAfterMs: windowMs - elapsed };
    }

    function fail(key, now) {
        // prune() already removed any entry whose window closed, so a surviving
        // entry is always inside the current window.
        prune(now);
        const entry = entries.get(key);
        if (entry) {
            entry.count += 1;
            // Re-insert so Map iteration order tracks recency and eviction
            // removes the least recently failing key.
            entries.delete(key);
            entries.set(key, entry);
        } else {
            entries.set(key, { count: 1, firstAt: now });
        }
        if (entries.size > maxKeys) {
            entries.delete(entries.keys().next().value);
        }
    }

    function clear(key) {
        entries.delete(key);
    }

    return { check, fail, clear, size: () => entries.size };
}

module.exports = { createAuthFailureLimiter };
