import { bearerHeader, getSession, tryRenewSession, type Session } from './auth.svelte';
import { recallCreds } from './keychain';
import { aiProviderOverride } from './settings.svelte';
import { reportCriticalError } from './error-doctor.svelte';

// API base override for cross-origin deployment (userapi.delivering.email)
declare global { interface Window { __IMAP_API_BASE__?: string; } }
export function apiBase(): string { const raw = (globalThis as any).__IMAP_API_BASE__ ?? ''; return String(raw).replace(/\/+$/, ''); }
export function apiUrl(path: string): string { if (!path.startsWith('/')) return path; return apiBase() + path; }

export interface Mailbox {
    path: string;
    name: string;
    delimiter: string;
    flags: string[];
    specialUse: string | null;
    subscribed: boolean;
    totalMessages?: number | null;
    unseen?: number | null;
}

export interface Envelope {
    date: string | null;
    subject: string | null;
    from: { name: string | null; address: string | null }[];
    sender?: { name: string | null; address: string | null }[];
    replyTo?: { name: string | null; address: string | null }[];
    to: { name: string | null; address: string | null }[];
    cc?: { name: string | null; address: string | null }[];
    bcc?: { name: string | null; address: string | null }[];
    messageId: string | null;
    inReplyTo: string | null;
}

export interface MessageListItem {
    uid: number;
    seq: number;
    flags: string[];
    size: number;
    internalDate: string | null;
    envelope: Envelope;
    hasAttachments?: boolean;
    attachmentCount?: number;
    /** Source folder — only stamped client-side during all-folders search. */
    mailbox?: string;
    /** SPF / DKIM / DMARC verdicts parsed from Authentication-Results.
     *  Absent when the receiving MTA didn't surface auth headers. */
    auth?: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
}

export interface Attachment {
    id: string;
    filename: string | null;
    contentType: string | null;
    size: number | null;
    disposition: string | null;
    related?: boolean;
}

export type AuthVerdict = 'pass' | 'fail' | 'softfail' | 'neutral' | 'permerror' | 'temperror' | 'none' | null;

export interface AuthResults {
    spf: AuthVerdict;
    dkim: AuthVerdict;
    dmarc: AuthVerdict;
    raw: string | null;
}

export interface MessageDetail {
    uid: number;
    seq: number;
    flags: string[];
    size: number;
    internalDate: string | null;
    envelope: Envelope;
    text: string | null;
    html: string | null;
    attachments: Attachment[];
    /** Parsed Authentication-Results — null when the receiving MTA didn't
     *  emit any auth headers (rare on modern providers). */
    auth?: AuthResults | null;
}

export interface MessageListResponse {
    path: string;
    page: number;
    pageSize: number;
    total: number;
    messages: MessageListItem[];
}

export interface ApiProblem {
    type: string;
    title: string;
    status: number;
    detail?: string;
}

export class ApiError extends Error {
    status: number;
    title: string;
    detail?: string;
    constructor(p: ApiProblem) {
        super(p.detail || p.title);
        this.status = p.status;
        this.title = p.title;
        this.detail = p.detail;
    }
}

function authHeaders(session?: Session): HeadersInit {
    const s = session || getSession();
    if (!s) return {};
    return { authorization: bearerHeader(s) };
}

