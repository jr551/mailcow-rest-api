// Multi-account session manager.
//
// Stores an array of Bearer-token sessions in sessionStorage. The active
// session is the one the rest of the app talks to. The account dropdown
// lets the user switch between sessions or add a new one.
//
// All API calls go through getSession() / bearerHeader() which always
// resolves to the *active* session. Local cache keys are user-scoped
// (see lib/cache.ts) so switching accounts doesn't leak data between them.
//
// Stay-signed-in (lib/keychain.ts) opt-in: when the user checks the box
// during login we stash the original Basic creds in localStorage. The
// expiry watcher uses them to call POST /v1/auth/session again when the
// session is about to expire, so a 1-hour token becomes effectively
// indefinite. Without opt-in the watcher just kicks the user to the
// login screen.

const STORAGE_KEY = 'webmail.session.v3';
const PERM_STORAGE_KEY = 'webmail.session.perm.v1';
const COOKIE_NAME = 'webmail_session';
import { rememberCreds, recallCreds, forgetCreds } from './keychain';
import { apiUrl } from './api';

// Mobile detection — the mobile app is served at /webmail/mobile/
const isMobile = typeof window !== 'undefined' && window.location.pathname.startsWith('/webmail/mobile/');

// Ask the browser nicely to keep our storage around. iOS Safari and other
// "intelligent tracking" defenses will purge localStorage after ~7 days of
// inactivity unless storage is marked persistent, which is what kicks PWA
// users to the login form even though their vault creds were valid. Worth
// a try — fails silently on browsers that don't support the API or refuse
// the request.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    navigator.storage.persist().catch(() => { /* noop */ });
}

// ---------- Cookie helpers (redundant fallback for mobile perma-sign-in) ----------

