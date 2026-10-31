// Outlook-style rewrite presets for selected compose text (opt-in AI).

export const COMPOSE_REWRITE_TONES = [
    { id: 'professional', label: 'Professional' },
    { id: 'casual', label: 'Casual' },
    { id: 'concise', label: 'Concise' },
    { id: 'friendly', label: 'Friendly' }
] as const;

export type ComposeRewriteTone = (typeof COMPOSE_REWRITE_TONES)[number]['id'];

export const MIN_COMPOSE_REWRITE_CHARS = 3;

export function composeRewriteToneLabel(tone: ComposeRewriteTone): string {
    return COMPOSE_REWRITE_TONES.find((t) => t.id === tone)?.label ?? tone;
}

export function selectionEligibleForRewrite(text: string): boolean {
    return (text || '').trim().length >= MIN_COMPOSE_REWRITE_CHARS;
}

/** Stable marker the e2e mock can sniff in the system prompt. */
export const COMPOSE_REWRITE_SYSTEM_MARKER = 'Outlook compose rewrite assistant';

export function buildComposeRewriteSystemPrompt(tone: ComposeRewriteTone): string {
    const toneHint =
        tone === 'professional'
            ? 'Use polished, neutral business language.'
            : tone === 'casual'
                ? 'Use relaxed, conversational language.'
                : tone === 'concise'
                    ? 'Shorten while keeping the meaning; remove filler.'
                    : 'Use warm, approachable language.';
    return [
        COMPOSE_REWRITE_SYSTEM_MARKER,
        'Rewrite ONLY the user\'s selected email text.',
        toneHint,
        'Preserve facts, names, dates, and intent.',
        'Reply with plain text only — no markdown, no quotes, no preamble.'
    ].join(' ');
}

/** Strip model wrappers and clamp length. */
export function sanitizeComposeRewriteOutput(raw: string, maxLen = 8000): string {
    let text = (raw || '').trim();
    text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (text.length > maxLen) text = text.slice(0, maxLen);
    return text;
}
