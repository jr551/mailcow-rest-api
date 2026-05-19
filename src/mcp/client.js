'use strict';

const { request } = require('undici');

// Thin wrapper over the mailcow-rest-api REST API for use by the MCP server.
// Each method is one HTTP call. Errors are normalized to Error with a `.status`
// field so the MCP server can render structured failures back to the LLM.

class RestClient {
    constructor({ baseUrl, user, pass, timeoutMs = 90_000 }) {
        if (!baseUrl) throw new Error('baseUrl is required');
        if (!user || !pass) throw new Error('user and pass are required');
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
        this.timeoutMs = timeoutMs;
    }

    async _call(method, path, { body, query, accept = 'application/json' } = {}) {
        const url = new URL(this.baseUrl + path);
        if (query) {
            for (const [k, v] of Object.entries(query)) {
                if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
            }
        }
        const headers = { 'authorization': this.authHeader, 'accept': accept };
        let payload;
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const signal = AbortSignal.timeout(this.timeoutMs);
        let res;
        try {
            res = await request(url, { method, headers, body: payload, signal });
        } catch (err) {
            const e = new Error(`Network error calling ${method} ${path}: ${err.message}`);
            e.status = 0;
            throw e;
        }
        const status = res.statusCode;
        const ctype = res.headers['content-type'] || '';
        let parsed;
        if (status === 204) {
            // Drain the (empty) body so undici returns the socket to the pool.
            await res.body.dump();
            parsed = null;
        } else if (ctype.startsWith('text/') && !ctype.includes('json')) {
            // Explicit text response (e.g. text/plain from OCR endpoint).
            parsed = await res.body.text();
        } else {
            // Default: try JSON, fall back to text.
            const text = await res.body.text();
            try {
                parsed = text ? JSON.parse(text) : null;
            } catch {
                parsed = text;
            }
        }
        if (status >= 400) {
            const detail = (parsed && typeof parsed === 'object' && parsed.detail)
                || (parsed && typeof parsed === 'object' && parsed.title)
                || (typeof parsed === 'string' ? parsed : `HTTP ${status}`);
            const e = new Error(detail);
            e.method = method;
            e.path = path;
            e.status = status;
            e.body = parsed;
            throw e;
        }
        return parsed;
    }

    listMailboxes() {
        return this._call('GET', '/v1/mailboxes');
    }
    createMailbox(path) {
        return this._call('POST', '/v1/mailboxes', { body: { path } });
    }
    renameMailbox(path, newPath) {
        return this._call('PUT', `/v1/mailboxes/${encodeURIComponent(path)}`, { body: { newPath } });
    }
    deleteMailbox(path) {
        return this._call('DELETE', `/v1/mailboxes/${encodeURIComponent(path)}`);
    }

    listMessages(path, { page, pageSize, search } = {}) {
        return this._call('GET', `/v1/mailboxes/${encodeURIComponent(path)}/messages`, {
            query: { page, pageSize, search }
        });
    }
    getMessage(path, uid) {
        return this._call('GET', `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}`);
    }
    ocrAttachment(path, uid, attachmentId, { format = 'text' } = {}) {
        const accept = format === 'json' ? 'application/json' : 'text/plain';
        const url = `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}/attachments/${encodeURIComponent(attachmentId)}/text`;
        return this._call('GET', url, { query: format === 'json' ? { format: 'json' } : undefined, accept });
    }

    flagMessage(path, uid, ops) {
        return this._call('PUT', `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}/flags`, {
            body: ops
        });
    }
    moveMessage(path, uid, dest) {
        return this._call('PUT', `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}/move`, {
            body: { path: dest }
        });
    }
    deleteMessage(path, uid) {
        return this._call('DELETE', `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}`);
    }

    listBlockedSenders() {
        return this._call('GET', '/v1/me/blocked-senders');
    }
    blockSender(sender) {
        return this._call('POST', '/v1/me/blocked-senders', { body: { sender } });
    }
    unblockSender(prefid) {
        return this._call('DELETE', `/v1/me/blocked-senders/${prefid}`);
    }

