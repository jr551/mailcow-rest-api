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

module.exports = Object.freeze({
    port: num(process.env.PORT, 3001),
    host: process.env.HOST || '0.0.0.0',

    imap: {
        host: process.env.IMAP_HOST || 'dovecot-mailcow',
        port: num(process.env.IMAP_PORT, 993),
        secure: bool(process.env.IMAP_SECURE, true),
        tlsServername: process.env.IMAP_TLS_SERVERNAME || '',
        rejectUnauthorized: bool(process.env.IMAP_TLS_REJECT_UNAUTHORIZED, true),
        connectTimeoutMs: num(process.env.IMAP_CONNECT_TIMEOUT_MS, 10000)
    },

    cache: {
        path: process.env.CACHE_PATH || './data/cache.db',
        ttlValidMs: num(process.env.CACHE_TTL_VALID_MS, 300_000),
        ttlInvalidMs: num(process.env.CACHE_TTL_INVALID_MS, 10_000),
        pruneIntervalMs: num(process.env.CACHE_PRUNE_INTERVAL_MS, 300_000)
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
        cachePath: process.env.OCR_CACHE_PATH || './data/ocr-cache.db',
        cacheMaxEntries: num(process.env.OCR_CACHE_MAX_ENTRIES, 1000)
    },

    security: {
        ipAllowlist: process.env.IP_ALLOWLIST || '',
        trustProxy: bool(process.env.TRUST_PROXY, true)
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
        preset: process.env.LLM_PRESET || (process.env.MISTRAL_API_KEY ? 'mistral' : ''),
        apiKey: process.env.LLM_API_KEY || process.env.MISTRAL_API_KEY || '',
        baseUrl: process.env.LLM_BASE_URL || '',
        model: process.env.LLM_MODEL || process.env.MISTRAL_CHAT_MODEL || '',
        timeoutMs: num(process.env.LLM_TIMEOUT_MS || process.env.MISTRAL_CHAT_TIMEOUT_MS, 30_000),
        maxInputChars: num(process.env.LLM_MAX_INPUT_CHARS || process.env.MISTRAL_CHAT_MAX_INPUT_CHARS, 24_000),
        // Defaults to false — letting the SPA pass an arbitrary baseUrl turns
        // the server into an SSRF foothold. Operators opt in deliberately
        // (e.g. a vetted local Ollama deployment).
        allowClientOverride: bool(process.env.LLM_ALLOW_CLIENT_OVERRIDE, false),
        // Per-user key provisioning via the LiteLLM proxy admin API. When
        // LITELLM_MASTER_KEY is set + baseUrl points at a litellm proxy,
        // /v1/ai/config returns a scoped key for the authenticated user
        // (provisioned on first call, persisted to litellmUserStorePath).
        // The shared apiKey above is then the fallback for users that
        // can't be provisioned (e.g. if the proxy is briefly unreachable).
        litellmMasterKey: process.env.LITELLM_MASTER_KEY || '',
        litellmUserStorePath: process.env.LITELLM_USER_STORE_PATH || '/data/litellm-users.json',
        // Per-user spend cap. Defaults to $0.75 USD with a 1-day rolling
        // reset — generous for everyday chat, hard ceiling against runaway
        // tool loops or someone exfiltrating the scoped key.
        litellmKeyMaxBudget: (() => {
            const raw = process.env.LITELLM_KEY_MAX_BUDGET;
            if (raw === undefined || raw === '') return 0.75;
            const n = Number(raw);
            return Number.isFinite(n) && n > 0 ? n : 0.75;
        })(),
        litellmKeyBudgetDuration: process.env.LITELLM_KEY_BUDGET_DURATION || '1d',
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
        dbPath: process.env.PUSH_DB_PATH || './data/push.db',
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
        dbPath: process.env.TRACKING_DB_PATH || './data/tracking.db',
        pruneIntervalMs: num(process.env.TRACKING_PRUNE_INTERVAL_MS, 86400_000) // 24h default
    },

    imageProxy: {
        cachePath: process.env.IMAGE_PROXY_CACHE_PATH || './data/image-proxy.db',
        maxBytes: num(process.env.IMAGE_PROXY_MAX_BYTES, 100 * 1024 * 1024), // 100 MB total cache
        maxBytesPerDay: num(process.env.IMAGE_PROXY_MAX_BYTES_PER_DAY, 1024 * 1024 * 1024) // 1 GB per user / day
    },

    calendarSubs: {
        dbPath: process.env.CALENDAR_SUBS_DB_PATH || './data/calendar-subs.db'
    },

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
            b2: {
                keyId: process.env.B2_KEY_ID || '',
                applicationKey: process.env.B2_APPLICATION_KEY || ''
            }
        };
    })(),

    logLevel: process.env.LOG_LEVEL || 'info'
});
