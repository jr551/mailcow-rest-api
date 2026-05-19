'use strict';

const { withClient, withMailbox, serializeListItem, serializeEnvelope } = require('../imap');
const {
    messageListItemSchema,
    messageDetailSchema,
    flagsOpSchema,
    moveOpSchema,
    listMessagesQuerySchema,
    problemSchema
} = require('../schemas');
const { notFound, badRequest, problem } = require('../errors');
const config = require('../config');
const { ocrAttachment, pagesToText } = require('../ocr');

function decodeMailboxPathParam(req) {
    return decodeURIComponent(req.params['*'] || req.params.path || '');
}

// Parse one or more Authentication-Results headers into discrete
// SPF / DKIM / DMARC verdicts. Returns null when no header is present.
//
// Format reference: RFC 8601. Headers look like:
//   Authentication-Results: mx.example.org;
//       spf=pass smtp.mailfrom=foo@x.com;
//       dkim=pass header.d=x.com;
//       dmarc=pass action=none header.from=x.com
//
// Multiple headers can be present (one per receiving MTA hop). We use
// the strongest verdict found ('pass' wins over 'neutral'/'fail') so a
// hop that doesn't run the check doesn't downgrade an upstream pass.
function parseAuthResults(rawHeader) {
    if (!rawHeader) return null;
    const text = String(rawHeader);
    const findVerdict = (key) => {
        const matches = [...text.matchAll(new RegExp(`(?:^|[\\s;])${key}\\s*=\\s*([a-z]+)`, 'gi'))];
        if (matches.length === 0) return null;
        const verdicts = matches.map((m) => m[1].toLowerCase());
        // Strongest first.
        for (const v of ['pass', 'fail', 'softfail', 'neutral', 'permerror', 'temperror', 'none']) {
            if (verdicts.includes(v)) return v;
        }
        return verdicts[0];
    };
    const spf = findVerdict('spf');
    const dkim = findVerdict('dkim');
    const dmarc = findVerdict('dmarc');
    if (!spf && !dkim && !dmarc) return { spf: null, dkim: null, dmarc: null, raw: text };
    return { spf, dkim, dmarc, raw: text };
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

function buildSearchCriteria(input) {
    const { tokens, rest } = parseSearchTokens(input);
    const criteria = {};
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
                    // Some servers index $HasAttachment; treat as a hint via
                    // keyword. Fallback: callers without keyword support will
                    // get more results — false-positives are acceptable here.
                    criteria.keyword = '$HasAttachment';
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
        return { or: [{ subject: input }, { from: input }, { body: input }] };
    }
    return criteria;
}

