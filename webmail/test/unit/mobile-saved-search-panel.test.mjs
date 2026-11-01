import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldShowMobileSavedSearchPanel } from '../../src/lib/mobile-saved-search-panel.ts';

test('mobile saved search panel hidden when search field is not focused', () => {
    assert.equal(shouldShowMobileSavedSearchPanel(false, 2, true, false), false);
});

test('mobile saved search panel shows when focused and user can save', () => {
    assert.equal(shouldShowMobileSavedSearchPanel(true, 0, true, false), true);
});

test('mobile saved search panel shows when focused with saved items only', () => {
    assert.equal(shouldShowMobileSavedSearchPanel(true, 1, false, false), true);
});

test('mobile saved search panel shows while naming a new saved search', () => {
    assert.equal(shouldShowMobileSavedSearchPanel(true, 0, false, true), true);
});

test('mobile saved search panel shows for People category matches (slice 53)', () => {
    assert.equal(shouldShowMobileSavedSearchPanel(true, 0, false, false, true), true);
    assert.equal(shouldShowMobileSavedSearchPanel(false, 0, false, false, true), false);
});