async function request<T>(
    method: string,
    url: string,
    init: { body?: unknown; session?: Session; raw?: boolean; signal?: AbortSignal; cache?: RequestCache; _retried?: boolean } = {}
): Promise<T> {
    // `url` stays the relative API path so the /v1/ routing checks below keep
    // working; `target` is what we actually fetch, which is absolute (and
    // cross-origin) when the SPA is served from the webmail domain.
    const target = apiUrl(url);
    const headers: Record<string, string> = { ...(authHeaders(init.session) as Record<string, string>) };
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.body);
    }
    // Probe every same-origin call for the topbar latency sparkline. Avoids
    // a separate /health round-trip — every real request becomes a probe.
    const _t0 = performance.now();
    let res: Response;
    try {
        res = await fetch(target, { method, headers, body, signal: init.signal, cache: init.cache });
        // Token rejected by server — silently re-mint via stored creds and
        // retry the request once. Without this every Settings / Calendar /
        // AI call after a server redeploy or session prune kicks the user
        // to the login screen even though their vault still has the creds.
        // Single-flight: tryRenewSession dedupes concurrent callers.
        if (res.status === 401 && !init._retried && url.startsWith('/v1/') && !url.startsWith('/v1/auth/')) {
            const renewed = await tryRenewSession();
            if (renewed) {
                return request<T>(method, url, { ...init, _retried: true });
            }
        }
        const _ms = Math.round(performance.now() - _t0);
        // Lazy-import to avoid a circular module load if anything in
        // latency.svelte.ts ever needs api.ts back.
        const { recordLatency } = await import('./latency.svelte');
        recordLatency({ ms: _ms, ts: Date.now(), ok: res.ok, method, url: target });
        // Any non-5xx answer means the server is alive — clear the
        // maintenance overlay if it had been flipped up.
        if (res.status < 500) {
            void import('./server-health.svelte').then((h) => h.noteServerOk()).catch(() => { /* */ });
        }
        // SW marked a response as served from the offline cache — flag it so
        // the UI can show a subtle "viewing cached data" badge.
        if (res.headers.get('x-webmail-from-cache') === '1') {
            void import('./store.svelte').then((s) => { s.ui.servingCachedApi = true; }).catch(() => { /* */ });
        } else if (res.ok && url.startsWith('/v1/')) {
            void import('./store.svelte').then((s) => {
                if (s.ui.servingCachedApi) s.ui.servingCachedApi = false;
            }).catch(() => { /* */ });
        }
    } catch (err) {
        const _ms = Math.round(performance.now() - _t0);
        const { recordLatency } = await import('./latency.svelte');
        recordLatency({ ms: _ms, ts: Date.now(), ok: false, method, url: target });
        reportCriticalError({
            type: 'network',
            message: (err as Error).message || 'Network request failed',
            url: target,
            detail: `${method} ${target}`
        });
        throw err;
    }
    if (init.raw) return res as unknown as T;
    if (res.status === 204) return undefined as unknown as T;
    if (!res.ok) {
        let problem: ApiProblem;
        try {
            const j = await res.json();
            problem = {
                type: j.type || 'about:blank',
                title: j.title || res.statusText,
                status: typeof j.status === 'number' ? j.status : res.status,
                detail: j.detail
            };
        } catch {
            problem = { type: 'about:blank', title: res.statusText, status: res.status };
        }
        if (problem.status >= 500) {
            reportCriticalError({
                type: 'api',
                message: problem.title,
                status: problem.status,
                url,
                detail: problem.detail
            });
        }
        throw new ApiError(problem);
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return res.json() as Promise<T>;
    return res.text() as unknown as Promise<T>;
}

export async function listMailboxes(opts: { counts?: boolean } = {}): Promise<Mailbox[]> {
    const qs = opts.counts ? '?counts=true' : '';
    return request<Mailbox[]>('GET', `/v1/mailboxes${qs}`);
}

export async function createMailbox(path: string): Promise<{ path: string }> {
    return request('POST', '/v1/mailboxes', { body: { path } });
}

export async function renameMailbox(oldPath: string, newPath: string): Promise<{ path: string }> {
    return request('PUT', `/v1/mailboxes/${encodeURIComponent(oldPath)}`, { body: { newPath } });
}

export async function deleteMailbox(path: string): Promise<void> {
    return request('DELETE', `/v1/mailboxes/${encodeURIComponent(path)}`);
}

