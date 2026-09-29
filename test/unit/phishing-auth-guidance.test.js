'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authTier, buildAuthGuidance } = require('../../src/routes/ai');

// SPF/DKIM/DMARC verdicts are the one piece of hard evidence the model
// gets about who actually sent a message — the visible From: is forgeable.
// These tests pin the two properties that make the guidance useful:
//
//   1. a FAIL reads as strong spoofing evidence (the case that motivated
//      wiring `auth` through at all), and
//   2. a PASS is never an all-clear — a passing verdict alongside a
//      surprising visible From must still be called out, because that
//      mismatch IS the phishing.
//
// They also pin the "no verdict" paths, so a message with no
// Authentication-Results header produces no auth text at all and the
// prompt is byte-identical to before — the regression this change most
// easily risks.

test('authTier maps each verdict to its tier', () => {
    assert.equal(authTier('pass'), 'pass');
    assert.equal(authTier('fail'), 'fail');
    assert.equal(authTier('softfail'), 'soft');
    assert.equal(authTier('temperror'), 'soft');
    assert.equal(authTier('permerror'), 'fail');
    // `none` means the mechanism never ran. It is NOT a pass — reading it
    // as one let unauthenticated lookalike senders through.
    assert.equal(authTier('none'), 'pending');
    assert.equal(authTier('neutral'), 'pending');
    assert.equal(authTier(null), 'absent');
    assert.equal(authTier(undefined), 'absent');
    assert.equal(authTier(''), 'absent');
    // Unrecognised tokens must not degrade into a pass.
    assert.equal(authTier('who-knows'), 'absent');
    // Case and stray whitespace come from raw header text.
    assert.equal(authTier('  PASS '), 'pass');
    assert.equal(authTier('SoftFail'), 'soft');
    assert.equal(authTier(42), 'absent');
});

test('a DMARC/SPF/DKIM fail reads as strong phishing evidence', () => {
    const out = buildAuthGuidance({ spf: 'fail', dkim: 'fail', dmarc: 'fail' });
    assert.ok(out, 'guidance is produced for an explicit fail');
    assert.match(out, /SPF, DKIM and DMARC FAILED/);
    // Must actively push the model toward isPhishing, not merely note it.
    assert.match(out, /lean strongly toward isPhishing=true/);
    // The verdicts themselves must appear verbatim so the model is
    // reading the actual result, not a paraphrase.
    assert.match(out, /SPF: fail/);
    assert.match(out, /DKIM: fail/);
    assert.match(out, /DMARC: fail/);
});

test('a single failing mechanism is enough to trigger the fail branch', () => {
    const out = buildAuthGuidance({ spf: 'pass', dkim: 'pass', dmarc: 'fail' });
    assert.ok(out);
    assert.match(out, /DMARC FAILED/);
    // The two that passed must not be described as failed.
    assert.doesNotMatch(out, /SPF FAILED/);
    assert.doesNotMatch(out, /DKIM FAILED/);
});

test('permerror counts as a fail', () => {
    const out = buildAuthGuidance({ spf: null, dkim: 'permerror', dmarc: null });
    assert.ok(out);
    assert.match(out, /DKIM FAILED/);
});

test('a pass is never presented as an all-clear', () => {
    const out = buildAuthGuidance({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    assert.ok(out);
    // The failure mode this exists to prevent: the old prompt said
    // "SPF/DKIM passed — ruling out the obvious sender-spoof tier",
    // which read to the model as permission to stop looking.
    assert.doesNotMatch(out, /ruling out/i);
    assert.match(out, /NOT an all-clear/);
});

test('a pass plus a surprising visible From is called out as an indicator', () => {
    const out = buildAuthGuidance({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    // The mismatch case is the whole reason a pass isn't an all-clear.
    assert.match(out, /names a DIFFERENT domain/);
    assert.match(out, /mismatch between the visible From and the authenticated envelope sender is ITSELF a strong phishing indicator/);
    // And a pass must not launder the content-level tells.
    assert.match(out, /does not excuse requests for credentials/);
});

test('multiple passing mechanisms are credited but still hedged', () => {
    const out = buildAuthGuidance({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    assert.match(out, /Two or more independent mechanisms passing/);
    // Even the all-pass case must end by telling the model to keep checking.
    assert.match(out, /still check links, attachments/);
});

test('a softfail is explicitly weak so bulk mail is not called phishing', () => {
    const out = buildAuthGuidance({ spf: 'softfail', dkim: null, dmarc: 'none' });
    assert.ok(out);
    assert.match(out, /did not pass cleanly/);
    // The false-positive guardrail matters more here: ordinary newsletter
    // senders softfail all the time.
    assert.match(out, /WEAK signal on its own/);
    assert.match(out, /do not let it alone make you call an ordinary newsletter phishing/);
});

test('no auth at all produces no guidance, so the prompt is unchanged', () => {
    assert.equal(buildAuthGuidance(null), null);
    assert.equal(buildAuthGuidance(undefined), null);
    assert.equal(buildAuthGuidance({}), null);
    // A message whose MTA reported `none` for everything is
    // indistinguishable from one that was never checked.
    assert.equal(buildAuthGuidance({ spf: 'none', dkim: 'none', dmarc: 'none' }), null);
    // Unparseable verdicts must not inject a fabricated "all clear".
    assert.equal(buildAuthGuidance({ spf: 'gibberish', dkim: null, dmarc: null }), null);
});

test('guidance always states the verdicts describe the envelope, not the From header', () => {
    for (const auth of [
        { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
        { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
        { spf: 'softfail', dkim: null, dmarc: 'none' }
    ]) {
        const out = buildAuthGuidance(auth);
        assert.match(out, /ENVELOPE sender/);
        assert.match(out, /NOT the visible "From:" header/);
    }
});

test('guidance does not claim a fail alone proves maliciousness', () => {
    // Guardrail in both directions: a broken SPF record on a familiar
    // sender is a misconfiguration far more often than an attack.
    const out = buildAuthGuidance({ spf: 'fail', dkim: 'fail', dmarc: 'fail' });
    assert.match(out, /do not by themselves make a message malicious/);
    assert.match(out, /false-positive guardrails above still apply/);
});

test('mechanism names are listed naturally, not chained with "and"', () => {
    // "SPF and DKIM and DMARC" reads as a bug in a prompt the model is
    // asked to trust.
    const all = buildAuthGuidance({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    assert.match(all, /SPF, DKIM and DMARC passed/);
    assert.doesNotMatch(all, /and DMARC and/);

    const two = buildAuthGuidance({ spf: 'pass', dkim: 'pass', dmarc: null });
    assert.match(two, /SPF and DKIM passed/);
});

test('a mixed verdict set describes each mechanism in its own tier', () => {
    const out = buildAuthGuidance({ spf: 'softfail', dkim: 'pass', dmarc: 'fail' });
    assert.match(out, /SPF did not pass cleanly/);
    assert.match(out, /DKIM passed/);
    assert.match(out, /DMARC FAILED/);
});
