/** OWA-style Quick Steps: templated multi-action shortcuts on selected mail. */

import type { Mailbox } from './api';

export type QuickStepMoveTarget = 'archive' | 'trash' | 'junk';

export type QuickStepAction =
    | { type: 'mark-read' }
    | { type: 'mark-unread' }
    | { type: 'flag' }
    | { type: 'unflag' }
    | { type: 'move'; target: QuickStepMoveTarget };

export interface QuickStepDefinition {
    id: string;
    label: string;
    actions: QuickStepAction[];
}

export const DEFAULT_QUICK_STEPS: QuickStepDefinition[] = [
    {
        id: 'done',
        label: 'Done',
        actions: [{ type: 'mark-read' }, { type: 'move', target: 'archive' }]
    },
    {
        id: 'read-flag',
        label: 'Mark read & flag',
        actions: [{ type: 'mark-read' }, { type: 'flag' }]
    },
    {
        id: 'junk',
        label: 'Move to Junk',
        actions: [{ type: 'move', target: 'junk' }, { type: 'mark-read' }]
    },
    {
        id: 'delete-read',
        label: 'Move to Deleted Items',
        actions: [{ type: 'mark-read' }, { type: 'move', target: 'trash' }]
    }
];

const VALID_IDS = new Set(DEFAULT_QUICK_STEPS.map((s) => s.id));

export function quickStepById(id: string): QuickStepDefinition | undefined {
    return DEFAULT_QUICK_STEPS.find((s) => s.id === id);
}

/** Keep only known ids; default to the full catalog when storage is empty or invalid. */
export function sanitizeEnabledQuickStepIds(raw: unknown): string[] {
    if (!Array.isArray(raw)) return DEFAULT_QUICK_STEPS.map((s) => s.id);
    const picked = raw.filter((id): id is string => typeof id === 'string' && VALID_IDS.has(id));
    return picked.length ? picked : DEFAULT_QUICK_STEPS.map((s) => s.id);
}

export function orderedQuickSteps(enabledIds: string[]): QuickStepDefinition[] {
    const byId = new Map(DEFAULT_QUICK_STEPS.map((s) => [s.id, s]));
    const out: QuickStepDefinition[] = [];
    for (const id of enabledIds) {
        const step = byId.get(id);
        if (step) out.push(step);
    }
    return out.length ? out : [...DEFAULT_QUICK_STEPS];
}

function findArchiveFolder(mailboxes: Mailbox[]): string | null {
    const flagged = mailboxes.find((m) => m.specialUse === '\\Archive' || m.specialUse === '\\All');
    if (flagged) return flagged.path;
    const named = mailboxes.find((m) => /^(archive|all mail|archived)$/i.test(m.name));
    return named ? named.path : null;
}

function findTrashFolder(mailboxes: Mailbox[]): string | null {
    const trash = mailboxes.find((m) => m.specialUse === '\\Trash');
    if (trash) return trash.path;
    const named = mailboxes.find((m) => /^(trash|deleted items|bin)$/i.test(m.name));
    return named ? named.path : null;
}

function findSpamFolder(mailboxes: Mailbox[]): string | null {
    const junk = mailboxes.find((m) => m.specialUse === '\\Junk');
    if (junk) return junk.path;
    const named = mailboxes.find((m) => /^(junk|spam)$/i.test(m.name));
    return named ? named.path : null;
}

export function resolveQuickStepMovePath(
    target: QuickStepMoveTarget,
    mailboxes: Mailbox[]
): string | null {
    switch (target) {
        case 'archive':
            return findArchiveFolder(mailboxes);
        case 'trash':
            return findTrashFolder(mailboxes);
        case 'junk':
            return findSpamFolder(mailboxes);
        default:
            return null;
    }
}

export function quickStepMoveLabel(target: QuickStepMoveTarget): string {
    switch (target) {
        case 'archive':
            return 'Archive';
        case 'trash':
            return 'Deleted Items';
        case 'junk':
            return 'Junk Email';
        default:
            return 'folder';
    }
}
