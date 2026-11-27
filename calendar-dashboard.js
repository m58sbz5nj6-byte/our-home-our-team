import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth,onAuthStateChanged,signInWithEmailAndPassword,signOut} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {getFirestore,doc,collection,onSnapshot,setDoc,deleteDoc,serverTimestamp,writeBatch} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {seed} from './tasks.js';
const app=initializeApp({apiKey:'AIzaSyBNvvpFmBpFhDJhNQX1_3ggCi6ChvHp_Bc',authDomain:'our-home-our-team.firebaseapp.com',projectId:'our-home-our-team',storageBucket:'our-home-our-team.firebasestorage.app',messagingSenderId:'439552559356',appId:'1:439552559356:web:e7aee51d4f6abd1469ef79'}),auth=getAuth(app),db=getFirestore(app);
const $=id=>document.getElementById(id), names={dad:'Dad',mum:'Mum',child1:'Child 1',child2:'Child 2',shared:'Shared'};let user,member,templates=[],records={},settings={},subs=[],loaded=false,editing=null;
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};const notice=t=>$('notice').textContent=t;const fail=e=>notice(e.message||String(e));const btn=(t,fn,cls)=>{let b=el('button',t,cls);b.type='button';b.onclick=()=>Promise.resolve().then(fn).catch(fail);return b};
function day(){let p=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Adelaide',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());let v=k=>p.find(x=>x.type===k).value;return v('year')+'-'+v('month')+'-'+v('day')}function iso(d){return d.toISOString().slice(0,10)}function date(s){return new Date(s+'T00:00:00Z')}function monday(s){let d=date(s);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return iso(d)}function weeks(a,b){return Math.round((date(a)-date(b))/604800000)}function cycle(){return ((weeks(monday(day()),settings.start||monday(day()))%4)+4)%4+1}function due(t){let d=day(),m=monday(d),w=cycle();if(t.frequency==='daily')return d;if(t.frequency==='weekly')return m;if(t.frequency==='rotation'&&t.week===w)return m;if(t.frequency==='fortnightly'&&w%2===1)return m;if(t.frequency==='monthly')return d.slice(0,7);if(t.frequency==='quarterly'&&[1,4,7,10].includes(+d.slice(5,7)))return d.slice(0,7);if(t.frequency==='halfyearly'&&[1,7].includes(+d.slice(5,7)))return d.slice(0,7);return null}
function items(){return templates.map(t=>{let p=due(t);return p?{...t,key:t.id+'_'+p,period:p,record:records[t.id+'_'+p]}:null}).filter(Boolean)}

const profiles = ['dad', 'mum', 'child1', 'child2', 'shared'];
const defaultNames = {...names};
const periods = ['Day', 'Week', 'Month'];
let person = null;
let view = 'home';
let period = 0;
let page = 0;
let showCompleted = false;
const pageSize = 4;

function scheduledGroup(task) {
  if (task.frequency === 'daily') return 0;
  if (['weekly', 'fortnightly', 'rotation'].includes(task.frequency)) return 1;
  return 2;
}

function go(next, profile = null) {
  view = next;
  person = profile;
  period = 0;
  page = 0;
  editing = null;
  showCompleted = false;
  render();
  window.scrollTo(0, 0);
  const heading = $(next === 'home' ? 'dashboardTitle' : next === 'calendar' ? 'calendarTitle' : 'viewTitle');
  heading.focus();
}

$('signin').onsubmit = async event => {
  event.preventDefault();
  try {
    notice('Signing in…');
    await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);
    $('password').value = '';
  } catch (error) {
    fail(error);
  }
};
$('logout').onclick = () => signOut(auth).catch(fail);
$('dashboardTab').onclick = () => go('home');
$('calendarTab').onclick = () => go('calendar');
$('signinTab').onclick = () => $('email').focus();
$('back').onclick = () => go('home');
$('manageTab').onclick = () => go('manage');
$('historyTab').onclick = () => go('history');

