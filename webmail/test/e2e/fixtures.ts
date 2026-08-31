import type { Page, Route } from '@playwright/test';

// Centralized API mocks for the webmail SPA. Routes are matched against the
// preview server's URL space (no /webmail prefix on API calls — Vite preview
// serves the SPA at /webmail/ but the SPA fetches /v1/... directly).

export const MOCK_USER = 'demo@test.local';
export const MOCK_PASS = 'hunter2';

export const mailboxes = [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: '\\Inbox', subscribed: true },
    { path: 'Sent', name: 'Sent', delimiter: '/', flags: [], specialUse: '\\Sent', subscribed: true },
    { path: 'Drafts', name: 'Drafts', delimiter: '/', flags: [], specialUse: '\\Drafts', subscribed: true },
    { path: 'Trash', name: 'Trash', delimiter: '/', flags: [], specialUse: '\\Trash', subscribed: true },
    { path: 'Junk', name: 'Junk', delimiter: '/', flags: [], specialUse: '\\Junk', subscribed: true },
    { path: 'Archive', name: 'Archive', delimiter: '/', flags: ['\\HasChildren'], specialUse: '\\Archive', subscribed: true },
    { path: 'Archive/2024', name: '2024', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: null, subscribed: true },
    { path: 'Archive/2025', name: '2025', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: null, subscribed: true },
    { path: 'Projects', name: 'Projects', delimiter: '/', flags: ['\\HasChildren'], specialUse: null, subscribed: true },
    { path: 'Projects/Client A', name: 'Client A', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: null, subscribed: true },
    { path: 'Projects/Client B', name: 'Client B', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: null, subscribed: true },
    { path: '.AI Conversations', name: '.AI Conversations', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: null, subscribed: true }
];

