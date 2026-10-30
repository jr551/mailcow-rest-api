import { appendRawMessage, type Mailbox } from './api';
import {
    buildComposeDraftRfc822,
    composeDraftHasContent,
    resolveDraftsMailboxPath,
    type ComposeDraftInput
} from './compose-draft';
import { showToast } from './store.svelte';

export async function saveComposeDraftToImap(
    mailboxes: Mailbox[],
    input: ComposeDraftInput
): Promise<{ path: string; uid: number | null } | null> {
    if (!composeDraftHasContent({
        to: input.to.join(', '),
        subject: input.subject,
        html: input.html,
        text: input.text
    })) {
        showToast('error', 'Nothing to save — add a recipient, subject, or message.');
        return null;
    }
    const path = resolveDraftsMailboxPath(mailboxes);
    const rfc822 = buildComposeDraftRfc822(input);
    const res = await appendRawMessage(path, rfc822, { flags: ['Draft'] });
    return { path: res.path || path, uid: res.uid };
}
