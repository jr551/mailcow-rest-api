// OWA-style Sweep automation: server-side mail rules that keep handling
// future mail from the same sender (Deleted Items / Archive). Pure builders
// and duplicate detection — UI lives in SenderSweepDialog.svelte.

import type { MailRule, MailRuleInput, MailRuleLeafCondition, MailRuleCompoundCondition } from './api';
import { normalizeSenderAddress } from './message-sender-sweep';

export type SenderSweepAutomationKind = 'always-trash' | 'always-archive';

const AUTOMATION_PREFIX = 'Sweep: ';

export function sweepAutomationRuleTitle(sender: string, kind: SenderSweepAutomationKind): string {
    const who = sender.trim() || 'sender';
    if (kind === 'always-archive') return `${AUTOMATION_PREFIX}Archive mail from ${who}`;
    return `${AUTOMATION_PREFIX}Trash mail from ${who}`;
}

export function buildSenderSweepAutomationRule(
    sender: string,
    kind: SenderSweepAutomationKind,
    folderPath: string
): MailRuleInput {
    const from = normalizeSenderAddress(sender);
    if (!from) throw new Error('Invalid sender address');
    return {
        name: sweepAutomationRuleTitle(from, kind),
        condition: { type: 'from-contains', value: from },
        action: { type: 'fileinto', folder: folderPath }
    };
}

function leafFromContains(c: MailRuleLeafCondition): string | null {
    if (c.type !== 'from-contains') return null;
    return normalizeSenderAddress(c.value);
}

function isCompoundCondition(c: MailRule['condition']): c is MailRuleCompoundCondition {
    return Array.isArray((c as MailRuleCompoundCondition).conditions);
}

function ruleSender(rule: MailRule): string | null {
    const c = rule.condition;
    if (isCompoundCondition(c)) {
        for (const leaf of c.conditions) {
            const from = leafFromContains(leaf);
            if (from) return from;
        }
        return null;
    }
    return leafFromContains(c);
}

export function findExistingSweepAutomation(
    rules: MailRule[],
    sender: string,
    kind: SenderSweepAutomationKind
): MailRule | undefined {
    const needle = normalizeSenderAddress(sender);
    if (!needle) return undefined;
    const title = sweepAutomationRuleTitle(needle, kind);
    return rules.find((r) => r.name === title || (r.name.startsWith(AUTOMATION_PREFIX) && ruleSender(r) === needle));
}

export function automationKindForOneTimeAction(
    action: 'delete-all' | 'keep-latest' | 'archive-all'
): SenderSweepAutomationKind {
    return action === 'archive-all' ? 'always-archive' : 'always-trash';
}
