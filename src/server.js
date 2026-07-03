'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const fastifyStatic = require('@fastify/static');

const config = require('./config');
const { createCache } = require('./cache');
const { createOcrCache } = require('./ocr-cache');
const { createImapCache } = require('./imap-cache');
const { createPool } = require('./pool');
const { createAuthHook } = require('./auth');
const { createIpAllowHook } = require('./ip-allow');
const { createPushStore } = require('./push-store');
const { createPushSender } = require('./push-sender');
const { createTrackingStore } = require('./tracking-store');
const { createImageProxyCache } = require('./image-proxy-cache');
const { createCalendarSubStore } = require('./calendar-sub-store');
const mailboxRoutes = require('./routes/mailboxes');
const messageRoutes = require('./routes/messages');
const sessionRoutes = require('./routes/session');
const aiRoutes = require('./routes/ai');
const sendRoutes = require('./routes/send');
const pushRoutes = require('./routes/push');
const senderPolicyRoutes = require('./routes/sender-policy');
const mailboxInfoRoutes = require('./routes/mailbox-info');
const shortcutsRoutes = require('./routes/shortcuts');
// v0.3.2 mail-rules.js supersedes recipient-policy.js: it serves the legacy
// /v1/me/blocked-recipients endpoints AND the new /v1/me/mail-rules ones
// from a single Sieve script per user.
const mailRulesRoutes = require('./routes/mail-rules');
const calendarRoutes = require('./routes/calendar');
const calendarSubRoutes = require('./routes/calendar-subscriptions');
const driveRoutes = require('./routes/drive');
const appRoutes = require('./routes/app');
const iconProxyRoutes = require('./routes/icon-proxy');
const trackingRoutes = require('./routes/tracking');
const imageProxyRoutes = require('./routes/image-proxy');
const telemetryRoutes = require('./routes/telemetry');
const { createMailcowDb } = require('./mailcow-db');
const { createSieveManager } = require('./sieve-manager');
const pkg = require('../package.json');

const MCP_SETUP_DESCRIPTION = [
    '### Use as an MCP server',
    '',
    'This API is also exposed as a [Model Context Protocol](https://modelcontextprotocol.io)',
    'server for LLM tool use.',
    '',
    'The easiest way to run the MCP server is via `npx` (no install required).',
    '',
    '```json',
    '{',
    '  "mcpServers": {',
    '    "mailcow-rest-api": {',
    '      "command": "npx",',
    '      "args": ["--yes", "--package", "mailcow-rest-api", "imap-rest-mcp"],',
    '      "env": {',
    '        "IMAP_REST_BASE_URL": "<this server\'s base URL>",',
    '        "IMAP_REST_USER": "user@example.com",',
    '        "IMAP_REST_PASS": "your-mailcow-password"',
    '      }',
    '    }',
    '  }',
    '}',
    '```',
    '',
    'If you already have the repo cloned locally, you can also point directly',
    'at the binary:',
    '',
    '```json',
    '{',
    '  "mcpServers": {',
    '    "mailcow-rest-api": {',
    '      "command": "node",',
    '      "args": ["/opt/mailcow-rest-api/bin/imap-rest-mcp"],',
    '      "env": {',
    '        "IMAP_REST_BASE_URL": "<this server\'s base URL>",',
    '        "IMAP_REST_USER": "user@example.com",',
    '        "IMAP_REST_PASS": "your-mailcow-password"',
    '      }',
    '    }',
    '  }',
    '}',
    '```',
    '',
    'Kimi CLI example:',
    '',
    '```bash',
    'kimi mcp add --transport stdio \\',
    '  -e IMAP_REST_BASE_URL=<this server\'s base URL> \\',
    '  -e IMAP_REST_USER=user@example.com \\',
    '  -e IMAP_REST_PASS=your-mailcow-password \\',
    '  mailcow-rest-api -- \\',
    '  npx --yes --package mailcow-rest-api imap-rest-mcp',
    '```',
    '',
    'Click **Authorize** below to enter your mailcow credentials, then',
    'expand any operation and click **Try it out**.'
].join('\n');

function loadTls() {
    if (!config.tls.cert || !config.tls.key) return null;
    return { cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) };
}

