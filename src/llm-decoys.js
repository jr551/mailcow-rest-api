'use strict';

const crypto = require('node:crypto');
const { request } = require('undici');

// Decoy requests.
//
// The provider sees every prompt we send, and prompts made of someone's
// mail are a detailed picture of their life. Decoys dilute that picture:
// alongside the real request we send variants with the identifying parts
// substituted, so what the provider records is a set of similar-looking
// conversations of which only one happened.
//
// Be clear about what this does and doesn't buy:
//
//   * It does NOT hide that this account talks to the model, when, or
//     roughly about how much text.
//   * It does NOT help if the provider correlates on timing or ordering —
//     decoys are sent close to the real request by design.
//   * It DOES mean the literal names, numbers and addresses in the stored
//     transcript are unreliable, because most of them never existed.
//
// It also multiplies token spend by (1 + count). Off unless the operator
// turns it on, and never allowed to delay or affect the user's answer.

const FAKE_FIRST = ['Alex', 'Priya', 'Jordan', 'Mei', 'Tomas', 'Sara', 'Noor', 'Ivan', 'Lena', 'Kofi'];
const FAKE_LAST = ['Fenwick', 'Alvarez', 'Okonkwo', 'Lindqvist', 'Baptiste', 'Moreau', 'Halloran', 'Devi'];
const FAKE_ORG = ['Northwind', 'Belmont', 'Cartwright', 'Ridgeway', 'Halcyon', 'Stonebridge', 'Ferngate'];
const FAKE_TLD = ['example.com', 'example.org', 'example.net'];

function pick(list) {
    return list[crypto.randomInt(list.length)];
}

function randomDigits(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += String(crypto.randomInt(10));
    return out;
}

// Rewrite the identifying surface of a prompt: addresses, names that look
// like names, numbers, and anything already redacted. The result should
// still read as the same *kind* of message so it is not trivially
// separable from the real one by shape alone.
function perturb(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;

    // Email addresses
    out = out.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, () =>
        `${pick(FAKE_FIRST).toLowerCase()}.${pick(FAKE_LAST).toLowerCase()}@${pick(FAKE_TLD)}`);

    // Anything the scrubber already replaced becomes a plausible-looking
    // value again, so decoys don't all carry the same tell.
    out = out.replace(/\[redacted(?::[a-z-]+)?\]/g, () => randomDigits(6));

    // Money and bare numbers
    out = out.replace(/(?<![\w.])\d{2,}(?![\w.])/g, (m) => randomDigits(m.length));

    // Capitalised words that look like names / orgs. Skip sentence starts
    // and common capitalised words so the text stays readable.
    const COMMON = new Set([
        'The', 'This', 'That', 'You', 'Your', 'We', 'Our', 'They', 'It', 'If', 'Please',
        'Hi', 'Hello', 'Dear', 'Thanks', 'Regards', 'Best', 'Monday', 'Tuesday',
        'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February',
        'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
        'November', 'December', 'Subject', 'From', 'To', 'Re', 'Fwd'
    ]);
    out = out.replace(/\b[A-Z][a-z]{2,}\b/g, (m) => (COMMON.has(m) ? m : pick(FAKE_ORG)));

    return out;
}

function perturbMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map((m) => {
        if (!m || typeof m !== 'object') return m;
        if (typeof m.content === 'string') return { ...m, content: perturb(m.content) };
        if (Array.isArray(m.content)) {
            return {
                ...m,
                content: m.content.map((p) => (
                    p && typeof p === 'object' && typeof p.text === 'string'
                        ? { ...p, text: perturb(p.text) }
                        : p
                ))
            };
        }
        return m;
    });
}

// Fire N decoys without awaiting them. Errors are swallowed: a decoy that
// fails has no user-visible meaning, and surfacing it would leak the
// feature's existence into the UI.
function sendDecoys({ config, resolved, body, logger, fetcher = request }) {
    const count = config?.ai?.decoyCount || 0;
    if (!count || !resolved?.apiKey) return;
    if (!Array.isArray(body?.messages) || !body.messages.length) return;

    const url = resolved.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    for (let i = 0; i < count; i++) {
        const decoy = {
            model: resolved.model,
            messages: perturbMessages(body.messages),
            // Keep the shape close to the real request so size and settings
            // don't single it out, but never stream — nothing reads these.
            temperature: body.temperature,
            max_tokens: Math.min(body.max_tokens || 256, 256),
            ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {})
        };
        Promise.resolve()
            .then(() => fetcher(url, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${resolved.apiKey}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify(decoy),
                headersTimeout: 30_000,
                bodyTimeout: 60_000
            }))
            .then((res) => res.body?.dump?.())
            .catch((err) => logger?.debug?.({ err: err.message }, 'decoy request failed'));
    }
}

module.exports = { sendDecoys, perturb, perturbMessages };
