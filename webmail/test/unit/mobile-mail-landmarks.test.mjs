import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAIL_MESSAGE_LIST_LANDMARK_ID,
    MAIL_READING_PANE_LANDMARK_ID,
    MAIL_SKIP_LINK_TEXT,
    MOBILE_APP_NAV_LABEL,
    MOBILE_LANDMARK_ROWS
} from '../../src/lib/mobile-mail-landmarks.ts';
import { MAIL_COMMAND_BAR_LABEL, MAIL_MESSAGE_LIST_LABEL, MAIL_READING_PANE_LABEL } from '../../src/lib/mail-landmarks.ts';

describe('mobile-mail-landmarks', () => {
    it('reuses desktop skip link text and list landmark id', () => {
        assert.equal(MAIL_SKIP_LINK_TEXT, 'Skip to message list');
        assert.equal(MAIL_MESSAGE_LIST_LANDMARK_ID, 'mail-message-list-landmark');
        assert.equal(MAIL_READING_PANE_LANDMARK_ID, 'mail-reading-pane-landmark');
    });

    it('documents mobile shell regions in tab order', () => {
        const regions = MOBILE_LANDMARK_ROWS.map((r) => r.region);
        assert.deepEqual(regions, [
            MAIL_COMMAND_BAR_LABEL,
            MOBILE_APP_NAV_LABEL,
            MAIL_MESSAGE_LIST_LABEL,
            MAIL_READING_PANE_LABEL
        ]);
        assert.equal(new Set(regions).size, regions.length);
    });
});