export async function appendRawMessage(
    path: string,
    rfc822: Uint8Array,
    opts: { flags?: string[]; internalDate?: Date } = {}
): Promise<{ path: string; uid: number | null; uidValidity: number | null }> {
    const session = getSession();
    if (!session) throw new Error('No active session');
    const qs = new URLSearchParams();
    if (opts.flags?.length) qs.set('flags', opts.flags.join(','));
    if (opts.internalDate) qs.set('internalDate', opts.internalDate.toISOString());
    const query = qs.toString();
    const res = await fetch(apiUrl(`/v1/mailboxes/${encodeURIComponent(path)}/messages${query ? '?' + query : ''}`), {
        method: 'POST',
        headers: {
            authorization: bearerHeader(session),
            'content-type': 'message/rfc822'
        },
        // Cast: TS lib types Uint8Array<ArrayBufferLike> but BodyInit wants
        // Uint8Array<ArrayBuffer>. Identical at runtime.
        body: rfc822 as BodyInit
    });
    if (!res.ok) {
        let problem: ApiProblem;
        try {
            const j = await res.json();
            problem = {
                type: j.type || 'about:blank',
                title: j.title || res.statusText,
                status: typeof j.status === 'number' ? j.status : res.status,
                detail: j.detail
            };
        } catch {
            problem = { type: 'about:blank', title: res.statusText, status: res.status };
        }
        throw new ApiError(problem);
    }
    return res.json();
}

export async function listMessages(
    path: string,
    params: { page?: number; pageSize?: number; search?: string; cache?: RequestCache } = {}
): Promise<MessageListResponse> {
    const q = new URLSearchParams();
    if (params.page !== undefined) q.set('page', String(params.page));
    if (params.pageSize !== undefined) q.set('pageSize', String(params.pageSize));
    if (params.search) q.set('search', params.search);
    const qs = q.toString();
    return request<MessageListResponse>(
        'GET',
        `/v1/mailboxes/${encodeURIComponent(path)}/messages${qs ? '?' + qs : ''}`,
        { cache: params.cache }
    );
}

export async function getMessage(path: string, uid: number): Promise<MessageDetail> {
    return request<MessageDetail>(
        'GET',
        `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}`
    );
}

export async function modifyFlags(
    path: string,
    uid: number,
    op: { add?: string[]; remove?: string[]; set?: string[] }
): Promise<{ uid: number; flags: string[] }> {
    return request('PUT', `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}/flags`, { body: op });
}

export async function moveMessage(
    fromPath: string,
    uid: number,
    destPath: string
): Promise<{ uid: number; path: string; destUid: number | null }> {
    return request('PUT', `/v1/mailboxes/${encodeURIComponent(fromPath)}/messages/${uid}/move`, {
        body: { path: destPath }
    });
}

export async function deleteMessage(path: string, uid: number): Promise<void> {
    return request('DELETE', `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}`);
}

export async function getRawMessage(path: string, uid: number): Promise<string> {
    const res = await request<Response>('GET', `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}/raw`, { raw: true });
    return res.text();
}

export function attachmentUrl(path: string, uid: number, attachmentId: string): string {
    return `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}/attachments/${encodeURIComponent(attachmentId)}`;
}

export async function ocrAttachmentText(
    path: string,
    uid: number,
    attachmentId: string
): Promise<string> {
    const url = `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}/attachments/${encodeURIComponent(attachmentId)}/text`;
    return request('GET', url);
}

function withProvider(payload: Record<string, unknown>): Record<string, unknown> {
    const provider = aiProviderOverride();
    return provider ? { ...payload, provider } : payload;
}

export async function summarizeMessage(text: string, maxWords = 120): Promise<{ content: string; model: string }> {
    return request('POST', '/v1/ai/summarize', { body: withProvider({ text, maxWords }) });
}

export async function draftReply(thread: string, intent?: string): Promise<{ content: string; model: string }> {
    return request('POST', '/v1/ai/draft-reply', { body: withProvider({ thread, intent: intent || undefined }) });
}

