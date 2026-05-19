'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod/v4');

const { RestClient } = require('./client');

function loadConfig() {
    const baseUrl = process.env.IMAP_REST_BASE_URL || 'http://127.0.0.1:3001';
    const user = process.env.IMAP_REST_USER;
    const pass = process.env.IMAP_REST_PASS;
    if (!user || !pass) {
        throw new Error('IMAP_REST_USER and IMAP_REST_PASS must be set in the environment');
    }
    const timeoutMs = Number(process.env.IMAP_REST_TIMEOUT_MS) || 90_000;
    return { baseUrl, user, pass, timeoutMs };
}

function ok(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: 'text', text }] };
}

function fail(err) {
    const status = err && err.status;
    const method = err && err.method;
    const path = err && err.path;
    const message = (err && err.message) ? err.message : String(err);
    let text;
    if (status && method && path) {
        text = `${method} ${path} → ${status}: ${message}`;
    } else if (status) {
        text = `HTTP ${status}: ${message}`;
    } else {
        text = message;
    }
    return { isError: true, content: [{ type: 'text', text }] };
}

function wrap(fn) {
    return async (...args) => {
        try {
            const result = await fn(...args);
            return ok(result);
        } catch (err) {
            return fail(err);
        }
    };
}

function buildServer({ client }) {
    const server = new McpServer({
        name: 'mailcow-rest-api',
        version: require('../../package.json').version
    });

    server.registerTool('list_mailboxes', {
        description: 'List all IMAP mailboxes (folders) for the configured user.',
        inputSchema: {}
    }, wrap(async () => client.listMailboxes()));

    server.registerTool('create_mailbox', {
        description: 'Create a new IMAP mailbox at the given hierarchical path (e.g. "Archive/2026").',
        inputSchema: {
            path: z.string().describe('Hierarchical mailbox path')
        }
    }, wrap(async ({ path }) => client.createMailbox(path)));

    server.registerTool('rename_mailbox', {
        description: 'Rename an existing IMAP mailbox.',
        inputSchema: {
            path: z.string().describe('Current mailbox path'),
            newPath: z.string().describe('New mailbox path')
        }
    }, wrap(async ({ path, newPath }) => client.renameMailbox(path, newPath)));

    server.registerTool('delete_mailbox', {
        description: 'Delete an IMAP mailbox. Fails if the mailbox is not empty on some servers.',
        inputSchema: {
            path: z.string().describe('Mailbox path to delete')
        }
    }, wrap(async ({ path }) => client.deleteMailbox(path)));

    server.registerTool('list_messages', {
        description: 'List messages in a mailbox, paginated, optionally filtered by a free-text search across subject/from/body.',
        inputSchema: {
            path: z.string().describe('Mailbox path'),
            page: z.number().int().min(0).optional().describe('Page index (0-based, default 0)'),
            pageSize: z.number().int().min(1).max(100).optional().describe('Items per page (default 20, max 100)'),
            search: z.string().optional().describe('Free-text search query')
        }
    }, wrap(async ({ path, page, pageSize, search }) =>
        client.listMessages(path, { page, pageSize, search })
    ));

    server.registerTool('get_message', {
        description: 'Fetch a single message including envelope, flags, and inline text/HTML body parts.',
        inputSchema: {
            path: z.string().describe('Mailbox path'),
            uid: z.number().int().describe('IMAP UID of the message')
        }
    }, wrap(async ({ path, uid }) => client.getMessage(path, uid)));

    server.registerTool('get_raw_message', {
        description: 'Fetch the raw RFC822 source of a message (full headers + body).',
        inputSchema: {
            path: z.string().describe('Mailbox path'),
            uid: z.number().int().describe('IMAP UID of the message')
        }
    }, wrap(async ({ path, uid }) => client.getRawMessage(path, uid)));

    server.registerTool('download_attachment', {
        description: 'Download an attachment from a message. Returns base64-encoded content plus metadata (filename, content-type, size).',
        inputSchema: {
            path: z.string().describe('Mailbox path'),
            uid: z.number().int().describe('IMAP UID of the message'),
            attachmentId: z.string().describe('Attachment ID from the message bodyStructure')
        }
    }, wrap(async ({ path, uid, attachmentId }) => client.downloadAttachment(path, uid, attachmentId)));

    server.registerTool('ocr_attachment', {
        description: 'Run Mistral OCR on an attachment and return the extracted text. Requires MISTRAL_API_KEY on the REST server. Returns plain text by default, or the full structured Mistral response when format="json".',
        inputSchema: {
            path: z.string().describe('Mailbox path'),
            uid: z.number().int().describe('IMAP UID of the message'),
            attachmentId: z.string().describe('Attachment ID from the message bodyStructure'),
            format: z.enum(['text', 'json']).optional().describe('"text" (default) or "json" for full Mistral response')
        }
    }, wrap(async ({ path, uid, attachmentId, format }) =>
        client.ocrAttachment(path, uid, attachmentId, { format: format || 'text' })
    ));

    server.registerTool('flag_message', {
        description: 'Add, remove, or set IMAP flags on a message (\\Seen, \\Flagged, \\Answered, \\Deleted, etc).',
        inputSchema: {
            path: z.string().describe('Mailbox path'),
            uid: z.number().int().describe('IMAP UID'),
            add: z.array(z.string()).optional().describe('Flags to add'),
            remove: z.array(z.string()).optional().describe('Flags to remove'),
            set: z.array(z.string()).optional().describe('Flags to set (replaces existing)')
        }
    }, wrap(async ({ path, uid, add, remove, set }) => {
        const ops = {};
        if (add) ops.add = add;
        if (remove) ops.remove = remove;
        if (set) ops.set = set;
        return client.flagMessage(path, uid, ops);
    }));

    server.registerTool('move_message', {
        description: 'Move a message to another mailbox.',
        inputSchema: {
            path: z.string().describe('Source mailbox path'),
            uid: z.number().int().describe('IMAP UID'),
            destination: z.string().describe('Destination mailbox path')
        }
    }, wrap(async ({ path, uid, destination }) =>
        client.moveMessage(path, uid, destination)
    ));

    server.registerTool('delete_message', {
        description: 'Permanently delete a message. Some IMAP servers move it to Trash instead of expunging.',
        inputSchema: {
            path: z.string().describe('Mailbox path'),
            uid: z.number().int().describe('IMAP UID')
        }
    }, wrap(async ({ path, uid }) => {
        await client.deleteMessage(path, uid);
        return { deleted: true, uid, path };
    }));

    server.registerTool('list_blocked_senders', {
        description: 'List senders blocked by the authenticated user. Requires mailcow DB to be configured on the REST server.',
        inputSchema: {}
    }, wrap(async () => client.listBlockedSenders()));

    server.registerTool('block_sender', {
        description: 'Add a sender to the user\'s blocklist. Wildcards like *@domain.tld are supported. Requires mailcow DB to be configured on the REST server.',
        inputSchema: {
            sender: z.string().describe('Email address or pattern to block (e.g. spammer@example.com or *@example.com)')
        }
    }, wrap(async ({ sender }) => client.blockSender(sender)));

    server.registerTool('unblock_sender', {
        description: 'Remove a sender from the user\'s blocklist by prefid.',
        inputSchema: {
            prefid: z.number().int().describe('The prefid of the blocked sender entry')
        }
    }, wrap(async ({ prefid }) => {
        await client.unblockSender(prefid);
        return { unblocked: true, prefid };
    }));

    server.registerTool('list_allowed_senders', {
        description: 'List senders explicitly allowed (whitelisted) by the authenticated user. Requires mailcow DB to be configured on the REST server.',
        inputSchema: {}
    }, wrap(async () => client.listAllowedSenders()));

    server.registerTool('allow_sender', {
        description: 'Add a sender to the user\'s allowlist (whitelist). Wildcards like *@domain.tld are supported. Requires mailcow DB to be configured on the REST server.',
        inputSchema: {
            sender: z.string().describe('Email address or pattern to allow (e.g. important@example.com or *@example.com)')
        }
    }, wrap(async ({ sender }) => client.allowSender(sender)));

    server.registerTool('unallow_sender', {
        description: 'Remove a sender from the user\'s allowlist by prefid.',
        inputSchema: {
            prefid: z.number().int().describe('The prefid of the allowed sender entry')
        }
    }, wrap(async ({ prefid }) => {
        await client.unallowSender(prefid);
        return { unallowed: true, prefid };
    }));

    server.registerTool('get_mailbox', {
        description: 'Get mailbox stats: quota, usage, message count, name, domain, auth source, etc. Requires mailcow DB to be configured on the REST server.',
        inputSchema: {}
    }, wrap(async () => client.getMailbox()));

    server.registerTool('get_logins', {
        description: 'Get recent SASL login history (imap, smtp, pop3, sso). Requires mailcow DB to be configured.',
        inputSchema: {
            limit: z.number().int().min(1).max(100).optional().describe('Number of recent logins to return (default 20, max 100)')
        }
    }, wrap(async ({ limit }) => client.getLogins(limit)));

    server.registerTool('get_aliases', {
        description: 'List aliases that forward to this mailbox. Requires mailcow DB to be configured.',
        inputSchema: {}
    }, wrap(async () => client.getAliases()));

    server.registerTool('get_temp_aliases', {
        description: 'List active time-limited (disposable) aliases for this mailbox. Requires mailcow DB to be configured.',
        inputSchema: {}
    }, wrap(async () => client.getTempAliases()));

    server.registerTool('create_temp_alias', {
        description: 'Create a random time-limited alias for this mailbox. Emails sent to the alias are forwarded to the mailbox. Requires mailcow DB to be configured.',
        inputSchema: {
            description: z.string().optional().describe('Optional description/note for the alias'),
            validityHours: z.number().int().min(1).max(87600).optional().describe('How many hours the alias remains active (default 720 = 30 days, max 87600)'),
            permanent: z.boolean().optional().describe('If true, the alias never expires (default false)')
        }
    }, wrap(async ({ description, validityHours, permanent }) =>
        client.createTempAlias({ description, validityHours, permanent })
    ));

    server.registerTool('delete_temp_alias', {
        description: 'Delete a time-limited alias by its address.',
        inputSchema: {
            address: z.string().describe('The full alias address to delete (e.g. abc123@domain.tld)')
        }
    }, wrap(async ({ address }) => {
        await client.deleteTempAlias(address);
        return { deleted: true, address };
    }));

    server.registerTool('get_send_from_addresses', {
        description: 'Get all addresses this user can send from: their own email, aliases, and temp aliases. Useful for populating a "From" dropdown. Requires mailcow DB to be configured.',
        inputSchema: {}
    }, wrap(async () => client.getSendFromAddresses()));

    server.registerTool('list_blocked_recipients', {
        description: 'List recipient (To) addresses the user has blocked via Sieve. Only addresses the user actually receives mail for can be blocked. Requires ManageSieve (Dovecot port 4190).',
        inputSchema: {}
    }, wrap(async () => client.listBlockedRecipients()));

    server.registerTool('block_recipient', {
        description: 'Block a recipient (To) address via Sieve filter. Emails sent to this address will be discarded. You must actually receive mail at this address (mailbox, alias, or catch-all). Requires ManageSieve.',
        inputSchema: {
            recipient: z.string().describe('The recipient email address to block (e.g. spammer@yourdomain.com)')
        }
    }, wrap(async ({ recipient }) => client.blockRecipient(recipient)));

    server.registerTool('unblock_recipient', {
        description: 'Unblock a previously blocked recipient (To) address.',
        inputSchema: {
            recipient: z.string().describe('The recipient email address to unblock')
        }
    }, wrap(async ({ recipient }) => {
        await client.unblockRecipient(recipient);
        return { unblocked: true, recipient };
    }));

    server.registerTool('list_mail_rules', {
        description: 'List all mail rules for the user: blocks, redirects, and copies. These are Sieve rules managed via ManageSieve.',
        inputSchema: {}
    }, wrap(async () => client.listMailRules()));

    server.registerTool('add_mail_rule', {
        description: 'Add a mail rule (block, redirect, or copy). For "redirect" the original email is forwarded and not kept. For "copy" the email is forwarded AND kept in the inbox. Requires ManageSieve.',
        inputSchema: {
            name: z.string().describe('Human-readable name for the rule, e.g. "PagerDuty to Bot"'),
            condition: z.object({
                type: z.enum(['envelope-to-is', 'header-contains', 'header-is', 'from-contains', 'to-contains', 'subject-contains']).describe('What to match against'),
                header: z.string().optional().describe('Header name (required for header-contains and header-is)'),
                value: z.string().describe('Value to match')
            }).describe('Condition that triggers the rule'),
            action: z.object({
                type: z.enum(['discard', 'redirect', 'copy']).describe('discard = block/delete, redirect = forward and dont keep, copy = forward and keep'),
                to: z.string().optional().describe('Destination email address (required for redirect and copy)')
            }).describe('Action to take when condition matches')
        }
    }, wrap(async ({ name, condition, action }) => client.addMailRule({ name, condition, action })));

    server.registerTool('remove_mail_rule', {
        description: 'Remove a mail rule by its ID.',
        inputSchema: {
            id: z.string().describe('The rule ID to remove')
        }
    }, wrap(async ({ id }) => {
        await client.removeMailRule(id);
        return { removed: true, id };
    }));

    server.registerTool('list_calendars', {
        description: 'List all CalDAV calendars for the configured user. Requires SOGO_URL to be configured on the REST server.',
        inputSchema: {}
    }, wrap(async () => client.listCalendars()));

    server.registerTool('list_events', {
        description: 'List events in a calendar within a date range. Requires SOGO_URL to be configured on the REST server.',
        inputSchema: {
            calendar: z.string().describe('Calendar ID (e.g. "personal")'),
            start: z.string().describe('ISO 8601 start datetime (e.g. "2026-05-01T00:00:00Z")'),
            end: z.string().describe('ISO 8601 end datetime (e.g. "2026-05-31T23:59:59Z")')
        }
    }, wrap(async ({ calendar, start, end }) => client.listEvents(calendar, start, end)));

    server.registerTool('get_event', {
        description: 'Get a single calendar event by UID. Requires SOGO_URL to be configured on the REST server.',
        inputSchema: {
            calendar: z.string().describe('Calendar ID'),
            uid: z.string().describe('Event UID')
        }
    }, wrap(async ({ calendar, uid }) => client.getEvent(calendar, uid)));

    server.registerTool('create_event', {
        description: 'Create a calendar event. Requires SOGO_URL to be configured on the REST server.',
        inputSchema: {
            calendar: z.string().describe('Calendar ID to create the event in (e.g. "personal")'),
            summary: z.string().describe('Event title/summary'),
            start: z.string().describe('ISO 8601 start datetime'),
            end: z.string().describe('ISO 8601 end datetime'),
            description: z.string().optional().describe('Optional event description'),
            location: z.string().optional().describe('Optional event location')
        }
    }, wrap(async ({ calendar, summary, start, end, description, location }) =>
        client.createEvent(calendar, { summary, start, end, description, location })
    ));

    server.registerTool('delete_event', {
        description: 'Delete a calendar event by UID. Requires SOGO_URL to be configured on the REST server.',
        inputSchema: {
            calendar: z.string().describe('Calendar ID'),
            uid: z.string().describe('Event UID to delete')
        }
    }, wrap(async ({ calendar, uid }) => {
        await client.deleteEvent(calendar, uid);
        return { deleted: true, calendar, uid };
    }));

    server.registerTool('send_message', {
        description: 'Send an email via SMTP. Requires SMTP_HOST to be configured on the REST server. Uses the user\'s IMAP credentials for SMTP AUTH. When called via MCP (Basic Auth), the email is held pending and an approval link is emailed to the user\'s inbox. The user must click the link before the message is actually dispatched.',
        inputSchema: {
            to: z.array(z.string()).describe('Recipient email addresses'),
            subject: z.string().describe('Email subject'),
            text: z.string().describe('Plain text body'),
            cc: z.array(z.string()).optional().describe('CC email addresses'),
            bcc: z.array(z.string()).optional().describe('BCC email addresses'),
            from: z.string().optional().describe('From address (must be an address you own; defaults to your email)'),
            html: z.string().optional().describe('HTML body (optional)'),
            inReplyTo: z.string().optional().describe('Message-ID of the message being replied to'),
            attachments: z.array(z.object({
                filename: z.string().describe('Filename of the attachment'),
                contentType: z.string().optional().describe('MIME content type (e.g. "application/pdf")'),
                content: z.string().describe('Base64-encoded file content')
            })).optional().describe('Files to attach (max 20, total ~18 MB)')
        }
    }, wrap(async ({ to, subject, text, cc, bcc, from, html, inReplyTo, attachments }) =>
        client.sendMessage({ to, subject, text, cc, bcc, from, html, inReplyTo, attachments })
    ));

    server.registerTool('check_delivery_status', {
        description: 'Check delivery status of a sent email by its Message-ID. Scans INBOX for bounce/DSN messages. Returns pending, delivered, failed, or delayed.',
        inputSchema: {
            messageId: z.string().describe('The Message-ID returned by send_message (e.g. "<uuid@domain>")')
        }
    }, wrap(async ({ messageId }) => client.checkDeliveryStatus(messageId)));

    return server;
}

async function main() {
    const config = loadConfig();
    const client = new RestClient(config);
    const server = buildServer({ client });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Server runs until stdin closes; SDK handles signals.
}

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(`imap-rest-mcp failed to start: ${err.message}\n`);
        process.exit(1);
    });
}

module.exports = { buildServer, loadConfig, RestClient, main };
