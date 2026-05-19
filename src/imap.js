'use strict';

const { fromImapError } = require('./errors');

// Acquire a pooled IMAP client for the authenticated user, run `fn(client)`,
// then release or discard. If the operation throws, classify the error and
// discard the client if it's a connection-level failure.
async function withClient(pool, creds, fn) {
    const client = await pool.acquire(creds.hash, creds.user, creds.pass);
    try {
        const result = await fn(client);
        pool.release(creds.hash, client);
        return result;
    } catch (err) {
        const isFatal = !client.authenticated || !client.usable ||
            /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket/i.test(String(err && err.message));
        if (isFatal) pool.discard(creds.hash, client);
        else pool.release(creds.hash, client);
        throw fromImapError(err);
    }
}

// Run `fn(lock)` while holding a mailbox lock. Ensures release even on error.
async function withMailbox(client, path, readOnly, fn) {
    const lock = await client.getMailboxLock(path, { readonly: !!readOnly });
    try {
        return await fn(lock);
    } finally {
        lock.release();
    }
}

// imapflow's mailbox objects carry a non-serializable `specialUse` symbol
// and other extras. This plucks just the fields we expose.
function serializeMailbox(mb) {
    return {
        path: mb.path,
        name: mb.name,
        delimiter: mb.delimiter,
        flags: mb.flags ? [...mb.flags] : [],
        specialUse: mb.specialUse || null,
        subscribed: !!mb.subscribed
    };
}

function serializeEnvelope(env) {
    if (!env) return {};
    const mapAddrs = (a) => (a || []).map((x) => ({ name: x.name || '', address: x.address || '' }));
    return {
        date: env.date ? new Date(env.date).toISOString() : null,
        subject: env.subject || null,
        from: mapAddrs(env.from),
        sender: mapAddrs(env.sender),
        replyTo: mapAddrs(env.replyTo),
        to: mapAddrs(env.to),
        cc: mapAddrs(env.cc),
        bcc: mapAddrs(env.bcc),
        messageId: env.messageId || null,
        inReplyTo: env.inReplyTo || null
    };
}

// Walk a bodyStructure tree and count "attachment-shaped" leaves: anything
// with a Content-Disposition of "attachment", or anything with a filename
// that isn't a plain text alternative. Cheap (the server already has the
// structure parsed) and lets the client's Attachments filter work without
// a per-message round-trip.
function countAttachments(node) {
    if (!node) return 0;
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
        let total = 0;
        for (const child of node.childNodes) total += countAttachments(child);
        return total;
    }
    const type = (node.type || '').toLowerCase();
    const disposition = (node.disposition || '').toLowerCase();
    const filename = (node.dispositionParameters && node.dispositionParameters.filename) ||
        (node.parameters && node.parameters.name) ||
        null;
    const isAttachment = disposition === 'attachment' || (filename && !type.startsWith('text/'));
    return isAttachment ? 1 : 0;
}

// Parse an Authentication-Results header blob into discrete SPF / DKIM /
// DMARC verdicts. Strongest verdict wins when multiple hops appear, so
// an early "pass" isn't downgraded by a later hop that didn't run the
// check. Returns null when the header isn't present.
function parseAuthResultsHeader(rawHeader) {
    if (!rawHeader) return null;
    const text = String(rawHeader);
    const findVerdict = (key) => {
        const matches = [...text.matchAll(new RegExp(`(?:^|[\\s;])${key}\\s*=\\s*([a-z]+)`, 'gi'))];
        if (matches.length === 0) return null;
        const verdicts = matches.map((m) => m[1].toLowerCase());
        for (const v of ['pass', 'fail', 'softfail', 'neutral', 'permerror', 'temperror', 'none']) {
            if (verdicts.includes(v)) return v;
        }
        return verdicts[0];
    };
    const spf = findVerdict('spf');
    const dkim = findVerdict('dkim');
    const dmarc = findVerdict('dmarc');
    if (!spf && !dkim && !dmarc) return null;
    return { spf, dkim, dmarc };
}

function serializeListItem(msg) {
    const out = {
        uid: msg.uid,
        seq: msg.seq,
        flags: msg.flags ? [...msg.flags] : [],
        size: msg.size || 0,
        internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
        envelope: serializeEnvelope(msg.envelope)
    };
    if (msg.bodyStructure) {
        const n = countAttachments(msg.bodyStructure);
        out.attachmentCount = n;
        out.hasAttachments = n > 0;
    }
    if (msg.headers) {
        const text = Buffer.isBuffer(msg.headers) ? msg.headers.toString('utf8') : String(msg.headers);
        const auth = parseAuthResultsHeader(text);
        if (auth) out.auth = auth;
    }
    return out;
}

module.exports = { withClient, withMailbox, serializeMailbox, serializeEnvelope, serializeListItem };
