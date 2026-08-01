'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTail } = require('../../src/routes/telemetry').__testables;

function tmpFile(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-'));
    const file = path.join(dir, 'error.log');
    fs.writeFileSync(file, contents);
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('readTail returns the whole file when it is under the cap', async () => {
    const { file, cleanup } = tmpFile('a\nb\nc\n');
    try {
        assert.equal(await readTail(file, 1024), 'a\nb\nc\n');
    } finally { cleanup(); }
});

test('readTail reads only the end of a large file', async () => {
    // The endpoint is public and append-only, so the log can grow past
    // anything we want to hold in memory. Reading a bounded window is the
    // difference between a tail and an OOM.
    const line = 'x'.repeat(200);
    const lines = Array.from({ length: 5000 }, (_, i) => `${i}:${line}`).join('\n') + '\n';
    const { file, cleanup } = tmpFile(lines);
    try {
        const tail = await readTail(file, 4096);
        assert.ok(tail.length <= 4096, `expected <=4096 bytes, got ${tail.length}`);
        // The last record must survive intact.
        assert.ok(tail.trimEnd().endsWith(`4999:${line}`));
    } finally { cleanup(); }
});

test('readTail never returns a truncated first record', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}-${'y'.repeat(50)}`).join('\n') + '\n';
    const { file, cleanup } = tmpFile(lines);
    try {
        const tail = await readTail(file, 500);
        // Starting mid-line would yield a partial record that JSON.parse
        // would reject; every returned line must be complete.
        for (const l of tail.split('\n').filter(Boolean)) {
            assert.match(l, /^line-\d+-y+$/, `partial record leaked: ${l}`);
        }
    } finally { cleanup(); }
});

test('readTail handles an empty file', async () => {
    const { file, cleanup } = tmpFile('');
    try {
        assert.equal(await readTail(file, 1024), '');
    } finally { cleanup(); }
});
