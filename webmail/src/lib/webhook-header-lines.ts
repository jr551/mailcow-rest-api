// Raw header lines → the `headers` map the outbound-webhook API takes.
//
// WHY A PARSE BOX AND NOT A NAME/VALUE REPEATER: what a user actually has
// when they reach this form is one line of text somebody else wrote —
// `Authorization: Bearer crsr_…` — and the repeater made them re-type it
// into two boxes and press "Add header" again for the next one. This module
// is the parse half of the paste box that replaced it; Settings.svelte is
// the render half.
//
// PARITY WITH THE SERVER IS THE POINT. src/utils/webhook-headers.js
// (sanitizeWebhookHeaders) is the enforcement, and it is deliberately
// strict for a request-forgery surface: RFC 7230 token names, printable
// ASCII values with no CR/LF, at most 10 headers, and a reserved-name
// blocklist. Mirroring those rules here means a bad line is reported
// against the LINE THAT IS WRONG, not as one opaque form-level error
// naming a name the user has to go hunting for. If a rule is added
// server-side and not here, the server is still right and the client is
// merely less helpful — the client is a convenience layer, never the gate.
//
// The one rule that CANNOT be mirrored exactly: the server counts 10
// headers per object, i.e. after duplicate names collapse. This counts
// LINES, so an 11th line is reported at the line. Eleven lines where two
// share a name collapse to ten names and are accepted — which is correct,
// because the map is the contract and the map is what the server sees.

/** The value the server substitutes for a stored credential it will never
 *  return again: the header NAMES come back, the VALUES never do. Only
 *  names are meaningful in a re-opened editor. */
export const MASKED_VALUE = '•••';

// RFC 7230 token — the legal header-name alphabet. Same expression as
// src/utils/webhook-headers.js; changing one without the other is the bug
// this comment exists to prevent.
const NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
// Printable ASCII plus space and tab. Mirrors VALUE_RE server-side. No
// CR/LF, so a pasted block can never become a header-injection vector.
const VALUE_RE = /^[\t\x20-\x7E]*$/;

const MAX_HEADERS = 10;
const MAX_VALUE = 2000;

// Transport- and signature-critical names. `x-webhook-*` is handled
// separately below because it is a PREFIX rule, not set membership.
const RESERVED: ReadonlySet<string> = new Set([
    'content-type',
    'user-agent',
    'host',
    'content-length',
    'connection',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'keep-alive',
    'proxy-authorization'
]);

/** One pasted line, resolved to a header. */
export type HeaderLine = {
    /** 1-based number in the textarea, so an error can point at it. */
    line: number;
    /** The header name. '' when the line is not a header at all. */
    name: string;
    /** The value. '' when the line carried none. */
    value: string;
};

/** One rejected line, addressed to the user by its number in the box. */
export type HeaderLineError = {
    line: number;
    message: string;
};

/** The textarea's contents → the map to send, and a verdict. */
export type HeaderParse = {
    /** The map `createOutboundWebhook` takes: `{ "Authorization": "Bearer …" }`. */
    headers: Record<string, string>;
    /** Per-line rejections, in paste order, for the message list under the box. */
    errors: HeaderLineError[];
    /** Non-header lines (no separator, blank, comment) that were dropped.
     *  These are NOT errors — typing half a line while still thinking must
     *  not turn the form red — but they are reported once at save so a
     *  pasted block with a stray word in it does not silently lose that word. */
    ignored: HeaderLineError[];
    /** True when nothing but blanks and comments was pasted. */
    empty: boolean;
};

/**
 * Split one pasted line into a name and a value.
 *
 * Accepted shapes, all case-insensitively:
 *   Authorization: Bearer abc     RFC 9110 header field — the real case
 *   authorization: Bearer abc     the same, lowercased
 *   Authorization=Bearer abc      shell export / netrc
 *   Authorization : Bearer abc    whitespace around the separator
 *   Authorization:                empty value, still a header
 *   Authorization                 no separator → NOT a header (dropped)
 *   # comment  /  // comment      ignored, so a pasted .env block survives
 *   curl -H 'X-Api-Key: k'        unwrapped; see below
 *
 * The separator is the FIRST one in the line. Values legitimately contain
 * colons and equals signs (`Authorization: Bearer x:y=z`, a base64 value
 * containing `=`), so splitting on the last separator would corrupt the
 * value — which for a masked, write-only credential means it can never be
 * checked or corrected by the user afterwards.
 *
 * The `curl -H` unwrap is a courtesy, not a rule: `-H '…'` is the single
 * most common way a raw header line reaches a human (the docs for half
 * these receivers show a curl command), and rejecting it would be right by
 * the letter of the rules and useless in practice.
 */
