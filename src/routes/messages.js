'use strict';

const { withClient, withMailbox, serializeListItem, serializeEnvelope, countAttachments,
    walkStructure, streamToBuffer, downloadPartText, parseAuthResultsHeader } = require('../imap');
const {
    messageListItemSchema,
    messageDetailSchema,
    flagsOpSchema,
    moveOpSchema,
    listMessagesQuerySchema,
    bulkDeleteMessagesBodySchema,
    problemSchema
} = require('../schemas');
const { notFound, badRequest, problem } = require('../errors');
const config = require('../config');
const { ocrAttachment, pagesToText } = require('../ocr');

// The router (find-my-way) percent-decodes route params before handlers see
// them — '%252F' is already '%2F' here. Decoding again was both wrong and
// dangerous: a mailbox literally named 'A%2FB' was addressed as 'A/B', so
// move/delete silently acted on a DIFFERENT mailbox than the caller named,
// and a mailbox named '100%' threw URIError → 500. Use the param exactly as
// the router hands it over.
function mailboxPathParam(req) {
    return req.params['*'] || req.params.path || '';
}

// IMAP UIDs are positive integers. An unvalidated Number() here turned
// 'abc' into NaN and stringified it to 'NaN' for the IMAP layer, which
// rejected it — a 502 with an upstream-error shape for what is a plain
// client mistake. Malformed uids are 400s and must never reach IMAP.
function parseUidParam(req) {
    const raw = String(req.params.uid ?? '');
    if (!/^\d+$/.test(raw)) throw badRequest('uid must be a positive integer');
    const uid = Number(raw);
    if (!Number.isSafeInteger(uid) || uid < 1) throw badRequest('uid must be a positive integer');
    return uid;
}

// A text/html or text/plain body far larger than any real message would be
// buffered, decoded and serialised to JSON on every open of it.
const MAX_BODY_PART_BYTES = 5 * 1024 * 1024;

// RFC 6266 Content-Disposition for a download: a plain ASCII fallback for
// old clients plus the RFC 5987 UTF-8 form for the real name. The name is
// attacker-chosen, so quotes, backslashes and line breaks never reach the
// quoted string.
function attachmentDisposition(filename) {
    const name = String(filename || 'attachment').toWellFormed();
    const fallback = name.replace(/[\r\n"\\]/g, '').replace(/[^\x20-\x7e]/g, '_').trim() || 'attachment';
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Bytes from a message are untrusted: never let a browser sniff them into
// something executable or render them with this origin's privileges.
function hardenDownload(reply) {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', 'sandbox');
}

// A pattern is an exact address or contains `*` wildcards matched against the
// whole address, the same two shapes rspamd's blacklist_from accepts.
function senderMatcher(pattern) {
    const want = pattern.toLowerCase();
    if (!want.includes('*')) return (address) => address.toLowerCase() === want;
    const re = new RegExp(
        '^' + want.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '[\\s\\S]*' : '\\' + c)) + '$',
        'i'
    );
    return (address) => re.test(address);
}

// IMAP FROM is a case-insensitive substring match, so it can only narrow:
// the longest literal run of the pattern is searched, and the envelope's
// From address is then held to the pattern itself.
async function findUidsBySender(client, pattern) {
    const literal = pattern.split('*').reduce((best, part) => (part.length > best.length ? part : best), '');
    // A pattern of only wildcards names no sender; it must not become "everything".
    if (!literal) return [];
    const candidates = (await client.search({ from: literal }, { uid: true })) || [];
    if (!candidates.length) return [];
    const matches = senderMatcher(pattern);
    const uids = [];
    for await (const msg of client.fetch(candidates, { uid: true, envelope: true }, { uid: true })) {
        const address = msg.envelope?.from?.[0]?.address;
        if (address && matches(address)) uids.push(msg.uid);
    }
    return uids;
}

// Parse a free-text search string into IMAP SEARCH criteria. Supports
// Gmail-style prefix tokens (case-insensitive, value can be quoted with
// "..." for multi-word matches):
//
//   from:foo            → header from contains "foo"
//   to:bar              → header to contains "bar"
//   cc:baz              → header cc contains "baz"
//   subject:hello       → header subject contains "hello"
//   body:"some words"   → body contains "some words"
//   has:attachment      → has any attachment (mapped to keyword: $HasAttachment
//                          + body:base64 fallback for servers that don't keyword)
//   is:unread           → flag UNSEEN
//   is:read             → flag SEEN
//   is:starred / is:flagged → flag FLAGGED
//
// Anything left over after extracting tokens becomes a free-text OR over
// {subject, from, body} — preserving the previous behaviour. Multiple
// tokens AND together. A bare query with no tokens behaves identically
// to the old code path.
function parseSearchTokens(input) {
    const tokens = [];
    let rest = '';
    const re = /(\w+):("([^"]*)"|(\S+))|(\S+)/g;
    let m;
    while ((m = re.exec(input)) !== null) {
        if (m[1]) {
            // m[1] = key, m[3] = quoted value (may be ''), m[4] = unquoted value
            const key = m[1].toLowerCase();
            const value = m[3] !== undefined ? m[3] : (m[4] || '');
            tokens.push({ key, value });
        } else if (m[5]) {
            rest += (rest ? ' ' : '') + m[5];
        }
    }
    return { tokens, rest };
}

