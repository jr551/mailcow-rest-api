// Background long-running task runner. Powers the `start_background_task`
// AI tool: when the model predicts a request will exceed the chat
// timeout (multi-step research, sweeping the inbox, etc.) it can defer
// the work here and answer the user immediately with "I'll notify you
// when done." The task loop runs detached from the surface that
// triggered it, so the user can switch away without interrupting it.
//
// Constraints:
//   * 30-minute hard ceiling per task — anything still running at the
//     deadline gets aborted and a partial result is posted.
//   * Up to 100 tool steps (vs. the foreground 6) before the runner
//     itself errors out.
//   * One task per thread at a time. A second start_background_task on
//     the same thread short-circuits with "already running".
//   * Result is appended as a new assistant message on the originating
//     thread, with a 🛎️ prefix so the user can spot them in scrollback.
//   * While at least one task is active a beforeunload listener warns
//     that closing the tab will cancel the task.

import { appendMessage } from './ai-threads.svelte';
import { chatTurn, DESTRUCTIVE_TOOLS, type ChatMessage, type GrantableCapability } from './chat.svelte';
import { playNotify } from './sounds.svelte';
import { showToast } from './store.svelte';

const MAX_RUNTIME_MS = 30 * 60 * 1000;
const DEFAULT_BG_MAX_STEPS = 100;

interface ActiveTask {
    id: string;
    threadId: string;
    description: string;
    startedAt: number;
    abort: AbortController;
    /** Live progress: what the agent is currently doing. Updated by
     *  the runner via the chatTurn onProgress channel. The chat
     *  surface's progress widget reads this directly. */
    currentTool: string;
    step: number;
    toolCount: number;
    subagentDepth: number;
    lastActivityAt: number;
}

interface TasksState {
    active: ActiveTask[];
}

const state = $state<TasksState>({ active: [] });

export function backgroundTasks(): TasksState { return state; }

export function activeTaskFor(threadId: string): ActiveTask | undefined {
    return state.active.find((t) => t.threadId === threadId);
}

export function cancelBackgroundTask(id: string) {
    const t = state.active.find((x) => x.id === id);
    if (t) t.abort.abort();
}

interface StartOpts {
    threadId: string;
    description: string;
    instruction: string;
    /** Tool catalog to make available — defaults to whatever the AI surface
     *  passed in. Background tasks shouldn't grant new capabilities; the
     *  model can only use what was already authorised on the originating
     *  thread. */
    tools: import('./chat.svelte').ToolDef[];
    systemPrompt: string;
    modelOverride?: string;
    /** Original thread history, optionally trimmed by the caller. The
     *  task model sees this so it has the context that led to the
     *  deferral. */
    history: ChatMessage[];
    /** Permission requests during background execution auto-deny — the
     *  user can't see them. Caller can override (rare). */
    confirmPermission?: (req: { capability: GrantableCapability; reason: string }) => Promise<boolean>;
    /** Per-task step ceiling. Defaults to 100 — much higher than the
     *  foreground 6 since the runner is detached and can chew through
     *  long tool chains without blocking the UI. */
    maxSteps?: number;
}

// Beforeunload guard. Browsers only respect the warning when there's an
// active user gesture history, so we attach the listener only while a
// task is running and tear it down on completion. Returning a non-empty
// string (Chromium) or calling preventDefault (Firefox/Safari) triggers
// the native "Leave site?" prompt; the page wins the close race only
// if the user cancels.
let beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
function refreshBeforeUnloadGuard() {
    if (typeof window === 'undefined') return;
    const shouldGuard = state.active.length > 0;
    if (shouldGuard && !beforeUnloadHandler) {
        beforeUnloadHandler = (e: BeforeUnloadEvent) => {
            const msg = 'A background AI task is still running. Closing this tab will cancel it.';
            e.preventDefault();
            // Legacy browsers read returnValue; modern ones ignore the
            // string but show their own generic prompt.
            (e as unknown as { returnValue: string }).returnValue = msg;
            return msg;
        };
        window.addEventListener('beforeunload', beforeUnloadHandler);
    } else if (!shouldGuard && beforeUnloadHandler) {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
        beforeUnloadHandler = null;
    }
}

export function startBackgroundTask(opts: StartOpts): { taskId: string; alreadyRunning: boolean } {
    const existing = activeTaskFor(opts.threadId);
    if (existing) return { taskId: existing.id, alreadyRunning: true };

    const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const abort = new AbortController();
    const task: ActiveTask = {
        id,
        threadId: opts.threadId,
        description: opts.description.slice(0, 200),
        startedAt: Date.now(),
        abort,
        currentTool: 'starting…',
        step: 0,
        toolCount: 0,
        subagentDepth: 0,
        lastActivityAt: Date.now()
    };
    state.active = [...state.active, task];
    refreshBeforeUnloadGuard();
    showToast('info', `AI is working in the background — ${task.description}. I'll let you know when it's done.`);

    // Hard deadline — abort if we breach the runtime ceiling. Cleared by
    // the runner's finally block; a stray timer at the deadline would
    // fire abort() on a no-op AbortController.
    const deadline = setTimeout(() => abort.abort(new Error('Background task hit the 30-minute ceiling')), MAX_RUNTIME_MS);

    void runBackgroundTask({
        ...opts,
        taskId: id,
        abort,
        cleanup: () => {
            clearTimeout(deadline);
            state.active = state.active.filter((t) => t.id !== id);
            refreshBeforeUnloadGuard();
        }
    });

    return { taskId: id, alreadyRunning: false };
}

interface RunOpts extends StartOpts {
    taskId: string;
    abort: AbortController;
    cleanup: () => void;
}

