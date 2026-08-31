<script lang="ts">
    import Icon from './Icon.svelte';
    import type { IconName } from '../lib/icons';

    interface Props {
        subject: string;
        date?: string | null;
        kind?: 'alert' | 'tracking' | 'sms';
        compact?: boolean; // smaller layout for inbox rows
    }
    let { subject, date = null, kind = 'alert', compact = false }: Props = $props();

    // Pick a sensible icon + accent based on subject keywords / kind.
    const iconName: IconName = $derived.by<IconName>(() => {
        if (kind === 'tracking') return 'eye';
        if (kind === 'sms') return 'phone';
        const s = subject.toLowerCase();
        if (s.startsWith('alert')) return 'shield';
        if (s.includes('error') || s.includes('failed')) return 'info';
        if (s.includes('warning') || s.includes('warn')) return 'info';
        return 'bell';
    });

    const niceDate = (() => {
        if (!date) return '';
        const d = new Date(date);
        if (Number.isNaN(d.getTime())) return '';
        const today = new Date();
        if (d.toDateString() === today.toDateString())
            return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    })();
</script>

<div class="notice" class:compact data-testid="notification-bubble" data-kind={kind}>
    <span class="badge"><Icon name={iconName} size={compact ? 12 : 14} /></span>
    <span class="title" title={subject}>{subject || '(no subject)'}</span>
    {#if niceDate}<span class="date">{niceDate}</span>{/if}
</div>

<style>
    .notice {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--accent) 10%, var(--bg-surface)),
            var(--bg-surface)
        );
        border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        border-radius: 999px;
        font-size: 12.5px;
        line-height: 1.3;
        color: var(--text-primary);
        max-width: 100%;
    }
    .notice[data-kind='tracking'] {
        background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--warning, #d97706) 14%, var(--bg-surface)),
            var(--bg-surface)
        );
        border-color: color-mix(in srgb, var(--warning, #d97706) 30%, var(--border-subtle));
    }
    .notice[data-kind='sms'] {
        background: linear-gradient(
            135deg,
            color-mix(in srgb, #16a34a 14%, var(--bg-surface)),
            var(--bg-surface)
        );
        border-color: color-mix(in srgb, #16a34a 30%, var(--border-subtle));
    }
    .notice[data-kind='sms'] .badge {
        background: color-mix(in srgb, #16a34a 22%, var(--bg-surface-alt));
        color: #16a34a;
    }
    .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--accent) 18%, var(--bg-surface-alt));
        color: var(--accent-text);
        flex-shrink: 0;
    }
    .notice[data-kind='tracking'] .badge {
        background: color-mix(in srgb, var(--warning, #d97706) 22%, var(--bg-surface-alt));
        color: var(--warning, #d97706);
    }
    .title {
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
    }
    .date {
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
        font-size: 11.5px;
        flex-shrink: 0;
    }
    .notice.compact {
        padding: 3px 8px;
        font-size: 12px;
        gap: 6px;
    }
    .notice.compact .badge { width: 18px; height: 18px; }
</style>