export async function extractActions(text: string): Promise<{ content: string; model: string }> {
    return request('POST', '/v1/ai/actions', { body: withProvider({ text }) });
}

export async function translateMessage(text: string, target: string): Promise<{ content: string; model: string }> {
    return request('POST', '/v1/ai/translate', { body: withProvider({ text, target }) });
}

export interface InboxSortMessage {
    uid: number;
    subject?: string;
    from?: { name?: string | null; address?: string | null }[];
    to?: { name?: string | null; address?: string | null }[];
    date?: string;
}

export interface InboxSortRanking {
    uid: number;
    /** 1 (low) → 5 (extreme — real-human waiting on the user). */
    level: number;
    /** Bucket the row UI renders to colour + group on. */
    category?: 'human' | 'family' | 'important' | 'purchase' | 'notification' | 'marketing' | 'info';
    /** True only when the AI thinks a real person sent this directly to
     *  the user (not a no-reply, list, or mailmerge). */
    human?: boolean;
    reason: string;
}

/** Server-side sort-inbox. Kept for parity but the client-side variant
 *  in lib/sort-inbox-client.ts is preferred — the deploy host has a
 *  flaky route to the LiteLLM proxy, while the browser doesn't. */
export async function sortInbox(messages: InboxSortMessage[]): Promise<{ rankings: InboxSortRanking[]; model: string }> {
    return request('POST', '/v1/ai/sort-inbox', { body: withProvider({ messages }) });
}

export interface PhishingScanInput {
    subject: string;
    from: string;
    to?: string;
    body: string;
    html?: string;
    headers?: string;
}

export interface PhishingScanResult {
    isPhishing: boolean;
    confidence: number;
    reasoning: string;
    indicators: string[];
    model: string;
}

export async function scanPhishing(input: PhishingScanInput): Promise<PhishingScanResult> {
    return request('POST', '/v1/ai/phishing-scan', { body: withProvider({ ...input }) });
}

export interface SendResult {
    sent: boolean;
    messageId: string;
}

export interface SendAttachment {
    filename: string;
    contentType?: string;
    /** Base-64 encoded content. Hard server-side cap is 20 items / ~18 MB decoded. */
    content: string;
}

