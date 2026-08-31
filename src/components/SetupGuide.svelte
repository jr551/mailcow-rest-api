<script lang="ts">
    import { onMount } from 'svelte';
    import { authState } from '../lib/auth.svelte';
    import { showToast } from '../lib/store.svelte';
    import { trapFocus } from '../lib/focus-trap';
    import Icon from './Icon.svelte';

    interface Props {
        onClose: () => void;
    }
    let { onClose }: Props = $props();

    let dialogEl: HTMLDivElement | undefined = $state();
    onMount(() => {
        if (dialogEl) return trapFocus(dialogEl);
    });

    // Best-guess defaults derived from the current origin. mailcow sets up
    // IMAP/SMTP on the same hostname as the web UI by default.
    const host = typeof window !== 'undefined' ? window.location.hostname : 'mail.example.com';
    const me = authState.activeUser || 'you@example.com';

    const protocols = [
        {
            name: 'IMAP (incoming)',
            host,
            ports: [
                { port: 993, encryption: 'TLS / SSL', recommended: true },
                { port: 143, encryption: 'STARTTLS' }
            ]
        },
        {
            name: 'SMTP (outgoing)',
            host,
            ports: [
                { port: 465, encryption: 'TLS / SSL', recommended: true },
                { port: 587, encryption: 'STARTTLS' }
            ]
        }
    ];

    // CalDAV / CardDAV — these go through the SOGo backend mailcow ships
    // with. URLs follow SOGo's standard layout under /SOGo/dav/<email>/.
    // Apple Calendar and Thunderbird Lightning auto-discover from the
    // server URL, so the per-collection paths are mostly informational.
    const proto = typeof window !== 'undefined' && window.location.protocol === 'http:' ? 'http' : 'https';
    const sogoBase = `${proto}://${host}/SOGo/dav/${encodeURIComponent(me)}`;
    const davUrls = {
        server: `${proto}://${host}/SOGo/dav/`,
        calendar: `${sogoBase}/Calendar/personal/`,
        contacts: `${sogoBase}/Contacts/personal/`
    };

    type Tab = 'apple' | 'android' | 'thunderbird' | 'outlook' | 'caldav' | 'manual';
    let tab = $state<Tab>('apple');

    function copyText(text: string) {
        try {
            navigator.clipboard.writeText(text);
            showToast('success', 'Copied');
        } catch {
            showToast('error', 'Copy failed');
        }
    }

    const PRESETS = {
        apple: {
            label: 'iPhone / iPad',
            steps: [
                'Open Settings → Mail → Accounts → Add Account → Other.',
                'Choose Add Mail Account, enter your name, email, password, and a description.',
                'On the next screen pick IMAP, then enter both Incoming and Outgoing mail server details — same hostname, your email as username, your mailbox or app password.',
                'Save. iOS will verify the account; if SMTP fails make sure SSL is on and the port is 465.'
            ]
        },
        android: {
            label: 'Android (K-9 Mail / FairEmail)',
            steps: [
                'Install K-9 Mail from F-Droid or Play Store (FairEmail also works).',
                'Add Account → choose your email provider as "Other".',
                'Enter your email + password. Choose IMAP for the incoming type.',
                'Set the IMAP host to the value below, port 993, SSL/TLS.',
                'Set the SMTP host the same, port 465, SSL/TLS.',
                'Finish the wizard. K-9 will check folders and you\'re in.'
            ]
        },
        thunderbird: {
            label: 'Thunderbird',
            steps: [
                'Tools → Account Settings → Account Actions → Add Mail Account.',
                'Enter your name, email, and password. Click Continue.',
                'When auto-discovery finishes (or fails), click Configure manually.',
                'Set Incoming: IMAP, hostname below, port 993, SSL/TLS, normal password.',
                'Set Outgoing: SMTP, hostname below, port 465, SSL/TLS, normal password.',
                'Re-test, then Done.'
            ]
        },
        outlook: {
            label: 'Outlook (desktop)',
            steps: [
                'File → Add Account → Advanced options → Let me set up my account manually.',
                'Pick IMAP from the type list.',
                'Enter the IMAP and SMTP hosts shown below.',
                'IMAP: 993 SSL/TLS · SMTP: 465 SSL/TLS · Username = full email · Password = mailbox or app password.',
                'Finish, then send yourself a test message.'
            ]
        },
        caldav: {
            label: 'Calendar &amp; Contacts',
            steps: [
                'Use the CalDAV / CardDAV URLs below to sync this account\'s calendars and address book.',
                'Apple (iOS / macOS): Settings → Calendar → Accounts → Add Account → Other → Add CalDAV Account. Server = the host below; user = your email; password = mailbox or app password. iOS will discover Calendar automatically; for Contacts repeat with "Add CardDAV Account".',
                'Thunderbird: install the TbSync + Provider for CalDAV & CardDAV add-ons (or use built-in calendar in Thunderbird 102+). Add a new Network calendar / CalDAV account, paste the Calendar URL below, sign in with your email + password.',
                'Android: DAVx⁵ from F-Droid or Play Store. Add account → "Login with URL and user name" → paste the server URL, your email, your password. Pick the calendars + address books to sync.',
                'GNOME / KDE: Online Accounts → Add Nextcloud-style account, point it at the server URL.'
            ]
        },
        manual: {
            label: 'Plain manual config',
            steps: [
                'Use these values in any IMAP/SMTP-capable client.',
                'IMAP: hostname below, 993 SSL/TLS (preferred) or 143 STARTTLS.',
                'SMTP: hostname below, 465 SSL/TLS (preferred) or 587 STARTTLS.',
                'CalDAV / CardDAV: paste the URLs below into any DAV-capable client.',
                'Username: full email address.',
                'Password: your mailbox password — or, if you have 2FA enabled, an app-specific password (see below).'
            ]
        }
    } as const;
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<div
    class="overlay"
    onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    role="presentation"
