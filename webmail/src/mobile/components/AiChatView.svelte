<script lang="ts">
    import { onMount } from 'svelte';
    import {
        aiState, newThread, appendMessage, patchLastAssistant,
        setTools, deleteThread, clearAutoSend, renameThread, refreshImapSync
    } from '../../lib/ai-threads.svelte';
    import {
        chatTurn, TOOLS, META_TOOLS, SYSTEM_PROMPT, generateThreadTitle,
        isChatConfigured, type ChatMessage, type GrantableCapability,
        WRITE_TOOLS
    } from '../../lib/chat.svelte';
    import { settings, capabilities } from '../../lib/settings.svelte';
    import { mobileState, navigate, showToast } from '../lib/store.svelte';
    import Icon from '../../components/Icon.svelte';
    import type { IconName } from '../../lib/icons';
    import { renderMarkdown } from '../../lib/markdown';
    import VoiceChat from '../../components/ai/VoiceChat.svelte';
    import EmailContextCard from '../../components/ai/EmailContextCard.svelte';
    import { parseEmailContext } from '../../lib/email-context';
    import { toolDisplay } from '../../lib/tool-icons';
    import { isVoiceAvailable, isSttAvailable } from '../../lib/voice.svelte';
    import { playNotify } from '../../lib/sounds.svelte';
    import { vibrate } from '../lib/native-bridge';
    import { backgroundTasks, cancelBackgroundTask } from '../../lib/background-tasks.svelte';

    let input = $state('');
    let sending = $state(false);
    let abortCtrl: AbortController | null = null;
    // Flash the latest assistant bubble after a reply lands. Cleared
    // 2.4s later via the $effect below.
    let doneFlashThreadId = $state<string | null>(null);
    let doneFlashStamp = $state(0);

    $effect(() => {
        if (doneFlashStamp === 0) return;
        const t = setTimeout(() => {
            doneFlashStamp = 0;
            doneFlashThreadId = null;
        }, 2400);
        return () => clearTimeout(t);
    });
    let scrollBox: HTMLDivElement | undefined = $state();
    let showThreads = $state(false);
    let showSettings = $state(false);
    let pendingImages = $state<string[]>([]);
    let voiceModeOpen = $state(false);

    // Pending write approvals
    interface PendingWrite {
        name: string;
        args: Record<string, unknown>;
        resolve: (ok: boolean) => void;
    }
    let pendingWrites = $state<PendingWrite[]>([]);

    interface PendingPermission {
        capability: GrantableCapability;
        reason: string;
        resolve: (ok: boolean) => void;
    }
    let pendingPermissions = $state<PendingPermission[]>([]);

    const CAP_META: Record<GrantableCapability, { title: string; icon: IconName; can: string[]; cannot: string[] }> = {
        accessEmail: {
            title: 'Access your emails and calendar',
            icon: 'mail',
            can: ['Read and search your inbox', 'See calendar events', 'Draft replies for you to send'],
            cannot: ['Send without approval', 'Delete messages', 'Share data outside this app']
        },
        accessAllChats: {
            title: 'Look at your other conversations',
            icon: 'user',
            can: ['Reference past questions', 'Keep context across chats', 'Avoid repeating answers'],
            cannot: ['Read other users\' chats', 'Share details with anyone', 'Store history beyond this session']
        },
        webSearch: {
            title: 'Search the web with Brave',
            icon: 'globe',
            can: ['Look up current info', 'Find references and facts', 'Verify claims via Brave Search'],
            cannot: ['Browse or buy for you', 'Submit forms', 'Access your other accounts']
        }
    };

    let active = $derived(aiState.threads.find((t) => t.id === aiState.activeId) ?? null);
    let bgTask = $derived(active ? backgroundTasks().active.find((t) => t.threadId === active.id) : undefined);

    let toolCatalog = $derived.by(() => {
        const base = aiState.tools.accessEmail ? TOOLS : [];
        const meta = META_TOOLS.filter((t) =>
            t.function.name !== 'web_search' || aiState.tools.webSearch
        );
        return [...base, ...meta];
    });

    let systemPrompt = $derived.by(() => {
        const custom = (settings.aiSystemPrompt || '').trim();
        const lines = custom ? [custom] : [SYSTEM_PROMPT];
        if (aiState.tools.accessEmail) {
            lines.push('You have tools to read mail, search messages, manage filter rules, and read or change the user\'s calendar. Prefer searching first.');
        }
        if (aiState.tools.accessAllChats) {
            const summaries = aiState.threads
                .filter((t) => t.id !== aiState.activeId && t.messages.length)
                .slice(0, 20)
                .map((t) => `- "${t.title}" (${t.messages.length} messages, last update ${new Date(t.updatedAt).toISOString().slice(0,10)})`)
                .join('\n');
            if (summaries) lines.push('You may reference the user\'s other recent chat threads:\n' + summaries);
        }
        if (aiState.tools.webSearch) {
            lines.push('Web search is enabled via the `web_search` tool (Brave Search). Use it whenever the user asks about current facts, news, prices, sports, weather, definitions, or anything not in their mail/calendar. Cite sources inline as [1], [2], etc., and list full URLs at the end of your reply.');
        }
        return lines.join(' ');
    });

    let modelOverride = $derived.by(() => {
        const llm = settings.llm;
        const cfg = capabilities.aiConfig;
        const base = (llm.baseUrl || cfg?.baseUrl || '').toLowerCase();
        const preset = llm.preset || '';
        const isOR = preset === 'openrouter' || base.includes('openrouter.ai');
        const isPplx = preset === 'perplexity' || base.includes('perplexity.ai');
        if (aiState.tools.webSearch) {
            if (isPplx) return 'sonar-pro';
            if (isOR) {
                const model = cfg?.model || llm.model || 'meta-llama/llama-3.1-8b-instruct';
                return model.endsWith(':online') ? model : `${model}:online`;
            }
        }
        return undefined;
    });

    function scrollToBottom(smooth = false) {
        if (!scrollBox) return;
        if (smooth && 'scrollBehavior' in scrollBox.style) {
            scrollBox.scrollTo({ top: scrollBox.scrollHeight, behavior: 'smooth' });
        } else {
            scrollBox.scrollTop = scrollBox.scrollHeight;
        }
    }

    function answerWrite(idx: number, ok: boolean) {
        const w = pendingWrites[idx];
        if (!w) return;
        w.resolve(ok);
        pendingWrites = pendingWrites.filter((_, i) => i !== idx);
    }

    function answerPermission(idx: number, ok: boolean) {
        const p = pendingPermissions[idx];
        if (!p) return;
        if (ok) setTools({ [p.capability]: true });
        p.resolve(ok);
        pendingPermissions = pendingPermissions.filter((_, i) => i !== idx);
    }

    /** Resize + JPEG-compress an image so the resulting data URL is small
     *  enough to fit inside a chat-completion request without choking the
     *  browser fetch (the original "Failed to fetch" with 5–10 MB photos).
     *  Long edge ≤ 1024 px, JPEG q=0.82 — typically 60–250 KB. */
    function compressImage(file: File, maxEdge = 1024, quality = 0.82): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error('Could not decode image'));
                img.onload = () => {
                    const ratio = Math.min(1, maxEdge / Math.max(img.width, img.height));
                    const w = Math.max(1, Math.round(img.width * ratio));
                    const h = Math.max(1, Math.round(img.height * ratio));
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) { reject(new Error('Canvas unavailable')); return; }
                    ctx.drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.src = reader.result as string;
            };
            reader.readAsDataURL(file);
        });
    }

    function pickImage(source: 'camera' | 'gallery') {
        const el = document.createElement('input');
        el.type = 'file';
        el.accept = 'image/*';
        if (source === 'camera') el.capture = 'environment';
        el.onchange = async () => {
            const file = el.files?.[0];
            if (!file) return;
            try {
                const dataUrl = await compressImage(file);
                pendingImages = [...pendingImages, dataUrl];
            } catch {
                showToast('error', 'Could not attach image — try a smaller file.');
            }
        };
        el.click();
    }

    function removePendingImage(idx: number) {
        pendingImages = pendingImages.filter((_, i) => i !== idx);
    }

    // Luxury one-tap AI prompts shown on the empty-thread state. Each
    // tile prefills a strong opening prompt and either auto-sends (read-
    // only suggestions) or focuses the textarea (writes that need user
    // detail). Tools that need email/calendar access flip the chip on
    // first use so the user doesn't have to opt in manually.
    type QuickTool = {
        id: 'calendar-add' | 'inbox-suggest' | 'inbox-triage' | 'meeting-prep';
        emoji: string;
        title: string;
        sub: string;
        prompt: string;
        autoSend: boolean;
        needsEmail?: boolean;
    };
    const QUICK_TOOLS: QuickTool[] = [
        {
            id: 'calendar-add',
            emoji: '📅',
            title: 'AI Calendar Add',
            sub: 'Describe an event in plain English',
            prompt: 'Add to my calendar: ',
            autoSend: false,
            needsEmail: true
        },
        {
            id: 'inbox-suggest',
            emoji: '✨',
            title: 'AI Suggest',
            sub: 'What should I focus on today?',
            prompt: 'Look at my recent inbox and calendar, then suggest 3-5 specific things I should focus on today. For each, give a one-sentence reason and the exact email or event it relates to.',
            autoSend: true,
            needsEmail: true
        },
        {
            id: 'inbox-triage',
            emoji: '🧹',
            title: 'Triage Inbox',
            sub: 'Sort what matters from what doesn\'t',
            prompt: 'Triage my inbox: skim the last 30 unread messages, group them into Important / Reply Soon / Skim Later / Delete Candidates, and tell me how many in each.',
            autoSend: true,
            needsEmail: true
        },
        {
            id: 'meeting-prep',
            emoji: '🎯',
            title: 'Meeting Prep',
            sub: 'Brief me on my next meeting',
            prompt: 'Find my next calendar event in the upcoming 24 hours, then summarise what I need to know to be ready: who\'s attending, the topic, any related emails, and 2-3 talking points.',
            autoSend: true,
            needsEmail: true
        }
    ];

    async function runQuickTool(qt: QuickTool) {
        if (qt.needsEmail && !aiState.tools.accessEmail) {
            setTools({ accessEmail: true });
        }
        if (!active) newThread();
        input = qt.prompt;
        if (qt.autoSend) {
            await tickScroll();
            void handleSend();
        } else {
            // Defer focus until the textarea finishes its current
            // disabled state (sending may have just resolved).
            setTimeout(() => {
                const ta = document.querySelector<HTMLTextAreaElement>('.input-bar textarea');
                if (ta) {
                    ta.focus();
                    ta.setSelectionRange(ta.value.length, ta.value.length);
                }
            }, 50);
        }
    }

    async function handleSend() {
        const text = input.trim();
        const images = pendingImages.slice();
        if ((!text && !images.length) || sending) return;
        input = '';
        pendingImages = [];

        if (!active) newThread();
        const threadId = aiState.activeId!;
        appendMessage(threadId, { role: 'user', content: text, images: images.length ? images : undefined });
        sending = true;
        await tickScroll();

        abortCtrl = new AbortController();
        const history = active?.messages.slice() || [];

        try {
            for await (const ev of chatTurn(history, {
                signal: abortCtrl.signal,
                tools: toolCatalog,
                systemPrompt,
                modelOverride,
                threadId,
                confirmWrite: async (call) => {
                    if (!WRITE_TOOLS.has(call.name)) return true;
                    return new Promise((resolve) => {
                        pendingWrites = [...pendingWrites, { name: call.name, args: call.args, resolve }];
                    });
                },
                confirmPermission: async (req) => {
                    return new Promise((resolve) => {
                        pendingPermissions = [...pendingPermissions, { capability: req.capability, reason: req.reason, resolve }];
                    });
                }
            })) {
                // ChatTurnEvent only emits message/tool_call/error/done.
                // The previous tool_result branch was dead code — chatTurn
                // executes tools internally and folds the result into the
                // following `message` event, so we never see one.
                if (ev.type === 'message') {
                    appendMessage(threadId, {
                        role: 'assistant',
                        content: ev.text || '',
                        ...(ev.reasoningContent ? { reasoningContent: ev.reasoningContent } : {})
                    });
                } else if (ev.type === 'tool_call') {
                    if (!toolDisplay(ev.toolName || '').hidden) {
                        patchLastAssistant(threadId, {
                            toolCalls: [{
                                id: ev.toolName || 'tc',
                                name: ev.toolName || '',
                                arguments: JSON.stringify(ev.toolArgs || {})
                            }]
                        });
                    }
                } else if (ev.type === 'switching_to_bg') {
                    // Foreground hit the step cap; chat library already
                    // spawned a background runner. Append a hand-off
                    // bubble instead of an error so the UI feels calm.
                    appendMessage(threadId, {
                        role: 'assistant',
                        content: `🛎️ ${ev.text || 'Switching to a long-running background task — I\'ll notify you when it\'s done.'}`
                    });
                } else if (ev.type === 'error') {
                    appendMessage(threadId, { role: 'assistant', content: `Error: ${ev.text || ''}` });
                }
                await tickScroll();
            }
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                appendMessage(threadId, { role: 'assistant', content: `Error: ${(err as Error).message}` });
            }
        } finally {
            sending = false;
            abortCtrl = null;
            await tickScroll();
            // Soft chime + haptic so the user knows the reply landed
            // even if they switched away from the chat surface.
            playNotify();
            vibrate('success');
            doneFlashThreadId = threadId;
            doneFlashStamp = Date.now();
            if (typeof document !== 'undefined' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
                try { new Notification('AI reply ready', { body: 'Your assistant has finished a response.', silent: false }); } catch { /* */ }
            }
            // Generate AI title with emoji once we have a first assistant
            // reply. Driven by the per-thread `aiTitled` flag (mirrors
            // the desktop ChatApp logic) so action-spawned chats whose
            // auto-derived title leaked the email sentinel still get
            // upgraded to a clean LLM-generated label.
            const t = aiState.threads.find((th) => th.id === threadId);
            const firstUser = t?.messages.find((m) => m.role === 'user');
            const firstAssistant = t?.messages.find((m) => m.role === 'assistant');
            if (t && firstUser && firstAssistant && !t.aiTitled) {
                const stripped = parseEmailContext(firstUser.content).display || firstUser.content;
                generateThreadTitle(stripped, firstAssistant.content)
                    .then((result) => {
                        if (result) {
                            renameThread(threadId, `${result.emoji} ${result.title}`, { ai: true });
                        } else {
                            renameThread(threadId, t.title, { ai: true });
                        }
                    })
                    .catch(() => { renameThread(threadId, t.title, { ai: true }); });
            }
        }
    }

    async function tickScroll() {
        await new Promise((r) => requestAnimationFrame(r));
        scrollToBottom();
    }

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }

    function startNewThread() {
        newThread();
        showThreads = false;
        scrollToBottom(true);
    }

    function pickThread(id: string) {
        aiState.activeId = id;
        showThreads = false;
        scrollToBottom(true);
    }

    function handleDeleteThread() {
        if (!active) return;
        const id = active.id;
        deleteThread(id);
        showSettings = false;
        showToast('info', 'Thread deleted');
    }

    function goToSettings() {
        showSettings = false;
        mobileState.view = 'settings';
    }

    onMount(() => {
        // Always try to refresh IMAP sync when opening the AI view,
        // so mobile stays in sync with desktop.
        refreshImapSync().then(() => {
            if (!aiState.threads.length) {
                newThread();
            } else if (!aiState.activeId) {
                aiState.activeId = aiState.threads[0]?.id ?? null;
            }
        });
        // Handle auto-send from deep links
        if (aiState.pendingAutoSend && aiState.pendingAutoSend === aiState.activeId) {
            clearAutoSend();
            const last = active?.messages[active.messages.length - 1];
            if (last && last.role === 'user') handleSend();
        }
        scrollToBottom();
    });
