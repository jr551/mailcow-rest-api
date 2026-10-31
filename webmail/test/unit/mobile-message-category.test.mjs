import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { categoryStorageKey, resolveMessageCategory } from '../../src/lib/message-categories.ts';

/** Mirrors `mobileRowCategory` in mobile-message-category.ts for unit tests. */
function mobileRowCategory(selectedPath, msg, overlay) {
    const path = msg.mailbox ?? selectedPath;
    return resolveMessageCategory(path, msg.uid, msg.flags, overlay);
}

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