onAuthStateChanged(auth, account => {
  subs.forEach(stop => stop());
  subs = [];
  user = account;
  member = null;
  templates = [];
  records = {};
  settings = {};
  Object.assign(names, defaultNames);
  loaded = false;
  view = 'home';
  $('home').hidden = true;
  $('logout').hidden = !account;
  $('signinTab').hidden = Boolean(account);
  for (const id of ['dashboardTab', 'calendarTab', 'manageTab', 'historyTab']) $(id).hidden = true;
  $('login').hidden = Boolean(account);
  notice(account ? 'Checking household access…' : '');
  if (!account) return;
  subs.push(onSnapshot(doc(db, 'members', account.uid), {includeMetadataChanges: true}, snapshot => {
    if (snapshot.metadata.fromCache) return;
    if (!snapshot.exists()) {
      subs.splice(1).forEach(stop => stop());
      member = null;
      loaded = false;
      $('home').hidden = true;
      for (const id of ['dashboardTab', 'calendarTab', 'manageTab', 'historyTab']) $(id).hidden = true;
      notice('Firebase could not find a household profile for this sign-in.');
      return;
    }
    const alreadyListening = Boolean(member);
    member = snapshot.data();
    $('home').hidden = false;
    for (const id of ['dashboardTab', 'calendarTab', 'historyTab']) $(id).hidden = false;
    $('manageTab').hidden = member.role !== 'adult';
    if (alreadyListening) {
      if (view === 'manage' && member.role !== 'adult') go('home');
      return;
    }
    notice('');
    render();
    let tasksReady = false;
    let activityReady = false;
    let configReady = false;
    const refresh = () => {
      loaded = tasksReady && activityReady && configReady;
      if (view !== 'manage' || !editing) render();
    };
    subs.push(
      onSnapshot(doc(db, 'config', 'household'), snap => {
        settings = snap.data() || {};
        for (const profile of profiles) names[profile] = settings.names?.[profile] || defaultNames[profile];
        configReady = true;
        refresh();
      }, fail),
      onSnapshot(collection(db, 'tasks'), snap => {
        templates = snap.docs.map(item => ({id: item.id, ...item.data()}));
        tasksReady = true;
        refresh();
      }, fail),
      onSnapshot(collection(db, 'activity'), snap => {
        records = Object.fromEntries(snap.docs.map(item => [item.id, item.data()]));
        activityReady = true;
        refresh();
      }, fail)
    );
  }, fail));
});

async function change(task, status) {
  await setDoc(doc(db, 'activity', task.key), {
    taskId: task.id, period: task.period, status, actor: member.profile,
    actorUid: user.uid, updatedAt: serverTimestamp(), title: task.title,
    assignee: task.assignee
  });
}

function choreHeading(title) {
  return typeof title === 'string' ? title.replace(/\band\b/gi, '&') : title;
}

function choreCard(task) {
  const status = task.record?.status || 'todo';
  const card = el('article', undefined, 'task ' + status);
  const info = el('div', undefined, 'info');
  const statusText = {todo: 'To do', doing: 'In progress', done: 'Done'};
  info.append(el('strong', choreHeading(task.title)), el('small', task.area), el('span', statusText[status], 'tag'));
  card.append(info);
  const canUpdate = member.role === 'adult'
    || (task.safe && [member.profile, 'shared'].includes(task.assignee));
  if (canUpdate) {
    const actions = el('div', undefined, 'actions');
    if (status === 'todo') actions.append(btn('Start', () => change(task, 'doing'), 'start'));
    if (status !== 'done') actions.append(btn('Done', () => change(task, 'done')));
    if (status !== 'todo') actions.append(btn(status === 'done' ? 'Undo' : 'Reset', () => change(task, 'todo'), 'undo'));
    card.append(actions);
  }
  return card;
}

