// Client-side phishing scan module.
// Scans emails via /v1/ai/phishing-scan and caches results in localStorage.

import { getSession, bearerHeader } from './auth.svelte';
import { settings } from './settings.svelte';
import { type Attachment } from './api';
import { redactSecrets } from './redact';
import { ocrImage } from './tesseract-ocr';
import { feedbackPayload } from './spam-feedback.svelte';
import { apiUrl } from './api';

// Bump on prompt/scale/OCR changes so stale entries don't show wrong UI.
// v5: SPF/DKIM/DMARC verdicts now feed the scanner prompt, so a fail
// that we couldn't see before may now flip a borderline message.
const CACHE_KEY = 'webmail.phishing-scan.v5';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_ENTRIES = 500;

export interface PhishingScanInput {
    subject: string;
    from: string;
    to?: string;
    body: string;
    html?: string;
    headers?: string;
    /** Image attachments — OCR'd in the background and folded into the body
     *  before the scan request goes out. */
    attachments?: Attachment[];
    /** Folder + uid are needed to call the OCR endpoint. */
    path?: string;
    uid?: number;
    /** Parsed Authentication-Results from the server. The phishing scan
     *  prompt uses this as a strong-but-not-absolute signal — DKIM/SPF
     *  failure ≈ likely phishing, full pass ≈ rule out the obvious
     *  spoof tier. */
    auth?: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
}

export interface PhishingScanResult {
    isPhishing: boolean;
    confidence: number;
    reasoning: string;
    indicators: string[];
    /** Spam classification — independent axis from phishing. A message
     *  can be flagged as spam, phishing, both, or neither. */
    isSpam: boolean;
    spamConfidence: number;
    spamReasoning: string;
    model: string;
}

interface CacheEntry {
    result: PhishingScanResult;
    ts: number;
}

function makeCacheKey(path: string, uid: number): string {
    return `${path}::${uid}`;
}

function loadCache(): Record<string, CacheEntry> {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* noop */ }
    return {};
}

function saveCache(cache: Record<string, CacheEntry>): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch { /* noop */ }
}

function pruneCache(cache: Record<string, CacheEntry>): void {
    const now = Date.now();
    const keys = Object.keys(cache);
    if (keys.length <= MAX_CACHE_ENTRIES) {
        // Just remove expired
        for (const k of keys) {
            if (now - cache[k].ts > CACHE_TTL_MS) delete cache[k];
        }
        return;
    }
    // Sort by age, keep newest MAX_CACHE_ENTRIES
    const sorted = keys
        .map((k) => ({ k, ts: cache[k].ts }))
        .sort((a, b) => b.ts - a.ts);
    const keep = new Set(sorted.slice(0, MAX_CACHE_ENTRIES).map((x) => x.k));
    for (const k of keys) {
        if (!keep.has(k) || now - cache[k].ts > CACHE_TTL_MS) delete cache[k];
    }
}

export function getCachedScan(path: string, uid: number): PhishingScanResult | null {
    const cache = loadCache();
    const entry = cache[makeCacheKey(path, uid)];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
    return entry.result;
}

export function setCachedScan(path: string, uid: number, result: PhishingScanResult): void {
    const cache = loadCache();
    cache[makeCacheKey(path, uid)] = { result, ts: Date.now() };
    pruneCache(cache);
    saveCache(cache);
}

// Confidence floor below which the UI should not render the "phishing!"
// smoke — better to be quiet than to scare the user about a maybe.
export const PHISHING_CONFIDENCE_FLOOR = 0.7;

/** Strip HTML to plain text — keeps the LLM context lean. We retain inline
 *  text content and lose tags/scripts/styles. */
function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

const MAX_BODY_CHARS = 4000;
const MAX_INLINE_OCR_IMAGES = 5;
const INLINE_OCR_BUDGET_MS = 20_000;
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*("([^"]+)"|'([^']+)'|([^\s>]+))/gi;

/** Extract <img src> URLs from a chunk of HTML. Returns deduplicated
 *  https/data URLs only — cid: refs require server-side Content-ID
 *  resolution we don't have, and protocol-relative or relative URLs
 *  can't be fetched cross-origin from this scan path. */
function extractInlineImageUrls(html: string): string[] {
    const urls = new Set<string>();
    IMG_SRC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMG_SRC_RE.exec(html)) !== null) {
        const raw = (m[2] || m[3] || m[4] || '').trim();
        if (!raw) continue;
        if (raw.startsWith('data:image/')) urls.add(raw);
        else if (raw.startsWith('https://') || raw.startsWith('http://')) urls.add(raw);
        if (urls.size >= MAX_INLINE_OCR_IMAGES) break;
    }
    return [...urls];
}

