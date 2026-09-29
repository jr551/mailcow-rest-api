// Best-effort HTML email sanitizer for rendering inside a sandboxed
// iframe. The iframe is the primary defence (no allow-scripts, no
// allow-forms, no allow-top-navigation); this layer is defence-in-depth
// to keep tracking content and dangerous URI schemes from rendering at
// all, even if a future iframe attribute change loosens the sandbox.
//
// Strips:
//   - <script>, <style>, <iframe>, <object>, <embed>, <link>, <meta>,
//     <base>, <form> blocks (including any payload they carry)
//   - inline event-handler attributes (onclick, onerror, …)
//   - href/src/xlink:href values starting with javascript:, vbscript:,
//     data:text/html, file: (privacy + XSS)
//   - <img> with remote http(s) src when allowRemoteImages is false
//   - background-image / list-style-image url() pointing at remote URLs
//     in inline style attributes (privacy)
//   - srcset attributes (sender-controlled remote loads)

const BLOCK_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'frame', 'frameset'];
const BLOCK_REGEX = new RegExp(`<(${BLOCK_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>|<(?:${BLOCK_TAGS.join('|')})\\b[^>]*\\/?>`, 'gi');

const HANDLER_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

// Match dangerous URI schemes in href/src/xlink:href whether the value is
// single-, double-, or unquoted. Covers javascript:, vbscript:, file:, and
// data:text/html (data:image/* is allowed elsewhere by the regex below).
const DANGEROUS_HREF = /(\b(?:href|src|xlink:href|action|formaction|background|poster))\s*=\s*(?:"\s*(?:javascript|vbscript|file):[^"]*"|'\s*(?:javascript|vbscript|file):[^']*'|\s*(?:javascript|vbscript|file):[^\s>]+|"\s*data:text\/html[^"]*"|'\s*data:text\/html[^']*'|\s*data:text\/html[^\s>]+)/gi;

// srcset can carry remote http(s) just like src — strip the whole attribute.
const SRCSET_ATTR = /\s+srcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

// Remote images blocked by default (privacy).
const IMG_SRC = /<img\b([^>]*?)\bsrc\s*=\s*("https?:[^"]*"|'https?:[^']*'|https?:[^\s>]+)/gi;

// Remote url() inside inline style attributes — covers background-image,
// list-style-image, cursor, mask-image, etc.
const STYLE_REMOTE_URL = /(\sstyle\s*=\s*)("[^"]*"|'[^']*')/gi;

export interface SanitizeOptions {
    allowRemoteImages?: boolean;
}

function scrubStyleValue(value: string, allowRemoteImages: boolean): string {
    if (allowRemoteImages) return value;
    // Replace url(http…) and url('http…') and url("http…") with url(about:blank).
    return value.replace(/url\(\s*(?:"|')?\s*https?:[^)"']*(?:"|')?\s*\)/gi, 'url(about:blank)');
}

export function sanitizeHtml(html: string, opts: SanitizeOptions = {}): string {
    if (!html) return '';
    const allowRemoteImages = !!opts.allowRemoteImages;
    let out = html;

    // Drop dangerous tag blocks (scripts, styles, link/meta/base, embedded
    // browsing contexts, forms). Run twice to catch nested/overlapping
    // pairs the first pass leaves behind.
    out = out.replace(BLOCK_REGEX, '');
    out = out.replace(BLOCK_REGEX, '');

    // Strip inline event handlers everywhere.
    out = out.replace(HANDLER_ATTR, '');

    // Strip srcset (avoids remote loads slipping past the IMG_SRC rule).
    out = out.replace(SRCSET_ATTR, '');

    // Neutralise dangerous URI schemes in any link/source attribute.
    out = out.replace(DANGEROUS_HREF, '$1="#"');

    // Privacy: rewrite remote url() in inline styles.
    out = out.replace(STYLE_REMOTE_URL, (_m, prefix, quoted) => `${prefix}${scrubStyleValue(quoted, allowRemoteImages)}`);

    if (!allowRemoteImages) {
        out = out.replace(IMG_SRC, '<img $1data-blocked-src=$2 alt="(remote image blocked)"');
    }
    return out;
}

// While the privacy proxy is still fetching, the message must not render
// the sender's original URLs — that would leak the read to them, which is
// the whole thing the proxy exists to prevent — and it must not render a
// broken-image icon either, which is what happens when the src is simply
// removed. Park the URL on a data attribute and let CSS draw a placeholder
// so the layout is stable and the state is legible.
export function placeholderRemoteImages(html: string): string {
    return html.replace(
        /<img\b([^>]*?)\bsrc\s*=\s*("https?:[^"]*"|'https?:[^']*'|https?:[^\s>]+)/gi,
        '<img $1data-loading-src=$2 class="imr-img-loading" alt="Loading image…"'
    );
}