// Returns { criteria, requireAttachment }. The flag is separate because
// "has an attachment" is not expressible as an IMAP SEARCH key — it has to
// be decided from the message's MIME structure after fetching.
function buildSearch(input) {
    const { tokens, rest } = parseSearchTokens(input);
    const criteria = {};
    let requireAttachment = false;
    for (const { key, value } of tokens) {
        if (!value && key !== 'has' && key !== 'is') continue;
        switch (key) {
            case 'from':    criteria.from = value; break;
            case 'to':      criteria.to = value; break;
            case 'cc':      criteria.cc = value; break;
            case 'bcc':     criteria.bcc = value; break;
            case 'subject': criteria.subject = value; break;
            case 'body':    criteria.body = value; break;
            case 'has':
                if (value.toLowerCase() === 'attachment' || value.toLowerCase() === 'attachments') {
                    // Dovecot does not set $HasAttachment, so searching for
                    // that keyword matched nothing at all — the advertised
                    // `has:attachment` query always returned zero results.
                    //
                    // Every message with an attachment is multipart, so
                    // narrow server-side on the Content-Type header (cheap,
                    // high recall) and let the caller filter precisely by
                    // bodyStructure afterwards. requireAttachment carries
                    // that instruction out.
                    criteria.header = { 'content-type': 'multipart/' };
                    requireAttachment = true;
                }
                break;
            case 'is': {
                const v = value.toLowerCase();
                if (v === 'unread') criteria.unseen = true;
                else if (v === 'read') criteria.seen = true;
                else if (v === 'starred' || v === 'flagged') criteria.flagged = true;
                else if (v === 'unstarred' || v === 'unflagged') criteria.unflagged = true;
                break;
            }
            default:
                // Unknown token — fall back to OR over body so the user's
                // intent (find this text) isn't dropped silently.
                criteria.or = (criteria.or || []).concat([{ body: `${key}:${value}` }]);
        }
    }
    if (rest) {
        criteria.or = (criteria.or || []).concat([
            { subject: rest }, { from: rest }, { body: rest }
        ]);
    }
    // If no tokens and no rest matched, fall back to the legacy free-text OR.
    if (Object.keys(criteria).length === 0) {
        return { criteria: { or: [{ subject: input }, { from: input }, { body: input }] }, requireAttachment };
    }
    return { criteria, requireAttachment };
}


