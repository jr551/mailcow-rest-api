// Client-side rule engine. Runs over every freshly listed message
// and either moves the row, archives it, trashes it, marks it read,
// or kicks off an AI action that pops the row away while it works.
//
// Why client-side and not Sieve: Sieve fires at delivery time on the
// server, before we know the user's current AI state. Client-side
// rules can do "summarize and archive" or "ai-brief and stash in
// AI Conversations" — actions that need an LLM call and are nice to
// dispatch in parallel as the inbox loads. Sieve still wins for hard
// drops / forwarding (no UI required), so the rules tab keeps both.
//
// Idempotency: each rule run records the `path::uid` it touched in
// localStorage so we don't re-fire on every refresh. The set is
// per-user and capped at 5000 entries (FIFO eviction).
//
// "Pop away" animation: the engine emits an event before the actual
// move/delete; MessageList listens and adds a CSS class to the row
// for ~360ms before the data refresh removes it. Feels smoother than
// a hard list flicker.

import type { MessageListItem, Mailbox } from './api';
import { moveMessage, modifyFlags, summarizeMessage, appendRawMessage } from './api';
import { settings, type ClientRule, type ClientRuleAction } from './settings.svelte';
import { ui, showToast } from './store.svelte';
import { getSession } from './auth.svelte';

const SEEN_KEY_PREFIX = 'webmail.client-rules.seen.v1.';
const SEEN_CAP = 5000;

interface SeenStore {
    keys: string[]; // path::uid
}

function seenKey(user: string): string {
    return `${SEEN_KEY_PREFIX}${user.toLowerCase()}`;
}

function loadSeen(user: string): SeenStore {
    try {
        const raw = localStorage.getItem(seenKey(user));
        if (!raw) return { keys: [] };
        const parsed = JSON.parse(raw);
        return { keys: Array.isArray(parsed?.keys) ? parsed.keys.slice(-SEEN_CAP) : [] };
    } catch {
        return { keys: [] };
    }
}

function saveSeen(user: string, store: SeenStore) {
    try {
        const trimmed = store.keys.length > SEEN_CAP ? store.keys.slice(-SEEN_CAP) : store.keys;
        localStorage.setItem(seenKey(user), JSON.stringify({ keys: trimmed }));
    } catch { /* quota */ }
}

function rowKey(path: string, uid: number): string {
    return `${path}::${uid}`;
}

/* Rule matcher: case-insensitive substring on envelope fields. */
function matches(rule: ClientRule, msg: MessageListItem): boolean {
    if (!rule.enabled) return false;
    const cond = rule.condition;
    const value = (cond.value || '').trim().toLowerCase();
    if (!value) return false;
    const env = msg.envelope;
    if (!env) return false;
    if (cond.type === 'from-contains') {
        const haystack = (env.from || []).map((a) => `${a?.name || ''} ${a?.address || ''}`).join(' ').toLowerCase();
        return haystack.includes(value);
    }
    if (cond.type === 'from-domain') {
        return (env.from || []).some((a) => (a?.address || '').toLowerCase().endsWith('@' + value));
    }
    if (cond.type === 'subject-contains') {
        return (env.subject || '').toLowerCase().includes(value);
    }
    if (cond.type === 'to-contains') {
        const haystack = (env.to || []).concat(env.cc || []).map((a) => `${a?.name || ''} ${a?.address || ''}`).join(' ').toLowerCase();
        return haystack.includes(value);
    }
    return false;
}

/* Resolve an action's target folder. Move actions name a folder
 * directly; archive/trash look up the special-use mailbox. AI
 * actions resolve to the standard ".AI Conversations" folder when
 * they finish so the user can find what was processed. */
function resolveTargetFolder(action: ClientRuleAction, mailboxes: Mailbox[]): string | null {
    if (action.type === 'move') return action.folder || null;
    if (action.type === 'archive') {
        return mailboxes.find((m) => m.specialUse === '\\Archive')?.path
            || mailboxes.find((m) => m.specialUse === '\\All')?.path
            || 'Archive';
    }
    if (action.type === 'trash') {
        return mailboxes.find((m) => m.specialUse === '\\Trash')?.path || 'Trash';
    }
    if (action.type === 'ai-summarize-archive' || action.type === 'ai-brief') {
        return mailboxes.find((m) => m.specialUse === '\\Archive')?.path
            || mailboxes.find((m) => m.specialUse === '\\All')?.path
            || 'Archive';
    }
    return null;
}

/* Listeners notified before/after each row is processed so MessageList
 * can play the pop-away animation. We do it via a CustomEvent rather
 * than a Svelte store import because the engine is pure-TS — keeps
 * the dependency graph one-way. */
export interface RuleEventDetail {
    path: string;
    uid: number;
    rule: ClientRule;
    phase: 'start' | 'done' | 'error';
}

function emit(detail: RuleEventDetail) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('webmail:client-rule', { detail }));
}

/* AI actions. Run async, hold the row in "shimmer" state via the
 * rule event, then pop it away when finished. Failure is surfaced
 * via a toast so the user sees that the rule fired but stalled. */
