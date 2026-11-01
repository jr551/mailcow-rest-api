import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const webmailRoot = path.resolve(import.meta.dirname, '../..');

function loadModule() {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mail-rules-mgmt-'));
    const out = path.join(tmp, 'mail-rules-management.mjs');
    const r = spawnSync(
        'npx',
        [
            'esbuild',
            '--bundle',
            '--loader:.ts=ts',
            '--format=esm',
            `--outfile=${out}`,
            path.join(webmailRoot, 'src/lib/mail-rules-management.ts')
        ],
        { cwd: webmailRoot, encoding: 'utf8' }
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return import(`file://${out}`);
}

describe('mail-rules-management (slice 57)', () => {
    it('partitions sweep vs other rules', async () => {
        const mod = await loadModule();
        const rules = [
            { id: '1', name: 'Sweep: Trash mail from a@x.com', condition: {}, action: {} },
            { id: '2', name: 'Block newsletters', condition: {}, action: {} },
            { id: '3', name: 'Sweep: Archive mail from b@y.com', condition: {}, action: {} }
        ];
        const counts = mod.mailRulesListFilterCounts(rules);
        assert.deepEqual(counts, { all: 3, sweep: 2, other: 1 });
        assert.equal(mod.filterMailRulesList(rules, 'sweep').length, 2);
        assert.equal(mod.filterMailRulesList(rules, 'other').length, 1);
        assert.equal(mod.filterMailRulesList(rules, 'all').length, 3);
    });

    it('empty hints when a filter bucket is empty', async () => {
        const mod = await loadModule();
        const rules = [{ id: '1', name: 'Manual', condition: {}, action: {} }];
        const counts = mod.mailRulesListFilterCounts(rules);
        assert.match(mod.mailRulesListFilterEmptyHint('sweep', counts), /No Sweep automation/i);
        assert.equal(mod.mailRulesListFilterEmptyHint('other', counts), null);
    });
});
