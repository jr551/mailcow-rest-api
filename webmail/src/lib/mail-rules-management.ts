// OWA-style mail rules list helpers — filter chips in Settings → Rules.

import type { MailRule } from './api';
import { isSweepAutomationMailRule } from './message-sender-sweep-automation';

export type MailRulesListFilter = 'all' | 'sweep' | 'other';

export const MAIL_RULES_LIST_FILTER_LABELS: Record<MailRulesListFilter, string> = {
    all: 'All rules',
    sweep: 'Sweep',
    other: 'Other'
};

export function filterMailRulesList(rules: MailRule[], filter: MailRulesListFilter): MailRule[] {
    if (filter === 'all') return rules;
    if (filter === 'sweep') return rules.filter((r) => isSweepAutomationMailRule(r));
    return rules.filter((r) => !isSweepAutomationMailRule(r));
}

export function mailRulesListFilterCounts(
    rules: MailRule[]
): Record<MailRulesListFilter, number> {
    const sweep = rules.filter((r) => isSweepAutomationMailRule(r)).length;
    return { all: rules.length, sweep, other: rules.length - sweep };
}

/** When the active filter shows no rows but other buckets still have rules. */
export function mailRulesListFilterEmptyHint(
    filter: MailRulesListFilter,
    counts: Record<MailRulesListFilter, number>
): string | null {
    if (filter === 'all' || counts.all === 0) return null;
    const visible = counts[filter];
    if (visible > 0) return null;
    if (filter === 'sweep') return 'No Sweep automation rules yet — use Sweep… on a message to create one.';
    return 'No non-Sweep rules — add one above or create rules in SOGo.';
}
