import { apiUrl } from './api';
// PWA install + service-worker registration.
//
// Two responsibilities:
//   1. Register /sw.js on first paint. It serves the SPA shell offline and
//      relays Web Push events into the OS notification surface.
//   2. Capture the `beforeinstallprompt` event so we can show our own
//      "Install app" button. Browsers fire this only when the manifest +
//      SW are valid and the site isn't already installed.

interface InstallState {
    available: boolean;
    installed: boolean;
    notificationsPermission: NotificationPermission | 'unavailable';
    swRegistered: boolean;
    /** A new SW version is waiting in the wings. The user-facing
     *  "Update available" prompt subscribes to this via $derived. */
    updateAvailable: boolean;
}

const state = $state<InstallState>({
    available: false,
    installed: false,
    notificationsPermission: typeof Notification !== 'undefined' ? Notification.permission : 'unavailable',
    swRegistered: false,
    updateAvailable: false
});

// Holds the registration so we can poke it from applyPwaUpdate().
let swReg: ServiceWorkerRegistration | null = null;

export const pwa = state;

// Holds the BIP event so we can call .prompt() later when the user clicks Install.
type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let deferredPrompt: BIP | null = null;

export function initPwa(): void {
    if (typeof window === 'undefined') return;

    // Detect already-installed state via display-mode media query.
    if (window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone) {
        state.installed = true;
    }

    window.addEventListener('beforeinstallprompt', (e: Event) => {
        e.preventDefault();
        deferredPrompt = e as BIP;
        state.available = true;
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        state.available = false;
        state.installed = true;
    });

    if ('serviceWorker' in navigator) {
        // Use absolute paths so the desktop bundle (/webmail/) and the
        // mobile PWA (/webmail/mobile/) both register the same SW with
        // scope /webmail/. A relative './sw.js' would resolve to
        // /webmail/mobile/sw.js on the mobile shell — which doesn't
        // exist — so registration silently failed and push subscribed
        // against a nonexistent worker on iOS.
        navigator.serviceWorker.register('/webmail/sw.js', { scope: '/webmail/' }).then((reg) => {
            state.swRegistered = true;
            swReg = reg;
            wireUpdateDetection(reg);
        }).catch(() => { /* SW unsupported / blocked — non-fatal */ });

        // controllerchange fires once the new SW takes over (after
        // skipWaiting + claim). Reload the page so the user is on the
        // freshly-cached shell instead of running stale assets that the
        // new SW will increasingly mismatch on.
        let reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloading) return;
            reloading = true;
            // Small delay so any user-visible "updating…" toast gets a
            // chance to render before the page tears down.
            setTimeout(() => { window.location.reload(); }, 60);
        });

        // Poll for updates every 30 minutes. The browser also checks on
        // navigation but PWAs in standalone mode rarely navigate, so
        // we'd otherwise miss new builds for hours.
        setInterval(() => {
            if (swReg) swReg.update().catch(() => { /* noop */ });
        }, 30 * 60 * 1000);
    }
}

function wireUpdateDetection(reg: ServiceWorkerRegistration) {
    // A SW already in "waiting" before init means a previous tab
    // installed an update we never picked up. Show the prompt now.
    if (reg.waiting) state.updateAvailable = true;

    // updatefound → a new SW is "installing". Watch its state for the
    // moment it lands in "installed" while a controller is still
    // running the old one — that's the upgrade-available signal.
    reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                state.updateAvailable = true;
            }
        });
    });
}

/** Tell the waiting SW to skipWaiting and reload. Called from the
 *  "Update available — refresh" UI button. The reload is driven by
 *  the controllerchange listener above; we just kick the worker. */
export function applyPwaUpdate(): void {
    const waiting = swReg?.waiting;
    if (!waiting) {
        // Nothing waiting — just reload as a fallback so the user
        // still sees the latest cached shell on next request.
        window.location.reload();
        return;
    }
    try { waiting.postMessage({ type: 'SKIP_WAITING' }); } catch { /* noop */ }
    // If postMessage is rejected, fall back to a hard reload.
    setTimeout(() => { if (state.updateAvailable) window.location.reload(); }, 1500);
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    if (!deferredPrompt) return 'unavailable';
    try {
        await deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
            state.available = false;
            deferredPrompt = null;
        }
        return outcome;
    } catch {
        return 'unavailable';
    }
}

// --- Web Push subscription ------------------------------------------------