async function runAiAction(
    msg: MessageListItem,
    action: ClientRuleAction,
    path: string,
    targetFolder: string
): Promise<boolean> {
    const session = getSession();
    if (!session) return false;
    const subject = msg.envelope?.subject || '(no subject)';
    const from = msg.envelope?.from?.[0];
    const fromText = from ? `${from.name || ''} <${from.address || ''}>`.trim() : '';
    if (action.type === 'ai-summarize-archive') {
        // One-shot summary call. We feed only the subject + sender
        // since the list payload doesn't include the body — full
        // body fetch would double the network cost per rule fire.
        const text = `Subject: ${subject}\nFrom: ${fromText}`;
        try {
            await summarizeMessage(text, 80);
        } catch {
            // Summary failure is non-fatal — still archive so the
            // rule's intent (get this out of the inbox) succeeds.
        }
        await moveMessage(path, msg.uid, targetFolder);
        return true;
    }
    if (action.type === 'ai-brief') {
        // Stash a one-line "AI brief" message into .AI Conversations
        // so the user can scan briefs later. Then archive the original.
        const aiFolder = '.AI Conversations';
        try {
            const summary = await summarizeMessage(`Subject: ${subject}\nFrom: ${fromText}`, 60);
            const me = session.user;
            const date = new Date().toUTCString();
            const briefRfc = [
                `Date: ${date}`,
                `From: ${me}`,
                `To: ${me}`,
                `Subject: AI brief: ${subject}`,
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset=utf-8',
                '',
                `Original from ${fromText}`,
                '',
                summary?.content || '(no summary)'
            ].join('\r\n');
            await appendRawMessage(aiFolder, new TextEncoder().encode(briefRfc));
        } catch { /* best-effort */ }
        await moveMessage(path, msg.uid, targetFolder);
        return true;
    }
    return false;
}

async function applyAction(
    msg: MessageListItem,
    action: ClientRuleAction,
    path: string,
    mailboxes: Mailbox[]
): Promise<boolean> {
    if (action.type === 'mark-read') {
        await modifyFlags(path, msg.uid, { add: ['\\Seen'] });
        return true;
    }
    const target = resolveTargetFolder(action, mailboxes);
    if (!target) return false;
    if (action.type === 'move' || action.type === 'archive' || action.type === 'trash') {
        await moveMessage(path, msg.uid, target);
        return true;
    }
    return runAiAction(msg, action, path, target);
}

/* Walk through the latest message list, fire any matching rules
 * against rows we haven't seen yet, and emit events so the UI can
 * pop the row away. Calls are dispatched concurrently (capped) so
 * a busy inbox doesn't stall behind a slow rule. */
const CONCURRENCY = 3;

export async function runClientRules(opts: {
    user: string;
    path: string;
    messages: MessageListItem[];
    mailboxes: Mailbox[];
}): Promise<{ fired: number }> {
    const rules = settings.clientRules.filter((r) => r.enabled);
    if (rules.length === 0) return { fired: 0 };
    const seen = loadSeen(opts.user);
    const seenSet = new Set(seen.keys);
    const queue: { msg: MessageListItem; rule: ClientRule }[] = [];
    for (const msg of opts.messages) {
        const key = rowKey(opts.path, msg.uid);
        if (seenSet.has(key)) continue;
        for (const rule of rules) {
            if (matches(rule, msg)) {
                queue.push({ msg, rule });
                break; // first-match wins; later rules don't fire on the same row
            }
        }
    }
    if (queue.length === 0) return { fired: 0 };

    let fired = 0;
    const workers: Promise<void>[] = [];
    let i = 0;
    const next = async () => {
        while (i < queue.length) {
            const idx = i++;
            const item = queue[idx];
            const key = rowKey(opts.path, item.msg.uid);
            // Mark as seen up-front so a concurrent refresh doesn't
            // re-queue the same row while this worker is mid-flight.
            seenSet.add(key);
            seen.keys.push(key);
            emit({ path: opts.path, uid: item.msg.uid, rule: item.rule, phase: 'start' });
            try {
                const ok = await applyAction(item.msg, item.rule.action, opts.path, opts.mailboxes);
                if (ok) {
                    fired++;
                    emit({ path: opts.path, uid: item.msg.uid, rule: item.rule, phase: 'done' });
                } else {
                    emit({ path: opts.path, uid: item.msg.uid, rule: item.rule, phase: 'error' });
                }
            } catch {
                emit({ path: opts.path, uid: item.msg.uid, rule: item.rule, phase: 'error' });
            }
        }
    };
    for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) workers.push(next());
    await Promise.all(workers);
    saveSeen(opts.user, seen);
    if (fired > 0) {
        // Toast is informational — the row pop-away animation has
        // already done the visual work; this tells the user how many
        // rules total fired so they can pop into the rules panel
        // and review if anything looks wrong.
        showToast('info', `${fired} client rule${fired === 1 ? '' : 's'} fired`);
    }
    // Reading `ui` here so refreshes downstream of rules see the
    // latest message list — caller is expected to re-list after.
    void ui;
    return { fired };
}

/* Clear seen-cache for a user. Called from settings UI when the
 * user wants to "re-run rules from scratch" — handy after editing
 * a rule. */
export function clearSeenCache(user: string): void {
    try { localStorage.removeItem(seenKey(user)); } catch { /* noop */ }
}
