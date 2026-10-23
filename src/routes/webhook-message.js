'use strict';

const { createReadStream } = require('node:fs');

// Public, unguessable one-link download for the complete RFC822 message.
// The GUID is 256 bits of randomness; the link expires after one hour.
// No mailbox credentials or signature are needed because the GUID is the
// capability and it is not derivable from the message or mailbox.
module.exports = async function webhookMessageRoutes(app, { config, stager }) {
    app.get('/v1/webhook-message/:guid', {
        config: { public: true, rateLimit: false },
        schema: {
            tags: ['webhooks'],
            summary: 'Download the complete RFC822 message via its one-time link'
        }
    }, async (req, reply) => {
        try {
            const file = await stager.resolveMessage(req.params.guid);
            reply.header('cache-control', 'private, no-store');
            reply.header('content-length', String(file.size));
            reply.header('content-disposition', 'attachment; filename="message.eml"');
            reply.type('message/rfc822');
            return reply.send(createReadStream(file.path));
        } catch (err) {
            return reply.code(err.statusCode || 404).send({ error: err.message });
        }
    });
};
