import { apiUrl } from './api';

// Avatar resolver. Resolution chain:
//   1. Gravatar (sha256(email)) — actual user portrait if registered
//   2. simple-icons brand glyph — known brand recognised from the sender's
//      domain (github.com → github, mail.openai.com → openai, etc.)
//      Rendered as a charcoal silhouette so all brand tiles look uniform
//      regardless of the brand's palette.
//   3. Domain favicon via DuckDuckGo's icon proxy
//   4. Deterministic-colour initials
//
// Caching is two-tier:
//   * in-memory Map<email, AvatarRecord> for the session
//   * localStorage shadow keyed by email with TTL so reloads stay fast
//
// All resolution happens in the browser. The user's email never leaves
// their device for the favicon/simple-icons paths; for the gravatar path
// the sha256 hash (not the email) is what hits gravatar.com.

// v2: bumped key so legacy records (which carried colourful favicon URLs
// without the silhouette pipeline) get re-resolved against the new
// mask-based renderer. Old records under v1 are abandoned.
const STORAGE_KEY = 'webmail.avatars.v2';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_ENTRIES = 500;
const SETTINGS_KEY = 'webmail.avatars.gravatar';

export type AvatarKind = 'gravatar' | 'simpleicon' | 'favicon' | 'initials';

export interface AvatarRecord {
    kind: AvatarKind;
    url?: string;
    initial: string;
    color: string; // CSS background colour for the initials fallback
    ts: number;
}

interface PersistShape { [email: string]: AvatarRecord }

const memCache = new Map<string, AvatarRecord>();

function readPersist(): PersistShape {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        return JSON.parse(raw) as PersistShape;
    } catch { return {}; }
}

