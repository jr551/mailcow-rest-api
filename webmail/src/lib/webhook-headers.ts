// Custom request-header rows → the `headers` map the outbound-webhook API
// takes, plus the validation the form shows before it ever calls the server.
//
// This module used to parse a pasted `Name: value` textarea. It became a
// name/value row list when the API stopped returning masked values: with
// nothing readable coming back, the editor's job is "build a fresh map" and
// a row per header is the honest shape for that.
//
// PARITY WITH THE SERVER IS THE POINT. src/utils/webhook-headers.js
// (sanitizeWebhookHeaders) is the enforcement, and it is deliberately strict
// for a request-forgery surface: RFC 7230 token names ≤64 chars, printable
// ASCII values with no CR/LF ≤1024 chars, at most 16 headers, and a
// reserved-name blocklist. Mirroring those rules here means a bad row is
// reported against the ROW that is wrong, not as one opaque form-level error
// naming a name the user has to go hunting for. If a rule is added
// server-side and not here, the server is still right and the client is
// merely less helpful — the client is a convenience layer, never the gate.
//
// Two rules are deliberately STRICTER than the server:
//  - A row with a name but no value is an error. The server accepts an
//    empty string, but in the editor an empty value reads as "leave it
//    alone" — and a PATCH that carried it would REPLACE the stored
//    credential with nothing, silently breaking every delivery. "Needs a
//    value" forces the real choice: type it or delete the row.
//  - Duplicate names are an error. The server resolves a repeat as
//    last-wins object semantics; in a row editor a duplicate is a mistake
//    the user wants pointed at, not a merge rule they never asked for.

// RFC 7230 token — the legal header-name alphabet, capped at 64 chars.
// Same expression as src/utils/webhook-headers.js; changing one without the
// other is the bug this comment exists to prevent.
const NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
// Printable ASCII plus space and tab. Mirrors VALUE_RE server-side. No
// CR/LF, so a pasted block can never become a header-injection vector.
const VALUE_RE = /^[\t\x20-\x7E]*$/;

export const MAX_HEADERS = 16;
export const MAX_NAME_LENGTH = 64;
export const MAX_VALUE_LENGTH = 1024;

// Transport-critical names the client must never send (the server rejects
// the same set, case-insensitively). Content-Type and User-Agent are NOT
// here: the deliverer merges custom headers over its own defaults, so
// overriding them is legitimate. What can never be overridden is the
// signature pair — those two exact names are blocked because letting a user
// set them would let a webhook forge or clobber the proof that a POST came
// from us. Other x-* names are fine.
const RESERVED: Record<string, true> = {
    'host': true,
    'content-length': true,
    'connection': true,
    'transfer-encoding': true,
    'upgrade': true,
    'te': true,
    'trailer': true,
    'keep-alive': true,
    'proxy-authenticate': true,
    'proxy-authorization': true,
    'x-webhook-timestamp': true,
    'x-webhook-signature-v2': true
};

/** One editable name/value row in the form. */
export type HeaderRow = {
    name: string;
    value: string;
};

/** One rejected row, addressed to the user by its position in the list. */
export type HeaderRowError = {
    /** 0-based index into the rows array; the UI renders it as `row + 1`. */
    row: number;
    message: string;
};

/** The rows → the map to send, and a verdict. */
export type HeaderRowsResult = {
    /** The map `createOutboundWebhook`/`updateOutboundWebhook` take. */
    headers: Record<string, string>;
    /** Per-row rejections, in row order, for the list under the editor. */
    errors: HeaderRowError[];
    /** Number of rows that produced a header (blank rows don't count). */
    count: number;
};

/**
 * Validate the row list. Runs every server-side rule per row so the user
 * sees which row is wrong and why, instead of one form-level error after a
 * round trip. Rows where both fields are blank are skipped entirely — a
 * half-finished "Add header" click is not an error.
 */
export function validateHeaderRows(rows: HeaderRow[]): HeaderRowsResult {
    const headers: Record<string, string> = {};
    const errors: HeaderRowError[] = [];
    const seen = new Map<string, number>();
    let count = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as HeaderRow;
        const name = row.name.trim();
        const value = row.value.trim();
        // Fully blank row: skipped, not an error.
        if (!name && !value) continue;
        let message = '';
        if (!name) {
            message = 'Header needs a name';
        } else if (!NAME_RE.test(name)) {
            message = name.length > MAX_NAME_LENGTH
                ? `"${name.slice(0, 40)}…" exceeds ${MAX_NAME_LENGTH} characters`
                : `"${name}" is not a valid header name`;
        } else if (RESERVED[name.toLowerCase()]) {
            message = `"${name}" is reserved and cannot be set`;
        } else if (!value) {
            // Stricter than the server on purpose — see the module comment.
            // An empty value on a PATCH that replaces the whole map reads
            // as "keep it" and stores nothing, which is the one silent
            // break this form can produce.
            message = `"${name}" needs a value — delete the row to drop the header`;
        } else if (value.length > MAX_VALUE_LENGTH) {
            message = `"${name}" exceeds ${MAX_VALUE_LENGTH} characters`;
        } else if (!VALUE_RE.test(value)) {
            message = `"${name}" contains characters that cannot go on the wire`;
        } else if (seen.has(name.toLowerCase())) {
            // Index math so the message names the earlier row, which is the
            // one the user is more likely to want to fix or remove.
            message = `"${name}" is already set on row ${(seen.get(name.toLowerCase()) ?? 0) + 1}`;
        } else if (count >= MAX_HEADERS) {
            message = `over the ${MAX_HEADERS}-header limit`;
        }
        if (message) {
            errors.push({ row: i, message });
            continue;
        }
        seen.set(name.toLowerCase(), i);
        headers[name] = value;
        count++;
    }

    return { headers, errors, count };
}
