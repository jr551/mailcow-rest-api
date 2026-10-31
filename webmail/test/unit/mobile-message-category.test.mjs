import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { categoryStorageKey } from '../../src/lib/message-categories.ts';
import { mobileRowCategory } from '../../src/lib/mobile-message-category.ts';

describe('mobile message category (slice 32)', () => {
    it('uses the row mailbox when present (all-folder search)', () => {
        const sentKey = categoryStorageKey('Sent', 9);
        const overlay = { [sentKey]: 'orange' };
        const fromInbox = mobileRowCategory('INBOX', { uid: 9, flags: [] }, overlay);
        assert.equal(fromInbox, null);
        const fromSent = mobileRowCategory(
            'INBOX',
            { uid: 9, flags: [], mailbox: 'Sent' },
            overlay
        );
        assert.equal(fromSent, 'orange');
    });
});
