import test from 'node:test';
import assert from 'node:assert/strict';
import {readFamilyCalendar} from './icloud.mjs';
import {writeCalendarEvents} from './firestore.mjs';
import {syncCalendar} from './worker.mjs';

const env = {
  ICLOUD_ACCOUNT: 'stub@example.invalid',
  ICLOUD_APP_PASSWORD: 'synthetic',
  ICLOUD_CALENDAR_URL: 'https://caldav.icloud.com/example/calendars/family/',
  FIREBASE_SYNC_EMAIL: 'sync@example.invalid',
  FIREBASE_SYNC_PASSWORD: 'synthetic',
  FIREBASE_WEB_API_KEY: 'synthetic'
};
const calendar = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'BEGIN:VEVENT',
  'UID:example-event', 'DTSTAMP:20261126T120000Z', 'DTSTART:20261127T150000Z',
  'DTEND:20261127T160000Z', 'SUMMARY:Sample event', 'END:VEVENT', 'END:VCALENDAR'
].join('\r\n');
const xml = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
  + '<d:response><d:propstat><d:prop><c:calendar-data><![CDATA[' + calendar
  + ']]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';

test('imports a sampled CalDAV response into the calendar collection', async () => {
  let commit;
  const fetcher = async (url, request) => {
    const host = new URL(url).hostname;
    if (host === 'caldav.icloud.com') {
      assert.equal(request.method, 'REPORT');
      return new Response(xml, {status: 207});
    }
    if (host === 'identitytoolkit.googleapis.com') return Response.json({idToken: 'stub-token'});
    assert.equal(host, 'firestore.googleapis.com');
    assert.equal(request.headers.Authorization, 'Bearer stub-token');
    commit = JSON.parse(request.body);
    return Response.json({});
  };
  const count = await syncCalendar(env, Date.UTC(2026, 10, 27),
    (config, start, end) => readFamilyCalendar(config, start, end, fetcher),
    (events, config) => writeCalendarEvents(events, config, fetcher));
  assert.equal(count, 1);
  const event = commit.writes[0].update;
  assert.match(event.name, /\/calendarEvents\/[a-f0-9]{64}$/);
  assert.equal(event.fields.title.stringValue, 'Sample event');
  assert.equal(event.fields.startDate.stringValue, '2026-11-28');
  assert.equal(event.fields.startTime.stringValue, '01:30');
  assert.equal(event.fields.assignee, undefined);
});
