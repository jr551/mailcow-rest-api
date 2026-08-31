<script lang="ts">
    // Full-surface AI chat. Threads persist in localStorage; the LLM is the
    // user's OpenAI-compatible provider (configured in Settings → AI).
    // Tool tickboxes opt in to: email/calendar access (existing MCP tools)
    // and OpenRouter `:online` web search.

    import { onMount } from 'svelte';
    import {
        aiState, newThread, selectThread, deleteThread, renameThread,
        appendMessage, setTools, searchThreads, clearAutoSend
    } from '../../lib/ai-threads.svelte';
    import { chatTurn, TOOLS, META_TOOLS, SYSTEM_PROMPT, generateThreadTitle, isChatConfigured, type ChatMessage, type GrantableCapability } from '../../lib/chat.svelte';
    import { settings, capabilities } from '../../lib/settings.svelte';
    import { ui, showToast } from '../../lib/store.svelte';
    import {
        voicePrefs, setVoiceEnabled, isVoiceAvailable,
        speakWithElevenLabs, stopSpeaking,
        isSttAvailable, createSpeechRecognizer
    } from '../../lib/voice.svelte';
    import Icon from '../Icon.svelte';
    import type { IconName } from '../../lib/icons';
    import { renderMarkdown } from '../../lib/markdown';
    import { parseEmailContext } from '../../lib/email-context';
    import EmailContextCard from './EmailContextCard.svelte';
    import { recentViewsForPrompt } from '../../lib/recent-views.svelte';
    import { toolDisplay } from '../../lib/tool-icons';
    import VoiceChat from './VoiceChat.svelte';
    import { playNotify } from '../../lib/sounds.svelte';
    import { backgroundTasks, cancelBackgroundTask } from '../../lib/background-tasks.svelte';

    let input = $state('');
    let sending = $state(false);
    let abortCtrl: AbortController | null = null;
    // Drives a one-shot glow on the latest assistant bubble after a
    // reply lands — see the .done-flash class below. Cleared by an
    // $effect 2.4s after it sets, which yanks the class so a future
    // reply re-triggers the CSS animation.
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
    let searchQuery = $state('');

    // Pending write-tool approvals — chatTurn parks here until the user
    // clicks Approve or Deny. Multiple writes in one turn queue up.
    interface PendingWrite {
        name: string;
        args: Record<string, unknown>;
        resolve: (ok: boolean) => void;
    }
    let pendingWrites = $state<PendingWrite[]>([]);
    /** Pending permission asks (the model called `request_permission`).
     *  Each card stays visible until the user clicks Allow or Deny. */
    interface PendingPermission {
        capability: GrantableCapability;
        reason: string;
        resolve: (ok: boolean) => void;
    }
    let pendingPermissions = $state<PendingPermission[]>([]);

    /** Rich human-friendly metadata for each grantable capability. */
    const CAP_META: Record<GrantableCapability, { title: string; icon: IconName; can: string[]; cannot: string[] }> = {
        accessEmail: {
            title: 'Access your emails and calendar',
            icon: 'mail',
            can: ['Read and search your inbox, sent mail, and folders', 'See calendar events and help schedule new ones', 'Summarise threads and draft replies for you to send'],
            cannot: ['Send emails without your approval', 'Delete or move messages permanently', 'Share your data outside this app']
        },
        accessAllChats: {
            title: 'Look at your other conversations',
            icon: 'user',
            can: ['Reference past questions you asked me', 'Keep context consistent across chats', 'Avoid repeating things you already told me'],
            cannot: ['Read other users\' chats', 'Share conversation details with anyone', 'Store chat history beyond this session']
        },
        webSearch: {
            title: 'Search the web with Brave',
            icon: 'globe',
            can: ['Look up current information and news', 'Find documentation, references, and facts', 'Verify claims with live sources from Brave Search'],
            cannot: ['Browse or buy things on your behalf', 'Submit forms or log into other sites', 'Access your accounts on other services']
        }
    };
    // Voice features. STT runs locally via the browser's Web Speech API;
    // TTS calls ElevenLabs through the server-supplied key in
    // capabilities.ttsConfig. Both are opt-in via the toolbar toggle.
    let listening = $state(false);
    let interimTranscript = $state('');
    let recognizer: ReturnType<typeof createSpeechRecognizer> | null = null;
    let lastSpokenIdx = $state(-1);
    let voiceModeOpen = $state(false);

    function startListening() {
        if (listening || !isSttAvailable()) return;
        recognizer = createSpeechRecognizer();
        if (!recognizer) return;
        listening = true;
        interimTranscript = '';
        let stash = '';
        recognizer.onResult((txt, isFinal) => {
            interimTranscript = txt;
            if (isFinal) stash += txt + ' ';
        });
        recognizer.onEnd(() => {
            listening = false;
            const final = (stash + interimTranscript).trim();
            interimTranscript = '';
            if (final) {
                if (voicePrefs.enabled) {
                    input = final;
                    void send();
                } else {
                    input = (input ? input + ' ' : '') + final;
                }
            }
        });
        recognizer.onError((err) => {
            listening = false;
            interimTranscript = '';
            if (err !== 'no-speech' && err !== 'aborted') {
                if (err === 'network') {
                    showToast('error', 'Speech recognition unavailable. Check your internet connection or try a different browser.');
                } else {
                    showToast('error', `Microphone: ${err}`);
                }
            }
        });
        try { recognizer.start(); } catch { listening = false; }
    }
    function stopListening() {
        try { recognizer?.stop(); } catch { /* */ }
        listening = false;
    }

    async function speakMessage(text: string) {
        if (!voicePrefs.enabled || !isVoiceAvailable()) return;
        try {
            await speakWithElevenLabs(text);
        } catch (err) {
            showToast('error', (err as Error).message || 'Voice playback failed');
        }
    }

    // When a new assistant message lands and voice is on, speak the
    // freshly-completed reply (skip while still streaming so we don't
    // start halfway through). Tracks lastSpokenIdx so we don't re-speak
    // the same message on every flush.
    $effect(() => {
        if (!voicePrefs.enabled) { lastSpokenIdx = -1; return; }
        const t = aiState.threads.find((th) => th.id === aiState.activeId);
        if (!t || !t.messages.length) return;
        const lastIdx = t.messages.length - 1;
        const last = t.messages[lastIdx];
        if (sending) return; // wait for streaming to finish
        if (last.role !== 'assistant' || !last.content) return;
        if (lastIdx === lastSpokenIdx) return;
        lastSpokenIdx = lastIdx;
        speakMessage(last.content);
    });

    function answerWrite(idx: number, ok: boolean) {
        const w = pendingWrites[idx];
        if (!w) return;
        w.resolve(ok);
        pendingWrites = pendingWrites.filter((_, i) => i !== idx);
    }
    function answerPermission(idx: number, ok: boolean) {
        const p = pendingPermissions[idx];
        if (!p) return;
        // On Allow we flip the toggle here so the *next* model step already
        // sees the new capability — saves the model from having to ask again.
        if (ok) setTools({ [p.capability]: true });
        p.resolve(ok);
        pendingPermissions = pendingPermissions.filter((_, i) => i !== idx);
    }
    function describeArgs(args: Record<string, unknown>): string {
        const entries = Object.entries(args).slice(0, 4);
        if (!entries.length) return '(no arguments)';
        return entries.map(([k, v]) => {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            return `${k}: ${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
        }).join(' · ');
    }

    // Filtered thread list — search across titles + message bodies.
    let visibleThreads = $derived.by(() => {
        if (!searchQuery.trim()) return aiState.threads;
        return searchThreads(searchQuery);
    });

    let active = $derived(aiState.threads.find((t) => t.id === aiState.activeId) ?? null);
    let bgTask = $derived(active ? backgroundTasks().active.find((t) => t.threadId === active.id) : undefined);

    // Tool catalog assembled from tickboxes. Email-access uses the existing
    // MCP catalog; without it the LLM still gets META_TOOLS so it can ask
    // for access rather than hallucinate an answer or refuse outright.
    // web_search (Brave) is gated behind the explicit toggle — exposing it
    // unconditionally would tempt the model to search the web for things
    // it could just answer from training data.
    let toolCatalog = $derived.by(() => {
        const base = aiState.tools.accessEmail ? TOOLS : [];
        const meta = META_TOOLS.filter((t) =>
            t.function.name !== 'web_search' || aiState.tools.webSearch
        );
        return [...base, ...meta];
    });

    // System prompt adapts to which capabilities are unlocked. The user can
    // override the persona in Settings → AI → System prompt; capability
    // hints still get appended so the model knows what tools it has.
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
            if (summaries) {
                lines.push('You may reference the user\'s other recent chat threads:\n' + summaries);
            }
        }
        if (aiState.tools.webSearch) {
            lines.push('Web search is enabled via the `web_search` tool (Brave Search). Use it whenever the user asks about current facts, news, prices, sports, weather, definitions, or anything not in their mail/calendar. Cite sources inline as [1], [2], etc., and list full URLs at the end of your reply.');
        }
        // Always include the user's recent in-app navigation (if any) so
        // the assistant can reference what they were just looking at —
        // "you were just on Marketing/", "you opened the invoice from
        // Acme 30 seconds ago" — without the user having to spell it out.
        const recents = recentViewsForPrompt(10);
        if (recents) lines.push(recents);
        return lines.join(' ');
    });

    // Pick the model the LLM call should use for the active thread.
    //  - Chat threads with the `webSearch` toggle on use a search-grounded
    //    model (Perplexity Sonar or OpenRouter `:online` suffix).
    //  - Otherwise, no override — use whatever resolveModel() picks.
    let modelOverride = $derived.by(() => {
        const llm = settings.llm;
        const cfg = capabilities.aiConfig;
        // Detect provider from server config first, then user settings.
        // (cfg.preset doesn't exist on the AiConfig type — only the user
        // settings.llm.preset is meaningful here.)
        const base = (llm.baseUrl || cfg?.baseUrl || '').toLowerCase();
        const preset = llm.preset || '';
        const isOR = preset === 'openrouter' || base.includes('openrouter.ai');
        const isPplx = preset === 'perplexity' || base.includes('perplexity.ai');

        if (aiState.tools.webSearch) {
            if (isPplx) return 'sonar-pro';
            if (isOR) {
                // OpenRouter's :online suffix enables search grounding on the
                // same model, so tool calls (email, calendar, etc.) keep working.
                const model = cfg?.model || llm.model || 'meta-llama/llama-3.1-8b-instruct';
                return model.endsWith(':online') ? model : `${model}:online`;
            }
        }
        return undefined;
    });

    /** Small info about the active provider/model for the header. */
    let providerInfo = $derived.by(() => {
        const cfg = capabilities.aiConfig;
        if (cfg?.configured) {
            return `Server · ${cfg.model || 'default'}`;
        }
        const llm = settings.llm;
        if (settings.useCustomLlm && llm.apiKey) {
            const preset = llm.preset || 'custom';
            return `${preset} · ${llm.model || 'default'}`;
        }
        return null;
    });

    onMount(() => {
        if (!aiState.threads.length) newThread();
        scrollToBottom();
    });

    function scrollToBottom(smooth = false) {
        queueMicrotask(() => {
            if (!scrollBox) return;
            if (smooth && 'scrollBehavior' in scrollBox.style) {
                scrollBox.scrollTo({ top: scrollBox.scrollHeight, behavior: 'smooth' });
            } else {
                scrollBox.scrollTop = scrollBox.scrollHeight;
            }
        });
    }

    async function send() {
        const text = input.trim();
        const images = pendingImages.slice();
        if ((!text && !images.length) || sending) return;
        if (!aiState.activeId) newThread();
        const threadId = aiState.activeId!;
        const userMsg: ChatMessage = {
            role: 'user',
            content: text,
            images: images.length ? images : undefined
        };
        appendMessage(threadId, userMsg);
        input = '';
        pendingImages = [];
        await runAssistant(threadId);
    }

    // ---- Pasted/dropped image handling -----------------------------------
    let pendingImages = $state<string[]>([]);

    /** Resize + JPEG-encode any image File so the chat-completion request
     *  body stays small enough to actually upload. Same compression
     *  approach as the mobile chat: long-edge ≤ 1024 px, q=0.82. */
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

    async function attachImageFiles(files: FileList | File[] | null) {
        if (!files) return;
        const arr = Array.from(files).filter((f) => f.type.startsWith('image/'));
        if (!arr.length) return;
        const dataUrls = await Promise.all(arr.map((f) => compressImage(f).catch(() => null)));
        pendingImages = [...pendingImages, ...dataUrls.filter((u): u is string => !!u)];
    }

    function onComposerPaste(e: ClipboardEvent) {
        const items = e.clipboardData?.items;
        if (!items) return;
        const imgs: File[] = [];
        for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const f = item.getAsFile();
                if (f) imgs.push(f);
            }
        }
        if (imgs.length) {
            e.preventDefault();
            attachImageFiles(imgs);
        }
    }

    function onComposerDrop(e: DragEvent) {
        if (!e.dataTransfer?.files?.length) return;
        const imgs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
        if (!imgs.length) return;
        e.preventDefault();
        attachImageFiles(imgs);
    }

    function removePendingImage(idx: number) {
        pendingImages = pendingImages.filter((_, i) => i !== idx);
    }

    /** Fire the LLM against an existing thread whose last message is
     *  already a user prompt — used by send() above and by the
     *  pendingAutoSend deep-link path (email AI suggestions). */
    async function runAssistant(threadId: string) {
        if (sending) return;
        if (!isChatConfigured()) {
            showToast('error', 'Configure an OpenAI-compatible provider + API key in Settings → AI.');
            return;
        }
        sending = true;
        scrollToBottom();

        const placeholder: ChatMessage = { role: 'assistant', content: '' };
        appendMessage(threadId, placeholder);

        abortCtrl = new AbortController();
        try {
            const thread = aiState.threads.find((t) => t.id === threadId);
            if (!thread) return;
            // Build the history sent to the model (everything except the
            // empty placeholder we just appended).
            const history = thread.messages.slice(0, -1);
            let acc = '';
            // Tracks the last consecutive tool chip so we can rewrite it
            // with an ×N suffix when the same tool fires repeatedly.
            let lastToolKey = '';
            let lastToolCount = 0;
            let lastToolLineLen = 0;
            for await (const ev of chatTurn(history, {
                signal: abortCtrl.signal,
                tools: toolCatalog,
                systemPrompt,
                modelOverride,
                threadId,
                confirmWrite: (call) => new Promise<boolean>((resolve) => {
                    pendingWrites = [...pendingWrites, { name: call.name, args: call.args, resolve }];
                    scrollToBottom();
                }),
                confirmPermission: (req) => new Promise<boolean>((resolve) => {
                    pendingPermissions = [...pendingPermissions, { capability: req.capability, reason: req.reason, resolve }];
                    scrollToBottom();
                })
            })) {
                if (ev.type === 'tool_call') {
                    const td = toolDisplay(ev.toolName || '');
                    if (!td.hidden) {
                        // Collapse consecutive identical tool calls into a
                        // single line with an ×N counter — keeps long chains
                        // (10× search, etc.) readable instead of spamming
                        // the transcript.
                        const key = ev.toolName || '';
                        if (key === lastToolKey && lastToolLineLen > 0) {
                            lastToolCount += 1;
                            acc = acc.slice(0, acc.length - lastToolLineLen);
                            const line = `\n_${td.emoji} ${td.label}…_ **×${lastToolCount}**\n`;
                            acc += line;
                            lastToolLineLen = line.length;
                        } else {
                            const line = `\n_${td.emoji} ${td.label}…_\n`;
                            acc += line;
                            lastToolKey = key;
                            lastToolCount = 1;
                            lastToolLineLen = line.length;
                        }
                        updateAssistant(threadId, acc);
                    }
                } else if (ev.type === 'message') {
                    acc += ev.text || '';
                    // First text token after a tool chain breaks the run —
                    // any further tool call starts a fresh chip.
                    if (ev.text) {
                        lastToolKey = '';
                        lastToolCount = 0;
                        lastToolLineLen = 0;
                    }
                    updateAssistant(threadId, acc, ev.reasoningContent);
                } else if (ev.type === 'switching_to_bg') {
                    // Foreground hit the step cap; the chat library
                    // already spawned a background runner. Surface a
                    // calm hand-off message — no error styling.
                    acc += `\n\n_🛎️ ${ev.text || 'Switching to a long-running background task — I\'ll notify you when it\'s done.'}_`;
                    updateAssistant(threadId, acc);
                } else if (ev.type === 'error') {
                    acc += `\n\n**Error:** ${ev.text}`;
                    updateAssistant(threadId, acc);
                }
                scrollToBottom();
            }
        } catch (err) {
            updateAssistant(threadId, `Error: ${(err as Error).message}`);
        } finally {
            sending = false;
            abortCtrl = null;
            scrollToBottom();
            // Soft chime + glow on the latest assistant message so the
            // user notices the reply landed even if they tabbed away or
            // were watching the thread list.
            playNotify();
            doneFlashThreadId = threadId;
            doneFlashStamp = Date.now();
            // Best-effort browser notification when the page is hidden —
            // skipped silently if the user hasn't granted permission.
            if (typeof document !== 'undefined' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
                try { new Notification('AI reply ready', { body: 'Your assistant has finished a response.', silent: false }); } catch { /* */ }
            }
            // Generate a concise emoji + title for the thread once the
            // first assistant reply lands. Fire-and-forget; cosmetic.
            // Driven by the per-thread `aiTitled` flag rather than the
            // title string itself, so the cheap auto-derived title from
            // appendMessage (which can be a [[email:…]] sentinel for
            // action-spawned chats) doesn't lock us out of upgrading it.
            const t = aiState.threads.find((th) => th.id === threadId);
            const stripSentinel = (s: string) => parseEmailContext(s).display || s;
            const firstUser = t?.messages.find((m) => m.role === 'user');
            const firstAssistant = t?.messages.find((m) => m.role === 'assistant');
            if (t && firstUser && firstAssistant && !t.aiTitled) {
                generateThreadTitle(stripSentinel(firstUser.content), firstAssistant.content)
                    .then((result) => {
                        if (result) {
                            renameThread(threadId, `${result.emoji} ${result.title}`, { ai: true });
                        } else {
                            // Mark titled even on failure so we don't burn
                            // a title-gen request on every subsequent reply.
                            renameThread(threadId, t.title, { ai: true });
                        }
                    })
                    .catch(() => { renameThread(threadId, t.title, { ai: true }); });
            }
        }
    }

    // Auto-send when MessageDetail (or any other surface) deep-links into
    // a thread that's already loaded with the prompt as its last message.
    $effect(() => {
        const id = aiState.pendingAutoSend;
        if (!id) return;
        const t = aiState.threads.find((x) => x.id === id);
        const last = t?.messages[t.messages.length - 1];
        if (last?.role !== 'user') { clearAutoSend(); return; }
        clearAutoSend();
        // Defer to the next tick so the surface mounts before we start
        // pumping the chatTurn loop into it.
        queueMicrotask(() => { void runAssistant(id); });
    });

    function updateAssistant(threadId: string, text: string, reasoningContent?: string) {
        const idx = aiState.threads.findIndex((t) => t.id === threadId);
        if (idx < 0) return;
        const thread = aiState.threads[idx];
        const lastIdx = thread.messages.length - 1;
        if (lastIdx < 0 || thread.messages[lastIdx].role !== 'assistant') return;
        // Mutate via the store — we need to keep reactivity. Reasoning
        // content (DeepSeek thinking, etc.) is stashed so the next turn
        // can echo it back without tripping the "must be passed back"
        // check at the LiteLLM proxy.
        const prev = thread.messages[lastIdx];
        thread.messages[lastIdx] = {
            ...prev,
            content: text,
            ...(reasoningContent ? { reasoningContent } : {})
        };
        aiState.threads[idx] = { ...thread, updatedAt: Date.now() };
    }

    function stop() {
        if (abortCtrl) abortCtrl.abort();
    }

    function pickThread(id: string) {
        selectThread(id);
        scrollToBottom();
    }

    function start() {
        newThread();
        scrollToBottom();
    }

    function trash(id: string, title: string) {
        if (confirm(`Delete chat "${title}"?`)) deleteThread(id);
    }

    // Right-click context menu for AI chats. Right-clicking a thread row
    // pops a small menu (Open / Archive / Delete) at the cursor.
    let chatCtxMenu = $state<{ id: string; title: string; x: number; y: number } | null>(null);
    function openChatCtx(e: MouseEvent, id: string, title: string) {
        e.preventDefault();
        e.stopPropagation();
        chatCtxMenu = { id, title, x: e.clientX, y: e.clientY };
    }
    function closeChatCtx() { chatCtxMenu = null; }
    $effect(() => {
        if (!chatCtxMenu) return;
        const close = () => closeChatCtx();
        window.addEventListener('click', close, { once: true });
        return () => window.removeEventListener('click', close);
    });
    function chatCtxArchive(id: string) {
        // Archived = deleted from the local state but kept in the IMAP
        // backup folder. Mirrors what the trash button does today; if we
        // ever add a real archive split we'll branch here.
        deleteThread(id);
        closeChatCtx();
    }

    function relTime(ts: number): string {
        const diff = Date.now() - ts;
        if (diff < 60_000) return 'just now';
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
        return `${Math.floor(diff / 86_400_000)}d`;
    }

    function onComposerKey(e: KeyboardEvent) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    }
</script>

<div class="ai-app" data-testid="ai-app">
    <aside class="ai-sidebar">
        <div class="side-head">
            <button type="button" class="new-btn" onclick={start} data-testid="ai-new">
                <Icon name="plus" size={14} /> Chat
            </button>
        </div>
        <div class="search-wrap">
            <Icon name="search" size={13} />
            <input
                type="search"
                placeholder="Search chats…"
                bind:value={searchQuery}
                data-testid="ai-search"
            />
        </div>
        <ul class="thread-list" data-testid="ai-thread-list">
            {#each visibleThreads as t (t.id)}
                <li
                    class="thread-row"
                    class:active={t.id === aiState.activeId}
                    data-testid={`ai-thread-${t.id}`}
                    oncontextmenu={(e) => openChatCtx(e, t.id, t.title)}
                >
                    <button type="button" class="thread-pick" onclick={() => pickThread(t.id)}>
                        <span class="thread-kind-icon" aria-hidden="true">
                            <Icon name="sparkles" size={11} />
                        </span>
                        <span class="thread-title truncate">{t.title}</span>
                        <span class="thread-meta muted">{t.messages.length} msgs · {relTime(t.updatedAt)}</span>
                    </button>
                    <button
                        type="button"
                        class="thread-del"
                        onclick={() => trash(t.id, t.title)}
                        aria-label={`Delete ${t.title}`}
                    >
                        <Icon name="trash" size={12} />
                    </button>
                </li>
            {:else}
                <li class="muted small" style="padding: 12px;">No chats found.</li>
            {/each}
        </ul>
    </aside>

    {#if chatCtxMenu}
        <ul
            class="chat-ctx-menu"
            role="menu"
            data-testid="ai-thread-ctx-menu"
            style={`position:fixed;left:${chatCtxMenu.x}px;top:${chatCtxMenu.y}px;z-index:200;`}
            onclick={(e) => e.stopPropagation()}
        >
            <li role="menuitem">
                <button type="button" class="chat-ctx-item" onclick={() => { pickThread(chatCtxMenu!.id); closeChatCtx(); }}>
                    <Icon name="sparkles" size={12} /> <span>Open</span>
                </button>
            </li>
            <li role="menuitem">
                <button type="button" class="chat-ctx-item" onclick={() => chatCtxArchive(chatCtxMenu!.id)}>
                    <Icon name="archive" size={12} /> <span>Archive</span>
                </button>
            </li>
            <li role="menuitem">
                <button type="button" class="chat-ctx-item danger" onclick={() => { trash(chatCtxMenu!.id, chatCtxMenu!.title); closeChatCtx(); }}>
                    <Icon name="trash" size={12} /> <span>Delete</span>
                </button>
            </li>
        </ul>
    {/if}

    <main class="ai-main">
        <header class="ai-toolbar">
            <h2 class="ai-title">
                <span class="ai-title-text">{active?.title || 'New chat'}</span>
                {#if providerInfo}
                    <span class="model-badge" title="Active AI provider and model">{providerInfo}</span>
                {/if}
                {#if aiState.tools.webSearch}
                    <span class="model-badge search-badge" title="Web search enabled">Web search</span>
                {/if}
            </h2>
            <div class="tool-toggles" role="group" aria-label="Capabilities">
                <label class="tool-toggle" title="Let the AI read mail, search messages, manage filter rules, and read/write your calendar.">
                    <input
                        type="checkbox"
                        checked={aiState.tools.accessEmail}
                        onchange={(e) => setTools({ accessEmail: (e.currentTarget as HTMLInputElement).checked })}
                        data-testid="ai-tool-email"
                    />
                    <Icon name="mail" size={12} />
                    <span>Email &amp; calendar</span>
                </label>
                <label class="tool-toggle" title="Reference your other chat threads in the model's context.">
                    <input
                        type="checkbox"
                        checked={aiState.tools.accessAllChats}
                        onchange={(e) => setTools({ accessAllChats: (e.currentTarget as HTMLInputElement).checked })}
                        data-testid="ai-tool-allchats"
                    />
                    <Icon name="sparkles" size={12} />
                    <span>All chats</span>
                </label>
                <label class="tool-toggle" title="Enable the web_search tool (powered by Brave Search). The assistant can look up live facts, news, prices, etc. Requires BRAVE_SEARCH_API_KEY on the server.">
                    <input
                        type="checkbox"
                        checked={aiState.tools.webSearch}
                        onchange={(e) => setTools({ webSearch: (e.currentTarget as HTMLInputElement).checked })}
                        data-testid="ai-tool-websearch"
                    />
                    <Icon name="search" size={12} />
                    <span>Brave Search</span>
                </label>

                {#if isVoiceAvailable()}
                    <label
                        class="tool-toggle"
                        class:voice-on={voicePrefs.enabled}
                        title="Speak assistant replies aloud via ElevenLabs"
                    >
                        <input
                            type="checkbox"
                            checked={voicePrefs.enabled}
                            onchange={(e) => setVoiceEnabled((e.currentTarget as HTMLInputElement).checked)}
                            data-testid="ai-tool-voice"
                        />
                        <Icon name="bell" size={12} />
                        <span>Voice</span>
                    </label>
                {/if}
                {#if isSttAvailable()}
                    <button
                        type="button"
                        class="tool-toggle voice-mode-toggle"
                        onclick={() => voiceModeOpen = true}
                        title="Open fullscreen voice conversation"
                        data-testid="ai-voice-mode"
                    >
                        <Icon name="mic" size={12} />
                        <span>Voice mode</span>
                    </button>
                {/if}
            </div>
        </header>

        {#if bgTask}
            {@const td = toolDisplay(bgTask.currentTool || '')}
            <div class="bg-task-widget" role="status" aria-live="polite" data-testid="ai-bg-task">
                <span class="bg-orb" aria-hidden="true">
                    <span class="bg-orb-ring"></span>
                    <span class="bg-orb-core">{td.emoji || '✨'}</span>
                </span>
                <div class="bg-meta">
                    <div class="bg-meta-top">
                        <strong>{bgTask.description}</strong>
                        <span class="bg-elapsed">· {Math.max(1, Math.round((Date.now() - bgTask.startedAt) / 1000))}s</span>
                    </div>
                    <div class="bg-meta-now">
                        <span class="bg-now-label">Now:</span>
                        <span class="bg-now-tool">{td.label || bgTask.currentTool || 'starting…'}</span>
                        <span class="bg-stat">step {bgTask.step + 1} · {bgTask.toolCount} tool calls</span>
                    </div>
                </div>
                <button type="button" class="bg-task-cancel" onclick={() => cancelBackgroundTask(bgTask!.id)}>Cancel</button>
            </div>
        {/if}

        <div class="messages" bind:this={scrollBox} data-testid="ai-messages">
            {#if !active || active.messages.length === 0}
                <div class="empty">
                    <div class="empty-mark"><Icon name="sparkles" size={24} /></div>
                    <h3>Ready when you are</h3>
                    <p class="muted">
                        Ask me anything — code, calendar, mail. Tick <strong>Email &amp; calendar</strong> to let me search your inbox or schedule events on your behalf. Turn on <strong>Web search</strong> for live web results.
                    </p>
                    <div class="prompt-chips">
                        {#each ['Summarise my unread mail', 'Schedule a team call tomorrow at 2pm', 'Draft a reply to my latest email', 'What’s on my calendar this week?'] as prompt}
                            <button type="button" class="prompt-chip" onclick={() => { input = prompt; }}>{prompt}</button>
                        {/each}
                    </div>
                </div>
            {:else}
                {#each active.messages as m, i (i)}
                    {#if m.role === 'user' || m.role === 'assistant'}
                        {@const isLast = i === active.messages.length - 1}
                        {@const isStreaming = sending && isLast && m.role === 'assistant'}
                        {@const parsed = parseEmailContext(m.content)}
                        {@const doneFlash = !isStreaming && isLast && m.role === 'assistant' && doneFlashThreadId === active.id && doneFlashStamp > 0}
                        <div class={`bubble ${m.role}`} class:streaming={isStreaming} class:done-flash={doneFlash}>
                            <div class="bubble-role">
                                {#if m.role === 'user'}
                                    You
                                {:else}
                                    <Icon name="sparkles" size={11} /> Assistant
                                    {#if isStreaming}<span class="badge-typing">typing…</span>{/if}
                                {/if}
                            </div>
                            {#if parsed.meta}
                                <EmailContextCard
                                    subject={parsed.meta.subject}
                                    fromName={parsed.meta.fromName}
                                    fromAddr={parsed.meta.fromAddr}
                                    date={parsed.meta.date}
                                    preview={parsed.meta.preview}
                                />
                            {/if}
                            <div class="bubble-text">
                                {#if parsed.display}
                                    {@html renderMarkdown(parsed.display)}{#if isStreaming}<span class="caret" aria-hidden="true"></span>{/if}
                                {:else if isStreaming}
                                    <span class="dots" aria-label="Assistant is typing">
                                        <span></span><span></span><span></span>
                                    </span>
                                {/if}
                            </div>
                        </div>
                    {/if}
                {/each}
            {/if}

            {#each pendingWrites as p, i (i)}
                {@const ptd = toolDisplay(p.name)}
                <div class="confirm-card" role="dialog" aria-label="Confirm action" data-testid={`confirm-${p.name}`}>
                    <div class="confirm-head">
                        <Icon name="shield" size={13} />
                        <span class="confirm-title">Approve action?</span>
                        <span class="confirm-tool">{ptd.emoji} {ptd.label}</span>
                    </div>
                    <div class="confirm-body muted small">
                        The assistant wants to make a change. Review and approve to continue, or deny to skip.
                    </div>
                    <div class="confirm-args"><code>{describeArgs(p.args)}</code></div>
                    <div class="confirm-actions">
                        <button type="button" class="btn btn-ghost" onclick={() => answerWrite(i, false)} data-testid="confirm-deny">
                            <Icon name="close" size={12} /> Deny
                        </button>
                        <button type="button" class="btn btn-primary" onclick={() => answerWrite(i, true)} data-testid="confirm-approve">
                            <Icon name="check" size={12} /> Approve
                        </button>
                    </div>
                </div>
            {/each}

            {#each pendingPermissions as p, i (i)}
                {@const meta = CAP_META[p.capability]}
                <div class="permission-card" role="dialog" aria-label="Permission request" data-testid={`permission-${p.capability}`}>
                    <div class="permission-head">
                        <span class="permission-icon" aria-hidden="true"><Icon name={meta.icon} size={16} /></span>
                        <div class="permission-head-text">
                            <div class="permission-title">{meta.title}</div>
                            <div class="permission-sub muted small">You can change this any time from the toolbar</div>
                        </div>
                    </div>

                    {#if p.reason}
                        <div class="permission-why">
                            <span class="why-label">Here's why I'm asking</span>
                            <p class="why-text">{p.reason}</p>
                        </div>
                    {/if}

                    <div class="permission-lists">
                        <div class="perm-list can">
                            <span class="perm-list-label"><Icon name="check" size={10} /> What I can do</span>
                            <ul>
                                {#each meta.can as item}<li>{item}</li>{/each}
                            </ul>
                        </div>
                        <div class="perm-list cannot">
                            <span class="perm-list-label"><Icon name="close" size={10} /> What I won't do</span>
                            <ul>
                                {#each meta.cannot as item}<li>{item}</li>{/each}
                            </ul>
                        </div>
                    </div>

                    <div class="confirm-actions">
                        <button type="button" class="btn btn-ghost" onclick={() => answerPermission(i, false)} data-testid="permission-deny">
                            <Icon name="close" size={12} /> Not now
                        </button>
                        <button type="button" class="btn btn-primary" onclick={() => answerPermission(i, true)} data-testid="permission-allow">
                            <Icon name="check" size={12} /> Allow
                        </button>
                    </div>
                </div>
            {/each}
        </div>

        <form
            class="composer"
            onsubmit={(e) => { e.preventDefault(); send(); }}
            ondragover={(e) => { e.preventDefault(); }}
            ondrop={onComposerDrop}
        >
            {#if pendingImages.length}
                <div class="composer-image-strip" data-testid="ai-pending-images">
                    {#each pendingImages as img, i}
                        <div class="composer-image">
                            <img src={img} alt="Pasted" />
                            <button
                                type="button"
                                class="composer-image-x"
                                title="Remove"
                                aria-label="Remove image"
                                onclick={() => removePendingImage(i)}
                            ><Icon name="close" size={10} /></button>
                        </div>
                    {/each}
                </div>
            {/if}
            <textarea
                placeholder={listening ? 'Listening… speak now' : 'Message your assistant — Shift+Enter for newline, paste an image to attach'}
                bind:value={input}
                onkeydown={onComposerKey}
                onpaste={onComposerPaste}
                rows="1"
                data-testid="ai-input"
            ></textarea>
            {#if listening && interimTranscript}
                <div class="mic-interim" aria-live="polite">{interimTranscript}</div>
            {/if}
            <div class="composer-actions">
                {#if isSttAvailable()}
                    <button
                        type="button"
                        class={`mic-btn ${listening ? 'listening' : ''}`}
                        onclick={listening ? stopListening : startListening}
                        title={listening ? 'Stop listening' : 'Speak (mic)'}
                        aria-label={listening ? 'Stop listening' : 'Start voice input'}
                        data-testid="ai-mic"
                    >
                        <Icon name="bell" size={14} />
                        {#if listening}<span class="mic-pulse" aria-hidden="true"></span>{/if}
                    </button>
                {/if}
                {#if sending}
                    <button type="button" class="btn btn-ghost" onclick={() => { stop(); stopSpeaking(); }} data-testid="ai-stop">Stop</button>
                {:else}
                    <button
                        type="submit"
                        class="btn btn-primary"
                        disabled={!input.trim() && pendingImages.length === 0}
                        data-testid="ai-send"
                    ><Icon name="send" size={13} /> Send</button>
                {/if}
            </div>
        </form>
    </main>
</div>

{#if voiceModeOpen}
    <VoiceChat onClose={() => voiceModeOpen = false} />
{/if}

<style>
    .ai-app {
        flex: 1;
        display: grid;
        grid-template-columns: 260px 1fr;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--bg-base);
    }
    .ai-sidebar {
        display: flex;
        flex-direction: column;
        background: var(--bg-surface);
        border-right: 1px solid var(--border-subtle);
        min-height: 0;
        overflow: hidden;
    }
    .side-head {
        padding: 10px;
        display: flex;
        gap: 6px;
    }
    .new-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 9px 10px;
        font-size: 12.5px;
        font-weight: 600;
        background: var(--accent);
        color: var(--text-on-accent);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-sm);
    }
    .new-btn:hover { filter: brightness(1.05); box-shadow: var(--shadow-md); }
    .search-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 0 10px 8px;
        padding: 6px 10px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-tertiary);
    }
    .search-wrap input {
        flex: 1;
        background: transparent;
        border: 0;
        font-size: 12.5px;
        color: var(--text-primary);
    }
    .search-wrap input:focus { outline: none; }
    .thread-list {
        list-style: none;
        margin: 0;
        padding: 0 8px 8px;
        overflow-y: auto;
        flex: 1;
    }
    .thread-row {
        display: flex;
        align-items: stretch;
        gap: 2px;
        margin-bottom: 2px;
        border-radius: var(--radius-sm);
    }
    .thread-row:hover { background: var(--bg-hover); transform: translateX(1px); }
    .thread-row { transition: background-color var(--transition-fast), transform 120ms ease; }

    /* Right-click chat context menu. */
    .chat-ctx-menu {
        list-style: none;
        margin: 0;
        padding: 4px;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        min-width: 160px;
        animation: fade-in 120ms ease-out;
    }
    .chat-ctx-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 10px;
        font-size: 13px;
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        text-align: left;
        background: transparent;
    }
    .chat-ctx-item:hover { background: var(--bg-hover); }
    .chat-ctx-item.danger { color: var(--danger); }
    .chat-ctx-item.danger:hover { background: var(--danger-soft); }
    .thread-row.active {
        background: var(--accent-soft);
        box-shadow: inset 2px 0 0 var(--accent);
    }

    .thread-pick {
        flex: 1;
        display: grid;
        grid-template-columns: auto 1fr;
        column-gap: 8px;
        row-gap: 1px;
        align-items: center;
        padding: 8px 10px;
        text-align: left;
        min-width: 0;
    }
    .thread-kind-icon {
        grid-row: span 2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        border-radius: 6px;
        background: var(--bg-surface-alt);
        color: var(--text-tertiary);
    }

    .thread-title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
    .thread-row.active .thread-title { color: var(--accent-text); font-weight: 600; }
    .thread-meta {
        font-size: 10.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .thread-del {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        color: var(--text-tertiary);
        opacity: 0;
        transition: opacity var(--transition-fast);
    }
    .thread-row:hover .thread-del { opacity: 1; }
    .thread-del:hover { color: var(--danger); background: var(--danger-soft); }

    .ai-main {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--bg-surface);
    }

    .ai-toolbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 22px;
        border-bottom: 1px solid var(--border-subtle);
        flex-wrap: wrap;
    }
    .ai-title {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.01em;
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .ai-title-text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .model-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border-radius: 999px;
        background: var(--bg-tag);
        color: var(--text-tertiary);
        border: 1px solid var(--border-subtle);
        flex-shrink: 0;
    }
    .model-badge.search-badge {
        background: rgba(27, 163, 184, 0.12);
        color: #0d8497;
        border-color: rgba(27, 163, 184, 0.30);
    }
    .tool-toggles { display: flex; gap: 4px; flex-wrap: wrap; }
    .tool-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        font-size: 11.5px;
        font-weight: 500;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        color: var(--text-secondary);
        cursor: pointer;
        user-select: none;
        transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
    }
    .tool-toggle input { width: 12px; height: 12px; accent-color: var(--accent); }
    .tool-toggle:has(input:checked) {
        background: var(--accent-soft);
        border-color: color-mix(in srgb, var(--accent) 40%, var(--border-subtle));
        color: var(--accent-text);
    }

    .messages {
        flex: 1 1 0;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior-y: contain;
        -webkit-overflow-scrolling: touch;
        padding: 28px 24px 0;
        display: flex;
        flex-direction: column;
        gap: 20px;
    }
    .empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        color: var(--text-tertiary);
        text-align: center;
        padding: 48px 32px;
    }
    .empty-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 72px;
        height: 72px;
        border-radius: 24px;
        background: linear-gradient(135deg, var(--accent-soft) 0%, color-mix(in srgb, var(--accent) 12%, var(--bg-base)) 100%);
        color: var(--accent);
        box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 15%, transparent);
    }
    .empty h3 { margin: 8px 0 0; font-size: 20px; color: var(--text-primary); font-weight: 700; letter-spacing: -0.02em; }
    .empty p { margin: 0; max-width: 460px; font-size: 14px; line-height: 1.6; color: var(--text-secondary); }
    .prompt-chips {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        margin-top: 16px;
        max-width: 480px;
    }
    .prompt-chip {
        padding: 7px 14px;
        font-size: 12.5px;
        font-weight: 500;
        color: var(--text-secondary);
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        cursor: pointer;
        transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast), transform 120ms ease;
    }
    .prompt-chip:hover {
        background: var(--accent-soft);
        border-color: color-mix(in srgb, var(--accent) 40%, var(--border-subtle));
        color: var(--accent-text);
        transform: translateY(-1px);
    }

    .bubble {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-width: 820px;
        min-width: 0;
        align-self: flex-start;
        padding: 14px 18px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        position: relative;
        overflow: hidden;
        box-shadow: 0 1px 2px rgba(0,0,0,0.04);
        transition: box-shadow 200ms ease;
        /* Without this, long conversations cause flex children inside the
           scroll container to shrink instead of overflowing — bubbles get
           squished and the pane refuses to scroll. */
        flex-shrink: 0;
    }
    .bubble:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
    .bubble:not(.user)::before {
        content: '';
        position: absolute;
        left: 0;
        top: 8px;
        bottom: 8px;
        width: 3px;
        border-radius: 0 2px 2px 0;
        background: linear-gradient(180deg,
            color-mix(in srgb, var(--accent) 70%, transparent),
            color-mix(in srgb, var(--accent) 30%, transparent));
    }
    .bubble.user {
        align-self: flex-end;
        background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 22%, var(--bg-surface)) 0%, color-mix(in srgb, var(--accent) 12%, var(--bg-surface)) 100%);
        border-color: color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        color: var(--text-primary);
    }
    .bubble.user .bubble-text {
        color: var(--text-primary);
    }
    .bubble-role {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
        display: inline-flex;
        align-items: center;
        gap: 5px;
    }
    .bubble.user .bubble-role { color: var(--accent-text); }
    .badge-typing {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: 1px 6px;
        background: var(--accent-soft);
        color: var(--accent-text);
        border-radius: 8px;
        margin-left: 2px;
        animation: typing-fade 1.4s ease-in-out infinite;
    }
    @keyframes typing-fade {
        0%, 100% { opacity: 0.6; }
        50%      { opacity: 1; }
    }
    /* Three-dot bouncer for "model is thinking, no tokens yet" state. */
    .dots {
        display: inline-flex;
        gap: 4px;
        padding: 4px 0;
    }
    .dots span {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--accent) 60%, var(--text-tertiary));
        animation: dot-bounce 1.2s ease-in-out infinite;
    }
    .dots span:nth-child(2) { animation-delay: 0.18s; }
    .dots span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes dot-bounce {
        0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
        40%           { transform: translateY(-4px); opacity: 1; }
    }
    /* Blinking caret at the end of the streaming text. */
    .caret {
        display: inline-block;
        width: 7px;
        height: 14px;
        margin-left: 2px;
        background: var(--accent);
        vertical-align: middle;
        border-radius: 1px;
        animation: caret-blink 1s step-end infinite;
    }
    @keyframes caret-blink {
        0%, 49%   { opacity: 1; }
        50%, 100% { opacity: 0; }
    }
    .bubble.streaming {
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
    }
    .bg-task-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface));
        border-bottom: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border-subtle));
        font-size: 12.5px;
    }
    .bg-task-text { flex: 1; min-width: 0; }
    .bg-task-spinner {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
        border-top-color: var(--accent);
        animation: bg-task-spin 0.9s linear infinite;
    }
    @keyframes bg-task-spin { to { transform: rotate(360deg); } }
    .bg-task-cancel {
        appearance: none;
        background: transparent;
        border: 1px solid var(--border-subtle);
        border-radius: 6px;
        padding: 3px 8px;
        font-size: 11.5px;
        cursor: pointer;
        color: var(--text-secondary);
    }
    .bg-task-cancel:hover { background: var(--bg-hover); color: var(--text-primary); }
    @media (prefers-reduced-motion: reduce) {
        .bg-task-spinner { animation: none; }
    }

    /* Rich live-progress widget shown above the chat scroll while a
     * bg task runs. Mirrors the global floater's purple aesthetic but
     * sits inline so it's immediately visible without competing for
     * attention with the floater. */
    .bg-task-widget {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 8px 12px 0;
        padding: 10px 12px;
        background: linear-gradient(135deg,
            color-mix(in srgb, #8b5cf6 18%, var(--bg-surface)) 0%,
            color-mix(in srgb, #6366f1 10%, var(--bg-surface)) 100%);
        border: 1px solid color-mix(in srgb, #8b5cf6 32%, var(--border-subtle));
        border-radius: 14px;
        box-shadow: 0 4px 14px color-mix(in srgb, #6366f1 12%, transparent);
        font-size: 12.5px;
    }
    .bg-orb {
        position: relative;
        width: 32px; height: 32px;
        flex: 0 0 32px;
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
    .bg-orb-core { font-size: 16px; line-height: 1; }
    @keyframes bg-orb-spin { to { transform: rotate(360deg); } }
    .bg-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .bg-meta-top {
        display: flex;
        align-items: baseline;
        gap: 6px;
    }
    .bg-meta-top strong {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 280px;
    }
    .bg-elapsed { color: var(--text-tertiary); font-size: 11.5px; }
    .bg-meta-now {
        display: flex;
        align-items: baseline;
        gap: 6px;
        color: var(--text-secondary);
        font-size: 11.5px;
    }
    .bg-now-label { opacity: 0.7; }
    .bg-now-tool {
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 220px;
    }
    .bg-stat { margin-left: auto; opacity: 0.75; font-variant-numeric: tabular-nums; }
    @media (prefers-reduced-motion: reduce) {
        .bg-orb-ring { animation: none; }
    }
    /* One-shot glow when the assistant finishes a turn — pulses the
     * accent ring around the bubble so the user notices the reply
     * landed even if they were skimming elsewhere on the page. */
    .bubble.done-flash {
        animation: bubble-done 2s ease-out;
    }
    @keyframes bubble-done {
        0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 65%, transparent); }
        20%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 28%, transparent); }
        100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) {
        .badge-typing, .dots span, .caret { animation: none; }
        .bubble.done-flash { animation: none; }
    }

    /* Write-tool approval card. Sits inline in the message stream until
     * the user picks Approve or Deny — chatTurn is parked on its
     * Promise. Multiple writes in one turn stack vertically. */
    .confirm-card {
        align-self: stretch;
        max-width: 560px;
        padding: 14px 16px;
        background: color-mix(in srgb, #d18c1d 12%, var(--bg-surface-alt));
        border: 1px solid color-mix(in srgb, #d18c1d 38%, var(--border-subtle));
        border-left: 3px solid #d18c1d;
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: 8px;
        animation: fade-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .confirm-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .confirm-title {
        font-size: 12.5px;
        font-weight: 700;
        color: var(--text-primary);
    }
    .confirm-tool { margin-left: auto; }
    .confirm-tool code {
        font-family: var(--font-mono);
        font-size: 11px;
        padding: 2px 7px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        color: var(--text-secondary);
    }
    .confirm-body { line-height: 1.5; }
    .confirm-args {
        padding: 8px 10px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        font-size: 11.5px;
        word-break: break-word;
    }
    .confirm-args code {
        font-family: var(--font-mono);
        color: var(--text-primary);
    }
    .confirm-actions {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
        flex-wrap: wrap;
    }
    .confirm-actions .btn { padding: 6px 12px; font-size: 12px; }

    /* Permission ask card (model called `request_permission`). Visually
     * cousins with .confirm-card but cooler-toned so the user can tell at
     * a glance the difference between "approve a destructive write" and
     * "grant a new capability". */
    .permission-card {
        align-self: stretch;
        max-width: 560px;
        padding: 14px 16px;
        background: color-mix(in srgb, var(--accent) 8%, var(--bg-surface-alt));
        border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        border-left: 3px solid var(--accent);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: 10px;
        animation: fade-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .permission-head {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        flex-wrap: wrap;
    }
    .permission-head-text {
        min-width: 0;
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .permission-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px; height: 34px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--accent) 18%, var(--bg-surface));
        color: var(--accent);
        flex-shrink: 0;
    }
    .permission-title {
        font-size: 14px;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.35;
    }
    .permission-sub { line-height: 1.45; font-size: 12px; }

    .permission-why {
        padding: 10px 12px;
        background: var(--bg-surface);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
    }
    .why-label {
        display: block;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--accent-text);
        margin-bottom: 4px;
    }
    .why-text {
        margin: 0;
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--text-primary);
    }

    .permission-lists {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
    }
    @media (max-width: 480px) {
        .permission-lists { grid-template-columns: 1fr; }
    }
    .perm-list {
        padding: 10px 12px;
        border-radius: var(--radius-sm);
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
    }
    .perm-list.can { border-left: 3px solid #22c55e; }
    .perm-list.cannot { border-left: 3px solid #ef4444; }
    .perm-list-label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 6px;
    }
    .perm-list.can .perm-list-label { color: #22c55e; }
    .perm-list.cannot .perm-list-label { color: #ef4444; }
    .perm-list ul {
        margin: 0;
        padding-left: 16px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .perm-list li {
        font-size: 12px;
        line-height: 1.45;
        color: var(--text-secondary);
    }
    .bubble-text {
        font-size: 15px;
        line-height: 1.65;
        color: var(--text-primary);
        word-wrap: break-word;
        overflow-wrap: anywhere;
    }
    /* Markdown-rendered elements inside chat bubbles */
    .bubble-text :global(p) { margin: 0 0 8px; }
    .bubble-text :global(p:last-child) { margin-bottom: 0; }
    .bubble-text :global(strong) { font-weight: 700; color: var(--text-primary); }
    .bubble-text :global(em) { font-style: italic; }
    .bubble-text :global(del) { text-decoration: line-through; opacity: 0.7; }
    .bubble-text :global(code) {
        font-family: var(--font-mono);
        font-size: 12.5px;
        padding: 1px 5px;
        background: color-mix(in srgb, var(--accent) 8%, var(--bg-base));
        border: 1px solid color-mix(in srgb, var(--accent) 15%, var(--border-subtle));
        border-radius: var(--radius-xs);
        color: var(--accent-text);
    }
    .bubble-text :global(pre) {
        margin: 8px 0;
        padding: 10px 12px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        overflow-x: auto;
    }
    .bubble-text :global(pre code) {
        background: none;
        border: none;
        padding: 0;
        color: var(--text-primary);
        font-size: 12px;
    }
    .bubble-text :global(blockquote) {
        margin: 8px 0;
        padding: 6px 12px;
        border-left: 3px solid var(--accent);
        background: color-mix(in srgb, var(--accent) 5%, transparent);
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        font-style: italic;
    }
    .bubble-text :global(ul), .bubble-text :global(ol) {
        margin: 6px 0;
        padding-left: 20px;
    }
    .bubble-text :global(li) { margin: 3px 0; }
    .bubble-text :global(a) {
        color: var(--accent);
        text-decoration: underline;
        text-underline-offset: 2px;
    }
    .bubble-text :global(a:hover) { opacity: 0.8; }
    .bubble-text :global(h1), .bubble-text :global(h2), .bubble-text :global(h3), .bubble-text :global(h4) {
        font-size: 14px;
        font-weight: 700;
        margin: 10px 0 6px;
        color: var(--text-primary);
    }
    .bubble-text :global(hr) {
        border: none;
        border-top: 1px solid var(--border-subtle);
        margin: 10px 0;
    }

    .composer {
        flex: 0 0 auto;
        padding: 14px 20px 18px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface);
    }
    .composer textarea {
        width: 100%;
        min-height: 52px;
        max-height: 220px;
        padding: 14px 18px;
        font-family: inherit;
        font-size: 15px;
        line-height: 1.55;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: 18px;
        color: var(--text-primary);
        resize: vertical;
        box-shadow: var(--shadow-sm);
        transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    .composer textarea:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--accent) 50%, var(--border-subtle));
        box-shadow:
            0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent),
            0 2px 8px color-mix(in srgb, var(--accent) 8%, transparent);
    }
    .composer-image-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0 0 10px;
    }
    .composer-image {
        position: relative;
        width: 72px;
        height: 72px;
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid var(--border-subtle);
        box-shadow: var(--shadow-sm);
    }
    .composer-image img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }
    .composer-image-x {
        position: absolute;
        top: 4px; right: 4px;
        width: 18px; height: 18px;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.55);
        color: #fff;
        border: none;
        border-radius: 50%;
        cursor: pointer;
    }
    .composer-image-x:hover { background: rgba(0, 0, 0, 0.78); }
    .voice-on {
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 18%, var(--bg-base)),
            color-mix(in srgb, #d268f4 14%, var(--bg-base))) !important;
        border-color: color-mix(in srgb, var(--accent) 40%, var(--border-subtle)) !important;
    }
    .voice-mode-toggle {
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 22%, var(--bg-base)),
            color-mix(in srgb, var(--accent) 10%, var(--bg-base)));
        border-color: color-mix(in srgb, var(--accent) 45%, var(--border-subtle));
        color: var(--accent-text);
        font-weight: 600;
        cursor: pointer;
    }
    .voice-mode-toggle:hover {
        background: linear-gradient(135deg,
            color-mix(in srgb, var(--accent) 30%, var(--bg-base)),
            color-mix(in srgb, var(--accent) 16%, var(--bg-base)));
    }
    .mic-btn {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .mic-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
    .mic-btn.listening {
        background: var(--danger-soft);
        color: var(--danger);
        border-color: color-mix(in srgb, var(--danger) 40%, var(--border-subtle));
    }
    .mic-pulse {
        position: absolute;
        inset: -3px;
        border-radius: 50%;
        border: 2px solid var(--danger);
        animation: mic-pulse 1.4s ease-out infinite;
    }
    @keyframes mic-pulse {
        0%   { transform: scale(0.85); opacity: 0.85; }
        100% { transform: scale(1.4); opacity: 0; }
    }
    .mic-interim {
        margin-top: 6px;
        padding: 8px 10px;
        font-size: 12.5px;
        font-style: italic;
        color: var(--text-secondary);
        background: var(--bg-base);
        border: 1px dashed color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
        border-radius: var(--radius-sm);
    }
    @media (prefers-reduced-motion: reduce) {
        .mic-pulse { animation: none; }
    }
    .composer-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 8px;
        flex-wrap: wrap;
    }

    @media (max-width: 720px) {
        .ai-app { grid-template-columns: 1fr; }
        .ai-sidebar { display: none; }
    }
</style>
