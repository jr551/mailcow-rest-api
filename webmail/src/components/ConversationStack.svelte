<script lang="ts">
    import { ui } from '../lib/store.svelte';
    import type { MessageDetail, MessageListItem } from '../lib/api';
    import {
        conversationOrderChronological,
        conversationSnippet,
        isConversationMessageExpanded,
        findThreadForUid
    } from '../lib/conversation-view';
    import {
        conversationAttachmentEntries,
        conversationAttachmentHint
    } from '../lib/conversation-attachments';
    import { formatFullDate, formatAddressList } from '../lib/format';
    import Avatar from './Avatar.svelte';
    import Icon from './Icon.svelte';

    interface Props {
        focusUid: number;
        /** When set (mobile), use instead of desktop `ui.messages`. */
        messages?: MessageListItem[];
        /** When set (mobile), use instead of `ui.conversationDetails`. */
        conversationDetails?: Record<number, MessageDetail>;
        /** When set (mobile), use instead of `ui.conversationStack`. */
        conversationStack?: { threadId: string; uids: number[] } | null;
    }
    let {
        focusUid,
        messages: messagesOverride,
        conversationDetails: detailsOverride,
        conversationStack: stackOverride
    }: Props = $props();

    let userExpanded = $state(new Set<number>());

    const messageList = $derived(messagesOverride ?? ui.messages);
    const stackMeta = $derived(stackOverride !== undefined ? stackOverride : ui.conversationStack);

    const thread = $derived(
        stackMeta && stackMeta.uids.length > 1 && focusUid != null
            ? findThreadForUid(messageList, focusUid)
            : null
    );

    const ordered = $derived(thread ? conversationOrderChronological(thread) : []);

    function bodyFor(uid: number): MessageDetail | undefined {
        const map = detailsOverride ?? ui.conversationDetails;
        return map[uid];
    }

    function toggleExpand(uid: number) {
        if (uid === focusUid) return;
        const next = new Set(userExpanded);
        if (next.has(uid)) next.delete(uid);
        else next.add(uid);
        userExpanded = next;
    }

    function viewText(d: MessageDetail | undefined): string {
        if (!d) return '';
        if (d.text) return d.text;
        if (d.html) return d.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return '';
    }

    $effect(() => {
        // Reset manual expansion when the user opens a different message/thread.
        focusUid;
        stackMeta?.threadId;
        userExpanded = new Set();
    });
</script>

{#if thread && ordered.length > 1}
    <div class="conversation-stack" data-testid="conversation-stack">
        {#each ordered as item (item.uid)}
            {@const expanded = isConversationMessageExpanded(item.uid, focusUid, userExpanded)}
            {@const detail = bodyFor(item.uid)}
            {@const from = item.envelope.from?.[0]}
            {@const attHint = conversationAttachmentHint(item, detail)}
            {@const attEntries = conversationAttachmentEntries(item, detail)}
            <article
                class="conv-msg"
                class:expanded
                class:collapsed={!expanded}
                data-testid={`conversation-msg-${item.uid}`}
                data-expanded={expanded ? 'true' : 'false'}
            >
                <header class="conv-head">
                    <Avatar email={from?.address} name={from?.name} size={32} />
                    <div class="conv-meta">
                        <div class="conv-from">
                            <span class="conv-name">{from?.name || from?.address || '(unknown)'}</span>
                            {#if from?.name && from?.address}
                                <span class="conv-addr muted">&lt;{from.address}&gt;</span>
                            {/if}
                        </div>
                        <time class="conv-date muted" datetime={item.internalDate || item.envelope.date || undefined}>
                            {formatFullDate(item.internalDate || item.envelope.date)}
                        </time>
                    </div>
                    {#if !expanded}
                        <button
                            type="button"
                            class="conv-expand btn btn-ghost"
                            onclick={() => toggleExpand(item.uid)}
                            data-testid={`conversation-expand-${item.uid}`}
                            aria-expanded="false"
                        >
                            Show message
                        </button>
                    {:else if item.uid !== focusUid}
                        <button
                            type="button"
                            class="conv-expand btn btn-ghost"
                            onclick={() => toggleExpand(item.uid)}
                            data-testid={`conversation-collapse-${item.uid}`}
                            aria-expanded="true"
                        >
                            Hide
                        </button>
                    {/if}
                </header>
                {#if expanded}
                    <div class="conv-body" data-testid={`conversation-body-${item.uid}`}>
                        {#if !detail}
                            <div class="conv-loading"><span class="spinner"></span></div>
                        {:else}
                            <div class="conv-recipients muted small">
                                To: {formatAddressList(detail.envelope.to)}
                            </div>
                            {#if attEntries.length > 0}
                                <ul class="conv-attachments" data-testid={`conversation-attachments-${item.uid}`}>
                                    {#each attEntries as att (att.id)}
                                        <li class="conv-att-chip">
                                            <Icon name="paperclip" size={12} />
                                            <span class="conv-att-name">{att.filename || `Attachment ${att.id}`}</span>
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                            <pre class="conv-text">{detail.text || viewText(detail) || '(no text body)'}</pre>
                        {/if}
                    </div>
                {:else}
                    <p class="conv-snippet muted" data-testid={`conversation-snippet-${item.uid}`}>
                        {conversationSnippet(detail ? viewText(detail) : '')}
                    </p>
                    {#if attHint}
                        <p class="conv-att-hint muted" data-testid={`conversation-att-hint-${item.uid}`}>
                            <Icon name="paperclip" size={12} />
                            <span>{attHint}</span>
                        </p>
                    {/if}
                {/if}
            </article>
        {/each}
    </div>
{/if}

<style>
    .conversation-stack {
        display: flex;
        flex-direction: column;
        gap: 0;
        border-top: 1px solid var(--border-subtle);
    }
    .conv-msg {
        border-bottom: 1px solid var(--border-subtle);
        padding: 12px 16px 14px;
        background: var(--bg-surface);
    }
    .conv-msg.collapsed {
        background: color-mix(in srgb, var(--bg-surface) 92%, var(--bg-hover));
        cursor: default;
    }
    .conv-msg.collapsed .conv-head {
        margin-bottom: 4px;
    }
    .conv-head {
        display: flex;
        align-items: flex-start;
        gap: 10px;
    }
    .conv-meta {
        flex: 1;
        min-width: 0;
    }
    .conv-from {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: baseline;
        font-weight: 600;
        font-size: 14px;
    }
    .conv-addr {
        font-weight: 400;
        font-size: 12px;
    }
    .conv-date {
        font-size: 12px;
    }
    .conv-expand {
        flex-shrink: 0;
        font-size: 12px;
        padding: 4px 8px;
    }
    .conv-snippet {
        margin: 0 0 0 42px;
        font-size: 13px;
        line-height: 1.35;
    }
    .conv-att-hint {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 4px 0 0 42px;
        font-size: 12px;
    }
    .conv-attachments {
        list-style: none;
        margin: 0 0 10px;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }
    .conv-att-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-hover);
        font-size: 12px;
        max-width: 100%;
    }
    .conv-att-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 220px;
    }
    .conv-body {
        margin-top: 10px;
        padding-left: 42px;
    }
    .conv-recipients {
        margin-bottom: 8px;
    }
    .conv-text {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: inherit;
        font-size: 14px;
        line-height: 1.5;
    }
    .conv-loading {
        padding: 8px 0;
    }
</style>