function urlBase64ToUint8Array(b64: string): Uint8Array {
    const padding = '='.repeat((4 - b64.length % 4) % 4);
    const base = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

export async function subscribePush(token: string): Promise<{ ok: boolean; reason?: string }> {
    if (typeof Notification === 'undefined') return { ok: false, reason: 'Notifications not supported' };
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return { ok: false, reason: 'Push not supported by this browser' };
    }
    const perm = await Notification.requestPermission();
    state.notificationsPermission = perm;
    if (perm !== 'granted') return { ok: false, reason: 'Notifications denied' };

    // Fetch the server's VAPID public key. If unset, we can still subscribe
    // for diagnostics but the server can never deliver pushes.
    let vapid: string | null = null;
    try {
        const res = await fetch(apiUrl('/v1/push/config'));
        if (res.ok) {
            const data = await res.json();
            vapid = data.vapidPublicKey || null;
        }
    } catch { /* network blip */ }

    const reg = await navigator.serviceWorker.ready;
    const subOpts: PushSubscriptionOptionsInit = { userVisibleOnly: true };
    if (vapid) subOpts.applicationServerKey = urlBase64ToUint8Array(vapid).buffer as ArrayBuffer;

    let sub: PushSubscription;
    try {
        sub = await reg.pushManager.subscribe(subOpts);
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'Subscribe failed' };
    }

    try {
        const res = await fetch(apiUrl('/v1/push/subscribe'), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ subscription: sub.toJSON() })
        });
        if (!res.ok) return { ok: false, reason: `Server returned ${res.status}` };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'POST failed' };
    }
    return { ok: true };
}

export async function unsubscribePush(token: string): Promise<{ ok: boolean }> {
    if (!('serviceWorker' in navigator)) return { ok: false };
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            const endpoint = sub.endpoint;
            await sub.unsubscribe();
            try {
                await fetch(apiUrl('/v1/push/subscribe'), {
                    method: 'DELETE',
                    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ endpoint })
                });
            } catch { /* server forgot it; oh well */ }
        }
        return { ok: true };
    } catch {
        return { ok: false };
    }
}

export async function pushSubscriptionStatus(): Promise<'subscribed' | 'denied' | 'default' | 'unsupported'> {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) return 'subscribed';
    } catch { /* noop */ }
    return Notification.permission === 'granted' ? 'default' : 'default';
}

// Exhaustive per-subsystem diagnostics for the "Why isn't push working?"
// debug panel. Ordered checks surface the FIRST broken link so the
// operator (or user) doesn't have to read all of it.
export interface PushDiagnostics {
    secureContext: boolean;
    notificationsSupported: boolean;
    pushSupported: boolean;
    permission: NotificationPermission | 'unavailable';
    serviceWorkerRegistered: boolean;
    serviceWorkerActive: boolean;
    hasSubscription: boolean;
    endpoint: string | null;
    serverVapidConfigured: boolean;
    standalone: boolean;
    /** Best-guess single-sentence summary of what's broken (or all-good). */
    summary: string;
}

export async function diagnosePush(): Promise<PushDiagnostics> {
    const out: PushDiagnostics = {
        secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
        notificationsSupported: typeof Notification !== 'undefined',
        pushSupported: 'serviceWorker' in navigator && 'PushManager' in window,
        permission: typeof Notification !== 'undefined' ? Notification.permission : 'unavailable',
        serviceWorkerRegistered: false,
        serviceWorkerActive: false,
        hasSubscription: false,
        endpoint: null,
        serverVapidConfigured: false,
        standalone: typeof window !== 'undefined'
            && (window.matchMedia('(display-mode: standalone)').matches
                || (navigator as unknown as { standalone?: boolean }).standalone === true),
        summary: ''
    };
    if (out.pushSupported) {
        try {
            const reg = await navigator.serviceWorker.getRegistration();
            out.serviceWorkerRegistered = !!reg;
            out.serviceWorkerActive = !!(reg && reg.active);
            if (reg) {
                const sub = await reg.pushManager.getSubscription();
                out.hasSubscription = !!sub;
                out.endpoint = sub?.endpoint || null;
            }
        } catch { /* noop */ }
    }
    try {
        const res = await fetch(apiUrl('/v1/push/config'));
        if (res.ok) {
            const data = await res.json();
            out.serverVapidConfigured = !!data.vapidPublicKey;
        }
    } catch { /* noop */ }

    out.summary = (
        !out.secureContext ? 'Page must be served over HTTPS for push to work.'
        : !out.notificationsSupported ? 'This browser does not support web notifications.'
        : !out.pushSupported ? 'This browser does not support the Push API.'
        : out.permission === 'denied' ? 'Notifications are blocked — flip the bell in the URL bar to allow.'
        : !out.serverVapidConfigured ? 'Server VAPID key not configured — push delivery will never reach you.'
        : !out.serviceWorkerRegistered ? 'Service worker has not registered yet — refresh the page.'
        : !out.serviceWorkerActive ? 'Service worker is registered but not yet active — refresh.'
        : !out.hasSubscription ? 'No active push subscription — tap "Enable notifications" to opt in.'
        : 'Push is wired correctly. Try the test notification button to confirm delivery.'
    );
    return out;
}

export async function sendTestPush(token: string): Promise<{ ok: boolean; reason?: string }> {
    try {
        const res = await fetch(apiUrl('/v1/push/test'), {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({})
        });
        if (!res.ok) {
            let reason = `Server returned ${res.status}`;
            try {
                const j = await res.json();
                if (j && (j.detail || j.title)) reason = j.detail || j.title;
            } catch { /* ignore */ }
            return { ok: false, reason };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'POST failed' };
    }
}