// A <script> that reports link clicks to the parent window and swallows the
// navigation, so the webmail can confirm before the user leaves.
//
// WHY A SCRIPT AT ALL: the body renders in a sandboxed iframe that owns its
// own document. Without `allow-scripts` that document is completely inert —
// no listener can run, no navigation can be cancelled, and the only signal
// out is the frame navigating away, which by definition has already lost the
// user's click. There is no script-free way to intercept a click in a frame
// we cannot reach into. So the frame is given `allow-scripts` and NOT
// `allow-same-origin`, which is the pair that matters: the frame keeps an
// opaque origin, so this script (and anything else that ran there) cannot
// read our DOM, cookies, storage or origin, and can only postMessage.
//
// HONEST LIMITS, stated because this is easy to oversell:
//   - `allow-scripts` is a real posture change. It is a mitigation for a
//     sanitizer bypass, not the boundary. The boundary is still the opaque
//     origin plus the sanitizer.
//   - A frame with a sanitizer bypass could forge a link-check message from
//     the same source, because the nonce lives in this document's text. The
//     caller cross-checks `event.source` as well, and neither check is a
//     security boundary on its own — a prompt the user reads is a UX guard,
//     not a guarantee.
//   - Sender-authored script is stripped by sanitizeHtml before this runs,
//     and inline on* handlers by HANDLER_ATTR, so the only script in the
//     frame is this one in the ordinary case.
//
// The nonce exists to reject messages from any *other* frame on the page
// (there are several: the .eml preview renders its own iframe) rather than to
// defend against a compromised one.
//
// DELIBERATELY NOT INTERCEPTED: clicks with a modifier held, and middle
// click. Ctrl/Cmd/Shift-click is an explicit "open this elsewhere" gesture
// and blocking it makes the browser feel broken; the user still has the URL
// on screen and can copy it.
export function linkCheckShim(nonce: string): string {
    return `<script>(function(){
var N=${JSON.stringify(nonce)};
function report(e){
  var t=e.target;
  var a=t&&t.closest?t.closest('a[href]'):null;
  if(!a)return;
  var href;
  try{href=new URL(a.getAttribute('href'),document.baseURI).href;}catch(_){return;}
  if(href.indexOf('http:')!==0&&href.indexOf('https:')!==0)return;
  var label=(a.textContent||'').replace(/\\s+/g,' ').trim();
  if(label.length>140)label=label.slice(0,140);
  e.preventDefault();
  e.stopPropagation();
  parent.postMessage({__linkcheck:1,token:N,url:href,label:label},'*');
}
document.addEventListener('click',report,true);
document.addEventListener('auxclick',function(e){if(e.button===1)report(e);},true);
}());</script>`;
}

// `shim` is the link-click reporter (see linkCheckShim). Optional and
// off by default so every other caller — and the .eml preview frame, which
// has no prompt to offer — gets exactly the document it got before.
export function buildIframeSrcDoc(html: string, theme: 'light' | 'dark', shim = ''): string {
    const fg = theme === 'dark' ? '#e8eaef' : '#0f1115';
    const bg = theme === 'dark' ? '#16191f' : '#ffffff';
    const link = theme === 'dark' ? '#88aef5' : '#1f5cdb';
    const muted = theme === 'dark' ? '#7e8693' : '#6b7380';
    const border = theme === 'dark' ? '#2b313c' : '#d4d8e0';
    // color-scheme tells the browser to interpret `Canvas` system colors,
    // form controls, scrollbars, etc., in the matching mode. Many HTML
    // emails leave colors unspecified — color-scheme alone keeps them
    // readable in dark mode.
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${theme}">
<base target="_blank" rel="noopener noreferrer">
<style>
    :root { color-scheme: ${theme}; }
    html { margin: 0; padding: 0; }
    body { margin: 0 auto; padding: 16px 18px; background: ${bg}; color: ${fg};
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px; line-height: 1.6; max-width: 820px; }
    /* Marketing mail is nearly always one fixed-width table (typically
     * 600px). Left-aligned inside a wider pane it reads as broken layout,
     * with the sender's background colour filling the empty space beside
     * it — so centre any top-level table in the available width. */
    body > table, body > center > table { margin-left: auto; margin-right: auto; }
    /* Heuristic: if the email forces a white background, dim it in dark mode
     * so it doesn't blow out. Authors who set explicit dark-friendly colors
     * still win because their inline styles are more specific. */
    ${theme === 'dark'
        ? 'body[bgcolor], body[style], table[bgcolor], table[style] { color-scheme: light; }'
        : ''}
    a { color: ${link}; }
    img { max-width: 100%; height: auto; }
    /* Placeholder for an image the proxy hasn't returned yet. Sized from
     * the element's own width/height where the mail provides them, so the
     * layout doesn't jump when the real image arrives. */
    img.imr-img-loading {
        min-width: 24px;
        min-height: 24px;
        background: linear-gradient(90deg,
            ${theme === 'dark' ? '#232833' : '#eef0f4'} 25%,
            ${theme === 'dark' ? '#2b313d' : '#f7f8fa'} 37%,
            ${theme === 'dark' ? '#232833' : '#eef0f4'} 63%);
        background-size: 400% 100%;
        animation: imr-shimmer 1.4s ease-in-out infinite;
        border-radius: 4px;
        color: transparent;
    }
    @keyframes imr-shimmer {
        0% { background-position: 100% 50%; }
        100% { background-position: 0 50%; }
    }
    @media (prefers-reduced-motion: reduce) {
        img.imr-img-loading { animation: none; }
    }
    blockquote { border-left: 3px solid ${border}; margin: 0; padding: 0 12px; color: ${muted}; }
    pre { white-space: pre-wrap; word-wrap: break-word; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
    table { max-width: 100%; }
    hr { border: 0; border-top: 1px solid ${border}; }
</style>${shim}
</head><body>${html}</body></html>`;
}
