'use strict';

// Strip credentials out of text before it is sent to a third-party model.
//
// Mail is full of secrets people didn't think of as secrets: a password
// reset that quotes the temporary password, a colleague pasting an API key,
// a signup confirmation with a one-time code. Summarising or scanning that
// mail ships it to whoever runs the model. None of these features need the
// secret itself — a summary is just as good with "[redacted:password]".
//
// This is deliberately pattern-based rather than model-based: it has to be
// deterministic, run before anything leaves the process, and never depend
// on the thing we're protecting against. That also means it is best-effort
// — it catches the shapes credentials actually take, not every conceivable
// secret. It is a reduction in exposure, not a guarantee.
//
// Bias: prefer missing an unusual secret over mangling ordinary prose. A
// redactor that eats real text gets turned off, and then it protects
// nothing.

// Vendor tokens with distinctive, unambiguous prefixes. These are safe to
// match on sight — no plausible English text looks like them.
const TOKEN_PATTERNS = [
    // OpenAI / DeepSeek / Anthropic / Mistral style
    [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'api-key'],
    [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, 'api-key'],
    // GitHub
    [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'api-key'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'api-key'],
    // AWS
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'aws-key-id'],
    // Google
    [/\bAIza[A-Za-z0-9_-]{30,}\b/g, 'api-key'],
    // Slack
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, 'api-key'],
    // Stripe
    [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, 'api-key'],
    // JSON Web Tokens
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'jwt'],
    // Private key blocks, including the body
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private-key']
];

// "<label>: <value>" where the label names a credential. The value stops at
// end of line, so a sentence mentioning the word "password" in passing is
// untouched — it only fires when something looks assigned to it.
const LABELLED_SECRET = new RegExp(
    '\\b(password|passwd|pwd|passphrase|secret|api[_ -]?key|apikey|access[_ -]?token|' +
    'auth[_ -]?token|bearer|client[_ -]?secret|private[_ -]?key|otp|one[- ]time[- ]code|' +
    '2fa[_ -]?code|verification[_ -]?code|security[_ -]?code|pin)' +
    '\\s*(?:is|=|:)\\s*' +
    '(["\']?)([^\\s"\'<>,;]{4,120})\\2',
    'gi'
);

// Basic auth embedded in a URL: https://user:secret@host
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;

// Card numbers, validated with Luhn so ordinary long digit runs (order
// numbers, phone numbers, reference codes) are left alone.
const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let n = digits.charCodeAt(i) - 48;
        if (alt) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        sum += n;
        alt = !alt;
    }
    return sum % 10 === 0;
}

function scrubText(input, counts) {
    if (typeof input !== 'string' || !input) return input;
    let out = input;

    for (const [re, kind] of TOKEN_PATTERNS) {
        out = out.replace(re, () => {
            counts[kind] = (counts[kind] || 0) + 1;
            return `[redacted:${kind}]`;
        });
    }

    out = out.replace(URL_CREDENTIALS, (_m, scheme, user) => {
        counts['url-credentials'] = (counts['url-credentials'] || 0) + 1;
        return `${scheme}${user}:[redacted:password]@`;
    });

    out = out.replace(LABELLED_SECRET, (match, label, quote, value) => {
        // A label followed by an obvious placeholder is not a secret, and
        // redacting it just makes the text harder to read.
        if (/^(?:\*+|x+|•+|-+|none|n\/a|null|unchanged|hidden|redacted)$/i.test(value)) return match;
        counts[label.toLowerCase().replace(/[_ -]/g, '')] =
            (counts[label.toLowerCase().replace(/[_ -]/g, '')] || 0) + 1;
        const sep = match.slice(label.length, match.indexOf(value, label.length));
        return `${label}${sep}[redacted]`;
    });

    out = out.replace(CARD_CANDIDATE, (m) => {
        const digits = m.replace(/[ -]/g, '');
        if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return m;
        counts['card-number'] = (counts['card-number'] || 0) + 1;
        return '[redacted:card-number]';
    });

    return out;
}

// Walk an OpenAI-shaped messages array, scrubbing every text field we can
// reach. Content may be a string or the multimodal array form.
function scrubMessages(messages) {
    const counts = {};
    if (!Array.isArray(messages)) return { messages, counts, redacted: 0 };
    const cleaned = messages.map((m) => {
        if (!m || typeof m !== 'object') return m;
        if (typeof m.content === 'string') {
            return { ...m, content: scrubText(m.content, counts) };
        }
        if (Array.isArray(m.content)) {
            return {
                ...m,
                content: m.content.map((part) => (
                    part && typeof part === 'object' && typeof part.text === 'string'
                        ? { ...part, text: scrubText(part.text, counts) }
                        : part
                ))
            };
        }
        return m;
    });
    const redacted = Object.values(counts).reduce((a, b) => a + b, 0);
    return { messages: cleaned, counts, redacted };
}

module.exports = { scrubText, scrubMessages, luhnValid };
