'use strict';

// Surgical edit helpers for raw VCALENDAR text. Used by the public
// event-edit endpoint so we preserve fields the regular parser ignores
// (ATTENDEE, ORGANIZER, RRULE, VALARM, SEQUENCE, …) while still
// rewriting the handful the form lets the user change.
//
// Round-trips are line-level: we unfold (RFC 5545 §3.1), match a single
// VEVENT block, replace one property at a time, then refold. Anything
// we don't touch survives untouched.

const { escapeIcalText, unescapeIcalText, foldLine, formatIcalDate } = require('./caldav-client');

function unfold(text) {
    return text.replace(/\r?\n[ \t]/g, '');
}

// Normalise a DTSTART/DTEND line's value to YYYY-MM-DDTHH:mm:ss[Z] (or a
// bare YYYY-MM-DD for all-day). The TZID parameter is dropped here, so a
// zoned value reads back as its wall-clock time.
function parseIcsDate(line) {
    // line shape: "DTSTART;TZID=...:20260101T123000" or "DTSTART:20260101T123000Z"
    const colon = line.indexOf(':');
    if (colon < 0) return null;
    const v = line.slice(colon + 1).trim();
    const clean = v.replace(/Z$/, '');
    if (/^\d{8}T\d{6}$/.test(clean)) {
        const iso = `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}`;
        // If original ended in Z, treat as UTC; otherwise floating local.
        return v.endsWith('Z') ? `${iso}Z` : iso;
    }
    if (/^\d{8}$/.test(clean)) {
        return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
    }
    return v;
}

// Split a component block into lines, tagging each with its bare property
// name (upper-cased, '' when the line has no ':') and whether it belongs to
// the block itself. Lines inside a nested component (a VALARM's DESCRIPTION,
// say) are not the event's own and must never be read or rewritten as such.
// The block's own BEGIN line, when it is the first, is not counted as nested.
function scanLines(text) {
    let nested = 0;
    return text.split(/\r?\n/).map((line, i) => {
        const colon = line.indexOf(':');
        const key = colon >= 0 ? line.slice(0, colon).split(';')[0].toUpperCase() : '';
        let own = nested === 0;
        if (key === 'BEGIN' && i > 0) {
            nested++;
            own = false;
        } else if (key === 'END' && nested > 0) {
            nested--;
            own = false;
        }
        return { line, key, own };
    });
}

// Read a single property line from inside a VEVENT block. Returns null
// if not found. Property name match is case-insensitive on the bare key
// before any ';' parameter or ':' delimiter.
function readProperty(veventText, key) {
    const upper = key.toUpperCase();
    const hit = scanLines(veventText).find((l) => l.own && l.key === upper);
    return hit ? hit.line : null;
}

// Read all property lines (handles ATTENDEE which appears multiple times).
function readAllProperties(veventText, key) {
    const upper = key.toUpperCase();
    return scanLines(veventText).filter((l) => l.own && l.key === upper).map((l) => l.line);
}

// Pull one VEVENT block out by UID. Returns { before, vevent, after } or
// null if no match. Used to scope edits to a specific event when the
// .ics resource happens to contain multiple components (e.g. recurring
// override exceptions live alongside the master).
function splitEventByUid(unfoldedText, uid) {
    const re = /BEGIN:VEVENT\r?\n[\s\S]*?END:VEVENT/g;
    let m;
    while ((m = re.exec(unfoldedText)) !== null) {
        const block = m[0];
        const uidLine = readProperty(block, 'UID');
        if (!uidLine) continue;
        const colon = uidLine.indexOf(':');
        const v = uidLine.slice(colon + 1).trim();
        if (v === uid) {
            return {
                before: unfoldedText.slice(0, m.index),
                vevent: block,
                after: unfoldedText.slice(m.index + block.length)
            };
        }
    }
    return null;
}

// Replace the first occurrence of a property line, or insert one before
// END:VEVENT if it's missing. Removing is achieved by passing newLine = null.
function setProperty(veventText, key, newLine) {
    const upper = key.toUpperCase();
    let replaced = false;
    const out = [];
    for (const { line, key: lineKey, own } of scanLines(veventText)) {
        if (own && lineKey === upper) {
            if (!replaced) {
                if (newLine) out.push(newLine);
                replaced = true;
            }
            // Drop subsequent same-key lines (we only edit single-valued props here).
            continue;
        }
        out.push(line);
    }
    if (!replaced && newLine) {
        // Insert before END:VEVENT.
        const endIdx = out.findIndex((l) => l.trim().toUpperCase() === 'END:VEVENT');
        if (endIdx >= 0) out.splice(endIdx, 0, newLine);
        else out.push(newLine);
    }
    return out.join('\r\n');
}

