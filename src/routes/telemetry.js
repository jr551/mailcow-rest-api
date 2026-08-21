'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Append-only telemetry sink. The webmail's error doctor POSTs every
// reportable incident here; we write a single JSON-line per error to
// /data/error.log with timestamp + ip + user + structured fields. No
// rotation yet — operator runs `logrotate` at the OS level if needed.
//
// We chose append-only JSON-lines (not pino) so this file is grep-
// friendly without a tool, and a simple `tail -f` shows live errors.

const MAX_BODY_BYTES = 64 * 1024;        // ignore >64 KB submissions
const MAX_FIELD_CHARS = 4000;            // cap individual fields

function clip(s, max = MAX_FIELD_CHARS) {
    if (typeof s !== 'string') return undefined;
    return s.length > max ? s.slice(0, max) + `…(+${s.length - max})` : s;
}

// The POST endpoint is public and appends up to 64 KB a call, so the log
// is attacker-growable. Two consequences to defend against:
//
//  * /recent used to readFile() the whole thing just to take the last N
//    lines — a large file turned one GET into an OOM / event-loop stall.
//    Read a bounded tail from the end instead.
//  * Nothing ever truncated the file. Rotate once it passes a ceiling,
//    keeping a single .1 generation, so disk use is bounded without
//    depending on an operator remembering to configure logrotate.
const TAIL_READ_BYTES = 512 * 1024;
const ROTATE_AT_BYTES = 16 * 1024 * 1024;

// Entries carry the reporter's IP, mailbox, page URLs and stack traces. The
// only gate used to be "authenticated", so every mailbox user could read
// every other user's error reports. Operators who want the full view name
// themselves here.
const ADMIN_USERS = new Set(
    String(process.env.TELEMETRY_ADMIN_USERS || '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
);

// Non-admins see their own reports, plus anonymous ones (the login surface
// reports before there is a user) with the IP removed.
function visibleTo(entry, caller) {
    if (!entry) return null;
    const owner = typeof entry.user === 'string' ? entry.user.toLowerCase() : null;
    if (owner && owner !== caller) return null;
    if (owner === caller) return entry;
    const { ip, ...rest } = entry;
    return rest;
}

async function readTail(file, maxBytes) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const { size } = await handle.stat();
        const start = Math.max(0, size - maxBytes);
        const length = size - start;
        if (length <= 0) return '';
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, start);
        let text = buf.toString('utf8');
        // A mid-line start would yield a partial JSON record; drop it.
        if (start > 0) {
            const nl = text.indexOf('\n');
            text = nl === -1 ? '' : text.slice(nl + 1);
        }
        return text;
    } finally {
        await handle.close();
    }
}


module.exports = async function telemetryRoutes(app, { logPath }) {
    const target = logPath || path.join('/data', 'error.log');
    try {
        const dir = path.dirname(target);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // Touch + chmod so first-write doesn't race.
        if (!fs.existsSync(target)) fs.writeFileSync(target, '', { mode: 0o640 });
    } catch (err) {
        app.log.warn({ err: err.message, target }, 'telemetry sink not writable; route disabled');
        return;
    }

    let rotating = false;
    async function rotateIfLarge(log) {
        if (rotating) return;
        try {
            const { size } = await fs.promises.stat(target);
            if (size < ROTATE_AT_BYTES) return;
            rotating = true;
            // Single generation: <file>.1 is replaced, not chained, so the
            // ceiling is 2x ROTATE_AT_BYTES no matter how long we run.
            await fs.promises.rename(target, `${target}.1`);
            await fs.promises.writeFile(target, '', { mode: 0o640 });
            log?.info({ target }, 'telemetry log rotated');
        } catch (err) {
            log?.warn({ err: err.message }, 'telemetry rotate failed');
        } finally {
            rotating = false;
        }
    }

    const bodySchema = {
        type: 'object',
        properties: {
            type: { type: 'string', enum: ['api', 'javascript', 'promise', 'network'] },
            message: { type: 'string' },
            status: { type: 'integer' },
            url: { type: 'string' },
            stack: { type: 'string' },
            detail: { type: 'string' },
            // Optional client-supplied metadata so we can correlate.
            page: { type: 'string' },
            userAgent: { type: 'string' },
            sessionId: { type: 'string' },
            buildSha: { type: 'string' }
        },
        additionalProperties: true
    };

    app.post('/v1/telemetry/error', {
        // Public so unauthenticated SPAs (login surface) can still
        // report their own crashes. We still bind the auth user when
        // we have one.
        config: { public: true },
        schema: {
            tags: ['system'],
            summary: 'Submit a client-side error for the operator log',
            body: bodySchema,
            response: {
                204: { type: 'null' },
                413: { type: 'object' }
            }
        },
        bodyLimit: MAX_BODY_BYTES
    }, async (req, reply) => {
        const b = req.body || {};
        const entry = {
            ts: new Date().toISOString(),
            ip: req.ip || req.socket?.remoteAddress || null,
            user: req.creds?.user || null,
            type: typeof b.type === 'string' ? b.type : 'unknown',
            message: clip(b.message) || '(no message)',
            status: typeof b.status === 'number' ? b.status : null,
            url: clip(b.url, 1000),
            page: clip(b.page, 1000),
            stack: clip(b.stack),
            detail: clip(b.detail),
            ua: clip(b.userAgent, 500),
            sid: clip(b.sessionId, 80),
            sha: clip(b.buildSha, 80)
        };
        try {
            await fs.promises.appendFile(target, JSON.stringify(entry) + '\n');
            await rotateIfLarge(req.log);
        } catch (err) {
            req.log.warn({ err: err.message }, 'telemetry append failed');
        }
        reply.code(204);
    });

    // GET to inspect the recent tail. Auth-required so we don't leak
    // user IPs / error messages publicly. Useful for an admin dashboard
    // (or the AI when troubleshooting "what's been breaking lately").
    app.get('/v1/telemetry/recent', {
        schema: {
            tags: ['system'],
            summary: 'Tail recent telemetry entries',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 1000 }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        entries: { type: 'array', items: { type: 'object' } }
                    }
                }
            }
        }
    }, async (req) => {
        const limit = Math.min(1000, Math.max(1, Number(req.query?.limit) || 100));
        const caller = String(req.creds?.user || '').toLowerCase();
        const isAdmin = ADMIN_USERS.has(caller);
        try {
            const raw = await readTail(target, TAIL_READ_BYTES);
            const lines = raw.trim().split('\n').filter(Boolean);
            const entries = [];
            // Filter before slicing, so a non-admin still gets `limit` of
            // their own entries rather than whatever survives the window.
            for (const line of lines) {
                let parsed;
                try { parsed = JSON.parse(line); }
                catch { continue; }
                const visible = isAdmin ? parsed : visibleTo(parsed, caller);
                if (visible) entries.push(visible);
            }
            return { entries: entries.slice(-limit) };
        } catch (err) {
            req.log.warn({ err: err.message }, 'telemetry read failed');
            return { entries: [] };
        }
    });
};

module.exports.__testables = { readTail, visibleTo, TAIL_READ_BYTES, ROTATE_AT_BYTES };
