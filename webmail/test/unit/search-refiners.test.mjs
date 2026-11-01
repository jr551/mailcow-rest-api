import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    OWA_SEARCH_REFINERS,
    refinerIsActive,
    searchQueryHasToken,
    showSearchRefiners,
    toggleSearchRefinerToken
} from '../../src/lib/search-refiners.ts';

describe('search-refiners (slice 50)', () => {
    it('detects tag tokens in a query', () => {
        assert.equal(searchQueryHasToken('budget has:attachment', 'has:attachment'), true);
        assert.equal(searchQueryHasToken('has:attachment budget', 'has:attachment'), true);
        assert.equal(searchQueryHasToken('subject:has:attachment', 'has:attachment'), false);
    });

    it('toggleSearchRefinerToken adds and removes tokens', () => {
        assert.equal(toggleSearchRefinerToken('team update', 'is:unread'), 'team update is:unread');
        assert.equal(toggleSearchRefinerToken('team is:unread', 'is:unread'), 'team');
        assert.equal(toggleSearchRefinerToken('', 'has:attachment'), 'has:attachment');
    });

    it('refinerIsActive and showSearchRefiners', () => {
        const unread = OWA_SEARCH_REFINERS.find((r) => r.id === 'is-unread');
        assert.ok(unread);
        assert.equal(refinerIsActive('q is:unread', unread), true);
        assert.equal(showSearchRefiners('  '), false);
        assert.equal(showSearchRefiners('budget'), true);
    });
});