// Bump the SEQUENCE counter so attendee clients accept the update as a
// newer revision (RFC 5545 §3.8.7.4).
function bumpSequence(veventText) {
    const cur = readProperty(veventText, 'SEQUENCE');
    let next = 1;
    if (cur) {
        const colon = cur.indexOf(':');
        const n = parseInt(cur.slice(colon + 1).trim(), 10);
        if (Number.isFinite(n) && n >= 0) next = n + 1;
    }
    return setProperty(veventText, 'SEQUENCE', `SEQUENCE:${next}`);
}

// Refresh DTSTAMP (last-mod-equivalent for METHOD:PUBLISH).
function refreshDtstamp(veventText) {
    const stamp = formatIcalDate(new Date().toISOString());
    return setProperty(veventText, 'DTSTAMP', `DTSTAMP:${stamp}`);
}

// True when the VEVENT is a recurring master or an override. A time change
// on one reshapes the whole series, which an anonymous link-holder should
// not be able to do; callers that can't allow that check this first.
function hasRecurrence(veventText) {
    return /^(RRULE|RDATE|EXDATE|RECURRENCE-ID)[;:]/im.test(String(veventText || ''));
}

// Render a DTSTART/DTEND line for a new wall-clock value, keeping the form
// the event already uses: TZID events stay in their zone, all-day events
// stay all-day, floating stays floating. Only a UTC (or absent) original
// is written as a UTC instant.
function dateTimeLine(key, existingLine, iso) {
    const compact = formatIcalDate(iso);
    const colon = existingLine ? existingLine.indexOf(':') : -1;
    if (colon >= 0) {
        const params = existingLine.slice(0, colon).split(';').slice(1);
        const tzid = params.find((p) => /^TZID=/i.test(p));
        if (tzid) return `${key};${tzid}:${compact.slice(0, -1)}`;
        if (params.some((p) => /^VALUE=DATE$/i.test(p))) return `${key};VALUE=DATE:${compact.slice(0, 8)}`;
        const value = existingLine.slice(colon + 1).trim();
        if (value && !/Z$/i.test(value)) return `${key}:${compact.slice(0, -1)}`;
    }
    return `${key}:${compact}`;
}

// Apply form-supplied changes to a parsed VEVENT block. Only fields
// the user can edit; nothing else is touched. start/end are wall-clock
// values (YYYY-MM-DDTHH:mm:ssZ as rendered by the form) and should only be
// passed when they actually changed.
function applyEdits(veventText, edits) {
    let v = veventText;
    if (Object.prototype.hasOwnProperty.call(edits, 'summary')) {
        v = setProperty(v, 'SUMMARY', `SUMMARY:${escapeIcalText(edits.summary || '')}`);
    }
    if (Object.prototype.hasOwnProperty.call(edits, 'start')) {
        v = setProperty(v, 'DTSTART', dateTimeLine('DTSTART', readProperty(v, 'DTSTART'), edits.start));
    }
    if (Object.prototype.hasOwnProperty.call(edits, 'end')) {
        v = setProperty(v, 'DTEND', dateTimeLine('DTEND', readProperty(v, 'DTEND') || readProperty(v, 'DTSTART'), edits.end));
        // DTEND and DURATION are mutually exclusive.
        v = setProperty(v, 'DURATION', null);
    }
    if (Object.prototype.hasOwnProperty.call(edits, 'location')) {
        const loc = edits.location || '';
        v = setProperty(v, 'LOCATION', loc ? `LOCATION:${escapeIcalText(loc)}` : null);
    }
    if (Object.prototype.hasOwnProperty.call(edits, 'description')) {
        const desc = edits.description || '';
        v = setProperty(v, 'DESCRIPTION', desc ? `DESCRIPTION:${escapeIcalText(desc)}` : null);
    }
    v = bumpSequence(v);
    v = refreshDtstamp(v);
    return v;
}

// Extract the readable subset of an event we use for the form prefill
// and the diff in the notification email.
function readEventFields(veventText) {
    const summaryLine = readProperty(veventText, 'SUMMARY');
    const dtstartLine = readProperty(veventText, 'DTSTART');
    const dtendLine = readProperty(veventText, 'DTEND');
    const locationLine = readProperty(veventText, 'LOCATION');
    const descriptionLine = readProperty(veventText, 'DESCRIPTION');
    const valueAfterColon = (line) => {
        if (!line) return '';
        const colon = line.indexOf(':');
        return colon < 0 ? '' : unescapeIcalText(line.slice(colon + 1));
    };
    return {
        summary: valueAfterColon(summaryLine),
        start: dtstartLine ? parseIcsDate(dtstartLine) : '',
        end: dtendLine ? parseIcsDate(dtendLine) : '',
        location: valueAfterColon(locationLine),
        description: valueAfterColon(descriptionLine)
    };
}

