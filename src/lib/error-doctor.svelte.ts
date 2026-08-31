// Error Doctor — global error capture + AI diagnosis.
//
// When something breaks critically (uncaught exception, unhandled rejection,
// repeated API failure, network outage) the doctor modal surfaces so the user
// gets a plain-English explanation from the LLM plus one-click recovery.

import { isChatConfigured, resolveBaseUrl, resolveModel, resolveApiKey } from './chat.svelte';
import { showToast } from './store.svelte';
import { apiBase, apiUrl } from './api';

const SUPPRESS_KEY = 'webmail.error-doctor.suppress';

export function isSuppressed(): boolean {
    try { return localStorage.getItem(SUPPRESS_KEY) === '1'; } catch { return false; }
}

export function setSuppressed(value: boolean) {
    try {
        if (value) localStorage.setItem(SUPPRESS_KEY, '1');
        else localStorage.removeItem(SUPPRESS_KEY);
    } catch { /* noop */ }
}

export type IncidentType = 'api' | 'javascript' | 'promise' | 'network';

export interface ErrorIncident {
    id: string;
    ts: number;
    type: IncidentType;
    message: string;
    status?: number;
    url?: string;
    stack?: string;
    detail?: string;
    diagnosis: string | null;
    diagnosisLoading: boolean;
}

const state = $state<{
    incident: ErrorIncident | null;
    history: ErrorIncident[];
    buffer: ErrorIncident[];
    quietTimer: ReturnType<typeof setTimeout> | null;
}>({
    incident: null,
    history: [],
    buffer: [],
    quietTimer: null
});

export const doctor = state;

function makeId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const QUIET_MS = 10000;

// Background-poll routes that the user never invoked directly. A 502 from
// these is almost always upstream blip, not something worth interrupting
// the user about. They still land in history, just not the modal.
const SILENT_ROUTES: RegExp[] = [
    /\/v1\/drive\/quota$/,
    /\/v1\/push\/config$/,
    /\/v1\/ai\/tts-config$/,
    /\/imap-rest\/health$/,
    // Image proxy upstream URLs are tracking-pixel hosts, signed CDN URLs,
    // and other ephemeral things that 502 routinely. The image just fails
    // to render — the user can see that — no need to also pop a modal.
    /\/v1\/proxy\/image(\?|$)/,
    // Phishing scan runs in the background on every message open. A blip
    // means we don't show the smoke effect; tomorrow's open will retry.
    /\/v1\/ai\/phishing-scan$/,
    // AI sort is opt-in but failures here surface inline in the UI
    // already (loader hides + retry button). No modal needed.
    /\/v1\/ai\/sort-inbox$/,
    // The settings-sync hidden folder is created lazily, so the very first
    // read after sign-in legitimately fails until it exists. Sync is
    // best-effort and already falls back to local settings — a modal here
    // just told a brand-new user their server was broken.
    /\/v1\/mailboxes\/\.storage_webmailsettings/
];

// Per-URL+status throttle so a flapping endpoint doesn't pile up 20
// identical incidents in a single batch window.
const recentReports = new Map<string, number>();
const REPORT_DEDUP_MS = 30_000;

// 5xx on any of our own routes feeds the server-health watcher so the
// maintenance overlay can flip up when things are properly broken.
function isOwnRoute(url?: string): boolean {
    if (!url) return false;
    return url.includes('/v1/') || url.includes('/imap-rest/');
}

