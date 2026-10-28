'use strict';

const { ImapFlow } = require('imapflow');
const { hashCreds } = require('./cache');
const { problem, unauthorized } = require('./errors');
const { looksLikeAppPassword, parseToken } = require('./app-password-store');
const { createAuthFailureLimiter } = require('./auth-failure-limit');

// Parse `Authorization: Basic <base64>` into { user, pass } or null.
function parseBasicAuth(headerValue) {
    if (!headerValue || typeof headerValue !== 'string') return null;
    const [scheme, encoded] = headerValue.split(/\s+/);
    if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) return null;
    let decoded;
    try {
        decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
        return null;
    }
    const ix = decoded.indexOf(':');
    if (ix < 0) return null;
    const user = decoded.slice(0, ix);
    const pass = decoded.slice(ix + 1);
    if (!user || !pass) return null;
    return { user, pass };
}

// Parse `Authorization: Bearer <token>` into token string or null.
function parseBearerAuth(headerValue) {
    if (!headerValue || typeof headerValue !== 'string') return null;
    const [scheme, token] = headerValue.split(/\s+/);
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
    return token;
}

// Try a fresh IMAP LOGIN to verify credentials without polluting the pool.
async function verifyWithDovecot(imap, user, pass) {
    const client = new ImapFlow({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        auth: { user, pass },
        tls: {
            rejectUnauthorized: imap.rejectUnauthorized,
            ...(imap.tlsServername ? { servername: imap.tlsServername } : {})
        },
        logger: false,
        emitLogs: false,
        connectTimeout: imap.connectTimeoutMs
    });
    client.on('error', () => {});
    try {
        await client.connect();
        try {
            await client.logout();
        } catch {
            client.close();
        }
        return { valid: true };
    } catch (err) {
        try {
            client.close();
        } catch {
            /* noop */
        }
        const text = `${err && err.responseText ? err.responseText : ''} ${err && err.message ? err.message : ''}`;
        if (err && err.authenticationFailed) return { valid: false, reason: 'auth' };
        if (/authentication\s*fail|invalid credentials|LOGIN failed/i.test(text)) return { valid: false, reason: 'auth' };
        // network / backend failures — surface distinctly
        throw err;
    }
}

// URLs served by @fastify/swagger-ui (registered with routePrefix='/') and the
// canonical /openapi.json. These must bypass auth so the docs page loads.
const SWAGGER_PUBLIC_URLS = new Set([
    '/', '/index.html', '/json', '/yaml', '/openapi.json',
    '/uiConfig', '/initOAuth', '/oauth2-redirect.html'
]);

function isSwaggerPath(url) {
    if (!url) return false;
    const path = url.split('?')[0];
    if (SWAGGER_PUBLIC_URLS.has(path)) return true;
    return path.startsWith('/static/');
}

// The webmail SPA assets are public — auth is enforced on the API calls the
// SPA makes. Anything under /webmail/ is asset-only.
function isWebmailPath(url) {
    if (!url) return false;
    const path = url.split('?')[0];
    return path === '/webmail' || path.startsWith('/webmail/');
}

