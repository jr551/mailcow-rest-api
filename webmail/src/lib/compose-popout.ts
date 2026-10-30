/** Outlook-style compose in a separate browser window (parity slice 15). */

import type { MessageDetail } from './api';
import type { ComposeRestoreSnapshot } from './undo-send';

export const COMPOSE_POPOUT_STORAGE_PREFIX = 'webmail.compose-popout.v1.';
export const COMPOSE_POPOUT_BROADCAST = 'webmail-compose-popout-v1';

export type ComposePopoutContext = {
    replyTo?: MessageDetail | null;
    mode?: 'new' | 'reply' | 'replyAll' | 'forward';
    draftPlain?: string;
    restore?: ComposeRestoreSnapshot;
};

export interface ComposePopoutSession {
    composeContext: ComposePopoutContext;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;

export function isComposePopoutLocation(loc: Pick<Location, 'search'> = globalThis.location): boolean {
    if (typeof loc === 'undefined' || !loc.search) return false;
    const sp = new URLSearchParams(loc.search);
    return sp.get('composePopout') === '1' && !!sp.get('sid');
}

export function composePopoutSessionId(loc: Pick<Location, 'search'> = globalThis.location): string | null {
    if (!isComposePopoutLocation(loc)) return null;
    const sid = new URLSearchParams(loc.search).get('sid') || '';
    return SESSION_ID_RE.test(sid) ? sid : null;
}

export function newComposePopoutSessionId(): string {
    const rand = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
        : Math.random().toString(36).slice(2, 18);
    return `pop-${Date.now().toString(36)}-${rand}`;
}

export function storeComposePopoutSession(id: string, session: ComposePopoutSession): void {
    if (!SESSION_ID_RE.test(id)) throw new Error('Invalid compose pop-out session id');
    sessionStorage.setItem(COMPOSE_POPOUT_STORAGE_PREFIX + id, JSON.stringify(session));
}

export function peekComposePopoutSession(id: string): ComposePopoutSession | null {
    if (!SESSION_ID_RE.test(id)) return null;
    try {
        const raw = sessionStorage.getItem(COMPOSE_POPOUT_STORAGE_PREFIX + id);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ComposePopoutSession;
        if (!parsed || typeof parsed !== 'object' || !parsed.composeContext) return null;
        return parsed;
    } catch {
        return null;
    }
}

/** Read once — pop-out window consumes the session so reload does not reopen stale drafts. */
export function consumeComposePopoutSession(id: string): ComposePopoutSession | null {
    const session = peekComposePopoutSession(id);
    if (session) sessionStorage.removeItem(COMPOSE_POPOUT_STORAGE_PREFIX + id);
    return session;
}

export function buildComposePopoutUrl(id: string, loc: Pick<Location, 'pathname' | 'search'> = globalThis.location): string {
    const url = new URL(loc.pathname || '/', 'http://local');
    url.searchParams.set('composePopout', '1');
    url.searchParams.set('sid', id);
    return `${url.pathname}${url.search}`;
}

export function openComposePopoutWindow(id: string): Window | null {
    if (typeof window === 'undefined') return null;
    const features = 'popup=yes,width=1020,height=760,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes';
    return window.open(buildComposePopoutUrl(id), `webmail-compose-${id}`, features);
}

export function broadcastComposePopoutClosed(sessionId: string): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
        const ch = new BroadcastChannel(COMPOSE_POPOUT_BROADCAST);
        ch.postMessage({ type: 'closed', sessionId });
        ch.close();
    } catch { /* noop */ }
}

export function buildPopoutComposeContext(
    base: ComposePopoutContext | null | undefined,
    restore: ComposeRestoreSnapshot
): ComposePopoutContext {
    return {
        ...(base || { replyTo: null, mode: 'new' }),
        restore
    };
}
