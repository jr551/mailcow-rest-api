import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    looksLikeStructuredMailSearch,
    parseNlSearchResponse,
    sanitizeTranslatedSearch,
    shouldTranslateNlSearchQuery
} from '../../src/lib/natural-language-search.ts';

describe('looksLikeStructuredMailSearch', () => {
    test('detects leading tag tokens', () => {
        assert.equal(looksLikeStructuredMailSearch('from:alice@example.com'), true);
        assert.equal(looksLikeStructuredMailSearch('has:attachment'), true);
    });

    test('detects embedded tag tokens', () => {
        assert.equal(looksLikeStructuredMailSearch('budget from:finance'), true);
    });

    test('plain language stays false', () => {
        assert.equal(looksLikeStructuredMailSearch('emails about invoices'), false);
        assert.equal(looksLikeStructuredMailSearch(''), false);
    });
});

describe('parseNlSearchResponse', () => {
    test('reads search field from JSON', () => {
        const q = parseNlSearchResponse('{"search":"from:billing subject:invoice"}');
        assert.equal(q, 'from:billing subject:invoice');
    });

    test('rejects unsafe characters', () => {
        assert.equal(parseNlSearchResponse('{"search":"<script>"}'), null);
    });
});

test('sanitizeTranslatedSearch trims and collapses whitespace', () => {
    assert.equal(sanitizeTranslatedSearch('  from:a   subject:b  '), 'from:a subject:b');
});

describe('shouldTranslateNlSearchQuery (slice 55 mobile)', () => {
    const on = { aiFeatures: true, naturalLanguageSearch: true };

    test('requires mail category and both AI toggles', () => {
        assert.equal(shouldTranslateNlSearchQuery('find invoices', 'mail', on), true);
        assert.equal(shouldTranslateNlSearchQuery('find invoices', 'people', on), false);
        assert.equal(shouldTranslateNlSearchQuery('find invoices', 'mail', { aiFeatures: false, naturalLanguageSearch: true }), false);
        assert.equal(shouldTranslateNlSearchQuery('find invoices', 'mail', { aiFeatures: true, naturalLanguageSearch: false }), false);
    });

    test('skips tag-syntax queries', () => {
        assert.equal(shouldTranslateNlSearchQuery('from:alice@example.com', 'mail', on), false);
    });
});
