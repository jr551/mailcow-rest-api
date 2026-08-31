<script lang="ts">
    // Fullscreen voice-conversation overlay. Think ChatGPT voice mode:
    // open it, speak naturally, the assistant replies aloud, repeat.
    //
    // The mic stream is always live while the overlay is open. We use:
    //   * SpeechRecognition (Web Speech API) for live cumulative transcript
    //   * a parallel AnalyserNode on the same getUserMedia stream for
    //     RMS-based silence detection — that's what triggers auto-submit
    //     instead of waiting for the recognizer's flaky onend / isFinal
    //
    // Closing the overlay leaves the full text transcript in the active
    // thread so the user can pick up in text chat at any time.

    import { onMount, onDestroy } from 'svelte';
    import {
        aiState, newThread, appendMessage
    } from '../../lib/ai-threads.svelte';
    import {
        chatTurn, TOOLS, META_TOOLS, SYSTEM_PROMPT,
        isChatConfigured, type ChatMessage
    } from '../../lib/chat.svelte';
    import { settings, capabilities } from '../../lib/settings.svelte';
    import { showToast } from '../../lib/store.svelte';
    import { playVoiceStart } from '../../lib/sounds.svelte';
    import {
        isVoiceAvailable, speakWithElevenLabs, stopSpeaking,
        isSttAvailable, createSpeechRecognizer
    } from '../../lib/voice.svelte';
    import Icon from '../Icon.svelte';
    import { renderMarkdown } from '../../lib/markdown';

    interface Props {
        onClose: () => void;
    }
    let { onClose }: Props = $props();

    // --- Tunables ----------------------------------------------------------
    // Keep the UX snappy without cutting people off mid-thought. The values
    // err on the sensitive side — a missed word is recoverable (the user
    // can tap Send manually), but a never-firing submit is invisible and
    // makes the whole feature look broken.
    const VOICE_RMS_THRESHOLD = 0.008;     // mic-on detection (lower = more sensitive; many laptop mics never reach 0.015)
    const SILENCE_HOLD_MS = 1100;          // silence (or no transcript change) before auto-submit
    const FINAL_SEGMENT_GRACE_MS = 600;    // shorter grace once Web Speech marks a segment final
    const BARGE_IN_HOLD_MS = 250;          // voice while speaking → interrupt
    const ANALYSER_TICK_MS = 80;
    const MAX_RECOGNIZER_RESTART_DELAY = 600;
    const FIRST_AUDIO_TIMEOUT_MS = 9000;   // surface a hint if STT never produced anything

    let phase = $state<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
    let interimTranscript = $state('');
    let micLevel = $state(0); // 0..1 for the orb glow
    let scrollBox: HTMLDivElement | undefined = $state();
    let alive = $state(true);
    let micPermission = $state<'unknown' | 'granted' | 'denied'>('unknown');

    // Recognizer + audio plumbing
    let recognizer: ReturnType<typeof createSpeechRecognizer> | null = null;
    let recRestartTimer: ReturnType<typeof setTimeout> | null = null;
    let recErrors = 0;
    const MAX_REC_ERRORS = 5;

    let mediaStream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    // Allocate over a plain ArrayBuffer so the type matches the DOM
    // signature exactly (Uint8Array<ArrayBuffer>, not the wider default
    // that includes SharedArrayBuffer).
    let analyserData: Uint8Array<ArrayBuffer> | null = null;
    let analyserTimer: ReturnType<typeof setInterval> | null = null;

    // Conversation state
    let abortCtrl: AbortController | null = null;
    let speakingAbort: AbortController | null = null;
    let currentText = ''; // accumulated transcript for THIS turn
    let lastTextChangeMs = 0; // wall-clock of the last currentText mutation
    let lastFinalMs = 0;  // last time Web Speech committed a *final* segment
    let lastVoiceMs = 0;  // last time RMS exceeded threshold
    let voiceSince = 0;   // when current voice burst started (for barge-in)
    let hadVoiceThisTurn = false;
    let submittedTurn = false; // dedupe: once we send, don't re-send the same text
    let listeningStartedMs = 0; // for FIRST_AUDIO_TIMEOUT_MS hint
    let heardNothingHint = $state(false); // shown when STT produces zero text after the timeout

    let activeThread = $derived(aiState.threads.find((t) => t.id === aiState.activeId) ?? null);

    onMount(async () => {
        if (!aiState.activeId) newThread();
        // Run mic init immediately while the user-gesture context from the
        // FAB click is still hot. The 300ms delay was eating the gesture
        // on Safari/iOS and AudioContext was landing in 'suspended' with
        // no resume() ever called → mic looked dead with no errors.
        await initMic();
    });

    onDestroy(() => {
        alive = false;
        teardown();
    });

    function teardown() {
        if (recRestartTimer) { clearTimeout(recRestartTimer); recRestartTimer = null; }
        if (analyserTimer) { clearInterval(analyserTimer); analyserTimer = null; }
        try { recognizer?.stop(); } catch { /* */ }
        recognizer = null;
        speakingAbort?.abort();
        abortCtrl?.abort();
        stopSpeaking();
        if (analyser) { try { analyser.disconnect(); } catch { /* */ } analyser = null; }
        if (audioCtx) { try { audioCtx.close(); } catch { /* */ } audioCtx = null; }
        if (mediaStream) {
            mediaStream.getTracks().forEach((t) => t.stop());
            mediaStream = null;
        }
        phase = 'idle';
    }

    async function initMic() {
        if (!alive) return;
        if (!isSttAvailable()) {
            showToast('error', 'Speech recognition is not supported in this browser. Try Chrome, Edge, or Safari.');
            return;
        }
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            micPermission = 'granted';
        } catch (err) {
            micPermission = 'denied';
            const name = (err as Error).name;
            if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
                showToast('error', 'Microphone permission denied. Allow it in your browser, then re-open voice chat.');
            } else {
                showToast('error', `Couldn’t access microphone: ${(err as Error).message}`);
            }
            return;
        }

        try {
            const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
                || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            audioCtx = new Ctor();
            // Browsers create the context in 'suspended' state when there
            // is no active user gesture chain. Resume explicitly so the
            // analyser actually receives audio frames.
            if (audioCtx.state === 'suspended') {
                try { await audioCtx.resume(); } catch { /* noop */ }
            }
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.6;
            const src = audioCtx.createMediaStreamSource(mediaStream);
            src.connect(analyser);
            analyserData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
            analyserTimer = setInterval(tickAnalyser, ANALYSER_TICK_MS);
        } catch {
            // Without the analyser we can still recognize, just no silence
            // detection — fall back to onEnd-based submit.
        }

        startListening();
    }

    function tickAnalyser() {
        if (!analyser || !analyserData) return;
        analyser.getByteTimeDomainData(analyserData);
        // RMS of normalized [-1, 1] samples.
        let sum = 0;
        for (let i = 0; i < analyserData.length; i++) {
            const v = (analyserData[i] - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / analyserData.length);
        micLevel = Math.min(1, rms / 0.3);
        const now = performance.now();
        const isVoice = rms > VOICE_RMS_THRESHOLD;

        if (phase === 'speaking') {
            // Barge-in: continuous voice for BARGE_IN_HOLD_MS interrupts.
            if (isVoice) {
                if (voiceSince === 0) voiceSince = now;
                if (now - voiceSince > BARGE_IN_HOLD_MS) {
                    voiceSince = 0;
                    bargeIn();
                }
            } else {
                voiceSince = 0;
            }
            return;
        }

        if (phase !== 'listening') return;

        if (isVoice) {
            lastVoiceMs = now;
            hadVoiceThisTurn = true;
        }

        // "Heard nothing yet" hint: STT produced zero text within the
        // timeout. Common when the browser/OS muted the mic, the user
        // is on Firefox (no Web Speech), or the OS speech engine is
        // missing. Shows a friendly nudge and keeps the manual Send
        // button reachable.
        if (!heardNothingHint && listeningStartedMs > 0
            && now - listeningStartedMs > FIRST_AUDIO_TIMEOUT_MS
            && lastTextChangeMs === 0) {
            heardNothingHint = true;
        }

        // Three paths to auto-submit, ANY suffices:
        //   A. Web Speech committed a *final* segment AND mic has been
        //      quiet (or text hasn't changed) for FINAL_SEGMENT_GRACE_MS.
        //      Fastest, most reliable when STT is healthy.
        //   B. We saw voice activity this turn AND mic has been quiet for
        //      SILENCE_HOLD_MS while transcript is non-empty.
        //   C. Transcript hasn't changed for SILENCE_HOLD_MS — covers
        //      cases where the analyser failed to acquire / mic is too
        //      quiet for our threshold but Web Speech still produced text.
        const text = currentText.trim();
        if (submittedTurn || text.length < 2) return;
        const finalReady = lastFinalMs > 0 && now - lastFinalMs >= FINAL_SEGMENT_GRACE_MS
            && (now - lastVoiceMs >= FINAL_SEGMENT_GRACE_MS || !hadVoiceThisTurn);
        const quietViaMic = hadVoiceThisTurn && now - lastVoiceMs >= SILENCE_HOLD_MS;
        const quietViaText = lastTextChangeMs > 0 && now - lastTextChangeMs >= SILENCE_HOLD_MS;
        if (finalReady || quietViaMic || quietViaText) {
            void submitTurn(text);
        }
    }

    function bargeIn() {
        speakingAbort?.abort();
        stopSpeaking();
        currentText = '';
        interimTranscript = '';
        hadVoiceThisTurn = true;
        lastVoiceMs = performance.now();
        submittedTurn = false;
        startListening();
    }

    function startListening() {
        if (!alive) return;
        if (phase === 'thinking') return;
        playVoiceStart();
        phase = 'listening';
        currentText = '';
        interimTranscript = '';
        hadVoiceThisTurn = false;
        lastTextChangeMs = 0;
        lastFinalMs = 0;
        listeningStartedMs = performance.now();
        heardNothingHint = false;
        submittedTurn = false;
        attachRecognizer();
    }

    function attachRecognizer() {
        try { recognizer?.stop(); } catch { /* */ }
        recognizer = createSpeechRecognizer({ continuous: true });
        if (!recognizer) {
            showToast('error', 'Speech recognition unavailable in this browser.');
            phase = 'idle';
            return;
        }

        recognizer.onResult((cumulative, gotFinal) => {
            const now = performance.now();
            if (cumulative !== currentText) {
                currentText = cumulative;
                lastTextChangeMs = now;
            }
            if (gotFinal) lastFinalMs = now;
            interimTranscript = cumulative;
            heardNothingHint = false;
        });

        recognizer.onEnd(() => {
            if (!alive) return;
            // Some browsers stop the recognizer every ~30s even in continuous
            // mode. Just restart it as long as we're still in the listening
            // phase. The silence detector handles auto-submit independently.
            if (phase === 'listening' && !submittedTurn) {
                recRestartTimer = setTimeout(() => {
                    if (alive && phase === 'listening' && !submittedTurn) attachRecognizer();
                }, 250);
            }
        });

        recognizer.onError((err) => {
            if (!alive) return;
            if (err === 'no-speech' || err === 'aborted') {
                // Benign — recognizer will fire onEnd next.
                return;
            }
            if (err === 'not-allowed') {
                micPermission = 'denied';
                showToast('error', 'Microphone permission denied.');
                phase = 'idle';
                return;
            }
            recErrors++;
            if (recErrors >= MAX_REC_ERRORS) {
                showToast('error', 'Speech recognition keeps failing. Try refreshing or another browser.');
                phase = 'idle';
                return;
            }
            const delay = Math.min(MAX_RECOGNIZER_RESTART_DELAY, 200 * recErrors);
            recRestartTimer = setTimeout(() => {
                if (alive && phase === 'listening') attachRecognizer();
            }, delay);
        });

        try { recognizer.start(); recErrors = 0; } catch {
            recRestartTimer = setTimeout(() => { if (alive) attachRecognizer(); }, 300);
        }
    }

    async function submitTurn(text: string) {
        if (submittedTurn || !alive) return;
        submittedTurn = true;
        interimTranscript = '';
        currentText = '';
        hadVoiceThisTurn = false;

        try { recognizer?.stop(); } catch { /* */ }
        recognizer = null;
        if (recRestartTimer) { clearTimeout(recRestartTimer); recRestartTimer = null; }

        phase = 'thinking';

        if (!aiState.activeId) newThread();
        const threadId = aiState.activeId!;
        appendMessage(threadId, { role: 'user', content: text });
        scrollToBottom();

        await runAssistant(threadId);
    }

    async function runAssistant(threadId: string) {
        if (!alive) return;
        if (!isChatConfigured()) {
            showToast('error', 'Configure an AI provider in Settings → AI.');
            phase = 'idle';
            return;
        }

        abortCtrl = new AbortController();
        const placeholder: ChatMessage = { role: 'assistant', content: '' };
        appendMessage(threadId, placeholder);
        scrollToBottom();

        try {
            const thread = aiState.threads.find((t) => t.id === threadId);
            if (!thread) return;
            const history = thread.messages.slice(0, -1);

            const meta = META_TOOLS.filter((t) =>
                t.function.name !== 'web_search' || aiState.tools.webSearch
            );
            const toolCatalog = aiState.tools.accessEmail ? [...TOOLS, ...meta] : [...meta];

            const custom = (settings.aiSystemPrompt || '').trim();
            const lines = custom ? [custom] : [SYSTEM_PROMPT];
            lines.push('You are speaking aloud over a voice channel. Reply in 1-3 short sentences. Avoid markdown, lists, code blocks, and long URLs — they sound bad when read aloud.');
            if (aiState.tools.accessEmail) {
                lines.push('You have tools to read mail, search messages, manage filter rules, and read or change the user\'s calendar. Prefer searching first.');
            }
            if (aiState.tools.webSearch) {
                lines.push('Web search is enabled. Cite sources only if essential.');
            }
            const systemPrompt = lines.join(' ');

            const llm = settings.llm;
            const cfg = capabilities.aiConfig;
            const base = (llm.baseUrl || cfg?.baseUrl || '').toLowerCase();
            const preset = llm.preset || '';
            const isOR = preset === 'openrouter' || base.includes('openrouter.ai');
            const isPplx = preset === 'perplexity' || base.includes('perplexity.ai');
            let modelOverride: string | undefined;
            if (aiState.tools.webSearch) {
                if (isPplx) modelOverride = 'sonar-pro';
                else if (isOR) {
                    const model = cfg?.model || llm.model || 'meta-llama/llama-3.1-8b-instruct';
                    modelOverride = model.endsWith(':online') ? model : `${model}:online`;
                }
            }

            let acc = '';
            for await (const ev of chatTurn(history, {
                signal: abortCtrl.signal,
                tools: toolCatalog,
                systemPrompt,
                modelOverride,
                confirmWrite: async () => false,
                confirmPermission: async () => false
            })) {
                if (ev.type === 'message') {
                    acc += ev.text || '';
                    updateAssistant(threadId, acc, ev.reasoningContent);
                    scrollToBottom();
                } else if (ev.type === 'error') {
                    acc += `\n\n**Error:** ${ev.text}`;
                    updateAssistant(threadId, acc);
                    scrollToBottom();
                    break;
                } else if (ev.type === 'done') {
                    break;
                }
            }

            const t = aiState.threads.find((th) => th.id === threadId);
            const last = t?.messages[t.messages.length - 1];
            if (last?.role === 'assistant' && last.content) {
                if (isVoiceAvailable()) {
                    phase = 'speaking';
                    speakingAbort = new AbortController();
                    voiceSince = 0;
                    try {
                        await speakWithElevenLabs(stripForSpeech(last.content), {
                            signal: speakingAbort.signal
                        });
                    } catch (err) {
                        const e = err as Error;
                        if (e.name !== 'AbortError') {
                            console.warn('TTS failed:', err);
                            showToast('error', `Voice playback: ${e.message}`);
                        }
                    }
                }
            }
        } catch (err) {
            updateAssistant(threadId, `Error: ${(err as Error).message}`);
            scrollToBottom();
        } finally {
            abortCtrl = null;
            speakingAbort = null;
            // Loop back into listening for the next turn.
            if (alive) startListening();
        }
    }

    /** Strip markdown, code blocks, and URLs that read badly aloud. */
    function stripForSpeech(text: string): string {
        return text
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/[*_#>]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function updateAssistant(threadId: string, text: string, reasoningContent?: string) {
        const idx = aiState.threads.findIndex((t) => t.id === threadId);
        if (idx < 0) return;
        const thread = aiState.threads[idx];
        const lastIdx = thread.messages.length - 1;
        if (lastIdx < 0 || thread.messages[lastIdx].role !== 'assistant') return;
        const prev = thread.messages[lastIdx];
        thread.messages[lastIdx] = {
            ...prev,
            content: text,
            ...(reasoningContent ? { reasoningContent } : {})
        };
        aiState.threads[idx] = { ...thread, updatedAt: Date.now() };
    }

    function scrollToBottom() {
        queueMicrotask(() => {
            if (scrollBox) scrollBox.scrollTop = scrollBox.scrollHeight;
        });
    }

    function handleClose() {
        teardown();
        onClose();
    }

    function handleTapOrb() {
        // Manual submit — useful if the silence detector is being shy.
        if (phase === 'listening') {
            const t = currentText.trim();
            if (t.length >= 1 && !submittedTurn) {
                void submitTurn(t);
            }
        } else if (phase === 'speaking') {
            bargeIn();
        }
    }

    function handleManualSend() {
        if (phase !== 'listening') return;
        const t = currentText.trim();
        if (t.length >= 1 && !submittedTurn) void submitTurn(t);
    }
</script>

<div class="voice-overlay" data-testid="voice-chat-overlay">
    <header class="voice-header">
        <span class="voice-title">{activeThread?.title || 'Voice chat'}</span>
        <button type="button" class="voice-close" onclick={handleClose} aria-label="Close voice chat" data-testid="voice-close">
            <Icon name="close" size={18} />
        </button>
    </header>

    <div class="voice-body">
        <div class="transcript" bind:this={scrollBox} data-testid="voice-transcript">
            {#if activeThread && activeThread.messages.length > 0}
                {#each activeThread.messages as m, i (i)}
                    {#if m.role === 'user' || m.role === 'assistant'}
                        <div class={`v-bubble ${m.role}`} data-testid={`voice-bubble-${m.role}-${i}`}>
                            <div class="v-bubble-text">
                                {#if m.content}
                                    {@html renderMarkdown(m.content)}
                                {:else}
                                    <span class="dots" aria-label="Loading"><span></span><span></span><span></span></span>
                                {/if}
                            </div>
                        </div>
                    {/if}
                {/each}
            {:else}
                <div class="voice-empty muted">
                    <p>Say something to start the conversation</p>
                </div>
            {/if}
        </div>

        <div class="orb-wrap">
            <button
                type="button"
                class="orb"
                class:listening={phase === 'listening'}
                class:thinking={phase === 'thinking'}
                class:speaking={phase === 'speaking'}
                style="--mic-level: {micLevel};"
                onclick={handleTapOrb}
                aria-label="Voice state orb"
            >
                {#if phase === 'listening'}
                    <span class="orb-icon"><Icon name="mic" size={32} /></span>
                {:else if phase === 'thinking'}
                    <span class="orb-icon"><Icon name="sparkles" size={32} /></span>
                {:else if phase === 'speaking'}
                    <span class="orb-icon"><Icon name="bell" size={32} /></span>
                {:else}
                    <span class="orb-icon"><Icon name="mic" size={32} /></span>
                {/if}
                {#if phase === 'listening'}
                    <span class="orb-ring" aria-hidden="true"></span>
                    <span class="orb-ring orb-ring-2" aria-hidden="true"></span>
                {/if}
                {#if phase === 'speaking'}
                    <span class="orb-wave" aria-hidden="true"></span>
                    <span class="orb-wave orb-wave-2" aria-hidden="true"></span>
                {/if}
            </button>
            <div class="orb-label">
                {#if micPermission === 'denied'}
                    Mic blocked — allow it in your browser
                {:else if phase === 'listening'}
                    {#if interimTranscript}
                        <span class="interim">{interimTranscript}</span>
                    {:else if heardNothingHint}
                        <span class="hint warn">Didn't catch anything yet — try moving closer to the mic, or type in the AI tab instead.</span>
                    {:else}
                        Listening…
                    {/if}
                {:else if phase === 'thinking'}
                    Thinking…
                {:else if phase === 'speaking'}
                    Speaking… <span class="hint">tap or talk to interrupt</span>
                {:else}
                    Tap to speak
                {/if}
            </div>
            {#if phase === 'listening' && interimTranscript}
                <button
                    type="button"
                    class="manual-send"
                    onclick={handleManualSend}
                    data-testid="voice-manual-send"
                    aria-label="Send now"
                >
                    <Icon name="send" size={14} />
                    <span>Send now</span>
                </button>
            {/if}
        </div>
    </div>
</div>

<style>
    .voice-overlay {
        position: fixed;
        inset: 0;
        z-index: 300;
        display: flex;
        flex-direction: column;
        background: color-mix(in srgb, var(--bg-base) 96%, transparent);
        backdrop-filter: blur(16px);
        animation: voice-fade-in 260ms ease;
        height: 100dvh;
        padding-bottom: env(safe-area-inset-bottom);
        padding-top: env(safe-area-inset-top);
    }
    @keyframes voice-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
    }

    .voice-header {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .voice-title {
        font-size: 15px;
        font-weight: 700;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding-right: 8px;
    }
    .voice-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        flex-shrink: 0;
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .voice-close:hover { background: var(--danger-soft); color: var(--danger); }

    .voice-body {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        padding: 12px 16px 20px;
        gap: 16px;
    }

    .transcript {
        flex: 1;
        min-height: 0;
        width: 100%;
        max-width: 720px;
        margin: 0 auto;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 4px;
        -webkit-overflow-scrolling: touch;
    }

    .voice-empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        font-size: 14px;
        color: var(--text-tertiary);
    }

    .v-bubble {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-width: 85%;
        padding: 10px 14px;
        border-radius: var(--radius-lg);
        font-size: 14.5px;
        line-height: 1.55;
        animation: bubble-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes bubble-in {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
    }

    .v-bubble.user {
        align-self: flex-end;
        background: color-mix(in srgb, var(--accent) 18%, var(--bg-surface));
        border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        color: var(--text-primary);
    }
    .v-bubble:not(.user) {
        align-self: flex-start;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        color: var(--text-primary);
    }

    .v-bubble-text :global(p) { margin: 0 0 6px; }
    .v-bubble-text :global(p:last-child) { margin-bottom: 0; }
    .v-bubble-text :global(strong) { font-weight: 700; }
    .v-bubble-text :global(code) {
        font-family: var(--font-mono);
        font-size: 12.5px;
        padding: 1px 4px;
        background: var(--bg-base);
        border-radius: var(--radius-xs);
    }
    .v-bubble-text :global(pre) {
        margin: 6px 0;
        padding: 8px 10px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        overflow-x: auto;
    }
    .v-bubble-text :global(pre code) { background: none; border: none; padding: 0; }
    .v-bubble-text :global(ul), .v-bubble-text :global(ol) { margin: 4px 0; padding-left: 18px; }
    .v-bubble-text :global(li) { margin: 2px 0; }

    .orb-wrap {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
    }

    .orb {
        position: relative;
        width: 120px;
        height: 120px;
        border-radius: 50%;
        background: linear-gradient(135deg, var(--accent), #d268f4);
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        box-shadow: 0 8px 32px color-mix(in srgb, var(--accent) 30%, transparent);
        transition: transform 80ms ease;
        cursor: pointer;
        --mic-level: 0;
    }
    .orb:active { transform: scale(0.96); }

    .orb.listening {
        /* Mic level drives the visible pulse — proves mic is alive. */
        transform: scale(calc(1 + var(--mic-level) * 0.12));
        box-shadow:
            0 8px 32px color-mix(in srgb, var(--accent) calc(30% + var(--mic-level) * 30%), transparent),
            0 0 0 calc(var(--mic-level) * 14px) color-mix(in srgb, var(--accent) 15%, transparent);
    }

    .orb.thinking {
        animation: orb-think-spin 2s linear infinite;
    }
    @keyframes orb-think-spin {
        0%   { filter: hue-rotate(0deg); }
        50%  { filter: hue-rotate(30deg); }
        100% { filter: hue-rotate(0deg); }
    }

    .orb.speaking {
        animation: orb-speak-glow 2s ease-in-out infinite;
    }
    @keyframes orb-speak-glow {
        0%, 100% { transform: scale(1); filter: brightness(1); }
        50%      { transform: scale(1.08); filter: brightness(1.15); }
    }

    .orb-ring {
        position: absolute;
        inset: -8px;
        border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
        animation: orb-ring-expand 1.8s ease-out infinite;
        pointer-events: none;
    }
    .orb-ring-2 { animation-delay: 0.6s; }
    @keyframes orb-ring-expand {
        0%   { transform: scale(0.9); opacity: 0.8; }
        100% { transform: scale(1.35); opacity: 0; }
    }

    .orb-wave {
        position: absolute;
        inset: -6px;
        border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--warning) 50%, transparent);
        animation: orb-wave-ping 1.4s ease-out infinite;
        pointer-events: none;
    }
    .orb-wave-2 { animation-delay: 0.5s; }
    @keyframes orb-wave-ping {
        0%   { transform: scale(1); opacity: 0.7; }
        100% { transform: scale(1.25); opacity: 0; }
    }

    .orb-label {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-secondary);
        min-height: 22px;
        text-align: center;
        max-width: 92vw;
        line-height: 1.35;
        word-break: break-word;
    }
    .interim {
        color: var(--accent-text);
        font-style: italic;
    }
    .hint {
        font-weight: 400;
        color: var(--text-tertiary);
        font-size: 12.5px;
    }
    .hint.warn {
        color: var(--warning);
        font-weight: 500;
    }
    .manual-send {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 4px;
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 600;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 999px;
        cursor: pointer;
        box-shadow: 0 4px 16px color-mix(in srgb, var(--accent) 30%, transparent);
        transition: transform var(--transition-fast), box-shadow var(--transition-fast);
    }
    .manual-send:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .manual-send:active { transform: translateY(0); }

    .dots {
        display: inline-flex;
        gap: 4px;
    }
    .dots span {
        width: 8px; height: 8px;
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

    @media (prefers-reduced-motion: reduce) {
        .orb, .orb-ring, .orb-wave, .dots span, .v-bubble { animation: none; }
        .orb.listening { transform: none; }
    }

    /* Mobile: shrink orb so transcript stays visible above the keyboard
       and the URL bar. Use 100dvh on the overlay so iOS safe area is OK. */
    @media (max-width: 560px) {
        .voice-body { padding: 8px 12px 16px; gap: 12px; }
        .orb { width: 92px; height: 92px; }
        .orb-icon :global(svg) { width: 26px; height: 26px; }
        .v-bubble { max-width: 92%; font-size: 14px; padding: 9px 12px; }
        .orb-label { font-size: 13px; }
    }
    @media (max-height: 560px) {
        .orb { width: 76px; height: 76px; }
        .orb-icon :global(svg) { width: 22px; height: 22px; }
        .voice-body { gap: 8px; }
    }
</style>
