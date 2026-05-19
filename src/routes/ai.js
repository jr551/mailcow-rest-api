'use strict';

const llm = require('../llm');
const config = require('../config');
const { problem } = require('../errors');
const { LitellmClient } = require('../litellm-client');
const { LitellmUserStore } = require('../litellm-user-store');

// `provider` block in the request body lets clients override the server's
// default LLM (so the Settings panel can target a user's own key/endpoint).
// Server admins can disable overrides via LLM_ALLOW_CLIENT_OVERRIDE=false.
const providerOverrideSchema = {
    type: 'object',
    properties: {
        kind: { type: 'string', enum: ['openai', 'anthropic'] },
        preset: { type: 'string', maxLength: 32 },
        apiKey: { type: 'string', maxLength: 512 },
        baseUrl: { type: 'string', format: 'uri', maxLength: 512 },
        model: { type: 'string', maxLength: 128 }
    },
    additionalProperties: false
};

const summarizeBodySchema = {
    type: 'object',
    required: ['text'],
    properties: {
        text: { type: 'string', minLength: 1, maxLength: 200_000 },
        maxWords: { type: 'integer', minimum: 20, maximum: 400 },
        provider: providerOverrideSchema
    },
    additionalProperties: false
};

const draftReplyBodySchema = {
    type: 'object',
    required: ['thread'],
    properties: {
        thread: { type: 'string', minLength: 1, maxLength: 200_000 },
        intent: { type: 'string', maxLength: 500 },
        provider: providerOverrideSchema
    },
    additionalProperties: false
};

const actionsBodySchema = {
    type: 'object',
    required: ['text'],
    properties: {
        text: { type: 'string', minLength: 1, maxLength: 200_000 },
        provider: providerOverrideSchema
    },
    additionalProperties: false
};

const translateBodySchema = {
    type: 'object',
    required: ['text', 'target'],
    properties: {
        text: { type: 'string', minLength: 1, maxLength: 200_000 },
        target: { type: 'string', minLength: 1, maxLength: 60 },
        provider: providerOverrideSchema
    },
    additionalProperties: false
};

const sortInboxBodySchema = {
    type: 'object',
    required: ['messages'],
    properties: {
        messages: {
            type: 'array',
            maxItems: 200,
            items: {
                type: 'object',
                required: ['uid'],
                properties: {
                    uid: { type: 'integer' },
                    subject: { type: 'string' },
                    from: {},
                    to: {},
                    date: { type: 'string' }
                }
            }
        },
        provider: providerOverrideSchema
    },
    additionalProperties: false
};

const phishingScanBodySchema = {
    type: 'object',
    required: ['subject', 'from', 'body'],
    properties: {
        subject: { type: 'string', maxLength: 2000 },
        from: { type: 'string', maxLength: 1000 },
        to: { type: 'string', maxLength: 1000 },
        body: { type: 'string', maxLength: 200_000 },
        html: { type: 'string', maxLength: 400_000 },
        headers: { type: 'string', maxLength: 20_000 },
        provider: providerOverrideSchema,
        // User feedback. When the user has previously marked emails
        // from a domain/address as "not spam" or "spam", the client
        // passes those lists so the model can lean toward the
        // matching label instead of relitigating the same call.
        userFeedback: {
            type: 'object',
            additionalProperties: false,
            properties: {
                trustedDomains: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 200 },
                trustedAddresses: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 200 },
                spamDomains: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 200 },
                spamAddresses: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 200 }
            }
        },
        // Parsed Authentication-Results from the receiving MTA — the
        // model treats DKIM/SPF/DMARC fail as a strong "phishing"
        // signal (sender domain is being spoofed), and a full pass as
        // grounds to rule out the obvious header-spoof tier.
        auth: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
                spf:   { type: ['string', 'null'], maxLength: 32 },
                dkim:  { type: ['string', 'null'], maxLength: 32 },
                dmarc: { type: ['string', 'null'], maxLength: 32 }
            }
        }
    },
    additionalProperties: false
};