export const messages = [
    {
        uid: 1001,
        seq: 1,
        flags: [],
        size: 1234,
        internalDate: '2026-04-29T10:32:00Z',
        envelope: {
            date: '2026-04-29T10:32:00Z',
            subject: 'Welcome to imap-rest webmail',
            from: [{ name: 'Concierge', address: 'concierge@example.com' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [],
            messageId: '<welcome@imap-rest>',
            inReplyTo: null
        }
    },
    {
        uid: 1000,
        seq: 0,
        flags: ['\\Seen'],
        size: 4321,
        internalDate: '2026-04-28T16:09:00Z',
        envelope: {
            date: '2026-04-28T16:09:00Z',
            subject: 'Q2 invoice ready for review',
            from: [{ name: 'Acme Billing', address: 'billing@acme.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [],
            messageId: '<inv-1@acme>',
            inReplyTo: null
        }
    },
    {
        uid: 999,
        seq: -1,
        flags: ['\\Seen', '\\Flagged'],
        size: 200,
        internalDate: '2026-04-27T08:00:00Z',
        envelope: {
            date: '2026-04-27T08:00:00Z',
            subject: 'Re: lunch on Friday?',
            from: [{ name: 'Sam', address: 'sam@friend.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [],
            messageId: '<lunch-2@friend>',
            inReplyTo: null
        }
    },
    {
        uid: 998,
        seq: -2,
        flags: ['\\Seen'],
        size: 800,
        internalDate: '2026-04-26T14:22:00Z',
        envelope: {
            date: '2026-04-26T14:22:00Z',
            subject: 'Opened: Re: Fwd: CONTACT FROM GUINNESS (TEXT, E-MAIL OR LETTER) TGPLIVE:0630230517',
            from: [{ name: 'Tracker', address: 'tracker@example.com' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [],
            messageId: '<track-1@example>',
            inReplyTo: null
        }
    }
];

export const detailFor1001 = {
    uid: 1001,
    seq: 1,
    flags: [],
    size: 1234,
    internalDate: '2026-04-29T10:32:00Z',
    envelope: messages[0].envelope,
    text:
        'Hi there!\n\n' +
        'Welcome to your new webmail. This message demonstrates the layout — ' +
        'click the AI button to summarize or draft a reply.\n\n' +
        'Best,\nThe Concierge',
    html: null,
    attachments: []
};

export const detailFor998 = {
    uid: 998,
    seq: -2,
    flags: ['\\Seen'],
    size: 800,
    internalDate: '2026-04-26T14:22:00Z',
    envelope: messages[3].envelope,
    text:
        'This is an open-tracking notification.\n\n' +
        'The recipient opened your email at 2026-04-26 14:22:00 UTC.',
    html: null,
    attachments: []
};

export const detailFor1000 = {
    uid: 1000,
    seq: 0,
    flags: ['\\Seen'],
    size: 4321,
    internalDate: '2026-04-28T16:09:00Z',
    envelope: messages[1].envelope,
    text:
        'Hi,\n\n' +
        'Your Q2 invoice is ready. Total due: $1,248.00. ' +
        'Payment is due by May 15. Let us know if anything looks off.\n\n' +
        '— Acme Billing',
    html: null,
    attachments: [
        { id: '2', filename: 'invoice-q2-2026.pdf', contentType: 'application/pdf', size: 84_312, disposition: 'attachment', related: false },
        { id: '3', filename: 'receipt-april.png', contentType: 'image/png', size: 22_104, disposition: 'attachment', related: false }
    ]
};

export async function applyMocks(page: Page) {
    await page.route(/\/health$/, (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ok: true, cache: 0, pool: 0,
                capabilities: { ai: true, ocr: true, smtp: false, drive: true }
            })
        });
    });

    await page.route('**/imap-rest/health', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ok: true, cache: 0, pool: 0,
                capabilities: { ai: true, ocr: true, smtp: false, drive: true }
            })
        });
    });

    // Bearer-token session endpoints (matches v0.2.0 server implementation).
    await page.route('**/v1/auth/session', (route, request) => {
        if (request.method() === 'POST') {
            route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({
                    token: 'fake-token-12345',
                    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
                })
            });
        } else {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    authenticated: true,
                    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
                })
            });
        }
    });

    await page.route('**/v1/auth/logout', (route) => {
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });

    await page.route('**/v1/me/shortcuts', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                shortcuts: [
                    { title: 'HR Portal', url: 'https://hr.example.com', mode: 'link', icon: 'user', description: 'Holidays, payroll' },
                    { title: 'Wiki', url: 'https://wiki.example.com', mode: 'popup', icon: 'info', description: 'Internal docs' },
                    { title: 'Calendar', url: 'https://calendar.example.com', mode: 'embed', icon: 'inbox', description: 'Team calendar' }
                ]
            })
        });
    });

    await page.route('**/v1/push/config', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ vapidPublicKey: '', configured: false })
        });
    });

    // Mailcow-DB-backed endpoints (mailbox info, aliases, logins, sender policies).
    await page.route('**/v1/me/mailbox', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                username: MOCK_USER, name: 'Demo User', active: true,
                domain: 'test.local', localPart: 'demo',
                quota: 5_368_709_120, quotaUsed: 248_932_864,
                percentInUse: 5, messages: 312,
                created: '2026-01-04 10:21:00', modified: '2026-04-29 18:11:00',
                authsource: 'mailcow', attributes: {}
            })
        });
    });
    await page.route('**/v1/me/logins*', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                user: MOCK_USER,
                logins: [
                    { datetime: '2026-04-29 18:11:00', service: 'imap', real_rip: '192.0.2.5', success: 1, app_password: 0 },
                    { datetime: '2026-04-29 11:02:30', service: 'smtp', real_rip: '192.0.2.5', success: 1, app_password: 1 },
                    { datetime: '2026-04-28 09:14:22', service: 'imap', real_rip: '198.51.100.7', success: 1, app_password: 0 },
                    { datetime: '2026-04-27 21:55:12', service: 'imap', real_rip: '192.0.2.42', success: 0, app_password: 0 }
                ]
            })
        });
    });
    await page.route('**/v1/me/aliases', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                user: MOCK_USER,
                aliases: [
                    { address: 'demo+sales@test.local', goto: MOCK_USER, active: 1, created: '2026-02-01 09:00:00', modified: '2026-02-01 09:00:00' },
                    { address: 'press@test.local', goto: MOCK_USER, active: 1, created: '2026-03-12 14:30:00', modified: '2026-03-12 14:30:00' }
                ]
            })
        });
    });
    await page.route('**/v1/me/temp-aliases', (route, request) => {
        if (request.method() === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            const validity = body.permanent ? 0 : Math.floor(Date.now() / 1000) + (body.validityHours || 720) * 3600;
            route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ address: `temp.${Date.now()}@test.local`, validity, permanent: !!body.permanent })
            });
        } else {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ user: MOCK_USER, aliases: [] })
            });
        }
    });
    await page.route('**/v1/me/send-from', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                user: MOCK_USER,
                addresses: [MOCK_USER, 'demo+sales@test.local', 'press@test.local']
            })
        });
    });
    let blockedList: { prefid: number; sender: string }[] = [];
    let allowedList: { prefid: number; sender: string }[] = [];
    let prefidCounter = 1;
    await page.route('**/v1/me/blocked-senders', (route, request) => {
        if (request.method() === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            const entry = { prefid: prefidCounter++, sender: body.sender };
            blockedList = [...blockedList, entry];
            route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(entry) });
        } else {
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: MOCK_USER, list: blockedList }) });
        }
    });
    await page.route(/\/v1\/me\/blocked-senders\/\d+$/, (route) => {
        if (route.request().method() === 'DELETE') {
            route.fulfill({ status: 204, body: '' });
        } else { route.continue(); }
    });
    await page.route('**/v1/me/allowed-senders', (route, request) => {
        if (request.method() === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            const entry = { prefid: prefidCounter++, sender: body.sender };
            allowedList = [...allowedList, entry];
            route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(entry) });
        } else {
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: MOCK_USER, list: allowedList }) });
        }
    });
    await page.route(/\/v1\/me\/allowed-senders\/\d+$/, (route) => {
        if (route.request().method() === 'DELETE') {
            route.fulfill({ status: 204, body: '' });
        } else { route.continue(); }
    });

    // v0.3.2 unified mail rules (blocks / redirects / copies via Sieve).
    let mailRules: { id: string; name: string; condition: { type: string; value: string; header?: string }; action: { type: string; to?: string } }[] = [];
    let ruleIdCounter = 1;
    await page.route('**/v1/me/mail-rules', (route, request) => {
        if (request.method() === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            const rule = {
                id: `r${ruleIdCounter++}`,
                name: body.name || 'rule',
                condition: body.condition,
                action: body.action
            };
            mailRules = [...mailRules, rule];
            route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(rule) });
        } else {
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: MOCK_USER, rules: mailRules }) });
        }
    });
    await page.route(/\/v1\/me\/mail-rules\/[^/]+$/, (route) => {
        if (route.request().method() === 'DELETE') {
            const m = route.request().url().match(/mail-rules\/([^/]+)$/);
            if (m) {
                const target = decodeURIComponent(m[1]);
                mailRules = mailRules.filter((r) => r.id !== target);
            }
            route.fulfill({ status: 204, body: '' });
        } else { route.continue(); }
    });

    // v0.3.1 recipient blocking via ManageSieve.
    let blockedRecipients: string[] = [];
    await page.route('**/v1/me/blocked-recipients', (route, request) => {
        if (request.method() === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            const recipient = String(body.recipient || '').toLowerCase();
            if (!blockedRecipients.includes(recipient)) blockedRecipients = [...blockedRecipients, recipient];
            route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ recipient }) });
        } else {
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: MOCK_USER, recipients: blockedRecipients }) });
        }
    });
    await page.route(/\/v1\/me\/blocked-recipients\/.+$/, (route) => {
        if (route.request().method() === 'DELETE') {
            const m = route.request().url().match(/blocked-recipients\/(.+)$/);
            if (m) {
                const target = decodeURIComponent(m[1]).toLowerCase();
                blockedRecipients = blockedRecipients.filter((r) => r !== target);
            }
            route.fulfill({ status: 204, body: '' });
        } else { route.continue(); }
    });

    // v0.4.1 CalDAV calendar (server normalises iCal into JSON).
    let calEvents: { uid: string; summary: string; description?: string; location?: string; dtstart: string; dtend: string }[] = [];
    let uidCounter = 1;
    await page.route('**/v1/me/calendars', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                user: MOCK_USER,
                calendars: [
                    { id: 'personal', displayName: 'Personal', color: '#1a73e8' },
                    { id: 'work', displayName: 'Work', color: '#a142f4' }
                ]
            })
        });
    });
    await page.route(/\/v1\/me\/calendars\/[^/]+\/events(\?.*)?$/, (route, request) => {
        const m = request.url().match(/calendars\/([^/]+)\/events/);
        const calendarId = m ? decodeURIComponent(m[1]) : 'personal';
        if (request.method() === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            const uid = `evt-${uidCounter++}@test`;
            calEvents.push({
                uid,
                summary: body.summary,
                description: body.description,
                location: body.location,
                dtstart: body.start,
                dtend: body.end
            });
            route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ uid, calendar: calendarId }) });
        } else {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ user: MOCK_USER, calendar: calendarId, events: calEvents })
            });
        }
    });
    await page.route(/\/v1\/me\/calendars\/[^/]+\/events\/[^/]+$/, (route, request) => {
        const m = request.url().match(/events\/([^/?]+)/);
        const uid = m ? decodeURIComponent(m[1]) : '';
        if (request.method() === 'DELETE') {
            calEvents = calEvents.filter((e) => e.uid !== uid);
            route.fulfill({ status: 204, body: '' });
        } else {
            const ev = calEvents.find((e) => e.uid === uid);
            if (ev) route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ev) });
            else route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ status: 404, title: 'Not Found' }) });
        }
    });

    // Calendar subscriptions (external ICS feeds)
    let subCounter = 1;
    const subStore: { id: string; name: string; url: string; color: string }[] = [];
    await page.route('**/v1/me/calendar-subscriptions', (route, request) => {
        if (request.method() === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            const sub = { id: `sub-${subCounter++}`, name: body.name, url: body.url, color: body.color || '#1a73e8' };
            subStore.push(sub);
            route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(sub) });
        } else {
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: MOCK_USER, subscriptions: subStore }) });
        }
    });
    await page.route(/\/v1\/me\/calendar-subscriptions\/[^/]+$/, (route, request) => {
        const m = request.url().match(/calendar-subscriptions\/([^/?]+)/);
        const id = m ? decodeURIComponent(m[1]) : '';
        if (request.method() === 'DELETE') {
            const idx = subStore.findIndex((s) => s.id === id);
            if (idx >= 0) subStore.splice(idx, 1);
            route.fulfill({ status: 204, body: '' });
        } else {
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: MOCK_USER, subscription: id, events: [] }) });
        }
    });

    await page.route('**/v1/ai/config', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                configured: true,
                kind: 'openai',
                baseUrl: 'http://localhost:11434/v1',
                model: 'mistral-small-latest',
                apiKey: 'sk-test'
            })
        });
    });

    await page.route('**/v1/ai/capabilities', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                configured: true,
                kind: 'openai',
                preset: 'mistral',
                model: 'mistral-small-latest',
                allowClientOverride: true,
                presets: ['mistral', 'openai', 'groq', 'together', 'ollama', 'perplexity', 'openrouter', 'anthropic']
            })
        });
    });

    await page.route('**/v1/ai/actions', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                content: '- [ ] Take a tour of the layout\n- [ ] Try the AI panel\n- [ ] Send feedback',
                model: 'mistral-small-latest'
            })
        });
    });

    await page.route('**/v1/ai/translate', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                content: '¡Hola!\n\nBienvenido a tu nuevo correo web. Este mensaje muestra el diseño.\n\nSaludos,\nEl Conserje',
                model: 'mistral-small-latest'
            })
        });
    });

    await page.route('**/v1/ai/sort-inbox', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                // Danger order: invoice (1000) critical → tracking (998) low → welcome (1001) low → lunch (999) low
                rankings: [
                    { uid: 1000, level: 4, reason: 'Invoice due soon — money at risk' },
                    { uid: 1001, level: 2, reason: 'Welcome message, non-urgent' },
                    { uid: 999, level: 2, reason: 'Casual lunch thread' },
                    { uid: 998, level: 1, reason: 'Tracking notification' }
                ],
                model: 'mistral-small-latest'
            })
        });
    });

    await page.route(/\/v1\/mailboxes(\?.*)?$/, (route, request) => {
        // Match GET /v1/mailboxes with or without ?counts=true.
        if (request.method() !== 'GET') return route.continue();
        const withCounts = request.url().includes('counts=true');
        const enriched = withCounts ? mailboxes.map((m, i) => ({
            ...m,
            totalMessages: i === 0 ? 4 : 0,
            unseen: i === 0 ? 1 : 0
        })) : mailboxes;
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(enriched)
        });
    });

    await page.route(/\/v1\/mailboxes\/INBOX\/messages(\?|$)/, (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                path: 'INBOX',
                page: 0,
                pageSize: 25,
                total: messages.length,
                messages
            })
        });
    });

    await page.route('**/v1/mailboxes/INBOX/messages/1001', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(detailFor1001)
        });
    });

    await page.route('**/v1/mailboxes/INBOX/messages/998', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(detailFor998)
        });
    });

    await page.route('**/v1/mailboxes/INBOX/messages/1000', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(detailFor1000)
        });
    });

    await page.route('**/v1/mailboxes/INBOX/messages/1000/attachments/2/text*', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'text/plain; charset=utf-8',
            body:
                'INVOICE — Q2 2026\n' +
                'Acme Billing Ltd.\n\n' +
                'Bill to: demo@test.local\n\n' +
                'Item 1 — Hosting (3 months)        $748.00\n' +
                'Item 2 — DNS / mail relay          $500.00\n\n' +
                'Total due:                        $1,248.00\n' +
                'Due date:                         2026-05-15\n'
        });
    });

    await page.route('**/v1/mailboxes/INBOX/messages/1001/flags', (route) => {
        const op = JSON.parse(route.request().postData() || '{}');
        const flags = ['\\Seen'];
        if (op.add) flags.push(...op.add);
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ uid: 1001, flags })
        });
    });

    await page.route('**/v1/messages/send', (route) => {
        route.fulfill({
            status: 501,
            contentType: 'application/problem+json',
            body: JSON.stringify({
                type: 'about:blank',
                title: 'Not Implemented',
                status: 501,
                detail: 'SMTP send is stubbed. Set SMTP_HOST/SMTP_USER/SMTP_PASS once the implementation lands.'
            })
        });
    });

    await page.route('**/v1/ai/summarize', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                content: '- Welcome message from the Concierge\n- Demonstrates the layout\n- Try the AI panel to summarize or draft replies',
                model: 'mistral-small-latest'
            })
        });
    });

    await page.route('**/v1/drive/config', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                enabled: true,
                endpoint: 'https://s3.mock.local',
                region: 'us-east-1',
                bucket: 'test-bucket',
                prefix: 'users/demo',
                publicUrl: '',
                credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }
            })
        });
    });

    // Mock S3 CORS preflight
    await page.route('https://s3.mock.local/**', (route, request) => {
        if (request.method() === 'OPTIONS') {
            route.fulfill({
                status: 204,
                headers: {
                    'access-control-allow-origin': '*',
                    'access-control-allow-methods': 'GET, PUT, DELETE, HEAD',
                    'access-control-allow-headers': 'authorization, x-amz-content-sha256, content-type, x-amz-date'
                }
            });
        } else {
            route.continue();
        }
    });

    // Mock S3 ListObjectsV2
    await page.route(/https:\/\/s3\.mock\.local\/test-bucket\?list-type=2/, (route, request) => {
        const url = new URL(request.url());
        const prefix = decodeURIComponent(url.searchParams.get('prefix') || '');
        if (prefix === 'users/demo/' || prefix === 'users%2Fdemo%2F') {
            route.fulfill({
                status: 200,
                contentType: 'application/xml',
                body:
                    '<?xml version="1.0" encoding="UTF-8"?>' +
                    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
                    '<Name>test-bucket</Name>' +
                    '<Prefix>users/demo/</Prefix>' +
                    '<Delimiter>/</Delimiter>' +
                    '<CommonPrefixes><Prefix>users/demo/Projects/</Prefix></CommonPrefixes>' +
                    '<CommonPrefixes><Prefix>users/demo/Photos/</Prefix></CommonPrefixes>' +
                    '<Contents>' +
                    '<Key>users/demo/report.pdf</Key>' +
                    '<LastModified>2026-04-28T10:00:00.000Z</LastModified>' +
                    '<ETag>"abc123"</ETag>' +
                    '<Size>84200</Size>' +
                    '</Contents>' +
                    '<Contents>' +
                    '<Key>users/demo/notes.txt</Key>' +
                    '<LastModified>2026-04-27T08:30:00.000Z</LastModified>' +
                    '<ETag>"def456"</ETag>' +
                    '<Size>1240</Size>' +
                    '</Contents>' +
                    '<Contents>' +
                    '<Key>users/demo/readme.md</Key>' +
                    '<LastModified>2026-04-26T09:00:00.000Z</LastModified>' +
                    '<ETag>"jkl012"</ETag>' +
                    '<Size>2100</Size>' +
                    '</Contents>' +
                    '</ListBucketResult>'
            });
        } else if (prefix === 'users/demo/Projects/' || prefix === 'users%2Fdemo%2FProjects%2F') {
            route.fulfill({
                status: 200,
                contentType: 'application/xml',
                body:
                    '<?xml version="1.0" encoding="UTF-8"?>' +
                    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
                    '<Name>test-bucket</Name>' +
                    '<Prefix>users/demo/Projects/</Prefix>' +
                    '<Delimiter>/</Delimiter>' +
                    '<Contents>' +
                    '<Key>users/demo/Projects/plan.md</Key>' +
                    '<LastModified>2026-04-25T14:00:00.000Z</LastModified>' +
                    '<ETag>"ghi789"</ETag>' +
                    '<Size>3500</Size>' +
                    '</Contents>' +
                    '</ListBucketResult>'
            });
        } else {
            route.fulfill({
                status: 200,
                contentType: 'application/xml',
                body:
                    '<?xml version="1.0" encoding="UTF-8"?>' +
                    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
                    '<Name>test-bucket</Name>' +
                    '<Prefix>' + prefix + '</Prefix>' +
                    '<Delimiter>/</Delimiter>' +
                    '</ListBucketResult>'
            });
        }
    });

    await page.route(/https:\/\/s3\.mock\.local\/test-bucket\/users\/demo\/.*/, (route) => {
        if (route.request().method() === 'PUT') {
            route.fulfill({ status: 200, headers: { 'ETag': '"newetag"' } });
        } else if (route.request().method() === 'DELETE') {
            route.fulfill({ status: 204 });
        } else {
            const url = route.request().url();
            if (url.includes('readme.md')) {
                route.fulfill({ status: 200, contentType: 'text/markdown', body: '# README\n\nThis is a **mock** markdown file for testing.\n\n## Features\n\n- Bullet one\n- Bullet two\n\n> A blockquote for good measure.\n\n`inline code` and a [link](https://example.com)' });
            } else if (url.includes('notes.txt')) {
                route.fulfill({ status: 200, contentType: 'text/plain', body: 'Hello world\nThis is a plain text file.\nLine three.' });
            } else if (url.includes('plan.md')) {
                route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Project Plan\n\n1. First item\n2. Second item\n\n```js\nconst x = 1;\n```' });
            } else {
                route.fulfill({ status: 200, body: 'mock file content' });
            }
        }
    });

    await page.route('**/v1/drive/quota', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ used: 124_000, total: 5_368_709_120 })
        });
    });

    await page.route('**/v1/ai/tts-config', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ configured: true, apiKey: 'sk-fake-elevenlabs' })
        });
    });

    await page.route('**/v1/ai/phishing-scan', (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        const isPhishing = (body.subject || '').toLowerCase().includes('invoice');
        // Verify that headers are being sent in phishing-scan requests
        const hasHeaders = !!(body.headers && body.headers.includes('From:'));
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                isPhishing,
                confidence: isPhishing ? 87 : 12,
                reasoning: isPhishing ? (hasHeaders ? 'Headers confirm suspicious sender patterns.' : 'This invoice email contains suspicious urgency tactics.') : 'No phishing indicators detected.',
                indicators: isPhishing ? ['Urgency tactic: payment due by specific date', 'Requests money transfer'] : [],
                model: 'stepfun/step-3.5-flash'
            })
        });
    });


    // Hidden AI Conversations folder mocks
    const aiConversationThread = {
        id: 'imap-thread-001',
        title: 'Synced from IMAP',
        createdAt: Date.now() - 3600_000,
        updatedAt: Date.now() - 1800_000,
        messages: [
            { role: 'user' as const, content: 'Hello from another device' },
            { role: 'assistant' as const, content: 'Hi there! I can see this thread was synced via IMAP.' }
        ]
    };

    await page.route('**/v1/mailboxes/.AI%20Conversations/messages*', (route, request) => {
        if (request.method() === 'POST') {
            route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ path: '.AI Conversations', uid: 5001, uidValidity: 1 })
            });
        } else {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    path: '.AI Conversations',
                    page: 0,
                    pageSize: 100,
                    total: 1,
                    messages: [
                        {
                            uid: 5000,
                            seq: 1,
                            flags: ['\\\\Seen'],
                            size: 512,
                            internalDate: new Date(aiConversationThread.updatedAt).toISOString(),
                            envelope: {
                                date: new Date(aiConversationThread.updatedAt).toISOString(),
                                subject: aiConversationThread.title,
                                from: [{ name: 'AI Assistant', address: 'ai@webmail.local' }],
                                to: [{ name: null, address: MOCK_USER }],
                                cc: [],
                                messageId: '<imap-thread-001@ai.webmail.local>',
                                inReplyTo: null
                            }
                        }
                    ]
                })
            });
        }
    });

    await page.route('**/v1/mailboxes/.AI%20Conversations/messages/5000', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                uid: 5000,
                seq: 1,
                flags: ['\\\\Seen'],
                size: 512,
                internalDate: new Date(aiConversationThread.updatedAt).toISOString(),
                envelope: {
                    date: new Date(aiConversationThread.updatedAt).toISOString(),
                    subject: aiConversationThread.title,
                    from: [{ name: 'AI Assistant', address: 'ai@webmail.local' }],
                    to: [{ name: null, address: MOCK_USER }],
                    cc: [],
                    messageId: '<imap-thread-001@ai.webmail.local>',
                    inReplyTo: null
                },
                text: JSON.stringify(aiConversationThread),
                html: null,
                attachments: []
            })
        });
    });

    await page.route('**/v1/ai/draft-reply', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                content:
                    'Hi Concierge,\n\nThanks for the warm welcome — the layout looks great. I\'ll take a tour and send any feedback your way.\n\nBest,\n' +
                    MOCK_USER.split('@')[0],
                model: 'mistral-small-latest'
            })
        });
    });
}

export async function login(page: Page) {
    await page.goto('/webmail/');
    await page.fill('[data-testid=login-user]', MOCK_USER);
    await page.fill('[data-testid=login-pass]', MOCK_PASS);
    await page.click('[data-testid=login-submit]');
    await page.waitForSelector('[data-testid=shell]');
}
