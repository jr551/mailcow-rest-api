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

/** Replace OTPs, passwords, API keys, and Luhn-valid card numbers with
 *  `[REDACTED]`. Returns the cleaned text — never throws. */
export function redactSecrets(text: string): string {
    if (!text) return text;
    let out = text;

    out = out.replace(RX_OTP_LABELLED, (m, code) => m.replace(code, '[REDACTED]'));
    out = out.replace(RX_PASSWORD_LABELLED, (m, pw) => m.replace(pw, '[REDACTED]'));
    out = out.replace(RX_API_KEY_LABELLED, (m, key) => m.replace(key, '[REDACTED]'));

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
