import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MOBILE_COMPOSE_DISCARD_TITLE,
    MOBILE_COMPOSE_DISCARD_BODY,
    MOBILE_COMPOSE_DISCARD_KEEP,
    MOBILE_COMPOSE_DISCARD_SAVE,
    MOBILE_COMPOSE_DISCARD_CONFIRM,
    mobileComposeNeedsDiscardConfirm
} from '../../src/lib/mobile-compose-discard.ts';

describe('mobile-compose-discard (slice 39)', () => {
    it('exposes OWA-style discard sheet copy', () => {
        assert.match(MOBILE_COMPOSE_DISCARD_TITLE, /discard/i);
        assert.match(MOBILE_COMPOSE_DISCARD_BODY, /sent/i);
        assert.equal(MOBILE_COMPOSE_DISCARD_KEEP, 'Keep editing');
        assert.equal(MOBILE_COMPOSE_DISCARD_SAVE, 'Save draft');
        assert.equal(MOBILE_COMPOSE_DISCARD_CONFIRM, 'Discard');
    });

    it('mobileComposeNeedsDiscardConfirm mirrors draft content', () => {
        assert.equal(mobileComposeNeedsDiscardConfirm(false), false);
        assert.equal(mobileComposeNeedsDiscardConfirm(true), true);
    });
});
