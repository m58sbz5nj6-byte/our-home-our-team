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
  const fields = {syncSource: {stringValue: 'icloud-family'}};
  for (const key of ['title', 'startDate', 'lastDate', 'startTime', 'timeLabel']) {
    if (typeof event[key] === 'string') fields[key] = {stringValue: event[key]};
  }
  return {update: {name: root + '/calendarEvents/' + event.id, fields}};
}

export async function writeCalendarEvents(events, env, fetcher = fetch) {
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
  const imported = writes.length;
  const keep = new Set(writes.map(write => write.update.name));
  const collection = root + '/calendarEvents';
  let pageToken;
  do {
    const query = new URLSearchParams({pageSize: '100', 'mask.fieldPaths': 'syncSource'});
    if (pageToken) query.set('pageToken', pageToken);
    const response = await fetcher('https://firestore.googleapis.com/v1/' + collection + '?' + query, {
      headers: {Authorization: 'Bearer ' + auth.idToken}
    });
    if (!response.ok) throw new Error('Firestore calendar list failed (HTTP ' + response.status + ')');
    const page = await response.json();
    for (const entry of page.documents || []) {
      if (!entry.name?.startsWith(collection + '/') || keep.has(entry.name)
        || entry.fields?.syncSource?.stringValue !== 'icloud-family') continue;
      if (!entry.updateTime) throw new Error('Calendar document has no update time');
      writes.push({delete: entry.name, currentDocument: {updateTime: entry.updateTime}});
    }
    if (writes.length > 400) throw new Error('Calendar batch exceeds the sync limit');
    pageToken = page.nextPageToken;
  } while (pageToken);
  if (writes.length) await post('https://firestore.googleapis.com/v1/' + root + ':commit',
    {writes}, fetcher, 'Firestore calendar commit', auth.idToken);
  return imported;
}