    listAllowedSenders() {
        return this._call('GET', '/v1/me/allowed-senders');
    }
    allowSender(sender) {
        return this._call('POST', '/v1/me/allowed-senders', { body: { sender } });
    }
    unallowSender(prefid) {
        return this._call('DELETE', `/v1/me/allowed-senders/${prefid}`);
    }

    getMailbox() {
        return this._call('GET', '/v1/me/mailbox');
    }
    getLogins(limit) {
        return this._call('GET', '/v1/me/logins', { query: limit ? { limit } : undefined });
    }
    getAliases() {
        return this._call('GET', '/v1/me/aliases');
    }
    getTempAliases() {
        return this._call('GET', '/v1/me/temp-aliases');
    }
    createTempAlias(opts) {
        return this._call('POST', '/v1/me/temp-aliases', { body: opts || {} });
    }
    deleteTempAlias(address) {
        return this._call('DELETE', `/v1/me/temp-aliases/${encodeURIComponent(address)}`);
    }
    getSendFromAddresses() {
        return this._call('GET', '/v1/me/send-from');
    }

    listBlockedRecipients() {
        return this._call('GET', '/v1/me/blocked-recipients');
    }
    blockRecipient(recipient) {
        return this._call('POST', '/v1/me/blocked-recipients', { body: { recipient } });
    }
    unblockRecipient(recipient) {
        return this._call('DELETE', `/v1/me/blocked-recipients/${encodeURIComponent(recipient)}`);
    }

    listMailRules() {
        return this._call('GET', '/v1/me/mail-rules');
    }
    addMailRule(rule) {
        return this._call('POST', '/v1/me/mail-rules', { body: rule });
    }
    removeMailRule(id) {
        return this._call('DELETE', `/v1/me/mail-rules/${encodeURIComponent(id)}`);
    }

    getRawMessage(path, uid) {
        return this._call('GET', `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}/raw`, { accept: 'message/rfc822' });
    }

    async downloadAttachment(path, uid, attachmentId) {
        const url = new URL(this.baseUrl + `/v1/mailboxes/${encodeURIComponent(path)}/messages/${uid}/attachments/${encodeURIComponent(attachmentId)}`);
        const headers = { 'authorization': this.authHeader };
        const signal = AbortSignal.timeout(this.timeoutMs);
        const res = await request(url, { method: 'GET', headers, signal });
        const status = res.statusCode;
        const ctype = res.headers['content-type'] || 'application/octet-stream';
        const filename = res.headers['content-disposition']
            ? decodeURIComponent((res.headers['content-disposition'].match(/filename="([^"]+)"/) || [])[1] || '')
            : null;
        const chunks = [];
        for await (const chunk of res.body) chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (status >= 400) {
            const text = buf.toString('utf8');
            let parsed;
            try { parsed = JSON.parse(text); } catch { parsed = text; }
            const detail = (parsed && typeof parsed === 'object' && parsed.detail) || (typeof parsed === 'string' ? parsed : `HTTP ${status}`);
            const e = new Error(detail);
            e.status = status;
            throw e;
        }
        return {
            contentType: ctype,
            filename,
            size: buf.length,
            base64: buf.toString('base64')
        };
    }

    listCalendars() {
        return this._call('GET', '/v1/me/calendars');
    }
    listEvents(calendar, start, end) {
        return this._call('GET', `/v1/me/calendars/${encodeURIComponent(calendar)}/events`, {
            query: { start, end }
        });
    }
    getEvent(calendar, uid) {
        return this._call('GET', `/v1/me/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(uid)}`);
    }
    createEvent(calendar, event) {
        return this._call('POST', `/v1/me/calendars/${encodeURIComponent(calendar)}/events`, { body: event });
    }
    deleteEvent(calendar, uid) {
        return this._call('DELETE', `/v1/me/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(uid)}`);
    }

    sendMessage(message) {
        return this._call('POST', '/v1/messages/send', { body: message });
    }
    checkDeliveryStatus(messageId) {
        return this._call('GET', `/v1/messages/send/${encodeURIComponent(messageId)}/status`);
    }
}

module.exports = { RestClient };
