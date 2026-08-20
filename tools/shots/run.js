'use strict';

// Look at Slate. Actually look at it.
//
// `npm run drive` clicks every button in the app, but it does it against a
// hand-rolled DOM with no layout engine — it can tell you a button exists and
// that clicking it throws nothing, and it can NEVER tell you the thing looks
// right. Two bugs got through exactly there: every paragraph landing on its own
// page (round 35) and a page fitting 27 lines where Word fits 23 (round 42).
//
// This drives a real browser. Headless Edge (or Chrome), real CSS, real layout,
// real fonts, and a PNG of every page so the result can be eyeballed.
//
// NEVER POINTED AT PORT 4173. It boots its own server on its own database with
// mock Canvas, because walking the app means clicking things, and clicking
// things in Slate marks work complete and saves drafts.
//
//   npm run shots            every page
//   npm run shots tests      just the pages whose name matches

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'dist', 'shots');
const WIDTH = 1400;
const HEIGHT = 1000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Ports come from the OS, never from a guess. A fixed one is how this walked
// straight into the oldest trap in this project: a stray server left listening
// on the chosen port, the new server failing to bind, and the browser happily
// photographing the OLD code while every check came back green. It has bitten
// in rounds 18, 23 and again here.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

// ---- the browser ---------------------------------------------------------
function findBrowser() {
  const e = process.env;
  const candidates = [
    [e['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
    [e.ProgramFiles, 'Microsoft\\Edge\\Application\\msedge.exe'],
    [e.ProgramFiles, 'Google\\Chrome\\Application\\chrome.exe'],
    [e['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'],
    [e.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'],
  ];
  for (const [base, rel] of candidates) {
    if (!base) continue;
    const p = path.join(base, rel);
    try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// A very small DevTools Protocol client. Node has WebSocket built in, so this
// needs nothing installed — the same rule the rest of Slate follows.
class Devtools {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const pending = this.waiting.get(msg.id);
      if (!pending) return;
      this.waiting.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('could not attach to the browser')), { once: true });
    });
    return new Devtools(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(method + ' timed out')); }
      }, 20000);
    });
  }

  // Runs JS in the page and hands back the value.
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description || r.exceptionDetails.text
        : r.exceptionDetails.text);
    }
    return r.result ? r.result.value : undefined;
  }

  async shot(file) {
    // Long pages get photographed in full. Anything FIXED TO THE VIEWPORT does
    // not: stretching the shot to the scroll height of the page behind it
    // shrinks the thing being looked at down to a stamp, and a fixed element
    // only paints once anyway. That is the hand-in overlay and the corner chat
    // panel — both pin the shot to the viewport instead.
    const popupOpen = await this.eval(
      "const o=document.getElementById('overlay');"
      + "const c=document.querySelector('.chat-panel:not(.hidden)');"
      + "return !!c || !!(o && !o.classList.contains('hidden'));"
    ).catch(() => false);
    if (popupOpen) {
      const r0 = await this.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
      });
      fs.writeFileSync(file, Buffer.from(r0.data, 'base64'));
      return { file, height: HEIGHT };
    }
    const { contentSize } = await this.send('Page.getLayoutMetrics');
    const h = Math.min(4000, Math.max(HEIGHT, Math.ceil(contentSize.height)));
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: WIDTH, height: h, scale: 1 },
    });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return { file, height: h };
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

// ---- the pages to walk ---------------------------------------------------
// Finds the slideshow project and leaves its id in `id`. Every slide step
// starts with this so it stands on its own.
const SLIDE_PROJECT = "closePanel(false);"
  + "const ps=await get('/api/projects');"
  + "const ds=await Promise.all(ps.map(p=>get('/api/projects/'+p.id)));"
  + "const s=ds.find(d=>d.build_mode==='slides'); const id = s && s.id;";

