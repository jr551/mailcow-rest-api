// Cross-device settings sync via a hidden IMAP folder.
//
// Why IMAP and not a server-side prefs endpoint: every mailcow account
// already has IMAP storage that's reachable by every device the user
// signs in on. Stashing one JSON message in a hidden folder means we
// inherit IMAP's auth, replication, and quota for free — no extra
// schema, no per-tenant DB rows, nothing for ops to remember.
//
// Folder name: `.storage_webmailsettings`. The leading dot keeps it out
// of MUA navigators that hide system folders; the Sidebar adds a path
// filter so it never shows up in the user's tree either. The server
// route comment in src/routes/messages.js calls this convention out
// explicitly.
//
// Snapshot envelope:
//   Subject: webmail-settings-v1
//   Content-Type: application/json
//   Body: { v:1, ts, settings, spamFeedback }
//
// Conflict policy: last-write-wins by `ts`. Settings are user-edited
// (low frequency, single-author per device) so we don't bother with
// per-field merging. The user always sees their most recent change
// after a round-trip; older device's pending edits will overwrite the
// newer if they sync after — accepted trade-off for "I changed it on
// my phone, it should appear on my laptop".

import {
    listMessages, getRawMessage, appendRawMessage, createMailbox, deleteMessage
} from './api';
import { settings, sanitizeSettings, type Settings } from './settings.svelte';
import { spamFeedback, type SpamFeedback } from './spam-feedback.svelte';
import { getSession } from './auth.svelte';

const SYNC_FOLDER = '.storage_webmailsettings';
const SYNC_SUBJECT = 'webmail-settings-v1';
const PUSH_DEBOUNCE_MS = 5000;
// Keep the last few snapshots around. If a future device's pull races
// with a push that's mid-write, the previous snapshot is still readable.
const KEEP_HISTORY = 3;
// Settings that stay on the device they were set on. The LLM provider block
// carries the user's API key and the endpoint that key is sent to, and
// permanentSignIn decides whether credentials are kept in the browser: none
// of that belongs in a mailbox folder, and none of it should be settable
// from one.
const LOCAL_ONLY_SETTINGS: ReadonlySet<string> = new Set(['llm', 'useCustomLlm', 'permanentSignIn']);
// A snapshot stamped further ahead than this is treated as if it were from
// now, so one bad timestamp cannot make every later pull look stale.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_FEEDBACK_ENTRIES = 200;
const MAX_FEEDBACK_ENTRY_LEN = 320;

export interface SettingsSnapshot {
    v: 1;
    ts: number;
    settings: Partial<Settings>;
    spamFeedback?: Partial<SpamFeedback>;
}

let lastPullTs = 0;
let lastPushTs = 0;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let inflightPush: Promise<void> | null = null;
let pulledOnce = false;

export function snapshotNow(): SettingsSnapshot {
    const synced: Record<string, unknown> = { ...settings };
    for (const k of LOCAL_ONLY_SETTINGS) delete synced[k];
    return {
        v: 1,
        ts: Date.now(),
        settings: synced as Partial<Settings>,
        spamFeedback: {
            trustedDomains: [...spamFeedback.trustedDomains],
            trustedAddresses: [...spamFeedback.trustedAddresses],
            spamDomains: [...spamFeedback.spamDomains],
            spamAddresses: [...spamFeedback.spamAddresses]
        }
    };
}

function buildRfc822(snap: SettingsSnapshot): Uint8Array {
    const session = getSession();
    const me = session?.user || 'webmail@localhost';
    const date = new Date(snap.ts).toUTCString();
    const json = JSON.stringify(snap);
    // Plain ASCII header set; the body is JSON UTF-8 with no MIME
    // tricks — IMAP fetch BODY[TEXT] returns it intact.
    const headers = [
        `Date: ${date}`,
        `From: ${me}`,
        `To: ${me}`,
        `Subject: ${SYNC_SUBJECT}`,
        `Message-ID: <webmail-settings-${snap.ts}@${me.split('@')[1] || 'webmail'}>`,
        'MIME-Version: 1.0',
        'Content-Type: application/json; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        ''
    ].join('\r\n');
    const text = headers + '\r\n' + json;
    return new TextEncoder().encode(text);
}

function parseSnapshotFromRfc822(raw: string): SettingsSnapshot | null {
    if (!raw) return null;
    // Headers / body split on the first blank line. RFC822 uses CRLF
    // but tolerate LF for parser quirks.
    const idx = raw.search(/\r?\n\r?\n/);
    const body = idx >= 0 ? raw.slice(idx).replace(/^\r?\n\r?\n/, '') : raw;
    try {
        return sanitizeSnapshot(JSON.parse(body));
    } catch { /* not our JSON */ }
    return null;
}