async function fetchAsBlob(url: string, signal?: AbortSignal): Promise<Blob | null> {
    try {
        if (url.startsWith('data:')) {
            const res = await fetch(url, { signal });
            return res.ok ? res.blob() : null;
        }
        // Route remote images through the existing privacy proxy so the
        // upstream CDN doesn't see the user's IP just because they have
        // OCR enabled. Same trade-off as the proxyImages setting.
        const session = getSession();
        const headers: Record<string, string> = {};
        if (session) headers.authorization = bearerHeader(session);
        const proxied = apiUrl(`/v1/proxy/image?url=${encodeURIComponent(url)}`);
        const res = await fetch(proxied, { headers, signal });
        if (!res.ok) return null;
        const blob = await res.blob();
        if (blob.size > MAX_INLINE_IMAGE_BYTES) return null;
        return blob;
    } catch {
        return null;
    }
}

/** OCR every inline <img> in the email HTML using the local tesseract
 *  worker. Bounded by INLINE_OCR_BUDGET_MS so a slow image fetch or a
 *  giant image can never stall the phishing scan. Returns a single
 *  concatenated blob — empty when OCR is disabled or there's nothing
 *  to scan. */
async function ocrInlineImages(html: string, signal?: AbortSignal): Promise<string> {
    const urls = extractInlineImageUrls(html);
    if (urls.length === 0) return '';

    const ctl = new AbortController();
    const externalAbort = () => ctl.abort();
    if (signal) {
        if (signal.aborted) ctl.abort();
        else signal.addEventListener('abort', externalAbort, { once: true });
    }
    const budget = setTimeout(() => ctl.abort(), INLINE_OCR_BUDGET_MS);

    try {
        const ocrAll = Promise.all(urls.map(async (url) => {
            const blob = await fetchAsBlob(url, ctl.signal);
            if (!blob || ctl.signal.aborted) return '';
            const text = await ocrImage(blob, { signal: ctl.signal });
            return text;
        }));
        const results = await ocrAll;
        const chunks: string[] = [];
        for (let i = 0; i < results.length; i++) {
            const t = results[i].trim().slice(0, 2000);
            if (t) chunks.push(`[image #${i + 1}]\n${t}`);
        }
        return chunks.join('\n\n');
    } catch {
        return '';
    } finally {
        clearTimeout(budget);
        if (signal) signal.removeEventListener('abort', externalAbort);
    }
}

// Kept on PhishingScanInput for callers that already pass it; current
// scan no longer uses attachments directly (tesseract works off inline
// img tags), but keeping the field avoids a churn cascade.
export type { Attachment };

function trimInput(input: PhishingScanInput, ocrText: string): PhishingScanInput {
    let text = (input.body && input.body.trim().length > 0)
        ? input.body
        : (input.html ? stripHtml(input.html) : '');
    if (ocrText) text = `${text}\n\n--- OCR'd from images ---\n${ocrText}`;
    // Redact OTPs, passwords, card numbers BEFORE the body leaves the
    // browser. The phishing scanner doesn't need to see them — and a
    // phishing email that includes a real OTP from elsewhere shouldn't
    // leak it to the LLM provider.
    return {
        subject: redactSecrets((input.subject || '').slice(0, 250)),
        from: (input.from || '').slice(0, 200),
        to: input.to?.slice(0, 200),
        body: redactSecrets(text.slice(0, MAX_BODY_CHARS)),
        // Drop the raw HTML — the server has the trimmed body + headers,
        // which is all the LLM needs to spot phishing patterns.
        html: undefined,
        headers: input.headers?.slice(0, 2000),
        auth: input.auth ?? undefined
    };
}

// In-flight dedup. If MessageList and MessageDetail both ask to scan the
// same uid in the same render frame they both hit the cache miss path
// and the route gets called twice. Coalesce on (path, uid).
//
// IMPORTANT: the underlying scan is *not* linked to any caller's signal
// — once started it runs to completion and writes to the cache. Caller
// signals only short-circuit the caller's await (so the user can
// navigate away without the UI updating from a stale message), they
// don't cancel the network request. Otherwise rapid back-and-forth
// between messages on a slow link kept aborting scans before they
// could persist, leading to "the same email gets scanned twice".
const inflight = new Map<string, Promise<PhishingScanResult | null>>();

