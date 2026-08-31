<script lang="ts">
    // Floating chat bubble bottom-right that talks directly from the browser
    // to the user's OpenAI-compatible LLM, with tool-calls executed against
    // /v1/* using the active session's bearer token. Conversation lives in
    // component state — refresh to clear. The user's API key never reaches
    // the imap-rest server.

    import { onMount, tick } from 'svelte';
    import { createPopover } from '@melt-ui/svelte';
    import Icon from './Icon.svelte';
    import { showToast } from '../lib/store.svelte';
    import { isChatConfigured, chatTurn, type ChatMessage, type ToolCall } from '../lib/chat.svelte';
    import { renderMarkdown } from '../lib/markdown';

    interface Props {
        // Push the bubble up when compose is open so it stops overlapping the
        // compose footer — that was the original removal reason. The panel
        // shifts in lock-step so the popover anchor stays correct.
        composeOpen?: boolean;
    }
    let { composeOpen = false }: Props = $props();

    const {
        elements: { trigger, content, arrow, close },
        states: { open }
    } = createPopover({
        positioning: { placement: 'top-end', gutter: 8 },
        forceVisible: true,
        preventScroll: false
    });

    let messages = $state<ChatMessage[]>([]);
    let input = $state('');
    let sending = $state(false);
    let scrollEl: HTMLDivElement | undefined = $state();
    let inputEl: HTMLTextAreaElement | undefined = $state();
    let lastToolCalls = $state<ToolCall[]>([]);
    let abortCtrl: AbortController | null = null;

    let configured = $derived(isChatConfigured());

    async function scrollToBottom() {
        await tick();
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    onMount(() => {
        const unsub = open.subscribe((v) => {
            if (v && inputEl) setTimeout(() => inputEl?.focus(), 50);
        });
        return unsub;
    });

    async function send() {
        const text = input.trim();
        if (!text || sending) return;
        input = '';
        messages = [...messages, { role: 'user', content: text }];
        await scrollToBottom();
        sending = true;
        abortCtrl = new AbortController();
        const pendingToolCalls: ToolCall[] = [];
        let assistantText = '';
        let assistantReasoning = '';
        try {
            for await (const ev of chatTurn(messages, { signal: abortCtrl.signal })) {
                if (ev.type === 'tool_call') {
                    const tc: ToolCall = {
                        id: `pending-${Date.now()}-${Math.random()}`,
                        name: ev.toolName!,
                        arguments: JSON.stringify(ev.toolArgs || {})
                    };
                    pendingToolCalls.push(tc);
                    lastToolCalls = [...pendingToolCalls];
                    await scrollToBottom();
                } else if (ev.type === 'message') {
                    assistantText = ev.text || '';
                    if (ev.reasoningContent) assistantReasoning = ev.reasoningContent;
                } else if (ev.type === 'error') {
                    showToast('error', ev.text || 'Chat failed');
                    messages = [...messages, { role: 'assistant', content: `_${ev.text || 'Chat failed'}_` }];
                    await scrollToBottom();
                    return;
                }
            }
            messages = [...messages, {
                role: 'assistant',
                content: assistantText,
                toolCalls: pendingToolCalls.length ? pendingToolCalls : undefined,
                ...(assistantReasoning ? { reasoningContent: assistantReasoning } : {})
            }];
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                showToast('error', (err as Error).message);
            }
        } finally {
            sending = false;
            abortCtrl = null;
            lastToolCalls = [];
            await scrollToBottom();
        }
    }

    function abort() {
        if (abortCtrl) abortCtrl.abort();
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    }

    function clearChat() {
        messages = [];
    }

    function describeArgs(args: string): string {
        try {
            const obj = JSON.parse(args);
            const entries = Object.entries(obj).filter(([_, v]) => v !== undefined && v !== '');
            if (!entries.length) return '';
            return entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
        } catch { return ''; }
    }
</script>

<button
    type="button"
    class={`bubble ${composeOpen ? 'compose-open' : ''}`}
    {...$trigger}
    use:trigger
    aria-label="Open assistant"
    data-testid="chatbot-bubble"
>
    <Icon name="sparkles" size={18} />
    <span class="bubble-label">Assistant</span>
</button>