// Plain mailbox only: no display names, groups, quoting, or header
// separators, since these addresses end up in a To: header.
const MAILBOX_RE = /^[a-z0-9._%+'-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

// Pull email addresses out of ATTENDEE / ORGANIZER lines. Each is of
// the form "ATTENDEE;CN=Name;ROLE=...:mailto:foo@example.com". Values that
// are not a plain mailbox are dropped.
function readAttendeeEmails(veventText) {
    const out = new Set();
    const collect = (lines) => {
        for (const line of lines) {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const v = line.slice(colon + 1).trim();
            const m = v.match(/^mailto:(.+)$/i);
            if (m) {
                const addr = m[1].trim().toLowerCase();
                if (addr.length <= 254 && MAILBOX_RE.test(addr)) out.add(addr);
            }
        }
    };
    collect(readAllProperties(veventText, 'ATTENDEE'));
    collect(readAllProperties(veventText, 'ORGANIZER'));
    return [...out];
}

// Re-fold every line in a VCALENDAR string to RFC 5545 75-octet limits.
function refoldVcalendar(unfoldedText) {
    return unfoldedText
        .split(/\r?\n/)
        .map((line) => foldLine(line))
        .join('\r\n');
}

// Properties a public feed may publish for a VEVENT. An allow-list on purpose:
// the feed is readable by anyone holding its link, so an unknown or vendor
// property (X-ALT-DESC HTML, X-GOOGLE-CONFERENCE, CONFERENCE dial-in codes,
// ATTACH, COMMENT, CONTACT, GEO) is dropped rather than republished. Attendee
// addresses, alarms and invitation state are also left out: the feed carries
// no invitation semantics. Anything not listed here is stripped.
const FEED_EVENT_PROPERTIES = new Set([
    'BEGIN', 'END', 'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION',
    'RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'RECURRENCE-ID', 'SUMMARY',
    'DESCRIPTION', 'LOCATION', 'URL', 'STATUS', 'SEQUENCE', 'CATEGORIES',
    'CLASS', 'TRANSP', 'LAST-MODIFIED', 'CREATED', 'PRIORITY'
]);

// Pull the VTIMEZONE and VEVENT blocks out of a calendar-data string so a
// feed can republish them as stored (RRULE, TZID, all-day dates and the
// rest survive) instead of re-synthesising events from a few fields.
function extractFeedComponents(calendarText) {
    const text = unfold(String(calendarText || ''));
    const timezones = [];
    const events = [];
    for (const m of text.matchAll(/BEGIN:VTIMEZONE\r?\n[\s\S]*?END:VTIMEZONE/g)) {
        const tzid = readProperty(m[0], 'TZID');
        timezones.push({ tzid: tzid ? tzid.slice(tzid.indexOf(':') + 1).trim() : '', text: m[0] });
    }
    for (const m of text.matchAll(/BEGIN:VEVENT\r?\n[\s\S]*?END:VEVENT/g)) {
        const kept = scanLines(m[0])
            .filter((l) => l.own && FEED_EVENT_PROPERTIES.has(l.key))
            .map((l) => l.line);
        events.push(kept.join('\r\n'));
    }
    return { timezones, events };
}

// Add the public edit link to a VEVENT for a feed: a banner at the head of
// DESCRIPTION, an "Edit:" LOCATION when none is set, URL, and an HTML
// alternative description. See buildIcsBody in routes/calendar.js.
function addEditLink(veventText, editUrl) {
    const fields = readEventFields(veventText);
    const banner = [
        '── ✏️ Edit this event ──',
        'Click to update without signing in:',
        editUrl,
        ''
    ].join('\n');
    const description = banner + (fields.description ? fields.description.trim() : '');
    let v = setProperty(veventText, 'DESCRIPTION', `DESCRIPTION:${escapeIcalText(description)}`);
    if (!fields.location) v = setProperty(v, 'LOCATION', `LOCATION:${escapeIcalText(`Edit: ${editUrl}`)}`);
    if (!readProperty(v, 'URL')) v = setProperty(v, 'URL', `URL:${editUrl}`);
    const html = `<p>✏️ <a href="${editUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Edit this event</a> — no sign-in required.</p>`;
    return setProperty(v, 'X-ALT-DESC', `X-ALT-DESC;FMTTYPE=text/html:${escapeIcalText(html)}`);
}

// Value of a property (unescaped), or '' when absent.
function readPropertyValue(veventText, key) {
    const line = readProperty(veventText, key);
    if (!line) return '';
    const colon = line.indexOf(':');
    return colon < 0 ? '' : line.slice(colon + 1).trim();
}

module.exports = {
    hasRecurrence,
    unfold,
    refoldVcalendar,
    splitEventByUid,
    readEventFields,
    readAttendeeEmails,
    readPropertyValue,
    extractFeedComponents,
    addEditLink,
    applyEdits,
    formatIcalDate
};
