import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MOBILE_SAVE_DRAFT_EMPTY,
    MOBILE_SAVE_DRAFT_SUCCESS,
    mobilePlainTextToDraftHtml
} from '../../src/lib/mobile-compose-save-draft.ts';

describe('mobile-compose-save-draft (slice 37)', () => {
    it('exposes stable toast copy', () => {
        assert.equal(MOBILE_SAVE_DRAFT_SUCCESS, 'Draft saved to Drafts');
        assert.match(MOBILE_SAVE_DRAFT_EMPTY, /Nothing to save/);
    });

    it('wraps plain text as draft HTML', () => {
        assert.equal(mobilePlainTextToDraftHtml(''), '<p></p>');
        assert.equal(mobilePlainTextToDraftHtml('Hi\nthere'), '<p>Hi<br>there</p>');
        assert.equal(mobilePlainTextToDraftHtml('<tag>'), '<p>&lt;tag&gt;</p>');
    });
});
