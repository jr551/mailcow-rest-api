'use strict';

// Positive-numeric env parser. Empty strings, NaN, 0, and negatives all
// fall back to the default — most consumers (port numbers, timeouts,
// poll intervals, byte/char limits) treat 0 as a bug, not a valid value.
const num = (v, d) => {
    if (v === undefined || v === null || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (v, d) => {
    if (v === undefined) return d;
    const s = String(v).toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'y';
};

// Every sqlite file must sit on the same persistent volume as the main
// cache. Defaulting them to a bare './data/...' meant that unless the
// operator's compose file happened to set each one explicitly, the file
// landed in the container's working directory and was destroyed on the
// next `docker compose up` — silently, since sqlite just recreates it.
// Deriving the default from CACHE_PATH's directory makes "on the volume"
// the thing you get for free and "somewhere else" the thing you opt into.
const nodePath = require('node:path');
const CACHE_PATH = process.env.CACHE_PATH || './data/cache.db';
const dataFile = (envValue, filename) =>
    envValue || nodePath.join(nodePath.dirname(CACHE_PATH), filename);

module.exports = Object.freeze({
    port: num(process.env.PORT, 3001),
    // '::' binds dual-stack (IPv4 + IPv6). The app must answer connections
    // on every address Docker DNS advertises for it — nginx resolves the
    // service to both A and AAAA and spreads requests across them.
    host: process.env.HOST || '::',

    imap: {
        host: process.env.IMAP_HOST || 'dovecot-mailcow',
        port: num(process.env.IMAP_PORT, 993),
        secure: bool(process.env.IMAP_SECURE, true),
        tlsServername: process.env.IMAP_TLS_SERVERNAME || '',
        rejectUnauthorized: bool(process.env.IMAP_TLS_REJECT_UNAUTHORIZED, true),
        connectTimeoutMs: num(process.env.IMAP_CONNECT_TIMEOUT_MS, 10000)
    },

    cache: {
        path: CACHE_PATH,
        ttlValidMs: num(process.env.CACHE_TTL_VALID_MS, 300_000),
        ttlInvalidMs: num(process.env.CACHE_TTL_INVALID_MS, 10_000),
        pruneIntervalMs: num(process.env.CACHE_PRUNE_INTERVAL_MS, 300_000)
    },

    imapCache: {
        path: dataFile(process.env.IMAP_CACHE_PATH, 'imap-cache.db')
    },

    pool: {
        max: num(process.env.POOL_MAX, 50),
        idleMs: num(process.env.POOL_IDLE_MS, 30_000)
    },

    tls: {
        cert: process.env.TLS_CERT || '',
        key: process.env.TLS_KEY || ''
    },

    ocr: {
        apiKey: process.env.MISTRAL_API_KEY || '',
        model: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
        timeoutMs: num(process.env.MISTRAL_OCR_TIMEOUT_MS, 60_000),
        endpoint: process.env.MISTRAL_OCR_ENDPOINT || 'https://api.mistral.ai/v1/ocr',
        maxBytes: num(process.env.MISTRAL_OCR_MAX_BYTES, 50 * 1024 * 1024),
        cacheEnabled: bool(process.env.OCR_CACHE_ENABLED, true),
        cachePath: dataFile(process.env.OCR_CACHE_PATH, 'ocr-cache.db'),
        cacheMaxEntries: num(process.env.OCR_CACHE_MAX_ENTRIES, 1000)
    },

    security: {
        ipAllowlist: process.env.IP_ALLOWLIST || '',
        // Key for encrypting stored mailbox passwords (sessions, tracking
        // pixels). Any string works — 32-byte hex/base64 is used directly,
        // anything else is stretched with scrypt. When unset the server
        // generates one next to the databases and warns, because a backup
        // of the data volume would then contain the key alongside the
        // ciphertext it protects.
        credentialKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '',
        // Which hops may set X-Forwarded-For.
        //
        // `true` means "trust whatever any client claims", which makes
        // req.ip attacker-controlled: a forged `X-Forwarded-For: 127.0.0.1`
        // would match both the rate limiter's allowList and the IP
        // allowlist's loopback rules, disabling the only brake on
        // credential stuffing against Dovecot. It isn't exploitable in the
        // reference deployment (the front nginx overwrites the header), but
        // that's the proxy's good behaviour protecting us, not ours.
        //
        // Default: trust only proxies on loopback/private networks, which
        // is exactly the Docker topology, and resolve the real client from
        // the forwarded chain. Set TRUST_PROXY to a comma-separated
        // IP/CIDR list, a hop count, or `false` to override.
        trustProxy: (() => {
            const raw = process.env.TRUST_PROXY;
            const PRIVATE_HOPS = 'loopback, linklocal, uniquelocal';
            if (raw === undefined || raw === '') return PRIVATE_HOPS;
            const s = String(raw).trim().toLowerCase();
            if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false;
            // `true` is treated as the private-hop list rather than
            // "trust everyone" — the literal is the footgun described above.
            if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return PRIVATE_HOPS;
            const hops = Number(raw);
            if (Number.isInteger(hops) && hops > 0) return hops;
            return String(raw).trim();
        })()
    },

    rateLimit: {
        // Anti-abuse backstop, not a strict per-user throttle — a webmail
        // client legitimately bursts many requests when opening a mailbox.
        // The default caps credential-stuffing sweeps against the IMAP
        // LOGIN each failed Basic-auth attempt triggers (see auth.js)
        // without disrupting normal use. 127.0.0.1/::1 are always exempt
        // so the Docker healthcheck can't be starved by real traffic.
        enabled: bool(process.env.RATE_LIMIT_ENABLED, true),
        max: num(process.env.RATE_LIMIT_MAX, 300),
        windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000)
    },

    session: {
        ttlMs: num(process.env.SESSION_TTL_MS, 3_600_000),
        // Hard cap on session age regardless of activity. Sliding TTL extends
        // ttlMs on every request; this ceiling stops a long-lived attacker.
        // Default raised from 1 day → 30 days so PWA users on iOS / Safari
        // (where storage is reclaimed aggressively) don't hit a forced
        // re-auth just because they opened the app a couple of weeks apart.
        // The vault-creds renewal flow still kicks in well before this.
        maxLifetimeMs: num(process.env.SESSION_MAX_LIFETIME_MS, 30 * 86_400_000)
    },

    mailcowDb: {
        host: process.env.MAILCOW_DB_HOST || 'mysql-mailcow',
        port: num(process.env.MAILCOW_DB_PORT, 3306),
        user: process.env.MAILCOW_DB_USER || 'mailcow',
        pass: process.env.MAILCOW_DB_PASS || '',
        name: process.env.MAILCOW_DB_NAME || 'mailcow'
    },

    ai: {
        // Pluggable LLM provider. `kind` is openai | anthropic. `preset` is
        // a shorthand for openai-compatible servers (mistral, openai, groq,
        // together, ollama, perplexity, openrouter). Backward compat:
        // MISTRAL_API_KEY still works (preset=mistral).
        kind: process.env.LLM_PROVIDER || 'openai',
        preset: process.env.LLM_PRESET || (process.env.MISTRAL_API_KEY ? 'mistral' : 'deepseek'),
        apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.MISTRAL_API_KEY || '',
        baseUrl: process.env.LLM_BASE_URL || '',
        model: process.env.LLM_MODEL || process.env.MISTRAL_CHAT_MODEL || '',
        timeoutMs: num(process.env.LLM_TIMEOUT_MS || process.env.MISTRAL_CHAT_TIMEOUT_MS, 30_000),
        maxInputChars: num(process.env.LLM_MAX_INPUT_CHARS || process.env.MISTRAL_CHAT_MAX_INPUT_CHARS, 24_000),
        // Defaults to false — letting the SPA pass an arbitrary baseUrl turns
        // the server into an SSRF foothold. Operators opt in deliberately
        // (e.g. a vetted local Ollama deployment).
        allowClientOverride: bool(process.env.LLM_ALLOW_CLIENT_OVERRIDE, false),
        // Reasoning budget sent as `reasoning_effort` on every completion.
        //
        // Reasoning models bill hidden thinking tokens against max_tokens
        // *before* emitting any visible content, so a modest budget can be
        // consumed entirely by the reasoning pass — the caller then gets a
        // 200 with finish_reason=length and an empty string. Measured on
        // deepseek-v4-flash: at max_tokens=40 the default spends all 40 on
        // reasoning and returns nothing, while 'none' answers correctly.
        // Counter-intuitively 'low' produced *more* reasoning than sending
        // nothing at all, so it was never the mitigation it looked like.
        //
        // 'none' suits this workload: summaries, classification, subject
        // lines and JSON extraction want the answer, not the deliberation.
        // Set LLM_REASONING_EFFORT to low/medium/high to re-enable it, or
        // to an empty string to omit the parameter entirely for providers
        // that reject unknown values.
        reasoningEffort: process.env.LLM_REASONING_EFFORT === undefined
            ? 'none'
            : process.env.LLM_REASONING_EFFORT,
        // Strip credentials from prompts before they leave this process.
        // Deterministic pattern matching, not a model — see secret-scrub.js.
        // On by default: the AI features work fine without the secret, and
        // sending one to a third party is the kind of mistake that can't be
        // taken back.
        scrubSecrets: bool(process.env.LLM_SCRUB_SECRETS, true),
        // Decoy requests per real request, to dilute what the provider can
        // profile from stored prompts. OFF by default: this multiplies
        // token spend by (1 + count) and does not hide that you use the
        // service at all — see llm-decoys.js for what it does and doesn't buy.
        decoyCount: (() => {
            const raw = process.env.LLM_DECOY_COUNT;
            if (raw === undefined || raw === '') return 0;
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 0) return 0;
            return Math.min(n, 5); // a sane ceiling; this is real money
        })(),
        // Server-side completion cache. The webmail re-asks the same
        // questions (reopening a message re-summarizes it, refreshing the
        // inbox re-triages it), so identical requests are answered from
        // sqlite instead of the provider. Scoped per user.
        cachePath: dataFile(process.env.AI_CACHE_PATH, 'ai-cache.db'),
        cacheEnabled: bool(process.env.AI_CACHE_ENABLED, true),
        cacheTtlMs: num(process.env.AI_CACHE_TTL_MS, 12 * 60 * 60 * 1000),
        cacheMaxEntries: num(process.env.AI_CACHE_MAX_ENTRIES, 5000),
        // Brave Search API key for the AI assistant's web_search tool.
        // Free tier: 2000 queries/month at https://api.search.brave.com.
        // Without a key the tool returns 501 and the model is told the
        // user hasn't enabled web search server-side.
        braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || ''
    },

    webmail: {
        enabled: bool(process.env.WEBMAIL_ENABLED, true),
        distPath: process.env.WEBMAIL_DIST || './webmail/dist'
    },

    smtp: {
        host: process.env.SMTP_HOST || '',
        port: num(process.env.SMTP_PORT, 587),
        secure: bool(process.env.SMTP_SECURE, false),
        tlsServername: process.env.SMTP_TLS_SERVERNAME || '',
        rejectUnauthorized: bool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
        connectTimeoutMs: num(process.env.SMTP_CONNECT_TIMEOUT_MS, 10000)
    },

    push: {
        // VAPID keys for Web Push delivery. /v1/push/subscribe accepts
        // subscriptions even when these are unset (for diagnostics) — the
        // notification poller only delivers when both are present.
        vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
        vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
        vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
        dbPath: dataFile(process.env.PUSH_DB_PATH, 'push.db'),
        pollIntervalMs: num(process.env.PUSH_POLL_INTERVAL_MS, 5 * 60 * 1000)
    },

    shortcuts: {
        // Admin-defined links / iframe popups / embedded panels that appear
        // in the webmail sidebar. Set COMPANY_SHORTCUTS to a JSON array, e.g.:
        //   [
        //     {"title":"HR Portal","url":"https://hr.example.com","mode":"link"},
        //     {"title":"Wiki","url":"https://wiki.example.com","mode":"popup","icon":"info"},
        //     {"title":"Calendar","url":"https://cal.example.com","mode":"embed"}
        //   ]
        // mode = "link" (window.open) | "popup" (in-app FloatingPanel iframe)
        //      | "embed" (replaces the message-pane with an iframe)
        // icon = optional name from the SPA's icon set
        items: (() => {
            const raw = process.env.COMPANY_SHORTCUTS || '';
            if (!raw.trim()) return [];
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) return [];
                return parsed
                    .filter((s) => s && typeof s.title === 'string' && typeof s.url === 'string')
                    .map((s) => ({
                        title: String(s.title).slice(0, 80),
                        url: String(s.url).slice(0, 2048),
                        mode: ['link', 'popup', 'embed'].includes(s.mode) ? s.mode : 'link',
                        icon: s.icon ? String(s.icon).slice(0, 32) : null,
                        description: s.description ? String(s.description).slice(0, 200) : null
                    }));
            } catch {
                // Invalid JSON — silently ignore (already logged by load() if you trace).
                return [];
            }
        })()
    },

    sogoUrl: process.env.SOGO_URL || '',

    notification: {
        // Email addresses whose mail should render as a "notification card"
        // in the webmail (sender hidden, subject prominent — think system
        // alerts from monitoring tools). Comma-separated. Lowercased on
        // load so address matching is case-insensitive.
        senders: (process.env.NOTIFICATION_SENDERS || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        // SMS gateway senders (e.g. sms@aa.net.uk). Same notification-card
        // treatment plus a phone icon and a no-reply lock on the detail
        // pane — replying to an SMS-gateway address by accident leaks your
        // mailbox identity, so we just disable the reply buttons.
        smsSenders: (process.env.SMS_SENDERS || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
    },

    caldav: {
        rejectUnauthorized: bool(process.env.CALDAV_TLS_REJECT_UNAUTHORIZED, true)
    },

    tts: {
        // ElevenLabs text-to-speech config. Exposed to authenticated clients
        // so the webmail UI can generate voice audio without storing keys
        // in localStorage.
        apiKey: process.env.ELEVENLABS_API_KEY || ''
    },

    tracking: {
        dbPath: dataFile(process.env.TRACKING_DB_PATH, 'tracking.db'),
        pruneIntervalMs: num(process.env.TRACKING_PRUNE_INTERVAL_MS, 86400_000) // 24h default
    },

    imageProxy: {
        cachePath: dataFile(process.env.IMAGE_PROXY_CACHE_PATH, 'image-proxy.db'),
        maxBytes: num(process.env.IMAGE_PROXY_MAX_BYTES, 100 * 1024 * 1024), // 100 MB total cache
        maxBytesPerDay: num(process.env.IMAGE_PROXY_MAX_BYTES_PER_DAY, 1024 * 1024 * 1024) // 1 GB per user / day
    },

    calendarSubs: {
        dbPath: dataFile(process.env.CALENDAR_SUBS_DB_PATH, 'calendar-subs.db')
    },

    // Webhook conversion accounts. Mail arriving in one of these mailboxes
    // is POSTed to the account's webhook URL and then deleted. Set
    // WEBHOOK_ACCOUNTS to a JSON array:
    //   [
    //     {"address":"forms@example.com","password":"…","url":"https://hooks.example.com/mail","secret":"…"},
    //     {"address":"tickets@example.com","password":"…","url":"https://desk.example.com/in","mailbox":"INBOX"}
    //   ]
    // `password` is the mailbox's own IMAP password — the forwarder runs in
    // the background with no user session to borrow credentials from.
    // `secret` (optional) signs the POST body with HMAC-SHA256, sent as
    // X-Webhook-Signature: sha256=<hex>. `mailbox` defaults to INBOX.
    webhooks: (() => {
        const raw = process.env.WEBHOOK_ACCOUNTS || '';
        let accounts = [];
        if (raw.trim()) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    accounts = parsed
                        .filter((a) => a && typeof a.address === 'string' &&
                            typeof a.password === 'string' && typeof a.url === 'string')
                        // Only http(s): a stray scheme here would be handed
                        // straight to undici.
                        .filter((a) => /^https?:\/\//i.test(a.url))
                        .map((a) => ({
                            address: a.address.trim(),
                            password: a.password,
                            url: a.url.trim(),
                            mailbox: (typeof a.mailbox === 'string' && a.mailbox.trim()) || 'INBOX',
                            secret: typeof a.secret === 'string' ? a.secret : ''
                        }));
                }
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[config] Failed to parse WEBHOOK_ACCOUNTS:', err.message);
            }
        }
        return {
            accounts,
            dbPath: dataFile(process.env.WEBHOOK_DB_PATH, 'webhooks.db'),
            pollIntervalMs: num(process.env.WEBHOOK_POLL_INTERVAL_MS, 60_000),
            timeoutMs: num(process.env.WEBHOOK_TIMEOUT_MS, 15_000),
            // ~7 attempts of backoff then daily retries for a week before
            // we stop and leave the message in the mailbox for a human.
            maxAttempts: num(process.env.WEBHOOK_MAX_ATTEMPTS, 14),
            maxMessageBytes: num(process.env.WEBHOOK_MAX_MESSAGE_BYTES, 25 * 1024 * 1024),
            // Attachment bytes are included in the payload so the receiver
            // doesn't have to re-parse MIME out of the raw source. Bounded,
            // because base64 adds a third and a mailbox may accept 25 MB
            // of attachments — an unbounded payload would be ~33 MB of JSON
            // per message. Over-cap parts are described and flagged rather
            // than silently dropped.
            includeAttachments: bool(process.env.WEBHOOK_INCLUDE_ATTACHMENTS, true),
            maxAttachmentBytes: num(process.env.WEBHOOK_MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024),
            maxAttachmentsTotalBytes: num(process.env.WEBHOOK_MAX_ATTACHMENTS_TOTAL_BYTES, 20 * 1024 * 1024)
        };
    })(),

    s3: (() => {
        const enabled = bool(process.env.S3_DRIVE_ENABLED, false);
        const provider = process.env.S3_DRIVE_PROVIDER || 'json'; // 'json' | 'b2'
        const filePath = process.env.S3_DRIVE_USERS_JSON || './data/drive-users.json';
        let users = {};
        if (enabled && provider === 'json') {
            try {
                const fs = require('node:fs');
                const path = require('node:path');
                const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
                if (fs.existsSync(absolute)) {
                    const raw = fs.readFileSync(absolute, 'utf8');
                    const parsed = JSON.parse(raw);
                    // Strip comment keys and validate shape
                    for (const [email, cfg] of Object.entries(parsed)) {
                        if (email.startsWith('_')) continue;
                        if (
                            cfg &&
                            typeof cfg === 'object' &&
                            typeof cfg.endpoint === 'string' &&
                            typeof cfg.bucket === 'string' &&
                            cfg.credentials &&
                            typeof cfg.credentials.accessKeyId === 'string'
                        ) {
                            users[email.toLowerCase()] = {
                                endpoint: cfg.endpoint,
                                region: cfg.region || 'us-east-1',
                                bucket: cfg.bucket,
                                prefix: cfg.prefix || '',
                                publicUrl: cfg.publicUrl || '',
                                credentials: {
                                    accessKeyId: cfg.credentials.accessKeyId,
                                    secretAccessKey: cfg.credentials.secretAccessKey || ''
                                }
                            };
                        }
                    }
                }
            } catch (err) {
                // If the file is missing or malformed we log once and fall back to empty users.
                // eslint-disable-next-line no-console
                console.warn('[config] Failed to load S3_DRIVE_USERS_JSON:', err.message);
            }
        }
        return {
            enabled,
            provider,
            filePath,
            users,
            defaultQuotaGb: num(process.env.S3_DRIVE_DEFAULT_QUOTA_GB, 5),
            // Browser origins allowed to talk to a provisioned bucket.
            // The webmail's Drive is a direct browser-to-S3 client, so a
            // bucket without matching CORS rules can't be opened at all.
            corsOrigins: process.env.DRIVE_CORS_ORIGINS || process.env.PUBLIC_BASE_URL || '',
            b2: {
                keyId: process.env.B2_KEY_ID || '',
                applicationKey: process.env.B2_APPLICATION_KEY || ''
            }
        };
    })(),

    logLevel: process.env.LOG_LEVEL || 'info'
});
