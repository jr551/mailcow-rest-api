import { listMessages, type MessageListItem } from './api';
import {
    normalizeSenderAddress,
    selectSenderSweepTargets,
    type SenderSweepAction
} from './message-sender-sweep';

const SWEEP_PAGE = 100;
const SWEEP_MAX = 200;

export async function listFolderMessagesFromSender(
    folderPath: string,
    sender: string,
    opts: { signal?: AbortSignal; max?: number } = {}
): Promise<MessageListItem[]> {
    const needle = normalizeSenderAddress(sender);
    if (!needle) return [];
    const max = Math.max(1, Math.min(SWEEP_MAX, opts.max ?? SWEEP_MAX));
    const collected: MessageListItem[] = [];
    for (let page = 0; collected.length < max; page++) {
        if (opts.signal?.aborted) break;
        const want = Math.min(SWEEP_PAGE, max - collected.length);
        const r = await listMessages(folderPath, {
            page,
            pageSize: want,
            search: `from:${needle}`,
            cache: 'no-store'
        });
        const batch = r.messages || [];
        collected.push(...batch);
        if (batch.length < want) break;
    }
    return collected.slice(0, max);
}

export async function resolveSenderSweepTargets(
    folderPath: string,
    sender: string,
    action: SenderSweepAction,
    opts: { signal?: AbortSignal } = {}
): Promise<MessageListItem[]> {
    const all = await listFolderMessagesFromSender(folderPath, sender, opts);
    return selectSenderSweepTargets(all, sender, action);
}
