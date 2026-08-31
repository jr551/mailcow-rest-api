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
//   Body: { v:1, ts, settings, spamFeedback, clientRules }
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
import { settings, type Settings } from './settings.svelte';
import { spamFeedback, type SpamFeedback } from './spam-feedback.svelte';
import { getSession } from './auth.svelte';

const SYNC_FOLDER = '.storage_webmailsettings';
const SYNC_SUBJECT = 'webmail-settings-v1';
const PUSH_DEBOUNCE_MS = 5000;
// Keep the last few snapshots around. If a future device's pull races
// with a push that's mid-write, the previous snapshot is still readable.
const KEEP_HISTORY = 3;

export interface SettingsSnapshot {
    v: 1;
    ts: number;
    settings: Partial<Settings>;
    spamFeedback?: SpamFeedback;
}

let lastPullTs = 0;
let lastPushTs = 0;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let inflightPush: Promise<void> | null = null;
let pulledOnce = false;

function snapshotNow(): SettingsSnapshot {
    return {
        v: 1,
        ts: Date.now(),
        settings: { ...settings },
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
        const parsed = JSON.parse(body);
        if (parsed && parsed.v === 1 && typeof parsed.ts === 'number'
            && parsed.settings && typeof parsed.settings === 'object') {
            return parsed as SettingsSnapshot;
        }
    } catch { /* not our JSON */ }
    return null;
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
export async function pullSettings(): Promise<SettingsSnapshot | null> {
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
export function applySnapshot(remote: SettingsSnapshot): boolean {
    if (remote.ts < lastPushTs) return false;
    let changed = false;
    // Settings: assign field-by-field so Svelte runes register the
    // change and dependents (effects, $derived) re-run.
    const incoming = remote.settings;
    for (const k of Object.keys(incoming) as (keyof Settings)[]) {
        const cur = (settings as unknown as Record<string, unknown>)[k as string];
        const next = (incoming as unknown as Record<string, unknown>)[k as string];
        if (cur !== next && next !== undefined) {
            (settings as unknown as Record<string, unknown>)[k as string] = next;
            changed = true;
        }
    }
    // Spam feedback: replace lists wholesale (these are full snapshots,
    // not deltas). Skip when the remote omits them.
    if (remote.spamFeedback) {
        spamFeedback.trustedAddresses = [...remote.spamFeedback.trustedAddresses];
        spamFeedback.trustedDomains = [...remote.spamFeedback.trustedDomains];
        spamFeedback.spamAddresses = [...remote.spamFeedback.spamAddresses];
        spamFeedback.spamDomains = [...remote.spamFeedback.spamDomains];
        changed = true;
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
export async function pushSettings(): Promise<void> {
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
export function debouncedPush(): void {
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