// Rewrite mailbox routes where literal '/' in the path was not encoded as '%2F'.
// Some clients/proxies decode %2F back to /, causing Fastify's :path(^.*) regex
// to fail because find-my-way treats / as a segment separator. We re-encode
// literal slashes in the mailbox path portion so the route matches correctly.
function rewriteMailboxUrl(url) {
    if (!url.startsWith('/v1/mailboxes/')) return url;

    const qIndex = url.indexOf('?');
    const pathPart = qIndex !== -1 ? url.slice(0, qIndex) : url;
    const queryPart = qIndex !== -1 ? url.slice(qIndex) : '';

    const rest = pathPart.slice('/v1/mailboxes/'.length);
    if (!rest) return url;

    const msgIndex = rest.indexOf('/messages');
    if (msgIndex !== -1) {
        const mboxPath = rest.slice(0, msgIndex);
        const suffix = rest.slice(msgIndex);
        if (!mboxPath.includes('/')) return url;
        return '/v1/mailboxes/' + mboxPath.replace(/\//g, '%2F') + suffix + queryPart;
    }

    // PUT (rename) and DELETE mailbox routes have no /messages suffix;
    // the entire remainder is the mailbox path.
    if (rest.includes('/')) {
        return '/v1/mailboxes/' + rest.replace(/\//g, '%2F') + queryPart;
    }

    return url;
}

function createServer(handler, opts) {
    const http = require('http');
    const https = require('https');

    const wrappedHandler = (req, res) => {
        if (req.url) {
            const rewritten = rewriteMailboxUrl(req.url);
            if (rewritten !== req.url) {
                req.url = rewritten;
            }
        }
        handler(req, res);
    };

    if (opts && opts.https) {
        return https.createServer(opts.https, wrappedHandler);
    }
    return http.createServer(wrappedHandler);
}

function getPublicBaseUrl(req) {
    const proto = req.headers['x-forwarded-proto'] || (req.protocol || 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const prefix = req.headers['x-forwarded-prefix'] || '';
    if (!host) return prefix || '';
    return `${proto}://${host}${prefix}`;
}

function createLogger() {
    return {
        level: config.logLevel,
        name: 'imap-rest',
        serializers: {
            req(req) {
                // Use req.ip (X-Forwarded-For when trustProxy is on) instead of
                // the raw socket address, so logs show real client IPs behind
                // nginx / Docker rather than the proxy's internal IP.
                return {
                    id: req.id,
                    method: req.method,
                    url: req.url,
                    version: req.httpVersion,
                    remoteAddress: req.ip || req.socket?.remoteAddress,
                    remotePort: req.socket?.remotePort,
                    headers: req.headers
                };
            }
        }
    };
}

async function build({ cache, ocrCache, imapCache, pool, pushStore, logger, imap } = {}) {
    const app = Fastify({
        serverFactory: createServer,
        logger: logger ?? createLogger(),
        https: loadTls(),
        disableRequestLogging: false,
        bodyLimit: 2 * 1024 * 1024,
        trustProxy: config.security.trustProxy
    });

    await app.register(sensible);

    if (config.rateLimit.enabled) {
        await app.register(require('@fastify/rate-limit'), {
            max: config.rateLimit.max,
            timeWindow: config.rateLimit.windowMs,
            allowList: ['127.0.0.1', '::1']
        });
    }

    // IP allowlist runs before auth so blocked IPs never trigger an IMAP LOGIN.
    app.addHook('onRequest', createIpAllowHook({ allowlist: config.security.ipAllowlist }));

    const imapCfg = imap ?? config.imap;

    cache = cache ?? createCache({
        filePath: config.cache.path,
        ttlValidMs: config.cache.ttlValidMs,
        ttlInvalidMs: config.cache.ttlInvalidMs,
        pruneIntervalMs: config.cache.pruneIntervalMs,
        maxLifetimeMs: config.session.maxLifetimeMs
    });

    if (ocrCache === undefined && config.ocr.cacheEnabled) {
        ocrCache = createOcrCache({
            filePath: config.ocr.cachePath,
            maxEntries: config.ocr.cacheMaxEntries
        });
    }

    pushStore = pushStore ?? createPushStore({ filePath: config.push.dbPath });

    const trackingStore = createTrackingStore({
        filePath: config.tracking.dbPath,
        pruneIntervalMs: config.tracking.pruneIntervalMs
    });

    const imageProxyCache = createImageProxyCache({
        filePath: config.imageProxy.cachePath,
        maxBytes: config.imageProxy.maxBytes
    });

    imapCache = imapCache ?? createImapCache({
        filePath: './data/imap-cache.db',
        ttlMs: config.cache.ttlValidMs,
        pruneIntervalMs: config.cache.pruneIntervalMs
    });

    pool = pool ?? createPool({
        imap: imapCfg,
        max: config.pool.max,
        idleMs: config.pool.idleMs,
        logger: app.log
    });

    const pushSender = createPushSender({ config, pushStore, pool, cache, logger: app.log });

    const mailcowDb = createMailcowDb(config.mailcowDb);
    if (mailcowDb) app.log.info('mailcow DB connected for sender policies');

    const calendarSubStore = createCalendarSubStore({ filePath: config.calendarSubs.dbPath });
    app.log.info('calendar subscription store ready (%s)', config.calendarSubs.dbPath);

    app.decorate('cache', cache);
    app.decorate('pool', pool);
    if (ocrCache) app.decorate('ocrCache', ocrCache);
    if (mailcowDb) app.decorate('mailcowDb', mailcowDb);
    app.decorate('trackingStore', trackingStore);
    app.decorate('imageProxyCache', imageProxyCache);
    app.decorate('calendarSubStore', calendarSubStore);

    await app.register(require('@fastify/swagger'), {
        openapi: {
            openapi: '3.1.0',
            info: {
                title: 'mailcow-rest-api',
                version: pkg.version,
                description: MCP_SETUP_DESCRIPTION
            },
            components: {
                securitySchemes: {
                    basicAuth: { type: 'http', scheme: 'basic' }
                }
            },
            security: [{ basicAuth: [] }],
            tags: [
                { name: 'mailboxes', description: 'IMAP mailbox operations' },
                { name: 'messages', description: 'Message and attachment operations' },
                { name: 'ocr', description: 'Mistral OCR for attachments' },
                { name: 'ai', description: 'AI-assisted summarize / draft / actions / translate' },
                { name: 'auth', description: 'Bearer session tokens' },
                { name: 'push', description: 'Web Push subscription registration' },
                { name: 'sender-policy', description: 'Per-user sender blacklist/whitelist via mailcow' },
                { name: 'mailbox-info', description: 'Mailbox stats, aliases, logins and temp aliases via mailcow' },
                { name: 'recipient-policy', description: 'Block/unblock recipient (To) addresses via Sieve/ManageSieve' },
                { name: 'mail-rules', description: 'Unified mail rules: block, redirect, or copy via Sieve/ManageSieve' },
                { name: 'calendar', description: 'CalDAV calendar operations via SOGo' },
                { name: 'tracking', description: 'Email open tracking pixels' },
                { name: 'proxy', description: 'Privacy image proxy' },
                { name: 'system', description: 'Health and meta endpoints' }
            ]
        }
    });
    await app.register(require('@fastify/swagger-ui'), {
        routePrefix: '/',
        uiConfig: { docExpansion: 'list', deepLinking: false, persistAuthorization: true }
    });

    if (config.webmail.enabled) {
        const distAbsolute = path.isAbsolute(config.webmail.distPath)
            ? config.webmail.distPath
            : path.resolve(process.cwd(), config.webmail.distPath);
        if (fs.existsSync(distAbsolute)) {
            await app.register(fastifyStatic, {
                root: distAbsolute,
                prefix: '/webmail/',
                index: ['index.html'],
                decorateReply: false
            });
            // Bare /webmail → /webmail/
            app.get('/webmail', { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
                reply.code(308).header('location', '/webmail/').send();
            });
            // Bare /webmail/mobile → /webmail/mobile/
            app.get('/webmail/mobile', { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
                reply.code(308).header('location', '/webmail/mobile/').send();
            });
            // SPA fallback for deep-link routes inside /webmail/*. Custom 404
            // handler returns index.html for HTML clients and JSON problem
            // for everything else.
            const indexHtml = fs.readFileSync(path.join(distAbsolute, 'index.html'));
            const mobileHtmlPath = path.join(distAbsolute, 'mobile', 'index.html');
            const mobileHtml = fs.existsSync(mobileHtmlPath) ? fs.readFileSync(mobileHtmlPath) : indexHtml;
            app.setNotFoundHandler(async (req, reply) => {
                if (req.method === 'GET' && req.url.startsWith('/webmail/mobile/')) {
                    return reply.type('text/html').send(mobileHtml);
                }
                if (req.method === 'GET' && req.url.startsWith('/webmail/')) {
                    return reply.type('text/html').send(indexHtml);
                }
                reply.code(404).type('application/problem+json').send({
                    type: 'about:blank',
                    title: 'Not Found',
                    status: 404,
                    detail: `Route ${req.method} ${req.url} not found`
                });
            });
        } else {
            app.log.warn({ distAbsolute }, 'webmail dist not found — SPA disabled (run `npm run build:webmail`)');
        }
    }

    // Expose the OpenAPI document at the canonical /openapi.json path.
    app.get('/openapi.json', { config: { public: true }, schema: { hide: true } }, async (req) => {
        const doc = app.swagger();
        return {
            ...doc,
            servers: [{ url: getPublicBaseUrl(req) || '/' }]
        };
    });

    // Error handler must be registered BEFORE routes so they inherit it.
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || {
            type: 'about:blank',
            title: err.name || 'Error',
            status,
            detail: err.message || 'Unexpected error'
        };
        if (status >= 500) req.log.error({ err }, 'request failed');
        else req.log.warn({ err: { message: err.message, code: err.code } }, 'request rejected');
        reply.code(status).type('application/problem+json').send(problem);
    });

    // Raw RFC822 body parser: lets POST /v1/mailboxes/:path/messages accept
    // an .eml byte stream verbatim for IMAP APPEND. Buffer is bounded by
    // bodyLimit above. message/rfc822 is the canonical MIME type used by
    // the existing /raw GET endpoint, so the API is symmetric.
    app.addContentTypeParser('message/rfc822', { parseAs: 'buffer' }, (_req, body, done) => {
        done(null, body);
    });

    // Public routes declared BEFORE the auth hook runs.
    app.addHook('onRequest', createAuthHook({ cache, imap: imapCfg }));

    app.get('/health', {
        config: { public: true },
        schema: { tags: ['system'], summary: 'Liveness/health check' }
    }, async () => ({
        ok: true,
        cache: cache.size(),
        pool: pool.count(),
        capabilities: {
            ai: !!config.ai.apiKey,
            ocr: !!config.ocr.apiKey,
            smtp: !!config.smtp.host,
            imageProxy: true,
            drive: config.s3.enabled,
            // Lower-cased addresses whose mail the webmail should render
            // as a notification card. The list is operator-defined via
            // NOTIFICATION_SENDERS. Empty array when nothing is configured.
            notificationSenders: config.notification.senders,
            // SMS-gateway senders — extra strict treatment (no-reply,
            // phone icon). Operator-defined via SMS_SENDERS.
            smsSenders: config.notification.smsSenders
        }
    }));

    await app.register(sessionRoutes, { cache, imap: imapCfg, sessionTtlMs: config.session.ttlMs });
    await app.register(mailboxRoutes, { pool, imapCache });
    await app.register(messageRoutes, { pool, ocrCache, imapCache });
    await app.register(aiRoutes);
    await app.register(sendRoutes, { db: mailcowDb, smtp: config.smtp, pool, trackingStore, getPublicBaseUrl, imapCache });
    await app.register(pushRoutes, { pushStore });

    if (pushSender.enabled) {
        pushSender.start();
        app.log.info('push notification sender started (interval: %d ms)', config.push.pollIntervalMs);
    } else {
        app.log.info('push notifications disabled — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable');
    }
    await app.register(senderPolicyRoutes, { db: mailcowDb });
    await app.register(mailboxInfoRoutes, { db: mailcowDb });
    await app.register(shortcutsRoutes);

    const sieveManager = mailcowDb ? createSieveManager({
        db: mailcowDb,
        imapHost: imapCfg.host,
        rejectUnauthorized: imapCfg.rejectUnauthorized,
        // Use the same SNI/cert hostname the IMAP client uses, so STARTTLS
        // on dovecot's ManageSieve port (4190) verifies against the public
        // cert (delivering.email) instead of the internal docker host.
        tlsServername: imapCfg.tlsServername
    }) : null;
    await app.register(mailRulesRoutes, { sieveManager });
    await app.register(calendarRoutes, {
        sogoUrl: config.sogoUrl,
        rejectUnauthorized: config.caldav.rejectUnauthorized,
        // Persist iCal subscription tokens next to the other on-disk state.
        dataDir: path.dirname(config.cache.path),
        // SMTP config used to send "your event was edited" notifications
        // when an attendee uses the public edit URL.
        smtp: config.smtp
    });
    await app.register(calendarSubRoutes, { store: calendarSubStore });
    await app.register(driveRoutes, { s3: config.s3, logger: app.log });
    await app.register(appRoutes, { distDir: process.env.ANDROID_DIST_DIR || '/app/dist/android' });
    await app.register(iconProxyRoutes);
    await app.register(trackingRoutes, { store: trackingStore, smtp: config.smtp });
    await app.register(imageProxyRoutes, { cache: imageProxyCache, maxBytesPerDay: config.imageProxy.maxBytesPerDay });
    await app.register(telemetryRoutes, { logPath: process.env.TELEMETRY_LOG_PATH || path.join(path.dirname(config.cache.path), 'error.log') });

    app.addHook('onClose', async () => {
        if (pushSender) pushSender.stop();
        await pool.closeAll();
        cache.close();
        if (ocrCache) ocrCache.close();
        if (pushStore && pushStore.close) pushStore.close();
        if (trackingStore) trackingStore.close();
        if (imageProxyCache) imageProxyCache.close();
        if (calendarSubStore) calendarSubStore.close();
        if (mailcowDb) await mailcowDb.close();
    });

    return app;
}

async function start() {
    const app = await build();
    const shutdown = async (signal) => {
        app.log.info({ signal }, 'shutting down');
        try {
            await app.close();
            process.exit(0);
        } catch (err) {
            app.log.error({ err }, 'shutdown error');
            process.exit(1);
        }
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    try {
        await app.listen({ port: config.port, host: config.host });
    } catch (err) {
        app.log.error({ err }, 'failed to start');
        process.exit(1);
    }
}

module.exports = { build, start, getPublicBaseUrl };

if (require.main === module) {
    start();
}