function writePersist(map: PersistShape) {
    try {
        // Evict oldest entries if we go over the cap.
        const entries = Object.entries(map);
        if (entries.length > MAX_ENTRIES) {
            entries.sort((a, b) => b[1].ts - a[1].ts);
            const trimmed: PersistShape = {};
            for (const [k, v] of entries.slice(0, MAX_ENTRIES)) trimmed[k] = v;
            map = trimmed;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch { /* quota / disabled */ }
}

// Hot-load from localStorage on first import.
{
    const persisted = readPersist();
    const now = Date.now();
    for (const [email, rec] of Object.entries(persisted)) {
        if (now - rec.ts < TTL_MS) memCache.set(email, rec);
    }
}

// --- Gravatar pref (default on) ----------------------------------------

function readGravatarPref(): boolean {
    try {
        const v = localStorage.getItem(SETTINGS_KEY);
        if (v === null) return true; // default on
        return v === '1';
    } catch { return true; }
}

const _gravatarOn = $state<{ on: boolean }>({ on: readGravatarPref() });
export const gravatarPref = _gravatarOn;

export function setGravatarEnabled(on: boolean) {
    _gravatarOn.on = on;
    try { localStorage.setItem(SETTINGS_KEY, on ? '1' : '0'); } catch { /* noop */ }
    // Drop any cached gravatar entries so they re-resolve under the new pref.
    if (!on) {
        for (const [email, rec] of memCache.entries()) {
            if (rec.kind === 'gravatar') memCache.delete(email);
        }
        const persisted = readPersist();
        for (const k of Object.keys(persisted)) {
            if (persisted[k].kind === 'gravatar') delete persisted[k];
        }
        writePersist(persisted);
    }
}

// --- Hashing -----------------------------------------------------------

async function sha256Hex(s: string): Promise<string> {
    const buf = new TextEncoder().encode(s);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
}

// --- Initials helpers --------------------------------------------------

// Muted, lower-saturation palette for the initials fallback. The brighter
// originals were jarring next to the charcoal silhouette tiles — these
// blend in with the same desaturated aesthetic.
const INITIAL_COLORS = [
    '#4a6789', '#4f7a5d', '#7a5d72', '#8a6f4d', '#5d6a8a',
    '#6e7a4d', '#8a5a5a', '#5d8080', '#6e5d8a', '#8a7252'
];

function pickInitial(name: string | null | undefined, email: string): string {
    const src = (name && name.trim()) || email;
    const ch = src.trim().charAt(0);
    return ch ? ch.toUpperCase() : '?';
}

function pickColor(seed: string): string {
    // Empty / placeholder seeds get a neutral grey — avoids the loud
    // olive-and-question-mark default the user flagged.
    if (!seed || seed === '?' || seed.length < 2) return '#6b7280';
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return INITIAL_COLORS[Math.abs(h) % INITIAL_COLORS.length];
}

function domainFor(email: string): string {
    const at = email.lastIndexOf('@');
    return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

// Derive simple-icons slug candidates from a domain. simple-icons slugs are
// lowercase alphanumeric (sometimes with leading digits, e.g. "1password").
// We probe candidates in order:
//   1. Full SLD with non-alphanumeric stripped (alibabaInc.com → alibabainc)
//   2. SLD split on "-"/"_", dropping generic corporate suffixes
//      (alibaba-inc.com → alibaba)
//   3. Just the first hyphen-segment (acme-research-group.com → acme)
// The first candidate that loads becomes the avatar; misses fall through
// to favicon and finally initials. Multi-part TLDs (foo.co.uk → co) miss
// silently and that's fine.
const GENERIC_SUFFIXES = new Set([
    'inc', 'corp', 'co', 'ltd', 'llc', 'group', 'gmbh', 'srl', 'sarl',
    'ag', 'sa', 'bv', 'plc', 'limited', 'holding', 'holdings', 'global',
    'international', 'company', 'companies', 'industries', 'tech', 'digital'
]);

function domainToSimpleIconSlugs(domain: string): string[] {
    if (!domain) return [];
    const labels = domain.replace(/\.$/, '').split('.').filter(Boolean);
    if (labels.length < 2) return [];
    const sld = labels[labels.length - 2].toLowerCase();
    const candidates: string[] = [];
    const full = sld.replace(/[^a-z0-9]/g, '');
    if (full) candidates.push(full);
    const parts = sld.split(/[-_]/).filter(Boolean);
    if (parts.length > 1) {
        const filtered = parts.filter((p) => !GENERIC_SUFFIXES.has(p));
        const joined = filtered.map((p) => p.replace(/[^a-z0-9]/g, '')).join('');
        if (joined && !candidates.includes(joined)) candidates.push(joined);
        const first = parts[0].replace(/[^a-z0-9]/g, '');
        if (first && !candidates.includes(first)) candidates.push(first);
    }
    return candidates;
}

// --- Probing -----------------------------------------------------------

// Resolve via <img> load events — img.onerror fires reliably in modern
// browsers when the src returns 404 (with d=404 on gravatar) or when the
// connection is refused. We avoid `fetch` here because Gravatar does
// not advertise CORS for the avatar endpoint.
function loadsOk(url: string, timeoutMs = 4000): Promise<boolean> {
    return new Promise((resolve) => {
        const img = new Image();
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            img.onload = null; img.onerror = null;
            resolve(ok);
        };
        img.onload = () => finish(img.naturalWidth > 4 && img.naturalHeight > 4);
        img.onerror = () => finish(false);
        img.src = url;
        setTimeout(() => finish(false), timeoutMs);
    });
}

// --- Public API --------------------------------------------------------

const inflight = new Map<string, Promise<AvatarRecord>>();

// All upstream icon URLs are wrapped through `/v1/proxy/icon` so the bytes
// arrive same-origin. This is required because we use the icons as
// `mask-image: url(...)` in CSS — Chrome refuses to paint masked
// cross-origin images that don't expose CORS, which leaves blank silhouettes
// AND fills the console with errors.
function viaProxy(upstream: string): string {
    return apiUrl(`/v1/proxy/icon?u=${encodeURIComponent(upstream)}`);
}

export function avatarUrl(_email: string, hash: string, size = 80): string {
    return viaProxy(`https://www.gravatar.com/avatar/${hash}?d=404&s=${size}`);
}

export function faviconUrl(domain: string, _size = 64): string {
    // DuckDuckGo's icon proxy returns a real 404 for unknown domains
    // (Google's s2/favicons returns a generic globe, which we can't tell
    // apart from a real hit). The image itself is served as PNG.
    return viaProxy(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`);
}

// simple-icons CDN. The trailing `/333333` forces a charcoal silhouette
// regardless of the brand's natural palette so a wall of mixed tiles
// looks uniform. Dark mode CSS in Avatar.svelte inverts to off-white.
export function simpleIconUrl(slug: string): string {
    return viaProxy(`https://cdn.simpleicons.org/${encodeURIComponent(slug)}/333333`);
}

export async function resolveAvatar(opts: { email: string; name?: string | null; size?: number }): Promise<AvatarRecord> {
    const email = (opts.email || '').trim().toLowerCase();
    if (!email) {
        return {
            kind: 'initials',
            initial: pickInitial(opts.name, '?'),
            color: pickColor('?'),
            ts: Date.now()
        };
    }
    const cached = memCache.get(email);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached;
    if (inflight.has(email)) return inflight.get(email)!;

    const promise = (async (): Promise<AvatarRecord> => {
        const initial = pickInitial(opts.name, email);
        const color = pickColor(email);
        const size = opts.size ?? 80;

        // 0. User-uploaded override (always wins). Stored as data: URL.
        const mine = getMyAvatar(email);
        if (mine) {
            return { kind: 'gravatar', url: mine, initial, color, ts: Date.now() };
        }

        // 1. Gravatar (if enabled)
        if (_gravatarOn.on) {
            try {
                const hash = await sha256Hex(email);
                const url = avatarUrl(email, hash, size);
                const ok = await loadsOk(url);
                if (ok) {
                    return { kind: 'gravatar', url, initial, color, ts: Date.now() };
                }
            } catch { /* hashing failed — fall through */ }
        }

        const domain = domainFor(email);

        // 2. simple-icons brand glyph (charcoal silhouette). Try a few
        //    derived slugs so e.g. "alibaba-inc.com" still hits "alibaba".
        if (domain) {
            const slugs = domainToSimpleIconSlugs(domain);
            for (const slug of slugs) {
                const url = simpleIconUrl(slug);
                const ok = await loadsOk(url);
                if (ok) {
                    return { kind: 'simpleicon', url, initial, color, ts: Date.now() };
                }
            }
        }

        // 3. Favicon for sender's domain
        if (domain) {
            const url = faviconUrl(domain, size);
            const ok = await loadsOk(url);
            if (ok) {
                return { kind: 'favicon', url, initial, color, ts: Date.now() };
            }
        }

        // 4. Initials
        return { kind: 'initials', initial, color, ts: Date.now() };
    })();

    inflight.set(email, promise);
    try {
        const rec = await promise;
        memCache.set(email, rec);
        const persisted = readPersist();
        persisted[email] = rec;
        writePersist(persisted);
        return rec;
    } finally {
        inflight.delete(email);
    }
}

export function avatarSync(email: string, name?: string | null): AvatarRecord {
    const e = (email || '').trim().toLowerCase();
    const mine = getMyAvatar(e);
    if (mine) {
        return { kind: 'gravatar', url: mine, initial: pickInitial(name, e), color: pickColor(e), ts: Date.now() };
    }
    const cached = memCache.get(e);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached;
    return {
        kind: 'initials',
        initial: pickInitial(name, e || '?'),
        color: pickColor(e || '?'),
        ts: 0 // ts=0 marks "placeholder; real one is loading"
    };
}

export function clearAvatarCache() {
    memCache.clear();
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
}

// --- Per-account user avatar override --------------------------------------
//
// Lets the user upload their own avatar, stored as a data URL in
// localStorage and shown wherever Avatar receives their own email
// address. Falls through to Gravatar / silhouette / initials when not set.

const MY_AVATAR_KEY = 'webmail.my-avatars.v1';
type MyAvatarMap = Record<string, string>;

function readMyAvatars(): MyAvatarMap {
    try {
        const raw = localStorage.getItem(MY_AVATAR_KEY);
        return raw ? (JSON.parse(raw) as MyAvatarMap) : {};
    } catch { return {}; }
}
function writeMyAvatars(m: MyAvatarMap) {
    try { localStorage.setItem(MY_AVATAR_KEY, JSON.stringify(m)); } catch { /* quota */ }
}

const _myAvatars = $state<{ map: MyAvatarMap }>({ map: readMyAvatars() });
export const myAvatars = _myAvatars;

export function getMyAvatar(email: string | null | undefined): string | null {
    if (!email) return null;
    return _myAvatars.map[email.toLowerCase()] || null;
}

export function setMyAvatar(email: string, dataUrl: string) {
    if (!email) return;
    _myAvatars.map = { ..._myAvatars.map, [email.toLowerCase()]: dataUrl };
    writeMyAvatars(_myAvatars.map);
    // Force resolveAvatar to pick up the override on next render.
    memCache.delete(email.toLowerCase());
}

export function clearMyAvatar(email: string) {
    if (!email) return;
    const next = { ..._myAvatars.map };
    delete next[email.toLowerCase()];
    _myAvatars.map = next;
    writeMyAvatars(next);
    memCache.delete(email.toLowerCase());
}