export function splitHeaderLine(raw: string): { name: string; value: string } | null {
    const line = raw.trim();
    if (!line) return null;
    if (line.startsWith('#') || line.startsWith('//')) return null;
    const curl = /^curl\b.*\s-H\s+(['"])(.*?)\1\s*$/i.exec(line);
    if (curl) return splitHeaderLine(curl[2] as string);

    const colon = line.indexOf(':');
    const eq = line.indexOf('=');
    if (colon === -1 && eq === -1) return null;
    const cut = eq !== -1 && (colon === -1 || eq < colon) ? eq : colon;
    const name = line.slice(0, cut).trim();
    if (!name) return null;
    return { name, value: line.slice(cut + 1).trim() };
}

/**
 * Parse the whole box. Runs every server-side rule per line so the user
 * sees which line is wrong and why, instead of one form-level error after
 * a round trip.
 */
export function parseHeaderLines(text: string, opts: { masked?: 'allow' | 'reject' } = {}): HeaderParse {
    // Default 'allow': the primary use of this function is re-displaying a
    // stored webhook, whose values are all masks.
    const masked = opts.masked ?? 'allow';
    const headers: Record<string, string> = {};
    const errors: HeaderLineError[] = [];
    const ignored: HeaderLineError[] = [];
    let valid = 0;

    const rawLines = text.split('\n');
    for (let i = 0; i < rawLines.length; i++) {
        const lineNo = i + 1;
        const split = splitHeaderLine(rawLines[i] as string);
        if (!split) {
            if ((rawLines[i] as string).trim()) {
                ignored.push({ line: lineNo, message: 'not a header — no ":" or "=" in it' });
            }
            continue;
        }
        const { name, value } = split;
        let message = '';
        // A masked line is a NAME with the server's placeholder, and the
        // server will never hand back the real value. Accepting `•••` as a
        // value on a SEND would be the worst outcome available for a
        // write-only credential: the save would succeed, the receiver would
        // 401 every delivery, and nothing on screen would say why. Callers
        // about to send require a real value; callers only re-displaying a
        // stored webhook keep the default, because that is exactly what a
        // re-opened box must contain.
        // The mask check comes FIRST and is a branch, not a test appended to
        // the chain, because MASKED_VALUE is U+2022 BULLET — not ASCII — so
        // in 'allow' mode it would otherwise be caught by VALUE_RE below and
        // rejected as "characters that cannot go on the wire". That rejection
        // is correct in principle (you really cannot send a bullet) and fatal
        // in practice: it is the exact text the server hands back for every
        // stored header, so the round trip would break on every re-opened
        // webhook. Handling it here is what makes 'allow' mean anything.
        const isMask = value === MASKED_VALUE;
        if (isMask && masked === 'reject') {
            message = `"${name}" is showing the stored secret, which cannot be read back — type the real value to set it, or delete the line to drop the header`;
        } else if (!NAME_RE.test(name)) {
            message = `"${name}" is not a valid header name`;
        } else if (!isMask) {
            // A mask in 'allow' mode skips every remaining rule on purpose:
            // it is never sent, and it is exactly the text the server hands
            // back. Only the NAME is still checked, above, because a masked
            // header is re-displayed and a bad name in the display is still
            // a bad name.
            const lower = name.toLowerCase();
            if (RESERVED.has(lower)) {
                message = `"${name}" is reserved and cannot be set`;
            } else if (lower.startsWith('x-webhook-')) {
                message = `"${name}" is reserved (x-webhook-* names carry our signature)`;
            } else if (value.length > MAX_VALUE) {
                message = `"${name}" exceeds ${MAX_VALUE} characters`;
            } else if (!VALUE_RE.test(value)) {
                message = `"${name}" contains characters that cannot go on the wire`;
            } else if (valid === MAX_HEADERS) {
                message = `over the ${MAX_HEADERS}-header limit`;
            }
        }
        if (message) {
            errors.push({ line: lineNo, message });
            continue;
        }
        // A repeated name replaces: the map is the contract, so the last
        // line wins exactly as it would in an object literal.
        headers[name] = value;
        valid++;
    }

    return { headers, errors, ignored, empty: valid === 0 && errors.length === 0 };
}

/**
 * Rebuild the box's contents from a stored webhook's headers map.
 *
 * The server masks every stored value: `GET /v1/me/outbound-webhooks`
 * returns `{ Authorization: '•••' }` and nothing else, forever. A stored
 * secret cannot be read back, so the honest rendering is the NAME with the
 * mask as an explicit marker — never a blank value, which would read as
 * "this header has no value" and invite a save that blanks the credential.
 * Names sort so re-opening the same webhook twice gives the same text.
 */
export function formatHeaderLines(headers: Record<string, string> | null | undefined): string {
    if (!headers) return '';
    return Object.keys(headers)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .map((name) => `${name}: ${headers[name] ?? MASKED_VALUE}`)
        .join('\n');
}
