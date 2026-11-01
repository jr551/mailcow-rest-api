import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    mailQueryForCategory,
    shouldRunMailSearch,
    searchPlaceholderForCategory,
    isSearchCategory
} from '../../src/lib/search-category.ts';

describe('search-category (slice 51)', () => {
    it('mailQueryForCategory adds has:attachment for files', () => {
        assert.equal(mailQueryForCategory('budget', 'files'), 'budget has:attachment');
        assert.equal(mailQueryForCategory('budget has:attachment', 'files'), 'budget has:attachment');
        assert.equal(mailQueryForCategory('hello', 'mail'), 'hello');
    });

    it('shouldRunMailSearch skips people', () => {
        assert.equal(shouldRunMailSearch('mail'), true);
        assert.equal(shouldRunMailSearch('files'), true);
        assert.equal(shouldRunMailSearch('people'), false);
    });

    it('searchPlaceholderForCategory', () => {
        assert.match(searchPlaceholderForCategory('people', false), /people/i);
        assert.match(searchPlaceholderForCategory('files', false), /attachment/i);
    });

    it('isSearchCategory', () => {
        assert.equal(isSearchCategory('mail'), true);
        assert.equal(isSearchCategory('nope'), false);
    });
});