// Each step sets up the view in the page, then gets photographed. `setup` runs
// inside the browser and has the app's own state/render to work with.
const STEPS = [
  { name: 'today', setup: "state.view='today'; state.doneTab='unfinished'; await render();" },
  { name: 'today-finished', setup: "state.view='today'; state.doneTab='finished'; await render();" },
  { name: 'today-projects', setup: "state.view='today'; state.todayTab='projects'; state.doneTab='unfinished'; await render();" },
  { name: 'week', setup: "state.todayTab='assignments'; state.view='week'; await render();" },
  {
    name: 'week-day-popup',
    setup: "state.view='week'; await render();"
      + "const d=[...document.querySelectorAll('.day.clickable,.week-day.clickable,.day')].find(x=>x.onclick);"
      + "if(d) d.onclick(); await new Promise(r=>setTimeout(r,400));",
  },
  { name: 'projects', setup: "closePanel(false); state.view='projects'; await render();" },
  { name: 'tests-all', setup: "state.view='tests'; state.testWeeks=0; await render();" },
  { name: 'tests-1-week', setup: "state.view='tests'; state.testWeeks=1; await render();" },
  { name: 'classes', setup: "state.view='classes'; await render();" },
  {
    name: 'class-page',
    setup: "const c=await get('/api/classes'); state.view='class'; state.classId=c[0].id;"
      + " state.classTab='grades'; await render();",
  },
  {
    name: 'assignment-editor',
    setup: "const t=await get('/api/today');"
      + "const ds=await Promise.all(t.assignments.map(a=>get('/api/assignments/'+a.id)));"
      + "const w=ds.find(d=>d.work_mode==='text')||ds[0];"
      + "state.view='work'; state.workId=w.id; await render();"
      + "await new Promise(r=>setTimeout(r,1800));", // let the page meter answer
  },
  {
    // The Ask Claude panel with a real conversation in it. The messages are put
    // straight into the database because this server has AI switched off; the
    // page then renders them through its own normal path.
    name: 'assignment-chat',
    arrange: (dbPath) => {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT id FROM assignments WHERE work_mode='text' ORDER BY id LIMIT 1").get();
      if (!row) { db.close(); return; }
      db.prepare('DELETE FROM chat_messages WHERE assignment_id = ?').run(row.id);
      const add = (role, text) => db
        .prepare('INSERT INTO chat_messages (assignment_id, role, text, created_at) VALUES (?,?,?,?)')
        .run(row.id, role, text, new Date().toISOString());
      add('you', 'I do not really get what this is asking. Where do I even start?');
      add('claude', "Start with what it wants at the end: one worked answer per question, with the steps shown.\n\n"
        + 'The part people trip on is the second half, where you have to justify the method rather than just use it. '
        + 'Do the first question the way you normally would, then write one sentence saying why that method was the right one. '
        + 'If that sentence is hard to write, that is the bit to ask me about.\n\n'
        + 'Which question is giving you the most trouble?');
      add('you', 'the second one. can you fix my grammar first?');
      // A proofread turn, so the change log Slate appends gets photographed too.
      add('claude', 'Fixed three things, all mechanical. I left the wording alone — that is yours.\n\n'
        + 'Changed in your draft (3):\n'
        + '• "Their are three" → "There are three" — wrong word\n'
        + '• "the evidence show" → "the evidence shows" — subject-verb agreement\n'
        + '• "prove the the point" → "prove the point" — doubled word\n\n'
        + 'Now the reasoning. It holds up as far as it goes, but it stops one step short — you say the method '
        + 'works and never say why it beats the alternative, which is the thing being marked. '
        + 'What would you say the alternative gets wrong?');
      db.close();
    },
    setup: "state.chatOpen=false;"
      + "const t=await get('/api/today');"
      + "const ds=await Promise.all(t.assignments.map(a=>get('/api/assignments/'+a.id)));"
      + "const w=ds.find(d=>d.work_mode==='text')||ds[0];"
      + "state.view='work'; state.workId=w.id; await render();"
      + "await new Promise(r=>setTimeout(r,1500));"
      // Opened by clicking the launcher, not by setting the flag — the picture
      // should be of the thing the student actually does.
      + "const l=document.querySelector('.chat-launcher'); if(l) l.click();"
      + "await new Promise(r=>setTimeout(r,500));"
      + "const b=document.querySelector('.chat-input'); if(b) b.value='is that the same as what we did in class?';",
  },
  {
    // The corner launcher, shut, over a page of work — what it looks like when
    // the student is not using it.
    name: 'assignment-chat-closed',
    setup: "state.chatOpen=false;"
      + "const t=await get('/api/today');"
      + "const ds=await Promise.all(t.assignments.map(a=>get('/api/assignments/'+a.id)));"
      + "const w=ds.find(d=>d.work_mode==='text')||ds[0];"
      + "state.view='work'; state.workId=w.id; await render();"
      + "await new Promise(r=>setTimeout(r,1500));",
  },
  {
    name: 'assignment-with-files',
    setup: "const t=await get('/api/today');"
      + "const ds=await Promise.all(t.assignments.map(a=>get('/api/assignments/'+a.id)));"
      + "const w=ds.find(d=>d.files&&d.files.length);"
      + "if(w){ state.view='work'; state.workId=w.id; await render(); }",
  },
  {
    name: 'essay-editor',
    setup: "const ps=await get('/api/projects');"
      + "const ds=await Promise.all(ps.map(p=>get('/api/projects/'+p.id)));"
      + "const e=ds.find(d=>d.build_mode==='essay');"
      + "if(e){ state.view='project'; state.projectId=e.id; await render();"
      + " await new Promise(r=>setTimeout(r,1800)); }",
  },
  {
    name: 'hand-in-popup',
    setup: "const ps=await get('/api/projects');"
      + "const ds=await Promise.all(ps.map(p=>get('/api/projects/'+p.id)));"
      + "const e=ds.find(d=>d.build_mode==='essay');"
      + "if(e){ await openDownloadPopup('essay', e.id, null); await new Promise(r=>setTimeout(r,900)); }",
  },
  // Each step sets itself up from scratch. An earlier version had these three
  // share a project id through a global, so `npm run shots slides-handin`
  // silently photographed the Today page — a filtered run must give the same
  // picture as the full one.
  {
    name: 'slides-editor',
    setup: SLIDE_PROJECT + "if(id){ state.view='project'; state.projectId=id; await render();"
      + " await new Promise(r=>setTimeout(r,1200)); }",
  },
  {
    name: 'slides-handin',
    setup: SLIDE_PROJECT + "if(id){ state.view='project'; state.projectId=id; await render();"
      + " await openDownloadPopup('project', id, null); await new Promise(r=>setTimeout(r,900)); }",
  },
  {
    // Picking a card near the right-hand end has to drag the strip along so
    // the ones after it are still clickable.
    name: 'slides-handin-slide5',
    setup: SLIDE_PROJECT + "if(id){ state.view='project'; state.projectId=id; await render();"
      + " await openDownloadPopup('project', id, null); await new Promise(r=>setTimeout(r,900));"
      + " const t=[...document.querySelectorAll('.pv-thumb')];"
      + " if(t[4]) t[4].onclick(); await new Promise(r=>setTimeout(r,900)); }",
  },
  {
    name: 'slides-handin-slide3',
    setup: SLIDE_PROJECT + "if(id){ state.view='project'; state.projectId=id; await render();"
      + " await openDownloadPopup('project', id, null); await new Promise(r=>setTimeout(r,900));"
      + " const t=[...document.querySelectorAll('.pv-thumb')];"
      + " if(t[2]) t[2].onclick(); await new Promise(r=>setTimeout(r,400)); }",
  },
  {
    // The chat on a slideshow: the boxes it edits are the slide cards behind it.
    name: 'slides-chat',
    setup: SLIDE_PROJECT + "if(id){ state.chatOpen=false; state.view='project'; state.projectId=id; await render();"
      + " await new Promise(r=>setTimeout(r,1400));"
      + " const l=document.querySelector('.chat-launcher'); if(l) l.click();"
      + " await new Promise(r=>setTimeout(r,500));"
      + " const b=document.querySelector('.chat-input'); if(b) b.value='add two bullets to slide 4'; }",
  },
  {
    // The waiting state. chatSpark() is called directly because the real one
    // only appears while a request is in flight, and this server has AI off.
    name: 'slides-chat-thinking',
    setup: SLIDE_PROJECT + "if(id){ state.chatOpen=false; state.view='project'; state.projectId=id; await render();"
      + " await new Promise(r=>setTimeout(r,1400));"
      + " const l=document.querySelector('.chat-launcher'); if(l) l.click();"
      + " await new Promise(r=>setTimeout(r,400));"
      + " const b=document.querySelector('.chat-input'); if(b){ b.value='write notes for slide 3'; }"
      + " const st=document.querySelector('.chat-status'); if(st){ st.innerHTML=''; st.appendChild(chatSpark('Thinking...')); }"
      + " await new Promise(r=>setTimeout(r,300)); }",
  },
  {
    // The sources panel, open, with one row hovered so the box it backs up is
    // lit behind it. The conversation is put in by hand: this server runs with
    // SLATE_NO_AI=1 and cannot go and look anything up.
    name: 'slides-chat-sources',
    arrange: (dbPath) => {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT id FROM assignments WHERE build_mode='slides' ORDER BY id LIMIT 1").get();
      if (!row) { db.close(); return; }
      const slides = [
        { title: 'The Great Compromise', bullets: ['U.S. History'], photo: false, notes: '' },
        { title: 'Why they argued', bullets: ['Virginia Plan: seats by population', 'New Jersey Plan: one vote per state', 'Small states feared being outvoted'], photo: false, notes: 'Set up the fight before the fix.' },
        { title: 'How it was settled', bullets: ['Two houses of Congress'], photo: false, notes: '' },
      ];
      db.prepare('UPDATE assignments SET slides_json=? WHERE id=?').run(JSON.stringify(slides), row.id);
      db.prepare('DELETE FROM chat_messages WHERE assignment_id = ?').run(row.id);
      const add = (role, text, sources) => db
        .prepare('INSERT INTO chat_messages (assignment_id, role, text, sources, created_at) VALUES (?,?,?,?,?)')
        .run(row.id, role, text, sources ? JSON.stringify(sources) : null, new Date().toISOString());
      add('you', 'put researched bullets on slide 2 about why they disagreed, and cite them');
      add('claude', 'Added 3 researched bullets to slide 2.' + String.fromCharCode(10,10)
        + String.fromCharCode(8203,8288,8203) + 'Updated bullets on slide 2.', [
        { title: 'U.S. Senate — A Great Compromise', url: 'https://www.senate.gov/artandhistory/history/minute/Great_Compromise.htm', where: 'slide2.bullets', quote: 'Small states feared being outvoted' },
        { title: 'U.S. Senate — The Virginia Plan, 1787', url: 'https://www.senate.gov/about/chronology/origins-1789/documents/virginia-plan.htm', where: 'slide2.bullets', quote: 'Virginia Plan: seats by population' },
        { title: 'National Constitution Center — Compromises of the Convention', url: 'https://constitutioncenter.org/education/classroom-resource-library', where: 'slide2.notes', quote: 'Set up the fight before the fix.' },
      ]);
      db.close();
    },
    setup: SLIDE_PROJECT + "if(id){ state.chatOpen=false; state.view='project'; state.projectId=id; await render();"
      + " await new Promise(r=>setTimeout(r,1400));"
      + " const l=document.querySelector('.chat-launcher'); if(l) l.click();"
      + " await new Promise(r=>setTimeout(r,700));"
      + " const b=document.querySelector('.src-btn'); if(b) b.click();"
      + " await new Promise(r=>setTimeout(r,300));"
      + " const rows=document.querySelectorAll('.src-row'); if(rows[0]) rows[0].onmouseenter();"
      + " await new Promise(r=>setTimeout(r,500)); }",
  },
  { name: 'email', setup: "closePanel(false); state.view='email'; await render();" },
  { name: 'api-page', setup: "state.view='api'; await render();" },
  { name: 'admin-page', setup: "state.view='admin'; await render();" },
];

