/** Outlook-style colour categories (IMAP keyword + local overlay). */

export type MessageCategoryId = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export interface MessageCategoryDef {
    id: MessageCategoryId;
    label: string;
    /** Custom IMAP keyword stored on the server when supported. */
    keyword: string;
    /** CSS colour for list stripe / chips. */
    color: string;
}

export const MESSAGE_CATEGORIES: MessageCategoryId[] = [
    'red',
    'orange',
    'yellow',
    'green',
    'blue',
    'purple'
];

export const MESSAGE_CATEGORY_BY_ID: Record<MessageCategoryId, MessageCategoryDef> = {
    red: { id: 'red', label: 'Red category', keyword: '$CategoryRed', color: '#c50f1f' },
    orange: { id: 'orange', label: 'Orange category', keyword: '$CategoryOrange', color: '#ca5010' },
    yellow: { id: 'yellow', label: 'Yellow category', keyword: '$CategoryYellow', color: '#986f0b' },
    green: { id: 'green', label: 'Green category', keyword: '$CategoryGreen', color: '#107c10' },
    blue: { id: 'blue', label: 'Blue category', keyword: '$CategoryBlue', color: '#0078d4' },
    purple: { id: 'purple', label: 'Purple category', keyword: '$CategoryPurple', color: '#5c2d91' }
};

export const ALL_CATEGORY_KEYWORDS = MESSAGE_CATEGORIES.map((id) => MESSAGE_CATEGORY_BY_ID[id].keyword);

export const MESSAGE_CATEGORIES_STORAGE_KEY = 'webmail.message-categories.v1';

export function categoryStorageKey(mailboxPath: string, uid: number): string {
    return `${mailboxPath}\u0000${uid}`;
}

export function sanitizeCategoryId(raw: unknown): MessageCategoryId | null {
    if (typeof raw !== 'string') return null;
    return MESSAGE_CATEGORIES.includes(raw as MessageCategoryId) ? (raw as MessageCategoryId) : null;
}

export function categoryFromFlags(flags: string[]): MessageCategoryId | null {
    for (const id of MESSAGE_CATEGORIES) {
        const kw = MESSAGE_CATEGORY_BY_ID[id].keyword;
        if (flags.includes(kw)) return id;
    }
    return null;
}

export function resolveMessageCategory(
    mailboxPath: string,
    uid: number,
    flags: string[],
    overlay: Record<string, MessageCategoryId>
): MessageCategoryId | null {
    const fromFlags = categoryFromFlags(flags);
    if (fromFlags) return fromFlags;
    return overlay[categoryStorageKey(mailboxPath, uid)] ?? null;
}

export function buildCategoryFlagUpdate(
    currentFlags: string[],
    next: MessageCategoryId | null
): { add?: string[]; remove?: string[] } {
    const remove = ALL_CATEGORY_KEYWORDS.filter((kw) => currentFlags.includes(kw));
    const add: string[] = [];
    if (next) add.push(MESSAGE_CATEGORY_BY_ID[next].keyword);
    const op: { add?: string[]; remove?: string[] } = {};
    if (remove.length) op.remove = remove;
    if (add.length) op.add = add;
    if (!op.add && !op.remove) return {};
    return op;
}

export function applyCategoryToFlags(currentFlags: string[], next: MessageCategoryId | null): string[] {
    const without = currentFlags.filter((f) => !ALL_CATEGORY_KEYWORDS.includes(f));
    if (!next) return without;
    return [...without, MESSAGE_CATEGORY_BY_ID[next].keyword];
}

export function sanitizeCategoryOverlay(raw: unknown): Record<string, MessageCategoryId> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, MessageCategoryId> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        const id = sanitizeCategoryId(val);
        if (id && typeof key === 'string' && key.includes('\u0000')) out[key] = id;
    }
    return out;
}

export function categoryMenuItems(): { value: MessageCategoryId | 'clear'; label: string }[] {
    const items = MESSAGE_CATEGORIES.map((id) => ({
        value: id as MessageCategoryId | 'clear',
        label: MESSAGE_CATEGORY_BY_ID[id].label
    }));
    items.push({ value: 'clear', label: 'Clear category' });
    return items;
}
