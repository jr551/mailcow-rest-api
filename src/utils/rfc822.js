'use strict';

// Building a synthetic RFC822 message in-process.
//
// The rules here are the ones src/routes/webhook-inbox.js has been using to
// wrap a POSTed webhook body into a message it can APPEND to a mailbox. They
// are reproduced here rather than shared by import because that file builds
// *ingest* mail (From: webhook-<id>@, X-Webhook-Inbox: …) and this builds
// *Sent* records for an outbound delivery. Same guarantees, different
// envelope — and neither is a place where a second, lazier implementation is
// acceptable:
//
//   * a CR/LF in a header value is how a "subject" becomes an injected Bcc,
//   * a non-ASCII header has to be RFC 2047 encoded or Dovecot rejects it,
//   * every line break in the result is CRLF, because that is what RFC 5322
//     says and half the clients that render it are strict about it.

// CR/LF in a header value is how a "subject" becomes an injected Bcc.
function headerSafe(value, fallback, maxLength = 200) {
    const clean = String(value || '').replace(/[\r\n]+/g, ' ').trim();
    return clean.slice(0, maxLength) || fallback;
}

// RFC 2047-encode a header phrase when it isn't plain ASCII.
function encodePhrase(value) {
    if (/^[\x20-\x7e]*$/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// A display name containing a quote, comma, colon or backslash is not a bare
// atom sequence, so it has to be a quoted-string. Without this a label like
// Ops "eu" produced a From line that parses as two addresses.
function formatPhrase(value) {
    if (!/^[\x20-\x7e]*$/.test(value)) return encodePhrase(value);
    if (!/[",:;<>@()[\]\\]/.test(value)) return value;
    return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

module.exports = { headerSafe, encodePhrase, formatPhrase };
