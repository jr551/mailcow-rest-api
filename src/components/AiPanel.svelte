<script lang="ts">
    import { ui, showToast } from '../lib/store.svelte';
    import { summarizeMessage, draftReply, extractActions, translateMessage, ApiError } from '../lib/api';
    import Icon from './Icon.svelte';

    interface Props {
        onClose: () => void;
    }
    let { onClose }: Props = $props();

    let intent = $state('');

    function bodyForAi(): string {
        if (!ui.detail) return '';
        const env = ui.detail.envelope;
        const headers = [
            `From: ${env.from?.[0]?.name || ''} <${env.from?.[0]?.address || ''}>`,
            env.subject ? `Subject: ${env.subject}` : '',
            env.date ? `Date: ${env.date}` : ''
        ].filter(Boolean).join('\n');
        const body = ui.detail.text || (ui.detail.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        return `${headers}\n\n${body}`;
    }

    async function runSummarize() {
        if (!ui.detail) return;
        ui.aiSummaryLoading = true;
        ui.aiSummaryError = null;
        try {
            const r = await summarizeMessage(bodyForAi());
            ui.aiSummary = r.content;
        } catch (err) {
            ui.aiSummaryError = describe(err, 'Summarize failed');
        } finally {
            ui.aiSummaryLoading = false;
        }
    }

    async function runDraft() {
        if (!ui.detail) return;
        ui.aiDraftLoading = true;
        ui.aiDraftError = null;
        try {
            const r = await draftReply(bodyForAi(), intent);
            ui.aiDraft = r.content;
        } catch (err) {
            ui.aiDraftError = describe(err, 'Draft failed');
        } finally {
            ui.aiDraftLoading = false;
        }
    }

    async function runActions() {
        if (!ui.detail) return;
        ui.aiActionsLoading = true;
        ui.aiActionsError = null;
        try {
            const r = await extractActions(bodyForAi());
            ui.aiActions = r.content;
        } catch (err) {
            ui.aiActionsError = describe(err, 'Action extraction failed');
        } finally {
            ui.aiActionsLoading = false;
        }
    }

    async function runTranslate() {
        if (!ui.detail) return;
        ui.aiTranslateLoading = true;
        ui.aiTranslateError = null;
        try {
            const r = await translateMessage(bodyForAi(), ui.aiTranslateLang);
            ui.aiTranslate = r.content;
        } catch (err) {
            ui.aiTranslateError = describe(err, 'Translation failed');
        } finally {
            ui.aiTranslateLoading = false;
        }
    }

    function describe(err: unknown, fallback: string): string {
        if (err instanceof ApiError) return err.detail || err.title || fallback;
        if (err instanceof Error) return err.message || fallback;
        return fallback;
    }

    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            showToast('success', 'Copied to clipboard');
        } catch {
            showToast('error', 'Copy failed');
        }
    }

    function useAsDraft(text: string) {
        ui.composeOpen = true;
        ui.composeContext = { replyTo: ui.detail };
        // user can paste — we don't auto-fill the textarea since Compose owns its
        // state; copying is the cleanest hand-off.
        copy(text);
    }
</script>

