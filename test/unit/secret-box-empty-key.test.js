'use strict';

// Regression test: an EXISTING but empty/whitespace credential-key file is
// not a fresh install. loadKey used to fall through the `if (raw)` check and
// silently overwrite it with a brand-new key — a master-key rotation that
// makes every credential sealed under the previous key unreadable — while
// logging the cheerful first-install message "generated a credential
// encryption key on disk", which describes none of that. The service must
// keep running (a new key is the only way forward once the file is empty),
// but the operator must be told what actually happened.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretBox } = require('../../src/secret-box');

function makeLogger() {
    const entries = [];
    return {
        entries,
        warn: (obj, msg) => entries.push({ level: 'warn', msg, obj }),
        error: (obj, msg) => entries.push({ level: 'error', msg, obj }),
        info: (obj, msg) => entries.push({ level: 'info', msg, obj }),
        debug: () => {}
    };
}

test('an empty credential-key file is reported as key loss, not as a fresh install', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretbox-empty-'));
    fs.writeFileSync(path.join(dataDir, 'credential-key'), '');

    const logger = makeLogger();
    const box = createSecretBox({ dataDir, logger });

    assert.ok(box.enabled, 'the service keeps running with a replacement key');
    assert.equal(box.decrypt(box.encrypt('pw')), 'pw', 'the replacement key round-trips');

    const keyProblems = logger.entries.filter((e) => e.level === 'error' && /key/i.test(e.msg));
    assert.ok(keyProblems.length >= 1,
        'an unusable key file is an ERROR the operator must see, not the first-install warning');
    const msg = keyProblems.map((e) => e.msg).join(' | ');
    assert.match(msg, /empty|unusable/i, 'the message names the actual condition');
    assert.match(msg, /previous key|no longer|unreadable/i,
        'the message states the consequence: sealed credentials are lost');

    const freshInstallLies = logger.entries.filter(
        (e) => e.level === 'warn' && /generated a credential encryption key on disk/i.test(e.msg)
    );
    assert.equal(freshInstallLies.length, 0,
        'the first-install message must not describe a key rotation');
});

test('a genuinely missing key file still gets the first-install warning', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretbox-fresh-'));
    const logger = makeLogger();
    const box = createSecretBox({ dataDir, logger });

    assert.ok(box.enabled);
    const gen = logger.entries.filter((e) => /generated a credential encryption key on disk/i.test(e.msg));
    assert.equal(gen.length, 1);
    assert.equal(logger.entries.filter((e) => e.level === 'error').length, 0,
        'a first install is not an error');
});
