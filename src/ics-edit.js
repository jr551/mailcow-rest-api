'use strict';

// Surgical edit helpers for raw VCALENDAR text. Used by the public
// event-edit endpoint so we preserve fields the regular parser ignores
// (ATTENDEE, ORGANIZER, RRULE, VALARM, SEQUENCE, …) while still
// rewriting the handful the form lets the user change.
//
// Round-trips are line-level: we unfold (RFC 5545 §3.1), match a single
// VEVENT block, replace one property at a time, then refold. Anything
// we don't touch survives untouched.

function unfold(text) {
    return text.replace(/\r?\n[ \t]/g, '');
}

function fold(line) {
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

function unescapeIcalText(text) {
    return String(text)
        .replace(/\\n/gi, '\n')
        .replace(/\\;/g, ';')
        .replace(/\\,/g, ',')
        .replace(/\\\\/g, '\\');
}

function formatIcalDate(isoString) {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${isoString}`);
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Strip TZID parameter (we always rewrite as UTC) and normalise to one
// of the canonical forms parseIcsDate understands.
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

// Read a single property line from inside a VEVENT block. Returns null
// if not found. Property name match is case-insensitive on the bare key
// before any ';' parameter or ':' delimiter.
function readProperty(veventText, key) {
    const lines = veventText.split(/\r?\n/);
    const upper = key.toUpperCase();
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const head = line.slice(0, colon);
        const bareKey = head.split(';')[0].toUpperCase();
        if (bareKey === upper) return line;
    }
    return null;
}

// Read all property lines (handles ATTENDEE which appears multiple times).
function readAllProperties(veventText, key) {
    const lines = veventText.split(/\r?\n/);
    const upper = key.toUpperCase();
    const out = [];
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const head = line.slice(0, colon);
        const bareKey = head.split(';')[0].toUpperCase();
        if (bareKey === upper) out.push(line);
    }
    return out;
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
    const lines = veventText.split(/\r?\n/);
    const upper = key.toUpperCase();
    let replaced = false;
    const out = [];
    for (const line of lines) {
        const colon = line.indexOf(':');
        const bareKey = colon >= 0 ? line.slice(0, colon).split(';')[0].toUpperCase() : '';
        if (bareKey === upper) {
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

// Apply form-supplied changes to a parsed VEVENT block. Only fields
// the user can edit; nothing else is touched.
function applyEdits(veventText, edits) {
    let v = veventText;
    if (Object.prototype.hasOwnProperty.call(edits, 'summary')) {
        v = setProperty(v, 'SUMMARY', `SUMMARY:${escapeIcalText(edits.summary || '')}`);
    }
    if (Object.prototype.hasOwnProperty.call(edits, 'start')) {
        v = setProperty(v, 'DTSTART', `DTSTART:${formatIcalDate(edits.start)}`);
    }
    if (Object.prototype.hasOwnProperty.call(edits, 'end')) {
        v = setProperty(v, 'DTEND', `DTEND:${formatIcalDate(edits.end)}`);
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

// Pull email addresses out of ATTENDEE / ORGANIZER lines. Each is of
// the form "ATTENDEE;CN=Name;ROLE=...:mailto:foo@example.com".
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
                if (addr) out.add(addr);
            }
        }
    };
    collect(readAllProperties(veventText, 'ATTENDEE'));
    collect(readAllProperties(veventText, 'ORGANIZER'));
    return [...out];
}

// Re-fold every line in a VCALENDAR string to RFC 5545 75-char limits.
function refoldVcalendar(unfoldedText) {
    return unfoldedText
        .split(/\r?\n/)
        .map((line) => fold(line))
        .join('\r\n');
}

module.exports = {
    unfold,
    refoldVcalendar,
    splitEventByUid,
    readEventFields,
    readAttendeeEmails,
    applyEdits,
    formatIcalDate
};
