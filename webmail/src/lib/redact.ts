// PII / secret redaction for any text that flows out to a third-party LLM
// (phishing scans, inbox briefings, etc).
//
// Goal: catch the obvious foot-guns — OTPs, payment-card numbers, anything
// labelled "password" — before the body leaves the browser. Conservative
// over aggressive: a false negative is a privacy bug, a false positive is
// a usability bug. The patterns below trade some recall for precision.

const RX_OTP_LABELLED = /\b(?:one[\s-]?time\s+(?:password|passcode|code)|verification\s+code|verification\s+pin|security\s+code|auth(?:entication)?\s+code|access\s+code|confirmation\s+code|otp|2fa\s+code|mfa\s+code|sms\s+code)\b[\s:=\-–—]*['"`]?(\d[\d\s-]{3,9}\d)['"`]?/gi;

const RX_PASSWORD_LABELLED = /\b(?:password|passcode|passphrase|pwd)\b[\s:=\-–—]*['"`]?([^\s'"`,;<>\n\r]{4,})['"`]?/gi;

const RX_API_KEY_LABELLED = /\b(?:api[_\s-]?key|secret(?:[_\s-]?key)?|access[_\s-]?token|bearer[_\s-]?token|auth[_\s-]?token)\b[\s:=\-–—]*['"`]?([A-Za-z0-9_\-\.]{16,})['"`]?/gi;

// Distinctive vendor-token shapes do not need a label. This matters for
// direct-to-provider calls and Error Doctor, where an upstream error can
// quote a key without ever saying "apiKey:" first.
const RX_VENDOR_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[abposr]-[A-Za-z0-9-]{10,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;

// Authorization headers and URL user-info can appear in fetch errors without
// a vendor prefix. Mirror the server scrubber so direct-to-provider Error
// Doctor requests get the same protection as server-brokered AI calls.
const RX_BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}=*/gi;
const RX_BASIC_AUTH = /\b(Authorization\s*:\s*Basic\s+)[A-Za-z0-9+\/]{8,}=*/gi;
const RX_URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const RX_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// 13–19 digit runs grouped by spaces or dashes, validated against Luhn.
// The grouping rules out long numeric IDs that aren't actually card-like.
const RX_CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhn(digits: string): boolean {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let n = digits.charCodeAt(i) - 48;
        if (n < 0 || n > 9) return false;
        if (alt) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        sum += n;
        alt = !alt;
    }
    return sum % 10 === 0;
}

/** Replace the secret capture group inside a labelled match. The secret sits
 *  at the end of the match (only an optional closing quote can follow), so it
 *  is located from the right: a plain `m.replace(secret, …)` hits the first
 *  occurrence, which can be inside the label itself ("password: word"). */
function redactCapture(m: string, secret: string): string {
    const at = m.lastIndexOf(secret);
    return m.slice(0, at) + '[REDACTED]' + m.slice(at + secret.length);
}

/** Replace OTPs, passwords, API keys, and Luhn-valid card numbers with
 *  `[REDACTED]`. Returns the cleaned text — never throws. */
export function redactSecrets(text: string): string {
    if (!text) return text;
    let out = text;

    out = out.replace(RX_OTP_LABELLED, redactCapture);
    out = out.replace(RX_PASSWORD_LABELLED, redactCapture);
    out = out.replace(RX_API_KEY_LABELLED, redactCapture);
    out = out.replace(RX_VENDOR_TOKEN, '[REDACTED]');
    out = out.replace(RX_PRIVATE_KEY, '[REDACTED]');
    out = out.replace(RX_BEARER, '$1[REDACTED]');
    out = out.replace(RX_BASIC_AUTH, '$1[REDACTED]');
    out = out.replace(RX_URL_CREDENTIALS, (_m, scheme, user) => `${scheme}${user}:[REDACTED]@`);

    out = out.replace(RX_CARD_CANDIDATE, (m) => {
        const digits = m.replace(/[\s-]/g, '');
        if (digits.length < 13 || digits.length > 19) return m;
        if (!luhn(digits)) return m;
        // Keep the last 4 — useful for the user to recognize but
        // worthless to anyone reading the LLM transcript.
        return `[REDACTED-CARD-${digits.slice(-4)}]`;
    });

    return out;
}
