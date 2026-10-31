import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mobileUndoSendToastMessage } from '../../src/lib/mobile-compose-undo.ts';

describe('mobile-compose-undo (slice 35)', () => {
    it('formats undo-send toast copy', () => {
        assert.equal(mobileUndoSendToastMessage(0), 'Sending in 0 seconds');
        assert.equal(mobileUndoSendToastMessage(1), 'Sending in 1 second');
        assert.equal(mobileUndoSendToastMessage(5), 'Sending in 5 seconds');
        assert.equal(mobileUndoSendToastMessage(5.7), 'Sending in 6 seconds');
    });
});