{#if $open}
    <div
        class="panel fade-in"
        {...$content}
        use:content
        data-testid="chatbot-panel"
    >
        <div {...$arrow} use:arrow></div>
        <header class="panel-head">
            <div>
                <h3 class="panel-title">Assistant</h3>
                <p class="muted small">
                    Calls your AI directly from the browser.
                    {#if !configured}
                        <span class="warn">Configure provider in Settings → AI.</span>
                    {/if}
                </p>
            </div>
            <div class="head-actions">
                {#if messages.length}
                    <button type="button" class="btn btn-ghost" onclick={clearChat} aria-label="Clear chat" data-testid="chatbot-clear">
                        Clear
                    </button>
                {/if}
                <button class="btn btn-ghost" {...$close} use:close aria-label="Close assistant">
                    <Icon name="close" size={14} />
                </button>
            </div>
        </header>

        <div class="messages" bind:this={scrollEl} data-testid="chatbot-messages">
            {#if messages.length === 0}
                <div class="empty">
                    <div class="empty-hero" aria-hidden="true">
                        <Icon name="sparkles" size={26} />
                    </div>
                    <h4 class="empty-title">How can I help?</h4>
                    <p class="empty-sub">I can search mail, summarise threads, draft replies, and manage filter rules and your calendar.</p>
                    <ul class="suggestions">
                        <li><button type="button" onclick={() => { input = 'What\'s new in my inbox today?'; send(); }} class="suggestion-btn">
                            <Icon name="inbox" size={13} /> <span>What's new in my inbox today?</span>
                        </button></li>
                        <li><button type="button" onclick={() => { input = 'Summarise my latest unread message.'; send(); }} class="suggestion-btn">
                            <Icon name="sparkles" size={13} /> <span>Summarise my latest unread</span>
                        </button></li>
                        <li><button type="button" onclick={() => { input = 'What\'s on my calendar this week?'; send(); }} class="suggestion-btn">
                            <Icon name="calendar" size={13} /> <span>What's on my calendar this week?</span>
                        </button></li>
                        <li><button type="button" onclick={() => { input = 'List my mail rules.'; send(); }} class="suggestion-btn">
                            <Icon name="filter" size={13} /> <span>List my mail rules</span>
                        </button></li>
                    </ul>
                </div>
            {:else}
                {#each messages as m, i (i)}
                    <div class={`msg msg-${m.role}`}>
                        {#if m.toolCalls?.length}
                            <ul class="tool-chips">
                                {#each m.toolCalls as tc (tc.id)}
                                    <li class="tool-chip" title={describeArgs(tc.arguments)}>
                                        <Icon name="settings" size={11} />
                                        <code>{tc.name}</code>
                                        {#if describeArgs(tc.arguments)}<span class="tool-chip-args">{describeArgs(tc.arguments)}</span>{/if}
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                        {#if m.content}
                            <div class="msg-body">{@html renderMarkdown(m.content)}</div>
                        {/if}
                    </div>
                {/each}
                {#if sending}
                    <div class="msg msg-assistant pending" data-testid="chatbot-pending">
                        {#if lastToolCalls.length}
                            <ul class="tool-chips">
                                {#each lastToolCalls as tc (tc.id)}
                                    <li class="tool-chip"><Icon name="settings" size={11} /><code>{tc.name}</code></li>
                                {/each}
                            </ul>
                        {/if}
                        <div class="msg-body thinking">Thinking<span class="dots"><span></span><span></span><span></span></span></div>
                    </div>
                {/if}
            {/if}
        </div>

        <footer class="composer">
            <textarea
                bind:this={inputEl}
                bind:value={input}
                onkeydown={onKeydown}
                placeholder={configured ? 'Ask anything…' : 'Configure AI first'}
                disabled={!configured || sending}
                rows="2"
                data-testid="chatbot-input"
            ></textarea>
            <div class="composer-actions">
                {#if sending}
                    <button type="button" class="btn btn-secondary" onclick={abort} data-testid="chatbot-stop">Stop</button>
                {:else}
                    <button
                        type="button"
                        class="btn btn-primary"
                        onclick={send}
                        disabled={!configured || !input.trim()}
                        data-testid="chatbot-send"
                    >Send</button>
                {/if}
            </div>
        </footer>
    </div>
{/if}

<style>
    .bubble {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 60;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 16px;
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 90%, white) 0%,
            var(--accent) 60%,
            color-mix(in srgb, var(--accent) 80%, #d268f4) 100%);
        color: var(--accent-on);
        border-radius: 999px;
        box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 35%, transparent),
                    0 2px 6px rgba(0,0,0,0.15);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: transform var(--transition-fast), box-shadow var(--transition-fast),
                    bottom 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    /* Float above the compose modal's bottom edge so the two never touch. */
    .bubble.compose-open { bottom: 96px; }
    .bubble:hover {
        transform: translateY(-1px);
        box-shadow: 0 10px 28px color-mix(in srgb, var(--accent) 45%, transparent),
                    0 3px 8px rgba(0,0,0,0.18);
    }
    .bubble-label { letter-spacing: 0.01em; }

    .panel {
        position: fixed;
        right: 18px;
        bottom: 78px;
        width: min(440px, calc(100vw - 24px));
        height: min(580px, calc(100vh - 110px));
        background: var(--bg-surface);
        border: 1px solid var(--border-soft);
        border-radius: var(--radius-lg);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.18),
                    0 6px 18px rgba(0, 0, 0, 0.10);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 65;
    }

    .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        padding: 14px 16px 12px;
        border-bottom: 1px solid var(--border-subtle);
        /* Subtle accent → surface gradient gives the assistant identity
         * without overpowering the message area below. */
        background: linear-gradient(180deg,
            color-mix(in srgb, var(--accent) 14%, var(--bg-surface)) 0%,
            color-mix(in srgb, #d268f4 7%, var(--bg-surface)) 100%);
    }
    .panel-title {
        margin: 0;
        font-size: 14.5px;
        font-weight: 700;
        letter-spacing: -0.01em;
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .panel-title::before {
        content: '';
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 8px var(--accent);
    }
    .panel-head .muted { font-size: 11px; line-height: 1.35; margin: 2px 0 0; }
    .panel-head .warn { color: var(--accent-text); font-weight: 600; }
    .head-actions { display: flex; gap: 4px; }

    .messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .empty p {
        margin: 0 0 10px;
        font-size: 12.5px;
        color: var(--text-secondary);
        font-weight: 500;
    }
    .empty-hero {
        width: 56px; height: 56px;
        border-radius: 50%;
        margin: 8px auto 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 22%, var(--bg-surface)) 0%,
            color-mix(in srgb, #d268f4 18%, var(--bg-surface)) 100%);
        color: var(--accent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent),
                    0 6px 20px color-mix(in srgb, var(--accent) 22%, transparent);
    }
    .empty-title {
        margin: 0 0 4px;
        font-size: 15px;
        font-weight: 700;
        text-align: center;
        letter-spacing: -0.01em;
    }
    .empty-sub {
        margin: 0 0 14px;
        font-size: 12px;
        line-height: 1.45;
        color: var(--text-secondary);
        text-align: center;
        padding: 0 6px;
    }
    .suggestion-btn {
        display: flex;
        align-items: center;
        gap: 9px;
    }
    .suggestion-btn :global(svg) { color: var(--accent); flex-shrink: 0; }
    .suggestions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .suggestion-btn {
        text-align: left;
        width: 100%;
        padding: 10px 12px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        font-size: 12.5px;
        color: var(--text-primary);
        cursor: pointer;
        transition: background-color var(--transition-fast),
                    border-color var(--transition-fast),
                    transform var(--transition-fast);
    }
    .suggestion-btn:hover {
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-surface-alt));
        border-color: color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
        transform: translateX(2px);
    }

    .msg {
        max-width: 92%;
        font-size: 13px;
        line-height: 1.55;
    }
    .msg-user {
        align-self: flex-end;
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 22%, var(--bg-surface)) 0%,
            color-mix(in srgb, var(--accent) 12%, var(--bg-surface)) 100%);
        color: var(--text-primary);
        padding: 9px 13px;
        border-radius: 16px 16px 4px 16px;
        border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    }
    .msg-assistant {
        align-self: flex-start;
        color: var(--text-primary);
    }
    .msg-body { white-space: pre-wrap; word-wrap: break-word; }
    .msg-assistant .msg-body {
        padding: 9px 13px;
        background: var(--bg-surface-alt);
        border-radius: 16px 16px 16px 4px;
        border: 1px solid var(--border-subtle);
    }
    .msg.pending .msg-body { color: var(--text-secondary); }

    .tool-chips {
        list-style: none;
        margin: 0 0 4px;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
    }
    .tool-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        align-self: flex-start;
        padding: 3px 8px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        font-size: 11px;
        color: var(--text-secondary);
    }
    .tool-chip code { font-family: var(--font-mono); font-size: 10.5px; color: var(--accent-text); }
    .tool-chip-args {
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-tertiary);
    }

    .thinking { display: inline-flex; align-items: center; gap: 6px; }
    .dots { display: inline-flex; gap: 3px; }
    .dots span {
        width: 4px; height: 4px; border-radius: 50%;
        background: currentColor; opacity: 0.4;
        animation: dot 1.2s infinite ease-in-out;
    }
    .dots span:nth-child(2) { animation-delay: 0.15s; }
    .dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes dot { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-2px); opacity: 1; } }

    .composer {
        border-top: 1px solid var(--border-subtle);
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--bg-surface-alt);
    }
    .composer textarea {
        resize: none;
        min-height: 46px;
        max-height: 120px;
        padding: 9px 12px;
        font-size: 13px;
        line-height: 1.4;
        background: var(--bg-surface);
        border: 1px solid var(--border-soft);
        border-radius: var(--radius-md);
        color: var(--text-primary);
        font-family: inherit;
        transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    .composer textarea:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .composer textarea:disabled { opacity: 0.6; cursor: not-allowed; }
    .composer-actions { display: flex; justify-content: flex-end; }

    .small { font-size: 11px; }
</style>
