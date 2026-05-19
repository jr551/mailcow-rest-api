'use strict';

const { sendMessage } = require('../smtp-client');
const { withClient, withMailbox } = require('../imap');
const { badRequest, problem } = require('../errors');
const { createPendingSendStore } = require('../pending-send-store');
const { hashCreds } = require('../cache');

const sendBodySchema = {
    type: 'object',
    required: ['to', 'subject'],
    properties: {
        to: { type: 'array', items: { type: 'string', format: 'email' }, minItems: 1, maxItems: 50 },
        cc: { type: 'array', items: { type: 'string', format: 'email' }, maxItems: 50 },
        bcc: { type: 'array', items: { type: 'string', format: 'email' }, maxItems: 50 },
        from: { type: 'string', format: 'email' },
        // Optional display name combined into the From header as
        // "Name" <email>. Trimmed + sanitized server-side; clients pass
        // the bare name (e.g. "John Rowe").
        fromName: { type: 'string', maxLength: 200 },
        subject: { type: 'string', minLength: 1, maxLength: 998 },
        text: { type: 'string', maxLength: 200_000 },
        html: { type: 'string', maxLength: 400_000 },
        inReplyTo: { type: 'string', maxLength: 998 },
        trackOpens: { type: 'boolean' },
        attachments: {
            type: 'array',
            maxItems: 20,
            items: {
                type: 'object',
                required: ['filename', 'content'],
                properties: {
                    filename: { type: 'string', minLength: 1, maxLength: 255 },
                    contentType: { type: 'string', maxLength: 128 },
                    content: { type: 'string', maxLength: 25_000_000 } // ~18.6 MB base64
                },
                additionalProperties: false
            }
        }
    },
    additionalProperties: false
};

const problemSchema = {
    type: 'object',
    properties: {
        type: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'integer' },
        detail: { type: 'string' }
    }
};

// Parse a message/delivery-status body part and extract Action + Status + Diagnostic-Code.
function parseDeliveryStatus(text) {
    const action = (text.match(/^Action:\s*(.+)$/im) || [])[1]?.trim() || null;
    const status = (text.match(/^Status:\s*(.+)$/im) || [])[1]?.trim() || null;
    const diagnostic = (text.match(/^Diagnostic-Code:\s*(.+)$/im) || [])[1]?.trim() || null;
    return { action, status, diagnostic };
}

// Check INBOX for a DSN (bounce/delivery report) referencing the original Message-ID.
async function checkDeliveryStatus(pool, creds, messageId) {
    return withClient(pool, creds, async (client) => {
        return withMailbox(client, 'INBOX', true, async () => {
            // Fast path: search by In-Reply-To header if the server supports it.
            let uids = [];
            try {
                uids = await client.search({ header: ['In-Reply-To', `<${messageId}>`] });
            } catch {
                // Fallback: broader search then filter manually.
                uids = await client.search({ from: 'MAILER-DAEMON' });
            }
            if (!uids || !uids.length) return { status: 'pending' };

            for (const uid of uids) {
                const info = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
                if (!info) continue;

                const env = info.envelope || {};
                const irt = env.inReplyTo || '';
                const refs = env.references || '';
                if (!irt.includes(messageId) && !refs.includes(messageId)) continue;

                // Walk bodyStructure looking for message/delivery-status part.
                const dsPart = findDeliveryStatusPart(info.bodyStructure);
                if (!dsPart) continue;

                const download = await client.download(uid, dsPart, { uid: true });
                if (!download || !download.content) continue;
                const chunks = [];
                for await (const chunk of download.content) chunks.push(chunk);
                const text = Buffer.concat(chunks).toString('utf8');
                const parsed = parseDeliveryStatus(text);
                if (!parsed.action) continue;

                const action = parsed.action.toLowerCase();
                if (action === 'failed') {
                    return {
                        status: 'failed',
                        details: parsed.diagnostic || parsed.status || 'Delivery failed'
                    };
                }
                if (action === 'delivered') {
                    return { status: 'delivered', details: parsed.status || 'Delivered' };
                }
                if (action === 'delayed') {
                    return { status: 'delayed', details: parsed.diagnostic || parsed.status || 'Delivery delayed' };
                }
            }

            return { status: 'pending' };
        });
    });
}

function findDeliveryStatusPart(node) {
    if (!node) return null;
    const type = (node.type || '').toLowerCase();
    if (type === 'message/delivery-status') return node.part || '1';
    if (Array.isArray(node.childNodes)) {
        for (const child of node.childNodes) {
            const found = findDeliveryStatusPart(child);
            if (found) return found;
        }
    }
    return null;
}