function sanitizeList(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    return v
        .filter((x): x is string => typeof x === 'string' && x.length <= MAX_FEEDBACK_ENTRY_LEN)
        .slice(0, MAX_FEEDBACK_ENTRIES);
}

/** Reduce an untrusted decoded snapshot to what this client will apply:
 *  only known, synced settings with validated values, string-array spam
 *  lists, and a timestamp that is not in the far future. */
export function sanitizeSnapshot(parsed: unknown): SettingsSnapshot | null {
    const p = parsed as Record<string, unknown> | null;
    if (!p || p.v !== 1 || typeof p.ts !== 'number' || !Number.isFinite(p.ts)) return null;
    const incoming = p.settings;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null;
    // sanitizeSettings fills every gap with a default, so only the keys the
    // remote actually sent are carried over.
    const clean = sanitizeSettings(incoming) as unknown as Record<string, unknown>;
    const synced: Record<string, unknown> = {};
    for (const k of Object.keys(incoming)) {
        if (LOCAL_ONLY_SETTINGS.has(k) || !Object.hasOwn(clean, k)) continue;
        if ((incoming as Record<string, unknown>)[k] === undefined) continue;
        synced[k] = clean[k];
    }
    const out: SettingsSnapshot = {
        v: 1,
        ts: Math.min(p.ts, Date.now() + MAX_CLOCK_SKEW_MS),
        settings: synced as Partial<Settings>
    };
    const fb = p.spamFeedback as Record<string, unknown> | null | undefined;
    if (fb && typeof fb === 'object') {
        out.spamFeedback = {
            trustedDomains: sanitizeList(fb.trustedDomains),
            trustedAddresses: sanitizeList(fb.trustedAddresses),
            spamDomains: sanitizeList(fb.spamDomains),
            spamAddresses: sanitizeList(fb.spamAddresses)
        };
    }
    return out;
}

