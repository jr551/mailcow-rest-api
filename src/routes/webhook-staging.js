'use strict';

const { createReadStream } = require('node:fs');

// Public, signature-gated download of a staged webhook payload part
// (raw.eml, text.txt, html.html, headers.json, attachments.json, attachment
// bytes). The URL is a capability: it expires and is HMAC-signed by the
// per-account webhook secret, so it needs no mailbox credentials.
module.exports = async function webhookStagingRoutes(app, { config, stager }) {
    app.get('/v1/webhook-staging/:address/:key/:file', {
        config: { public: true, rateLimit: false },
        schema: {
            tags: ['webhooks'],
            summary: 'Download a staged webhook payload part (signed URL)'
        }
    }, async (req, reply) => {
        const address = req.params.address || '';
        const account = config.webhooks.accounts.find((a) => a.address.toLowerCase() === address.toLowerCase());
        if (!account) return reply.code(404).send({ error: 'unknown webhook account' });
        const expires = Number(req.query.expires);
        const signature = String(req.query.sig || '');
        try {
            const file = await stager.resolve(account, req.params.key, req.params.file, expires, signature);
            reply.header('cache-control', 'private, max-age=300');
            reply.header('content-length', String(file.size));
            reply.type('application/octet-stream');
            return reply.send(createReadStream(file.path));
        } catch (err) {
            const status = err.statusCode || 404;
            return reply.code(status).send({ error: err.message });
        }
    });
};
