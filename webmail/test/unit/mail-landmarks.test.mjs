import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAIL_COMMAND_BAR_LABEL,
    MAIL_FOLDER_NAV_LABEL,
    MAIL_LANDMARK_ROWS,
    MAIL_MESSAGE_LIST_LABEL,
    MAIL_MESSAGE_LIST_LANDMARK_ID,
    MAIL_READING_PANE_LABEL,
    MAIL_READING_PANE_LANDMARK_ID,
    MAIL_SKIP_LINK_TEXT,
    mailLandmarkLabelSet
} from '../../src/lib/mail-landmarks.ts';

describe('mail-landmarks', () => {
    it('exposes stable skip-link target ids', () => {
        assert.match(MAIL_MESSAGE_LIST_LANDMARK_ID, /^mail-/);
        assert.match(MAIL_READING_PANE_LANDMARK_ID, /^mail-/);
        assert.notEqual(MAIL_MESSAGE_LIST_LANDMARK_ID, MAIL_READING_PANE_LANDMARK_ID);
    });

    it('uses unique OWA-aligned region labels', () => {
        assert.ok(MAIL_SKIP_LINK_TEXT.length > 8);
        const labels = [
            MAIL_COMMAND_BAR_LABEL,
            MAIL_FOLDER_NAV_LABEL,
            MAIL_MESSAGE_LIST_LABEL,
            MAIL_READING_PANE_LABEL
        ];
        assert.equal(new Set(labels).size, labels.length);
        assert.equal(mailLandmarkLabelSet().size, MAIL_LANDMARK_ROWS.length);
    });
});