/** Report a critical error that should trigger the doctor modal. */
export function reportCriticalError(opts: {
    type: IncidentType;
    message: string;
    status?: number;
    url?: string;
    stack?: string;
    detail?: string;
}) {
    if (typeof opts.status === 'number' && opts.status >= 500 && opts.status <= 599 && isOwnRoute(opts.url)) {
        // Lazy import to avoid a circular load at module init.
        import('./server-health.svelte').then((h) => h.noteServer5xx()).catch(() => { /* noop */ });
    }
    if (opts.type === 'network' && isOwnRoute(opts.url)) {
        import('./server-health.svelte').then((h) => h.noteServer5xx()).catch(() => { /* noop */ });
    }
    if (opts.url && SILENT_ROUTES.some((r) => r.test(opts.url!))) return;

    if (opts.url) {
        const key = `${opts.url}|${opts.status ?? ''}`;
        const last = recentReports.get(key) ?? 0;
        const now = Date.now();
        if (now - last < REPORT_DEDUP_MS) return;
        recentReports.set(key, now);
        if (recentReports.size > 100) {
            for (const [k, t] of recentReports) {
                if (now - t > REPORT_DEDUP_MS) recentReports.delete(k);
            }
        }
    }

    // Fire-and-forget telemetry POST so the operator can grep
    // /data/error.log for what users hit. Uses sendBeacon when
    // available so page unload still flushes; falls back to fetch.
    try {
        const body = JSON.stringify({
            type: opts.type,
            message: opts.message,
            status: opts.status,
            url: opts.url,
            stack: opts.stack,
            detail: opts.detail,
            page: typeof location !== 'undefined' ? location.href : undefined,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined
        });
        // sendBeacon can't perform the CORS preflight an application/json
        // body requires, so it is only usable while the API is same-origin.
        if (!apiBase() && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            const blob = new Blob([body], { type: 'application/json' });
            navigator.sendBeacon('/v1/telemetry/error', blob);
        } else {
            void fetch(apiUrl('/v1/telemetry/error'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                keepalive: true
            }).catch(() => { /* swallow — never let telemetry crash the app */ });
        }
    } catch { /* never throw out of an error reporter */ }

    const incident: ErrorIncident = {
        id: makeId(),
        ts: Date.now(),
        type: opts.type,
        message: opts.message,
        status: opts.status,
        url: opts.url,
        stack: opts.stack,
        detail: opts.detail,
        diagnosis: null,
        diagnosisLoading: false
    };
    state.history = [incident, ...state.history].slice(0, 20);

    // Accumulate in buffer instead of showing immediately.
    state.buffer = [...state.buffer, incident];

    // Reset the quiet timer.
    if (state.quietTimer) clearTimeout(state.quietTimer);
    state.quietTimer = setTimeout(() => flushBuffer(), QUIET_MS);
}

function flushBuffer() {
    state.quietTimer = null;
    const batch = state.buffer;
    if (batch.length === 0) return;
    state.buffer = [];

    if (isSuppressed()) return;

    // Build a compound incident from the batch.
    const compound: ErrorIncident = batch.length === 1
        ? batch[0]
        : {
            id: makeId(),
            ts: Date.now(),
            type: batch.some(i => i.type === 'javascript') ? 'javascript'
                : batch.some(i => i.type === 'promise') ? 'promise'
                : batch.some(i => i.type === 'network') ? 'network'
                : 'api',
            message: `${batch.length} errors occurred`,
            status: batch.find(i => i.status)?.status,
            url: batch.find(i => i.url)?.url,
            detail: batch.map((i, idx) => `(${idx + 1}) [${i.type}] ${i.message}${i.detail ? ': ' + i.detail : ''}`).join('\n'),
            diagnosis: null,
            diagnosisLoading: false
        };

    state.incident = compound;

    if (isChatConfigured()) {
        runDiagnosis(compound, batch);
    }
}

/** Dismiss the current incident. */
export function dismissIncident() {
    state.incident = null;
    // Also clear any buffered errors so they don't resurface.
    state.buffer = [];
    if (state.quietTimer) {
        clearTimeout(state.quietTimer);
        state.quietTimer = null;
    }
}

/** Clear all history. */
export function clearHistory() {
    state.history = [];
    state.incident = null;
}

/** Refresh the page. */
export function refreshPage() {
    location.reload();
}

/** Soft-restart: dismiss the incident and reset reactive state so the app
 *  re-initialises without a full page load. */
export function softRestart() {
    dismissIncident();
    // Dispatch a custom event that views can listen for to re-fetch data.
    window.dispatchEvent(new CustomEvent('app:restart', { detail: { ts: Date.now() } }));
}

async function runDiagnosis(incident: ErrorIncident, batch?: ErrorIncident[]) {
    incident.diagnosisLoading = true;
    try {
        const baseUrl = resolveBaseUrl();
        const model = resolveModel();
        const apiKey = resolveApiKey();

        const prompt = buildDiagnosisPrompt(incident, batch);
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 300 // keep it fast
            })
        });
        if (!res.ok) {
            incident.diagnosis = null;
            return;
        }
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content || '';
        incident.diagnosis = text.trim() || null;
    } catch {
        incident.diagnosis = null;
    } finally {
        incident.diagnosisLoading = false;
    }
}

