import ICAL from 'ical.js';
import {XMLParser} from 'fast-xml-parser';

const zone = 'Australia/Adelaide';
const dayFormat = new Intl.DateTimeFormat('en-AU', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
});
const clock = new Intl.DateTimeFormat('en-AU', {
  timeZone: zone, hour: 'numeric', minute: '2-digit'
});

function adelaideDate(instant) {
  const parts = Object.fromEntries(dayFormat.formatToParts(instant).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function rangeValue(instant) {
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function list(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function calendarPayloads(xml) {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('Unexpected declaration in calendar response');
  const parsed = new XMLParser({
    removeNSPrefix: true, parseTagValue: false, trimValues: false
  }).parse(xml);
  if (!parsed.multistatus) throw new Error('iCloud did not return a CalDAV multistatus');
  const result = [];
  for (const resource of list(parsed.multistatus.response)) {
    const properties = list(resource.propstat).filter(item => /^HTTP\/\S+ 200\b/.test(item.status));
    const payload = properties.map(item => item.prop?.['calendar-data']).find(item => typeof item === 'string');
    if (!payload) throw new Error('iCloud returned an incomplete calendar resource');
    result.push(payload);
  }
  return result;
}

function localParts(value) {
  const text = value.toString();
  if (value.isDate) return {date: text, time: '', label: 'All day'};
  if (value.zone.tzid === 'floating') {
    const time = text.slice(11, 16);
    const [hour, minute] = time.split(':');
    return {date: text.slice(0, 10), time, label: ((+hour % 12) || 12) + ':' + minute + (+hour < 12 ? ' am' : ' pm')};
  }
  const instant = value.toJSDate();
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(instant);
  return {date: adelaideDate(instant), time, label: clock.format(instant)};
}

async function eventId(uid, recurrenceId) {
  const bytes = new TextEncoder().encode(JSON.stringify([uid, recurrenceId]));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

async function readPayload(text) {
  const calendar = new ICAL.Component(ICAL.parse(text));
  for (const definition of calendar.getAllSubcomponents('vtimezone')) {
    const timezone = new ICAL.Timezone({component: definition});
    ICAL.TimezoneService.register(timezone);
  }
  const events = [];
  for (const component of calendar.getAllSubcomponents('vevent')) {
    if (String(component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') continue;
    if (component.hasProperty('rrule') || component.hasProperty('rdate')) {
      throw new Error('iCloud returned an unexpanded recurring event');
    }
    const event = new ICAL.Event(component);
    if (!event.uid || !event.startDate) throw new Error('iCloud returned an event with no ID or start');
    const start = localParts(event.startDate);
    const end = event.endDate;
    let lastDate = start.date;
    if (end && end.compare(event.startDate) > 0) {
      // DTEND is exclusive, including for multi-day all-day events.
      const inclusiveEnd = end.clone();
      inclusiveEnd.addDuration(ICAL.Duration.fromSeconds(end.isDate ? -86400 : -1));
      lastDate = localParts(inclusiveEnd).date;
    }
    events.push({
      id: await eventId(event.uid, event.recurrenceId?.toString() || ''),
      title: event.summary || 'Untitled event',
      startDate: start.date, lastDate, startTime: start.time, timeLabel: start.label
    });
  }
  return events;
}

export async function readFamilyCalendar(env, start, end, fetcher = fetch) {
  if (!(Number.isFinite(+start) && Number.isFinite(+end) && +start < +end)) {
    throw new Error('Invalid calendar sync window');
  }
  if (!env.ICLOUD_CALENDAR_URL || !env.ICLOUD_ACCOUNT || !env.ICLOUD_APP_PASSWORD) {
    throw new Error('iCloud sync configuration is incomplete');
  }
  const url = new URL(env.ICLOUD_CALENDAR_URL);
  if (url.protocol !== 'https:' || !/^(?:p\d+-)?caldav\.icloud\.com$/.test(url.hostname)
    || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Expected a private iCloud CalDAV collection URL');
  }
  const range = 'start="' + rangeValue(start) + '" end="' + rangeValue(end) + '"';
  const body = '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:prop><c:calendar-data><c:expand ' + range + '/></c:calendar-data></d:prop>'
    + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
    + '<c:time-range ' + range + '/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
  const authorization = 'Basic ' + btoa(env.ICLOUD_ACCOUNT + ':' + env.ICLOUD_APP_PASSWORD);
  const response = await fetcher(url, {
    method: 'REPORT', redirect: 'error',
    headers: {Authorization: authorization, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8'},
    body
  });
  if (response.status !== 207) throw new Error('iCloud calendar query failed (HTTP ' + response.status + ')');
  const events = new Map();
  for (const payload of calendarPayloads(await response.text())) {
    for (const event of await readPayload(payload)) events.set(event.id, event);
  }
  return [...events.values()];
}