module.exports = async function messageRoutes(app, { pool, ocrCache, imapCache }) {
    const cache = imapCache; // may be undefined in legacy tests
    // POST /v1/mailboxes/:path/messages — IMAP APPEND a raw RFC822 message
    // into the named mailbox. Used by the webmail to stash hidden settings
    // payloads in `.storage_webmailsettings` for cross-device sync, but the
    // endpoint is generic — any RFC822 bytes are valid.
    //
    // Content-Type must be message/rfc822 (handled by the body parser in
    // server.js). Optional query string:
    //   ?flags=Seen,Draft   — comma-separated IMAP flags (no leading backslash)
    //   ?internalDate=ISO   — overrides the appended message's INTERNALDATE
    app.post('/v1/mailboxes/:path(^.*)/messages', {
        schema: {
            tags: ['messages'],
            summary: 'Append a raw RFC822 message to a mailbox',
            consumes: ['message/rfc822'],
            querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    flags: { type: 'string' },
                    internalDate: { type: 'string', format: 'date-time' }
                }
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        uid: { type: ['integer', 'null'] },
                        uidValidity: { type: ['integer', 'null'] }
                    }
                },
                400: problemSchema,
                404: problemSchema,
                502: problemSchema
            }
        }
    }, async (req, reply) => {
        const mboxPath = mailboxPathParam(req);
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
            throw badRequest('Body must be raw RFC822 bytes (Content-Type: message/rfc822)');
        }
        const flags = req.query?.flags
            ? String(req.query.flags).split(',').map((f) => f.trim()).filter(Boolean).map((f) => f.startsWith('\\') ? f : `\\${f}`)
            : undefined;
        const idate = req.query?.internalDate ? new Date(req.query.internalDate) : undefined;

        return withClient(pool, req.creds, async (client) => {
            const res = await client.append(mboxPath, body, flags, idate);
            cache?.invalidateFolderUid(req.creds.hash, mboxPath);
            cache?.invalidateFolderStatus(req.creds.hash, mboxPath);
            reply.code(201);
            return {
                path: res?.path || mboxPath,
                uid: typeof res?.uid === 'number' ? res.uid : null,
                uidValidity: typeof res?.uidValidity === 'number' || typeof res?.uidValidity === 'bigint'
                    ? Number(res.uidValidity)
                    : null
            };
        });
    });

    app.get('/v1/mailboxes/:path(^.*)/messages', {
        schema: {
            tags: ['messages'],
            summary: 'List messages in a mailbox',
            querystring: listMessagesQuerySchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        page: { type: 'integer' },
                        pageSize: { type: 'integer' },
                        total: { type: 'integer' },
                        messages: { type: 'array', items: messageListItemSchema }
                    }
                },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const mboxPath = mailboxPathParam(req);
        const { page = 0, pageSize = 20, search, include } = req.query;
        const userHash = req.creds.hash;

        // `include` opts in to the two per-item extras that are expensive on
        // a Gmail-synced folder: `attachments` adds hasAttachments /
        // attachmentCount (answering it forces the whole message to be pulled
        // from Google, which doesn't ship MIME structure separately), and
        // `auth` adds the SPF/DKIM/DMARC verdicts (a second per-item
        // BODY[HEADER.FIELDS] round trip). Only a client that actually draws
        // them should pay for them, so the default fetch carries the envelope
        // and flags and nothing else.
        const includes = new Set();
        for (const token of String(include ?? '').split(',')) {
            const value = token.trim();
            if (!value) continue; // tolerate 'attachments, auth' and stray commas
            if (value !== 'attachments' && value !== 'auth') {
                throw badRequest(`Unknown include value "${value}" — expected attachments and/or auth`);
            }
            includes.add(value);
        }

        const result = await withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, true, async () => {
                const fetchQuery = {
                    uid: true,
                    flags: true,
                    envelope: true,
                    size: true,
                    internalDate: true
                };
                if (includes.has('attachments')) fetchQuery.bodyStructure = true;
                if (includes.has('auth')) {
                    fetchQuery.headers = ['authentication-results'];
                }
                let uids;

                let requireAttachment = false;
                if (search) {
                    const parsed = buildSearch(search);
                    requireAttachment = parsed.requireAttachment;
                    uids = await client.search(parsed.criteria, { uid: true });
                    uids = (uids || []).sort((a, b) => b - a);

                    // `has:attachment` can't be answered by IMAP SEARCH, so
                    // the criteria above only narrowed to multipart mail.
                    // Decide it from the MIME structure using the very same
                    // counter that renders the paperclip in the UI, so the
                    // query and the indicator can't disagree. bodyStructure
                    // alone is a light fetch — no envelope, headers or body.
                    if (requireAttachment && uids.length) {
                        const uidValidity = client.mailbox?.uidValidity || 0;
                        // Anything the list view has already rendered is
                        // known for free — bodyStructure costs ~23ms per
                        // message, which is over a minute for a 3000-mail
                        // folder, so only the remainder is fetched.
                        const known = imapCache?.getAttachmentFlags(userHash, mboxPath, uidValidity) || new Map();
                        const unknown = uids.filter((u) => !known.has(u));
                        const learned = [];
                        if (unknown.length) {
                            for await (const msg of client.fetch(unknown, { uid: true, bodyStructure: true }, { uid: true })) {
                                const has = !!(msg.bodyStructure && countAttachments(msg.bodyStructure) > 0);
                                known.set(msg.uid, has);
                                learned.push([msg.uid, has]);
                            }
                            // The attachment-flag cache is fail-soft at the
                            // module level (see src/imap-cache.js): a write
                            // that fails can never fail this list read.
                            if (learned.length && imapCache) {
                                imapCache.setAttachmentFlags(userHash, mboxPath, uidValidity, learned);
                            }
                        }
                        uids = uids.filter((u) => known.get(u) === true).sort((a, b) => b - a);
                    }
                } else {
                    const exists = client.mailbox?.exists || 0;
                    if (!exists) return { path: mboxPath, page, pageSize, total: 0, messages: [] };
                    // A page past the end is a stale pagination cursor from
                    // the client — the folder shrank under it (or it was
                    // restored from an old cache). EXISTS already answers it,
                    // while the old path paid a full SEARCH plus a lock on a
                    // 100k-message folder to render an empty page.
                    if (page * pageSize >= exists) {
                        return { path: mboxPath, page, pageSize, total: exists, messages: [] };
                    }

                    const uidValidity = client.mailbox?.uidValidity || 0;
                    const uidNext = client.mailbox?.uidNext;
                    const cached = cache?.getUids(userHash, mboxPath, uidValidity);
                    // Cheap invalidation: if the cached UID count matches EXISTS
                    // and UIDNEXT has not moved, the manifest is still valid.
                    // The count alone is not enough — an expunge plus an arrival
                    // leaves it unchanged while swapping a UID. This avoids a
                    // SEARCH call on every page load while the mailbox is quiet.
                    if (cached && cached.length === exists &&
                        (!uidNext || cache.getUidNext(userHash, mboxPath, uidValidity) === uidNext)) {
                        uids = cached;
                    } else if (cached && cached.length && cached.length < exists) {
                        // Mail arrived since the manifest was written. The
                        // manifest is newest-first, so cached[0] is the
                        // highest UID we know and everything above it is new
                        // — ask for exactly that tail (imapflow compiles the
                        // `uid` key to `UID <set>`) instead of re-running
                        // SEARCH ALL over a 100k-message folder.
                        const fresh = await client.search({ uid: `${cached[0] + 1}:*` }, { uid: true });
                        const merged = [...(fresh || []).sort((a, b) => b - a), ...cached];
                        if (merged.length === exists) {
                            uids = merged;
                            cache?.setUids(userHash, mboxPath, uidValidity, merged, uidNext);
                        } else {
                            // Expunges (or anything else that moved more than
                            // the tail) make the merge unauthoritative — only
                            // a full search is.
                            uids = await client.search({ all: true }, { uid: true });
                            uids = (uids || []).sort((a, b) => b - a);
                            cache?.setUids(userHash, mboxPath, uidValidity, uids, uidNext);
                        }
                    } else {
                        uids = await client.search({ all: true }, { uid: true });
                        uids = (uids || []).sort((a, b) => b - a);
                        cache?.setUids(userHash, mboxPath, uidValidity, uids, uidNext);
                    }
                }

                const total = uids.length;
                // Same stale-cursor short-circuit as above, but a search's
                // total is only known once the search (and any has:attachment
                // bodyStructure pass) has settled. Nothing to fetch past the
                // end, so don't open a FETCH over an empty slice.
                if (page * pageSize >= total) {
                    return { path: mboxPath, page, pageSize, total, messages: [] };
                }
                const slice = uids.slice(page * pageSize, page * pageSize + pageSize);
                const messages = [];
                if (slice.length) {
                    for await (const msg of client.fetch(slice, fetchQuery, { uid: true })) {
                        messages.push(serializeListItem(msg));
                    }
                    messages.sort((a, b) => b.uid - a.uid);
                    // Record what we just learned for free, so a later
                    // has:attachment search doesn't re-fetch these.
                    if (imapCache) {
                        const uidValidity = client.mailbox?.uidValidity || 0;
                        const flags = messages
                            .filter((m) => typeof m.hasAttachments === 'boolean')
                            .map((m) => [m.uid, m.hasAttachments]);
                        if (flags.length) {
                            imapCache.setAttachmentFlags(userHash, mboxPath, uidValidity, flags);
                        }
                    }
                }
                return { path: mboxPath, page, pageSize, total, messages };
            })
        );

        // Revalidate every time: a fresh max-age window served a deleted,
        // moved or re-flagged message back from the browser cache. The
        // server-side imap-cache already bounds the cost of a refresh.
        reply.header('cache-control', 'private, no-cache');
        return result;
    });

    app.get('/v1/mailboxes/:path(^.*)/messages/:uid', {
        schema: {
            tags: ['messages'],
            summary: 'Get a message',
            response: { 200: messageDetailSchema, 400: problemSchema, 404: problemSchema }
        }
    }, async (req, reply) => {
        const mboxPath = mailboxPathParam(req);
        const uid = parseUidParam(req);

        const result = await withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, true, async () => {
                const msg = await client.fetchOne(String(uid), {
                    uid: true,
                    flags: true,
                    envelope: true,
                    size: true,
                    internalDate: true,
                    bodyStructure: true,
                    // Pull just the auth-related header — much cheaper
                    // than a full BODY[HEADER] fetch and enough to power
                    // the padlock / skull badge on the sender chip.
                    headers: ['authentication-results']
                }, { uid: true });
                if (!msg) throw notFound('Message not found');

                const acc = { textPart: null, htmlPart: null, attachments: [] };
                walkStructure(msg.bodyStructure, msg.bodyStructure?.part || '1', acc);

                const [text, html] = await Promise.all([
                    downloadPartText(client, uid, acc.textPart, MAX_BODY_PART_BYTES),
                    downloadPartText(client, uid, acc.htmlPart, MAX_BODY_PART_BYTES)
                ]);

                let authHeaderText = '';
                if (msg.headers) {
                    // imapflow returns Buffer | string depending on version.
                    authHeaderText = Buffer.isBuffer(msg.headers)
                        ? msg.headers.toString('utf8')
                        : String(msg.headers);
                }

                return {
                    uid: msg.uid,
                    seq: msg.seq,
                    flags: msg.flags ? [...msg.flags] : [],
                    size: msg.size || 0,
                    internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
                    envelope: serializeEnvelope(msg.envelope),
                    text,
                    html,
                    attachments: acc.attachments,
                    auth: parseAuthResultsHeader(authHeaderText, { includeRaw: true })
                };
            })
        );

        reply.header('cache-control', 'private, no-cache');
        return result;
    });

    app.get('/v1/mailboxes/:path(^.*)/messages/:uid/raw', {
        schema: { tags: ['messages'], summary: 'Download raw RFC822 source' }
    }, async (req, reply) => {
        const mboxPath = mailboxPathParam(req);
        const uid = parseUidParam(req);

        return withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, true, async () => {
                const dl = await client.download(String(uid), undefined, { uid: true });
                if (!dl || !dl.content) throw notFound('Message not found');
                reply.header('content-type', 'message/rfc822');
                hardenDownload(reply);
                if (dl.meta && dl.meta.size) reply.header('content-length', dl.meta.size);
                return reply.send(dl.content);
            })
        );
    });

    app.get('/v1/mailboxes/:path(^.*)/messages/:uid/attachments/:attachmentId', {
        schema: { tags: ['messages'], summary: 'Download an attachment' }
    }, async (req, reply) => {
        const mboxPath = mailboxPathParam(req);
        const uid = parseUidParam(req);
        const attachmentId = req.params.attachmentId;

        return withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, true, async () => {
                const dl = await client.download(String(uid), attachmentId, { uid: true });
                if (!dl || !dl.content) throw notFound('Attachment not found');
                const meta = dl.meta || {};
                reply.header('content-type', meta.contentType || 'application/octet-stream');
                reply.header('content-disposition', attachmentDisposition(meta.filename));
                hardenDownload(reply);
                return reply.send(dl.content);
            })
        );
    });

    app.get('/v1/mailboxes/:path(^.*)/messages/:uid/attachments/:attachmentId/text', {
        schema: { tags: ['ocr'], summary: 'OCR an attachment via Mistral' }
    }, async (req, reply) => {
        const mboxPath = mailboxPathParam(req);
        const uid = parseUidParam(req);
        const attachmentId = req.params.attachmentId;
        const wantJson = String(req.query.format || '').toLowerCase() === 'json';

        if (!config.ocr.apiKey) {
            throw problem(501, 'OCR not configured', 'MISTRAL_API_KEY env var is not set');
        }

        // Fetch attachment, then release the IMAP connection before the (slow) OCR call.
        const fetched = await withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, true, async () => {
                const dl = await client.download(String(uid), attachmentId, { uid: true });
                if (!dl || !dl.content) throw notFound('Attachment not found');
                const meta = dl.meta || {};
                let buffer;
                try {
                    // Cap at the OCR size limit — anything larger is rejected
                    // by the OCR call anyway, so there's no reason to buffer it.
                    buffer = await streamToBuffer(dl.content, config.ocr.maxBytes);
                } catch (err) {
                    if (err.code === 'ESTREAMLIMIT') {
                        throw problem(413, 'Payload Too Large',
                            `Attachment exceeds the ${config.ocr.maxBytes}-byte OCR limit`);
                    }
                    throw err;
                }
                return { buffer, mimeType: meta.contentType, filename: meta.filename };
            })
        );

        const result = await ocrAttachment({
            buffer: fetched.buffer,
            mimeType: fetched.mimeType,
            filename: fetched.filename,
            config: config.ocr,
            logger: req.log,
            cache: ocrCache
        });

        if (!result.ok) {
            const err = problem(result.status, result.title, result.detail);
            if (result.retryAfter) reply.header('retry-after', result.retryAfter);
            throw err;
        }

        if (wantJson) {
            reply.header('content-type', 'application/json; charset=utf-8');
            return result.response;
        }
        reply.header('content-type', 'text/plain; charset=utf-8');
        return reply.send(pagesToText(result.response));
    });

    app.put('/v1/mailboxes/:path(^.*)/messages/:uid/flags', {
        schema: {
            tags: ['messages'],
            summary: 'Modify message flags',
            body: flagsOpSchema,
            response: {
                200: {
                    type: 'object',
                    properties: { uid: { type: 'integer' }, flags: { type: 'array', items: { type: 'string' } } }
                },
                400: problemSchema
            }
        }
    }, async (req) => {
        const mboxPath = mailboxPathParam(req);
        const uid = parseUidParam(req);
        const { add, remove, set } = req.body || {};
        if (!add && !remove && !set) throw badRequest('Provide add, remove, or set');

        return withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, false, async () => {
                const opts = { uid: true };
                if (set) await client.messageFlagsSet(String(uid), set, opts);
                if (add) await client.messageFlagsAdd(String(uid), add, opts);
                if (remove) await client.messageFlagsRemove(String(uid), remove, opts);
                const msg = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
                if (!msg) throw notFound('Message not found');
                cache?.invalidateFolderStatus(req.creds.hash, mboxPath);
                return { uid: msg.uid, flags: msg.flags ? [...msg.flags] : [] };
            })
        );
    });

    app.put('/v1/mailboxes/:path(^.*)/messages/:uid/move', {
        schema: {
            tags: ['messages'],
            summary: 'Move a message to another mailbox',
            body: moveOpSchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        uid: { type: 'integer' },
                        path: { type: 'string' },
                        destUid: { type: ['integer', 'null'] }
                    }
                },
                400: problemSchema
            }
        }
    }, async (req) => {
        const mboxPath = mailboxPathParam(req);
        const uid = parseUidParam(req);
        const dest = req.body.path;

        return withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, false, async () => {
                const res = await client.messageMove(String(uid), dest, { uid: true });
                let destUid = null;
                if (res && res.uidMap) {
                    const v = res.uidMap.get ? res.uidMap.get(uid) : res.uidMap[uid];
                    if (v) destUid = v;
                }
                cache?.invalidateFolderUid(req.creds.hash, mboxPath);
                cache?.invalidateFolderStatus(req.creds.hash, mboxPath);
                cache?.invalidateFolderUid(req.creds.hash, dest);
                cache?.invalidateFolderStatus(req.creds.hash, dest);
                return { uid, path: dest, destUid };
            })
        );
    });

    app.delete('/v1/mailboxes/:path(^.*)/messages/:uid', {
        schema: { tags: ['messages'], summary: 'Delete a message' }
    }, async (req, reply) => {
        const mboxPath = mailboxPathParam(req);
        const uid = parseUidParam(req);

        await withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, false, async () => {
                const ok = await client.messageDelete(String(uid), { uid: true });
                if (!ok) throw notFound('Message not found');
            })
        );
        cache?.invalidateFolderUid(req.creds.hash, mboxPath);
        cache?.invalidateFolderStatus(req.creds.hash, mboxPath);
        reply.code(204).send();
    });

    // Bulk delete for the "block this sender" flow. The one-uid DELETE above
    // is the wrong shape there: a blocked sender's mail is however many
    // messages the folder happens to hold, and having the client loop over
    // them turns one user action into N round-trips, N chances to fail
    // halfway, and — worst — a partial delete the client cannot report
    // honestly. One authorised call, one UID EXPUNGE, one result.
    //
    // `sender` is resolved server-side rather than trusting the client to
    // hand over the uids it happened to have loaded: the list is paged, so a
    // client-side match would silently leave the sender's older mail behind
    // while the confirmation said "12 deleted". Resolving it here is what
    // makes the count in the response equal the count that was expunged.
    app.delete('/v1/mailboxes/:path(^.*)/messages', {
        schema: {
            tags: ['messages'],
            summary: 'Delete messages in bulk, by uid list or by sender pattern',
            body: bulkDeleteMessagesBodySchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        matched: { type: 'integer' },
                        deleted: { type: 'integer' }
                    }
                },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const mboxPath = mailboxPathParam(req);
        const { uids, sender, dryRun } = req.body;
        const hasUids = Array.isArray(uids);
        const hasSender = typeof sender === 'string';
        if (hasUids && hasSender) {
            throw badRequest('Send either uids or sender, not both');
        }
        // Checked explicitly rather than left to the schema's minProperties,
        // because `dryRun` has a default: a body of {} comes out of
        // validation carrying { dryRun: false }, which satisfies the
        // property count and falls through to a sender search with no
        // sender. An IMAP SEARCH with an undefined FROM is not an empty
        // search — it is a malformed one, and depending on the server it can
        // match everything and hand the result to an expunge.
        if (!hasUids && !hasSender) {
            throw badRequest('Provide either uids or sender');
        }
        // An empty uid list is a legitimate no-op from the bulk-select path
        // (selection emptied between render and click), so it is allowed —
        // but only when the caller actually sent the field.
        if (hasUids && uids.length === 0) {
            reply.code(200).send({ path: mboxPath, matched: 0, deleted: 0 });
            return;
        }

        const result = await withClient(pool, req.creds, (client) =>
            // `readOnly`, so a dry run passes `dryRun` — NOT `!dryRun`.
            // Inverting this reads plausible and is catastrophic: every
            // real delete would open the mailbox read-only and the UID
            // EXPUNGE would fail against a read-only mailbox.
            withMailbox(client, mboxPath, !!dryRun, async () => {
                // One UID EXPUNGE per request either way. The uid-list form
                // is what the bulk-select path uses; the sender form is
                // what the block flow uses.
                const list = Array.isArray(uids) ? uids : await findUidsBySender(client, sender);
                // A dry run opens the mailbox READ-ONLY as well as skipping
                // the expunge. Belt and braces: `readonly` is what actually
                // makes a delete impossible here, and a future edit that
                // dropped the dryRun guard would still be stopped by the
                // server rather than by a missing if.
                if (dryRun) return { matched: list.length, deleted: 0 };
                if (!list.length) return { matched: 0, deleted: 0 };
                const ok = await client.messageDelete(list, { uid: true });
                // A false here means the server refused the range, not that
                // it matched nothing — reporting 0 deleted for a refusal
                // would read to the client as "cleaned up" on a folder that
                // still holds every one of those messages.
                if (!ok) throw problem(502, 'Delete failed', 'The server refused the expunge range');
                return { matched: list.length, deleted: list.length };
            })
        );

        if (result.deleted) {
            cache?.invalidateFolderUid(req.creds.hash, mboxPath);
            cache?.invalidateFolderStatus(req.creds.hash, mboxPath);
        }
        reply.code(200).send({ path: mboxPath, ...result });
    });
};
