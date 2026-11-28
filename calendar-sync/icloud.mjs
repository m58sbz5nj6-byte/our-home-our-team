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

function privateCalendarUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol === 'https:' && /^(?:p\d+-)?caldav\.icloud\.com$/.test(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && !/^\/published(?:\/|$)/i.test(url.pathname)) return url;
  } catch {
    // Invalid configuration can be replaced by authenticated discovery.
  }
  return null;
}

function davProperties(resource) {
  return list(resource?.propstat)
    .filter(item => /^HTTP\/\S+ 200\b/.test(item.status))
    .map(item => item.prop);
}

async function findFamilyCalendar(authorization, fetcher) {
  async function properties(url, depth, fields) {
    const body = '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
      + fields + '</d:prop></d:propfind>';
    for (let redirects = 0; redirects < 5; redirects++) {
      if (!url) throw new Error('iCloud calendar discovery returned an unexpected address');
      const response = await fetcher(url, {
        method: 'PROPFIND', redirect: 'manual',
        headers: {Authorization: authorization, Depth: depth, 'Content-Type': 'application/xml; charset=utf-8'},
        body
      });
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get('Location');
        url = location ? privateCalendarUrl(location, url) : null;
        continue;
      }
      if (response.status !== 207) throw new Error('iCloud calendar discovery failed (HTTP ' + response.status + ')');
      const xml = await response.text();
      if (/<!DOCTYPE/i.test(xml)) throw new Error('Unexpected declaration in calendar response');
      const parsed = new XMLParser({removeNSPrefix: true, parseTagValue: false}).parse(xml);
      if (!parsed.multistatus) throw new Error('iCloud did not return a CalDAV multistatus');
      return {url, resources: list(parsed.multistatus.response)};
    }
    throw new Error('iCloud calendar discovery returned too many redirects');
  }

  const server = await properties(new URL('https://caldav.icloud.com/'), '0', '<d:current-user-principal/>');
  const principal = server.resources.flatMap(davProperties)
    .map(prop => prop?.['current-user-principal']?.href).find(value => typeof value === 'string' && value);
  if (!principal) throw new Error('iCloud calendar discovery found no account address');
  const account = await properties(privateCalendarUrl(principal, server.url), '0', '<c:calendar-home-set/>');
  const homes = account.resources.flatMap(davProperties)
    .flatMap(prop => list(prop?.['calendar-home-set']?.href));
  if (!homes.length) throw new Error('iCloud calendar discovery found no calendar home');
  const matches = new Map();
  for (const home of new Set(homes)) {
    const calendars = await properties(privateCalendarUrl(home, account.url), '1', '<d:displayname/><d:resourcetype/>');
    for (const resource of calendars.resources) {
      const props = davProperties(resource);
      if (!props.some(prop => Object.hasOwn(prop?.resourcetype ?? {}, 'calendar'))
        || !props.some(prop => prop?.displayname?.trim?.().toLowerCase() === 'family')) continue;
      const url = resource.href && privateCalendarUrl(resource.href, calendars.url);
      if (!url) throw new Error('iCloud calendar discovery returned an unexpected address');
      matches.set(url.href, url);
    }
  }
  if (matches.size !== 1) throw new Error('iCloud calendar discovery requires exactly one Family calendar');
  return matches.values().next().value;
}

export async function readFamilyCalendar(env, start, end, fetcher = fetch) {
  if (!(Number.isFinite(+start) && Number.isFinite(+end) && +start < +end)) {
    throw new Error('Invalid calendar sync window');
  }
  if (!env.ICLOUD_ACCOUNT || !env.ICLOUD_APP_PASSWORD) {
    throw new Error('iCloud sync configuration is incomplete');
  }
  const authorization = 'Basic ' + btoa(env.ICLOUD_ACCOUNT + ':' + env.ICLOUD_APP_PASSWORD);
  const url = (env.ICLOUD_CALENDAR_URL && privateCalendarUrl(env.ICLOUD_CALENDAR_URL))
    || await findFamilyCalendar(authorization, fetcher);
  const range = 'start="' + rangeValue(start) + '" end="' + rangeValue(end) + '"';
  const body = '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:prop><c:calendar-data><c:expand ' + range + '/></c:calendar-data></d:prop>'
    + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
    + '<c:time-range ' + range + '/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
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