function render() {
  if (!member) return;
  $('dashboard').hidden = view !== 'home';
  $('detail').hidden = view === 'home' || view === 'calendar';
  $('calendarView').hidden = view !== 'calendar';
  const current = {home: 'dashboardTab', chores: 'dashboardTab', calendar: 'calendarTab', manage: 'manageTab', history: 'historyTab'}[view];
  for (const id of ['dashboardTab', 'calendarTab', 'manageTab', 'historyTab']) {
    if (id === current) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  if (view === 'calendar') {
    renderMonth();
    return;
  }
  $('detail').dataset.profile = view === 'chores' ? person : '';
  $('week').textContent = 'Rotation week ' + cycle() + ' of 4';
  const list = loaded ? items() : [];
  if (view === 'home') {
    const cards = $('people');
    cards.textContent = '';
    if (!loaded) {
      cards.append(el('p', 'Loading chores…'));
      return;
    }
    for (const profile of profiles) {
      const assigned = list.filter(task => task.assignee === profile && task.record?.status !== 'done');
      const card = btn('', () => go('chores', profile), 'family-card');
      card.dataset.profile = profile;
      const counts = el('span', undefined, 'chore-counts');
      periods.forEach((label, index) => {
        const count = assigned.filter(task => scheduledGroup(task) === index).length;
        const cell = el('span');
        cell.append(el('strong', String(count)), el('span', label));
        counts.append(cell);
      });
      card.append(el('strong', names[profile], 'family-name'), counts);
      cards.append(card);
    }
    return;
  }

  const content = $('content');
  const controls = $('detailControls');
  content.textContent = '';
  controls.textContent = '';
  content.className = '';
  $('viewTitle').textContent = view === 'chores' ? names[person] : view === 'manage' ? 'Manage chores' : 'History';
  if (!loaded) {
    content.append(el('p', 'Loading chores…'));
    return;
  }
  if (view === 'manage') {
    manage(content);
    return;
  }
  if (view === 'history') {
    Object.values(records).sort((a,b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0)).forEach(record => {
      const row = el('div', undefined, 'task');
      row.append(el('strong', choreHeading(record.title)), el('span', record.status + ' · ' + record.period));
      content.append(row);
    });
    if (!content.childElementCount) content.append(el('p', 'No activity yet.'));
    return;
  }

  const assigned = list.filter(task => task.assignee === person);
  periods.forEach((label, index) => {
    const control = btn(label, () => { period = index; page = 0; render(); }, period === index ? '' : 'secondary');
    control.setAttribute('aria-pressed', String(period === index));
    controls.append(control);
  });
  const toggle = btn(showCompleted ? 'Hide done' : 'Show done', () => {
    showCompleted = !showCompleted;
    page = 0;
    render();
  }, 'secondary');
  toggle.setAttribute('aria-pressed', String(showCompleted));
  controls.append(toggle);
  const matching = assigned.filter(task => scheduledGroup(task) === period
    && (showCompleted || task.record?.status !== 'done'));
  const pages = Math.max(1, Math.ceil(matching.length / pageSize));
  page = Math.min(page, pages - 1);
  const grid = el('div', undefined, 'chore-grid');
  matching.slice(page * pageSize, (page + 1) * pageSize).forEach(task => grid.append(choreCard(task)));
  content.append(grid);
  if (!matching.length) content.append(el('p', showCompleted ? 'No chores due here.' : 'All caught up!', 'empty'));
  if (pages > 1) {
    const nav = el('div', undefined, 'chore-pages');
    const previous = btn('Previous', () => { page--; render(); }, 'secondary');
    const next = btn('Next', () => { page++; render(); }, 'secondary');
    previous.disabled = page === 0;
    next.disabled = page === pages - 1;
    nav.append(previous, el('span', (page + 1) + ' of ' + pages), next);
    content.append(nav);
  }
}
function manage(c){if(member.role!=='adult')return;if(!templates.length)c.append(btn('Load starter roster',async()=>{let b=writeBatch(db);seed.forEach((t,i)=>b.set(doc(db,'tasks','starter'+i),t));b.set(doc(db,'config','household'),{...settings,start:monday(day())});await b.commit();notice('Starter roster loaded.')}));let start=el('input');start.type='date';start.value=settings.start||monday(day());c.append(el('h2','Cycle start (Monday)'),start,btn('Save cycle start',()=>setDoc(doc(db,'config','household'),{...settings,start:monday(start.value)})));let nameInputs={};c.append(el('h2','Family names'));for(const p of ['dad','mum','child1','child2']){let l=el('label',names[p]+' '),i=el('input');i.value=names[p];nameInputs[p]=i;l.append(i);c.append(l)}c.append(btn('Save names',()=>setDoc(doc(db,'config','household'),{...settings,start:settings.start||monday(day()),names:Object.fromEntries(Object.entries(nameInputs).map(([p,i])=>[p,i.value.trim()||names[p]]))})));c.append(el('h2','Edit roster'),btn('Add job',()=>{editing={title:'',area:'Household',assignee:'shared',frequency:'weekly',week:1,safe:false};render()}));if(editing){let e=el('div',undefined,'editor'),fields={};for(let [k,label,opts] of [['title','Job'],['area','Area'],['assignee','Assigned to',Object.keys(names)],['frequency','Frequency',['daily','weekly','fortnightly','rotation','monthly','quarterly','halfyearly']],['week','Rotation week',['1','2','3','4']]]){let l=el('label',label),i=el(opts?'select':'input');if(opts)opts.forEach(o=>{let op=el('option',names[o]||o);op.value=o;i.append(op)});i.value=editing[k];fields[k]=i;l.append(i);e.append(l)}let safe=el('input');safe.type='checkbox';safe.checked=editing.safe;let l=el('label',' Child-safe job ');l.prepend(safe);e.append(l,btn('Save job',async()=>{let t=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value]));t.week=+t.week;t.safe=safe.checked;if(!t.title.trim())throw Error('Enter a job name');if(!t.safe&&['child1','child2'].includes(t.assignee))throw Error('Adult-only job must be assigned to an adult or shared');let id=editing.id||doc(collection(db,'tasks')).id;await setDoc(doc(db,'tasks',id),t);editing=null;render()}),btn('Cancel',()=>{editing=null;render()},'secondary'));c.append(e)}templates.forEach(t=>{let x=el('div',undefined,'task'),i=el('div',undefined,'info');i.append(el('strong',choreHeading(t.title)),el('small',`${names[t.assignee]} · ${t.frequency}${t.frequency==='rotation'?' '+t.week:''}`));x.append(i,btn('Edit',()=>{editing=t;render();window.scrollTo(0,0)},'secondary'),btn('Delete',async()=>{if(confirm('Delete this recurring job?'))await deleteDoc(doc(db,'tasks',t.id))},'secondary'));c.append(x)})}

