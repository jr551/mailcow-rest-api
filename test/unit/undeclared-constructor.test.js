'use strict';

// Static guard for a bug class that shipped in v0.22.0 and survived two
// releases: `src/outbound-webhook-forwarder.js` used `new ImapFlow(...)` while
// never requiring `imapflow`. The forwarder therefore threw
// `ReferenceError: ImapFlow is not defined` on every connect and delivered
// nothing, while still reporting itself healthy.
//
// No unit test could catch it, because the delivery tests inject a fake IMAP
// and short-circuit the constructor before the missing name is read. It was
// only reachable in production.
//
// This test closes that hole at the source: it walks every file in src/,
// collects the names each module actually declares or imports, and fails if
// anything is instantiated with `new <Name>(` that the module never defines.
// Class names are the narrow, high-signal case - unlike a full no-undef pass,
// this has essentially no false positives once the JS globals are excluded.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');

// Built-ins and node globals that a module can legitimately instantiate or
// refer to without importing anything. Keep this list to true globals - a
// class that belongs to the app must be declared or required in the file that
// uses it.
const GLOBALS = new Set([
    'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError',
    'Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Promise', 'RegExp',
    'JSON', 'Math', 'Symbol', 'Function', 'Proxy', 'Reflect', 'BigInt', 'Intl', 'Event', 'EventTarget', 'URL',
    'URLSearchParams', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'AbortController', 'AbortSignal',
    'TextEncoder', 'TextDecoder', 'Buffer', 'ReadableStream', 'WritableStream', 'TransformStream',
    'ArrayBuffer', 'DataView', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array',
    'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigInt64Array',
    'WebSocket', 'MessageChannel', 'MessagePort', 'WeakRef', 'FinalizationRegistry', 'SharedArrayBuffer'
]);

function listSourceFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listSourceFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

// Extract the identifier a single binding part introduces. Handles
// `name`, `name = default`, `key: alias` and `key: alias = default`.
function bindingName(part) {
    const name = String(part || '')
        .split('=')[0]
        .trim()
        .split(':')
        .pop()
        .trim();
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}

// Collect every name this module binds. `const { A, B: C } = x` binds A and C,
// so the alias after the colon is what matters. This is deliberately
// syntactic rather than scope-aware: it errs toward over-reporting names as
// declared, which is the safe direction (it can miss a bug, never invent one).
function declaredNames(source) {
    const names = new Set();
    const patterns = [
        /\bconst\s*\{([^}]+)\}\s*=/g,                      // destructured
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,        // simple bindings
        /\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g,       // declarations
        /\b(?:async\s+)?function\s+[^(]*\(([^)]*)\)/g,      // parameters
        /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,               // catch bindings
        /\(([^()]*)\)\s*=>/g,                               // arrow parameters
        /\bfor\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g
    ];
    for (const re of patterns) {
        for (const m of source.matchAll(re)) {
            const body = m[1];
            // A binding list is either a destructuring pattern
            // (`{ a = def, b: c }` / `[a, b]`) or a comma-separated list of
            // simple names. Destructured forms nest commas inside the braces
            // or brackets, so extract those first, then the rest.
            for (const inner of body.match(/[{\[][^}\]]*[}\]]/g) || []) {
                for (const part of inner.replace(/^[{[]|[}\]]$/g, '').split(',')) {
                    const name = bindingName(part);
                    if (name) names.add(name);
                }
            }
            const plain = body.replace(/[{\[][^}\]]*[}\]]/g, ' ');
            for (const part of plain.split(',')) {
                const name = bindingName(part);
                if (name) names.add(name);
            }
        }
    }
    // require('...') binds whatever the module exports - we cannot see those
    // statically, so record the require'd names as declared to avoid false
    // positives on `const { createX } = require('./x')` handled above.
    return names;
}

test('every src/ module declares or imports every class it instantiates', () => {
    const offenders = [];

    for (const file of listSourceFiles(SRC)) {
        const source = fs.readFileSync(file, 'utf8');
        const declared = declaredNames(source);

        for (const m of source.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
            const name = m[1];
            if (GLOBALS.has(name) || declared.has(name)) continue;
            const line = source.slice(0, m.index).split('\n').length;
            offenders.push(`${path.relative(SRC, file)}:${line}  new ${name}(`);
        }
    }

    assert.deepStrictEqual(
        offenders,
        [],
        `Instantiating a class the module never declares or imports throws\n`
        + `ReferenceError at runtime - which is exactly how the outbound webhook\n`
        + `forwarder shipped broken for two releases (missing ImapFlow import),\n`
        + `invisible to tests that inject a fake. Offenders:\n\n${offenders.join('\n')}\n`
        + `\nAdd the require, or if the name is a genuine global, add it to GLOBALS.`
    );
});

test('the guard is not vacuous: it catches a missing import', () => {
    // Prove the check has teeth against the real historical bug shape.
    const source = `'use strict';\nfunction connect() { return new ImapFlow({ host: 'x' }); }\nmodule.exports = { connect };\n`;
    const declared = declaredNames(source);
    const found = [];
    for (const m of source.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (!GLOBALS.has(m[1]) && !declared.has(m[1])) found.push(m[1]);
    }
    assert.deepStrictEqual(found, ['ImapFlow'], 'expected the undeclared ImapFlow to be detected');
});