</script>

<div class="ai-view">
    <header class="mheader">
        <button type="button" class="mbtn mbtn-ghost" onclick={() => showThreads = true}>
            <Icon name="inbox" size={18} />
        </button>
        <h1 class="truncate">{active?.title || 'AI Chat'}</h1>
        <div class="header-actions">
            {#if isVoiceAvailable() && isSttAvailable()}
                <button type="button" class="mbtn mbtn-ghost" onclick={() => voiceModeOpen = true} title="Voice chat">
                    <Icon name="mic" size={18} />
                </button>
            {/if}
            <button type="button" class="mbtn mbtn-ghost" onclick={startNewThread}>
                <Icon name="plus" size={18} />
            </button>
            <button type="button" class="mbtn mbtn-ghost" onclick={() => showSettings = true}>
                <Icon name="settings" size={18} />
            </button>
        </div>
    </header>

    {#if !isChatConfigured()}
        <div class="mempty">
            <Icon name="sparkles" size={32} />
            <p>AI is not configured.</p>
            <p class="muted small">Set an OpenAI-compatible provider in Settings → AI.</p>
        </div>
    {:else}
        <div class="tool-bar">
            {#each ['accessEmail', 'accessAllChats', 'webSearch'] as cap}
                <button
                    type="button"
                    class="tool-chip"
                    class:active={aiState.tools[cap as GrantableCapability]}
                    onclick={() => setTools({ [cap]: !aiState.tools[cap as GrantableCapability] })}
                >
                    {CAP_META[cap as GrantableCapability].title}
                </button>
            {/each}
        </div>

        {#if bgTask}
            {@const td = toolDisplay(bgTask.currentTool || '')}
            <div class="bg-task-widget" role="status" aria-live="polite" data-testid="ai-bg-task">
                <span class="bg-orb" aria-hidden="true">
                    <span class="bg-orb-ring"></span>
                    <span class="bg-orb-core">{td.emoji || '✨'}</span>
                </span>
                <div class="bg-meta">
                    <div class="bg-meta-top"><strong>{bgTask.description}</strong></div>
                    <div class="bg-meta-now">
                        <span class="bg-now-tool">{td.label || bgTask.currentTool || 'starting…'}</span>
                        <span class="bg-stat">step {bgTask.step + 1} · {bgTask.toolCount} tools</span>
                    </div>
                </div>
                <button type="button" class="bg-task-cancel" onclick={() => cancelBackgroundTask(bgTask!.id)}>Stop</button>
            </div>
        {/if}

        <div class="chat-scroll scroll-y" bind:this={scrollBox}>
            {#if !active || active.messages.length === 0}
                <div class="quick-hero">
                    <div class="quick-hero-spark" aria-hidden="true">✨</div>
                    <h2 class="quick-hero-title">Pick a tool, or just ask</h2>
                    <p class="quick-hero-sub">One-tap AI for the things you do every day.</p>
                    <div class="quick-grid">
                        {#each QUICK_TOOLS as qt (qt.id)}
                            <button
                                type="button"
                                class="quick-tile quick-tile-{qt.id}"
                                onclick={() => runQuickTool(qt)}
                                disabled={sending}
                            >
                                <span class="quick-tile-emoji" aria-hidden="true">{qt.emoji}</span>
                                <span class="quick-tile-title">{qt.title}</span>
                                <span class="quick-tile-sub">{qt.sub}</span>
                            </button>
                        {/each}
                    </div>
                </div>
            {/if}
            {#if active}
                {#each active.messages as msg, i (i)}
                    {@const isUser = msg.role === 'user'}
                    {@const isTool = msg.role === 'tool'}
                    {@const parsed = parseEmailContext(msg.content)}
                    {@const isLast = i === active.messages.length - 1}
                    {@const doneFlash = isLast && msg.role === 'assistant' && doneFlashThreadId === active.id && doneFlashStamp > 0}
                    <div class="bubble-wrap" class:user={isUser} class:tool={isTool}>
                        <div class="bubble" class:done-flash={doneFlash}>
                            {#if msg.toolCalls?.length}
                                {@const grouped = (() => {
                                    const out: { name: string; count: number }[] = [];
                                    for (const tc of msg.toolCalls!) {
                                        const last = out[out.length - 1];
                                        if (last && last.name === tc.name) last.count++;
                                        else out.push({ name: tc.name, count: 1 });
                                    }
                                    return out;
                                })()}
                                <div class="tool-call">
                                    {#each grouped as g, gi (gi)}
                                        {@const td = toolDisplay(g.name)}
                                        <span class="tool-call-chip" title={g.name}>
                                            <span class="tool-call-emoji" aria-hidden="true">{td.emoji}</span>
                                            <span>{td.label}</span>
                                            {#if g.count > 1}<span class="tool-call-count">×{g.count}</span>{/if}
                                        </span>
                                    {/each}
                                </div>
                            {/if}
                            {#if msg.images?.length}
                                <div class="image-row">
                                    {#each msg.images as img}
                                        <img src={img} alt="Attached" class="chat-img" />
                                    {/each}
                                </div>
                            {/if}
                            {#if parsed.meta}
                                <EmailContextCard
                                    subject={parsed.meta.subject}
                                    fromName={parsed.meta.fromName}
                                    fromAddr={parsed.meta.fromAddr}
                                    date={parsed.meta.date}
                                    preview={parsed.meta.preview}
                                />
                            {/if}
                            {#if parsed.display}
                                <div class="markdown">{@html renderMarkdown(parsed.display)}</div>
                            {/if}
                        </div>
                    </div>
                {/each}
                {#if sending}
                    <div class="bubble-wrap">
                        <div class="bubble typing">
                            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                        </div>
                    </div>
                {/if}
            {/if}
        </div>

        {#if pendingPermissions.length}
            <div class="approval-sheet">
                {#each pendingPermissions as p, idx}
                    {@const meta = CAP_META[p.capability]}
                    <div class="approval-card perm-card">
                        <div class="perm-head">
                            <span class="perm-icon"><Icon name={meta.icon} size={18} /></span>
                            <div>
                                <p class="perm-title">{meta.title}</p>
                                <p class="perm-sub muted small">You can change this any time</p>
                            </div>
                        </div>
                        {#if p.reason}
                            <p class="perm-reason">{p.reason}</p>
                        {/if}
                        <div class="perm-lists">
                            <div class="perm-list can">
                                <span class="perm-list-h">Can do</span>
                                <ul>
                                    {#each meta.can as item}<li>{item}</li>{/each}
                                </ul>
                            </div>
                            <div class="perm-list cannot">
                                <span class="perm-list-h">Won't do</span>
                                <ul>
                                    {#each meta.cannot as item}<li>{item}</li>{/each}
                                </ul>
                            </div>
                        </div>
                        <div class="approval-actions">
                            <button type="button" class="mbtn mbtn-secondary" onclick={() => answerPermission(idx, false)}>Not now</button>
                            <button type="button" class="mbtn mbtn-primary" onclick={() => answerPermission(idx, true)}>Allow</button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}

        {#if pendingWrites.length}
            <div class="approval-sheet">
                {#each pendingWrites as w, idx}
                    {@const wtd = toolDisplay(w.name)}
                    <div class="approval-card">
                        <p class="semibold">{wtd.emoji} {wtd.label}?</p>
                        <p class="muted small">The assistant wants to make a change.</p>
                        <div class="approval-actions">
                            <button type="button" class="mbtn mbtn-secondary" onclick={() => answerWrite(idx, false)}>Deny</button>
                            <button type="button" class="mbtn mbtn-primary" onclick={() => answerWrite(idx, true)}>Approve</button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}

        {#if pendingImages.length}
            <div class="pending-images">
                {#each pendingImages as img, i}
                    <div class="pending-img-wrap">
                        <img src={img} alt="Pending" />
                        <button type="button" class="pending-remove" onclick={() => removePendingImage(i)}>
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                {/each}
            </div>
        {/if}

        <div class="input-bar">
            <button type="button" class="mbtn mbtn-ghost attach-btn" onclick={() => pickImage('camera')} title="Take photo">
                <Icon name="camera" size={18} />
            </button>
            <button type="button" class="mbtn mbtn-ghost attach-btn" onclick={() => pickImage('gallery')} title="Add photo">
                <Icon name="image" size={18} />
            </button>
            <textarea
                bind:value={input}
                onkeydown={onKey}
                placeholder="Ask anything…"
                rows={1}
            ></textarea>
            <button
                type="button"
                class="mbtn mbtn-primary send-btn"
                disabled={(!input.trim() && !pendingImages.length) || sending}
                onclick={handleSend}
            >
                <Icon name="send" size={18} />
            </button>
        </div>
    {/if}
</div>

{#if showThreads}
    <div class="sheet-backdrop" onclick={() => showThreads = false}></div>
    <div class="threads-sheet slide-up">
        <div class="sheet-header">
            <h2>Chats</h2>
            <button type="button" class="mbtn mbtn-ghost" onclick={() => showThreads = false}>
                <Icon name="close" size={18} />
            </button>
        </div>
        <div class="threads-list scroll-y">
            {#each aiState.threads as t}
                <button
                    type="button"
                    class="thread-row"
                    class:active={t.id === aiState.activeId}
                    onclick={() => pickThread(t.id)}
                >
                    <span class="truncate">{t.title}</span>
                    <span class="muted small">{t.messages.length}</span>
                </button>
            {/each}
        </div>
        <button type="button" class="mbtn mbtn-primary" style="margin:12px 16px;" onclick={startNewThread}>
            <Icon name="plus" size={16} /> New chat
        </button>
    </div>
{/if}

{#if voiceModeOpen}
    <VoiceChat onClose={() => voiceModeOpen = false} />
{/if}

{#if showSettings}
    <div class="sheet-backdrop" onclick={() => showSettings = false}></div>
    <div class="threads-sheet slide-up">
        <div class="sheet-header">
            <h2>Chat settings</h2>
            <button type="button" class="mbtn mbtn-ghost" onclick={() => showSettings = false}>
                <Icon name="close" size={18} />
            </button>
        </div>
        <div class="settings-list scroll-y">
            {#each ['accessEmail', 'accessAllChats', 'webSearch'] as cap}
                <div class="settings-row">
                    <div class="settings-info">
                        <span class="semibold">{CAP_META[cap as GrantableCapability].title}</span>
                    </div>
                    <button
                        type="button"
                        class="toggle-switch"
                        class:on={aiState.tools[cap as GrantableCapability]}
                        class:off={!aiState.tools[cap as GrantableCapability]}
                        onclick={() => setTools({ [cap]: !aiState.tools[cap as GrantableCapability] })}
                    >
                        <span class="toggle-knob"></span>
                    </button>
                </div>
            {/each}
            <div class="settings-divider"></div>
            <button type="button" class="settings-row danger" onclick={handleDeleteThread}>
                <Icon name="trash" size={16} />
                <span>Delete thread</span>
            </button>
            <button type="button" class="settings-row" onclick={goToSettings}>
                <Icon name="settings" size={16} />
                <span>Open Settings</span>
            </button>
        </div>
    </div>
{/if}

<style>
    .ai-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        background: var(--bg-base);
    }
    .header-actions {
        display: flex;
        align-items: center;
        gap: 2px;
    }
    .tool-bar {
        flex: 0 0 auto;
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        overflow-x: auto;
        scrollbar-width: none;
    }
    .tool-bar::-webkit-scrollbar { display: none; }
    .tool-chip {
        flex: 0 0 auto;
        padding: 5px 12px;
        border-radius: 999px;
        border: 1px solid var(--border-soft);
        background: var(--bg-surface);
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 120ms, color 120ms, border-color 120ms;
    }
    .tool-chip.active {
        background: var(--accent-soft);
        color: var(--accent-text);
        border-color: color-mix(in srgb, var(--accent) 35%, var(--border-soft));
    }
    .chat-scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior-y: contain;
        padding: 16px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    .bubble-wrap {
        display: flex;
        justify-content: flex-start;
        /* Keep the natural height — without this flex-shrink:0 the wraps
           compress as the conversation grows and the scroll container
           never overflows, so bubbles get squished and the pane refuses
           to scroll. */
        flex-shrink: 0;
    }
    .bubble-wrap.user { justify-content: flex-end; }
    .bubble-wrap.tool { justify-content: center; }
    .bubble {
        max-width: 85%;
        flex-shrink: 0;
        padding: 12px 16px;
        border-radius: 18px;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: 15.5px;
        line-height: 1.55;
        word-break: break-word;
        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .bubble-wrap.user .bubble {
        background: linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 85%, #000) 100%);
        color: var(--text-on-accent);
        border-bottom-right-radius: 6px;
        box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .bubble-wrap:not(.user) .bubble {
        border-bottom-left-radius: 6px;
        background: linear-gradient(180deg, var(--bg-surface) 0%, color-mix(in srgb, var(--bg-surface) 97%, var(--accent)) 100%);
    }
    .bubble.tool {
        background: var(--bg-hover);
        color: var(--text-tertiary);
        font-size: 12px;
        padding: 6px 10px;
    }
    .bubble.typing {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 12px 16px;
    }
    .bubble.done-flash {
        animation: bubble-done 2s ease-out;
    }
    /* Luxury one-tap quick-tools shown on the empty thread state.
     * Grid of square-ish tiles with a coloured wash, a big emoji
     * up top, and a two-line label. Tap → prefill the composer or
     * fire the request directly. */
    .quick-hero {
        padding: 18px 14px 8px;
        text-align: center;
    }
    .quick-hero-spark {
        font-size: 28px;
        line-height: 1;
        margin-bottom: 6px;
        filter: drop-shadow(0 2px 8px color-mix(in srgb, var(--accent) 35%, transparent));
    }
    .quick-hero-title {
        margin: 0 0 4px;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
        letter-spacing: -0.01em;
    }
    .quick-hero-sub {
        margin: 0 0 14px;
        font-size: 13px;
        color: var(--text-secondary);
    }
    .quick-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
        padding: 0 4px;
    }
    .quick-tile {
        position: relative;
        appearance: none;
        text-align: left;
        padding: 14px 12px 12px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border-subtle));
        background:
            linear-gradient(135deg,
                color-mix(in srgb, var(--accent) 14%, var(--bg-surface)) 0%,
                color-mix(in srgb, var(--accent) 4%, var(--bg-surface)) 100%);
        color: var(--text-primary);
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-height: 90px;
        box-shadow:
            0 1px 2px color-mix(in srgb, var(--accent) 8%, transparent),
            0 0 0 1px color-mix(in srgb, var(--accent) 6%, transparent) inset;
        transition: transform 0.12s ease, box-shadow 0.18s ease, border-color 0.18s ease;
        overflow: hidden;
    }
    .quick-tile::before {
        content: '';
        position: absolute;
        inset: 0;
        background: radial-gradient(120% 80% at 100% 0%, color-mix(in srgb, var(--accent) 18%, transparent) 0%, transparent 60%);
        pointer-events: none;
        opacity: 0.7;
    }
    .quick-tile:hover, .quick-tile:active {
        transform: translateY(-1px);
        border-color: color-mix(in srgb, var(--accent) 38%, var(--border-subtle));
        box-shadow:
            0 4px 14px color-mix(in srgb, var(--accent) 14%, transparent),
            0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent) inset;
    }
    .quick-tile:disabled {
        opacity: 0.55;
        pointer-events: none;
    }
    .quick-tile-emoji {
        font-size: 26px;
        line-height: 1;
        margin-bottom: 6px;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.08));
    }
    .quick-tile-title {
        font-size: 14px;
        font-weight: 600;
        line-height: 1.15;
        color: var(--text-primary);
    }
    .quick-tile-sub {
        font-size: 11.5px;
        color: var(--text-secondary);
        line-height: 1.25;
        margin-top: 2px;
    }
    /* Per-tool tints — subtle accent shift so the tiles read as
     * distinct functions at a glance. */
    .quick-tile-calendar-add { --accent: var(--blue, #3b82f6); }
    .quick-tile-inbox-suggest { --accent: var(--violet, #8b5cf6); }
    .quick-tile-inbox-triage { --accent: var(--green, #10b981); }
    .quick-tile-meeting-prep { --accent: var(--amber, #f59e0b); }

    .bg-task-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface));
        border-bottom: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border-subtle));
        font-size: 12.5px;
    }

    /* Mobile live progress widget — same purple gradient as desktop
     * but tighter for the narrow viewport. */
    .bg-task-widget {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 6px 8px 0;
        padding: 8px 10px;
        background: linear-gradient(135deg,
            color-mix(in srgb, #8b5cf6 18%, var(--bg-surface)) 0%,
            color-mix(in srgb, #6366f1 10%, var(--bg-surface)) 100%);
        border: 1px solid color-mix(in srgb, #8b5cf6 30%, var(--border-subtle));
        border-radius: 12px;
        font-size: 12px;
    }
    .bg-orb {
        position: relative;
        width: 28px; height: 28px;
        flex: 0 0 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
    .bg-orb-ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid transparent;
        border-top-color: #c4b5fd;
        border-right-color: #818cf8;
        animation: bg-orb-spin 1.1s linear infinite;
    }
    .bg-orb-core { font-size: 14px; line-height: 1; }
    @keyframes bg-orb-spin { to { transform: rotate(360deg); } }
    .bg-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .bg-meta-top strong {
        font-size: 12.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: block;
        max-width: 180px;
    }
    .bg-meta-now {
        display: flex;
        gap: 8px;
        font-size: 11px;
        color: var(--text-secondary);
    }
    .bg-now-tool {
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 110px;
    }
    .bg-stat { margin-left: auto; opacity: 0.8; font-variant-numeric: tabular-nums; }
    .bg-task-text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .bg-task-spinner {
        width: 11px;
        height: 11px;
        border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
        border-top-color: var(--accent);
        animation: bg-task-spin 0.9s linear infinite;
        flex: 0 0 auto;
    }
    @keyframes bg-task-spin { to { transform: rotate(360deg); } }
    .bg-task-cancel {
        appearance: none;
        background: transparent;
        border: 1px solid var(--border-subtle);
        border-radius: 6px;
        padding: 3px 8px;
        font-size: 11px;
        color: var(--text-secondary);
    }
    @keyframes bubble-done {
        0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 65%, transparent); }
        20%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 28%, transparent); }
        100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) {
        .bubble.done-flash { animation: none; }
    }
    .bubble.typing .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--text-tertiary);
        animation: typing 1.2s infinite ease-in-out;
    }
    .bubble.typing .dot:nth-child(2) { animation-delay: 0.15s; }
    .bubble.typing .dot:nth-child(3) { animation-delay: 0.3s; }
    @keyframes typing {
        0%, 80%, 100% { transform: scale(0.7); opacity: 0.5; }
        40% { transform: scale(1); opacity: 1; }
    }
    .tool-call {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--accent-text);
        margin-bottom: 4px;
    }
    .tool-call-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 9px;
        background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface));
        border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border-subtle));
        border-radius: 999px;
        font-weight: 600;
        font-size: 11.5px;
    }
    .tool-call-emoji {
        font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
    }
    .tool-call-count {
        font-variant-numeric: tabular-nums;
        font-feature-settings: 'tnum';
        font-weight: 700;
        font-size: 10.5px;
        padding: 1px 6px;
        margin-left: 2px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--accent) 28%, transparent);
        color: var(--accent-text);
    }
    .markdown {
        word-wrap: break-word;
        overflow-wrap: anywhere;
    }
    .markdown :global(p) { margin: 0 0 8px; }
    .markdown :global(p:last-child) { margin-bottom: 0; }
    .markdown :global(strong) { font-weight: 700; }
    .markdown :global(em) { font-style: italic; }
    .markdown :global(del) { text-decoration: line-through; opacity: 0.7; }
    .markdown :global(code) {
        font-family: var(--font-mono);
        font-size: 12.5px;
        padding: 1px 5px;
        background: color-mix(in srgb, var(--accent) 8%, var(--bg-base));
        border: 1px solid color-mix(in srgb, var(--accent) 15%, var(--border-subtle));
        border-radius: var(--radius-xs);
        color: var(--accent-text);
    }
    .markdown :global(pre) {
        margin: 8px 0;
        padding: 10px 12px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        overflow-x: auto;
    }
    .markdown :global(pre code) {
        background: none;
        border: none;
        padding: 0;
        color: var(--text-primary);
        font-size: 12px;
    }
    .markdown :global(blockquote) {
        margin: 8px 0;
        padding: 6px 12px;
        border-left: 3px solid var(--accent);
        background: color-mix(in srgb, var(--accent) 5%, transparent);
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        font-style: italic;
    }
    .markdown :global(ul), .markdown :global(ol) {
        margin: 6px 0;
        padding-left: 20px;
    }
    .markdown :global(li) { margin: 3px 0; }
    .markdown :global(a) {
        color: var(--accent);
        text-decoration: underline;
        text-underline-offset: 2px;
    }
    .markdown :global(h1), .markdown :global(h2), .markdown :global(h3), .markdown :global(h4) {
        font-size: 15px;
        font-weight: 700;
        margin: 10px 0 6px;
    }
    .markdown :global(hr) {
        border: none;
        border-top: 1px solid var(--border-subtle);
        margin: 10px 0;
    }
    .input-bar {
        flex: 0 0 auto;
        display: flex;
        align-items: flex-end;
        gap: 8px;
        padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
        background: var(--bg-surface);
        border-top: 1px solid var(--border-subtle);
    }
    .input-bar textarea {
        flex: 1;
        border: 1px solid var(--border-soft);
        border-radius: 20px;
        padding: 12px 16px;
        font-size: 15.5px;
        line-height: 1.45;
        resize: none;
        outline: none;
        background: var(--bg-base);
        color: var(--text-primary);
        max-height: 140px;
        box-shadow: inset 0 1px 2px rgba(0,0,0,0.03);
    }
    .input-bar textarea:focus {
        border-color: var(--border-focus);
    }
    .send-btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        padding: 0;
        flex-shrink: 0;
    }
    .attach-btn {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        padding: 0;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .image-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 6px;
    }
    .chat-img {
        max-width: 160px;
        max-height: 160px;
        border-radius: 8px;
        object-fit: cover;
    }
    .pending-images {
        flex: 0 0 auto;
        display: flex;
        gap: 8px;
        padding: 8px 16px 0;
        overflow-x: auto;
        scrollbar-width: none;
    }
    .pending-images::-webkit-scrollbar { display: none; }
    .pending-img-wrap {
        position: relative;
        flex: 0 0 auto;
        width: 64px;
        height: 64px;
        border-radius: 8px;
        overflow: hidden;
    }
    .pending-img-wrap img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .pending-remove {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: none;
        background: rgba(0,0,0,0.5);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
    }
    .approval-sheet {
        flex: 0 0 auto;
        padding: 8px 16px;
        background: var(--bg-surface);
        border-top: 1px solid var(--border-subtle);
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .approval-card {
        background: var(--bg-hover);
        border-radius: 10px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .approval-reason {
        margin: 0;
        font-size: 14px;
        color: var(--text-primary);
    }
    .approval-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    }
    .approval-actions .mbtn {
        padding: 6px 12px;
        font-size: 13px;
    }

    /* Human-friendly permission card */
    .perm-card {
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-hover)) !important;
        border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border-subtle));
    }
    .perm-head {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .perm-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px; height: 36px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--accent) 18%, var(--bg-surface));
        color: var(--accent);
        flex-shrink: 0;
    }
    .perm-title {
        font-size: 14px;
        font-weight: 700;
        color: var(--text-primary);
        margin: 0;
    }
    .perm-sub { margin: 0; font-size: 12px; }
    .perm-reason {
        margin: 0;
        font-size: 13px;
        color: var(--text-primary);
        padding: 8px 10px;
        background: var(--bg-surface);
        border-radius: 8px;
        border: 1px solid var(--border-subtle);
    }
    .perm-lists {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
    }
    .perm-list {
        padding: 8px 10px;
        border-radius: 8px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
    }
    .perm-list.can { border-left: 3px solid #22c55e; }
    .perm-list.cannot { border-left: 3px solid #ef4444; }
    .perm-list-h {
        display: block;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 4px;
    }
    .perm-list.can .perm-list-h { color: #22c55e; }
    .perm-list.cannot .perm-list-h { color: #ef4444; }
    .perm-list ul {
        margin: 0;
        padding-left: 14px;
        display: flex;
        flex-direction: column;
        gap: 3px;
    }
    .perm-list li {
        font-size: 11.5px;
        line-height: 1.4;
        color: var(--text-secondary);
    }

    .sheet-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.4);
        z-index: 90;
    }
    .threads-sheet {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        max-height: 70vh;
        background: var(--bg-surface);
        border-radius: 16px 16px 0 0;
        z-index: 100;
        display: flex;
        flex-direction: column;
        padding-bottom: env(safe-area-inset-bottom);
    }
    .sheet-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .sheet-header h2 {
        margin: 0;
        font-size: 17px;
        font-weight: 700;
    }
    .threads-list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 8px 0;
    }
    .thread-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 16px;
        background: transparent;
        border: none;
        width: 100%;
        text-align: left;
        font-size: 15px;
        color: var(--text-primary);
        cursor: pointer;
    }
    .thread-row.active {
        background: var(--bg-selected);
    }
    .thread-row:active {
        background: var(--bg-hover);
    }
    .settings-list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 8px 0;
        display: flex;
        flex-direction: column;
    }
    .settings-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        background: transparent;
        border: none;
        width: 100%;
        text-align: left;
        font-size: 15px;
        color: var(--text-primary);
        cursor: pointer;
    }
    .settings-row.danger {
        color: var(--danger);
    }
    .settings-row:active {
        background: var(--bg-hover);
    }
    .settings-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .settings-divider {
        height: 1px;
        background: var(--border-subtle);
        margin: 8px 16px;
    }
    .toggle-switch {
        width: 52px;
        height: 32px;
        border-radius: 16px;
        border: none;
        padding: 2px;
        position: relative;
        cursor: pointer;
        transition: background-color 200ms ease;
        flex-shrink: 0;
        background: var(--border-soft);
    }
    .toggle-switch.on { background: var(--accent); }
    .toggle-switch.off { background: var(--border-soft); }
    .toggle-knob {
        display: block;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--bg-surface);
        box-shadow: 0 1px 3px rgba(0,0,0,0.15);
        transition: transform 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .toggle-switch.on .toggle-knob { transform: translateX(20px); }
    .toggle-switch.off .toggle-knob { transform: translateX(0); }
</style>
