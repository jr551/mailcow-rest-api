import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    looksLikeStructuredMailSearch,
    parseNlSearchResponse,
    sanitizeTranslatedSearch
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