async function ensureFolder(): Promise<boolean> {
    try {
        await createMailbox(SYNC_FOLDER);
        return true;
    } catch (err) {
        // 409 / 4xx "already exists" is fine; anything else means we
        // can't sync. Don't crash the caller.
        const status = (err as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return true;
        return false;
    }
}

/** Fetch the newest snapshot from the sync folder. Returns null when
 *  the folder is empty or doesn't exist. */
async function pullSettings(): Promise<SettingsSnapshot | null> {
    try {
        const list = await listMessages(SYNC_FOLDER, { page: 0, pageSize: 50 });
        if (!list?.messages?.length) return null;
        // Sort newest first by INTERNALDATE / envelope date / UID.
        const sorted = [...list.messages].sort((a, b) => {
            const ta = Date.parse(a.internalDate || a.envelope?.date || '') || a.uid;
            const tb = Date.parse(b.internalDate || b.envelope?.date || '') || b.uid;
            return tb - ta;
        });
        for (const m of sorted) {
            try {
                const raw = await getRawMessage(SYNC_FOLDER, m.uid);
                const snap = parseSnapshotFromRfc822(raw);
                if (snap) return snap;
            } catch { /* unreadable, try the next one */ }
        }
        return null;
    } catch (err) {
        // Folder missing → nothing to merge. Caller should still allow
        // the local snapshot to be the source of truth and call push.
        const status = (err as { status?: number })?.status;
        if (status === 404) return null;
        return null;
    }
}

/** Apply a remote snapshot to local state. Skips fields that aren't
 *  present in the remote (lets new local-only settings stay local
 *  until the next push), and refuses to apply a snapshot older than
 *  what we last pushed (so a slow round-trip doesn't undo the user's
 *  most recent edit). */
function applySnapshot(remote: SettingsSnapshot): boolean {
    if (remote.ts < lastPushTs) return false;
    let changed = false;
    // Settings: assign field-by-field so Svelte runes register the
    // change and dependents (effects, $derived) re-run.
    // Snapshots pulled via pullSettings() are already sanitised, so retired
    // fields such as `clientRules` never reach this loop.
    const incoming = remote.settings as Record<string, unknown>;
    const live = settings as unknown as Record<string, unknown>;
    for (const k of Object.keys(incoming)) {
        if (live[k] !== incoming[k]) {
            live[k] = incoming[k];
            changed = true;
        }
    }
    // Spam feedback: replace lists wholesale (these are full snapshots,
    // not deltas). Skip any list the remote omits.
    if (remote.spamFeedback) {
        for (const k of ['trustedAddresses', 'trustedDomains', 'spamAddresses', 'spamDomains'] as const) {
            const list = remote.spamFeedback[k];
            if (list) {
                spamFeedback[k] = [...list];
                changed = true;
            }
        }
    }
    if (changed) {
        // Mirror to localStorage so the next reload reflects the merge
        // before the network sync fires again.
        try {
            localStorage.setItem('webmail.settings.v1', JSON.stringify(settings));
            localStorage.setItem('webmail.spam-feedback.v1', JSON.stringify(spamFeedback));
        } catch { /* quota */ }
    }
    lastPullTs = remote.ts;
    return changed;
}

/** Append a fresh snapshot to the sync folder, then prune older ones
 *  past KEEP_HISTORY. Coalesces concurrent calls so a burst of edits
 *  results in one push. */
async function pushSettings(): Promise<void> {
    if (inflightPush) return inflightPush;
    inflightPush = (async () => {
        try {
            const session = getSession();
            if (!session) return;
            const ok = await ensureFolder();
            if (!ok) return;
            const snap = snapshotNow();
            const rfc822 = buildRfc822(snap);
            await appendRawMessage(SYNC_FOLDER, rfc822, { internalDate: new Date(snap.ts) });
            lastPushTs = snap.ts;
            // Prune older snapshots so the folder doesn't grow forever.
            try {
                const list = await listMessages(SYNC_FOLDER, { page: 0, pageSize: 50 });
                if (list?.messages?.length && list.messages.length > KEEP_HISTORY) {
                    const sorted = [...list.messages].sort((a, b) => {
                        const ta = Date.parse(a.internalDate || a.envelope?.date || '') || a.uid;
                        const tb = Date.parse(b.internalDate || b.envelope?.date || '') || b.uid;
                        return tb - ta;
                    });
                    const stale = sorted.slice(KEEP_HISTORY);
                    for (const m of stale) {
                        try { await deleteMessage(SYNC_FOLDER, m.uid); } catch { /* skip */ }
                    }
                }
            } catch { /* prune is best-effort */ }
        } finally {
            inflightPush = null;
        }
    })();
    return inflightPush;
}

/** Schedule a push 5s from now, resetting the timer if more changes
 *  land in the meantime. The chatty path during a settings panel
 *  session collapses to one push when the user stops fiddling. */
function debouncedPush(): void {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        pushTimer = null;
        void pushSettings();
    }, PUSH_DEBOUNCE_MS);
}

/** Wire up sync after the user signs in. Pulls once, then watches for
 *  local changes and debounces pushes. Safe to call multiple times —
 *  subsequent calls just re-pull. */
export async function startSync(): Promise<void> {
    const session = getSession();
    if (!session) return;
    if (!pulledOnce) {
        pulledOnce = true;
        // First run: install change-watchers BEFORE the pull, so any
        // mutation made by applySnapshot doesn't itself trigger an
        // immediate re-push (the timer fires after PUSH_DEBOUNCE_MS,
        // by which time we've already updated lastPushTs from the pull).
        installWatchers();
    }
    try {
        const remote = await pullSettings();
        if (remote) {
            applySnapshot(remote);
            // Honour the remote's ts as our floor so we don't immediately
            // overwrite it with our about-to-fire debounced push.
            lastPushTs = Math.max(lastPushTs, remote.ts);
            // Cancel the watcher's reactive push if one was scheduled
            // by applySnapshot's writes — those writes are remote in
            // origin, not user-driven.
            if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
        }
    } catch { /* offline first-pull is fine; we'll push the local one */ }
    // Push the local snapshot if we've never pushed before — guarantees
    // the folder has at least one entry on first device.
    if (lastPushTs === 0) {
        void pushSettings();
    }
}

let watchersInstalled = false;
function installWatchers() {
    if (watchersInstalled) return;
    watchersInstalled = true;
    // Svelte's `$effect.root` would be cleaner but isn't available
    // outside a component context. We poll instead — coarse but the
    // settings object is small, and stringify is cheap relative to
    // the network round-trip we're guarding.
    let last = JSON.stringify({ s: settings, f: spamFeedback });
    setInterval(() => {
        const cur = JSON.stringify({ s: settings, f: spamFeedback });
        if (cur !== last) {
            last = cur;
            debouncedPush();
        }
    }, 1500);
}
