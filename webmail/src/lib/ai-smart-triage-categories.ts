import type { MessageCategoryId } from './message-categories.ts';
import { categoryFromFlags } from './message-categories.ts';

/** Minimal ranking shape from AI inbox sort (avoids pulling client deps in unit tests). */
export type SmartTriageRanking = {
    uid: number;
    category?: string;
    human?: boolean;
};

export type InboxCategory =
    | 'human'
    | 'family'
    | 'important'
    | 'purchase'
    | 'notification'
    | 'marketing'
    | 'info';

const INBOX_CATEGORIES = new Set<InboxCategory>([
    'human',
    'family',
    'important',
    'purchase',
    'notification',
    'marketing',
    'info'
]);

export function sanitizeInboxCategory(raw: unknown): InboxCategory | null {
    if (typeof raw !== 'string' || !INBOX_CATEGORIES.has(raw as InboxCategory)) return null;
    return raw as InboxCategory;
}

/** Opt-in AI triage → Outlook colour category mapping (slice 49). */
export function inboxCategoryToOwaCategory(category: InboxCategory): MessageCategoryId | null {
    switch (category) {
        case 'family':
            return 'purple';
        case 'human':
            return 'red';
        case 'important':
            return 'orange';
        case 'purchase':
            return 'blue';
        case 'notification':
            return 'yellow';
        case 'marketing':
            return 'green';
        case 'info':
            return null;
        default:
            return null;
    }
}

export type SmartTriageCategoryAssignment = {
    uid: number;
    inboxCategory: InboxCategory;
    owaCategory: MessageCategoryId;
};

/**
 * Build OWA category assignments from AI sort rankings. Skips messages that
 * already carry a colour category on the server flags.
 */
export function buildSmartTriageCategoryAssignments(input: {
    rankings: SmartTriageRanking[];
    resolveEffectiveInboxCategory: (uid: number) => InboxCategory | null;
    flagsForUid: (uid: number) => string[] | undefined;
}): SmartTriageCategoryAssignment[] {
    const out: SmartTriageCategoryAssignment[] = [];
    for (const ranking of input.rankings) {
        const flags = input.flagsForUid(ranking.uid);
        if (!flags || categoryFromFlags(flags)) continue;

        const inboxCat = input.resolveEffectiveInboxCategory(ranking.uid);
        if (!inboxCat) continue;

        const owa = inboxCategoryToOwaCategory(inboxCat);
        if (!owa) continue;

        out.push({ uid: ranking.uid, inboxCategory: inboxCat, owaCategory: owa });
    }
    return out;
}