>
    <div
        bind:this={dialogEl}
        class="dialog fade-in"
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-labelledby="setup-title"
        data-testid="setup-modal"
    >
        <header class="head">
            <div>
                <h2 id="setup-title">Connect a device</h2>
                <p class="muted">Set up Mail.app, Outlook, Thunderbird, or any IMAP/SMTP client to talk to this mailbox.</p>
            </div>
            <button type="button" class="btn btn-ghost" aria-label="Close" onclick={onClose}>
                <Icon name="close" size={16} />
            </button>
        </header>

        <div class="body">
            <section class="server-info" aria-label="Server details">
                {#each protocols as p (p.name)}
                    <div class="proto">
                        <div class="proto-name">{p.name}</div>
                        <div class="kvs">
                            <div class="kv">
                                <span class="k">Host</span>
                                <code>{p.host}</code>
                                <button type="button" class="copy" onclick={() => copyText(p.host)} aria-label="Copy host" data-testid={`copy-${p.name}-host`}>Copy</button>
                            </div>
                            <div class="kv">
                                <span class="k">Username</span>
                                <code>{me}</code>
                                <button type="button" class="copy" onclick={() => copyText(me)} aria-label="Copy username">Copy</button>
                            </div>
                            <div class="kv ports">
                                <span class="k">Ports</span>
                                <div class="port-list">
                                    {#each p.ports as port (port.port)}
                                        <span class="port" class:rec={port.recommended}>
                                            <strong>{port.port}</strong>
                                            <span class="muted">{port.encryption}</span>
                                            {#if port.recommended}<span class="rec-tag">recommended</span>{/if}
                                        </span>
                                    {/each}
                                </div>
                            </div>
                        </div>
                    </div>
                {/each}

                <div class="proto" data-testid="setup-dav">
                    <div class="proto-name">CalDAV &amp; CardDAV (Calendar / Contacts)</div>
                    <div class="kvs">
                        <div class="kv">
                            <span class="k">Server</span>
                            <code>{davUrls.server}</code>
                            <button type="button" class="copy" onclick={() => copyText(davUrls.server)} aria-label="Copy server URL" data-testid="copy-dav-server">Copy</button>
                        </div>
                        <div class="kv">
                            <span class="k">Calendar</span>
                            <code>{davUrls.calendar}</code>
                            <button type="button" class="copy" onclick={() => copyText(davUrls.calendar)} aria-label="Copy calendar URL" data-testid="copy-dav-calendar">Copy</button>
                        </div>
                        <div class="kv">
                            <span class="k">Contacts</span>
                            <code>{davUrls.contacts}</code>
                            <button type="button" class="copy" onclick={() => copyText(davUrls.contacts)} aria-label="Copy contacts URL" data-testid="copy-dav-contacts">Copy</button>
                        </div>
                        <div class="kv">
                            <span class="k">Username</span>
                            <code>{me}</code>
                            <button type="button" class="copy" onclick={() => copyText(me)} aria-label="Copy username">Copy</button>
                        </div>
                    </div>
                </div>
            </section>

            <section class="recipes" aria-label="Client recipes">
                <div class="tab-strip" role="tablist">
                    {#each Object.entries(PRESETS) as [k, v] ([k])}
                        <button
                            type="button"
                            role="tab"
                            class="tab"
                            class:active={tab === k}
                            aria-selected={tab === k}
                            onclick={() => (tab = k as Tab)}
                            data-testid={`setup-tab-${k}`}
                        >{v.label}</button>
                    {/each}
                </div>
                <ol class="steps" data-testid="setup-steps">
                    {#each PRESETS[tab].steps as step, i (i)}
                        <li>{step}</li>
                    {/each}
                </ol>
            </section>

            <section class="note">
                <Icon name="info" size={14} />
                <div>
                    <strong>Two-factor authentication?</strong>
                    <span class="muted">
                        IMAP and SMTP can't prompt for a 2FA code, so use an
                        <a href="https://docs.mailcow.email/manual-guides/SOGo/u_e-sogo-app_password/" target="_blank" rel="noopener">
                            app password
                        </a>
                        instead of your account password. Generate one in mailcow's SOGo settings, then paste it where the
                        client asks for a password.
                    </span>
                </div>
            </section>
        </div>

        <footer class="foot">
            <button type="button" class="btn btn-primary" onclick={onClose} data-testid="setup-done">Done</button>
        </footer>
    </div>
</div>

<style>
    .overlay {
        position: fixed; inset: 0;
        background: var(--bg-overlay);
        display: flex; align-items: center; justify-content: center;
        padding: 20px; z-index: 70;
        backdrop-filter: blur(2px);
    }
    .dialog {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(720px, 100%);
        max-height: calc(100vh - 40px);
        display: flex; flex-direction: column;
        overflow: hidden;
    }
    .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .head h2 { margin: 0 0 4px; font-size: 16px; font-weight: 700; letter-spacing: -0.015em; }
    .head .muted { font-size: 12.5px; line-height: 1.45; }
    .body { padding: 18px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 22px; }
    .foot {
        display: flex;
        justify-content: flex-end;
        padding: 12px 20px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }

    .server-info {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
    }
    @media (max-width: 600px) { .server-info { grid-template-columns: 1fr; } }
    .proto {
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        padding: 12px 14px;
    }
    .proto-name {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-tertiary);
        margin-bottom: 8px;
    }
    .kvs { display: flex; flex-direction: column; gap: 6px; }
    .kv {
        display: grid;
        grid-template-columns: 60px 1fr auto;
        align-items: center;
        gap: 8px;
        font-size: 13px;
    }
    .kv.ports {
        grid-template-columns: 60px 1fr;
        align-items: flex-start;
    }
    .kv .k {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
    }
    .kv code {
        font-family: var(--font-mono);
        background: var(--bg-base);
        padding: 4px 8px;
        border-radius: var(--radius-xs);
        font-size: 12.5px;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .copy {
        font-size: 11px;
        color: var(--accent-text);
        padding: 4px 8px;
        border-radius: var(--radius-xs);
        font-weight: 500;
    }
    .copy:hover { background: var(--accent-soft); }
    .port-list { display: flex; flex-direction: column; gap: 4px; }
    .port {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12.5px;
    }
    .port strong { font-family: var(--font-mono); }
    .port.rec strong { color: var(--accent-text); }
    .rec-tag {
        font-size: 10px;
        padding: 1px 6px;
        background: var(--accent-soft);
        color: var(--accent-text);
        border-radius: 8px;
        font-weight: 600;
    }

    .recipes {
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        overflow: hidden;
    }
    .tab-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 0;
        background: var(--bg-surface-alt);
        border-bottom: 1px solid var(--border-subtle);
        padding: 4px;
    }
    .tab {
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-secondary);
        border-radius: var(--radius-xs);
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .tab:hover { background: var(--bg-hover); color: var(--text-primary); }
    .tab.active {
        background: var(--bg-surface);
        color: var(--text-primary);
        font-weight: 600;
        box-shadow: var(--shadow-sm);
    }
    .steps {
        margin: 0;
        padding: 14px 16px 14px 36px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 13px;
        line-height: 1.55;
        color: var(--text-secondary);
    }
    .steps li::marker { color: var(--text-tertiary); font-weight: 600; }

    .note {
        display: flex;
        gap: 10px;
        padding: 12px 14px;
        background: var(--accent-soft);
        border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        border-radius: var(--radius-md);
        color: var(--text-primary);
        font-size: 12.5px;
        line-height: 1.5;
    }
    .note strong { display: block; margin-bottom: 2px; }
    .note .muted { font-size: 12px; }
</style>
