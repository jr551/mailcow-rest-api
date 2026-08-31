// Last-second AI sanity-check on outgoing mail. Asks the LLM for
// AT MOST one short improvement suggestion (or null when nothing's
// off). Deliberately conservative — a noisy checker would just train
// the user to mash through it.
//
// The user can bypass with the modal's "Send anyway" button OR by
// holding Shift while clicking Send (skips the call entirely).

import { settings, capabilities, aiAuthKey } from './settings.svelte';
import { cachedChatCompletion } from './ai-cache.svelte';

interface ProviderCfg { baseUrl: string; model: string; apiKey: string; }
function resolveProvider(): ProviderCfg | null {
    if (capabilities.aiConfig?.configured) {
        return {
            baseUrl: capabilities.aiConfig.baseUrl.replace(/\/+$/, ''),
            model: capabilities.aiConfig.model,
            apiKey: aiAuthKey()
        };
    }
    const llm = settings.llm;
    if (!settings.useCustomLlm || !llm.apiKey) return null;
    return {
        baseUrl: (llm.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
        model: llm.model || 'gpt-4o-mini',
        apiKey: llm.apiKey
    };
}

export interface PreSendCheckInput {
    subject: string;
    body: string;
    to: string;
    cc?: string;
}

export interface PreSendCheckResult {
    /** Single short suggestion text, or null when the model thinks the
     *  email is fine to send as-is. UI hides the modal on null. */
    suggestion: string | null;
    /** Why the model thinks this matters — passed through verbatim and
     *  shown beneath the suggestion as muted text. May be empty. */
    rationale: string;
}

const SYS = [
    'You proofread an outgoing email and decide whether the writer might want to fix one thing before sending.',
    'Be conservative: only flag a real issue. Examples worth flagging:',
    '- Missing or wrong recipient ("you wrote `Dear Bob` but the To is alice@…")',
    '- Promised attachment with no attachment hint in the message',
    '- Subject says "tomorrow" but the body references a date in the past',
    '- Obvious unfinished placeholder ("[INSERT DATE HERE]", "TODO", "Lorem ipsum")',
    '- Missing close/sign-off when the body is long-form',
    '',
    'Do NOT flag style/tone, grammar nits, or shorter wording — those distract more than they help.',
    'Return ONLY a JSON object: {"suggestion": "..."} OR {"suggestion": null}',
    'Optionally include {"rationale":"..."} for the why. No prose, no markdown, no code fences.'
].join('\n');

export async function preSendCheck(
    input: PreSendCheckInput,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<PreSendCheckResult> {
    const cfg = resolveProvider();
    if (!cfg) return { suggestion: null, rationale: '' };

    const userPrompt = [
        `To: ${input.to}`,
        input.cc ? `Cc: ${input.cc}` : '',
        `Subject: ${input.subject || '(no subject)'}`,
        '',
        'Body:',
        (input.body || '').slice(0, 6000)
    ].filter(Boolean).join('\n');

    const requestBody = JSON.stringify({
        model: cfg.model,
        messages: [
            { role: 'system', content: SYS },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 220,
        reasoning_effort: 'low'
    });

    // Bound the AI call so the user never waits more than a couple
    // seconds at click-time. 4s is generous on mail-ai's median.
    const timeoutMs = opts.timeoutMs || 4500;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    if (opts.signal) {
        if (opts.signal.aborted) ctl.abort();
        else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true });
    }

    try {
        const r = await cachedChatCompletion({
            baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body: requestBody,
            scope: 'pre-send-check', signal: ctl.signal
        });
        if (!r.ok) return { suggestion: null, rationale: '' };
        const data = JSON.parse(r.text);
        const raw = (data?.choices?.[0]?.message?.content || '').trim();
        const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim();
        const json = JSON.parse(cleaned);
        const suggestion = json && typeof json.suggestion === 'string' && json.suggestion.trim()
            ? json.suggestion.trim().slice(0, 280) : null;
        const rationale = json && typeof json.rationale === 'string' ? json.rationale.trim().slice(0, 280) : '';
        return { suggestion, rationale };
    } catch {
        // Network/parse blip: don't block the send.
        return { suggestion: null, rationale: '' };
    } finally {
        clearTimeout(timer);
    }
}
