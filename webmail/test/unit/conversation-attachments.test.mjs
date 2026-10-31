import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    conversationAttachmentHint,
    conversationAttachmentEntries,
    summarizeAttachmentFilenames
} from '../../src/lib/conversation-attachments.ts';

describe('conversation attachments (slice 30)', () => {
    it('summarizeAttachmentFilenames prefers real filenames', () => {
        assert.equal(
            summarizeAttachmentFilenames([
                { id: '1', filename: 'menu.pdf', contentType: 'application/pdf', size: 1, disposition: 'attachment', related: false }
            ]),
            'menu.pdf'
        );
        assert.equal(
            summarizeAttachmentFilenames([
                { id: '1', filename: 'a.pdf', contentType: 'application/pdf', size: 1, disposition: 'attachment', related: false },
                { id: '2', filename: 'b.png', contentType: 'image/png', size: 1, disposition: 'attachment', related: false }
            ]),
            'a.pdf +1'
        );
    });

    it('conversationAttachmentHint uses detail filenames when loaded', () => {
        const hint = conversationAttachmentHint(
            { uid: 1, seq: 1, flags: [], size: 1, internalDate: null, envelope: { date: null, subject: 's', from: [], to: [], cc: [], messageId: null, inReplyTo: null }, hasAttachments: true },
            {
                uid: 1,
                seq: 1,
                flags: [],
                size: 1,
                internalDate: null,
                envelope: { date: null, subject: 's', from: [], to: [], cc: [], messageId: null, inReplyTo: null },
                text: 'hi',
                html: null,
                attachments: [
                    { id: '1', filename: 'menu.pdf', contentType: 'application/pdf', size: 1, disposition: 'attachment', related: false }
                ]
            }
        );
        assert.equal(hint, 'menu.pdf');
    });

    it('conversationAttachmentEntries falls back to list metadata', () => {
        const entries = conversationAttachmentEntries({
            uid: 2,
            seq: 1,
            flags: [],
            size: 1,
            internalDate: null,
            envelope: { date: null, subject: 's', from: [], to: [], cc: [], messageId: null, inReplyTo: null },
            hasAttachments: true,
            attachmentCount: 2
        });
        assert.equal(entries.length, 2);
        assert.equal(entries[0].filename, 'Attachment 1');
    });
});
