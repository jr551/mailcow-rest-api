<script lang="ts">
    import Icon from '../Icon.svelte';

    interface Props {
        subject: string;
        fromName?: string;
        fromAddr?: string;
        date?: string | null;
        preview?: string;
    }
    let { subject, fromName = '', fromAddr = '', date = null, preview = '' }: Props = $props();

    const initials = (() => {
        const src = (fromName || fromAddr || '?').trim();
        const parts = src.split(/[\s.@_-]+/).filter(Boolean);
        if (parts.length === 0) return '?';
        if (parts.length === 1) return parts[0][0].toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    })();

    const niceDate = (() => {
        if (!date) return '';
        const d = new Date(date);
        if (Number.isNaN(d.getTime())) return '';
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    })();
</script>

<div class="email-card" data-testid="email-context-card">
    <div class="env-icon" aria-hidden="true">
        <Icon name="mail" size={14} />
    </div>
    <div class="avatar" aria-hidden="true">{initials}</div>
    <div class="meta">
        <div class="row1">
            <span class="from" title={fromAddr}>{fromName || fromAddr || 'Unknown sender'}</span>
            {#if niceDate}<span class="date">{niceDate}</span>{/if}
        </div>
        <div class="subject" title={subject}>{subject || '(no subject)'}</div>
        {#if preview}<div class="preview">{preview}</div>{/if}
    </div>
</div>

<style>
    .email-card {
        display: grid;
        grid-template-columns: auto auto 1fr;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        margin-bottom: 10px;
        background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--accent) 8%, var(--bg-surface)),
            var(--bg-surface)
        );
        border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border-subtle));
        border-radius: 12px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    }
    .env-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--accent) 18%, transparent);
        color: var(--accent-text);
        flex-shrink: 0;
    }
    .avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #d268f4));
        color: white;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }
    .meta { min-width: 0; line-height: 1.35; }
    .row1 {
        display: flex;
        align-items: baseline;
        gap: 8px;
        font-size: 12px;
    }
    .from {
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
    }
    .date {
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }
    .subject {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 1px;
    }
    .preview {
        font-size: 12px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 2px;
    }
</style>
