/** Shared copy/helpers for mobile save draft (slice 37). */

export const MOBILE_SAVE_DRAFT_SUCCESS = 'Draft saved to Drafts';
export const MOBILE_SAVE_DRAFT_EMPTY = 'Nothing to save — add a recipient, subject, or message.';

/** Plain-text mobile compose body → minimal HTML for multipart draft append. */
export function mobilePlainTextToDraftHtml(text: string): string {
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    if (!escaped.trim()) return '<p></p>';
    return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
}
