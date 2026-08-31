<script lang="ts">
    // In-app PDF AcroForm filler. Loads the form fields with pdf-lib,
    // exposes them as native HTML inputs, and on Save re-emits the PDF
    // with the fields filled. Optionally calls onAttach with the filled
    // bytes so the caller can drop them into a Compose draft.

    import { onMount } from 'svelte';
    import Icon from '../Icon.svelte';
    import { showToast } from '../../lib/store.svelte';
    import { extractPdfFormFields, fillPdfForm, type PdfFormField } from '../../lib/pdf-form';

    interface Props {
        bytes: ArrayBuffer;
        filename?: string;
        onClose: () => void;
        onAttach?: (file: { filename: string; contentType: string; dataUrl: string }) => void;
    }
    let { bytes, filename = 'form.pdf', onClose, onAttach }: Props = $props();

    let fields = $state<PdfFormField[]>([]);
    let values = $state<Record<string, string | boolean>>({});
    let loading = $state(true);
    let saving = $state(false);
    let error = $state<string | null>(null);
    let flatten = $state(false);

    onMount(async () => {
        try {
            fields = await extractPdfFormFields(bytes);
            const init: Record<string, string | boolean> = {};
            for (const f of fields) init[f.name] = f.value;
            values = init;
        } catch (err) {
            error = (err as Error).message || 'Failed to read PDF form';
        } finally {
            loading = false;
        }
    });

    function setValue(name: string, v: string | boolean) {
        values = { ...values, [name]: v };
    }

    async function bytesToDataUrl(arr: Uint8Array): Promise<string> {
        // Avoid String.fromCharCode on huge arrays (stack overflow on big
        // PDFs) — base64 via FileReader is constant-stack and fast enough.
        const blob = new Blob([new Uint8Array(arr)], { type: 'application/pdf' });
        return await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onerror = () => reject(r.error);
            r.onload = () => resolve(String(r.result || ''));
            r.readAsDataURL(blob);
        });
    }

    async function downloadFilled() {
        if (saving) return;
        saving = true;
        try {
            const filled = await fillPdfForm(bytes, values, { flatten });
            const blob = new Blob([new Uint8Array(filled)], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename.replace(/\.pdf$/i, '') + '-filled.pdf';
            a.click();
            URL.revokeObjectURL(url);
            showToast('success', 'Filled PDF downloaded');
        } catch (err) {
            showToast('error', `Couldn't fill: ${(err as Error).message}`);
        } finally {
            saving = false;
        }
    }

    async function attachToReply() {
        if (!onAttach || saving) return;
        saving = true;
        try {
            const filled = await fillPdfForm(bytes, values, { flatten });
            const dataUrl = await bytesToDataUrl(filled);
            onAttach({
                filename: filename.replace(/\.pdf$/i, '') + '-filled.pdf',
                contentType: 'application/pdf',
                dataUrl
            });
            onClose();
        } catch (err) {
            showToast('error', `Couldn't attach: ${(err as Error).message}`);
        } finally {
            saving = false;
        }
    }

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') onClose();
    }
</script>

<svelte:window onkeydown={onKey} />