async function runScan(
    path: string,
    uid: number,
    input: PhishingScanInput
): Promise<PhishingScanResult | null> {
    const timeoutCtl = new AbortController();
    const timeoutMs = Math.max(2000, (settings.phishingScanTimeoutSec || 8) * 1000);
    const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
    try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const session = getSession();
        if (session) {
            headers.authorization = bearerHeader(session);
        }
        // Local OCR via tesseract.js for inline body images. Off by
        // default — only fires when the user has both installed the
        // engine AND enabled the phishing-OCR sub-toggle. All work
        // happens in a Web Worker, so the UI thread doesn't lag,
        // and image bytes never leave the browser.
        let ocrText = '';
        if (
            settings.tesseractOcrInstalled
            && settings.phishingScanOcrInline
            && input.html
        ) {
            try {
                ocrText = await ocrInlineImages(input.html, timeoutCtl.signal);
            } catch { /* noop */ }
        }
        const body = trimInput(input, ocrText);
        // The user can prepend extra instructions to bias the scan
        // (e.g. "I'm a security researcher, lean strict on financial
        // lookalikes"). Fold it into the headers blob the server
        // already passes through; cheap and avoids a server change.
        const addendum = (settings.phishingScanPromptAddendum || '').trim();
        if (addendum) {
            body.headers = `X-Webmail-Phishing-Hint: ${addendum.replace(/\s+/g, ' ').slice(0, 500)}\n` + (body.headers || '');
        }
        const fb = feedbackPayload();
        if (fb) {
            (body as unknown as Record<string, unknown>).userFeedback = fb;
        }
        const res = await fetch(apiUrl('/v1/ai/phishing-scan'), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: timeoutCtl.signal
        });
        if (!res.ok) return null;
        const result: PhishingScanResult = await res.json();
        setCachedScan(path, uid, result);
        return result;
    } catch {
        // Silently fail — don't block email reading
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function scanEmailForPhishing(
    path: string,
    uid: number,
    input: PhishingScanInput,
    opts: { signal?: AbortSignal } = {}
): Promise<PhishingScanResult | null> {
    const cached = getCachedScan(path, uid);
    if (cached) return cached;
    const key = makeCacheKey(path, uid);

    let scan = inflight.get(key);
    if (!scan) {
        scan = runScan(path, uid, input).finally(() => {
            // Only release the slot once the scan is fully done so any
            // racing callers in the meantime piggy-back on the same
            // promise. setCachedScan inside runScan persists the result
            // before this finally fires.
            inflight.delete(key);
        });
        inflight.set(key, scan);
    }

    // Caller signal only cancels the caller's await — the underlying
    // scan keeps running so the cache fills even if the user
    // navigated away. Future visits to the same email get an instant
    // hit instead of re-scanning.
    if (!opts.signal) return scan;
    return new Promise<PhishingScanResult | null>((resolve) => {
        if (opts.signal!.aborted) { resolve(null); return; }
        let settled = false;
        const onAbort = () => { if (!settled) { settled = true; resolve(null); } };
        opts.signal!.addEventListener('abort', onAbort, { once: true });
        scan!.then((r) => {
            if (settled) return;
            settled = true;
            opts.signal!.removeEventListener('abort', onAbort);
            resolve(r);
        });
    });
}

function fmtAddr(a: { name?: string | null; address?: string | null }): string {
    if (a.name && a.address) return `"${a.name}" <${a.address}>`;
    return a.address || '';
}

export function envelopeToHeaders(envelope: {
    date?: string | null;
    subject?: string | null;
    from?: { name?: string | null; address?: string | null }[];
    sender?: { name?: string | null; address?: string | null }[];
    replyTo?: { name?: string | null; address?: string | null }[];
    to?: { name?: string | null; address?: string | null }[];
    cc?: { name?: string | null; address?: string | null }[];
    bcc?: { name?: string | null; address?: string | null }[];
    messageId?: string | null;
    inReplyTo?: string | null;
}): string {
    const lines: string[] = [];
    if (envelope.date) lines.push(`Date: ${envelope.date}`);
    if (envelope.subject) lines.push(`Subject: ${envelope.subject}`);
    if (envelope.from?.length) lines.push(`From: ${fmtAddr(envelope.from[0])}`);
    if (envelope.sender?.length) lines.push(`Sender: ${fmtAddr(envelope.sender[0])}`);
    if (envelope.replyTo?.length) lines.push(`Reply-To: ${fmtAddr(envelope.replyTo[0])}`);
    if (envelope.to?.length) lines.push(`To: ${envelope.to.map(fmtAddr).join(', ')}`);
    if (envelope.cc?.length) lines.push(`Cc: ${envelope.cc.map(fmtAddr).join(', ')}`);
    if (envelope.bcc?.length) lines.push(`Bcc: ${envelope.bcc.map(fmtAddr).join(', ')}`);
    if (envelope.messageId) lines.push(`Message-ID: ${envelope.messageId}`);
    if (envelope.inReplyTo) lines.push(`In-Reply-To: ${envelope.inReplyTo}`);
    return lines.join('\n');
}

export function clearPhishingCache(): void {
    try {
        localStorage.removeItem(CACHE_KEY);
    } catch { /* noop */ }
}
