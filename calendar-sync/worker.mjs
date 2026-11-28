import {readFamilyCalendar} from './icloud.mjs';
import {writeCalendarEvents} from './firestore.mjs';

const dayMs = 86400000;
const safeHttpError = /^(?:iCloud calendar query|Firebase sign-in|Firestore calendar list|Firestore calendar commit) failed \(HTTP \d{3}\)$/;
const safeDetails = new Set([
  'Unexpected declaration in calendar response',
  'iCloud did not return a CalDAV multistatus',
  'iCloud returned an incomplete calendar resource',
  'iCloud returned an unexpanded recurring event',
  'iCloud returned an event with no ID or start',
  'Invalid calendar sync window',
  'iCloud sync configuration is incomplete',
  'Expected a private iCloud CalDAV collection URL',
  'Invalid normalised calendar event',
  'Calendar batch exceeds the sync limit',
  'Firebase sync configuration is incomplete',
  'Missing Firebase ID token',
  'Calendar document has no update time'
]);

function stageError(stage, error) {
  const detail = error?.message;
  // Only include known messages. Network errors can contain private URLs.
  if (safeHttpError.test(detail) || safeDetails.has(detail)) {
    return new Error(stage + ': ' + detail);
  }
  return new Error(stage + ': unexpected error');
}

export async function syncCalendar(env, scheduledTime, read = readFamilyCalendar, write = writeCalendarEvents) {
  const start = new Date(scheduledTime - 31 * dayMs);
  const end = new Date(scheduledTime + 90 * dayMs);
  let events;
  try {
    events = await read(env, start, end);
  } catch (error) {
    throw stageError('iCloud calendar read failed', error);
  }
  try {
    return await write(events, env);
  } catch (error) {
    throw stageError('Firebase calendar sync failed', error);
  }
}

export default {
  scheduled(controller, env) {
    return syncCalendar(env, controller.scheduledTime);
  }
};
