'use strict';

const { withClient, serializeMailbox } = require('../imap');
const {
    mailboxSchema,
    createMailboxSchema,
    renameMailboxSchema,
    problemSchema
} = require('../schemas');
const { badRequest, notFound, conflict } = require('../errors');

// `.wh-<id>` is the outbound-webhook parking namespace — internal plumbing
// the forwarder polls, not the user's mail. It must not appear in their
// folder tree. Matched on the whole path because the prefix itself contains
// the hierarchy separator, so splitting on '.' would eat it.
const WEBHOOK_MAILBOX_RE = /(^|[./])\.wh-[a-z0-9]+$/;
function isWebhookMailbox(path) {
    return WEBHOOK_MAILBOX_RE.test(String(path));
}

function decodeMailboxPathParam(req) {
    return decodeURIComponent(req.params['*'] || req.params.path || '');
}

module.exports = async function mailboxRoutes(app, { pool, imapCache }) {
    const cache = imapCache; // may be undefined in legacy tests
    app.get('/v1/mailboxes', {
        schema: {
            tags: ['mailboxes'],
            summary: 'List mailboxes',
            querystring: {
                type: 'object',
                properties: {
                    counts: { type: 'boolean', default: false }
                }
            },
            response: {
                200: { type: 'array', items: mailboxSchema },
                401: problemSchema,
                502: problemSchema
            }
        }
    }, async (req) => {
        const includeCounts = req.query?.counts === true || req.query?.counts === 'true';
        const userHash = req.creds.hash;

        return withClient(pool, req.creds, async (client) => {
            let out = cache?.getTree(userHash);
            if (!out) {
                const list = await client.list();
                out = list.map(serializeMailbox);
                cache?.setTree(userHash, out);
            }

            // `.wh-*` is the outbound-webhook namespace — internal plumbing
            // the forwarder polls. It is not the user's mail and has no
            // business in their folder tree.
            out = out.filter((mb) => !isWebhookMailbox(mb.path));

            if (!includeCounts) return out;

            // STATUS gives MESSAGES + UNSEEN per mailbox without entering it.
            // Use cached status when available; otherwise batch STATUS calls.
            const limit = 6;
            for (let i = 0; i < out.length; i += limit) {
                const slice = out.slice(i, i + limit);
                await Promise.all(slice.map(async (mb) => {
                    const cached = cache?.getStatus(userHash, mb.path);
                    if (cached) {
                        mb.totalMessages = typeof cached.messages === 'number' ? cached.messages : null;
                        mb.unseen = typeof cached.unseen === 'number' ? cached.unseen : null;
                        return;
                    }
                    try {
                        const s = await client.status(mb.path, { messages: true, unseen: true });
                        cache?.setStatus(userHash, mb.path, s);
                        mb.totalMessages = typeof s.messages === 'number' ? s.messages : null;
                        mb.unseen = typeof s.unseen === 'number' ? s.unseen : null;
                    } catch {
                        mb.totalMessages = null;
                        mb.unseen = null;
                    }
                }));
            }
            return out;
        });
    });

    app.post('/v1/mailboxes', {
        schema: {
            tags: ['mailboxes'],
            summary: 'Create a mailbox',
            body: createMailboxSchema,
            response: { 201: mailboxSchema, 400: problemSchema, 409: problemSchema }
        }
    }, async (req, reply) => {
        const { path } = req.body;
        return withClient(pool, req.creds, async (client) => {
            const res = await client.mailboxCreate(path);
            if (res && res.created === false) throw conflict('Mailbox already exists');
            cache?.invalidateTree(req.creds.hash);
            reply.code(201);
            return {
                path: res.path,
                name: res.path.split(res.delimiter || '/').pop(),
                delimiter: res.delimiter || '/',
                flags: [],
                specialUse: null,
                subscribed: false
            };
        });
    });

    app.put('/v1/mailboxes/:path(^.*)', {
        schema: {
            tags: ['mailboxes'],
            summary: 'Rename a mailbox',
            body: renameMailboxSchema,
            response: { 200: mailboxSchema, 404: problemSchema, 409: problemSchema }
        }
    }, async (req) => {
        const from = decodeMailboxPathParam(req);
        const { newPath } = req.body;
        return withClient(pool, req.creds, async (client) => {
            const res = await client.mailboxRename(from, newPath);
            const userHash = req.creds.hash;
            cache?.invalidateTree(userHash);
            cache?.invalidateFolder(userHash, from);
            cache?.invalidateFolder(userHash, newPath);
            return {
                path: res.newPath || newPath,
                name: (res.newPath || newPath).split(res.delimiter || '/').pop(),
                delimiter: res.delimiter || '/',
                flags: [],
                specialUse: null,
                subscribed: false
            };
        });
    });

    app.delete('/v1/mailboxes/:path(^.*)', {
        schema: {
            tags: ['mailboxes'],
            summary: 'Delete a mailbox',
            response: { 204: { type: 'null' }, 404: problemSchema }
        }
    }, async (req, reply) => {
        const path = decodeMailboxPathParam(req);
        if (path.toUpperCase() === 'INBOX') throw badRequest('Cannot delete INBOX');
        await withClient(pool, req.creds, async (client) => {
            await client.mailboxDelete(path);
        });
        const userHash = req.creds.hash;
        cache?.invalidateTree(userHash);
        cache?.invalidateFolder(userHash, path);
        reply.code(204).send();
    });
};
