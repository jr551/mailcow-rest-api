/** Lightweight markdown → HTML renderer for chat bubbles.
 *  Handles: paragraphs, **bold**, *italic*, `code`, ```code blocks```,
 *  > blockquotes, - lists, [links](url), # headings.
 *  Safe: HTML is escaped before parsing so only markdown syntax produces tags.
 */

function escapeHtml(raw: string): string {
    return raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Quotes matter because the link rule below interpolates into an
        // href="..." attribute. Without these, a markdown link whose URL
        // contained a quote closed the attribute early and everything after
        // it became more attributes — including event handlers, in output
        // that is rendered with {@html}.
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Escape what can terminate a double-quoted attribute value. The source has
 *  already been through escapeHtml, so this is a guard on the interpolation
 *  itself rather than the only defence. */
function escapeAttr(value: string): string {
    return value.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Scheme test on a whitespace-stripped copy. Browsers ignore embedded tabs
 *  and newlines when resolving a URL scheme, so "java\tscript:" navigates
 *  even though it doesn't match a naive ^javascript: pattern. */
function isDangerousUrl(url: string): boolean {
    const flat = url.replace(/[\s\u0000-\u001f\u007f]/g, '').toLowerCase();
    return /^(?:javascript|vbscript|file|data):/.test(flat) && !/^data:image\//.test(flat);
}

/** Extract fenced code blocks, replace with placeholders, process rest, then restore. */
export function renderMarkdown(src: string): string {
    let text = escapeHtml(src);
    const codeBlocks: { placeholder: string; html: string }[] = [];

    // Fenced code blocks (```...```)
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
        const ph = `\x00CODEBLOCK${codeBlocks.length}\x00`;
        const cls = lang ? ` class="language-${lang}"` : '';
        codeBlocks.push({
            placeholder: ph,
            html: `<pre><code${cls}>${code.trimEnd()}</code></pre>`
        });
        return ph;
    });

    // Inline code (`...`) — skip placeholders
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold (**...**)
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic (*...* or _..._) — but not inside already-rendered tags.
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Underscore emphasis only counts at word boundaries. Intra-word
    // underscores are far more likely to be an identifier than emphasis —
    // UI_PROXY_OK, snake_case names, env vars like LLM_API_KEY — and
    // treating them as markup rendered them as "UI<em>PROXY</em>OK",
    // silently corrupting the text the assistant meant to show. This is
    // what CommonMark and GFM do for the same reason.
    text = text.replace(/(^|[\s([{<"'])_([^_\n]+)_(?=$|[\s)\]}>.,;:!?"'])/g, '$1<em>$2</em>');

    // Strikethrough (~~...~~)
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // Links [text](url) — block dangerous schemes so a model (or pasted
    // markdown) can't smuggle javascript:/vbscript:/data:text/html into
    // the chat surface, which uses {@html} to render the result.
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, rawUrl) => {
        const url = String(rawUrl).trim();
        const safe = isDangerousUrl(url) ? '#' : url;
        return `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    // Blockquote lines (> ...)
    text = text.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists (- item or * item)
    text = text.replace(/^(?:[-*] (.+)(?:\n|$))+/gm, (block) => {
        const items = block
            .trim()
            .split('\n')
            .map((line) => `<li>${line.replace(/^[-*] /, '')}</li>`)
            .join('');
        return `<ul>${items}</ul>`;
    });

    // Ordered lists (1. item)
    text = text.replace(/^(?:\d+\. (.+)(?:\n|$))+/gm, (block) => {
        const items = block
            .trim()
            .split('\n')
            .map((line) => `<li>${line.replace(/^\d+\. /, '')}</li>`)
            .join('');
        return `<ol>${items}</ol>`;
    });

    // Headings (### heading)
    text = text.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Horizontal rule
    text = text.replace(/^---+$/gm, '<hr />');

    // Restore code blocks
    for (const cb of codeBlocks) {
        text = text.replace(cb.placeholder, cb.html);
    }

    // Paragraphs: split on blank lines, wrap non-block elements
    const blocks = text.split(/\n\n+/);
    const out = blocks.map((blk) => {
        const trimmed = blk.trim();
        if (!trimmed) return '';
        // Don't wrap existing block-level elements
        if (
            trimmed.startsWith('<pre>') ||
            trimmed.startsWith('<ul>') ||
            trimmed.startsWith('<ol>') ||
            trimmed.startsWith('<blockquote>') ||
            trimmed.startsWith('<h') ||
            trimmed.startsWith('<hr')
        ) {
            return trimmed;
        }
        // Convert single newlines to <br>
        const inner = trimmed.replace(/\n/g, '<br>\n');
        return `<p>${inner}</p>`;
    });

    return out.join('\n\n');
}
