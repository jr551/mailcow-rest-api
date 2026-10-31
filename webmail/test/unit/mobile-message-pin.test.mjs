import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors helpers in `mobile-message-pin.ts` / `message-pin-snooze.ts` for Node tests. */
function messageOverlayKey(mailboxPath, uid) {
    return `${mailboxPath}\u0000${uid}`;
}

function mobileRowMailboxPath(selectedPath, msg) {
    return msg.mailbox ?? selectedPath;
}

function mobileRowIsPinned(overlay, selectedPath, msg) {
    const key = messageOverlayKey(mobileRowMailboxPath(selectedPath, msg), msg.uid);
    return overlay.pinned[key] === true;
}

function mobilePinActionLabel(pinned) {
    return pinned ? 'Unpin' : 'Pin to top';
}

describe('mobile message pin (slice 34)', () => {
    it('resolves mailbox path for all-folder search rows', () => {
        assert.equal(mobileRowMailboxPath('INBOX', { uid: 1 }), 'INBOX');
        assert.equal(mobileRowMailboxPath('INBOX', { uid: 1, mailbox: 'Sent' }), 'Sent');
    });

    it('reads pin state from the row mailbox overlay key', () => {
        const sentKey = messageOverlayKey('Sent', 9);
        const overlay = { pinned: { [sentKey]: true }, snoozeUntil: {} };
        assert.equal(
            mobileRowIsPinned(overlay, 'INBOX', { uid: 9, mailbox: 'Sent' }),
            true
        );
        assert.equal(mobileRowIsPinned(overlay, 'INBOX', { uid: 9 }), false);
    });

    it('labels pin toggle actions', () => {
        assert.equal(mobilePinActionLabel(false), 'Pin to top');
        assert.equal(mobilePinActionLabel(true), 'Unpin');
    });
});
