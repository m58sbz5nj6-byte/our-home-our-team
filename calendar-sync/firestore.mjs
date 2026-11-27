const project = 'our-home-our-team';
const root = 'projects/' + project + '/databases/(default)/documents';

async function post(url, body, fetcher, stage, token) {
  const headers = {'Content-Type': 'application/json'};
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetcher(url, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(stage + ' failed (HTTP ' + response.status + ')');
  return response.json();
}

function eventWrite(event) {
  if (!/^[a-f0-9]{64}$/.test(event.id) || typeof event.title !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(event.startDate)) {
    throw new Error('Invalid normalised calendar event');
  }
  const fields = {};
  for (const key of ['title', 'startDate', 'lastDate', 'startTime', 'timeLabel']) {
    if (typeof event[key] === 'string') fields[key] = {stringValue: event[key]};
  }
  return {update: {name: root + '/calendarEvents/' + event.id, fields}};
}

export async function writeCalendarEvents(events, env, fetcher = fetch) {
  if (!events.length) return 0;
  const writes = events.map(eventWrite);
  if (writes.length > 400) throw new Error('Calendar batch exceeds the sync limit');
  if (!env.FIREBASE_WEB_API_KEY || !env.FIREBASE_SYNC_EMAIL || !env.FIREBASE_SYNC_PASSWORD) {
    throw new Error('Firebase sync configuration is incomplete');
  }
  const auth = await post(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='
      + encodeURIComponent(env.FIREBASE_WEB_API_KEY),
    {email: env.FIREBASE_SYNC_EMAIL, password: env.FIREBASE_SYNC_PASSWORD, returnSecureToken: true},
    fetcher, 'Firebase sign-in'
  );
  if (typeof auth.idToken !== 'string' || !auth.idToken) throw new Error('Missing Firebase ID token');
  await post('https://firestore.googleapis.com/v1/' + root + ':commit',
    {writes}, fetcher, 'Firestore calendar commit', auth.idToken);
  return writes.length;
}
