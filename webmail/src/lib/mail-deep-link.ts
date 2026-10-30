/** Outlook-style shareable mail deep links (parity slice 16). */

export const MAIL_DEEP_LINK_MARKER = 'mail';

export type MailDeepLinkTarget = {
    folder: string;
    uid: number;
};

const FOLDER_MAX = 512;
const UID_MAX = 2_147_483_647;

export function sanitizeMailDeepLinkFolder(folder: string): string | null {
    const t = (folder || '').trim();
    if (!t || t.length > FOLDER_MAX) return null;
    return t;
}

export function sanitizeMailDeepLinkUid(raw: unknown): number | null {
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n) || n < 1 || n > UID_MAX) return null;
    return Math.floor(n);
}

function hashQueryString(hash: string): string | null {
    const trimmed = (hash || '').replace(/^#/, '').trim();
    if (!trimmed.startsWith(MAIL_DEEP_LINK_MARKER)) return null;
    const rest = trimmed.slice(MAIL_DEEP_LINK_MARKER.length);
    if (!rest || rest.startsWith('?') || rest.startsWith('&')) {
        return rest.replace(/^[?&]/, '');
    }
    return null;
}

export function parseMailDeepLinkHash(hash: string): MailDeepLinkTarget | null {
    const q = hashQueryString(hash);
    if (q === null) return null;
    const sp = new URLSearchParams(q);
    const folder = sanitizeMailDeepLinkFolder(sp.get('folder') || '');
    const uid = sanitizeMailDeepLinkUid(sp.get('uid'));
    if (!folder || uid === null) return null;
    return { folder, uid };
}

export function buildMailDeepLinkHash(folder: string, uid: number): string {
    const f = sanitizeMailDeepLinkFolder(folder);
    const u = sanitizeMailDeepLinkUid(uid);
    if (!f || u === null) throw new Error('Invalid mail deep link');
    const sp = new URLSearchParams();
    sp.set('folder', f);
    sp.set('uid', String(u));
    return `#${MAIL_DEEP_LINK_MARKER}?${sp.toString()}`;
}

export function buildMailDeepLinkUrl(
    folder: string,
    uid: number,
    loc: Pick<Location, 'pathname' | 'search' | 'origin'> = globalThis.location
): string {
    const hash = buildMailDeepLinkHash(folder, uid);
    const path = loc.pathname || '/webmail/';
    const search = loc.search || '';
    const origin = loc.origin || '';
    return `${origin}${path}${search}${hash}`;
}

export function replaceMailDeepLinkInHistory(
    folder: string | null,
    uid: number | null,
    loc: Pick<Location, 'pathname' | 'search'> = globalThis.location
): void {
    if (typeof history === 'undefined') return;
    let hash = '';
    if (folder && uid != null) {
        try {
            hash = buildMailDeepLinkHash(folder, uid);
        } catch {
            hash = '';
        }
    }
    const url = `${loc.pathname || '/webmail/'}${loc.search || ''}${hash}`;
    try {
        history.replaceState(history.state, '', url);
    } catch { /* noop */ }
}

export async function copyMailDeepLinkToClipboard(folder: string, uid: number): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    try {
        await navigator.clipboard.writeText(buildMailDeepLinkUrl(folder, uid));
        return true;
    } catch {
        return false;
    }
}
