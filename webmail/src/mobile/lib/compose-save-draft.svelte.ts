import { appendRawMessage, ApiError } from '../../lib/api';
import {
    buildComposeDraftRfc822,
    composeDraftHasContent,
    resolveDraftsMailboxPath,
    type ComposeDraftInput
} from '../../lib/compose-draft';
import {
    MOBILE_SAVE_DRAFT_EMPTY,
    MOBILE_SAVE_DRAFT_SUCCESS,
    mobilePlainTextToDraftHtml
} from '../../lib/mobile-compose-save-draft';
import { mobileState, showToast } from './store.svelte';
import type { SendAttachment } from '../../lib/api';

export type MobileComposeDraftInput = {
    from: string;
    fromName?: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    inReplyTo?: string;
    attachments?: SendAttachment[];
};

export async function saveMobileComposeDraft(input: MobileComposeDraftInput): Promise<boolean> {
    const html = mobilePlainTextToDraftHtml(input.body);
    const text = input.body || '';
    if (!composeDraftHasContent({ to: input.to.join(', '), subject: input.subject, html, text })) {
        showToast('error', MOBILE_SAVE_DRAFT_EMPTY);
        return false;
    }
    const draftInput: ComposeDraftInput = {
        from: input.from,
        fromName: input.fromName,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        html,
        text,
        inReplyTo: input.inReplyTo,
        attachments: input.attachments
    };
    try {
        const path = resolveDraftsMailboxPath(mobileState.mailboxes);
        const rfc822 = buildComposeDraftRfc822(draftInput);
        await appendRawMessage(path, rfc822, { flags: ['Draft'] });
        showToast('success', MOBILE_SAVE_DRAFT_SUCCESS);
        return true;
    } catch (err) {
        const detail = err instanceof ApiError ? (err.detail || err.title) : (err as Error).message;
        showToast('error', detail || "Couldn't save draft");
        return false;
    }
}