let visibleMonth = date(day().slice(0, 7) + '-01');
const monthFormat = new Intl.DateTimeFormat('en-AU', {month: 'long', year: 'numeric', timeZone: 'UTC'});

function monthCells(month) {
  const start = date(monday(iso(month)));
  return Array.from({length: 42}, (_, index) => new Date(start.getTime() + index * 86400000));
}

function renderMonth() {
  $('calendarTitle').textContent = monthFormat.format(visibleMonth);
  const grid = $('calendarGrid');
  grid.textContent = '';
  for (const label of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    grid.append(el('strong', label, 'weekday'));
  }
  const today = day();
  for (const cell of monthCells(visibleMonth)) {
    const tile = el('div', undefined, 'month-day');
    if (cell.getUTCMonth() !== visibleMonth.getUTCMonth()) tile.classList.add('outside-month');
    const number = el('time', String(cell.getUTCDate()));
    number.dateTime = iso(cell);
    if (number.dateTime === today) number.setAttribute('aria-current', 'date');
    tile.append(number);
    grid.append(tile);
  }
}

function stepMonth(step) {
  visibleMonth.setUTCMonth(visibleMonth.getUTCMonth() + step);
  renderMonth();
}
$('previousMonth').onclick = () => stepMonth(-1);
$('nextMonth').onclick = () => stepMonth(1);
$('currentMonth').onclick = () => {
  visibleMonth = date(day().slice(0, 7) + '-01');
  renderMonth();
};

const headerDateFormat = new Intl.DateTimeFormat('en-AU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC'
});
function updateHeaderDate(today) {
  const headerDate = $('headerDate');
  headerDate.dateTime = today;
  headerDate.textContent = headerDateFormat.format(date(today));
}
let lastDay = day();
updateHeaderDate(lastDay);
setInterval(() => {
  const today = day();
  if (today === lastDay) return;
  lastDay = today;
  updateHeaderDate(today);
  if (member && view !== 'manage') render();
}, 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