export async function sendStub(payload: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    /** Override the From address — must be in the user's allowed list
     *  (mailbox + aliases + wildcard domains). Falls back to login user. */
    from?: string;
    /** Optional display name for the From address. The server combines
     *  this into a standard "Name" <email> header so recipients see a
     *  friendly name instead of the bare local-part. */
    fromName?: string;
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    /** When true, the server injects a 1×1 tracking pixel and emails the
     *  sender on first open. Server route: /v1/messages/send. */
    trackOpens?: boolean;
    attachments?: SendAttachment[];
}): Promise<SendResult> {
    return request<SendResult>('POST', '/v1/messages/send', { body: payload });
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'delayed' | 'unknown';
export interface DeliveryStatusResult {
    messageId: string;
    status: DeliveryStatus;
    details?: string | null;
}

export async function getMessageDeliveryStatus(messageId: string): Promise<DeliveryStatusResult> {
    // Status check polls the user's INBOX over IMAP for matching DSNs, so
    // it needs the plaintext password — Bearer tokens are rejected. Same
    // pattern as the calendar API; pulls creds out of the keychain (only
    // populated when the user ticked "Remember me" at login).
    return calendarRequest<DeliveryStatusResult>(
        'GET',
        `/v1/messages/send/${encodeURIComponent(messageId)}/status`
    );
}

// ---------- /v1/me — mailcow profile + aliases + send-from ----------

export interface MailboxInfo {
    username: string;
    name: string | null;
    active: boolean;
    domain: string;
    localPart: string;
    quota: number;       // bytes
    quotaUsed: number;   // bytes
    percentInUse: number;
    messages: number;
    created: string;
    modified: string;
    authsource: string;
    attributes: Record<string, unknown>;
}

// Server returns rows from mailcow's sasl_log via /v1/me/logins. The SQL
// aliases columns (real_rip AS ip, datetime AS time) so depending on the
// server version, rows can use either name pair. Both are exposed here and
// the UI reads ip || real_rip and time || datetime. sasl_log only records
// successful authentications — `success` may be undefined and should be
// treated as success at the call site.
export interface LoginEntry {
    user?: string;
    /** Aliased SQL column — newer server. */
    ip?: string;
    time?: string;
    /** Raw SQL column — fallback. */
    real_rip?: string;
    datetime?: string;
    service?: string;
    app_password?: string | number | null;
    success?: number | boolean;
    [k: string]: unknown;
}

export interface AliasEntry {
    address: string;
    goto: string;
    active: number | boolean;
    public_comment?: string | null;
    private_comment?: string | null;
    created: string;
    modified: string;
    [k: string]: unknown;
}

export interface TempAliasEntry {
    address: string;
    validity: number;       // unix epoch seconds
    permanent?: boolean;
    description?: string;
    [k: string]: unknown;
}

export async function getMailboxInfo(): Promise<MailboxInfo> {
    return request('GET', '/v1/me/mailbox');
}

export async function getLogins(limit = 20): Promise<{ user: string; logins: LoginEntry[] }> {
    return request('GET', `/v1/me/logins?limit=${limit}`);
}

export async function getAliases(): Promise<{ user: string; aliases: AliasEntry[] }> {
    return request('GET', '/v1/me/aliases');
}

export async function getTempAliases(): Promise<{ user: string; aliases: TempAliasEntry[] }> {
    return request('GET', '/v1/me/temp-aliases');
}

export async function createTempAlias(opts: { description?: string; validityHours?: number; permanent?: boolean })
    : Promise<{ address: string; validity: number; permanent: boolean }> {
    return request('POST', '/v1/me/temp-aliases', { body: opts });
}

export async function deleteTempAlias(address: string): Promise<void> {
    return request('DELETE', `/v1/me/temp-aliases/${encodeURIComponent(address)}`);
}

export async function getSendFromAddresses(): Promise<{ user: string; addresses: string[]; wildcardDomains?: string[] }> {
    return request('GET', '/v1/me/send-from');
}

// ---------- /v1/me — sender policy (block / allow) ----------

export interface SenderPolicy { prefid: number; sender: string }

export async function listBlockedSenders(): Promise<{ user: string; list: SenderPolicy[] }> {
    return request('GET', '/v1/me/blocked-senders');
}

export async function blockSender(sender: string): Promise<SenderPolicy> {
    return request('POST', '/v1/me/blocked-senders', { body: { sender } });
}

export async function unblockSender(prefid: number): Promise<void> {
    return request('DELETE', `/v1/me/blocked-senders/${prefid}`);
}

export async function listAllowedSenders(): Promise<{ user: string; list: SenderPolicy[] }> {
    return request('GET', '/v1/me/allowed-senders');
}

export async function allowSender(sender: string): Promise<SenderPolicy> {
    return request('POST', '/v1/me/allowed-senders', { body: { sender } });
}

export async function unallowSender(prefid: number): Promise<void> {
    return request('DELETE', `/v1/me/allowed-senders/${prefid}`);
}

// ---------- /v1/me — recipient policy (block To addresses via Sieve) ----------

export async function listBlockedRecipients(): Promise<{ user: string; recipients: string[] }> {
    return request('GET', '/v1/me/blocked-recipients');
}

export async function blockRecipient(recipient: string): Promise<{ recipient: string }> {
    return request('POST', '/v1/me/blocked-recipients', { body: { recipient } });
}

export async function unblockRecipient(recipient: string): Promise<void> {
    return request('DELETE', `/v1/me/blocked-recipients/${encodeURIComponent(recipient)}`);
}

// ---------- /v1/me/mail-rules — unified mail rules (v0.3.2) ----------
// One endpoint for blocks, redirects, and copies. Existing
// blocked-recipients endpoints still work and represent the same Sieve
// script, but the rules API is more expressive.

export type MailRuleConditionType =
    | 'envelope-to-is'
    | 'header-contains'
    | 'header-is'
    | 'from-contains'
    | 'to-contains'
    | 'subject-contains';

export type MailRuleActionType = 'discard' | 'redirect' | 'copy';

export interface MailRuleCondition {
    type: MailRuleConditionType;
    value: string;
    /** Required when type is `header-contains` or `header-is`. */
    header?: string;
}

export interface MailRuleAction {
    type: MailRuleActionType;
    /** Required for `redirect` and `copy`. */
    to?: string;
}

export interface MailRule {
    id: string;
    name: string;
    condition: MailRuleCondition;
    action: MailRuleAction;
}

export interface MailRuleInput {
    name: string;
    condition: MailRuleCondition;
    action: MailRuleAction;
}

export async function listMailRules(): Promise<{ user: string; rules: MailRule[] }> {
    return request('GET', '/v1/me/mail-rules');
}

export async function addMailRule(rule: MailRuleInput): Promise<MailRule> {
    return request('POST', '/v1/me/mail-rules', { body: rule });
}

export async function removeMailRule(id: string): Promise<void> {
    return request('DELETE', `/v1/me/mail-rules/${encodeURIComponent(id)}`);
}

// ---------- Calendar (CalDAV via SOGo) ----------
//
// The server proxies CalDAV — every request is forwarded with the user's
// plaintext password as Basic Auth (SOGo doesn't accept bearer tokens). We
// pull the password out of the keychain (set when the user ticked
// "Remember me" at login). Without it, calendar features fail with a clear
// "sign in again with Remember me" hint.
//
// Wire shapes — see src/routes/calendar.js + src/caldav-client.js:
//   GET    /v1/me/calendars                              → { user, calendars: [{id,displayName,color}] }
//   GET    /v1/me/calendars/:calendar/events?start=&end= → { user, calendar, events: [...] }
//   GET    /v1/me/calendars/:calendar/events/:uid        → event | 404
//   POST   /v1/me/calendars/:calendar/events             → 201 { uid, calendar }
//   DELETE /v1/me/calendars/:calendar/events/:uid        → 204
//
// Event shape from the iCalendar parser:
//   { uid, summary?, description?, location?, dtstart, dtend, dtstamp? }

export interface ApiCalendar {
    id: string;
    displayName?: string;
    name?: string;
    color?: string | null;
}

export interface ApiCalendarEvent {
    uid?: string;
    summary?: string;
    description?: string;
    location?: string;
    dtstart?: string;
    dtend?: string;
    dtstamp?: string;
}

export interface NormalizedCalendar {
    id: string;
    name: string;
    color?: string;
}

export interface NormalizedEvent {
    uid: string;
    calendarId: string;
    title: string;
    description?: string;
    location?: string;
    start: string;
    end: string;
    allDay?: boolean;
}

function isAllDay(s?: string): boolean {
    return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function normalizeCalendar(c: ApiCalendar): NormalizedCalendar {
    return {
        id: c.id,
        name: c.displayName || c.name || c.id,
        color: c.color || undefined
    };
}

export function normalizeEvent(e: ApiCalendarEvent, calendarId: string): NormalizedEvent {
    const start = e.dtstart || '';
    const end = e.dtend || start;
    return {
        uid: (e.uid || '').toString(),
        calendarId,
        title: e.summary || '(untitled)',
        description: e.description,
        location: e.location,
        start,
        end,
        allDay: isAllDay(start) && isAllDay(end)
    };
}

class CalendarAuthError extends Error {
    status = 401;
    constructor() {
        super('Sign in again with "Remember me" to use the calendar (SOGo needs your password).');
        this.name = 'CalendarAuthError';
    }
}

function basicCalendarAuth(): string {
    const session = getSession();
    if (!session) throw new CalendarAuthError();
    const creds = recallCreds(session.user);
    if (!creds) throw new CalendarAuthError();
    const bytes = new TextEncoder().encode(`${creds.user}:${creds.pass}`);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'Basic ' + btoa(bin);
}

async function calendarRequest<T>(method: string, url: string, init: { body?: unknown } = {}): Promise<T> {
    url = apiUrl(url);
    const headers: Record<string, string> = { authorization: basicCalendarAuth() };
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.body);
    }
    const res = await fetch(url, { method, headers, body });
    if (res.status === 204) return undefined as unknown as T;
    if (!res.ok) {
        let problem: ApiProblem;
        try {
            const j = await res.json();
            problem = {
                type: j.type || 'about:blank',
                title: j.title || res.statusText,
                status: typeof j.status === 'number' ? j.status : res.status,
                detail: j.detail
            };
        } catch {
            problem = { type: 'about:blank', title: res.statusText, status: res.status };
        }
        throw new ApiError(problem);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json() as Promise<T>;
    return res.text() as unknown as Promise<T>;
}

export async function listCalendars(): Promise<NormalizedCalendar[]> {
    const r = await calendarRequest<{ user: string; calendars: ApiCalendar[] }>('GET', '/v1/me/calendars');
    return (r.calendars || []).map(normalizeCalendar);
}

export async function listCalendarEvents(
    calendarId: string,
    range: { start: Date | string; end: Date | string }
): Promise<NormalizedEvent[]> {
    const startStr = range.start instanceof Date ? range.start.toISOString() : range.start;
    const endStr = range.end instanceof Date ? range.end.toISOString() : range.end;
    const q = new URLSearchParams({ start: startStr, end: endStr }).toString();
    const r = await calendarRequest<{ user: string; calendar: string; events: ApiCalendarEvent[] }>(
        'GET',
        `/v1/me/calendars/${encodeURIComponent(calendarId)}/events?${q}`
    );
    return (r.events || []).map((e) => normalizeEvent(e, calendarId));
}

export async function getCalendarEvent(calendarId: string, uid: string): Promise<NormalizedEvent> {
    const r = await calendarRequest<ApiCalendarEvent>(
        'GET',
        `/v1/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(uid)}`
    );
    return normalizeEvent(r, calendarId);
}

export interface CreateEventInput {
    title: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
}

export async function createCalendarEvent(
    calendarId: string,
    input: CreateEventInput
): Promise<{ uid: string; calendar: string }> {
    // Server schema is strict (additionalProperties: false). Send only what
    // the route accepts; recurrence/color/allDay aren't supported yet.
    const body: Record<string, string> = {
        summary: input.title,
        start: input.start,
        end: input.end
    };
    if (input.description) body.description = input.description;
    if (input.location) body.location = input.location;
    return calendarRequest<{ uid: string; calendar: string }>(
        'POST',
        `/v1/me/calendars/${encodeURIComponent(calendarId)}/events`,
        { body }
    );
}

export async function deleteCalendarEvent(calendarId: string, uid: string): Promise<void> {
    return calendarRequest('DELETE', `/v1/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(uid)}`);
}

export async function getCalendarIcalLink(calendarId: string): Promise<string> {
    // Authenticated URL — caller can use it directly inside the webmail
    // (carries Bearer auth) but it is NOT shareable. Use IcalPublicToken
    // helpers below for a token-based public subscription URL.
    return apiUrl(`/v1/me/calendars/${encodeURIComponent(calendarId)}/ical`);
}

export interface IcalPublicToken {
    token: string | null;
    url: string | null;
    createdAt: number | null;
    expiresAt: number | null;
}

export async function getIcalPublicToken(calendarId: string): Promise<IcalPublicToken> {
    return request<IcalPublicToken>('GET', `/v1/me/calendars/${encodeURIComponent(calendarId)}/ical-token`);
}

export async function issueIcalPublicToken(calendarId: string): Promise<IcalPublicToken> {
    return request<IcalPublicToken>('POST', `/v1/me/calendars/${encodeURIComponent(calendarId)}/ical-token`);
}

export async function revokeIcalPublicToken(calendarId: string): Promise<void> {
    return request('DELETE', `/v1/me/calendars/${encodeURIComponent(calendarId)}/ical-token`);
}

// ---------- Calendar subscriptions ----------

export interface CalendarSubscription {
    id: string;
    name: string;
    url: string;
    color: string;
}

export async function listCalendarSubscriptions(): Promise<CalendarSubscription[]> {
    const r = await calendarRequest<{ user: string; subscriptions: CalendarSubscription[] }>('GET', '/v1/me/calendar-subscriptions');
    return r.subscriptions || [];
}

export async function createCalendarSubscription(input: { name: string; url: string; color?: string }): Promise<CalendarSubscription> {
    return calendarRequest<CalendarSubscription>('POST', '/v1/me/calendar-subscriptions', { body: input });
}

export async function deleteCalendarSubscription(id: string): Promise<void> {
    return calendarRequest('DELETE', `/v1/me/calendar-subscriptions/${encodeURIComponent(id)}`);
}

export interface SubCalendarEvent {
    uid: string;
    summary: string;
    description?: string;
    location?: string;
    dtstart: string;
    dtend: string;
    dtstamp?: string;
}

export async function listSubscriptionEvents(
    id: string,
    range: { start: Date | string; end: Date | string }
): Promise<SubCalendarEvent[]> {
    const startStr = range.start instanceof Date ? range.start.toISOString() : range.start;
    const endStr = range.end instanceof Date ? range.end.toISOString() : range.end;
    const q = new URLSearchParams({ start: startStr, end: endStr }).toString();
    const r = await calendarRequest<{ user: string; subscription: string; events: SubCalendarEvent[] }>(
        'GET',
        `/v1/me/calendar-subscriptions/${encodeURIComponent(id)}/events?${q}`
    );
    return r.events || [];
}

// ---------- Company shortcuts (admin-configured) ----------

export interface Shortcut {
    title: string;
    url: string;
    mode: 'link' | 'popup' | 'embed';
    icon: string | null;
    description: string | null;
}

export interface AiConfig {
    configured: boolean;
    kind: string;
    baseUrl: string;
    model: string;
    // When true, baseUrl is our own same-origin proxy and callers must
    // authenticate with the session token (see aiAuthKey()), not apiKey —
    // the server keeps the provider key to itself.
    proxied?: boolean;
    apiKey: string;
}

export async function getAiConfig(): Promise<AiConfig> {
    return request<AiConfig>('GET', '/v1/ai/config');
}

export interface TtsConfig {
    configured: boolean;
    /** Never sent by the server — voice runs on the browser's own
     *  SpeechSynthesis. Kept optional so older cached bundles still parse. */
    apiKey?: string;
}

export async function getTtsConfig(): Promise<TtsConfig> {
    return request<TtsConfig>('GET', '/v1/ai/tts-config');
}

export async function getShortcuts(): Promise<{ shortcuts: Shortcut[] }> {
    return request('GET', '/v1/me/shortcuts');
}

// ---------- Drive config ----------

export interface DriveConfig {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    publicUrl: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
}

export async function getDriveConfig(): Promise<DriveConfig | null> {
    try {
        return await request<DriveConfig>('GET', '/v1/drive/config');
    } catch (e) {
        const ae = e as ApiError;
        if (ae.status === 404) return null;
        throw e;
    }
}

export interface DriveQuota {
    used: number;
    total: number;
}

export async function getDriveQuota(): Promise<DriveQuota | null> {
    try {
        return await request<DriveQuota>('GET', '/v1/drive/quota');
    } catch (e) {
        const ae = e as ApiError;
        if (ae.status === 404) return null;
        throw e;
    }
}
