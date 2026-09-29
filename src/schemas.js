'use strict';

// Shared JSON schemas used by route options. Fastify both validates requests
// and generates the OpenAPI document from these.

const addressSchema = {
    type: 'object',
    properties: {
        name: { type: 'string' },
        address: { type: 'string', format: 'email' }
    },
    required: ['address']
};

const envelopeSchema = {
    type: 'object',
    properties: {
        date: { type: ['string', 'null'] },
        subject: { type: ['string', 'null'] },
        from: { type: 'array', items: addressSchema },
        sender: { type: 'array', items: addressSchema },
        replyTo: { type: 'array', items: addressSchema },
        to: { type: 'array', items: addressSchema },
        cc: { type: 'array', items: addressSchema },
        bcc: { type: 'array', items: addressSchema },
        messageId: { type: ['string', 'null'] },
        inReplyTo: { type: ['string', 'null'] }
    }
};

const mailboxSchema = {
    type: 'object',
    properties: {
        path: { type: 'string' },
        name: { type: 'string' },
        delimiter: { type: 'string' },
        flags: { type: 'array', items: { type: 'string' } },
        specialUse: { type: ['string', 'null'] },
        subscribed: { type: 'boolean' },
        // Optional — populated only when GET /v1/mailboxes?counts=true
        totalMessages: { type: ['integer', 'null'] },
        unseen: { type: ['integer', 'null'] }
    },
    required: ['path', 'name']
};

const messageListItemSchema = {
    type: 'object',
    properties: {
        uid: { type: 'integer' },
        seq: { type: 'integer' },
        flags: { type: 'array', items: { type: 'string' } },
        size: { type: 'integer' },
        internalDate: { type: ['string', 'null'] },
        envelope: envelopeSchema,
        // Lets the webmail's Attachment filter work without an extra
        // round-trip per message. Computed by walking the IMAP
        // bodyStructure server-side.
        hasAttachments: { type: 'boolean' },
        attachmentCount: { type: 'integer' },
        // Same parsed auth verdicts as messageDetail, so the inbox
        // list can render a per-row padlock / skull badge without
        // forcing the user to open each message.
        auth: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
                spf:   { type: ['string', 'null'] },
                dkim:  { type: ['string', 'null'] },
                dmarc: { type: ['string', 'null'] }
            }
        }
    }
};

const attachmentRefSchema = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        filename: { type: ['string', 'null'] },
        contentType: { type: ['string', 'null'] },
        size: { type: ['integer', 'null'] },
        disposition: { type: ['string', 'null'] },
        related: { type: 'boolean' }
    },
    required: ['id']
};

// Parsed Authentication-Results — three independent verdicts. Each is
// pass | fail | softfail | neutral | none | temperror | permerror, mapped
// from the raw header tokens. `null` means the receiving MTA didn't run
// that check (or didn't surface it in the headers we read).
const authResultsSchema = {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: {
        spf:   { type: ['string', 'null'] },
        dkim:  { type: ['string', 'null'] },
        dmarc: { type: ['string', 'null'] },
        /** Verbatim Authentication-Results header(s) so the AI scanner
         *  and the user-facing tooltip have something to quote. */
        raw:   { type: ['string', 'null'] }
    }
};

const messageDetailSchema = {
    type: 'object',
    properties: {
        uid: { type: 'integer' },
        seq: { type: 'integer' },
        flags: { type: 'array', items: { type: 'string' } },
        size: { type: 'integer' },
        internalDate: { type: ['string', 'null'] },
        envelope: envelopeSchema,
        text: { type: ['string', 'null'] },
        html: { type: ['string', 'null'] },
        attachments: { type: 'array', items: attachmentRefSchema },
        auth: authResultsSchema
    }
};

const flagsOpSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
        set: { type: 'array', items: { type: 'string' } }
    }
};

const moveOpSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string' } }
};

const createMailboxSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    // Bounded so an unbounded string can't be assembled into a multi-MB
    // IMAP command line.
    properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } }
};

const renameMailboxSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['newPath'],
    properties: { newPath: { type: 'string', minLength: 1, maxLength: 1024 } }
};

const listMessagesQuerySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        page: { type: 'integer', minimum: 0, default: 0 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        search: { type: 'string' }
    }
};

// Bulk delete. `uids` is the exact set to expunge; `sender` is the
// rspamd `blacklist_from` pattern whose matches should be found server-side
// instead. Exactly one of the two must be supplied, and the two are
// mutually exclusive because a caller that supplies both has two different
// ideas of what it wants gone and silently taking one of them is how mail
// gets deleted that the user meant to keep.
//
// `uids` is capped at 1000: the IMAP UID EXPUNGE is a single command over
// a mailbox, and a mailbox that large is better paged by the client than
// deleted blind in one request that can time out halfway with no report.
const bulkDeleteMessagesBodySchema = {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
        uids: {
            type: 'array',
            maxItems: 1000,
            items: { type: 'integer', minimum: 1 }
        },
        sender: { type: 'string', minLength: 3, maxLength: 320 },
        // Count only — run the search, expunge nothing.
        //
        // This exists because the confirmation the user reads MUST name a
        // count, and the only honest way to know it is to run the same
        // search the delete runs. Asking the delete itself for the count
        // would expunge before the user has confirmed, which is the one
        // thing a destructive action must never do.
        dryRun: { type: 'boolean', default: false }
    }
};

const problemSchema = {
    type: 'object',
    properties: {
        type: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'integer' },
        detail: { type: 'string' }
    }
};

module.exports = {
    mailboxSchema,
    messageListItemSchema,
    messageDetailSchema,
    flagsOpSchema,
    moveOpSchema,
    createMailboxSchema,
    renameMailboxSchema,
    listMessagesQuerySchema,
    problemSchema,
    bulkDeleteMessagesBodySchema
};
