'use strict';

const crypto = require('node:crypto');

const config = require('../config');
const pkg = require('../../package.json');
const { parseAllowlist, isAllowed } = require('../ip-allow');
const { unauthorized, forbidden } = require('../errors');

// Compare two secrets without leaking their length or a byte-position prefix
// through timing. Hashing first makes both inputs fixed-width, so
// timingSafeEqual never throws on a length mismatch.
function secretEquals(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function parseBearer(headerValue) {
    if (!headerValue || typeof headerValue !== 'string') return null;
    const [scheme, token] = headerValue.split(/\s+/);
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
    return token;
}

const settingsResponse = {
    type: 'object',
    properties: {
        webmail: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                // Why `enabled` has the value it does: 'db' (an admin set it),
                // 'default' (nothing stored), or 'env-forced-off'.
                source: { type: 'string' }
            }
        }
    }
};

module.exports = async function adminRoutes(app, { adminSettings, appPasswordStore } = {}) {
    // No token configured means no admin surface at all.
    if (!config.admin.token) {
        app.log.info('admin API disabled — set ADMIN_TOKEN to enable /v1/admin/*');
        return;
    }

    const ipRules = parseAllowlist(config.admin.ipAllowlist);
    const ipRestricted = ipRules.v4.length > 0 || ipRules.v6.length > 0;

    // Routes are public: true so the IMAP auth hook skips them — they carry
    // their own operator authentication, which is not a mailbox login.
    app.addHook('onRequest', async (req, reply) => {
        if (!req.url.startsWith('/v1/admin/')) return;
        if (ipRestricted && !isAllowed(req.ip, ipRules)) {
            req.log.warn({ ip: req.ip }, 'admin request from non-allowlisted IP');
            throw forbidden('Source IP not on admin allowlist');
        }
        const token = parseBearer(req.headers.authorization);
        if (!token || !secretEquals(token, config.admin.token)) {
            reply.header('WWW-Authenticate', 'Bearer realm="imap-rest-admin"');
            throw unauthorized('Invalid admin token');
        }
    });

    app.get('/v1/admin/settings', {
        config: { public: true },
        schema: {
            tags: ['admin'],
            summary: 'Read runtime operator settings',
            security: [{ adminToken: [] }],
            response: { 200: settingsResponse }
        }
    }, async () => ({
        webmail: {
            enabled: adminSettings.getWebmailEnabled(),
            source: adminSettings.webmailSource()
        }
    }));

    app.put('/v1/admin/settings', {
        config: { public: true },
        schema: {
            tags: ['admin'],
            summary: 'Update runtime operator settings',
            description:
                'Toggling webmail.enabled takes effect immediately, without a restart. ' +
                'When the server was started with WEBMAIL_ENABLED=false the environment ' +
                'wins and the webmail stays off; the response `source` says so.',
            security: [{ adminToken: [] }],
            body: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    webmail: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['enabled'],
                        properties: { enabled: { type: 'boolean' } }
                    }
                }
            },
            response: { 200: settingsResponse }
        }
    }, async (req) => {
        if (req.body && req.body.webmail) {
            adminSettings.setWebmailEnabled(req.body.webmail.enabled);
            req.log.info({ enabled: req.body.webmail.enabled }, 'admin set webmail.enabled');
        }
        return {
            webmail: {
                enabled: adminSettings.getWebmailEnabled(),
                source: adminSettings.webmailSource()
            }
        };
    });

    app.get('/v1/admin/status', {
        config: { public: true },
        schema: {
            tags: ['admin'],
            summary: 'Operator status: version, uptime, on-disk state',
            security: [{ adminToken: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        version: { type: 'string' },
                        uptimeSec: { type: 'number' },
                        webmail: settingsResponse.properties.webmail,
                        appPasswords: {
                            type: 'object',
                            properties: {
                                enabled: { type: 'boolean' },
                                total: { type: 'integer' }
                            }
                        }
                    }
                }
            }
        }
    }, async () => ({
        version: pkg.version,
        uptimeSec: Math.round(process.uptime()),
        webmail: {
            enabled: adminSettings.getWebmailEnabled(),
            source: adminSettings.webmailSource()
        },
        appPasswords: {
            enabled: !!appPasswordStore,
            total: appPasswordStore ? appPasswordStore.countAll() : 0
        }
    }));
};
