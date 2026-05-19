'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateIcal, parseIcal, formatIcalDate } = require('../../src/caldav-client');

test('formatIcalDate converts ISO to iCal format', () => {
    assert.equal(formatIcalDate('2026-05-01T10:00:00Z'), '20260501T100000Z');
});

test('formatIcalDate rejects invalid date', () => {
    assert.throws(() => formatIcalDate('not-a-date'), /Invalid date/);
});

test('generateIcal creates valid VCALENDAR with required fields', () => {
    const ical = generateIcal({
        summary: 'Team Meeting',
        start: '2026-05-01T10:00:00Z',
        end: '2026-05-01T11:00:00Z'
    });
    assert.ok(ical.includes('BEGIN:VCALENDAR'));
    assert.ok(ical.includes('VERSION:2.0'));
    assert.ok(ical.includes('BEGIN:VEVENT'));
    assert.ok(ical.includes('SUMMARY:Team Meeting'));
    assert.ok(ical.includes('DTSTART:20260501T100000Z'));
    assert.ok(ical.includes('DTEND:20260501T110000Z'));
    assert.ok(ical.includes('UID:'));
    assert.ok(ical.includes('END:VEVENT'));
    assert.ok(ical.includes('END:VCALENDAR'));
});

test('generateIcal includes optional description and location', () => {
    const ical = generateIcal({
        summary: 'Lunch',
        start: '2026-05-01T12:00:00Z',
        end: '2026-05-01T13:00:00Z',
        description: 'Team lunch\nAt the pub',
        location: 'The Red Lion'
    });
    assert.ok(ical.includes('DESCRIPTION:Team lunch\\nAt the pub'));
    assert.ok(ical.includes('LOCATION:The Red Lion'));
});

test('generateIcal escapes special chars', () => {
    const ical = generateIcal({
        summary: 'Meeting; with, special\\chars',
        start: '2026-05-01T10:00:00Z',
        end: '2026-05-01T11:00:00Z'
    });
    assert.ok(ical.includes('SUMMARY:Meeting\\; with\\, special\\\\chars'));
});

test('generateIcal uses provided uid', () => {
    const ical = generateIcal({
        uid: 'my-custom-uid@example.com',
        summary: 'X',
        start: '2026-05-01T10:00:00Z',
        end: '2026-05-01T11:00:00Z'
    });
    assert.ok(ical.includes('UID:my-custom-uid@example.com'));
});

test('parseIcal extracts event fields', () => {
    const ical = generateIcal({
        uid: 'evt-1',
        summary: 'Test Event',
        start: '2026-05-01T10:00:00Z',
        end: '2026-05-01T11:00:00Z',
        description: 'Details here',
        location: 'Room A'
    });
    const events = parseIcal(ical);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.uid, 'evt-1');
    assert.equal(ev.summary, 'Test Event');
    assert.equal(ev.dtstart, '2026-05-01T10:00:00');
    assert.equal(ev.dtend, '2026-05-01T11:00:00');
    assert.equal(ev.description, 'Details here');
    assert.equal(ev.location, 'Room A');
});

test('parseIcal handles multiple VEVENTs', () => {
    const ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:First\r\nDTSTART:20260501T100000Z\r\nDTEND:20260501T110000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Second\r\nDTSTART:20260502T100000Z\r\nDTEND:20260502T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const events = parseIcal(ical);
    assert.equal(events.length, 2);
    assert.equal(events[0].summary, 'First');
    assert.equal(events[1].summary, 'Second');
});

test('parseIcal handles folded lines', () => {
    const ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:This is a very long summary that has been folded across multiple\r\n lines for transport\r\nDTSTART:20260501T100000Z\r\nDTEND:20260501T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const events = parseIcal(ical);
    assert.equal(events.length, 1);
    assert.ok(events[0].summary.includes('folded'));
});

test('parseIcal handles all-day date', () => {
    const ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:All Day\r\nDTSTART;VALUE=DATE:20260501\r\nDTEND;VALUE=DATE:20260502\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const events = parseIcal(ical);
    assert.equal(events[0].dtstart, '2026-05-01');
});
