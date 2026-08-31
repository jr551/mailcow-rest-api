<script lang="ts">
    import { getObjectUrl, fetchBlob } from '../../lib/drive-api';
    import { renderMarkdown } from '../../lib/markdown';
    import Icon from '../Icon.svelte';

    interface Props {
        item: { name: string; path: string; size: number; contentType?: string } | null;
        onClose: () => void;
        onEdit?: (item: { name: string; path: string; size: number; contentType?: string }) => void;
    }
    let { item, onClose, onEdit }: Props = $props();

    let url = $state('');
    let textContent = $state<string | null>(null);
    let isMarkdownFile = $state(false);

    $effect(() => {
        if (item) {
            getObjectUrl(item.path).then((u) => { url = u; });
            if (isMarkdown(item.name) || isTextCode(item.name)) {
                fetchBlob(item.path).then((b) => b.text()).then((t) => {
                    textContent = t;
                    isMarkdownFile = isMarkdown(item.name);
                });
            } else {
                textContent = null;
                isMarkdownFile = false;
            }
        } else {
            url = '';
            textContent = null;
            isMarkdownFile = false;
        }
    });

    function isImage(name: string): boolean {
        const ext = name.split('.').pop()?.toLowerCase();
        return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext || '');
    }

    function isVideo(name: string): boolean {
        const ext = name.split('.').pop()?.toLowerCase();
        return ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv'].includes(ext || '');
    }

    function isAudio(name: string): boolean {
        const ext = name.split('.').pop()?.toLowerCase();
        return ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext || '');
    }

    function isPdf(name: string): boolean {
        return name.toLowerCase().endsWith('.pdf');
    }

    function isOffice(name: string): boolean {
        const ext = name.split('.').pop()?.toLowerCase();
        return ['doc','docx','odt','xls','xlsx','csv','ods','ppt','pptx','odp'].includes(ext || '');
    }

    function isMarkdown(name: string): boolean {
        return name.toLowerCase().endsWith('.md');
    }

    function isTextCode(name: string): boolean {
        const ext = name.split('.').pop()?.toLowerCase();
        return [
            'txt', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'java',
            'c', 'cpp', 'h', 'rs', 'php', 'swift', 'kt', 'scala', 'r', 'pl',
            'sql', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'html', 'htm', 'css',
            'scss', 'sass', 'less', 'xml', 'log', 'csv', 'ini', 'toml', 'conf'
        ].includes(ext || '');
    }

    function copyText() {
        if (textContent) {
            navigator.clipboard.writeText(textContent).then(() => {
                // Could show a toast here, but the button gives immediate feedback
            });
        }
    }

    let pdfBytes = $state<ArrayBuffer | null>(null);
    $effect(() => {
        if (item && isPdf(item.name)) {
            fetchBlob(item.path).then((b) => b.arrayBuffer()).then((ab) => { pdfBytes = ab; });
        } else {
            pdfBytes = null;
        }
    });

    $effect(() => {
        if (!item) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    });

    function formatSize(bytes: number): string {
        if (bytes === 0) return '0 B';
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
    }
</script>

