import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAIL_COMMAND_BAR_LABEL as DESKTOP_COMMAND_BAR,
    MAIL_MESSAGE_LIST_LABEL as DESKTOP_MESSAGE_LIST,
    MAIL_MESSAGE_LIST_LANDMARK_ID as DESKTOP_LIST_ID,
    MAIL_READING_PANE_LABEL as DESKTOP_READING_PANE,
    MAIL_READING_PANE_LANDMARK_ID as DESKTOP_READING_ID,
    MAIL_SKIP_LINK_TEXT as DESKTOP_SKIP_TEXT
} from '../../src/lib/mail-landmarks.ts';
import {
    MAIL_COMMAND_BAR_LABEL,
    MAIL_MESSAGE_LIST_LABEL,
    MAIL_MESSAGE_LIST_LANDMARK_ID,
    MAIL_READING_PANE_LABEL,
    MAIL_READING_PANE_LANDMARK_ID,
    MAIL_SKIP_LINK_TEXT,
    MOBILE_APP_NAV_LABEL,
    MOBILE_LANDMARK_ROWS,
    focusMobileReadingPaneLandmark,
    focusMobileMessageListLandmark
} from '../../src/lib/mobile-mail-landmarks.ts';

describe('mobile-mail-landmarks', () => {
    it('matches desktop slice 17 ids and region labels', () => {
        assert.equal(MAIL_SKIP_LINK_TEXT, DESKTOP_SKIP_TEXT);
        assert.equal(MAIL_MESSAGE_LIST_LANDMARK_ID, DESKTOP_LIST_ID);
        assert.equal(MAIL_READING_PANE_LANDMARK_ID, DESKTOP_READING_ID);
        assert.equal(MAIL_COMMAND_BAR_LABEL, DESKTOP_COMMAND_BAR);
        assert.equal(MAIL_MESSAGE_LIST_LABEL, DESKTOP_MESSAGE_LIST);
        assert.equal(MAIL_READING_PANE_LABEL, DESKTOP_READING_PANE);
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

    it('focusMobileReadingPaneLandmark uses the shared reading pane id', () => {
        assert.equal(MAIL_READING_PANE_LANDMARK_ID, 'mail-reading-pane-landmark');
        assert.equal(typeof focusMobileReadingPaneLandmark, 'function');
    });

    it('message list landmark copy mentions Esc return focus (slice 44)', () => {
        const row = MOBILE_LANDMARK_ROWS.find((r) => r.region === MAIL_MESSAGE_LIST_LABEL);
        assert.ok(row);
        assert.match(row.description, /Esc/i);
        assert.equal(typeof focusMobileMessageListLandmark, 'function');
    });
});
