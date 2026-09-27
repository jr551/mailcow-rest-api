'use strict';

const zlib = require('node:zlib');

// Shared payload construction for the two webhook directions.
//
// Both the operator-configured forwarder (webhook-forwarder.js) and the
// per-user outbound webhooks (outbound-webhook-forwarder.js) hand a message
// to an HTTP endpoint, and both need the same things: the headers parsed off
// the raw source, a readable text body, an address list, and attachment bytes
// the receiver can actually decode. These lived as private copies in
// webhook-forwarder.js; they are here so the second caller does not become a
// third copy that drifts.

// Unfold and parse RFC822 headers from the raw source. Lower-cased keys;
// duplicates -> array.
function headersFromSource(sourceBuf) {
    const str = sourceBuf.toString('utf8');
    const end = str.search(/\r?\n\r?\n/);
    const head = end === -1 ? str : str.slice(0, end);
    const lines = head.split(/\r?\n/);
    const out = {};
    let curKey = null;
    let curVal = '';
    const push = () => {
        if (!curKey) return;
        const k = curKey.toLowerCase();
        const v = curVal.trim();
        if (out[k] === undefined) out[k] = v;
        else if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
    };
    for (const line of lines) {
        if (/^\s/.test(line) && curKey) curVal += ' ' + line.trim();
        else {
            push();
            const m = line.match(/^([^:]+):\s*(.*)$/);
            if (m) { curKey = m[1]; curVal = m[2]; } else { curKey = null; curVal = ''; }
        }
    }
    push();
    return out;
}

// Minimal HTML -> text for LLM extraction: strip tags, decode entities,
// collapse space.
function htmlToText(html) {
    if (!html) return null;
    let t = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<[^>]+>/g, ' ');
    t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    t = t.replace(/\s+/g, ' ').trim();
    return t.length ? t : null;
}

function addressList(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map((a) => ({ name: a?.name || null, address: a?.address || null }))
        .filter((a) => a.address || a.name);
}

// Quote a body the way a mail client does when replying: every line gets a
// "> " prefix, and a blank line becomes a bare ">". The receiver is usually a
// model or a script reading a flat string, so the markers are what tell it
// where the user's own words stop and the forwarded mail starts.
function quoteText(text) {
    if (!text) return '';
    return String(text)
        .split(/\r?\n/)
        .map((line) => (line.length ? `> ${line}` : '>'))
        .join('\n');
}

// The human-readable body a receiver actually reads: the user's preamble
// first, then the original quoted underneath.
//
// With no preamble the original is returned untouched — not quoted. A
// receiver that asked for no preamble is getting the raw message, and adding
// "> " markers to it would silently change the content it parses.
function composeForwardedText({ prepend, text }) {
    const body = text || '';
    const preamble = (prepend || '').trim();
    if (!preamble) return body;
    return `${preamble}\n\n${quoteText(body)}`;
}

// Attachment bytes, gzipped then base64'd.
//
// Gzip first because mail attachments are usually already-compressed formats
// (PDF, images) only sometimes, and text-ish ones (CSV, logs, vCards) shrink
// enormously — and base64 inflates by a third regardless, so compressing
// before encoding is what keeps a payload inside a sane size. The instruction
// string travels with the bytes because a receiver that has to guess the
// encoding will guess wrong.
function encodeAttachment(buf) {
    const gz = zlib.gzipSync(buf);
    return {
        encoding: 'base64+gzip',
        content: gz.toString('base64'),
        compressedBytes: gz.length,
        instructions:
            'Base64-decode, then gunzip, to recover the original file bytes. ' +
            'Node: zlib.gunzipSync(Buffer.from(content, "base64")). ' +
            'Python: gzip.decompress(base64.b64decode(content)).'
    };
}

const ATTACHMENT_SCHEME_INSTRUCTIONS =
    'Each attachment is gzip-compressed and then base64-encoded. To recover a file: ' +
    'base64-decode `content`, then gunzip the result. ' +
    'Node: zlib.gunzipSync(Buffer.from(att.content, "base64")). ' +
    'Python: gzip.decompress(base64.b64decode(att.content)). ' +
    '`bytes` is the original uncompressed size; `compressedBytes` is the size of the decoded payload.';

module.exports = {
    headersFromSource,
    htmlToText,
    addressList,
    quoteText,
    composeForwardedText,
    encodeAttachment,
    ATTACHMENT_SCHEME_INSTRUCTIONS
};