{#if item}
    <div class="preview-overlay" onclick={onClose} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div class="preview-modal" onclick={(e) => e.stopPropagation()}>
            <div class="preview-header">
                <span class="preview-title">{item.name}</span>
                <div class="preview-actions">
                    {#if textContent}
                        <button type="button" class="preview-action" onclick={copyText} title="Copy text">
                            <Icon name="copy" size={18} />
                        </button>
                    {/if}
                    {#if onEdit && (isMarkdown(item.name) || isTextCode(item.name))}
                        <button type="button" class="preview-action" onclick={() => onEdit(item)} title="Edit">
                            <Icon name="filePen" size={18} />
                        </button>
                    {/if}
                    <a class="preview-action" href={url} download={item.name} title="Download">
                        <Icon name="download" size={18} />
                    </a>
                    <button type="button" class="preview-action preview-close" onclick={onClose} title="Close">
                        <Icon name="close" size={20} />
                    </button>
                </div>
            </div>

            <div class="preview-body">
                {#if isImage(item.name)}
                    <img src={url} alt={item.name} class="preview-image" />
                {:else if isVideo(item.name)}
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <video src={url} controls class="preview-video">
                        <track kind="captions" src="" label="No captions" default />
                    </video>
                {:else if isAudio(item.name)}
                    <div class="preview-audio-wrap">
                        <Icon name="music" size={64} />
                        <audio src={url} controls class="preview-audio"></audio>
                    </div>
                {:else if isPdf(item.name) && pdfBytes}
                    <div class="pdf-wrap">
                        {#await import('../editor/PdfViewer.svelte') then mod}
                            <mod.default bytes={pdfBytes} filename={item.name} onClose={onClose} inline={true} />
                        {/await}
                    </div>
                {:else if isOffice(item.name)}
                    <iframe src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`} title={item.name} class="preview-iframe"></iframe>
                {:else if isMarkdownFile && textContent !== null}
                    <div class="preview-text markdown-body">
                        {@html renderMarkdown(textContent)}
                    </div>
                {:else if isTextCode(item.name) && textContent !== null}
                    <div class="preview-text code-body">
                        <pre><code>{textContent}</code></pre>
                    </div>
                {:else}
                    <div class="preview-generic">
                        <Icon name="file" size={64} />
                        <p class="preview-name">{item.name}</p>
                        <p class="preview-meta">{formatSize(item.size)}</p>
                        <a class="preview-btn" href={url} download={item.name}>
                            <Icon name="download" size={16} />
                            Download
                        </a>
                    </div>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .preview-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.75);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        padding: 16px;
    }
    .preview-modal {
        width: 100%;
        max-width: 960px;
        height: 90vh;
        background: var(--bg-surface);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-xl);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .preview-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-base);
        flex: 0 0 auto;
    }
    .preview-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }
    .preview-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }
    .preview-action {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 6px;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        text-decoration: none;
        background: none;
        border: none;
        cursor: pointer;
    }
    .preview-action:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    .preview-body {
        flex: 1;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-base);
    }
    .preview-image {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
    }
    .preview-video {
        max-width: 100%;
        max-height: 100%;
    }
    .preview-audio-wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 24px;
        color: var(--text-secondary);
        padding: 40px;
    }
    .preview-audio {
        width: 100%;
        max-width: 480px;
    }
    .preview-iframe {
        width: 100%;
        height: 100%;
        border: none;
        background: #fff;
    }
    .preview-generic {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        color: var(--text-secondary);
        padding: 40px;
        text-align: center;
    }
    .preview-generic .preview-name {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
        max-width: 400px;
        word-break: break-word;
    }
    .preview-generic .preview-meta {
        font-size: 13px;
        color: var(--text-tertiary);
    }
    .preview-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 20px;
        border-radius: var(--radius-md);
        background: var(--accent);
        color: #fff;
        text-decoration: none;
        font-size: 14px;
        font-weight: 500;
        margin-top: 8px;
    }
    .preview-btn:hover {
        opacity: 0.9;
    }
    .pdf-wrap {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-height: 0;
    }

    /* Text / Markdown preview styles */
    .preview-text {
        flex: 1;
        width: 100%;
        overflow-y: auto;
        padding: 24px 32px;
        text-align: left;
        align-self: stretch;
        justify-self: stretch;
    }
    .code-body {
        background: var(--bg-base);
    }
    .code-body pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 13px;
        line-height: 1.6;
        color: var(--text-primary);
    }
    .code-body code {
        background: transparent;
        padding: 0;
    }

    /* Markdown body styles */
    .markdown-body :global(h1),
    .markdown-body :global(h2),
    .markdown-body :global(h3),
    .markdown-body :global(h4) {
        color: var(--text-primary);
        margin: 16px 0 8px;
        font-weight: 600;
        line-height: 1.3;
    }
    .markdown-body :global(h1) { font-size: 22px; }
    .markdown-body :global(h2) { font-size: 19px; }
    .markdown-body :global(h3) { font-size: 16px; }
    .markdown-body :global(h4) { font-size: 14px; }
    .markdown-body :global(p) {
        color: var(--text-primary);
        margin: 8px 0;
        line-height: 1.6;
    }
    .markdown-body :global(pre) {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 12px;
        overflow-x: auto;
        margin: 8px 0;
    }
    .markdown-body :global(pre code) {
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 13px;
        color: var(--text-primary);
        background: transparent;
        padding: 0;
    }
    .markdown-body :global(code) {
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 13px;
        background: var(--bg-surface);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        color: var(--accent);
    }
    .markdown-body :global(ul),
    .markdown-body :global(ol) {
        margin: 8px 0;
        padding-left: 24px;
        color: var(--text-primary);
    }
    .markdown-body :global(li) {
        margin: 4px 0;
        line-height: 1.5;
    }
    .markdown-body :global(blockquote) {
        border-left: 3px solid var(--accent);
        margin: 8px 0;
        padding: 4px 12px;
        color: var(--text-secondary);
        background: var(--bg-surface);
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    }
    .markdown-body :global(a) {
        color: var(--accent);
        text-decoration: none;
    }
    .markdown-body :global(a:hover) {
        text-decoration: underline;
    }
    .markdown-body :global(hr) {
        border: none;
        border-top: 1px solid var(--border-subtle);
        margin: 16px 0;
    }
    .markdown-body :global(strong) { font-weight: 600; }
    .markdown-body :global(em) { font-style: italic; }
    .markdown-body :global(del) { text-decoration: line-through; }
</style>
