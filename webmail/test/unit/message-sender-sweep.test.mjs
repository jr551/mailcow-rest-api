import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'sender-sweep-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'message-sender-sweep.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/message-sender-sweep.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

function msg(uid, from, iso) {
    return {
        uid,
        seq: uid,
        flags: ['\\Seen'],
        size: 100,
        internalDate: iso,
        envelope: {
            date: iso,
            subject: `m${uid}`,
            from: [{ name: from.split('@')[0], address: from }],
            to: [],
            cc: [],
            messageId: `<${uid}>`,
            inReplyTo: null
        }
    };
}

describe('message sender sweep (slice 10)', () => {
    it('delete-all selects every message from the sender', async () => {
        const { selectSenderSweepTargets } = await loadModule();
        const list = [
            msg(1, 'sam@friend.example', '2026-04-26T12:00:00Z'),
            msg(2, 'sam@friend.example', '2026-04-27T08:00:00Z'),
            msg(3, 'other@example.com', '2026-04-28T08:00:00Z')
        ];
        const targets = selectSenderSweepTargets(list, 'sam@friend.example', 'delete-all');
        assert.deepEqual(targets.map((m) => m.uid), [1, 2]);
    });

    it('keep-latest drops only the newest from the sender', async () => {
        const { selectSenderSweepTargets } = await loadModule();
        const list = [
            msg(1, 'sam@friend.example', '2026-04-26T12:00:00Z'),
            msg(2, 'sam@friend.example', '2026-04-27T08:00:00Z')
        ];
        const targets = selectSenderSweepTargets(list, 'sam@friend.example', 'keep-latest');
        assert.deepEqual(targets.map((m) => m.uid), [1]);
    });

    it('keep-latest with a single message returns nothing', async () => {
        const { selectSenderSweepTargets } = await loadModule();
        const list = [msg(1, 'sam@friend.example', '2026-04-26T12:00:00Z')];
        const targets = selectSenderSweepTargets(list, 'sam@friend.example', 'keep-latest');
        assert.equal(targets.length, 0);
    });

    it('menu labels include the sender display name', async () => {
        const { senderSweepMenuItems } = await loadModule();
        const items = senderSweepMenuItems('Sam');
        assert.ok(items.some((i) => i.label.includes('Sam')));
        assert.equal(items.length, 3);
    });
});
