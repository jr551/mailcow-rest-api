// Pure formatting helpers used across the UI.

export function formatDate(iso: string | null, now: Date = new Date()): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    // Calendar-day diff (NOT 24-hour diff). A message from yesterday morning
    // and a message from yesterday evening should both show as the same
    // weekday no matter what time it is right now.
    const civilNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const civilD = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((civilNow.getTime() - civilD.getTime()) / 86_400_000);
    if (diffDays >= 1 && diffDays <= 6) {
        return d.toLocaleDateString(undefined, { weekday: 'short' });
    }
    const sameYear = d.getFullYear() === now.getFullYear();
    if (sameYear) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' });
}

export function formatFullDate(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export function formatBytes(bytes: number | null | undefined): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface AddressLike {
    name?: string | null;
    address?: string | null;
}

export function formatAddress(a: AddressLike | undefined | null): string {
    if (!a) return '';
    if (a.name && a.address) return `${a.name} <${a.address}>`;
    return a.address || a.name || '';
}

export function formatAddressList(list: AddressLike[] | undefined | null): string {
    if (!list || !list.length) return '';
    return list.map(formatAddress).join(', ');
}

export function senderShort(list: AddressLike[] | undefined | null): string {
    if (!list || !list.length) return '(unknown sender)';
    const a = list[0];
    return a.name || a.address || '(unknown sender)';
}

export function initials(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '?';
    const parts = trimmed.split(/[\s<>"]+/).filter(Boolean);
    if (!parts.length) return trimmed.slice(0, 2).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable 32-bit hash (FNV-1a-ish). Used as the seed for avatar colors.
function hash32(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// Golden-angle hue distribution. Multiplying an integer index by ~137.508°
// produces a sequence of hues that visually never collide. We use the hash
// as that index, which spreads similar-prefix names (Concierge, Customers)
// far apart on the wheel — fixing the "everyone is purple" problem.
const GOLDEN_ANGLE = 137.50776405003785;

export function avatarGradient(seed: string): string {
    const h = hash32(seed || '?');
    const hue = (h * GOLDEN_ANGLE) % 360;
    // Vary saturation + lightness slightly per seed so adjacent hues still
    // look distinct, and so the gradient never goes flat.
    const sat = 58 + (h % 17);          // 58–74
    const light = 50 + ((h >>> 5) % 9); // 50–58
    const hue2 = (hue + 28 + ((h >>> 9) % 12)) % 360;
    return `linear-gradient(135deg, hsl(${hue} ${sat}% ${light + 8}%), hsl(${hue2} ${sat}% ${light - 4}%))`;
}

const FOLDER_ICON_BY_SPECIAL: Record<string, string> = {
    '\\Inbox': 'inbox',
    '\\Sent': 'sent',
    '\\Drafts': 'drafts',
    '\\Trash': 'trash',
    '\\Junk': 'spam',
    '\\Archive': 'archive',
    '\\Important': 'star'
};

export function folderIcon(specialUse: string | null | undefined, name: string | undefined): string {
    if (specialUse && FOLDER_ICON_BY_SPECIAL[specialUse]) return FOLDER_ICON_BY_SPECIAL[specialUse];
    const lower = (name || '').toLowerCase();
    if (lower === 'inbox') return 'inbox';
    if (/sent/.test(lower)) return 'sent';
    if (/draft/.test(lower)) return 'drafts';
    if (/trash|deleted/.test(lower)) return 'trash';
    if (/junk|spam/.test(lower)) return 'spam';
    if (/archive/.test(lower)) return 'archive';
    return 'folder';
}

// Heuristic for Gmail-synced container folders. Mailcow + dsync from
// a Google account commonly carry the bracketed parent ("[Google Mail]"
// or "[Gmail]") and its children. Detect both the container itself and
// any child path starting with the prefix so the sidebar can brand them.
export function isGmailFolder(path: string | null | undefined, name?: string | null): boolean {
    const p = (path || '').trim();
    const n = (name || '').trim();
    if (!p && !n) return false;
    const re = /^\[(Google Mail|Gmail)\]/i;
    return re.test(p) || re.test(n);
}

// True only for the bare Gmail container itself, not its children. Used
// to render the special "Synced Gmail Folder" pill instead of the
// children's normal labels.
export function isGmailContainer(path: string | null | undefined, name?: string | null): boolean {
    const p = (path || '').trim();
    const n = (name || '').trim();
    const re = /^\[(Google Mail|Gmail)\]\/?$/i;
    return re.test(p) || re.test(n);
}

export function plural(n: number, one: string, many: string): string {
    return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

/** Detects server-generated open-tracking notification emails. */
export function isTrackingEmail(subject: string | null | undefined): boolean {
    if (!subject) return false;
    return subject.trim().toLowerCase().startsWith('opened:');
}

/**
 * Treat a message as a "system notification" — render with a compact
 * alert/notice card style instead of the usual avatar+sender row. True for:
 *   - tracking-open notifications (server-generated)
 *   - any sender in the operator-configured NOTIFICATION_SENDERS list
 *   - any sender in SMS_SENDERS (those also get the phone icon, see kind)
 */
export function isNotificationMessage(opts: {
    from?: { address: string | null }[] | null;
    subject?: string | null;
    notificationSenders?: string[];
    smsSenders?: string[];
}): boolean {
    if (isTrackingEmail(opts.subject)) return true;
    const addr = opts.from?.[0]?.address?.toLowerCase() || '';
    if (!addr) return false;
    return (opts.notificationSenders || []).includes(addr)
        || (opts.smsSenders || []).includes(addr);
}

/** Detects mail from a configured SMS gateway. The webmail uses this to
 *  swap in a phone icon and disable reply. */
export function isSmsMessage(opts: {
    from?: { address: string | null }[] | null;
    smsSenders?: string[];
}): boolean {
    const addr = opts.from?.[0]?.address?.toLowerCase() || '';
    if (!addr) return false;
    return (opts.smsSenders || []).includes(addr);
}
