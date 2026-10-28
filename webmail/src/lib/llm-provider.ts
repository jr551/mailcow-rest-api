// Single place that turns the user's AI settings into a chat-completions
// endpoint: the server's same-origin proxy when the server has AI
// configured, otherwise the user's own provider (preset or custom URL).

import { settings, capabilities, aiAuthKey } from './settings.svelte';

export interface LlmProvider { baseUrl: string; model: string; apiKey: string; }

const PRESETS: Record<string, { url: string; model: string }> = {
    mistral:    { url: 'https://api.mistral.ai/v1',          model: 'mistral-small-latest' },
    openai:     { url: 'https://api.openai.com/v1',          model: 'gpt-4o-mini' },
    groq:       { url: 'https://api.groq.com/openai/v1',     model: 'llama-3.1-70b-versatile' },
    together:   { url: 'https://api.together.xyz/v1',        model: 'meta-llama/Llama-3-8b-chat-hf' },
    ollama:     { url: 'http://127.0.0.1:11434/v1',          model: 'llama3.1' },
    perplexity: { url: 'https://api.perplexity.ai',          model: 'llama-3.1-sonar-small-128k-chat' },
    openrouter: { url: 'https://openrouter.ai/api/v1',       model: 'meta-llama/llama-3.1-8b-instruct' },
    deepseek:   { url: 'https://api.deepseek.com/v1',        model: 'deepseek-v4-flash' }
};

export function resolveProvider(): LlmProvider | null {
    if (capabilities.aiConfig?.configured) {
        return {
            baseUrl: capabilities.aiConfig.baseUrl.replace(/\/+$/, ''),
            model: capabilities.aiConfig.model,
            apiKey: aiAuthKey()
        };
    }
    const llm = settings.llm;
    if (!settings.useCustomLlm || !llm.apiKey) return null;
    const preset = PRESETS[llm.preset] || PRESETS.openai;
    return {
        baseUrl: (llm.baseUrl || preset.url).replace(/\/+$/, ''),
        model: llm.model || preset.model,
        apiKey: llm.apiKey
    };
}