// ---- run -----------------------------------------------------------------
(async () => {
  const only = process.argv[2];
  const steps = only ? STEPS.filter((s) => s.name.includes(only)) : STEPS;
  if (!steps.length) {
    console.error(`Nothing matches "${only}". Pages: ${STEPS.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  const browser = findBrowser();
  if (!browser) { console.error('No Edge or Chrome found.'); process.exit(1); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-shots-'));
  fs.mkdirSync(OUT, { recursive: true });
  const PORT = await freePort();
  const CDP_PORT = await freePort();

  // --- its own server, its own database, mock Canvas. Never 4173.
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CANVAS_MODE: 'mock',
      SLATE_OPEN: '0',
      SLATE_NO_AI: '1',
      SLATE_NO_AUTOSYNC: '1',
      SLATE_DB_PATH: path.join(tmp, 'shots.db'),
      SLATE_DATA_DIR: tmp,
      SLATE_DESKTOP_DIR: tmp,
    },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await getJson(base + '/api/status'); up = true; break; } catch { await wait(250); }
  }
  if (!up) { server.kill(); console.error('the server did not start'); process.exit(1); }

  const profile = path.join(tmp, 'profile');
  const chrome = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* not up yet */ }
    await wait(250);
  }
  if (!target) { chrome.kill(); server.kill(); console.error('the browser never answered'); process.exit(1); }

  const dt = await Devtools.connect(target.webSocketDebuggerUrl);
  await dt.send('Page.enable');
  await dt.send('Runtime.enable');

  // Collect anything the page complains about — a screenshot that looks fine
  // can still be sitting on a thrown error.
  const problems = [];
  dt.ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push('exception: ' + (d.exception ? d.exception.description : d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push('console: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  await dt.send('Page.navigate', { url: base + '/' });
  await wait(2500);

  console.log(`Slate on ${base}, shooting ${steps.length} page(s) into dist/shots\n`);
  const results = [];
  for (const step of steps) {
    const before = problems.length;
    try {
      // A step can arrange something the app itself cannot produce here — the
      // shots server runs with SLATE_NO_AI=1, so a conversation has to be put
      // into the database rather than had. Runs in Node, not the page.
      if (step.arrange) await step.arrange(path.join(tmp, 'shots.db'), base);
      await dt.eval(step.setup);
      await wait(700);
      const file = path.join(OUT, step.name + '.png');
      const { height } = await dt.shot(file);
      const errs = problems.slice(before);
      results.push({ name: step.name, height, errors: errs });
      console.log(`  ${errs.length ? 'ERR ' : 'ok  '}${step.name.padEnd(22)} ${WIDTH}x${height}`
        + (errs.length ? '   ' + errs[0].slice(0, 120) : ''));
    } catch (err) {
      results.push({ name: step.name, errors: [err.message] });
      console.log(`  ERR ${step.name.padEnd(22)} ${err.message}`);
    }
  }

  const bad = results.filter((r) => r.errors && r.errors.length);
  console.log(`\n${results.length - bad.length}/${results.length} pages drawn clean`);
  if (bad.length) {
    console.log('\nProblems:');
    for (const b of bad) b.errors.forEach((e) => console.log(`  ${b.name}: ${e}`));
  }
  console.log(`\nPNGs: ${OUT}`);

  dt.close();
  chrome.kill();
  server.kill();
  await wait(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ }
  process.exit(bad.length ? 1 : 0);
})();