function appendTrackingPixel(html, text, pixelUrl) {
    const imgTag = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;">`;
    if (html) {
        if (html.includes('</body>')) {
            return html.replace(/<\/body>/i, `${imgTag}</body>`);
        }
        return html + imgTag;
    }
    if (text) {
        const escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        return `<p>${escaped}</p>${imgTag}`;
    }
    return imgTag;
}

function isBasicAuth(req) {
    const auth = req.headers.authorization || '';
    return auth.startsWith('Basic ');
}

function buildApprovalEmail({ from, to, subject, approveUrl, denyUrl }) {
    const toList = Array.isArray(to) ? to.join(', ') : to;
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Approve Email</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:24px auto;padding:0 16px;">
  <h2>Approve sending this email?</h2>
  <p><strong>From:</strong> ${from}</p>
  <p><strong>To:</strong> ${toList}</p>
  <p><strong>Subject:</strong> ${subject}</p>
  <div style="margin:24px 0;">
    <a href="${approveUrl}" style="display:inline-block;padding:12px 24px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">✅ Approve & Send</a>
    <a href="${denyUrl}" style="display:inline-block;padding:12px 24px;background:#ef4444;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;margin-left:12px;">❌ Deny</a>
  </div>
  <p style="color:#666;font-size:13px;">This request was made via the MCP/API. If you didn't request this, click Deny.</p>
</body>
</html>`;
    const text = `Approve sending this email?

From: ${from}
To: ${toList}
Subject: ${subject}

Approve: ${approveUrl}
Deny: ${denyUrl}

This request was made via the MCP/API.`;
    return { html, text };
}

module.exports = async function sendRoutes(app, { db, smtp, pool, trackingStore, getPublicBaseUrl, imapCache }) {
    const smtpEnabled = !!(smtp && smtp.host);
    const pendingStore = createPendingSendStore();

    app.addHook('onClose', async () => {
        pendingStore.close();
    });

    app.post('/v1/messages/send', {
        schema: {
            tags: ['messages'],
            summary: 'Send an email via SMTP',
            body: sendBodySchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        sent: { type: 'boolean' },
                        messageId: { type: 'string' },
                        pendingApproval: { type: 'boolean' },
                        token: { type: 'string' },
                        message: { type: 'string' }
                    }
                },
                400: problemSchema,
                403: problemSchema,
                502: problemSchema,
                501: problemSchema
            }
        }
    }, async (req) => {
        if (!smtpEnabled) {
            throw problem(501, 'Not Implemented', 'SMTP is not configured. Set SMTP_HOST to enable sending.');
        }

        const user = req.creds.user;
        const pass = req.creds.pass;
        if (!pass) {
            throw problem(401, 'Unauthorized', 'Sending email requires Basic Auth. Bearer tokens cannot be used because the plaintext password is needed to authenticate with the SMTP server.');
        }

        const body = req.body;
        let from = body.from || user;

        // Optional display name → "Sanitized Name" <email@domain> per
        // RFC 5322. Strip CR/LF/quotes/angle-brackets so callers can't
        // smuggle extra headers via a crafted `fromName` value.
        function applyFromName(addr, name) {
            const clean = String(name || '').replace(/[\r\n"<>]/g, '').trim().slice(0, 200);
            return clean ? `"${clean}" <${addr}>` : addr;
        }

        // Validate from address ownership.
        // Acceptable when the address is in the explicit allow-list OR
        // (new) when it falls under a wildcard/catch-all the user holds.
        if (db) {
            const result = await db.getSendFromAddresses(user);
            const allowed = Array.isArray(result) ? result : (result.addresses || []);
            const wildcards = Array.isArray(result) ? [] : (result.wildcardDomains || []);
            const fromDomain = String(from).split('@')[1]?.toLowerCase() || '';
            const wildcardOk = !!fromDomain && wildcards.includes(fromDomain);
            if (!allowed.includes(from) && !wildcardOk) {
                throw problem(403, 'Forbidden', `You are not allowed to send from ${from}. Allowed addresses: ${allowed.join(', ')}${wildcards.length ? ` (or any address @${wildcards.join(', @')})` : ''}`);
            }
        } else if (from !== user) {
            throw problem(403, 'Forbidden', `You are not allowed to send from ${from}`);
        }

        // If the request comes from Basic Auth (MCP / API client), require approval.
        if (isBasicAuth(req)) {
            const token = pendingStore.create({
                user,
                pass,
                from,
                to: body.to,
                cc: body.cc,
                bcc: body.bcc,
                subject: body.subject,
                text: body.text,
                html: body.html,
                inReplyTo: body.inReplyTo,
                attachments: body.attachments,
                trackOpens: body.trackOpens
            });

            const baseUrl = getPublicBaseUrl ? getPublicBaseUrl(req) : '';
            const approveUrl = `${baseUrl}/v1/messages/approve/${token}`;
            const denyUrl = `${baseUrl}/v1/messages/deny/${token}`;

            const { html: approvalHtml, text: approvalText } = buildApprovalEmail({
                from,
                to: body.to,
                subject: body.subject,
                approveUrl,
                denyUrl
            });

            try {
                await sendMessage({
                    smtpConfig: smtp,
                    user,
                    pass,
                    from,
                    to: [user],
                    subject: `Approve sending: ${body.subject}`,
                    text: approvalText,
                    html: approvalHtml
                });
            } catch (err) {
                req.log.warn({ err }, 'Failed to send approval email');
                // Don't fail the whole request because the approval email bounced.
            }

            return {
                pendingApproval: true,
                token,
                message: 'An approval email has been sent to your inbox. Click the link to send this message.'
            };
        }

        let html = body.html;
        if (body.trackOpens) {
            if (!trackingStore) {
                throw problem(501, 'Not Implemented', 'Tracking store is not configured.');
            }
            const baseUrl = getPublicBaseUrl ? getPublicBaseUrl(req) : '';
            if (!baseUrl) {
                throw problem(400, 'Bad Request', 'Cannot determine public base URL for tracking pixel. Ensure the request includes Host or X-Forwarded-Host headers.');
            }
            const ref = trackingStore.create({
                sender: from,
                senderPass: pass,
                recipient: body.to[0] || '',
                subject: body.subject
            });
            const pixelUrl = `${baseUrl}/v1/track/${ref}.gif`;
            html = appendTrackingPixel(body.html, body.text, pixelUrl);
        }

        try {
            const result = await sendMessage({
                smtpConfig: smtp,
                user,
                pass,
                from: applyFromName(from, body.fromName),
                to: body.to,
                cc: body.cc,
                bcc: body.bcc,
                subject: body.subject,
                text: body.text,
                html,
                inReplyTo: body.inReplyTo,
                attachments: body.attachments
            });
            await appendToSent(req.creds, result.raw);
            return { sent: result.sent, messageId: result.messageId };
        } catch (err) {
            req.log.warn({ err }, 'SMTP send failed');
            const detail = err && err.response ? `${err.response} (${err.message})` : err.message;
            throw problem(502, 'Bad Gateway', `SMTP error: ${detail}`);
        }
    });

    async function appendToSent(creds, raw) {
        if (!pool || !raw) return;
        const hash = creds.hash || hashCreds(creds.user, creds.pass);
        const fullCreds = { ...creds, hash };

        const folders = ['Sent', 'INBOX.Sent', 'Sent Items', 'Sent Messages'];
        for (const folder of folders) {
            try {
                await withClient(pool, fullCreds, async (client) => {
                    await client.append(folder, raw, ['\\Seen']);
                });
                // Invalidate cache so the next listMessages sees the new message.
                imapCache?.invalidateFolderUid(hash, folder);
                imapCache?.invalidateFolderStatus(hash, folder);
                return;
            } catch (err) {
                const isMailboxNotFound = err?.problem?.status === 404 || /not found|nonexistent|does not exist/i.test(err?.message || '');
                if (!isMailboxNotFound) {
                    // Log real errors (quota, auth, connection) but don't fail the SMTP send.
                    app.log.warn({ err, folder, user: creds.user }, 'Failed to append sent message to Sent folder');
                }
                // If this was the last folder, we've exhausted fallbacks — still don't fail the request.
                if (folder === folders[folders.length - 1]) {
                    app.log.warn({ user: creds.user }, 'Could not append sent message to any Sent folder');
                }
            }
        }
    }

    async function resolvePendingAndSend(token, req) {
        const entry = pendingStore.get(token);
        if (!entry) {
            throw problem(404, 'Not Found', 'Approval request not found or expired.');
        }

        let html = entry.html;
        if (entry.trackOpens && trackingStore) {
            const baseUrl = getPublicBaseUrl ? getPublicBaseUrl(req) : '';
            if (baseUrl) {
                const ref = trackingStore.create({
                    sender: entry.from,
                    senderPass: entry.pass,
                    recipient: entry.to[0] || '',
                    subject: entry.subject
                });
                const pixelUrl = `${baseUrl}/v1/track/${ref}.gif`;
                html = appendTrackingPixel(entry.html, entry.text, pixelUrl);
            }
        }

        const result = await sendMessage({
            smtpConfig: smtp,
            user: entry.user,
            pass: entry.pass,
            from: entry.from,
            to: entry.to,
            cc: entry.cc,
            bcc: entry.bcc,
            subject: entry.subject,
            text: entry.text,
            html,
            inReplyTo: entry.inReplyTo,
            attachments: entry.attachments
        });

        await appendToSent({ user: entry.user, pass: entry.pass }, result.raw);
        pendingStore.remove(token);
        return { sent: result.sent, messageId: result.messageId };
    }

    app.get('/v1/messages/approve/:token', {
        config: { public: true },
        schema: {
            tags: ['messages'],
            summary: 'Approve and send a pending email',
            response: {
                200: { type: 'object', properties: { sent: { type: 'boolean' }, messageId: { type: 'string' } } },
                404: problemSchema,
                502: problemSchema
            }
        }
    }, async (req, reply) => {
        try {
            const result = await resolvePendingAndSend(req.params.token, req);
            reply.type('text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sent</title>
<style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px;text-align:center}
.success{color:#10b981;font-size:48px;margin-bottom:16px}
h1{margin:0 0 8px}
p{color:#666}</style></head>
<body>
<div class="success">✅</div>
<h1>Email sent</h1>
<p>Message ID: <code>${result.messageId}</code></p>
</body></html>`);
        } catch (err) {
            if (err.problem && err.problem.status === 404) {
                reply.code(404).type('text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Expired</title>
<style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px;text-align:center}
.error{color:#ef4444;font-size:48px;margin-bottom:16px}
h1{margin:0 0 8px}
p{color:#666}</style></head>
<body>
<div class="error">❌</div>
<h1>Approval expired</h1>
<p>This approval link is no longer valid.</p>
</body></html>`);
            } else {
                req.log.warn({ err }, 'Approval send failed');
                const detail = err && err.response ? `${err.response} (${err.message})` : err.message;
                reply.code(502).type('text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Error</title>
<style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px;text-align:center}
.error{color:#ef4444;font-size:48px;margin-bottom:16px}
h1{margin:0 0 8px}
p{color:#666}</style></head>
<body>
<div class="error">⚠️</div>
<h1>Failed to send</h1>
<p>${detail}</p>
</body></html>`);
            }
        }
    });

    app.get('/v1/messages/deny/:token', {
        config: { public: true },
        schema: {
            tags: ['messages'],
            summary: 'Deny a pending email send',
            response: {
                200: { type: 'object', properties: { denied: { type: 'boolean' } } },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const removed = pendingStore.remove(req.params.token);
        if (!removed) {
            reply.code(404).type('text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Expired</title>
<style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px;text-align:center}
.error{color:#ef4444;font-size:48px;margin-bottom:16px}
h1{margin:0 0 8px}
p{color:#666}</style></head>
<body>
<div class="error">❌</div>
<h1>Already handled</h1>
<p>This approval link is no longer valid.</p>
</body></html>`);
            return;
        }
        reply.type('text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Denied</title>
<style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px;text-align:center}
.denied{color:#ef4444;font-size:48px;margin-bottom:16px}
h1{margin:0 0 8px}
p{color:#666}</style></head>
<body>
<div class="denied">🚫</div>
<h1>Send denied</h1>
<p>The email was not sent.</p>
</body></html>`);
    });

    app.get('/v1/messages/send/:messageId/status', {
        schema: {
            tags: ['messages'],
            summary: 'Check delivery status of a sent email',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        messageId: { type: 'string' },
                        status: { type: 'string', enum: ['pending', 'delivered', 'failed', 'delayed'] },
                        details: { type: ['string', 'null'] }
                    }
                },
                404: problemSchema
            }
        }
    }, async (req) => {
        if (!pool) {
            throw problem(501, 'Not Implemented', 'IMAP pool not available for delivery status checks.');
        }
        const messageId = decodeURIComponent(req.params.messageId);
        const result = await checkDeliveryStatus(pool, req.creds, messageId);
        return { messageId, ...result };
    });
};
