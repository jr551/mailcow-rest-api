'use strict';

const { CaldavClient, generateIcal } = require('../caldav-client');
const { badRequest, problem } = require('../errors');
const { problemSchema } = require('../schemas');
const { IcalTokenStore } = require('../ical-token-store');
const icsEdit = require('../ics-edit');
const { sendMessage } = require('../smtp-client');
const path = require('node:path');

module.exports = async function calendarRoutes(app, { sogoUrl, rejectUnauthorized = true, dataDir = './data', smtp = null }) {
    if (!sogoUrl) {
        app.log.warn('calendar routes disabled: SOGO_URL not configured');
        return;
    }

    const client = new CaldavClient({ sogoUrl, rejectUnauthorized });
    const icalTokens = new IcalTokenStore(path.join(dataDir, 'ical-tokens.json'));

    // Build a VCALENDAR feed from a list of parsed events. When
    // editUrlFor is provided, each VEVENT picks up a URL: line whose
    // target is the public anonymous-edit page; calendar apps surface
    // that URL as a clickable link on the event so attendees (or
    // anyone holding the feed URL) can adjust the event without an
    // account.
    //
    // Google Calendar challenge: Google's web event-preview popover
    // truncates DESCRIPTION aggressively and frequently drops both
    // the standalone URL: property and the X-ALT-DESC HTML payload.
    // To make the edit link reachable from a Google Calendar
    // subscription we PREPEND the edit banner to DESCRIPTION (so it
    // appears in the popover's first visible chunk) and, when the
    // event has no real LOCATION, write "Edit: <url>" into LOCATION
    // — Google auto-links http(s) URLs in the location field, which
    // is also surfaced in the popover. Apple/Outlook/Thunderbird
    // still get the dedicated URL: + X-ALT-DESC lines they prefer.
    function buildIcsBody(events, editUrlFor) {
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//mailcow-rest-api//EN',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH'
        ];
        for (const ev of events) {
            let description = ev.description || '';
            let location = ev.location || '';
            let editUrl = '';
            if (editUrlFor && ev.uid) editUrl = editUrlFor(ev.uid) || '';
            if (editUrl) {
                const banner = [
                    '── ✏️ Edit this event ──',
                    'Click to update without signing in:',
                    editUrl,
                    ''
                ].join('\n');
                // Prepend so Google's truncated popover catches it.
                description = banner + (description ? description.trim() : '');
                // Only stamp location when the user hasn't set one —
                // physical addresses must not be overwritten.
                if (!location) location = `Edit: ${editUrl}`;
            }
            const evLines = generateIcal({
                uid: ev.uid,
                summary: ev.summary,
                description,
                location,
                start: ev.dtstart,
                end: ev.dtend
            }).trim().split(/\r?\n/).filter((l) => !l.startsWith('BEGIN:VCALENDAR') && !l.startsWith('END:VCALENDAR') && !l.startsWith('VERSION:') && !l.startsWith('PRODID:') && !l.startsWith('CALSCALE:') && !l.startsWith('METHOD:'));
            if (editUrl) {
                const endIdx = evLines.findIndex((l) => l.trim().toUpperCase() === 'END:VEVENT');
                // URL:<href> for Apple / Outlook / Thunderbird, plus
                // an X-ALT-DESC HTML alternative so importers that
                // honour rich descriptions render a real anchor.
                const html = `<p>✏️ <a href="${editUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Edit this event</a> — no sign-in required.</p>`;
                const altDesc = `X-ALT-DESC;FMTTYPE=text/html:${html.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')}`;
                const inserts = [`URL:${editUrl}`, altDesc];
                if (endIdx >= 0) evLines.splice(endIdx, 0, ...inserts);
                else evLines.push(...inserts);
            }
            lines.push(...evLines);
        }
        lines.push('END:VCALENDAR');
        return lines.join('\r\n') + '\r\n';
    }

    function requirePassword(req) {
        if (!req.creds.pass) {
            throw problem(401, 'Unauthorized', 'CalDAV requires Basic Auth. Bearer tokens cannot be used for calendar operations because the plaintext password is needed to authenticate with SOGo.');
        }
    }

    app.get('/v1/me/calendars', {
        schema: {
            tags: ['calendar'],
            summary: 'List CalDAV calendars',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        calendars: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    displayName: { type: 'string' },
                                    color: { type: ['string', 'null'] }
                                }
                            }
                        }
                    }
                }
            }
        }
    }, async (req) => {
        requirePassword(req);
        const user = req.creds.user;
        const pass = req.creds.pass;
        const calendars = await client.listCalendars(user, pass);
        return { user, calendars };
    });

    app.get('/v1/me/calendars/:calendar/events', {
        schema: {
            tags: ['calendar'],
            summary: 'List events in a calendar (date-range filtered)',
            querystring: {
                type: 'object',
                additionalProperties: false,
                required: ['start', 'end'],
                properties: {
                    start: { type: 'string', description: 'ISO 8601 start datetime or YYYY-MM-DD date' },
                    end: { type: 'string', description: 'ISO 8601 end datetime or YYYY-MM-DD date' }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        calendar: { type: 'string' },
                        events: { type: 'array', items: { type: 'object', additionalProperties: true } }
                    }
                }
            }
        }
    }, async (req) => {
        requirePassword(req);
        const user = req.creds.user;
        const pass = req.creds.pass;
        const calendar = decodeURIComponent(req.params.calendar);
        const { start, end } = req.query;
        if (!start || !end) throw badRequest('start and end query parameters are required');
        const events = await client.listEvents(user, pass, calendar, start, end);
        return { user, calendar, events };
    });

    app.get('/v1/me/calendars/:calendar/events/:uid', {
        schema: {
            tags: ['calendar'],
            summary: 'Get a single event by UID',
            response: {
                200: { type: 'object', additionalProperties: true },
                404: problemSchema
            }
        }
    }, async (req) => {
        requirePassword(req);
        const user = req.creds.user;
        const pass = req.creds.pass;
        const calendar = decodeURIComponent(req.params.calendar);
        const uid = decodeURIComponent(req.params.uid);
        const event = await client.getEvent(user, pass, calendar, uid);
        if (!event) throw problem(404, 'Not Found', 'Event not found');
        return event;
    });

    app.post('/v1/me/calendars/:calendar/events', {
        schema: {
            tags: ['calendar'],
            summary: 'Create a calendar event',
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['summary', 'start', 'end'],
                properties: {
                    summary: { type: 'string' },
                    start: { type: 'string', description: 'ISO 8601 start datetime or YYYY-MM-DD date' },
                    end: { type: 'string', description: 'ISO 8601 end datetime or YYYY-MM-DD date' },
                    description: { type: 'string' },
                    location: { type: 'string' }
                }
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        uid: { type: 'string' },
                        calendar: { type: 'string' }
                    }
                },
                400: problemSchema
            }
        }
    }, async (req, reply) => {
        requirePassword(req);
        const user = req.creds.user;
        const pass = req.creds.pass;
        const calendar = decodeURIComponent(req.params.calendar);
        const { summary, start, end, description, location } = req.body;
        try {
            const result = await client.createEvent(user, pass, calendar, { summary, start, end, description, location });
            reply.code(201);
            return result;
        } catch (err) {
            if (err.message && err.message.includes('Invalid date')) throw badRequest(err.message);
            throw err;
        }
    });

    app.get('/v1/me/calendars/:calendar/ical', {
        schema: {
            tags: ['calendar'],
            summary: 'Export calendar as iCal (.ics) feed (authenticated)',
            response: {
                200: { type: 'string' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        requirePassword(req);
        const user = req.creds.user;
        const pass = req.creds.pass;
        const calendar = decodeURIComponent(req.params.calendar);
        // Wide window: 2 years back, 2 years forward.
        const now = new Date();
        const start = new Date(now.getFullYear() - 2, now.getMonth(), 1).toISOString();
        const end = new Date(now.getFullYear() + 2, now.getMonth() + 1, 0, 23, 59, 59).toISOString();
        const events = await client.listEvents(user, pass, calendar, start, end);
        reply.header('content-type', 'text/calendar; charset=utf-8');
        reply.header('content-disposition', `inline; filename="${calendar}.ics"`);
        return buildIcsBody(events);
    });

    // ── Public iCal subscription tokens ──────────────────────────────
    // Authenticated routes that mint / inspect / revoke an opaque token.
    // The token is then served by the public route below — no bearer
    // auth required, so 3rd-party calendar apps can subscribe.

    app.post('/v1/me/calendars/:calendar/ical-token', {
        schema: {
            tags: ['calendar'],
            summary: 'Issue (or rotate) a public iCal subscription token',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        token: { type: 'string' },
                        url: { type: 'string' },
                        createdAt: { type: 'integer' },
                        expiresAt: { type: ['integer', 'null'] }
                    }
                }
            }
        }
    }, async (req, reply) => {
        requirePassword(req);
        const user = req.creds.user;
        const pass = req.creds.pass;
        const calendar = decodeURIComponent(req.params.calendar);
        const { token, expiresAt } = icalTokens.issue({ user, pass, calendar });
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const url = `${proto}://${host}/v1/public/ical/${token}.ics`;
        reply.code(200);
        return { token, url, createdAt: Date.now(), expiresAt };
    });

    app.get('/v1/me/calendars/:calendar/ical-token', {
        schema: {
            tags: ['calendar'],
            summary: 'Look up the active public iCal token for this calendar',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        token: { type: ['string', 'null'] },
                        url: { type: ['string', 'null'] },
                        createdAt: { type: ['integer', 'null'] },
                        expiresAt: { type: ['integer', 'null'] }
                    }
                }
            }
        }
    }, async (req) => {
        const user = req.creds.user;
        const calendar = decodeURIComponent(req.params.calendar);
        const rec = icalTokens.findByUserCalendar(user, calendar);
        if (!rec) return { token: null, url: null, createdAt: null, expiresAt: null };
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        return {
            token: rec.token,
            url: `${proto}://${host}/v1/public/ical/${rec.token}.ics`,
            createdAt: rec.createdAt,
            expiresAt: rec.expiresAt
        };
    });

    app.delete('/v1/me/calendars/:calendar/ical-token', {
        schema: { tags: ['calendar'], summary: 'Revoke the public iCal token for this calendar' }
    }, async (req, reply) => {
        const user = req.creds.user;
        const calendar = decodeURIComponent(req.params.calendar);
        icalTokens.revoke(user, calendar);
        reply.code(204);
    });

    // PUBLIC: served unauthenticated using the stored token credentials.
    app.get('/v1/public/ical/:token.ics', {
        config: { public: true },
        schema: {
            tags: ['calendar'],
            summary: 'Public iCal feed (token-based; share this URL)',
            response: { 200: { type: 'string' }, 404: problemSchema }
        }
    }, async (req, reply) => {
        const rec = icalTokens.get(req.params.token);
        if (!rec) {
            reply.code(404);
            return { type: 'about:blank', title: 'Not Found', status: 404, detail: 'Token unknown or expired' };
        }
        try {
            const now = new Date();
            const start = new Date(now.getFullYear() - 2, now.getMonth(), 1).toISOString();
            const end = new Date(now.getFullYear() + 2, now.getMonth() + 1, 0, 23, 59, 59).toISOString();
            const events = await client.listEvents(rec.user, rec.pass, rec.calendar, start, end);
            reply.header('content-type', 'text/calendar; charset=utf-8');
            reply.header('content-disposition', `inline; filename="${rec.calendar}.ics"`);
            // Conservative cache so feed apps don't hammer SOGo every minute.
            reply.header('cache-control', 'public, max-age=600');
            const base = publicBaseUrl(req);
            const editUrlFor = (uid) => `${base}/v1/public/event/${req.params.token}/${encodeURIComponent(uid)}/edit`;
            return buildIcsBody(events, editUrlFor);
        } catch (err) {
            req.log.warn({ err: err.message }, 'public ical fetch failed');
            reply.code(502);
            return { type: 'about:blank', title: 'Bad Gateway', status: 502, detail: 'Could not fetch calendar from CalDAV' };
        }
    });

    // ── Public anonymous event editing ───────────────────────────────
    // Holders of the calendar's public iCal token can amend any event
    // in that calendar via a server-rendered HTML form. The owner and
    // every ATTENDEE/ORGANIZER on the event get an emailed diff once
    // the change is applied. Treat the calendar token as bearer auth:
    // possession of the .ics URL is what grants edit rights, by design.

    // Form posts use application/x-www-form-urlencoded; register a
    // narrow parser so we don't pull in @fastify/formbody just for one
    // route. Limited to 64 KiB — generous for description text.
    app.addContentTypeParser('application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: 64 * 1024 },
        (_req, body, done) => {
            try {
                const params = new URLSearchParams(body);
                const obj = {};
                for (const [k, v] of params) obj[k] = v;
                done(null, obj);
            } catch (err) {
                done(err, undefined);
            }
        });

    function publicBaseUrl(req) {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        return `${proto}://${host}`;
    }

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Format a UTC ISO string (YYYY-MM-DDTHH:mm:ssZ) into the value
    // expected by <input type="datetime-local"> (YYYY-MM-DDTHH:mm,
    // browser-local, no timezone). We can't easily get the viewer's
    // tz on the server, so we render in UTC and label the field
    // accordingly. The browser sends a tz-less local string back; we
    // re-interpret as UTC on save (consistent with the input).
    function isoToInput(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }

    function inputToIso(local) {
        if (!local || typeof local !== 'string') return null;
        // Trust the browser's datetime-local format. Append Z so we
        // re-anchor the wall-clock value to UTC, matching the input
        // we rendered into the form.
        const m = local.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
        if (!m) return null;
        return `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}Z`;
    }

    function renderEditPage({ token, uid, fields, error, calendar }) {
        const safeSummary = escHtml(fields.summary || '');
        const safeLocation = escHtml(fields.location || '');
        const safeDescription = escHtml(fields.description || '');
        const safeStart = escHtml(isoToInput(fields.start));
        const safeEnd = escHtml(isoToInput(fields.end));
        const safeCal = escHtml(calendar || '');
        const action = `/v1/public/event/${encodeURIComponent(token)}/${encodeURIComponent(uid)}/edit`;
        const errorBlock = error ? `<div class="err">${escHtml(error)}</div>` : '';
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>Edit event — ${safeSummary || 'untitled'}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f4f4f6; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #1a1a1f; color: #f4f4f6; } .card { background: #24242b !important; box-shadow: 0 8px 28px rgba(0,0,0,0.4) !important; } input, textarea { background: #1a1a1f !important; color: #f4f4f6 !important; border-color: #3a3a44 !important; } }
  .wrap { max-width: 520px; margin: 32px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 14px; padding: 20px 22px; box-shadow: 0 4px 22px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #888; margin-bottom: 18px; }
  label { display: block; font-size: 12px; font-weight: 600; margin: 12px 0 4px; letter-spacing: 0.02em; }
  input[type=text], input[type=datetime-local], textarea {
    width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; border: 1px solid #d4d4dc; border-radius: 8px;
  }
  textarea { min-height: 90px; resize: vertical; }
  .row { display: flex; gap: 10px; }
  .row > * { flex: 1; }
  .actions { margin-top: 20px; display: flex; gap: 10px; align-items: center; justify-content: flex-end; }
  .btn { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer; }
  .btn.primary { background: #3b82f6; color: white; }
  .btn.primary:hover { background: #2563eb; }
  .btn.ghost { background: transparent; color: #666; }
  .err { background: #fee2e2; color: #991b1b; padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
  .hint { font-size: 11.5px; color: #888; margin-top: 6px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Edit event</h1>
    <div class="sub">${safeCal} · anonymous edit</div>
    ${errorBlock}
    <form method="post" action="${escHtml(action)}" autocomplete="off">
      <label>Title</label>
      <input type="text" name="summary" value="${safeSummary}" required maxlength="200" />

      <div class="row">
        <div>
          <label>Start (UTC)</label>
          <input type="datetime-local" name="start" value="${safeStart}" required />
        </div>
        <div>
          <label>End (UTC)</label>
          <input type="datetime-local" name="end" value="${safeEnd}" required />
        </div>
      </div>

      <label>Location</label>
      <input type="text" name="location" value="${safeLocation}" maxlength="300" />

      <label>Description</label>
      <textarea name="description" maxlength="4000">${safeDescription}</textarea>

      <div class="hint">Saving will email the organiser and every attendee a summary of what changed.</div>
      <div class="actions">
        <button type="submit" class="btn primary">Save changes</button>
      </div>
    </form>
  </div>
</div>
</body>
</html>`;
    }

    function renderSavedPage({ summary, calendar }) {
        return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>Saved</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #f4f4f6; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #1a1a1f; color: #f4f4f6; } .card { background: #24242b !important; } }
  .wrap { max-width: 480px; margin: 64px auto; padding: 0 16px; text-align: center; }
  .card { background: #fff; border-radius: 14px; padding: 28px 22px; box-shadow: 0 4px 22px rgba(0,0,0,0.08); }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: #888; font-size: 13px; }
  .ok { color: #059669; font-size: 36px; line-height: 1; margin-bottom: 8px; }
</style></head><body>
<div class="wrap"><div class="card">
  <div class="ok">&#10003;</div>
  <h1>Changes saved</h1>
  <div class="sub">${escHtml(summary || 'event')} on ${escHtml(calendar)} updated. Attendees have been notified by email.</div>
</div></div></body></html>`;
    }

    function renderErrorPage({ status, title, detail }) {
        return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${escHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f4f4f6;color:#111}.wrap{max-width:480px;margin:64px auto;padding:0 16px;text-align:center}.card{background:#fff;border-radius:14px;padding:28px 22px;box-shadow:0 4px 22px rgba(0,0,0,0.08)}h1{font-size:22px;margin:0 0 6px}.sub{color:#888;font-size:13px}@media(prefers-color-scheme:dark){body{background:#1a1a1f;color:#f4f4f6}.card{background:#24242b}}</style>
</head><body><div class="wrap"><div class="card"><h1>${escHtml(title)}</h1><div class="sub">${escHtml(detail)}</div></div></div></body></html>`;
    }

    app.get('/v1/public/event/:token/:uid/edit', {
        config: { public: true },
        schema: { tags: ['calendar'], summary: 'Public anonymous event-edit form (token-based)' }
    }, async (req, reply) => {
        const rec = icalTokens.get(req.params.token);
        if (!rec) {
            reply.code(404).type('text/html');
            return renderErrorPage({ status: 404, title: 'Not found', detail: 'This calendar share link is unknown or has expired.' });
        }
        const uid = decodeURIComponent(req.params.uid);
        const raw = await client.getEventRaw(rec.user, rec.pass, rec.calendar, uid).catch(() => null);
        if (!raw) {
            reply.code(404).type('text/html');
            return renderErrorPage({ status: 404, title: 'Event not found', detail: 'The event may have been deleted from the calendar.' });
        }
        const unfolded = icsEdit.unfold(raw);
        const split = icsEdit.splitEventByUid(unfolded, uid);
        if (!split) {
            reply.code(404).type('text/html');
            return renderErrorPage({ status: 404, title: 'Event not found', detail: 'The calendar resource does not contain an event with this ID.' });
        }
        const fields = icsEdit.readEventFields(split.vevent);
        reply.type('text/html').header('cache-control', 'no-store').header('x-robots-tag', 'noindex,nofollow');
        return renderEditPage({ token: req.params.token, uid, fields, calendar: rec.calendar });
    });

    app.post('/v1/public/event/:token/:uid/edit', {
        config: { public: true },
        schema: { tags: ['calendar'], summary: 'Apply an anonymous event edit and notify attendees' }
    }, async (req, reply) => {
        const rec = icalTokens.get(req.params.token);
        if (!rec) {
            reply.code(404).type('text/html');
            return renderErrorPage({ status: 404, title: 'Not found', detail: 'This calendar share link is unknown or has expired.' });
        }
        const uid = decodeURIComponent(req.params.uid);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const summary = (body.summary || '').toString().trim();
        const startLocal = (body.start || '').toString().trim();
        const endLocal = (body.end || '').toString().trim();
        const location = (body.location || '').toString();
        const description = (body.description || '').toString();
        const startIso = inputToIso(startLocal);
        const endIso = inputToIso(endLocal);

        const renderWithError = async (msg) => {
            reply.code(400).type('text/html').header('cache-control', 'no-store');
            const raw = await client.getEventRaw(rec.user, rec.pass, rec.calendar, uid).catch(() => null);
            const unfolded = raw ? icsEdit.unfold(raw) : '';
            const split = unfolded ? icsEdit.splitEventByUid(unfolded, uid) : null;
            const fields = split ? icsEdit.readEventFields(split.vevent) : { summary, start: startIso, end: endIso, location, description };
            // Echo back the user's submitted values so they don't lose typing.
            return renderEditPage({
                token: req.params.token, uid,
                fields: { summary, start: startIso || fields.start, end: endIso || fields.end, location, description },
                error: msg, calendar: rec.calendar
            });
        };
        if (!summary) return renderWithError('Title is required.');
        if (!startIso || !endIso) return renderWithError('Start and end must both be valid date/times.');
        if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
            return renderWithError('End time must be after start time.');
        }

        let raw;
        try {
            raw = await client.getEventRaw(rec.user, rec.pass, rec.calendar, uid);
        } catch (err) {
            req.log.warn({ err: err.message }, 'public edit: fetch raw failed');
            reply.code(502).type('text/html');
            return renderErrorPage({ status: 502, title: 'Could not load event', detail: 'The calendar server is unreachable. Try again in a moment.' });
        }
        if (!raw) {
            reply.code(404).type('text/html');
            return renderErrorPage({ status: 404, title: 'Event not found', detail: 'The event may have been deleted.' });
        }
        const unfolded = icsEdit.unfold(raw);
        const split = icsEdit.splitEventByUid(unfolded, uid);
        if (!split) {
            reply.code(404).type('text/html');
            return renderErrorPage({ status: 404, title: 'Event not found', detail: 'The calendar resource does not contain an event with this ID.' });
        }

        const before = icsEdit.readEventFields(split.vevent);
        const attendees = icsEdit.readAttendeeEmails(split.vevent);
        const updatedVevent = icsEdit.applyEdits(split.vevent, {
            summary, start: startIso, end: endIso, location, description
        });
        const newCalendar = icsEdit.refoldVcalendar(split.before + updatedVevent + split.after);

        try {
            await client.putEventRaw(rec.user, rec.pass, rec.calendar, uid, newCalendar);
        } catch (err) {
            req.log.warn({ err: err.message }, 'public edit: put failed');
            reply.code(502).type('text/html');
            return renderErrorPage({ status: 502, title: 'Could not save', detail: 'The calendar server rejected the update. Try again later.' });
        }

        // Fire the notification email; failure here must not block the
        // success page (the edit itself already landed).
        try {
            await sendEditNotification({
                ownerEmail: rec.user,
                ownerPass: rec.pass,
                attendees,
                calendar: rec.calendar,
                before,
                after: { summary, start: startIso, end: endIso, location, description },
                req
            });
        } catch (err) {
            req.log.warn({ err: err.message }, 'public edit: notify failed');
        }

        reply.type('text/html').header('cache-control', 'no-store').header('x-robots-tag', 'noindex,nofollow');
        return renderSavedPage({ summary, calendar: rec.calendar });
    });

    async function sendEditNotification({ ownerEmail, ownerPass, attendees, calendar, before, after, req }) {
        if (!smtp || !smtp.host) {
            req.log.info('skip edit notification: SMTP not configured');
            return;
        }
        const recipients = new Set([ownerEmail.toLowerCase(), ...attendees.map((a) => a.toLowerCase())]);
        if (recipients.size === 0) return;

        const fmtDate = (iso) => {
            if (!iso) return '';
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return iso;
            return d.toUTCString();
        };
        const diffRows = [];
        const fields = [
            ['Title', 'summary', (v) => v || '(empty)'],
            ['Start', 'start', fmtDate],
            ['End', 'end', fmtDate],
            ['Location', 'location', (v) => v || '(none)'],
            ['Description', 'description', (v) => v || '(none)']
        ];
        for (const [label, key, fmt] of fields) {
            const oldV = fmt(before[key] || '');
            const newV = fmt(after[key] || '');
            if (oldV !== newV) diffRows.push({ label, oldV, newV });
        }
        if (diffRows.length === 0) return; // nothing actually changed

        const escHtmlMail = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        const subject = `Event edited: ${after.summary || before.summary || '(untitled)'}`;
        const textLines = [
            `An event on calendar "${calendar}" was edited via its public share link.`,
            '',
            'Changes:',
            ...diffRows.map((r) => `  • ${r.label}: ${r.oldV} → ${r.newV}`),
            '',
            'If you didn\'t expect this, the calendar owner can rotate the share link to invalidate the edit URL.'
        ];
        const text = textLines.join('\n');
        const htmlRows = diffRows.map((r) => `
            <tr>
              <td style="padding:6px 10px;font-weight:600;color:#555;border-bottom:1px solid #eee;vertical-align:top">${escHtmlMail(r.label)}</td>
              <td style="padding:6px 10px;color:#a33;border-bottom:1px solid #eee;text-decoration:line-through;vertical-align:top">${escHtmlMail(r.oldV)}</td>
              <td style="padding:6px 10px;color:#0a7;border-bottom:1px solid #eee;vertical-align:top">${escHtmlMail(r.newV)}</td>
            </tr>`).join('');
        const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111">
            <p>An event on calendar <strong>${escHtmlMail(calendar)}</strong> was edited via its public share link.</p>
            <table style="border-collapse:collapse;width:100%;margin-top:8px">
              <thead><tr><th style="text-align:left;padding:6px 10px;font-size:12px;color:#888">Field</th><th style="text-align:left;padding:6px 10px;font-size:12px;color:#888">Was</th><th style="text-align:left;padding:6px 10px;font-size:12px;color:#888">Now</th></tr></thead>
              <tbody>${htmlRows}</tbody>
            </table>
            <p style="font-size:12px;color:#888;margin-top:18px">If you didn't expect this, the calendar owner can rotate the share link to invalidate the edit URL.</p>
        </body></html>`;

        await sendMessage({
            smtpConfig: smtp,
            user: ownerEmail,
            pass: ownerPass,
            from: ownerEmail,
            to: [...recipients].join(', '),
            subject,
            text,
            html
        });
    }

    app.delete('/v1/me/calendars/:calendar/events/:uid', {
        schema: {
            tags: ['calendar'],
            summary: 'Delete a calendar event by UID',
            response: {
                204: { type: 'null' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        requirePassword(req);
        const user = req.creds.user;
        const pass = req.creds.pass;
        const calendar = decodeURIComponent(req.params.calendar);
        const uid = decodeURIComponent(req.params.uid);
        try {
            await client.deleteEvent(user, pass, calendar, uid);
            reply.code(204).send();
        } catch (err) {
            if (err.status === 404) throw problem(404, 'Not Found', 'Event not found');
            throw err;
        }
    });
};
