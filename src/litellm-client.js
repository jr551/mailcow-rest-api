'use strict';

// Thin client for LiteLLM proxy admin endpoints. We only need `/key/generate`
// (issue a per-user scoped key) and `/key/delete` (rotation). Everything else
// the user does goes straight from their browser to the proxy with the scoped
// key — we do NOT proxy chat/completions through here.

const { request } = require('undici');

// Outbound calls to a LiteLLM proxy can be intermittently flaky.
// undici's default connect timeout is 30s, which is unusably long: the
// /v1/ai/config handler awaits a key provision call in-line, so a single
// proxy hiccup cascades into a 30s SPA boot, /v1/ai/key/usage hangs, and
// the error doctor floods the user with 502 incidents. Fail in ~4s
// instead so the per-user-key path retries shortly after the first
// successful boot, and the SPA falls back to the shared key for the
// brief window in between.
const LITELLM_CONNECT_TIMEOUT_MS = 4000;
const LITELLM_HEADERS_TIMEOUT_MS = 5000;
const LITELLM_BODY_TIMEOUT_MS = 6000;

class LitellmClient {
    constructor({ baseUrl, masterKey, logger }) {
        if (!baseUrl) throw new Error('LitellmClient: baseUrl required');
        if (!masterKey) throw new Error('LitellmClient: masterKey required');
        // Strip trailing /v1 so we hit /key/generate (admin) not /v1/key/generate.
        this.adminUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        this.masterKey = masterKey;
        this.logger = logger || console;
    }

    async _post(path, body) {
        const url = `${this.adminUrl}${path}`;
        const res = await request(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.masterKey}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify(body),
            headersTimeout: LITELLM_HEADERS_TIMEOUT_MS,
            bodyTimeout: LITELLM_BODY_TIMEOUT_MS,
            // AbortSignal.timeout caps the WHOLE request (connect + headers
            // + body). Belt-and-suspenders against undici's default global
            // Agent connect timeout that ignores the per-request options.
            signal: AbortSignal.timeout(LITELLM_CONNECT_TIMEOUT_MS + LITELLM_HEADERS_TIMEOUT_MS)
        });
        const text = await res.body.text();
        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`LiteLLM ${path} ${res.statusCode}: ${text.slice(0, 200)}`);
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`LiteLLM ${path}: non-JSON response: ${text.slice(0, 100)}`);
        }
    }

    /**
     * Provision a key scoped to one user.
     *
     * @param {object} opts
     * @param {string} opts.userId           User identifier (we use email).
     * @param {string[]} opts.models         Whitelist of model names.
     * @param {string} [opts.keyAlias]       Friendly alias (visible in LiteLLM UI).
     * @param {number} [opts.maxBudget]      Cap in USD; null = unlimited.
     * @param {string} [opts.budgetDuration] e.g. "30d" — resets spend on cadence.
     * @param {string} [opts.duration]       Key TTL e.g. "365d"; null = no expiry.
     * @returns {Promise<{key: string, token: string, keyName: string, expires: string|null}>}
     */
    async createKey({ userId, models, keyAlias, maxBudget = null, budgetDuration, duration }) {
        const body = {
            user_id: userId,
            models,
            metadata: { provisioned_by: 'mailcow-rest-api' }
        };
        if (keyAlias) body.key_alias = keyAlias;
        if (maxBudget !== null && maxBudget !== undefined) body.max_budget = maxBudget;
        if (budgetDuration) body.budget_duration = budgetDuration;
        if (duration) body.duration = duration;

        const r = await this._post('/key/generate', body);
        return {
            key: r.key,
            token: r.token,
            keyName: r.key_name,
            expires: r.expires || null
        };
    }

    /** Revoke a key by its token (the long opaque id from createKey). */
    async deleteKey(token) {
        return this._post('/key/delete', { keys: [token] });
    }

    /**
     * Fetch live spend + budget for a key, by token (NOT the sk-... key).
     * Returns the raw `info` object — fields of interest:
     *   spend, max_budget, budget_duration, budget_reset_at
     */
    async getKeyInfo(token) {
        const url = `${this.adminUrl}/key/info?key=${encodeURIComponent(token)}`;
        const res = await request(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${this.masterKey}` },
            headersTimeout: LITELLM_HEADERS_TIMEOUT_MS,
            bodyTimeout: LITELLM_BODY_TIMEOUT_MS,
            // AbortSignal.timeout caps the WHOLE request (connect + headers
            // + body). Belt-and-suspenders against undici's default global
            // Agent connect timeout that ignores the per-request options.
            signal: AbortSignal.timeout(LITELLM_CONNECT_TIMEOUT_MS + LITELLM_HEADERS_TIMEOUT_MS)
        });
        const text = await res.body.text();
        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`LiteLLM /key/info ${res.statusCode}: ${text.slice(0, 200)}`);
        }
        const parsed = JSON.parse(text);
        return parsed.info || parsed;
    }
}

module.exports = { LitellmClient };
