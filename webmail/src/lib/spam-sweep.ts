// Bulk classification helper for the "Sweep inbox now" button in
// Settings > AI spam & phishing. Pulls the most recent N messages
// from INBOX, runs the existing phishing scan on each (which now
// also returns spam classification), and reports the candidates so
// the user can move them in one click.

import { listMailboxes, listMessages, getMessage, moveMessage, type Mailbox, type MessageListItem } from './api';
import { scanEmailForPhishing, envelopeToHeaders } from './phishing-scan';
import { settings } from './settings.svelte';

export interface SweepCandidate {
    uid: number;
    path: string;
    subject: string;
    from: string;
    isPhishing: boolean;
    isSpam: boolean;
    confidence: number;
    spamConfidence: number;
    reasoning: string;
    spamReasoning: string;
}

export interface SweepProgress {
    scanned: number;
    total: number;
    flagged: number;
}

// Find the user's spam-equivalent folder by IMAP special-use flag,
// falling back to common names. Returns null if nothing matches —
// caller can show a toast asking the user to create one.
export function findSpamFolder(mailboxes: Mailbox[]): string | null {
    const junk = mailboxes.find((m) => m.specialUse === '\\Junk');
    if (junk) return junk.path;
    const named = mailboxes.find((m) => /^(junk|spam)$/i.test(m.name));
    return named ? named.path : null;
}

export function findTrashFolder(mailboxes: Mailbox[]): string | null {
    const trash = mailboxes.find((m) => m.specialUse === '\\Trash');
    if (trash) return trash.path;
    const named = mailboxes.find((m) => /^(trash|deleted items|bin)$/i.test(m.name));
    return named ? named.path : null;
}

function findInboxFolder(mailboxes: Mailbox[]): string | null {
    const inbox = mailboxes.find((m) => m.specialUse === '\\Inbox');
    if (inbox) return inbox.path;
    const named = mailboxes.find((m) => /^inbox$/i.test(m.name));
    return named ? named.path : null;
}

export function findArchiveFolder(mailboxes: Mailbox[]): string | null {
    const flagged = mailboxes.find((m) => m.specialUse === '\\Archive' || m.specialUse === '\\All');
    if (flagged) return flagged.path;
    const named = mailboxes.find((m) => /^(archive|all mail|archived)$/i.test(m.name));
    return named ? named.path : null;
}

const LIST_PAGE_MAX = 100;

interface SweepOptions {
    onProgress?: (p: SweepProgress) => void;
    signal?: AbortSignal;
}

// Walk INBOX newest-first and classify until we've checked
// settings.spamSweepBatchSize messages or the abort signal fires.
// Cached scans are reused, so a follow-up sweep is fast.
export async function runSpamSweep(opts: SweepOptions = {}): Promise<{
    candidates: SweepCandidate[];
    inboxPath: string;
    spamPath: string | null;
    trashPath: string | null;
}> {
    const mailboxes = await listMailboxes();
    const inboxPath = findInboxFolder(mailboxes);
    if (!inboxPath) throw new Error('Could not find INBOX');
    const spamPath = findSpamFolder(mailboxes);
    const trashPath = findTrashFolder(mailboxes);

    const batch = settings.spamSweepBatchSize || 50;
    // The listing comes back newest-first (server-side INBOX view), pages
    // are 0-based and the server caps pageSize at LIST_PAGE_MAX, so a
    // bigger batch is read page by page.
    const messages: MessageListItem[] = [];
    for (let page = 0; messages.length < batch; page++) {
        if (opts.signal?.aborted) break;
        const want = Math.min(LIST_PAGE_MAX, batch - messages.length);
        const list = await listMessages(inboxPath, { pageSize: want, page });
        const got = list.messages || [];
        messages.push(...got);
        if (got.length < want) break;
    }

    const candidates: SweepCandidate[] = [];
    let scanned = 0;
    const total = messages.length;

    const phishingFloor = settings.phishingScanConfidenceFloor || 0.7;
    const spamFloor = settings.spamSuggestConfidenceFloor || 0.7;

    for (const item of messages) {
        if (opts.signal?.aborted) break;
        try {
            // Need the full message to scan body. Cached scans return
            // immediately so the network cost is bounded by uncached
            // messages only.
            const detail = await getMessage(inboxPath, item.uid);
            const from = detail.envelope.from?.[0];
            const to = detail.envelope.to?.[0];
            const result = await scanEmailForPhishing(inboxPath, item.uid, {
                subject: detail.envelope.subject || '',
                from: from ? `${from.name || ''} <${from.address}>`.trim() : '',
                to: to ? `${to.name || ''} <${to.address}>`.trim() : '',
                body: detail.text || '',
                html: detail.html || '',
                headers: envelopeToHeaders(detail.envelope),
                // Same reasoning as the message views: without the
                // envelope-sender verdicts the sweep ranks spoofed
                // lookalike senders below genuine marketing mail.
                auth: detail.auth ?? null,
                attachments: detail.attachments,
                path: inboxPath,
                uid: item.uid
            }, { signal: opts.signal });

            const phish = !!result?.isPhishing && (result?.confidence || 0) >= phishingFloor;
            const spam = !!result?.isSpam && (result?.spamConfidence || 0) >= spamFloor;
            if (phish || spam) {
                const fromAddr = from ? (from.address || from.name || '') : '';
                candidates.push({
                    uid: item.uid,
                    path: inboxPath,
                    subject: detail.envelope.subject || '(no subject)',
                    from: fromAddr,
                    isPhishing: phish,
                    isSpam: spam,
                    confidence: result?.confidence || 0,
                    spamConfidence: result?.spamConfidence || 0,
                    reasoning: result?.reasoning || '',
                    spamReasoning: result?.spamReasoning || ''
                });
            }
        } catch { /* skip — keep sweeping */ }
        scanned++;
        opts.onProgress?.({ scanned, total, flagged: candidates.length });
    }

    return { candidates, inboxPath, spamPath, trashPath };
}

// Bulk move a list of (path, uid) → destination. Returns counts so
// the UI can show "Moved 12 / 14 — 2 failed", plus the items that really
// moved so callers only drop those rows.
export async function bulkMove(
    items: { path: string; uid: number }[],
    destPath: string,
    onProgress?: (done: number, total: number, failed: number) => void
): Promise<{ moved: number; failed: number; movedItems: { path: string; uid: number }[] }> {
    const movedItems: { path: string; uid: number }[] = [];
    let failed = 0;
    for (let i = 0; i < items.length; i++) {
        const { path, uid } = items[i];
        try {
            await moveMessage(path, uid, destPath);
            movedItems.push(items[i]);
        } catch {
            failed++;
        }
        onProgress?.(i + 1, items.length, failed);
    }
    return { moved: movedItems.length, failed, movedItems };
}
