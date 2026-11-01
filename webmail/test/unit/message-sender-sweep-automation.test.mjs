import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const webmailRoot = path.resolve(import.meta.dirname, '../..');

function loadModule() {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sender-sweep-automation-'));
    const out = path.join(tmp, 'message-sender-sweep-automation.mjs');
    const r = spawnSync(
        'npx',
        ['esbuild', '--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/message-sender-sweep-automation.ts')],
        { cwd: webmailRoot, encoding: 'utf8' }
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return import(`file://${out}`);
}

describe('message-sender-sweep-automation (slice 54)', () => {
    it('builds trash and archive automation rules', async () => {
        const mod = await loadModule();
        const trash = mod.buildSenderSweepAutomationRule('Sam@Example.com', 'always-trash', 'Trash');
        assert.equal(trash.condition.type, 'from-contains');
        assert.equal(trash.condition.value, 'sam@example.com');
        assert.equal(trash.action.type, 'fileinto');
        assert.equal(trash.action.folder, 'Trash');
        assert.match(trash.name, /Trash mail from sam@example.com/i);

        const archive = mod.buildSenderSweepAutomationRule('sam@example.com', 'always-archive', 'Archive');
        assert.equal(archive.action.folder, 'Archive');
        assert.match(archive.name, /Archive mail from/i);
    });

    it('maps one-time actions to automation kinds', async () => {
        const mod = await loadModule();
        assert.equal(mod.automationKindForOneTimeAction('archive-all'), 'always-archive');
        assert.equal(mod.automationKindForOneTimeAction('delete-all'), 'always-trash');
        assert.equal(mod.automationKindForOneTimeAction('keep-latest'), 'always-trash');
    });

    it('detects existing sweep automation by title', async () => {
        const mod = await loadModule();
        const sender = 'jordan@example.com';
        const title = mod.sweepAutomationRuleTitle(sender, 'always-trash');
        const rules = [
            { id: '1', name: title, condition: { type: 'from-contains', value: sender }, action: { type: 'fileinto', folder: 'Trash' } }
        ];
        assert.ok(mod.findExistingSweepAutomation(rules, sender, 'always-trash'));
        assert.equal(mod.findExistingSweepAutomation(rules, 'other@example.com', 'always-trash'), undefined);
    });
});
