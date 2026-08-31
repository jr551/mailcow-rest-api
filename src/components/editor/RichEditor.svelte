<script lang="ts">
    // Tiptap-backed rich-text editor for the Compose body. Vanilla
    // @tiptap/core + Svelte glue (no @tiptap/svelte adapter needed).
    // Emits HTML via bindable `html` and a stripped plain-text via `text`
    // — Compose sends both so receiving clients without HTML support
    // still get a readable copy.

    import { onMount, onDestroy } from 'svelte';
    import { Editor } from '@tiptap/core';
    import StarterKit from '@tiptap/starter-kit';
    import Link from '@tiptap/extension-link';
    import Image from '@tiptap/extension-image';
    import Underline from '@tiptap/extension-underline';
    import Placeholder from '@tiptap/extension-placeholder';
    import TextAlign from '@tiptap/extension-text-align';
    import Icon from '../Icon.svelte';

    interface Props {
        html: string;
        placeholder?: string;
        // When true, the empty-state placeholder pulses with a soft "ghost"
        // glow so the user's eye is drawn to it. Used in reply mode.
        ghostPlaceholder?: boolean;
        onChange?: (html: string) => void;
    }
    let { html = $bindable(''), placeholder = 'Write your message…', ghostPlaceholder = false, onChange }: Props = $props();

    let mountEl: HTMLDivElement | undefined = $state();
    let editor: Editor | null = null;

    // Tiptap's Placeholder extension only renders when the entire doc is
    // empty. In reply mode the doc starts with quoted content, so the
    // built-in placeholder never shows. We render a Svelte-managed ghost
    // banner instead, hidden once the user focuses the editor or types.
    let ghostInteracted = $state(false);
    let ghostFocused = $state(false);

    // Re-derive button "active" state from the editor selection. Tiptap
    // doesn't push reactive state out of the box, so we hook the
    // selectionUpdate event and bump a tick state to force Svelte to
    // re-evaluate the $derived blocks below.
    let editorTick = $state(0);

    onMount(() => {
        if (!mountEl) return;
        const initialHtml = html;
        editor = new Editor({
            element: mountEl,
            extensions: [
                StarterKit.configure({
                    // Heading is overkill for an email; keep H2/H3 only.
                    heading: { levels: [2, 3] },
                    // Disable extensions that we add separately below
                    link: false,
                    underline: false
                }),
                Underline,
                Link.configure({
                    openOnClick: false,
                    autolink: true,
                    HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' }
                }),
                Image.configure({ inline: false, allowBase64: true }),
                TextAlign.configure({ types: ['heading', 'paragraph'] }),
                Placeholder.configure({ placeholder })
            ],
            content: html || '',
            onUpdate: ({ editor: e }) => {
                const next = e.getHTML();
                html = next;
                onChange?.(next);
                editorTick++;
                if (next !== initialHtml) ghostInteracted = true;
            },
            onSelectionUpdate: () => { editorTick++; },
            onFocus: () => { ghostFocused = true; },
            onBlur: () => { ghostFocused = false; }
        });
    });

    onDestroy(() => { editor?.destroy(); editor = null; });

    // Dependency on editorTick keeps the buttons in sync with the
    // selection / mark state.
    function isActive(name: string, attrs?: Record<string, unknown>): boolean {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        editorTick;
        return !!editor && editor.isActive(name, attrs);
    }
    function isAlign(side: 'left' | 'center' | 'right'): boolean {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        editorTick;
        if (!editor) return false;
        const cur = editor.getAttributes('paragraph')?.textAlign
            ?? editor.getAttributes('heading')?.textAlign
            ?? 'left';
        return cur === side;
    }

    function toggleBold() { editor?.chain().focus().toggleBold().run(); }
    function toggleItalic() { editor?.chain().focus().toggleItalic().run(); }
    function toggleUnderline() { editor?.chain().focus().toggleUnderline().run(); }
    function toggleStrike() { editor?.chain().focus().toggleStrike().run(); }
    function toggleCode() { editor?.chain().focus().toggleCode().run(); }
    function toggleBullet() { editor?.chain().focus().toggleBulletList().run(); }
    function toggleOrdered() { editor?.chain().focus().toggleOrderedList().run(); }
    function toggleQuote() { editor?.chain().focus().toggleBlockquote().run(); }
    function setHeading(level: 2 | 3) {
        if (isActive('heading', { level })) editor?.chain().focus().setParagraph().run();
        else editor?.chain().focus().toggleHeading({ level }).run();
    }
    function alignLeft()   { editor?.chain().focus().setTextAlign('left').run(); }
    function alignCenter() { editor?.chain().focus().setTextAlign('center').run(); }
    function alignRight()  { editor?.chain().focus().setTextAlign('right').run(); }
    function setLink() {
        const prev = editor?.getAttributes('link')?.href || '';
        const url = prompt('Link URL (leave blank to remove):', prev);
        if (url === null) return;
        if (url === '') editor?.chain().focus().unsetLink().run();
        else editor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
    function insertImageFromFile(file: File) {
        if (!file) return;
        const r = new FileReader();
        r.onload = () => {
            const src = r.result as string;
            editor?.chain().focus().setImage({ src }).run();
        };
        r.readAsDataURL(file);
    }
    function pickImage() {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
        inp.onchange = () => {
            const f = inp.files?.[0];
            if (f) insertImageFromFile(f);
        };
        inp.click();
    }
    function undo() { editor?.chain().focus().undo().run(); }
    function redo() { editor?.chain().focus().redo().run(); }
</script>

<div class="rich-editor" data-testid="rich-editor">
    <div class="toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" class:active={isActive('bold')}      onclick={toggleBold}      title="Bold (⌘/Ctrl+B)"><b>B</b></button>
        <button type="button" class:active={isActive('italic')}    onclick={toggleItalic}    title="Italic (⌘/Ctrl+I)"><i>I</i></button>
        <button type="button" class:active={isActive('underline')} onclick={toggleUnderline} title="Underline (⌘/Ctrl+U)"><u>U</u></button>
        <button type="button" class:active={isActive('strike')}    onclick={toggleStrike}    title="Strikethrough"><s>S</s></button>
        <button type="button" class:active={isActive('code')}      onclick={toggleCode}      title="Inline code">{'</>'}</button>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class:active={isActive('heading', { level: 2 })} onclick={() => setHeading(2)} title="Heading 2">H2</button>
        <button type="button" class:active={isActive('heading', { level: 3 })} onclick={() => setHeading(3)} title="Heading 3">H3</button>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class:active={isActive('bulletList')}  onclick={toggleBullet}  title="Bulleted list"><Icon name="reply" size={12} /></button>
        <button type="button" class:active={isActive('orderedList')} onclick={toggleOrdered} title="Numbered list">1.</button>
        <button type="button" class:active={isActive('blockquote')}  onclick={toggleQuote}   title="Quote">❝</button>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class:active={isAlign('left')}   onclick={alignLeft}   title="Align left">⇤</button>
        <button type="button" class:active={isAlign('center')} onclick={alignCenter} title="Align center">⇔</button>
        <button type="button" class:active={isAlign('right')}  onclick={alignRight}  title="Align right">⇥</button>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class:active={isActive('link')} onclick={setLink} title="Link"><Icon name="paperclip" size={13} /></button>
        <button type="button" onclick={pickImage} title="Insert image"><Icon name="eye" size={13} /></button>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" onclick={undo} title="Undo"><Icon name="chevronLeft" size={13} /></button>
        <button type="button" onclick={redo} title="Redo"><Icon name="chevronRight" size={13} /></button>
    </div>
    <div class="surface-wrap">
        {#if ghostPlaceholder && !ghostInteracted && !ghostFocused}
            <div
                class="ghost-banner"
                aria-hidden="true"
                data-testid="ghost-placeholder"
            >
                {placeholder}
            </div>
        {/if}
        <div bind:this={mountEl} class="surface" class:ghost-placeholder={ghostPlaceholder} data-testid="rich-editor-surface"></div>
    </div>
</div>

<style>
    .rich-editor {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        background: var(--bg-base);
        overflow: hidden;
    }
    .toolbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 6px 8px;
        background: var(--bg-surface-alt);
        border-bottom: 1px solid var(--border-subtle);
        flex-wrap: wrap;
    }
    .toolbar button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        height: 28px;
        padding: 0 6px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
        border-radius: var(--radius-xs);
        cursor: pointer;
        font-family: inherit;
    }
    .toolbar button:hover { background: var(--bg-hover); color: var(--text-primary); }
    .toolbar button.active {
        background: var(--accent-soft);
        color: var(--accent-text);
    }
    .toolbar .sep {
        width: 1px;
        height: 18px;
        background: var(--border-subtle);
        margin: 0 4px;
    }
    .surface {
        flex: 1;
        overflow-y: auto;
        padding: 12px 14px;
        font-size: 14px;
        line-height: 1.55;
        color: var(--text-primary);
    }
    .surface :global(.ProseMirror) {
        outline: none;
        min-height: 220px;
        background: transparent;
        color: var(--text-primary);
        caret-color: var(--accent);
    }
    .surface :global(.ProseMirror p) { margin: 0 0 0.6em; }
    .surface :global(.ProseMirror p:last-child) { margin-bottom: 0; }
    .surface :global(.ProseMirror h2) {
        font-size: 17px;
        font-weight: 700;
        letter-spacing: -0.01em;
        margin: 0.6em 0 0.4em;
    }
    .surface :global(.ProseMirror h3) {
        font-size: 15px;
        font-weight: 700;
        margin: 0.6em 0 0.3em;
    }
    .surface :global(.ProseMirror ul),
    .surface :global(.ProseMirror ol) { padding-left: 22px; }
    .surface :global(.ProseMirror blockquote) {
        margin: 0 0 0.6em;
        padding: 4px 0 4px 12px;
        border-left: 3px solid var(--accent);
        color: var(--text-secondary);
    }
    .surface :global(.ProseMirror code) {
        font-family: var(--font-mono);
        font-size: 12.5px;
        padding: 1px 5px;
        background: var(--bg-surface-alt);
        border-radius: var(--radius-xs);
    }
    .surface :global(.ProseMirror pre) {
        font-family: var(--font-mono);
        font-size: 12.5px;
        padding: 10px 12px;
        background: var(--bg-surface-alt);
        border-radius: var(--radius-sm);
        overflow-x: auto;
    }
    .surface :global(.ProseMirror img) {
        max-width: 100%;
        border-radius: var(--radius-sm);
        box-shadow: var(--shadow-sm);
    }
    .surface :global(.ProseMirror a) {
        color: var(--accent-text);
        text-decoration: underline;
    }
    /* Tiptap placeholder — only rendered when the editor is empty. */
    .surface :global(.ProseMirror p.is-editor-empty:first-child::before) {
        content: attr(data-placeholder);
        float: left;
        color: var(--text-tertiary);
        pointer-events: none;
        height: 0;
    }
    /* Ghost placeholder: a subdued translucent grey banner pinned to the
     * top of the editor surface. Tiptap's built-in Placeholder doesn't fire
     * in reply mode (the doc isn't empty — it has the quoted message), so
     * we render the hint manually as an overlay. Click-through stays
     * intact — the editor underneath is fully usable. */
    .surface-wrap {
        flex: 1;
        position: relative;
        display: flex;
        min-height: 0;
    }
    .surface-wrap > .surface { flex: 1; }
    .ghost-banner {
        position: absolute;
        top: 14px;
        left: 18px;
        right: 18px;
        z-index: 1;
        pointer-events: none;
        font-size: 14px;
        line-height: 1.55;
        color: var(--text-tertiary);
        font-style: italic;
        opacity: 0.45;
        letter-spacing: 0.01em;
        animation: ghost-breathe 4s ease-in-out infinite;
        transition: opacity 140ms ease-out;
    }
    @keyframes ghost-breathe {
        0%, 100% { opacity: 0.32; }
        50%      { opacity: 0.58; }
    }
    @media (prefers-reduced-motion: reduce) {
        .ghost-banner { animation: none; opacity: 0.45; }
    }
</style>