function buildDiagnosisPrompt(incident: ErrorIncident, batch?: ErrorIncident[]): string {
    const parts = [
        'You are a helpful technical support assistant inside a webmail app.',
        'A user hit errors. Explain what happened in 2-4 short, friendly sentences.',
        'Then suggest the best next step (refresh page, check settings, try again later, or contact support).',
        '',
        'Error details:'
    ];
    if (batch && batch.length > 1) {
        for (const i of batch.slice(0, 6)) {
            parts.push(`- [${i.type}] ${i.message}${i.status ? ` (HTTP ${i.status})` : ''}${i.url ? ` — ${i.url}` : ''}`);
        }
        if (batch.length > 6) parts.push(`- …and ${batch.length - 6} more.`);
    } else {
        parts.push(`- Type: ${incident.type}`);
        parts.push(`- Message: ${incident.message}`);
        if (incident.status !== undefined) parts.push(`- HTTP status: ${incident.status}`);
        if (incident.url) parts.push(`- URL: ${incident.url}`);
        if (incident.detail) parts.push(`- Detail: ${incident.detail}`);
        if (incident.stack) parts.push(`- Stack: ${incident.stack.split('\n').slice(0, 4).join('\n')}`);
    }
    parts.push(`- Page: ${location.href}`);
    parts.push(`- User agent: ${navigator.userAgent}`);
    parts.push('');
    parts.push('Keep the tone calm and helpful. No markdown headings. Plain paragraphs only. Be concise.');
    return parts.join('\n');
}

// --------------------------------------------------------------------------
// Global window-level error handlers
// --------------------------------------------------------------------------

let installed = false;

// Non-critical errors that Svelte or frameworks throw as recoverable warnings.
// Opening a doctor modal for these is worse than letting the UI degrade gracefully.
const IGNORED_PATTERNS = [
    /svelte\.dev\/e\/each_key_duplicate/,
    /svelte\.dev\/e\/state_referenced_locally/,
    // Tesseract.js worker errors. The OCR path is best-effort — when
    // the worker can't load a WASM variant or decode an image, the
    // higher-level scan code already handles the empty result. We
    // don't want a doctor modal popping up for these.
    /attempting to read image/i,
    /tesseract-core[^\s]*\.wasm/i,
    /Failed to execute 'importScripts'.*tesseract/i
];

function shouldIgnoreError(msg: string): boolean {
    return IGNORED_PATTERNS.some((p) => p.test(msg));
}

export function installErrorDoctor() {
    if (installed) return;
    installed = true;

    const origOnError = window.onerror;
    window.onerror = (msg, url, line, col, err) => {
        const message = String(msg);
        if (!shouldIgnoreError(message)) {
            reportCriticalError({
                type: 'javascript',
                message,
                url: url ?? undefined,
                stack: err?.stack,
                detail: `line ${line}, col ${col}`
            });
        }
        if (typeof origOnError === 'function') origOnError.call(window, msg, url, line, col, err);
        return false;
    };

    const origOnRejection = window.onunhandledrejection;
    window.onunhandledrejection = (ev) => {
        const reason = ev.reason;
        const err = reason instanceof Error ? reason : new Error(String(reason));
        if (!shouldIgnoreError(err.message)) {
            reportCriticalError({
                type: 'promise',
                message: err.message || 'Unhandled promise rejection',
                stack: err.stack,
                detail: String(reason)
            });
        }
        if (typeof origOnRejection === 'function') origOnRejection.call(window, ev);
    };
}

/** Wrap an async function so that rejected promises are reported to the doctor
 *  instead of becoming unhandled rejections.  Useful for fire-and-forget calls. */
export function guard<T>(promise: Promise<T>, context?: string): Promise<T | undefined> {
    return promise.catch((err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        reportCriticalError({
            type: 'api',
            message: e.message,
            stack: e.stack,
            detail: context
        });
        return undefined;
    });
}
