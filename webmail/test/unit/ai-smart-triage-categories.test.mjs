import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSmartTriageCategoryAssignments,
    inboxCategoryToOwaCategory
} from '../../src/lib/ai-smart-triage-categories.ts';

describe('ai-smart-triage-categories', () => {
    it('maps inbox triage categories to OWA colour categories', () => {
        assert.equal(inboxCategoryToOwaCategory('human'), 'red');
        assert.equal(inboxCategoryToOwaCategory('family'), 'purple');
        assert.equal(inboxCategoryToOwaCategory('important'), 'orange');
        assert.equal(inboxCategoryToOwaCategory('info'), null);
    });

    it('buildSmartTriageCategoryAssignments skips flagged categories and info bucket', () => {
        const rankings = [
            { uid: 1, level: 5, category: 'human', human: true, reason: 'x' },
            { uid: 2, level: 3, category: 'info', human: false, reason: 'y' },
            { uid: 3, level: 2, category: 'marketing', human: false, reason: 'z' }
        ];
        const flags = new Map([
            [1, ['\\Seen']],
            [2, ['\\Seen']],
            [3, ['\\Seen', '$CategoryBlue']]
        ]);
        const assignments = buildSmartTriageCategoryAssignments({
            rankings,
            resolveEffectiveInboxCategory: (uid) => {
                const r = rankings.find((x) => x.uid === uid);
                return r?.category ?? null;
            },
            flagsForUid: (uid) => flags.get(uid)
        });
        assert.deepEqual(
            assignments.map((a) => ({ uid: a.uid, owa: a.owaCategory })),
            [{ uid: 1, owa: 'red' }]
        );
    });
});