// Walk bodyStructure nodes (recursive MIME tree) and collect text parts
// (inline text/plain, text/html) and attachments (anything else with a filename
// or content-disposition=attachment).
function walkStructure(node, path, acc) {
    if (!node) return;
    const part = path || (node.part ? node.part : '');
    const type = (node.type || '').toLowerCase();
    const disposition = (node.disposition || '').toLowerCase();
    const filename = (node.dispositionParameters && node.dispositionParameters.filename) ||
        (node.parameters && node.parameters.name) ||
        null;

    if (Array.isArray(node.childNodes) && node.childNodes.length) {
        for (const child of node.childNodes) {
            walkStructure(child, child.part, acc);
        }
        return;
    }

    let isAttachment = disposition === 'attachment' || (filename && !type.startsWith('text/'));
    // Some gateways mark the HTML body as disposition=attachment without a
    // filename. If we treat it as an attachment the message appears to have
    // no body content at all.
    if (type === 'text/html' && isAttachment && !filename) {
        isAttachment = false;
    }
    if (isAttachment) {
        acc.attachments.push({
            id: part || '1',
            filename,
            contentType: type || null,
            size: node.size || null,
            disposition: disposition || null,
            related: disposition === 'inline'
        });
        return;
    }
    if (type === 'text/plain' && !acc.textPart) acc.textPart = part || '1';
    else if (type === 'text/html' && !acc.htmlPart) acc.htmlPart = part || '1';
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function downloadPartText(client, uid, part) {
    if (!part) return null;
    const res = await client.download(uid, part, { uid: true });
    if (!res || !res.content) return null;
    const buf = await streamToBuffer(res.content);
    return buf.toString('utf8');
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
        const mboxPath = decodeMailboxPathParam(req);
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
        const mboxPath = decodeMailboxPathParam(req);
        const { page = 0, pageSize = 20, search } = req.query;
        const userHash = req.creds.hash;

        const result = await withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, true, async () => {
                // bodyStructure is requested so the list response can carry
                // hasAttachments / attachmentCount for the client's filter
                // without per-message detail fetches.
                // authentication-results lets serializeListItem surface a
                // per-row SPF/DKIM/DMARC badge without forcing the user
                // to open each message. The header fetch costs one extra
                // BODY[HEADER.FIELDS] round-trip per item but the result
                // is cached on the item itself, not re-fetched.
                const fetchQuery = {
                    uid: true,
                    flags: true,
                    envelope: true,
                    size: true,
                    internalDate: true,
                    bodyStructure: true,
                    headers: ['authentication-results', 'arc-authentication-results']
                };
                let uids;

                if (search) {
                    uids = await client.search(buildSearchCriteria(search), { uid: true });
                    uids = (uids || []).sort((a, b) => b - a);
                } else {
                    const exists = client.mailbox?.exists || 0;
                    if (!exists) return { path: mboxPath, page, pageSize, total: 0, messages: [] };

                    const uidValidity = client.mailbox?.uidValidity || 0;
                    const cached = cache?.getUids(userHash, mboxPath, uidValidity);
                    // Cheap invalidation: if the cached UID count matches EXISTS,
                    // the manifest is still valid. This avoids a SEARCH call on
                    // every page load while the mailbox is quiet.
                    if (cached && cached.length === exists) {
                        uids = cached;
                    } else {
                        uids = await client.search({ all: true }, { uid: true });
                        uids = (uids || []).sort((a, b) => b - a);
                        cache?.setUids(userHash, mboxPath, uidValidity, uids);
                    }
                }

                const total = uids.length;
                const slice = uids.slice(page * pageSize, page * pageSize + pageSize);
                const messages = [];
                if (slice.length) {
                    for await (const msg of client.fetch(slice, fetchQuery, { uid: true })) {
                        messages.push(serializeListItem(msg));
                    }
                    messages.sort((a, b) => b.uid - a.uid);
                }
                return { path: mboxPath, page, pageSize, total, messages };
            })
        );

        // Cache message lists briefly so refreshes don't hammer IMAP.
        // Search results are more volatile so we skip caching them.
        if (!search) {
            reply.header('cache-control', 'private, max-age=30');
        }
        return result;
    });

    app.get('/v1/mailboxes/:path(^.*)/messages/:uid', {
        schema: {
            tags: ['messages'],
            summary: 'Get a message',
            response: { 200: messageDetailSchema, 404: problemSchema }
        }
    }, async (req, reply) => {
        const mboxPath = decodeMailboxPathParam(req);
        const uid = Number(req.params.uid);

        const result = await withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, true, async () => {
                const msg = await client.fetchOne(String(uid), {
                    uid: true,
                    flags: true,
                    envelope: true,
                    size: true,
                    internalDate: true,
                    bodyStructure: true,
                    // Pull just the auth-related headers — much cheaper
                    // than a full BODY[HEADER] fetch and enough to power
                    // the padlock / skull badge on the sender chip.
                    headers: ['authentication-results', 'received-spf', 'arc-authentication-results']
                }, { uid: true });
                if (!msg) throw notFound('Message not found');

                const acc = { textPart: null, htmlPart: null, attachments: [] };
                walkStructure(msg.bodyStructure, msg.bodyStructure?.part || '1', acc);

                const [text, html] = await Promise.all([
                    downloadPartText(client, uid, acc.textPart),
                    downloadPartText(client, uid, acc.htmlPart)
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
                    auth: parseAuthResults(authHeaderText)
                };
            })
        );

        reply.header('cache-control', 'private, max-age=60');
        return result;
    });

    app.get('/v1/mailboxes/:path(^.*)/messages/:uid/raw', {
        schema: { tags: ['messages'], summary: 'Download raw RFC822 source' }
    }, async (req, reply) => {
        const mboxPath = decodeMailboxPathParam(req);
        const uid = Number(req.params.uid);

        return withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, true, async () => {
                const dl = await client.download(String(uid), undefined, { uid: true });
                if (!dl || !dl.content) throw notFound('Message not found');
                reply.header('content-type', 'message/rfc822');
                if (dl.meta && dl.meta.size) reply.header('content-length', dl.meta.size);
                return reply.send(dl.content);
            })
        );
    });

    app.get('/v1/mailboxes/:path(^.*)/messages/:uid/attachments/:attachmentId', {
        schema: { tags: ['messages'], summary: 'Download an attachment' }
    }, async (req, reply) => {
        const mboxPath = decodeMailboxPathParam(req);
        const uid = Number(req.params.uid);
        const attachmentId = req.params.attachmentId;

        return withClient(pool, req.creds, (client) =>
            withMailbox(client, mboxPath, true, async () => {
                const dl = await client.download(String(uid), attachmentId, { uid: true });
                if (!dl || !dl.content) throw notFound('Attachment not found');
                const meta = dl.meta || {};
                reply.header('content-type', meta.contentType || 'application/octet-stream');
                if (meta.filename) {
                    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(meta.filename)}"`);
                }
                return reply.send(dl.content);
            })
        );
    });

    app.get('/v1/mailboxes/:path(^.*)/messages/:uid/attachments/:attachmentId/text', {
        schema: { tags: ['ocr'], summary: 'OCR an attachment via Mistral' }
    }, async (req, reply) => {
        const mboxPath = decodeMailboxPathParam(req);
        const uid = Number(req.params.uid);
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
                const buffer = await streamToBuffer(dl.content);
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
                }
            }
        }
    }, async (req) => {
        const mboxPath = decodeMailboxPathParam(req);
        const uid = Number(req.params.uid);
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
                }
            }
        }
    }, async (req) => {
        const mboxPath = decodeMailboxPathParam(req);
        const uid = Number(req.params.uid);
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
        const mboxPath = decodeMailboxPathParam(req);
        const uid = Number(req.params.uid);

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
};
