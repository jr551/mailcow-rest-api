/** Outlook-style mail search tag syntax (IMAP REST `search` param). */

const TAG_PREFIX = /^(from|to|cc|subject|body|has|is|before|after|larger|smaller):/i;

const TAG_ANYWHERE = /\b(from|to|cc|subject|body|has|is|before|after|larger|smaller):/i;

/** True when the query already uses tag syntax — skip NL translation. */
export function looksLikeStructuredMailSearch(query: string): boolean {
    const q = query.trim();
    if (!q) return false;
    if (TAG_PREFIX.test(q)) return true;
    if (TAG_ANYWHERE.test(q)) return true;
    return false;
}

/** Strip unsafe characters from a model-produced search string. */
export function sanitizeTranslatedSearch(raw: string): string | null {
    const s = raw
        .trim()
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 400);
    if (!s) return null;
    if (/[<>{}]/.test(s)) return null;
    return s;
}

export function parseNlSearchResponse(text: string): string | null {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        const j = JSON.parse(m[0]) as { search?: string; query?: string };
        const q = String(j.search ?? j.query ?? '').trim();
        return sanitizeTranslatedSearch(q);
    } catch {
        return null;
    }
}

export const NL_SEARCH_SYSTEM = [
    'You translate a natural-language mail search into IMAP-style search tags.',
    'Supported tokens (combine with spaces):',
    '  from:address-or-name  to:…  cc:…  subject:words  body:words',
    '  has:attachment  is:unread  is:read  is:starred  is:flagged',
    '  before:YYYY-MM-DD  after:YYYY-MM-DD',
    'Rules:',
    '- Return ONLY a JSON object: {"search":"<tag query>"}',
    '- Use tag syntax only; no prose, no quotes around the whole query.',
    '- Prefer several narrow tags over guessing unknown headers.',
    '- If the request is already tag syntax, echo it in "search".',
    '- Dates must be ISO YYYY-MM-DD when used.'
].join('\n');
