import {readFamilyCalendar} from './icloud.mjs';
import {writeCalendarEvents} from './firestore.mjs';

const dayMs = 86400000;

export async function syncCalendar(env, scheduledTime, read = readFamilyCalendar, write = writeCalendarEvents) {
  const start = new Date(scheduledTime - 31 * dayMs);
  const end = new Date(scheduledTime + 90 * dayMs);
  const events = await read(env, start, end);
  return write(events, env);
}

export default {
  async scheduled(controller, env) {
    try {
      await syncCalendar(env, controller.scheduledTime);
    } catch (error) {
      // Keep provider responses, event data and credentials out of Worker logs.
      const safeMessages = /^(?:iCloud calendar query|Firebase sign-in|Firestore calendar commit) failed \(HTTP \d{3}\)$/;
      const message = safeMessages.test(error?.message) ? error.message : 'Calendar sync failed';
      throw new Error(message);
    }
  }
};