async function runBackgroundTask(opts: RunOpts): Promise<void> {
    const start = Date.now();
    let acc = '';
    let toolCount = 0;
    const live = state.active.find((t) => t.id === opts.taskId);
    try {
        // Append the user's deferred instruction to the history so the
        // model sees it as the immediate prompt. Detailed instruction
        // template — gives the agent a planning frame, tool budget
        // hints, and an explicit call-out for the spawn_subagent tool
        // so it knows when to fan out.
        const richInstruction = [
            `[Background task — long-running]`,
            ``,
            `Your job: ${opts.instruction}`,
            ``,
            `How to work this task:`,
            `1. PLAN. In your first internal step, decompose the request into 2–6 concrete steps. Don't write the plan to the user — just do it.`,
            `2. EXECUTE. Use tools aggressively. You have a ${opts.maxSteps ?? DEFAULT_BG_MAX_STEPS}-step budget and 30 minutes. Don't over-optimise — it's cheaper to make an extra search call than to guess.`,
            `3. PARALLELISE WHERE IT HELPS. If the work has obviously independent slices (e.g. "summarise every email from these 4 senders", "audit each of these 5 calendars"), call \`spawn_subagent\` once per slice with a self-contained instruction. The sub-agent runs to completion and returns its summary. Don't spawn for trivial work — only when a slice would otherwise eat 5+ tool calls of YOUR budget.`,
            `4. RECOVER ON ERROR. If a tool fails, try a narrower variant once. If it fails again, note it in your summary and move on — don't burn the whole budget on one stuck step.`,
            `5. SUMMARISE. End with a single concise, scannable assistant message: what you did (1–3 bullets), what you found (key facts), what the user should do next (1 line). NO preamble. NO "I have completed your task" — just the result.`,
            ``,
            `Hard rules:`,
            `- Do NOT ask follow-up questions. The user is not watching. Make the most-defensible choice and proceed.`,
            `- You do NOT have send/delete/mail-rule/block tools here. Nobody is watching to approve them, and the mail you read may itself be trying to trigger them. If the task genuinely needs one, do everything else and say in your summary exactly what you left for the user to do.`,
            `- Do NOT call \`start_background_task\` from inside this task — you ARE the background task.`,
            `- Sub-agent recursion depth is capped at 3.`
        ].join('\n');

        const history: ChatMessage[] = [...opts.history, {
            role: 'user',
            content: richInstruction
        }];

        for await (const ev of chatTurn(history, {
            signal: opts.abort.signal,
            // Withhold irreversible tools. A background task runs with no
            // one to consent, on content that can carry injected
            // instructions — so the capability simply isn't offered rather
            // than being offered and asked about.
            tools: opts.tools.filter((t) => !DESTRUCTIVE_TOOLS.has(t.function.name)),
            systemPrompt: opts.systemPrompt,
            modelOverride: opts.modelOverride,
            maxSteps: opts.maxSteps ?? DEFAULT_BG_MAX_STEPS,
            // Background tasks can't surface UI prompts — auto-deny any
            // permission/write asks. The model is instructed to use only
            // what's already authorised.
            confirmPermission: opts.confirmPermission || (() => Promise.resolve(false)),
            confirmWrite: () => Promise.resolve(false),
            subagentDepth: 0,
            onProgress: (p) => {
                if (!live) return;
                live.lastActivityAt = Date.now();
                if (p.kind === 'tool' && p.name) {
                    live.currentTool = p.name;
                    live.toolCount += 1;
                } else if (p.kind === 'step' && typeof p.step === 'number') {
                    live.step = p.step;
                }
            }
            // No threadId: we're already the bg runner, prevent
            // recursive promotion if this task itself hits the cap.
        })) {
            if (ev.type === 'message') {
                acc += ev.text || '';
                if (live && ev.text) {
                    live.currentTool = 'thinking…';
                    live.lastActivityAt = Date.now();
                }
            } else if (ev.type === 'tool_call') {
                toolCount += 1;
            } else if (ev.type === 'error') {
                acc += `\n\n_Error: ${ev.text || 'unknown'}_`;
            }
        }

        const elapsedMs = Date.now() - start;
        const summary = (acc || '_(no output)_').trim();
        const header = `🛎️ **Background task done** — ${opts.description.slice(0, 120)}\n\n_Ran for ${formatElapsed(elapsedMs)}, ${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}._\n\n`;
        appendMessage(opts.threadId, { role: 'assistant', content: header + summary });
        playNotify();
        notifyDesktop(`Background task done`, opts.description.slice(0, 120));
    } catch (err) {
        const aborted = (err as Error)?.name === 'AbortError' || opts.abort.signal.aborted;
        const reason = aborted
            ? (opts.abort.signal.reason instanceof Error ? opts.abort.signal.reason.message : 'cancelled')
            : ((err as Error)?.message || 'unknown error');
        const header = aborted
            ? `🛑 **Background task stopped** — ${opts.description.slice(0, 120)}\n\n_${reason}._\n\n`
            : `⚠️ **Background task failed** — ${opts.description.slice(0, 120)}\n\n_${reason}._\n\n`;
        appendMessage(opts.threadId, { role: 'assistant', content: header + (acc.trim() || '_(no partial output)_') });
        playNotify();
        notifyDesktop(`Background task ${aborted ? 'stopped' : 'failed'}`, opts.description.slice(0, 120));
    } finally {
        opts.cleanup();
    }
}

function formatElapsed(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
}

function notifyDesktop(title: string, body: string) {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try { new Notification(title, { body, silent: false }); } catch { /* */ }
}
