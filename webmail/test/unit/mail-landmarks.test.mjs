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
    MAIL_SKIP_TO_READING_PANE_TEXT,
    composeCloseFocusLandmarkId,
    mailLandmarkLabelSet,
    focusMailReadingPaneLandmark,
    focusMailMessageListLandmark
} from '../../src/lib/mail-landmarks.ts';

describe('mail-landmarks', () => {
    it('exposes stable skip-link target ids', () => {
        assert.match(MAIL_MESSAGE_LIST_LANDMARK_ID, /^mail-/);
        assert.match(MAIL_READING_PANE_LANDMARK_ID, /^mail-/);
        assert.notEqual(MAIL_MESSAGE_LIST_LANDMARK_ID, MAIL_READING_PANE_LANDMARK_ID);
    });

    it('documents skip links for list and reading pane (slice 48)', () => {
        assert.ok(MAIL_SKIP_LINK_TEXT.includes('message list'));
        assert.ok(MAIL_SKIP_TO_READING_PANE_TEXT.includes('reading pane'));
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

    it('focusMailReadingPaneLandmark targets the reading pane landmark id', () => {
        assert.equal(MAIL_READING_PANE_LANDMARK_ID, 'mail-reading-pane-landmark');
        assert.equal(typeof focusMailReadingPaneLandmark, 'function');
    });

    it('focusMailMessageListLandmark targets the message list landmark id', () => {
        assert.equal(MAIL_MESSAGE_LIST_LANDMARK_ID, 'mail-message-list-landmark');
        assert.equal(typeof focusMailMessageListLandmark, 'function');
    });

    it('documents Esc return focus on the message list region', () => {
        const listRow = MAIL_LANDMARK_ROWS.find((r) => r.region === MAIL_MESSAGE_LIST_LABEL);
        assert.ok(listRow?.description.includes('Esc'));
        assert.ok(listRow?.description.includes('compose'));
    });

    it('composeCloseFocusLandmarkId returns reading pane for reply with open message', () => {
        assert.equal(
            composeCloseFocusLandmarkId('reply', true, true),
            MAIL_READING_PANE_LANDMARK_ID
        );
        assert.equal(
            composeCloseFocusLandmarkId('forward', true, true),
            MAIL_READING_PANE_LANDMARK_ID
        );
    });

    it('composeCloseFocusLandmarkId returns message list for new compose or hidden pane', () => {
        assert.equal(composeCloseFocusLandmarkId('new', true, true), MAIL_MESSAGE_LIST_LANDMARK_ID);
        assert.equal(composeCloseFocusLandmarkId('reply', true, false), MAIL_MESSAGE_LIST_LANDMARK_ID);
        assert.equal(composeCloseFocusLandmarkId('reply', false, true), MAIL_MESSAGE_LIST_LANDMARK_ID);
        assert.equal(composeCloseFocusLandmarkId(undefined, true, true), MAIL_MESSAGE_LIST_LANDMARK_ID);
    });
});
