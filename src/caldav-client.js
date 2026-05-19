'use strict';

const { request, Agent } = require('undici');
const { XMLParser } = require('fast-xml-parser');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// iCalendar helpers
// ---------------------------------------------------------------------------

function formatIcalDate(isoString) {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${isoString}`);
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function foldLine(line) {
    if (line.length <= 75) return line;
    let out = line.slice(0, 75);
    let rest = line.slice(75);
    while (rest.length > 0) {
        const chunk = rest.slice(0, 74);
        out += '\r\n ' + chunk;
        rest = rest.slice(74);
    }
    return out;
}

function escapeIcalText(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
}

function generateIcal(event) {
    const uid = event.uid || `${crypto.randomUUID()}@mailcow-rest-api`;
    const dtstamp = formatIcalDate(new Date().toISOString());
    const dtstart = formatIcalDate(event.start);
    const dtend = formatIcalDate(event.end);
    const summary = escapeIcalText(event.summary || '');
    const description = event.description ? escapeIcalText(event.description) : null;
    const location = event.location ? escapeIcalText(event.location) : null;

    let lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//mailcow-rest-api//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${dtstart}`,
        `DTEND:${dtend}`,
        `SUMMARY:${summary}`
    ];
    if (description) lines.push(`DESCRIPTION:${description}`);
    if (location) lines.push(`LOCATION:${location}`);
    lines.push('END:VEVENT');
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
}

