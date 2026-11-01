<script lang="ts">
    import Icon from './Icon.svelte';
    import type { MessageDetail } from '../lib/api';
    import { canSendQuickReply, quickReplyPlaceholder } from '../lib/reading-pane-quick-reply';

    interface Props {
        detail: MessageDetail;
        sending?: boolean;
        onSend: (plainText: string) => void | Promise<void>;
        onOpenFullCompose: () => void;
    }

    let { detail, sending = false, onSend, onOpenFullCompose }: Props = $props();

    let expanded = $state(false);
    let text = $state('');
    let inputEl = $state<HTMLTextAreaElement | null>(null);

    const placeholder = $derived(quickReplyPlaceholder(detail));
    const canSend = $derived(canSendQuickReply(text) && !sending);

    function focusField() {
        expanded = true;
        requestAnimationFrame(() => inputEl?.focus());
    }

    function collapse() {
        expanded = false;
        text = '';
    }

    async function submit() {
        if (!canSend) return;
        const body = text.trim();
        await onSend(body);
        collapse();
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            collapse();
            return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
        }
    }
</script>

<footer class="quick-reply" data-testid="reading-pane-quick-reply">
    <div class="quick-reply-inner" class:expanded>
        <Icon name="reply" size={14} class="quick-reply-icon" />
        {#if expanded}
            <div class="quick-reply-editor">
                <textarea
                    bind:this={inputEl}
                    bind:value={text}
                    class="quick-reply-input"
                    rows={3}
                    {placeholder}
                    aria-label={placeholder}
                    data-testid="reading-pane-quick-reply-input"
                    onkeydown={onKeydown}
                ></textarea>
                <div class="quick-reply-actions">
                    <button
                        type="button"
                        class="btn btn-primary"
                        disabled={!canSend}
                        onclick={() => void submit()}
                        data-testid="reading-pane-quick-reply-send"
                    >
                        {#if sending}<span class="spinner"></span>{/if}
                        Send
                    </button>
                    <button
                        type="button"
                        class="btn btn-ghost"
                        disabled={sending}
                        onclick={collapse}
                        data-testid="reading-pane-quick-reply-discard"
                    >
                        Discard
                    </button>
                    <button
                        type="button"
                        class="btn btn-ghost linkish"
                        disabled={sending}
                        onclick={onOpenFullCompose}
                        data-testid="reading-pane-quick-reply-full"
                    >
                        Open full reply
                    </button>
                </div>
            </div>
        {:else}
            <button
                type="button"
                class="quick-reply-trigger"
                onclick={focusField}
                data-testid="reading-pane-quick-reply-trigger"
            >
                {placeholder}
            </button>
        {/if}
    </div>
</footer>

<style>
    .quick-reply {
        flex-shrink: 0;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface);
        padding: 10px 16px 14px;
    }
    .quick-reply-inner {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        max-width: 100%;
    }
    .quick-reply-inner:not(.expanded) {
        align-items: center;
    }
    .quick-reply-icon {
        flex-shrink: 0;
        margin-top: 2px;
        color: var(--text-tertiary);
    }
    .quick-reply-trigger {
        flex: 1;
        text-align: left;
        font: inherit;
        font-size: 14px;
        color: var(--text-tertiary);
        background: var(--bg-hover);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        padding: 10px 12px;
        cursor: text;
    }
    .quick-reply-trigger:hover {
        border-color: color-mix(in srgb, var(--accent) 40%, var(--border-subtle));
        color: var(--text-secondary);
    }
    .quick-reply-input {
        flex: 1;
        min-width: 0;
        font: inherit;
        font-size: 14px;
        line-height: 1.45;
        padding: 10px 12px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: var(--bg-surface);
        color: var(--text-primary);
        resize: vertical;
    }
    .quick-reply-input:focus {
        outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
        border-color: var(--accent);
    }
    .quick-reply-inner.expanded {
        flex-wrap: nowrap;
        align-items: flex-start;
    }
    .quick-reply-editor {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .quick-reply-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
    }
    .quick-reply-inner.expanded .quick-reply-icon {
        margin-top: 12px;
    }
    .linkish {
        margin-left: auto;
    }
</style>
