import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createSavedMailSearch,
    sanitizeSavedMailSearches,
    touchSavedMailSearch,
    upsertSavedMailSearch,
    removeSavedMailSearch,
    MAX_SAVED_MAIL_SEARCHES
} from '../../src/lib/saved-mail-searches.ts';

test('sanitizeSavedMailSearches drops invalid rows and caps count', () => {
    const raw = [
        { id: 'a', name: '  Good  ', query: 'from:alice@example.com', scope: 'folder' },
        { id: 'b', name: '', query: 'from:bob@example.com', scope: 'folder' },
        { id: 'c', name: 'Bad', query: 'from:<script>', scope: 'folder' },
        { id: 'd', name: 'All', query: 'subject:team', scope: 'all' }
    ];
    const out = sanitizeSavedMailSearches(raw);
    assert.equal(out.length, 2);
    assert.equal(out[0].name, 'Good');
    assert.equal(out[1].scope, 'all');
});

test('upsertSavedMailSearch keeps newest first and respects max', () => {
    let list = [];
    for (let i = 0; i < MAX_SAVED_MAIL_SEARCHES + 3; i++) {
        const entry = createSavedMailSearch(`S${i}`, `q${i}`, 'folder');
        assert.ok(entry);
        list = upsertSavedMailSearch(list, entry);
    }
    assert.equal(list.length, MAX_SAVED_MAIL_SEARCHES);
    assert.match(list[0].name, /^S\d+/);
});

test('touchSavedMailSearch moves a used entry to the front', () => {
    const a = createSavedMailSearch('A', 'from:a', 'folder');
    const b = createSavedMailSearch('B', 'from:b', 'folder');
    assert.ok(a && b);
    let list = upsertSavedMailSearch(upsertSavedMailSearch([], a), b);
    list = touchSavedMailSearch(list, a.id);
    assert.equal(list[0].id, a.id);
    list = removeSavedMailSearch(list, a.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, b.id);
});