function parseIcal(icalText) {
    const text = icalText.replace(/\r\n[ \t]/g, ''); // unfold
    const events = [];
    const veventRegex = /BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g;
    let m;
    while ((m = veventRegex.exec(text)) !== null) {
        const block = m[1];
        const event = {};
        const lines = block.split(/\r?\n/);
        for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx < 0) continue;
            const key = line.slice(0, idx).split(';')[0];
            let value = line.slice(idx + 1);
            value = value.replace(/\\n/g, '\n').replace(/\\;/g, ';').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
            if (key === 'DTSTART' || key === 'DTEND' || key === 'DTSTAMP') {
                // Parse iCal date/time to ISO
                const clean = value.replace(/Z$/, '');
                if (/^\d{8}T\d{6}$/.test(clean)) {
                    event[key.toLowerCase()] = `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}`;
                } else if (/^\d{8}$/.test(clean)) {
                    event[key.toLowerCase()] = `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
                } else {
                    event[key.toLowerCase()] = value;
                }
            } else if (key === 'UID') {
                event.uid = value;
            } else if (key === 'SUMMARY') {
                event.summary = value;
            } else if (key === 'DESCRIPTION') {
                event.description = value;
            } else if (key === 'LOCATION') {
                event.location = value;
            }
        }
        events.push(event);
    }
    return events;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function parseXml(xmlText) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: false,
        parseTagValue: false,
        trimValues: true
    });
    return parser.parse(xmlText);
}

function getResponses(doc) {
    const multi = doc['D:multistatus'] || doc['d:multistatus'] || doc.multistatus;
    if (!multi) return [];
    const resp = multi['D:response'] || multi['d:response'] || multi.response;
    if (!resp) return [];
    return Array.isArray(resp) ? resp : [resp];
}

function getProp(resp) {
    const propstat = resp['D:propstat'] || resp['d:propstat'] || resp.propstat;
    if (!propstat) return null;
    const arr = Array.isArray(propstat) ? propstat : [propstat];
    for (const ps of arr) {
        const status = (ps['D:status'] || ps['d:status'] || ps.status || '');
        if (status.includes('200')) {
            return ps['D:prop'] || ps['d:prop'] || ps.prop;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// CalDAV client
// ---------------------------------------------------------------------------

class CaldavClient {
    constructor({ sogoUrl, timeoutMs = 30000, rejectUnauthorized = true }) {
        if (!sogoUrl) throw new Error('sogoUrl is required');
        this.sogoUrl = sogoUrl.replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
        this.agent = new Agent({ connect: { rejectUnauthorized } });
    }

    _authHeader(user, pass) {
        return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    }

    async _request(method, urlPath, { body, headers = {}, user, pass } = {}) {
        const url = new URL(this.sogoUrl + urlPath);
        const reqHeaders = {
            'authorization': this._authHeader(user, pass),
            ...headers
        };
        const signal = AbortSignal.timeout(this.timeoutMs);
        let res;
        try {
            res = await request(url, { method, headers: reqHeaders, body, signal, dispatcher: this.agent });
        } catch (err) {
            const e = new Error(`Network error: ${err.message}`);
            e.status = 0;
            throw e;
        }
        const status = res.statusCode;
        const text = await res.body.text();
        if (status >= 400) {
            const e = new Error(`CalDAV ${method} ${urlPath} → ${status}: ${text.slice(0, 200)}`);
            e.status = status;
            throw e;
        }
        return text;
    }

    async listCalendars(user, pass) {
        const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <C:calendar-color/>
  </D:prop>
</D:propfind>`;
        const xml = await this._request('PROPFIND', `/dav/${encodeURIComponent(user)}/Calendar/`, {
            body,
            headers: { 'content-type': 'application/xml; charset=utf-8', 'depth': '1' },
            user, pass
        });
        const doc = parseXml(xml);
        const calendars = [];
        for (const resp of getResponses(doc)) {
            const href = resp['D:href'] || resp['d:href'] || resp.href;
            const prop = getProp(resp);
            if (!prop || !href) continue;
            const rt = prop['D:resourcetype'] || prop['d:resourcetype'] || prop.resourcetype;
            if (!rt) continue;
            const cal = rt['C:calendar'] || rt['c:calendar'] || rt.calendar;
            if (!cal) continue;
            const id = href.split('/').filter(Boolean).pop() || '';
            const displayName = prop['D:displayname'] || prop['d:displayname'] || prop.displayname || id;
            const color = prop['C:calendar-color'] || prop['c:calendar-color'] || prop['calendar-color'] || null;
            calendars.push({ id, displayName: String(displayName), color: color ? String(color) : null });
        }
        return calendars;
    }

    async listEvents(user, pass, calendar, start, end) {
        const startStr = formatIcalDate(start);
        const endStr = formatIcalDate(end);
        const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${startStr}" end="${endStr}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
        const xml = await this._request('REPORT', `/dav/${encodeURIComponent(user)}/Calendar/${encodeURIComponent(calendar)}/`, {
            body,
            headers: { 'content-type': 'application/xml; charset=utf-8', 'depth': '1' },
            user, pass
        });
        const doc = parseXml(xml);
        const events = [];
        for (const resp of getResponses(doc)) {
            const prop = getProp(resp);
            if (!prop) continue;
            const calData = prop['C:calendar-data'] || prop['c:calendar-data'] || prop['calendar-data'];
            if (!calData) continue;
            const parsed = parseIcal(String(calData));
            events.push(...parsed);
        }
        return events;
    }

    async getEvent(user, pass, calendar, uid) {
        const ical = await this._request('GET', `/dav/${encodeURIComponent(user)}/Calendar/${encodeURIComponent(calendar)}/${encodeURIComponent(uid)}.ics`, {
            headers: { 'accept': 'text/calendar' },
            user, pass
        });
        const parsed = parseIcal(ical);
        return parsed[0] || null;
    }

    // Returns the raw VCALENDAR text for an event so callers can do a
    // surgical line-level edit and PUT it back without losing fields the
    // parser doesn't know about (ATTENDEE, ORGANIZER, RRULE, VALARM …).
    async getEventRaw(user, pass, calendar, uid) {
        try {
            return await this._request('GET', `/dav/${encodeURIComponent(user)}/Calendar/${encodeURIComponent(calendar)}/${encodeURIComponent(uid)}.ics`, {
                headers: { 'accept': 'text/calendar' },
                user, pass
            });
        } catch (err) {
            if (err.status === 404) return null;
            throw err;
        }
    }

    async putEventRaw(user, pass, calendar, uid, ical) {
        await this._request('PUT', `/dav/${encodeURIComponent(user)}/Calendar/${encodeURIComponent(calendar)}/${encodeURIComponent(uid)}.ics`, {
            body: ical,
            headers: { 'content-type': 'text/calendar; charset=utf-8' },
            user, pass
        });
        return { uid, calendar };
    }

    async createEvent(user, pass, calendar, event) {
        const ical = generateIcal(event);
        const uid = event.uid || (ical.match(/UID:([^\r\n]+)/) || [])[1];
        if (!uid) throw new Error('Failed to generate event UID');
        await this._request('PUT', `/dav/${encodeURIComponent(user)}/Calendar/${encodeURIComponent(calendar)}/${encodeURIComponent(uid)}.ics`, {
            body: ical,
            headers: { 'content-type': 'text/calendar; charset=utf-8' },
            user, pass
        });
        return { uid, calendar };
    }

    async deleteEvent(user, pass, calendar, uid) {
        await this._request('DELETE', `/dav/${encodeURIComponent(user)}/Calendar/${encodeURIComponent(calendar)}/${encodeURIComponent(uid)}.ics`, {
            user, pass
        });
        return { deleted: true, uid };
    }
}

module.exports = { CaldavClient, generateIcal, parseIcal, formatIcalDate };
