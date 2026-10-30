import { cachedChatCompletion } from './ai-cache.svelte';
import { maybeFlagCooldown, aiCooldownActive } from './ai-cooldown.svelte';
import { settings } from './settings.svelte';
import { resolveProvider } from './llm-provider';
import {
    NL_SEARCH_SYSTEM,
    looksLikeStructuredMailSearch,
    parseNlSearchResponse
} from './natural-language-search';

function extractAssistantText(raw: string): string {
    try {
        const j = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
        return j?.choices?.[0]?.message?.content?.trim() || '';
    } catch {
        return '';
    }
}

/** Translate plain-language query to tag syntax; null → keep original query. */
export async function translateNaturalLanguageSearch(
    query: string,
    opts: { signal?: AbortSignal } = {}
): Promise<string | null> {
    const q = query.trim();
    if (!q || !settings.aiFeatures || !settings.naturalLanguageSearch) return null;
    if (looksLikeStructuredMailSearch(q)) return null;
    if (aiCooldownActive()) return null;

    const cfg = resolveProvider();
    if (!cfg) return null;

    const body = JSON.stringify({
        model: cfg.model,
        messages: [
            { role: 'system', content: NL_SEARCH_SYSTEM },
            { role: 'user', content: q }
        ],
        temperature: 0,
        max_tokens: 200
    });

    const res = await cachedChatCompletion({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        body,
        scope: 'nl-search',
        signal: opts.signal
    });

    if (!res.ok) {
        let detail = `${res.status}`;
        try {
            const j = JSON.parse(res.text) as { error?: { message?: string }; message?: string };
            detail = j?.error?.message || j?.message || detail;
        } catch { /* ignore */ }
        maybeFlagCooldown(detail);
        return null;
    }

    const text = extractAssistantText(res.text);
    return parseNlSearchResponse(text);
}
