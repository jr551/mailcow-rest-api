'use strict';

const crypto = require('node:crypto');

// In-memory store for pending email-send approvals.
// Created when the API receives a /v1/messages/send request authenticated
// with Basic Auth (e.g. from the MCP client). The user must click an
// approval link before the email is actually dispatched via SMTP.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

function createPendingSendStore({ ttlMs = DEFAULT_TTL_MS } = {}) {
    const store = new Map(); // token -> { createdAt, body, user, pass, from, to, ... }

    function create(entry) {
        const token = crypto.randomBytes(32).toString('hex');
        store.set(token, {
            ...entry,
            createdAt: Date.now()
        });
        return token;
    }

    function get(token) {
        const entry = store.get(token);
        if (!entry) return null;
        if (Date.now() - entry.createdAt > ttlMs) {
            store.delete(token);
            return null;
        }
        return entry;
    }

    function remove(token) {
        return store.delete(token);
    }

    function prune() {
        const cutoff = Date.now() - ttlMs;
        for (const [token, entry] of store) {
            if (entry.createdAt < cutoff) {
                store.delete(token);
            }
        }
    }

    // Prune every 5 minutes
    const timer = setInterval(prune, 5 * 60 * 1000);
    timer.unref && timer.unref();

    function close() {
        clearInterval(timer);
        store.clear();
    }

    return { create, get, remove, prune, close };
}

module.exports = { createPendingSendStore };
