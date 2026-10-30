import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    filterOutSnoozedMessages,
    isMessagePinned,
    isMessageSnoozed,
    messageOverlayKey,
    snoozeUntilForPreset,
    sortWithPinnedFirst,
    emptyPinSnoozeOverlay
} from '../../src/lib/message-pin-snooze.ts';

const path = 'INBOX';

function msg(uid) {
    return {
        uid,
        seq: uid,
        flags: ['\\Seen'],
        size: 100,
        internalDate: new Date(2026, 0, uid).toISOString(),
        envelope: { subject: `m${uid}`, from: [{ name: 'A', address: 'a@example.com' }], to: [], date: '' }
    };
}

describe('message pin / snooze (slice 9)', () => {
    it('pins sort above the chosen list order', () => {
        const overlay = emptyPinSnoozeOverlay();
        const key = messageOverlayKey(path, 1002);
        overlay.pinned[key] = true;
        const list = [msg(1001), msg(1002), msg(1003)];
        const sorted = sortWithPinnedFirst(list, path, overlay, 'date-desc');
        assert.equal(sorted[0].uid, 1002);
    });

    it('hides snoozed messages until the wake time', () => {
        const overlay = emptyPinSnoozeOverlay();
        const now = Date.parse('2026-06-01T12:00:00');
        overlay.snoozeUntil[messageOverlayKey(path, 1001)] = now + 60_000;
        assert.ok(isMessageSnoozed(overlay, path, 1001, now));
        assert.ok(!isMessageSnoozed(overlay, path, 1001, now + 120_000));
        const visible = filterOutSnoozedMessages([msg(1001), msg(1002)], path, overlay, now);
        assert.deepEqual(visible.map((m) => m.uid), [1002]);
    });

    it('snooze presets land in the future', () => {
        const now = Date.parse('2026-06-01T10:00:00');
        assert.ok(snoozeUntilForPreset('later-today', now) > now);
        assert.ok(snoozeUntilForPreset('tomorrow', now) > now);
        assert.ok(snoozeUntilForPreset('next-week', now) > now);
    });

    it('toggle pin state is keyed by mailbox + uid', () => {
        const overlay = emptyPinSnoozeOverlay();
        overlay.pinned[messageOverlayKey(path, 7)] = true;
        assert.ok(isMessagePinned(overlay, path, 7));
        assert.ok(!isMessagePinned(overlay, path, 8));
    });
});