<aside class="panel fade-in" aria-label="AI tools" data-testid="ai-panel">
    <header>
        <h3>
            <Icon name="sparkles" size={16} />
            AI tools
        </h3>
        <button type="button" class="btn btn-ghost" aria-label="Close" onclick={onClose}>
            <Icon name="close" size={14} />
        </button>
    </header>

    {#if !ui.detail}
        <div class="placeholder muted">Open a message first.</div>
    {:else}
        <section class="section">
            <div class="head">
                <h4>Summarize</h4>
                <button
                    type="button"
                    class="btn btn-secondary"
                    onclick={runSummarize}
                    disabled={ui.aiSummaryLoading}
                    data-testid="ai-summarize-btn"
                >
                    {#if ui.aiSummaryLoading}<span class="spinner"></span>{/if}
                    {ui.aiSummary ? 'Re-run' : 'Summarize'}
                </button>
            </div>
            {#if ui.aiSummaryError}
                <div class="error">{ui.aiSummaryError}</div>
            {:else if ui.aiSummary}
                <pre class="output" data-testid="ai-summary-out">{ui.aiSummary}</pre>
                <div class="row-actions">
                    <button type="button" class="btn btn-ghost" onclick={() => copy(ui.aiSummary || '')}>
                        Copy
                    </button>
                </div>
            {:else if !ui.aiSummaryLoading}
                <p class="muted hint">Summarize the open message into 3–5 bullets.</p>
            {/if}
        </section>

        <section class="section">
            <div class="head">
                <h4>Draft reply</h4>
                <button
                    type="button"
                    class="btn btn-secondary"
                    onclick={runDraft}
                    disabled={ui.aiDraftLoading}
                    data-testid="ai-draft-btn"
                >
                    {#if ui.aiDraftLoading}<span class="spinner"></span>{/if}
                    {ui.aiDraft ? 'Re-draft' : 'Draft'}
                </button>
            </div>
            <label class="intent-label">
                <span class="intent-lbl-text">How should I reply?</span>
                <input
                    type="text"
                    bind:value={intent}
                    placeholder="e.g. thank them and decline"
                    class="intent"
                />
            </label>
            {#if ui.aiDraftError}
                <div class="error">{ui.aiDraftError}</div>
            {:else if ui.aiDraft}
                <pre class="output" data-testid="ai-draft-out">{ui.aiDraft}</pre>
                <div class="row-actions">
                    <button type="button" class="btn btn-ghost" onclick={() => copy(ui.aiDraft || '')}>
                        Copy
                    </button>
                    <button type="button" class="btn btn-primary" onclick={() => useAsDraft(ui.aiDraft || '')}>
                        Use as reply
                    </button>
                </div>
            {:else if !ui.aiDraftLoading}
                <p class="muted hint">Draft a reply using the message body and your optional intent.</p>
            {/if}
        </section>

        <section class="section">
            <div class="head">
                <h4>Action items</h4>
                <button
                    type="button"
                    class="btn btn-secondary"
                    onclick={runActions}
                    disabled={ui.aiActionsLoading}
                    data-testid="ai-actions-btn"
                >
                    {#if ui.aiActionsLoading}<span class="spinner"></span>{/if}
                    {ui.aiActions ? 'Re-run' : 'Extract'}
                </button>
            </div>
            {#if ui.aiActionsError}
                <div class="error">{ui.aiActionsError}</div>
            {:else if ui.aiActions}
                <pre class="output" data-testid="ai-actions-out">{ui.aiActions}</pre>
                <div class="row-actions">
                    <button type="button" class="btn btn-ghost" onclick={() => copy(ui.aiActions || '')}>Copy</button>
                </div>
            {:else if !ui.aiActionsLoading}
                <p class="muted hint">Pull a checklist of action items from this message.</p>
            {/if}
        </section>

        <section class="section">
            <div class="head">
                <h4>Translate</h4>
                <button
                    type="button"
                    class="btn btn-secondary"
                    onclick={runTranslate}
                    disabled={ui.aiTranslateLoading || !ui.aiTranslateLang.trim()}
                    data-testid="ai-translate-btn"
                >
                    {#if ui.aiTranslateLoading}<span class="spinner"></span>{/if}
                    Translate
                </button>
            </div>
            <input
                type="text"
                bind:value={ui.aiTranslateLang}
                placeholder="Target language (e.g. Spanish, French)"
                aria-label="Target language"
                class="intent"
            />
            {#if ui.aiTranslateError}
                <div class="error">{ui.aiTranslateError}</div>
            {:else if ui.aiTranslate}
                <pre class="output" data-testid="ai-translate-out">{ui.aiTranslate}</pre>
                <div class="row-actions">
                    <button type="button" class="btn btn-ghost" onclick={() => copy(ui.aiTranslate || '')}>Copy</button>
                </div>
            {/if}
        </section>
    {/if}
</aside>

<style>
    .panel {
        position: relative;
        width: 340px;
        max-width: 100%;
        flex: 0 0 340px;
        background: var(--bg-surface);
        border-left: 1px solid var(--border-subtle);
        box-shadow: var(--shadow-md);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    @media (max-width: 1100px) {
        .panel {
            position: fixed;
            top: 0;
            right: 0;
            bottom: 0;
            width: min(380px, calc(100% - 24px));
            z-index: 30;
        }
    }
    .intent-label {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .intent-lbl-text {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid var(--border-subtle);
    }
    header h3 {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--accent-text);
        letter-spacing: -0.01em;
    }
    header {
        background:
            linear-gradient(135deg,
                color-mix(in srgb, var(--accent) 14%, var(--bg-surface)),
                color-mix(in srgb, #d268f4 8%, var(--bg-surface)));
    }
    .placeholder {
        padding: 24px 18px;
        font-size: 13px;
        text-align: center;
    }
    .section {
        padding: 16px;
        border-bottom: 1px solid var(--border-subtle);
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .section:last-child { border-bottom: none; }
    .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .head h4 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--text-primary);
    }
    .intent { width: 100%; }
    .hint { font-size: 12px; }
    .output {
        margin: 0;
        padding: 12px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        font-family: var(--font-sans);
        font-size: 13px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-wrap: break-word;
        max-height: 280px;
        overflow-y: auto;
    }
    .error {
        padding: 10px 12px;
        background: var(--danger-soft);
        color: var(--danger);
        border-radius: var(--radius-md);
        font-size: 12px;
    }
    .row-actions {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
    }
</style>