<div class="scrim" role="presentation" onclick={onClose}>
    <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Fill PDF form"
        onclick={(e) => e.stopPropagation()}
        data-testid="pdf-form-filler"
    >
        <header class="head">
            <div class="title">
                <Icon name="filePen" size={16} />
                <span>Fill form</span>
                <span class="muted small">{filename}</span>
            </div>
            <button type="button" class="close" onclick={onClose} aria-label="Close">
                <Icon name="close" size={14} />
            </button>
        </header>

        <div class="body">
            {#if loading}
                <p class="muted">Reading form fields…</p>
            {:else if error}
                <p class="error" role="alert">{error}</p>
            {:else if fields.length === 0}
                <p class="muted">This PDF doesn't have fillable form fields.</p>
            {:else}
                <ul class="fields" data-testid="pdf-form-fields">
                    {#each fields as f (f.name)}
                        <li class="field">
                            <label class="lbl" for={`pdf-fld-${f.name}`}>{f.label || f.name}</label>
                            {#if f.kind === 'text'}
                                <input
                                    id={`pdf-fld-${f.name}`}
                                    type="text"
                                    value={values[f.name] as string}
                                    oninput={(e) => setValue(f.name, (e.currentTarget as HTMLInputElement).value)}
                                    data-testid={`pdf-fld-${f.name}`}
                                />
                            {:else if f.kind === 'checkbox'}
                                <label class="check-row">
                                    <input
                                        id={`pdf-fld-${f.name}`}
                                        type="checkbox"
                                        checked={values[f.name] as boolean}
                                        onchange={(e) => setValue(f.name, (e.currentTarget as HTMLInputElement).checked)}
                                        data-testid={`pdf-fld-${f.name}`}
                                    />
                                    <span class="muted small">{values[f.name] ? 'Yes' : 'No'}</span>
                                </label>
                            {:else if f.kind === 'radio'}
                                <div class="radio-group" role="radiogroup" aria-labelledby={`pdf-fld-${f.name}`}>
                                    {#each f.options || [] as opt (opt)}
                                        <label class="radio-option">
                                            <input
                                                type="radio"
                                                name={`pdf-fld-${f.name}`}
                                                value={opt}
                                                checked={values[f.name] === opt}
                                                onchange={() => setValue(f.name, opt)}
                                            />
                                            <span>{opt}</span>
                                        </label>
                                    {/each}
                                </div>
                            {:else if f.kind === 'dropdown'}
                                <select
                                    id={`pdf-fld-${f.name}`}
                                    value={values[f.name] as string}
                                    onchange={(e) => setValue(f.name, (e.currentTarget as HTMLSelectElement).value)}
                                    data-testid={`pdf-fld-${f.name}`}
                                >
                                    {#each f.options || [] as opt (opt)}
                                        <option value={opt}>{opt}</option>
                                    {/each}
                                </select>
                            {:else}
                                <input
                                    id={`pdf-fld-${f.name}`}
                                    type="text"
                                    placeholder="(unsupported field type — value passed through)"
                                    value={values[f.name] as string}
                                    oninput={(e) => setValue(f.name, (e.currentTarget as HTMLInputElement).value)}
                                />
                            {/if}
                        </li>
                    {/each}
                </ul>

                <label class="flatten-row">
                    <input type="checkbox" checked={flatten} onchange={(e) => (flatten = (e.currentTarget as HTMLInputElement).checked)} />
                    <span class="muted small">Lock fields after filling (recipient can't edit further)</span>
                </label>
            {/if}
        </div>

        <footer class="foot">
            <button type="button" class="btn btn-ghost" onclick={onClose}>Cancel</button>
            {#if onAttach && !loading && !error && fields.length}
                <button type="button" class="btn btn-secondary" onclick={attachToReply} disabled={saving} data-testid="pdf-form-attach">
                    {#if saving}<span class="spinner"></span>{/if}
                    <Icon name="paperclip" size={13} /> Attach to reply
                </button>
            {/if}
            <button type="button" class="btn btn-primary" onclick={downloadFilled} disabled={loading || saving || !!error || fields.length === 0} data-testid="pdf-form-download">
                {#if saving}<span class="spinner"></span>{/if}
                <Icon name="download" size={13} /> Download filled
            </button>
        </footer>
    </div>
</div>

<style>
    .scrim {
        position: fixed;
        inset: 0;
        background: rgba(20, 22, 30, 0.55);
        backdrop-filter: blur(4px);
        z-index: 200;
        display: grid;
        place-items: center;
        animation: fade-in 160ms ease-out;
    }
    .dialog {
        width: min(560px, calc(100vw - 32px));
        max-height: min(85vh, 720px);
        display: flex;
        flex-direction: column;
        border-radius: 16px;
        overflow: hidden;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
        color: var(--text-primary);
    }
    .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
    }
    .title .small { font-weight: 400; }
    .close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px; height: 32px;
        border-radius: 50%;
        background: transparent;
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
    }
    .close:hover { background: var(--bg-hover); color: var(--text-primary); }
    .body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 14px 18px 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    .fields {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .lbl {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        font-weight: 600;
    }
    .field input[type=text],
    .field select {
        padding: 7px 10px;
        font-size: 13px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-family: inherit;
    }
    .field input[type=text]:focus,
    .field select:focus {
        outline: none;
        border-color: var(--accent);
    }
    .check-row { display: inline-flex; align-items: center; gap: 8px; }
    .radio-group { display: flex; flex-wrap: wrap; gap: 10px; padding-top: 4px; }
    .radio-option { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; }
    .flatten-row {
        display: inline-flex; align-items: center; gap: 8px;
        padding-top: 6px;
        border-top: 1px dashed var(--border-subtle);
    }
    .error { color: var(--danger); margin: 0; }
    .foot {
        flex: 0 0 auto;
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 8px;
        padding: 10px 16px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    @keyframes fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }
</style>