function setSessionCookie(value: string) {
    try {
        const maxAge = 60 * 60 * 24 * 365; // 1 year
        document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; path=/webmail; max-age=${maxAge}; SameSite=Strict`;
    } catch { /* noop */ }
}

function getSessionCookie(): string | null {
    try {
        const match = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : null;
    } catch { return null; }
}

function clearSessionCookie() {
    try {
        document.cookie = `${COOKIE_NAME}=; path=/webmail; max-age=0; SameSite=Strict`;
    } catch { /* noop */ }
}

export interface Session {
    user: string;
    token: string;
    expiresAt: number; // epoch ms
}

interface SavedState {
    sessions: Session[];
    activeUser: string | null;
}

interface AuthState {
    sessions: Session[];
    activeUser: string | null;
    pending: boolean;
    error: string | null;
    addingAccount: boolean;       // true when login form is shown over existing inbox
    expiringSoon: boolean;
}

// recallCreds decodes the vault, which can throw on a corrupted entry.
// load() runs at module init, so a throw there would take the whole app
// down — treat any failure as "not remembered".
function hasRememberedCreds(user: string): boolean {
    try {
        return recallCreds(user) !== null;
    } catch {
        return false;
    }
}

function load(): SavedState {
    try {
        let raw = sessionStorage.getItem(STORAGE_KEY);
        // If no sessionStorage but permanent sign-in is on, try localStorage.
        if (!raw) {
            raw = localStorage.getItem(PERM_STORAGE_KEY);
        }
        // Mobile third fallback: cookie (some corporate policies wipe storage).
        if (!raw && isMobile) {
            raw = getSessionCookie();
        }
        if (!raw) return { sessions: [], activeUser: null };
        const parsed = JSON.parse(raw) as Partial<SavedState>;
        if (!parsed || !Array.isArray(parsed.sessions)) {
            // Migration from v2 format (single object) — keep working.
            const v2 = sessionStorage.getItem('webmail.session.v2');
            if (v2) {
                const s = JSON.parse(v2);
                if (s && s.user && s.token && s.expiresAt > Date.now()) {
                    return { sessions: [s], activeUser: s.user };
                }
            }
            return { sessions: [], activeUser: null };
        }
        // Keep an expired session when we still hold vault creds for it.
        //
        // Session tokens live ~1h, so a PWA reopened the next morning always
        // loads an expired one. Dropping it here made getSession() return
        // null, and every renewal path (tick(), the visibilitychange hook,
        // the 401 retry in api.ts) bails on a null session — so the vault
        // creds were never tried and the user got the login form despite
        // "stay signed in". Hand the stale session through instead and let
        // those paths re-mint it; tick() removes it if there are no creds.
        const wellFormed = parsed.sessions.filter((s) =>
            s && typeof s.user === 'string' && typeof s.token === 'string' &&
            typeof s.expiresAt === 'number');
        const valid = wellFormed.filter((s) => s.expiresAt > Date.now() || hasRememberedCreds(s.user));
        const activeUser =
            (parsed.activeUser && valid.find((s) => s.user === parsed.activeUser)?.user) ||
            valid[0]?.user || null;
        return { sessions: valid, activeUser };
    } catch {
        return { sessions: [], activeUser: null };
    }
}

function persist(state: AuthState) {
    try {
        const data: SavedState = { sessions: state.sessions, activeUser: state.activeUser };
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        // On mobile, always mirror to localStorage + cookie so the session
        // survives browser restarts, tab closes, and storage-wiping policies.
        if (isMobile) {
            localStorage.setItem(PERM_STORAGE_KEY, JSON.stringify(data));
            setSessionCookie(JSON.stringify(data));
        }
    } catch { /* quota or disabled */ }
}

function persistPerm(state: AuthState) {
    try {
        const data: SavedState = { sessions: state.sessions, activeUser: state.activeUser };
        localStorage.setItem(PERM_STORAGE_KEY, JSON.stringify(data));
        if (isMobile) setSessionCookie(JSON.stringify(data));
    } catch { /* quota or disabled */ }
}

function clearPerm() {
    try { localStorage.removeItem(PERM_STORAGE_KEY); } catch { /* noop */ }
    if (isMobile) clearSessionCookie();
}

const init = load();
const state = $state<AuthState>({
    sessions: init.sessions,
    activeUser: init.activeUser,
    pending: false,
    error: null,
    addingAccount: false,
    expiringSoon: false
});

export const authState = state;

// ---------- Active session helpers ----------

export function getSession(): Session | null {
    if (!state.activeUser) return null;
    return state.sessions.find((s) => s.user === state.activeUser) || null;
}

export function bearerHeader(session: Session): string {
    return `Bearer ${session.token}`;
}

export function setError(msg: string | null) { state.error = msg; }
export function setPending(p: boolean) { state.pending = p; }
export function setAddingAccount(adding: boolean) {
    state.addingAccount = adding;
    state.error = null;
}

// Replace or add a session by user, then make it active.
export function upsertSession(session: Session) {
    const idx = state.sessions.findIndex((s) => s.user === session.user);
    if (idx >= 0) state.sessions[idx] = session;
    else state.sessions.push(session);
    state.activeUser = session.user;
    state.addingAccount = false;
    state.expiringSoon = false;
    persist(state);
    // Re-request persistent-storage from inside the login codepath. On
    // iOS Safari + Chrome the request is much more likely to be granted
    // when called from a recent user-gesture — the module-load attempt
    // earlier in this file fails silently on most mobile browsers.
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
        navigator.storage.persist().catch(() => { /* noop */ });
    }
    // On mobile, ALWAYS write to the perm store regardless of the
    // permanentSignIn setting — iOS PWA storage is volatile and we'd
    // rather kick the user to a quick auto-relogin (vault has the creds
    // anyway because remember=true defaults on) than lose the session
    // every time the OS swaps our process.
    try {
        const raw = localStorage.getItem('webmail.settings.v1');
        const settings = raw ? JSON.parse(raw) : {};
        if (isMobile || settings.permanentSignIn) {
            persistPerm(state);
        }
    } catch { /* noop */ }
}

// Drop a session (sign-out for one account).
export function removeSession(user: string) {
    const filtered = state.sessions.filter((s) => s.user !== user);
    state.sessions = filtered;
    if (state.activeUser === user) {
        state.activeUser = filtered[0]?.user || null;
    }
    persist(state);
    persistPerm(state);
    if (!filtered.length) clearPerm();
}

// Drop everything (sign-out all accounts).
export function clearAll() {
    state.sessions = [];
    state.activeUser = null;
    state.error = null;
    state.expiringSoon = false;
    persist(state);
    clearPerm();
}

export function switchTo(user: string) {
    if (state.sessions.find((s) => s.user === user)) {
        state.activeUser = user;
        persist(state);
        try {
            const raw = localStorage.getItem('webmail.settings.v1');
            const settings = raw ? JSON.parse(raw) : {};
            if (settings.permanentSignIn) persistPerm(state);
        } catch { /* noop */ }
    }
}

// Backward-compat shim: components called setSession(null) for logout.
export function setSession(s: Session | null) {
    if (!s) {
        if (state.activeUser) removeSession(state.activeUser);
        return;
    }
    upsertSession(s);
}

// ---------- Sign-in handoff ----------

// The mailcow login page offers a "sign in to the new webmail" button. It
// exchanges the credentials the user just typed for a session token against
// the API, then sends the browser here with the token in the URL fragment.
//
// A fragment is never sent to a server and never appears in a Referer, and it
// is wiped from the address bar and this history entry before anything else
// runs. The token is not trusted on its own either — it is presented to the
// API, and only a session the server confirms is adopted, so a crafted link
// cannot plant a fake session.
export function hasHandoff(): boolean {
    if (typeof location === 'undefined' || !location.hash) return false;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    return !!(params.get('wm_token') && params.get('wm_user'));
}

export async function adoptHandoffSession(): Promise<boolean> {
    if (typeof location === 'undefined' || !location.hash) return false;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = params.get('wm_token');
    const user = params.get('wm_user');

    if (!token || !user) return false;

    const clean = () => {
        try {
            history.replaceState(null, '', location.pathname + location.search);
        } catch { /* older browsers — the hash just stays visible */ }
    };
    clean();

    try {
        const res = await fetch(apiUrl('/v1/auth/session'), {
            headers: { authorization: `Bearer ${token}` }
        });
        if (!res.ok) return false;
        const data = await res.json();
        upsertSession({
            user,
            token,
            expiresAt: typeof data.expiresAt === 'string'
                ? new Date(data.expiresAt).getTime()
                : Number(data.expiresAt)
        });
        return true;
    } catch {
        return false;
    }
}

// ---------- Auth flows ----------

// btoa() only accepts Latin1 — passwords with emoji or non-ASCII letters
// would throw InvalidCharacterError. Encode the credentials as UTF-8
// bytes first, then base64.
function basicAuth(user: string, pass: string): string {
    const bytes = new TextEncoder().encode(`${user}:${pass}`);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'Basic ' + btoa(bin);
}

// POST /v1/auth/session with Basic credentials → bearer token.
export async function login(user: string, pass: string, opts: { remember?: boolean } = {}): Promise<Session> {
    const basic = basicAuth(user, pass);
    // No body on this POST — don't advertise content-type or Fastify rejects
    // with "Body cannot be empty when content-type is set to 'application/json'".
    const res = await fetch(apiUrl('/v1/auth/session'), {
        method: 'POST',
        headers: { authorization: basic }
    });
    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
            const j = await res.json();
            detail = j.detail || j.title || detail;
        } catch { /* not JSON */ }
        const err = new Error(detail) as Error & { status: number };
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    // permanentSignIn implies "I want this to survive across browser
    // restarts forever" — that's worthless without saved creds, so
    // force-remember even if the user didn't tick the checkbox.
    let shouldRemember = !!opts.remember;
    try {
        const raw = localStorage.getItem('webmail.settings.v1');
        const settings = raw ? JSON.parse(raw) : {};
        if (settings.permanentSignIn) shouldRemember = true;
    } catch { /* */ }
    if (shouldRemember) {
        try { rememberCreds(user, pass); } catch { /* noop */ }
    } else {
        try { forgetCreds(user); } catch { /* noop */ }
    }
    return {
        user,
        token: data.token,
        expiresAt: typeof data.expiresAt === 'string'
            ? new Date(data.expiresAt).getTime()
            : Number(data.expiresAt)
    };
}

// Background renewal: if the active session is within ~5 min of expiring
// AND we have remembered creds for that user, call /v1/auth/session again
// to get a fresh token. Returns true if the session was renewed.
async function renewIfNeeded(session: Session): Promise<boolean> {
    const remaining = session.expiresAt - Date.now();
    if (remaining > SOON_MS) return false;
    const creds = recallCreds(session.user);
    if (!creds) return false;
    try {
        const fresh = await login(creds.user, creds.pass, { remember: true });
        upsertSession(fresh);
        return true;
    } catch (err) {
        // Only forget creds on a *definitive* auth failure (server told us
        // 401 — bad password). Network errors, 5xx, IMAP-backend-down etc.
        // mean the creds may still be valid; wiping them on every flaky
        // wifi is what was kicking PWA users to the login screen on
        // perfectly good passwords.
        const status = (err as { status?: number }).status;
        if (status === 401) forgetCreds(session.user);
        return false;
    }
}

// Forget remembered creds for a user (Settings → "Forget device").
export function forgetSavedCreds(user: string) {
    forgetCreds(user);
}

/** Force a renewal attempt regardless of how much time is left. Use this
 *  when an API call returns 401 — typical cause is the server got
 *  redeployed and lost its in-memory IMAP session pool. Returns true if
 *  the session was successfully replaced.
 *
 *  Single-flight: concurrent callers (multiple in-flight 401s on app
 *  resume) all await the same renewal promise instead of stampeding the
 *  /v1/auth/session endpoint. */
let inflightRenewal: Promise<boolean> | null = null;
export async function tryRenewSession(): Promise<boolean> {
    if (inflightRenewal) return inflightRenewal;
    const session = getSession();
    if (!session) return false;
    const creds = recallCreds(session.user);
    if (!creds) return false;
    inflightRenewal = (async () => {
        try {
            const fresh = await login(creds.user, creds.pass, { remember: true });
            upsertSession(fresh);
            return true;
        } catch (err) {
            // As in renewIfNeeded — only forget on a definitive 401. A
            // network error or 5xx means the password might still be good
            // and we'd rather fail this attempt than nuke the keychain.
            const status = (err as { status?: number }).status;
            if (status === 401) forgetCreds(session.user);
            return false;
        } finally {
            inflightRenewal = null;
        }
    })();
    return inflightRenewal;
}

export function isRemembered(user: string): boolean {
    return recallCreds(user) !== null;
}

// Server-side logout for the active session (best-effort).
export async function logoutRemote(): Promise<void> {
    const session = getSession();
    if (!session) return;
    try {
        await fetch(apiUrl('/v1/auth/logout'), {
            method: 'POST',
            headers: { authorization: bearerHeader(session) }
        });
    } catch { /* server may not implement; ignore */ }
}

// Probe the active session.
export async function probeSession(): Promise<number | null> {
    const session = getSession();
    if (!session) return null;
    try {
        const res = await fetch(apiUrl('/v1/auth/session'), {
            headers: { authorization: bearerHeader(session) }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const expiresAt = typeof data.expiresAt === 'string'
            ? new Date(data.expiresAt).getTime()
            : Number(data.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt !== session.expiresAt) {
            upsertSession({ ...session, expiresAt });
        }
        return expiresAt;
    } catch {
        return null;
    }
}

const SOON_MS = 5 * 60 * 1000;

let renewing = false;
async function tick() {
    const session = getSession();
    if (!session) {
        state.expiringSoon = false;
        return;
    }
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) {
        // Try one renewal first if we have stored creds.
        if (!renewing) {
            renewing = true;
            try { await renewIfNeeded(session); } finally { renewing = false; }
        }
        // If still expired, only drop the session when there's no way back
        // — i.e. no remembered creds. With creds, a transient renewal
        // failure (server briefly down, captive wifi) used to bounce the
        // user to login; now we keep the (expired) session around so the
        // next tick or next API call can retry the renewal silently.
        const fresh = getSession();
        if (!fresh || fresh.expiresAt <= Date.now()) {
            if (!recallCreds(session.user)) {
                removeSession(session.user);
            }
        }
    } else if (remaining <= SOON_MS) {
        state.expiringSoon = true;
        if (!renewing) {
            renewing = true;
            try { await renewIfNeeded(session); } finally { renewing = false; }
        }
    } else {
        state.expiringSoon = false;
    }
}

export function startExpiryWatch(): () => void {
    let stopped = false;
    const wrapped = async () => { if (!stopped) await tick(); };
    wrapped();
    const interval = setInterval(wrapped, 30_000);
    // iOS PWAs get suspended for hours; the 30s interval doesn't fire
    // while the app is backgrounded, so the bearer token can sail past
    // its TTL between visibilities. Trigger a renewal as soon as the
    // tab becomes visible again — recallCreds() will silently re-mint
    // a session before the inbox even mounts, so the user doesn't see
    // the login screen on every "open the app" gesture.
    const onVisibility = () => {
        if (typeof document === 'undefined' || document.hidden) return;
        const session = getSession();
        if (!session) return;
        const remaining = session.expiresAt - Date.now();
        // Renew aggressively on resume — anything under 10 min counts as
        // "about to expire" since we don't know how long we've been
        // suspended. tryRenewSession is a no-op when creds aren't
        // remembered, so this is safe.
        if (remaining <= 10 * 60 * 1000) {
            void tryRenewSession();
        }
    };
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
        stopped = true;
        clearInterval(interval);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility);
        }
    };
}
