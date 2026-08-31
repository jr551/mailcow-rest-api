#!/usr/bin/env node

const DEFAULT_TIMEOUT_MS = 6000;

function usage() {
    console.log(`Usage:
  npm run check:config -- --url https://webmail.example.com
  node scripts/check-config.mjs --url http://localhost:8080

Options:
  --url <origin>       Webmail origin to test. Defaults to WEBMAIL_URL or http://localhost:8080.
  --timeout <ms>       Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}.
`);
}

function parseArgs(argv) {
    const out = {
        url: process.env.WEBMAIL_URL || 'http://localhost:8080',
        timeoutMs: DEFAULT_TIMEOUT_MS
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            usage();
            process.exit(0);
        }
        if (arg === '--url') {
            out.url = argv[++i] || '';
            continue;
        }
        if (arg === '--timeout') {
            out.timeoutMs = Number(argv[++i]);
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
        throw new Error('--timeout must be a positive number');
    }
    return out;
}

function endpoint(base, path) {
    return new URL(path, base).toString();
}

async function fetchWithTimeout(url, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        return await fetch(url, {
            cache: 'no-store',
            redirect: 'manual',
            signal: ctl.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

async function check(base, def, timeoutMs) {
    const url = endpoint(base, def.path);
    try {
        const res = await fetchWithTimeout(url, timeoutMs);
        const contentType = res.headers.get('content-type') || '';
        if (!res.ok) {
            return { ...def, ok: false, status: res.status, detail: `${def.path} returned HTTP ${res.status}` };
        }
        if (def.kind === 'json') {
            try {
                await res.clone().json();
            } catch {
                return { ...def, ok: false, status: res.status, detail: `${def.path} returned non-JSON content (${contentType || 'no content-type'})` };
            }
        }
        if (def.kind === 'openapi') {
            try {
                const json = await res.clone().json();
                if (!json.openapi && !json.swagger) {
                    return { ...def, ok: false, status: res.status, detail: `${def.path} is JSON but not an OpenAPI document` };
                }
            } catch {
                return { ...def, ok: false, status: res.status, detail: `${def.path} returned invalid JSON` };
            }
        }
        return { ...def, ok: true, status: res.status, detail: `${def.path} OK` };
    } catch (err) {
        const detail = err instanceof DOMException && err.name === 'AbortError'
            ? `${def.path} timed out`
            : `${def.path} failed: ${err instanceof Error ? err.message : String(err)}`;
        return { ...def, ok: false, detail };
    }
}

const checks = [
    {
        name: 'Webmail shell',
        path: '/webmail/',
        kind: 'html',
        fix: 'Serve this repo at /webmail/ or adjust the Vite base and web server paths together.'
    },
    {
        name: 'API health',
        path: '/health',
        kind: 'text',
        fix: 'Proxy /health to mailcow-rest-api.'
    },
    {
        name: 'OpenAPI document',
        path: '/openapi.json',
        kind: 'openapi',
        fix: 'Proxy /openapi.json to mailcow-rest-api.'
    },
    {
        name: 'Public API route',
        path: '/v1/push/config',
        kind: 'json',
        fix: 'Proxy /v1/* to mailcow-rest-api. This is the same route family login uses.'
    }
];

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const base = new URL(opts.url);
    if (!base.pathname.endsWith('/')) base.pathname += '/';

    console.log(`Checking ${base.origin}`);
    const results = await Promise.all(checks.map((c) => check(base, c, opts.timeoutMs)));
    let failed = 0;
    for (const result of results) {
        const mark = result.ok ? 'OK ' : 'ERR';
        const status = result.status ? `HTTP ${result.status}` : 'no response';
        console.log(`${mark} ${result.name.padEnd(18)} ${status.padEnd(9)} ${result.detail}`);
        if (!result.ok) {
            failed++;
            console.log(`    fix: ${result.fix}`);
        }
    }
    if (failed) {
        console.log(`\n${failed} check${failed === 1 ? '' : 's'} failed. The browser needs /v1/*, /health, and /openapi.json on the same origin as webmail.`);
        process.exit(1);
    }
    console.log('\nAll checks passed.');
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
