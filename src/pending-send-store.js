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

    // Take the entry and delete it in one synchronous step. The approval
    // route used to get() the entry, await a full SMTP round-trip, and only
    // then remove() it — so two concurrent clicks both saw the entry and the
    // mail went out twice. JS is single-threaded, so deleting before the
    // first await closes that window entirely.
    function claim(token) {
        const entry = store.get(token);
        if (!entry) return null;
        store.delete(token);
        if (Date.now() - entry.createdAt > ttlMs) return null;
        return entry;
    }

    // Put a claimed entry back after a failed send, so the user can retry
    // the same link rather than losing the draft.
    function restore(token, entry) {
        if (!token || !entry) return false;
        store.set(token, entry);
        return true;
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

    return { create, get, claim, restore, remove, prune, close };
}

module.exports = { createPendingSendStore };