const aiResultSchema = {
    type: 'object',
    properties: {
        content: { type: 'string' },
        model: { type: 'string' }
    }
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

const capabilitiesSchema = {
    type: 'object',
    properties: {
        configured: { type: 'boolean' },
        kind: { type: 'string' },
        preset: { type: 'string' },
        model: { type: 'string' },
        allowClientOverride: { type: 'boolean' },
        presets: { type: 'array', items: { type: 'string' } }
    }
};

function resolveProvider(override) {
    if (!config.ai.allowClientOverride && override) {
        // Server admin opted out of client overrides. Fall back silently.
        override = undefined;
    }
    return llm.resolveProvider(config.ai, override);
}

function reject(result) {
    const err = problem(result.status || 502, result.title || 'AI error', result.detail || 'AI request failed');
    throw err;
}

module.exports = async function aiRoutes(app) {
    // Capability probe — UI uses this to decide whether to enable AI buttons.
    const aiConfigSchema = {
        type: 'object',
        properties: {
            configured: { type: 'boolean' },
            kind: { type: 'string' },
            baseUrl: { type: 'string' },
            model: { type: 'string' },
            apiKey: { type: 'string' }
        }
    };

    app.get('/v1/ai/capabilities', {
        config: { public: true },
        schema: {
            tags: ['ai'],
            summary: 'Report whether AI is configured server-side and which presets are known',
            response: { 200: capabilitiesSchema }
        }
    }, async () => ({
        configured: !!config.ai.apiKey,
        kind: config.ai.kind || 'openai',
        preset: config.ai.preset || '',
        model: config.ai.model || '',
        allowClientOverride: !!config.ai.allowClientOverride,
        presets: Object.keys(llm.OPENAI_COMPAT_PRESETS).concat(['anthropic'])
    }));

    // LiteLLM per-user key provisioner. Only initialised when the operator
    // sets LITELLM_MASTER_KEY. If init fails (bad URL, etc.) we fall back
    // to the shared apiKey path so the chat keeps working.
    let litellmClient = null;
    let litellmStore = null;
    if (config.ai.litellmMasterKey && config.ai.baseUrl) {
        try {
            litellmClient = new LitellmClient({
                baseUrl: config.ai.baseUrl,
                masterKey: config.ai.litellmMasterKey,
                logger: app.log
            });
            litellmStore = new LitellmUserStore(config.ai.litellmUserStorePath);
            app.log.info('LiteLLM per-user key provisioning enabled');
        } catch (err) {
            app.log.warn({ err: err.message }, 'LiteLLM per-user key provisioning disabled');
            litellmClient = null;
            litellmStore = null;
        }
    }

    async function getOrProvisionUserKey(email) {
        if (!litellmClient || !litellmStore) return null;
        const wantBudget = config.ai.litellmKeyMaxBudget;
        const wantDuration = config.ai.litellmKeyBudgetDuration;

        const existing = litellmStore.get(email);
        const budgetMismatch = existing && existing.key && (
            existing.maxBudget !== wantBudget || existing.budgetDuration !== wantDuration
        );

        // If we already have a working key and the envelope matches, use it.
        if (existing && existing.key && !budgetMismatch) return existing;

        // Either no record yet, OR the operator changed the budget envelope.
        // Try to mint a fresh key; on failure (proxy unreachable etc) keep
        // serving the old one so users don't get bumped to the master key
        // every time the network blips.
        try {
            if (budgetMismatch && existing.token) {
                try { await litellmClient.deleteKey(existing.token); } catch (err) {
                    app.log.warn({ err: err.message, email }, 'budget-rotation revoke failed (continuing)');
                }
            }
            const resolved = llm.resolveProvider(config.ai);
            const models = resolved.model ? [resolved.model] : ['*'];
            const created = await litellmClient.createKey({
                userId: email,
                models,
                keyAlias: `imr-${email}`,
                maxBudget: wantBudget,
                budgetDuration: wantDuration
            });
            const record = {
                key: created.key,
                token: created.token,
                keyName: created.keyName,
                createdAt: new Date().toISOString(),
                expiresAt: created.expires,
                maxBudget: wantBudget,
                budgetDuration: wantDuration
            };
            litellmStore.set(email, record);
            return record;
        } catch (err) {
            app.log.warn({ err: err.message, email }, 'LiteLLM provisioning failed');
            // Fall back to the previous record if we have one — it still
            // works, just under the old budget envelope.
            if (existing && existing.key) {
                app.log.info({ email }, 'using stale per-user key while proxy is unreachable');
                return existing;
            }
            return null;
        }
    }

    // Expose the server's resolved AI provider config to authenticated clients
    // so the webmail chat can use the admin-configured key/endpoint directly.
    app.get('/v1/ai/config', {
        schema: {
            tags: ['ai'],
            summary: 'Get server AI provider config for client-side use',
            response: { 200: aiConfigSchema, 501: problemSchema }
        }
    }, async (req) => {
        if (!config.ai.apiKey && !litellmClient) {
            throw problem(501, 'Not Implemented', 'AI provider not configured server-side');
        }
        const resolved = llm.resolveProvider(config.ai);
        let apiKey = resolved.apiKey;
        if (litellmClient && req.creds?.user) {
            try {
                const userKey = await getOrProvisionUserKey(req.creds.user.toLowerCase());
                if (userKey?.key) apiKey = userKey.key;
            } catch (err) {
                req.log.warn({ err: err.message, user: req.creds.user }, 'LiteLLM key provisioning failed; falling back to shared key');
            }
        }
        return {
            configured: true,
            kind: resolved.kind,
            baseUrl: resolved.baseUrl,
            model: resolved.model,
            apiKey
        };
    });

    // Live spend + budget for the calling user, queried fresh from LiteLLM.
    // Returns 200 with `enabled: false` (instead of an error) when per-user
    // provisioning isn't configured, so the webmail can render gracefully
    // on shared-key deployments.
    app.get('/v1/ai/key/usage', {
        schema: {
            tags: ['ai'],
            summary: 'Spend + budget for the calling user\'s scoped LiteLLM key',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean' },
                        spent: { type: 'number' },
                        maxBudget: { type: ['number', 'null'] },
                        budgetDuration: { type: ['string', 'null'] },
                        percent: { type: 'number' },
                        resetAt: { type: ['string', 'null'] }
                    }
                }
            }
        }
    }, async (req) => {
        if (!litellmClient || !litellmStore) {
            return { enabled: false, spent: 0, maxBudget: null, budgetDuration: null, percent: 0, resetAt: null };
        }
        const email = req.creds.user.toLowerCase();
        const record = litellmStore.get(email);
        if (!record?.token) {
            // Not provisioned yet — return zeros so the UI doesn't 404-toast.
            return { enabled: true, spent: 0, maxBudget: config.ai.litellmKeyMaxBudget, budgetDuration: config.ai.litellmKeyBudgetDuration, percent: 0, resetAt: null };
        }
        try {
            const info = await litellmClient.getKeyInfo(record.token);
            const spent = Number(info.spend) || 0;
            const max = info.max_budget === null || info.max_budget === undefined ? null : Number(info.max_budget);
            const percent = max && max > 0 ? Math.min(100, (spent / max) * 100) : 0;
            return {
                enabled: true,
                spent,
                maxBudget: max,
                budgetDuration: info.budget_duration || null,
                percent,
                resetAt: info.budget_reset_at || null
            };
        } catch (err) {
            req.log.warn({ err: err.message, email }, 'LiteLLM /key/info failed');
            return { enabled: true, spent: 0, maxBudget: record.maxBudget ?? null, budgetDuration: record.budgetDuration ?? null, percent: 0, resetAt: null };
        }
    });

    // Force-rotate the calling user's LiteLLM key. Useful if a key was
    // leaked or if budget needs to reset early. Old key is revoked best-
    // effort; new one is provisioned and persisted.
    app.post('/v1/ai/key/rotate', {
        schema: {
            tags: ['ai'],
            summary: 'Rotate the calling user\'s scoped LiteLLM key',
            response: {
                200: {
                    type: 'object',
                    properties: { rotated: { type: 'boolean' } }
                },
                501: problemSchema
            }
        }
    }, async (req) => {
        if (!litellmClient || !litellmStore) {
            throw problem(501, 'Not Implemented', 'Per-user key provisioning is not enabled');
        }
        const email = req.creds.user.toLowerCase();
        const old = litellmStore.get(email);
        litellmStore.delete(email);
        if (old?.token) {
            try { await litellmClient.deleteKey(old.token); } catch (err) {
                req.log.warn({ err: err.message }, 'old key revocation failed');
            }
        }
        await getOrProvisionUserKey(email);
        return { rotated: true };
    });

    // Brave Search proxy for the AI assistant's `web_search` tool. The
    // browser doesn't call api.search.brave.com directly because the API
    // key needs to live server-side (and Brave's CORS is restrictive).
    // Free tier is 2000 queries/month; gate on BRAVE_SEARCH_API_KEY so
    // operators opt in deliberately.
    app.post('/v1/ai/web-search', {
        schema: {
            tags: ['ai'],
            summary: 'Brave Search proxy for the AI assistant',
            body: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: { type: 'string', minLength: 1, maxLength: 400 },
                    count: { type: 'integer', minimum: 1, maximum: 10, default: 5 }
                },
                additionalProperties: false
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        provider: { type: 'string' },
                        query: { type: 'string' },
                        results: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    title: { type: 'string' },
                                    url: { type: 'string' },
                                    description: { type: 'string' }
                                }
                            }
                        }
                    }
                },
                501: problemSchema,
                502: problemSchema
            }
        }
    }, async (req) => {
        const apiKey = config.ai.braveSearchApiKey;
        if (!apiKey) {
            throw problem(501, 'Not Implemented',
                'Web search isn\'t configured on this server. The operator can enable it by setting BRAVE_SEARCH_API_KEY (free tier at api.search.brave.com).');
        }
        const query = String(req.body.query || '').trim();
        const count = Math.max(1, Math.min(10, Number(req.body.count) || 5));
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;

        const { request: undiciRequest } = require('undici');
        let res;
        try {
            res = await undiciRequest(url, {
                method: 'GET',
                headers: {
                    'X-Subscription-Token': apiKey,
                    'Accept': 'application/json',
                    // Force identity so undici can hand us a plain string —
                    // it doesn't auto-decompress gzip/br, and the
                    // previous "Accept-Encoding: gzip" header turned every
                    // 200 response into a "non-JSON" salad of bytes.
                    'Accept-Encoding': 'identity'
                },
                headersTimeout: 5000,
                bodyTimeout: 6000,
                signal: AbortSignal.timeout(9000)
            });
        } catch (err) {
            req.log.warn({ err: err.message }, 'Brave Search request failed');
            throw problem(502, 'Bad Gateway', `Brave Search unreachable: ${err.message}`);
        }
        // Defensive: if a future undici/proxy hop ever lands a compressed
        // body here despite Accept-Encoding: identity, decompress before
        // JSON.parse rather than reporting "non-JSON".
        const encoding = (res.headers['content-encoding'] || '').toString().toLowerCase();
        let text;
        if (encoding === 'gzip' || encoding === 'br' || encoding === 'deflate') {
            const buf = Buffer.from(await res.body.arrayBuffer());
            try {
                const zlib = require('zlib');
                if (encoding === 'gzip') text = zlib.gunzipSync(buf).toString('utf8');
                else if (encoding === 'br') text = zlib.brotliDecompressSync(buf).toString('utf8');
                else text = zlib.inflateSync(buf).toString('utf8');
            } catch (err) {
                req.log.warn({ err: err.message, encoding }, 'Brave Search decode failed');
                throw problem(502, 'Bad Gateway', `Brave Search returned ${encoding} body that failed to decode`);
            }
        } else {
            text = await res.body.text();
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
            req.log.warn({ status: res.statusCode, body: text.slice(0, 200) }, 'Brave Search returned error');
            // Specific surface for the most common operator-side failure:
            // a missing / wrong / revoked subscription token. Brave returns
            // 401 or 422 with SUBSCRIPTION_TOKEN_INVALID — translate to a
            // 501 Not Implemented so the assistant tells the user to ask
            // the operator to fix the key, instead of "Bad Gateway".
            if (
                res.statusCode === 401
                || res.statusCode === 422
                || /SUBSCRIPTION_TOKEN_INVALID/i.test(text)
            ) {
                throw problem(501, 'Not Implemented',
                    'Web search is misconfigured on this server: the BRAVE_SEARCH_API_KEY is missing or invalid. Ask the operator to refresh it at https://api.search.brave.com.');
            }
            // Brave's free tier is 1 query/sec; surface 429 nicely.
            if (res.statusCode === 429) {
                throw problem(502, 'Bad Gateway', 'Brave Search rate limit hit — wait a moment and retry.');
            }
            throw problem(502, 'Bad Gateway', `Brave Search ${res.statusCode}: ${text.slice(0, 160)}`);
        }
        let parsed;
        try { parsed = JSON.parse(text); } catch (err) {
            // Log enough to diagnose what came back without leaking the
            // whole response into our logs forever.
            req.log.warn({
                err: err.message,
                status: res.statusCode,
                contentType: res.headers['content-type'],
                head: text.slice(0, 80)
            }, 'Brave Search returned non-JSON');
            throw problem(502, 'Bad Gateway', 'Brave Search returned non-JSON');
        }
        const items = (parsed && parsed.web && Array.isArray(parsed.web.results)) ? parsed.web.results : [];
        return {
            provider: 'brave',
            query,
            results: items.slice(0, count).map((r) => ({
                title: String(r.title || '').slice(0, 200),
                url: String(r.url || ''),
                description: String(r.description || '').replace(/<[^>]+>/g, '').slice(0, 400)
            }))
        };
    });

    const ttsConfigSchema = {
        type: 'object',
        properties: {
            configured: { type: 'boolean' },
            apiKey: { type: 'string' }
        }
    };

    // Expose ElevenLabs key to authenticated clients for direct browser-side TTS.
    app.get('/v1/ai/tts-config', {
        schema: {
            tags: ['ai'],
            summary: 'Get server TTS (ElevenLabs) config for client-side use',
            response: { 200: ttsConfigSchema }
        }
    }, async () => {
        if (!config.tts.apiKey) {
            return { configured: false, apiKey: '' };
        }
        return {
            configured: true,
            apiKey: config.tts.apiKey
        };
    });

    app.post('/v1/ai/summarize', {
        schema: {
            tags: ['ai'],
            summary: 'Summarize a message body',
            body: summarizeBodySchema,
            response: { 200: aiResultSchema, 501: problemSchema, 502: problemSchema }
        }
    }, async (req) => {
        const provider = resolveProvider(req.body.provider);
        const result = await llm.summarize({ text: req.body.text, maxWords: req.body.maxWords, provider });
        if (!result.ok) reject(result);
        return { content: result.content, model: result.model };
    });

    app.post('/v1/ai/draft-reply', {
        schema: {
            tags: ['ai'],
            summary: 'Draft a reply to an email thread',
            body: draftReplyBodySchema,
            response: { 200: aiResultSchema, 501: problemSchema, 502: problemSchema }
        }
    }, async (req) => {
        const provider = resolveProvider(req.body.provider);
        const result = await llm.draftReply({ thread: req.body.thread, intent: req.body.intent, provider });
        if (!result.ok) reject(result);
        return { content: result.content, model: result.model };
    });

    app.post('/v1/ai/actions', {
        schema: {
            tags: ['ai'],
            summary: 'Extract action items as a checklist',
            body: actionsBodySchema,
            response: { 200: aiResultSchema, 501: problemSchema, 502: problemSchema }
        }
    }, async (req) => {
        const provider = resolveProvider(req.body.provider);
        const result = await llm.extractActions({ text: req.body.text, provider });
        if (!result.ok) reject(result);
        return { content: result.content, model: result.model };
    });

    app.post('/v1/ai/translate', {
        schema: {
            tags: ['ai'],
            summary: 'Translate a message into another language',
            body: translateBodySchema,
            response: { 200: aiResultSchema, 501: problemSchema, 502: problemSchema }
        }
    }, async (req) => {
        const provider = resolveProvider(req.body.provider);
        const result = await llm.translate({ text: req.body.text, target: req.body.target, provider });
        if (!result.ok) reject(result);
        return { content: result.content, model: result.model };
    });

    const sortResultSchema = {
        type: 'object',
        properties: {
            rankings: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        uid: { type: 'integer' },
                        level: { type: 'integer' },
                        category: { type: 'string' },
                        human: { type: 'boolean' },
                        reason: { type: 'string' }
                    }
                }
            },
            model: { type: 'string' }
        }
    };

    app.post('/v1/ai/sort-inbox', {
        schema: {
            tags: ['ai'],
            summary: 'Sort inbox messages by AI-assessed danger/urgency',
            body: sortInboxBodySchema,
            response: { 200: sortResultSchema, 501: problemSchema, 502: problemSchema }
        }
    }, async (req) => {
        const provider = resolveProvider(req.body.provider);
        const result = await llm.sortInbox({ messages: req.body.messages, provider });
        if (!result.ok) reject(result);
        return { rankings: result.content, model: result.model };
    });

    const phishingScanResultSchema = {
        type: 'object',
        properties: {
            isPhishing: { type: 'boolean' },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
            indicators: { type: 'array', items: { type: 'string' } },
            // Secondary classification: unsolicited / unwanted bulk mail.
            // Independent of phishing — a message can be both, or just one.
            isSpam: { type: 'boolean' },
            spamConfidence: { type: 'number' },
            spamReasoning: { type: 'string' },
            model: { type: 'string' }
        }
    };

    app.post('/v1/ai/phishing-scan', {
        schema: {
            tags: ['ai'],
            summary: 'Scan an email for phishing indicators',
            body: phishingScanBodySchema,
            response: { 200: phishingScanResultSchema, 501: problemSchema, 502: problemSchema }
        }
    }, async (req) => {
        const provider = resolveProvider(req.body.provider);
        // Use the configured model alias (mail-ai on the LiteLLM proxy)
        // instead of pinning a specific upstream — pinning stepfun broke
        // when the proxy didn't have that backend wired and bypassed all
        // the per-user budget enforcement we added later.
        const scanProvider = { ...provider };

        // Pull the per-user feedback lists (if any) and bake them into
        // the system prompt so the model has explicit tells about what
        // this user trusts vs hates.
        const fb = req.body.userFeedback || {};
        const feedbackBlock = [];
        if (Array.isArray(fb.trustedDomains) && fb.trustedDomains.length) {
            feedbackBlock.push(`USER-TRUSTED DOMAINS (treat as legitimate unless the email itself is clearly malicious): ${fb.trustedDomains.slice(0, 60).join(', ')}.`);
        }
        if (Array.isArray(fb.trustedAddresses) && fb.trustedAddresses.length) {
            feedbackBlock.push(`USER-TRUSTED ADDRESSES (treat as legitimate): ${fb.trustedAddresses.slice(0, 60).join(', ')}.`);
        }
        if (Array.isArray(fb.spamDomains) && fb.spamDomains.length) {
            feedbackBlock.push(`USER-FLAGGED SPAM DOMAINS (lean spam=true unless the message is a personal reply): ${fb.spamDomains.slice(0, 60).join(', ')}.`);
        }
        if (Array.isArray(fb.spamAddresses) && fb.spamAddresses.length) {
            feedbackBlock.push(`USER-FLAGGED SPAM ADDRESSES (lean spam=true): ${fb.spamAddresses.slice(0, 60).join(', ')}.`);
        }

        const system = [
            'You are an expert email security analyst.',
            'Classify the provided email on TWO independent axes — phishing and spam — and return both.',
            '',
            'PHISHING — a deliberate attempt to trick the recipient into surrendering credentials, money, or sensitive information, OR a self-declared/vendor-marked phishing simulation. Look for:',
            '- Suspicious sender addresses (spoofed domains, lookalikes)',
            '- Urgency tactics, threats, or false deadlines',
            '- Requests for passwords, credentials, 2FA codes, or personal info',
            '- Suspicious links or mismatched display URLs',
            '- Generic greetings (Dear Customer, Dear User) vs personalized',
            '- Spelling/grammar issues or unusual formatting',
            '- Unusual attachments or requests to download files',
            '- Requests to verify, confirm, or reactivate account details',
            '- Unexpected invoices, shipping notifications, or legal threats',
            '- Image-only bodies, or bodies whose visible text only appears via OCR (a classic evasion of text-based filters)',
            'Phishing simulations / training emails (KnowBe4, Cofense/PhishMe, Proofpoint, Mimecast, Hoxhunt, …) count as phishing for this scan — the user is to be warned.',
            'CRITICAL false-positive guardrails for phishing:',
            ' - Real Google security/sign-in alerts (from no-reply@accounts.google.com or @google.com), real Microsoft/Apple/Amazon transactional mails, and real bank account-activity emails are NOT phishing just because they ask the user to "review" or "verify". They are only phishing when the LINK targets a non-matching domain or the sender envelope is spoofed.',
            ' - Genuine 2FA codes, password-reset emails the user clearly requested, real receipts, real shipping notifications, real meeting invites, real employer comms — NOT phishing.',
            ' - When uncertain, set isPhishing=false with a moderate confidence rather than over-flagging.',
            '',
            'SPAM — unsolicited or low-value bulk mail the user almost certainly does not want, but is NOT trying to defraud them. Be AGGRESSIVE about catching:',
            ' - Promotional newsletters with sale headlines: "X% off", "limited time", "today only", "shop now", "your basket is waiting", "you may also like".',
            ' - Drip-marketing onboarding ("did you know we offer…", "tip of the week", "we miss you"), product announcements from SaaS vendors, "new feature" mailers.',
            ' - Cold sales outreach: "I noticed your website", "quick question", "5 min chat", "the leadership team thought…", template-style intros to people the user has never replied to.',
            ' - Charity/political fundraising solicitations the user did not opt into.',
            ' - Survey requests and feedback nags from sites the user once visited.',
            ' - Discount voucher / catalogue / "your weekly digest" emails. List-Unsubscribe header is a strong tell.',
            'NOT spam: personal correspondence, transactional receipts, 2FA codes, calendar invites, security alerts the user expected, employer/team communication, alerts from tools the user runs.',
            'When the body is mostly imagery + a single CTA button + an unsubscribe link, that is almost always marketing slop — flag it spam unless the brand is one the user clearly transacts with.',
            'A message can be BOTH phishing and spam (e.g. a malicious cold pitch) or one or the other — set the two booleans independently.',
            '',
            ...(feedbackBlock.length ? ['USER FEEDBACK (apply BEFORE the heuristics above):', ...feedbackBlock, ''] : []),
            'When OCR text from inline/attached images is provided, treat it as part of the body for both classifications.',
            '',
            'Return ONLY a valid JSON object with this exact shape. No markdown, no commentary, no code fences:',
            '{"isPhishing":true|false,"confidence":0.0-1.0,"reasoning":"brief explanation","indicators":["specific red flag 1","specific red flag 2"],"isSpam":true|false,"spamConfidence":0.0-1.0,"spamReasoning":"brief explanation"}'
        ].join('\n');

        // Build an Authentication-Results summary line so the model can
        // weight DKIM/SPF/DMARC verdicts. Pass = strong "not spoofed";
        // fail = strong "treat as phishing"; missing = uninformative.
        const auth = req.body.auth;
        const authLine = auth
            ? `Authentication-Results — SPF: ${auth.spf || 'not checked'} · DKIM: ${auth.dkim || 'not checked'} · DMARC: ${auth.dmarc || 'not checked'}`
            : 'Authentication-Results: not provided';
        const authHint = auth && (auth.spf === 'fail' || auth.dkim === 'fail' || auth.dmarc === 'fail')
            ? '\n[Hint: at least one auth check FAILED — strongly increases phishing likelihood when the message claims to be from a major brand.]'
            : (auth && (auth.spf === 'pass' || auth.dkim === 'pass') && !(auth.spf === 'fail' || auth.dkim === 'fail' || auth.dmarc === 'fail'))
                ? '\n[Hint: SPF/DKIM passed — ruling out the obvious sender-spoof tier of phishing. Spam can still apply if content is promotional.]'
                : '';

        const userPrompt = [
            req.body.headers ? `Headers:\n${req.body.headers}\n` : '',
            authLine,
            `Subject: ${req.body.subject || '(no subject)'}`,
            `From: ${req.body.from || ''}`,
            `To: ${req.body.to || ''}`,
            '',
            'Body:',
            req.body.body || '',
            req.body.html ? `\nHTML snippet (first 8KB):\n${req.body.html.slice(0, 8192)}` : '',
            authHint
        ].join('\n');

        const result = await llm.chat({ provider: scanProvider, system, userPrompt });
        if (!result.ok) reject(result);

        try {
            const cleaned = result.content.replace(/^```json\s*|\s*```$/g, '').trim();
            const json = JSON.parse(cleaned);
            // Models drift between 0-1 and 0-100 scales; the prompt asks
            // for 0-1 but tolerate either by normalizing values >1.
            const norm = (n) => {
                const v = Number(n) || 0;
                const v01 = v > 1 ? v / 100 : v;
                return Math.max(0, Math.min(1, v01));
            };
            return {
                isPhishing: !!json.isPhishing,
                confidence: norm(json.confidence),
                reasoning: String(json.reasoning || ''),
                indicators: Array.isArray(json.indicators) ? json.indicators.map(String) : [],
                isSpam: !!json.isSpam,
                spamConfidence: norm(json.spamConfidence),
                spamReasoning: String(json.spamReasoning || ''),
                model: result.model
            };
        } catch (err) {
            return {
                isPhishing: false,
                confidence: 0,
                reasoning: 'Could not parse AI response',
                indicators: [],
                isSpam: false,
                spamConfidence: 0,
                spamReasoning: '',
                model: result.model
            };
        }
    });
};
