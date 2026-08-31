// Parses the leading [[email:{...}]] sentinel that MessageDetail attaches
// to AI prompts when the user runs an action against an open email. The
// chat UI peels the sentinel off so it doesn't appear in the bubble; the
// LLM still sees the full content (sentinel + body) in its history.

export interface EmailContextMeta {
    subject: string;
    fromName?: string;
    fromAddr?: string;
    date?: string | null;
    preview?: string;
}

export interface ParsedMessage {
    meta: EmailContextMeta | null;
    /** Content with the sentinel + the verbose "Email context (for your reference, …)"
     *  block stripped, leaving the user's actual prompt. */
    display: string;
}

const SENTINEL = /^\s*\[\[email:({[\s\S]*?})\]\]\s*\n?/;
// Trailing block that follows the prompt — keep the LLM context in the raw
// message but hide it from the bubble. Match heading + everything after.
const CONTEXT_BLOCK = /\n+Email context \(for your reference[\s\S]*$/;

export function parseEmailContext(content: string): ParsedMessage {
    if (!content || !content.startsWith('[[email:')) {
        return { meta: null, display: content };
    }
    const m = content.match(SENTINEL);
    if (!m) return { meta: null, display: content };
    let meta: EmailContextMeta | null = null;
    try {
        const parsed = JSON.parse(m[1]);
        meta = {
            subject: typeof parsed.subject === 'string' ? parsed.subject : '',
            fromName: typeof parsed.fromName === 'string' ? parsed.fromName : '',
            fromAddr: typeof parsed.fromAddr === 'string' ? parsed.fromAddr : '',
            date: parsed.date ?? null,
            preview: typeof parsed.preview === 'string' ? parsed.preview : ''
        };
    } catch {
        return { meta: null, display: content };
    }
    const after = content.slice(m[0].length);
    const display = after.replace(CONTEXT_BLOCK, '').trim();
    return { meta, display };
}
