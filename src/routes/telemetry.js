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
        try {
            const raw = await fs.promises.readFile(target, 'utf8');
            const lines = raw.trim().split('\n').filter(Boolean);
            const tail = lines.slice(-limit);
            const entries = [];
            for (const line of tail) {
                try { entries.push(JSON.parse(line)); }
                catch { /* skip malformed */ }
            }
            return { entries };
        } catch (err) {
            req.log.warn({ err: err.message }, 'telemetry read failed');
            return { entries: [] };
        }
    });
};
