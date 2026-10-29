'use strict';

const { sendMessage } = require('../smtp-client');
const { problem } = require('../errors');
const { problemSchema } = require('../schemas');
const { buildOpenNotice } = require('../tracking-enrich');

// 1x1 transparent GIF (43 bytes)
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

module.exports = async function trackingRoutes(app, { store, smtp }) {
    const smtpEnabled = !!(smtp && smtp.host);

    // SMTP AUTH is the mailbox that sent the mail, which may differ from the
    // From alias the notification is sent as and to.
    async function notifySender(req, record, ip, ua) {
        const { text, html } = await buildOpenNotice({
            subject: record.subject,
            recipient: record.recipient,
            openedAt: record.openedAt,
            ip,
            ua
        });
        await sendMessage({
            smtpConfig: smtp,
            user: record.owner,
            pass: record.senderPass,
            from: record.sender,
            to: [record.sender],
            subject: `📬 Opened: ${record.subject}`,
            text,
            html
        });
        req.log.info({ ref: record.ref, recipient: record.recipient }, 'tracking notification sent');
    }

    // Public tracking pixel — loaded when a recipient opens an HTML email.
    app.get('/v1/track/:ref.gif', {
        config: { public: true },
        schema: {
            tags: ['tracking'],
            summary: 'Email open tracking pixel',
            description: 'Returns a 1x1 transparent GIF. On first load, records the open and emails the sender.',
            params: {
                type: 'object',
                required: ['ref'],
                properties: {
                    ref: { type: 'string', format: 'uuid' }
                }
            },
            response: {
                200: { type: 'string', contentMediaType: 'image/gif' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const ref = req.params.ref;
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        const ua = req.headers['user-agent'] || '';

        const record = store.recordOpen({ ref, ip, ua });
        if (!record) {
            // Still return the pixel so the email client doesn't show a broken image.
            // Log it for debugging but don't leak whether the ref exists.
            req.log.debug({ ref }, 'tracking pixel requested for unknown ref');
            return reply.type('image/gif').send(TRANSPARENT_GIF);
        }

        // The pixel is returned straight away: the notification below does a
        // geo lookup and an SMTP login, and a mail client or image proxy that
        // times out on a slow pixel shows a broken image.
        reply.type('image/gif').send(TRANSPARENT_GIF);

        // On first open, send a notification email to the original sender
        // — enriched with country flag, ISP, browser, and device parsed
        // from IP + UA so the sender gets useful context, not just a raw
        // IP they have to look up themselves.
        if (record.wasFirstOpen) {
            const notified = smtpEnabled
                ? notifySender(req, record, ip, ua)
                    .catch((err) => req.log.warn({ err, ref }, 'tracking notification email failed'))
                : Promise.resolve();
            // The stored password has no further use once that one attempt is over.
            notified.finally(() => {
                try {
                    store.clearSenderPass(ref);
                } catch (err) {
                    req.log.warn({ err, ref }, 'could not clear stored tracking credentials');
                }
            });
        }

        return reply;
    });

    // List tracking pixels created by the authenticated user.
    app.get('/v1/tracking', {
        schema: {
            tags: ['tracking'],
            summary: 'List tracking pixels',
            description: 'Returns all open-tracking pixels created by the authenticated sender.',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    ref: { type: 'string' },
                                    recipient: { type: 'string' },
                                    subject: { type: 'string' },
                                    sentAt: { type: 'integer' },
                                    openedAt: { type: ['integer', 'null'] },
                                    openerIp: { type: ['string', 'null'] },
                                    openerUa: { type: ['string', 'null'] }
                                }
                            }
                        }
                    }
                }
            }
        }
    }, async (req) => {
        const items = store.listBySender(req.creds.user);
        return { items };
    });

    // Delete a tracking pixel.
    app.delete('/v1/tracking/:ref', {
        schema: {
            tags: ['tracking'],
            summary: 'Delete a tracking pixel',
            params: {
                type: 'object',
                required: ['ref'],
                properties: {
                    ref: { type: 'string', format: 'uuid' }
                }
            },
            response: {
                204: { type: 'null' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const removed = store.remove({ ref: req.params.ref, sender: req.creds.user });
        if (!removed) {
            throw problem(404, 'Not Found', 'Tracking pixel not found');
        }
        return reply.code(204).send();
    });
};