// Fastify onRequest hook factory. Populates `req.creds = { user, pass, hash }`.
// Supports Bearer (session token or app password), Basic auth, and Basic auth
// whose password is an app password — auto-detected from the header.
function createAuthHook({
    cache, imap, appPasswords = null, verifier = verifyWithDovecot, now = () => Date.now(),
    authFailures = createAuthFailureLimiter(),
    // Basic-auth failures per source IP. Each uncached attempt costs a real
    // IMAP LOGIN, and the global rate limit alone still allows thousands of
    // guesses an hour from one address. Keyed by IP, never by username, so
    // nobody can lock a mailbox owner out by guessing at their address; the
    // ceiling is high enough that a shared NAT with a few mistyped passwords
    // is unaffected.
    loginFailures = createAuthFailureLimiter({ max: 30 })
}) {
    // An app password stands in for the mailbox password. The store hands back
    // the real one (decrypted) so IMAP still gets a credential it recognises;
    // req.appPassword marks the request as delegated, which the app-password
    // routes use to refuse self-management.
    function acceptAppPassword(req, reply, token, expectedUser) {
        // Failures are counted per token id, which the token carries in
        // cleartext, so an unparseable token falls back to the caller's IP.
        // The raw token is never stored.
        const parsed = parseToken(token);
        const key = parsed ? parsed.id : `ip:${req.ip}`;
        const at = now();

        // The live log shows a client retrying an expired token indefinitely;
        // each retry costs a database read and a decrypt. Telling the client to
        // back off is cheaper for everyone than re-checking.
        const gate = authFailures.check(key, at);
        if (gate.blocked) {
            reply.header('retry-after', String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))));
            throw problem(429, 'Too Many Requests', 'Too many failed app password attempts — retry later');
        }

        const result = appPasswords.verify({ token, ip: req.ip }, at);
        if (!result.ok) {
            authFailures.fail(key, at);
            // The reason separates "wrong token" from "right token, wrong
            // network"; the client is told neither — except for `expired`,
            // which the holder of the token needs to know about to go and mint
            // a new one.
            req.log.warn({ reason: result.reason, ip: req.ip }, 'app password rejected');
            if (result.reason === 'expired') {
                reply.header(
                    'WWW-Authenticate',
                    'Bearer realm="imap-rest", error="invalid_token", error_description="app password expired"'
                );
                throw unauthorized('App password expired — create a new one in the webmail (Settings → Security)');
            }
            reply.header('WWW-Authenticate', 'Bearer realm="imap-rest"');
            throw unauthorized('Invalid credentials');
        }
        if (expectedUser && expectedUser.toLowerCase() !== result.user.toLowerCase()) {
            req.log.warn({ ip: req.ip }, 'app password presented with a mismatched username');
            reply.header('WWW-Authenticate', 'Bearer realm="imap-rest"');
            throw unauthorized('Invalid credentials');
        }
        authFailures.clear(key);
        req.creds = {
            user: result.user,
            pass: result.password,
            hash: hashCreds(result.user, result.password)
        };
        req.appPassword = { id: result.id, label: result.label };
    }

    return async function authHook(req, reply) {
        // Preflight requests never carry credentials — the browser strips
        // Authorization from them — so authenticating one can only ever 401
        // and kill the real request that follows.
        if (req.method === 'OPTIONS') return;
        if (req.routeOptions?.config?.public) return;
        if (isSwaggerPath(req.url)) return;
        if (isWebmailPath(req.url)) return;

        // Try Bearer session token first
        const bearerToken = parseBearerAuth(req.headers.authorization);
        if (bearerToken) {
            // An app password carries its own id, so it authenticates as a
            // bearer token with no username alongside it.
            if (appPasswords && looksLikeAppPassword(bearerToken)) {
                return acceptAppPassword(req, reply, bearerToken, null);
            }
            // `cache` can be null: server.js now survives an unusable
            // session store rather than refusing to start. Without one,
            // every session token is simply unknown, which reads as
            // 'sign in again' rather than a 500 on the request. The same
            // applies when the store exists but a read throws (corrupt
            // file, I/O error): an unreadable cache must not 500 every
            // authenticated request.
            let session = null;
            try {
                session = cache?.getSession(bearerToken, now()) || null;
            } catch (err) {
                req.log.warn({ err: err.message }, 'session cache read failed; treating token as unknown');
            }
            if (!session) {
                reply.header('WWW-Authenticate', 'Bearer realm="imap-rest"');
                throw unauthorized('Invalid or expired session token');
            }
            req.creds = { user: session.user, pass: session.pass, hash: session.hash };
            // The presented token is carried on req.session so the session
            // routes can revoke exactly this token on Bearer sign-out (the
            // documented contract) instead of falling through to revoking
            // every session for the mailbox.
            req.session = { token: bearerToken, expiresAt: session.expiresAt };
            return;
        }

        // Fall back to Basic auth
        const creds = parseBasicAuth(req.headers.authorization);
        if (!creds) {
            reply.header('WWW-Authenticate', 'Bearer realm="imap-rest"');
            throw unauthorized('Missing credentials');
        }

        // MCP clients and curl send Basic auth, so an app password has to work
        // in the password field too. Checked before the IMAP path so a token
        // is never sent to Dovecot as if it were a password.
        if (appPasswords && looksLikeAppPassword(creds.pass)) {
            return acceptAppPassword(req, reply, creds.pass, creds.user);
        }

        const hash = hashCreds(creds.user, creds.pass);
        let cached = null;
        try {
            cached = cache?.get(hash, now()) || null;
        } catch (err) {
            // The auth cache only saves an IMAP round-trip. If it cannot be
            // read, fall through to the real verification rather than
            // failing the request.
            req.log.warn({ err: err.message }, 'auth cache read failed; verifying against IMAP');
        }
        if (cached && cached.valid) {
            req.creds = { user: creds.user, pass: creds.pass, hash };
            return;
        }

        const loginKey = `ip:${req.ip}`;
        const loginGate = loginFailures.check(loginKey, now());
        if (loginGate.blocked) {
            reply.header('retry-after', String(Math.max(1, Math.ceil(loginGate.retryAfterMs / 1000))));
            throw problem(429, 'Too Many Requests', 'Too many failed sign-in attempts — retry later');
        }

        if (cached) {
            loginFailures.fail(loginKey, now());
            reply.header('WWW-Authenticate', 'Bearer realm="imap-rest"');
            throw unauthorized('Invalid credentials');
        }

        let result;
        try {
            result = await verifier(imap, creds.user, creds.pass);
        } catch (err) {
            req.log.warn({ err }, 'imap backend unreachable during auth');
            const e = new Error('IMAP backend unavailable');
            e.statusCode = 502;
            e.problem = { type: 'about:blank', title: 'Bad Gateway', status: 502, detail: 'IMAP backend unavailable' };
            throw e;
        }

        try {
            cache?.set(hash, result.valid, now());
        } catch (err) {
            // Best-effort: a cache that cannot be written must not turn a
            // successful sign-in into a failed request.
            req.log.warn({ err: err.message }, 'could not write auth cache entry');
        }
        if (!result.valid) {
            loginFailures.fail(loginKey, now());
            reply.header('WWW-Authenticate', 'Bearer realm="imap-rest"');
            throw unauthorized('Invalid credentials');
        }
        req.creds = { user: creds.user, pass: creds.pass, hash };
    };
}

module.exports = {
    parseBasicAuth,
    parseBearerAuth,
    verifyWithDovecot,
    createAuthHook
};
