import { resolveProvider } from './llm-provider';
import { cachedChatCompletion } from './ai-cache.svelte';
import {
    buildComposeRewriteSystemPrompt,
    sanitizeComposeRewriteOutput,
    type ComposeRewriteTone
} from './compose-ai-rewrite';

export async function rewriteComposeSelection(
    selected: string,
    tone: ComposeRewriteTone,
    opts: { signal?: AbortSignal } = {}
): Promise<string | null> {
    const cfg = resolveProvider();
    if (!cfg) return null;
    const snippet = (selected || '').trim();
    if (snippet.length < 3) return null;
    try {
        const requestBody = JSON.stringify({
            model: cfg.model,
            messages: [
                { role: 'system', content: buildComposeRewriteSystemPrompt(tone) },
                { role: 'user', content: snippet.slice(0, 6000) }
            ],
            temperature: 0.5,
            max_tokens: 900,
            reasoning_effort: 'minimal',
            thinking: { type: 'disabled' }
        });
        const r = await cachedChatCompletion({
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            body: requestBody,
            scope: 'compose-rewrite',
            signal: opts.signal
        });
        if (!r.ok) return null;
        const data = JSON.parse(r.text);
        const msg = data?.choices?.[0]?.message ?? {};
        let raw: string = (msg.content || '').trim();
        if (!raw) {
            const reasoning: string =
                msg.reasoning_content
                || msg.reasoning
                || msg.provider_specific_fields?.reasoning_content
                || '';
            raw = reasoning.trim().split('\n').filter(Boolean).pop() || '';
        }
        const cleaned = sanitizeComposeRewriteOutput(raw);
        return cleaned || null;
    } catch {
        return null;
    }
}
