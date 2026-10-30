import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyCategoryToFlags,
    buildCategoryFlagUpdate,
    categoryFromFlags,
    categoryStorageKey,
    resolveMessageCategory,
    sanitizeCategoryOverlay
} from '../../src/lib/message-categories.ts';

describe('message categories', () => {
    it('maps IMAP keywords to category ids', () => {
        assert.equal(categoryFromFlags(['\\Seen', '$CategoryBlue']), 'blue');
        assert.equal(categoryFromFlags(['\\Seen']), null);
    });

    it('builds flag add/remove when assigning', () => {
        const op = buildCategoryFlagUpdate(['\\Seen', '$CategoryRed'], 'green');
        assert.deepEqual(op.remove, ['$CategoryRed']);
        assert.deepEqual(op.add, ['$CategoryGreen']);
    });

    it('applyCategoryToFlags replaces prior category keyword', () => {
        const next = applyCategoryToFlags(['\\Seen', '$CategoryOrange'], 'purple');
        assert.ok(next.includes('$CategoryPurple'));
        assert.ok(!next.includes('$CategoryOrange'));
    });

    it('resolve prefers server flags over overlay', () => {
        const key = categoryStorageKey('INBOX', 42);
        const overlay = { [key]: 'red' };
        assert.equal(resolveMessageCategory('INBOX', 42, ['$CategoryBlue'], overlay), 'blue');
        assert.equal(resolveMessageCategory('INBOX', 42, [], overlay), 'red');
    });

    it('sanitizeCategoryOverlay drops invalid entries', () => {
        const key = categoryStorageKey('INBOX', 1);
        assert.deepEqual(
            sanitizeCategoryOverlay({ [key]: 'green', bad: 'nope', 'plain-key': 'blue' }),
            { [key]: 'green' }
        );
    });
});
