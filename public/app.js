'use strict';

// ---- tiny helpers --------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function get(path) { const r = await fetch(path); return r.json(); }
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
function fmtDate(d) {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// The real deadline, date and time: "Fri, Aug 15 at 8:00 AM".
//
// This is the ACTUAL Canvas deadline (due_at), which is not always the day the
// work shows up on — anything due before noon is listed the day before, because
// that's when it has to be done. Showing the true deadline here is what makes
// that make sense instead of looking like a mistake.
function fmtDue(dueAt, dueDate) {
  if (!dueAt) return fmtDate(dueDate);
  const d = new Date(dueAt);
  if (isNaN(d.getTime())) return fmtDate(dueDate);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}
function fmtClock(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---- app state -----------------------------------------------------------
const app = $('#app');
const overlay = $('#overlay');
const panel = $('#panel');
let state = {
  view: 'today', todaySort: 'due', todayTab: 'assignments', doneTab: 'unfinished',
  workId: null, classId: null, classTab: 'grades',
  // Ask Claude: open or shut. Held here rather than in the DOM so the panel
  // stays open across a re-render of the page underneath it.
  chatOpen: false,
  // How far ahead Tests & Quizzes is looking, in weeks. 0 = all of them.
  testWeeks: 0,
};
// Set by refreshStatus, which always runs before the first render. Slate starts
// empty now, so every empty page needs to know whether that means "you're all
// caught up" or "Canvas isn't hooked up yet".
let notConnected = false;
function emptyOr(icon, title, sub) {
  return notConnected
    ? emptyState('Canvas is not connected', 'Open the API tab and paste your Canvas address and token, and your work will show up here.')
    : emptyState(icon, title, sub);
}

// ---- overlay / popup -----------------------------------------------------
let activeTimer = null; // popup-scoped timer (tests study timer)
function openPanel() { overlay.classList.remove('hidden'); }
function closePanel(rerender = true) {
  if (activeTimer) { activeTimer.stop(); activeTimer = null; }
  overlay.classList.add('hidden');
  panel.innerHTML = '';
  panel.className = 'panel';   // the hand-in screen adds its own layout class
  // Re-render the view behind the popup (progress may have changed), except on
  // the work page — re-rendering there would reset the running focus timer.
  if (rerender && state.view !== 'work') render();
}
overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closePanel(); });
// Clicking anywhere else shuts an open three-dot menu.
document.addEventListener('click', () => {
  document.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
});

function panelHeader(title, sub, rerenderOnClose = true) {
  const close = el('button', 'panel-close', '&times;');
  close.onclick = () => closePanel(rerenderOnClose);
  const head = el('div', 'panel-head');
  head.appendChild(close);
  head.appendChild(el('h2', null, esc(title)));
  if (sub) head.appendChild(el('div', 'sub', esc(sub)));
  return head;
}

// ---- study timer (tests page): simple count-up ----------------------------
function makeTimer(startSeconds, onSave) {
  let elapsed = 0;
  let running = false;
  let iv = null;
  const clock = el('div', 'timer-clock', fmtClock(startSeconds));
  const meta = el('div', 'timer-meta', 'Not running');
  const btn = el('button', 'btn btn-accent', 'Start');
  const total = () => startSeconds + elapsed;
  function tick() { elapsed += 1; clock.textContent = fmtClock(total()); }
  function start() {
    running = true; btn.textContent = 'Pause'; btn.classList.remove('btn-accent'); btn.classList.add('btn-ghost');
    meta.textContent = 'Running…'; iv = setInterval(tick, 1000);
  }
  function pause() {
    running = false; btn.textContent = 'Start'; btn.classList.add('btn-accent'); btn.classList.remove('btn-ghost');
    meta.textContent = 'Paused'; clearInterval(iv);
    if (elapsed > 0) { onSave(elapsed); startSeconds = total(); elapsed = 0; }
  }
  btn.onclick = () => (running ? pause() : start());
  const wrap = el('div', 'timer');
  const left = el('div'); left.appendChild(clock); left.appendChild(meta);
  wrap.appendChild(left); wrap.appendChild(btn);
  const handle = { node: wrap, stop() { if (running) pause(); } };
  // Register for page-navigation cleanup so leaving the page banks the time.
  pageTimer = { dispose: () => handle.stop(), beacon: () => {} };
  return handle;
}


// The plain-text list bar, still used by the essay editor. That page's outline,
// click-to-jump and Get-unstuck coach all work off the caret position in a
// textarea, so it keeps its plain surface until those are ported across.
// Bullets are real "• " characters and numbers real "1. ".
function listToolbar(ta, onChange) {
  const bar = el('div', 'fmt-bar');
  const lineRange = () => {
    const v = ta.value;
    const start = v.lastIndexOf('\n', Math.max(0, ta.selectionStart - 1)) + 1;
    let end = v.indexOf('\n', ta.selectionEnd);
    if (end === -1) end = v.length;
    return { start, end };
  };
  const apply = (fn) => {
    const { start, end } = lineRange();
    const out = fn(ta.value.slice(start, end).split('\n')).join('\n');
    ta.value = ta.value.slice(0, start) + out + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + out.length;
    ta.focus();
    onChange();
  };
  const strip = (l) => l.replace(/^\s*(?:[•\-*]\s+|\d+[.)]\s+)/, '');
  const allBulleted = (lines) => lines.every((l) => !l.trim() || /^\s*•\s+/.test(l));
  const allNumbered = (lines) => lines.every((l) => !l.trim() || /^\s*\d+[.)]\s+/.test(l));
  const btn = (label, title, fn) => {
    const b = el('button', 'fmt-btn', label);
    b.title = title;
    b.onclick = (e) => { if (e && e.preventDefault) e.preventDefault(); apply(fn); };
    bar.appendChild(b);
  };
  btn('Bullets', 'Turn these lines into a bulleted list', (lines) =>
    (allBulleted(lines) ? lines.map(strip) : lines.map((l) => (l.trim() ? '• ' + strip(l) : l))));
  btn('1. 2. 3.', 'Turn these lines into a numbered list', (lines) => {
    if (allNumbered(lines)) return lines.map(strip);
    let n = 0;
    return lines.map((l) => (l.trim() ? `${++n}. ${strip(l)}` : l));
  });
  btn('Indent', 'Push these lines in', (lines) => lines.map((l) => (l.trim() ? '    ' + l : l)));
  btn('Outdent', 'Pull these lines back', (lines) => lines.map((l) => l.replace(/^ {1,4}/, '')));
  btn('Clear', 'Take the list markers off', (lines) => lines.map((l) => strip(l).replace(/^ +/, '')));

  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const v = ta.value;
    const lineStart = v.lastIndexOf('\n', Math.max(0, ta.selectionStart - 1)) + 1;
    const line = v.slice(lineStart, ta.selectionStart);
    const m = line.match(/^(\s*)(•\s+|(\d+)[.)]\s+)/);
    if (!m) return;
    if (e.preventDefault) e.preventDefault();
    if (line.slice(m[0].length).trim() === '') {
      ta.value = v.slice(0, lineStart) + v.slice(ta.selectionStart);
      ta.selectionStart = ta.selectionEnd = lineStart;
      onChange();
      return;
    }
    const next = m[3] ? `${m[1]}${Number(m[3]) + 1}. ` : `${m[1]}• `;
    const at = ta.selectionStart;
    ta.value = v.slice(0, at) + '\n' + next + v.slice(at);
    ta.selectionStart = ta.selectionEnd = at + 1 + next.length;
    onChange();
  });
  return bar;
}

// ---- the writing editor --------------------------------------------------
// A real editor: a toolbar sitting on top of the writing surface, the way
// Canvas does it, in Slate's colours. The surface is contenteditable, so what
// comes out is HTML — src/richtext.js turns that into the block model the Word
// and PDF builders and the page preview all render from.
//
// The document starts as MLA (Times New Roman 12). Touch the font or size
// pickers and that choice becomes the document's, which is what
// /api/assignments/:id/doc-style records.

const EDITOR_FONTS = ['Times New Roman', 'Arial', 'Calibri', 'Georgia', 'Verdana', 'Courier New'];
const EDITOR_SIZES = [9, 10, 11, 12, 14, 16, 18, 24];

function richEditor(html, { docStyle, onChange, onStyle, tall } = {}) {
  const wrap = el('div', 'editor-wrap');
  const bar = el('div', 'editor-bar');
  const surface = el('div', 'editor-surface' + (tall ? ' tall' : ''));
  surface.contentEditable = 'true';
  surface.spellcheck = true;
  surface.innerHTML = html || '<p></p>';

  const style = docStyle || { font: null, size: null };
  const applyDocStyle = () => {
    surface.style.fontFamily = (style.font || 'Times New Roman') + ', serif';
    surface.style.fontSize = (style.size || 12) * 1.333 + 'px';
  };
  applyDocStyle();

  // execCommand is the only way to do this without a dependency, and every
  // browser still supports it. Guarded because the test harness has no DOM.
  const exec = (cmd, value) => {
    surface.focus();
    if (document.execCommand) document.execCommand(cmd, false, value);
    onChange && onChange();
  };

  const group = () => { const g = el('div', 'editor-group'); bar.appendChild(g); return g; };
  const btn = (host, label, title, fn) => {
    const b = el('button', 'editor-btn', label);
    b.title = title;
    b.onclick = (e) => { if (e && e.preventDefault) e.preventDefault(); fn(); };
    host.appendChild(b);
    return b;
  };

  // ---- font + size: these set the DOCUMENT default, not a selection --------
  const g1 = group();
  const fontSel = el('select', 'editor-select editor-font');
  for (const f of EDITOR_FONTS) {
    const o = el('option', null, f);
    o.value = f;
    if ((style.font || 'Times New Roman') === f) o.selected = true;
    fontSel.appendChild(o);
  }
  fontSel.value = style.font || 'Times New Roman';
  fontSel.title = 'Font for the whole document';
  fontSel.onchange = () => { style.font = fontSel.value; applyDocStyle(); onStyle && onStyle(style); };
  g1.appendChild(fontSel);

  const sizeSel = el('select', 'editor-select editor-size');
  for (const n of EDITOR_SIZES) {
    const o = el('option', null, String(n));
    o.value = String(n);
    if ((style.size || 12) === n) o.selected = true;
    sizeSel.appendChild(o);
  }
  sizeSel.value = String(style.size || 12);
  sizeSel.title = 'Size for the whole document';
  sizeSel.onchange = () => { style.size = Number(sizeSel.value); applyDocStyle(); onStyle && onStyle(style); };
  g1.appendChild(sizeSel);

  const g2 = group();
  btn(g2, 'B', 'Bold (Ctrl+B)', () => exec('bold')).classList.add('is-bold');
  btn(g2, 'I', 'Italic (Ctrl+I)', () => exec('italic')).classList.add('is-italic');
  btn(g2, 'U', 'Underline (Ctrl+U)', () => exec('underline')).classList.add('is-underline');

  const g3 = group();
  btn(g3, '≡', 'Left', () => exec('justifyLeft'));
  btn(g3, '☰', 'Centre', () => exec('justifyCenter'));
  btn(g3, '≡', 'Right', () => exec('justifyRight')).classList.add('flip');

  const g4 = group();
  btn(g4, 'Bullets', 'Bulleted list', () => exec('insertUnorderedList'));
  btn(g4, '1. 2. 3.', 'Numbered list', () => exec('insertOrderedList'));
  btn(g4, 'Indent', 'Push in', () => exec('indent'));
  btn(g4, 'Outdent', 'Pull back', () => exec('outdent'));

  const g5 = group();
  btn(g5, 'Clear', 'Take the formatting off', () => exec('removeFormat'));

  // Paste as plain text — pasting a Word chunk otherwise drags its whole
  // stylesheet in and the document stops looking like one document.
  surface.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;
    const text = e.clipboardData.getData('text/plain');
    if (text == null) return;
    if (e.preventDefault) e.preventDefault();
    if (document.execCommand) document.execCommand('insertText', false, text);
    onChange && onChange();
  });
  surface.addEventListener('input', () => onChange && onChange());

  wrap.appendChild(bar);
  wrap.appendChild(surface);
  return {
    node: wrap,
    surface,
    getHtml: () => surface.innerHTML,
    setHtml: (v) => { surface.innerHTML = String(v == null ? '' : v) || '<p></p>'; },
    getText: () => surface.textContent || '',
    style,
  };
}

// ---- unsaved-draft guard -------------------------------------------------
// Editors autosave on a debounce, so there is always a moment where what's on
// screen isn't on disk yet. Anything that tears the page down (marking a chunk
// done, switching tabs, going back) flushes the pending save first, so typing
// can never be thrown away by a re-render.
let pageDraft = null; // { flush(): Promise, beacon(): void }

// `source` is either a textarea (plain) or a rich editor handle, which reports
// HTML instead. The server derives the plain text from the HTML, so only one of
// the two fields ever goes up.
function registerDraft(assignmentId, source, onSaved) {
  const isRich = typeof source.getHtml === 'function';
  const read = () => (isRich ? source.getHtml() : source.value);
  const payload = (v) => (isRich ? { html: v } : { text: v });
  let saved = read();
  const handle = {
    isDirty: () => read() !== saved,
    flush() {
      const now = read();
      if (now === saved) return Promise.resolve();
      return post(`/api/assignments/${assignmentId}/draft`, payload(now)).then(() => {
        saved = now;
        if (onSaved) onSaved();
      });
    },
    beacon() {
      const now = read();
      if (now !== saved) {
        navigator.sendBeacon(`/api/assignments/${assignmentId}/draft`, JSON.stringify(payload(now)));
        saved = now;
      }
    },
    // The server changed the draft under us — Claude's grammar corrections are
    // the only thing that does this. Put the new text on screen and treat it as
    // already saved, or the next flush would push the uncorrected copy back
    // over the top of it.
    adopt(value) {
      if (value == null) return;
      if (isRich) source.setHtml(String(value));
      else source.value = String(value);
      saved = read();
    },
  };
  pageDraft = handle;
  return handle;
}

// Study timer cleanup handle (tests page). Focus timers were removed from
// assignment and project pages — studying is the only place a timer helps.
let pageTimer = null;

// An in-flight "Ask Claude" request. Leaving the page aborts it, which closes
// the response, which kills the hidden claude process on the server — the same
// chain the essay coach uses.
let pageChat = null;

window.addEventListener('beforeunload', () => {
  if (pageTimer) pageTimer.beacon();
  if (pageDraft) pageDraft.beacon();
});

// ---- TODAY ---------------------------------------------------------------
// Two tabs: what's due today, and the project work Slate pulled in to fill out
// the rest of the 2-hour day.
function fmtMins(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

async function renderToday() {
  const plan = await get('/api/today?sort=' + state.todaySort);
  const tab = state.todayTab === 'projects' ? 'projects' : 'assignments';

  const head = el('div', 'view-head');
  head.appendChild(el('h1', 'view-title', 'Today'));
  if (tab === 'assignments') {
    const toggle = el('div', 'toggle-group');
    const byDue = el('button', state.todaySort === 'due' ? 'active' : '', 'By due date');
    const byImpact = el('button', state.todaySort === 'impact' ? 'active' : '', 'By grade impact');
    byDue.onclick = () => { state.todaySort = 'due'; render(); };
    byImpact.onclick = () => { state.todaySort = 'impact'; render(); };
    toggle.appendChild(byDue); toggle.appendChild(byImpact);
    head.appendChild(toggle);
  }
  app.appendChild(head);

  // How the day adds up, as a plain line — no bar.
  const total = plan.total_minutes || 0;
  const summary = el('div', 'day-plan');
  summary.appendChild(el('div', 'day-line',
    `${fmtMins(total)} of work planned` +
    (plan.project_minutes ? ` · ${fmtMins(plan.assignment_minutes)} due today + ${fmtMins(plan.project_minutes)} of project work` : '')));
  app.appendChild(summary);

  // Assignments | Projects switcher.
  const tabs = el('div', 'toggle-group day-tabs');
  const aBtn = el('button', tab === 'assignments' ? 'active' : '', `Assignments (${plan.assignments.length})`);
  const pBtn = el('button', tab === 'projects' ? 'active' : '', `Projects (${plan.projects.length})`);
  aBtn.onclick = () => { state.todayTab = 'assignments'; render(); };
  pBtn.onclick = () => { state.todayTab = 'projects'; render(); };
  tabs.appendChild(aBtn); tabs.appendChild(pBtn);
  app.appendChild(tabs);

  if (tab === 'assignments') {
    if (!plan.assignments.length && !plan.finished.length) {
      app.appendChild(emptyOr('Nothing due today', 'Check the Projects tab — there is project work waiting.'));
      return;
    }
    app.appendChild(doneSwitcher(plan.assignments.length, plan.finished.length));
    if (state.doneTab === 'finished') {
      if (!plan.finished.length) { app.appendChild(emptyState('Nothing finished yet today', 'Tick something off and it shows up here.')); return; }
      const grid = el('div', 'grid');
      for (const a of plan.finished) grid.appendChild(assignmentCardNode(a));
      app.appendChild(grid);
      return;
    }
    if (!plan.assignments.length) {
      // Clearing a real day's worth of work means you're finished, not that
      // you've earned more. Only a day that was quiet to start with gets filled.
      const cleared = plan.scheduled_today_count > 0;
      app.appendChild(emptyState(cleared ? "You're done for the day" : 'Nothing due today',
        cleared && plan.projects.length ? 'There is project work on the Projects tab if you want it.'
          : cleared ? 'Everything today is handled.' : 'Check the Projects tab.'));
      return;
    }
    const grid = el('div', 'grid');
    for (const a of plan.assignments) grid.appendChild(assignmentCardNode(a));
    app.appendChild(grid);
    return;
  }

  const anyProjects = plan.projects.length || plan.finished_projects.length;
  if (!anyProjects) {
    app.appendChild(emptyOr('No projects on', 'Projects from Canvas show up here.'));
    return;
  }
  app.appendChild(doneSwitcher(plan.projects.length, plan.finished_projects.length));
  const showFinished = state.doneTab === 'finished';
  const list = showFinished ? plan.finished_projects : plan.projects;
  if (!list.length) {
    app.appendChild(emptyState(showFinished ? 'Nothing finished yet today' : 'Every project is done',
      showFinished ? 'Finish a project and it shows up here.' : 'Nice work.'));
    return;
  }
  const pgrid = el('div', 'grid');
  for (const p of list) pgrid.appendChild(projectCardNode(p));
  app.appendChild(pgrid);
}

// Unfinished | Finished, the same switcher as Assignments | Projects and the
// sort buttons. `state.doneTab` is shared by Today and Week on purpose — you
// are asking the same question of both pages.
function doneSwitcher(unfinishedCount, finishedCount) {
  const showing = state.doneTab === 'finished' ? 'finished' : 'unfinished';
  const group = el('div', 'toggle-group day-tabs');
  const u = el('button', showing === 'unfinished' ? 'active' : '', `Unfinished (${unfinishedCount})`);
  const f = el('button', showing === 'finished' ? 'active' : '', `Finished (${finishedCount})`);
  u.onclick = () => { state.doneTab = 'unfinished'; render(); };
  f.onclick = () => { state.doneTab = 'finished'; render(); };
  group.appendChild(u); group.appendChild(f);
  return group;
}

// A titled block of cards. An empty Finished list is simply left out — the page
// should not carry a heading with nothing under it.
function section(title, count, nodes, emptyLine) {
  if (!count && !emptyLine) return;
  const head = el('div', 'list-head');
  head.appendChild(el('span', 'list-title', esc(title)));
  head.appendChild(el('span', 'pill muted', String(count)));
  app.appendChild(head);
  if (!count) {
    app.appendChild(el('div', 'day-line', esc(emptyLine)));
    return;
  }
  const grid = el('div', 'grid');
  for (const n of nodes) grid.appendChild(n);
  app.appendChild(grid);
}

function assignmentCardNode(a) {
  const card = el('div', 'card' + (a.upcoming ? ' ahead' : '') + (a.done ? ' finished' : '')
    + (a.overdue && !a.done ? ' late' : ''));
  card.appendChild(el('div', 'card-title', esc(a.title)));
  card.appendChild(el('div', 'card-class', esc(a.class_name)));
  // The real deadline, always. Plus why it's on today's list when the deadline
  // itself is later — either it's due first thing tomorrow, or it's been pulled
  // forward off a quiet day.
  const due = el('div', 'card-due', 'Due ' + esc(fmtDue(a.due_at, a.due_date)));
  if (a.overdue && !a.done) {
    due.appendChild(el('span', 'due-late',
      a.days_late === 1 ? ' · a day late' : ` · ${a.days_late} days late`));
  } else if (a.upcoming) due.appendChild(el('span', 'due-note', ' · getting ahead'));
  else if (a.due_morning_of) due.appendChild(el('span', 'due-note', ' · do it today'));
  card.appendChild(due);
  const row = el('div', 'card-row');
  const pills = el('div', 'pill-row');
  pills.appendChild(el('span', 'pill', esc(a.points) + ' pts'));
  pills.appendChild(el('span', 'pill muted', '~' + fmtMins(a.minutes)));
  if (a.upcoming) pills.appendChild(el('span', 'pill muted', 'ahead'));
  if (state.todaySort === 'impact') pills.appendChild(el('span', 'pill muted', 'impact ' + a.impact));
  row.appendChild(pills);
  if (a.done) {
    const undo = el('button', 'btn btn-ghost btn-sm', 'Move to unfinished');
    undo.onclick = async (e) => { e.stopPropagation(); await post(`/api/assignments/${a.id}/reopen`); render(); };
    row.appendChild(undo);
  } else {
    const done = el('button', 'btn btn-accent btn-sm', 'Mark complete');
    done.onclick = async (e) => { e.stopPropagation(); await post(`/api/assignments/${a.id}/complete`); render(); };
    row.appendChild(done);
  }
  card.appendChild(row);
  card.onclick = () => { state.view = 'work'; state.workId = a.id; render(); };
  return card;
}

// A project on Today. The whole project, not a slice of one — projects are no
// longer broken into a daily plan.
function projectCardNode(p) {
  const card = el('div', 'card' + (p.done ? ' finished' : ''));
  card.appendChild(el('div', 'card-title', esc(p.title)));
  card.appendChild(el('div', 'card-class', esc(p.class_name)));
  card.appendChild(el('div', 'card-due', 'Due ' + esc(fmtDue(p.due_at, p.due_date))));
  const row = el('div', 'card-row');
  const pills = el('div', 'pill-row');
  if (p.points) pills.appendChild(el('span', 'pill', p.points + ' pts'));
  row.appendChild(pills);
  const done = el('button', 'btn btn-ghost btn-sm', p.done ? 'Move to unfinished' : 'Mark complete');
  done.onclick = async (e) => {
    e.stopPropagation();
    await post(`/api/assignments/${p.project_id}/${p.done ? 'reopen' : 'complete'}`);
    render();
  };
  row.appendChild(done);
  card.appendChild(row);
  card.onclick = () => { state.view = 'project'; state.projectId = p.project_id; render(); };
  return card;
}

// ---- WORK PAGE (full page per assignment) --------------------------------
async function renderWork() {
  const a = await get('/api/assignments/' + state.workId);
  if (!a || a.error) { state.view = 'today'; return render(); }

  const back = el('button', 'btn btn-ghost back-btn', '← Back');
  back.onclick = () => { state.view = 'today'; state.workId = null; render(); };
  app.appendChild(back);

  const head = el('div', 'work-head');
  head.appendChild(el('h1', 'view-title', esc(a.title)));
  head.appendChild(el('div', 'view-sub',
    `${esc(a.class_name)} · ${esc(a.points)} pts · due ${esc(fmtDue(a.due_at, a.due_date))}`
    + (a.due_morning_of ? ' — so it has to be done today' : '')));
  app.appendChild(head);

  const body = el('div', 'work-body');
  if (a.work_mode === 'text') buildTextWork(body, a);
  else buildGuideWork(body, a);
  app.appendChild(body);
}

// Turn instruction text into a few clean, short action lines.
function instructionLines(text) {
  let lines = String(text || '').split('\n').map((l) => l.replace(/^[•\-\d.)\s]+/, '').trim()).filter(Boolean);
  // If it came back as one long line, break it into sentences so it's scannable.
  if (lines.length === 1 && lines[0].length > 90) {
    lines = lines[0].split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  }
  return lines.length ? lines : ['No instructions provided.'];
}

// Simplified instructions at the top of every work page — plain text, no box.
// Shows the quick version instantly, then swaps in the AI-simplified one.
function instructionsSection(assignmentId, detail) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'section-label', 'Instructions'));
  const listEl = el('ul', 'instructions');
  const fill = (text) => {
    listEl.innerHTML = '';
    instructionLines(text).forEach((l) => listEl.appendChild(el('li', null, esc(l))));
  };
  fill(detail.instructions_ai || detail.instructions_plain || 'No instructions provided.');
  wrap.appendChild(listEl);
  if (!detail.instructions_ai) {
    const note = el('div', 'bar-label', 'Making these simpler…');
    wrap.appendChild(note);
    post(`/api/assignments/${assignmentId}/simplify`, {})
      .then((r) => { if (r && r.instructions) fill(r.instructions); note.remove(); })
      .catch(() => note.remove());
  }
  return wrap;
}

// Written work: type the answer here, submit -> file on the Desktop.
function buildTextWork(body, a) {
  body.appendChild(instructionsSection(a.id, a));
  if (a.steps && a.steps.length) {
    body.appendChild(el('div', 'section-label', 'Steps'));
    const ol = el('ol', 'steps');
    a.steps.forEach((s) => ol.appendChild(el('li', null, esc(s))));
    body.appendChild(ol);
  }
  attachFiles(body, a);

  body.appendChild(el('div', 'section-label', 'Your answer'));
  const saveNote = el('div', 'bar-label', a.draft_text ? 'Draft loaded' : '');
  let deb = null;
  let draft = null;
  const touched = () => {
    saveNote.textContent = 'Saving…';
    clearTimeout(deb);
    deb = setTimeout(() => draft && draft.flush(), 800);
  };
  const ed = richEditor(a.draft_html, {
    docStyle: a.doc_style,
    onChange: touched,
    onStyle: (st) => post(`/api/assignments/${a.id}/doc-style`, st),
  });
  body.appendChild(ed.node);
  const statusRow = el('div', 'editor-status');
  statusRow.appendChild(saveNote);
  const meter = pageMeter('assignment', a.id, () => draft);
  statusRow.appendChild(meter.node);
  body.appendChild(statusRow);
  draft = registerDraft(a.id, ed, () => { saveNote.textContent = 'Draft saved'; meter.update(); });
  meter.now();
  const ta = ed.surface; // the guide below still wants a handle on the surface

  const actions = el('div', 'work-actions');
  const submit = el('button', 'btn btn-accent', 'Submit');
  submit.onclick = async () => {
    clearTimeout(deb);
    await draft.flush();
    openDownloadPopup('assignment', a.id, () => {
      post(`/api/assignments/${a.id}/complete`);
      state.view = 'today'; state.workId = null; render();
    });
  };
  const complete = el('button', 'btn btn-ghost', 'Mark complete');
  complete.onclick = async () => {
    await post(`/api/assignments/${a.id}/complete`);
    state.view = 'today'; state.workId = null; render();
  };
  actions.appendChild(submit); actions.appendChild(complete);
  body.appendChild(actions);
  chatWidget(body, a);
}

// Handing work in. Two ways, always the student's choice:
//   - save the file to the Desktop and upload it yourself, or
//   - let Slate put it into Canvas.
// The Canvas route ALWAYS goes through a preview of the exact thing that will
// be sent, with a way back to the editor. Nothing is ever submitted by Slate on
// its own — this only moves when a button here is pressed.
// ---- the page preview ----------------------------------------------------
// A real US Letter page: 8.5 x 11 inches with 1-inch margins, at 96 CSS pixels
// to the inch. Content that runs past the bottom starts a new page, the way
// Word does it, and the whole stack is scaled down to fit whatever room the
// popup has.
const PAGE_W = 816;          // 8.5in
const PAGE_H = 1056;         // 11in
const PAGE_MARGIN = 96;      // 1in
const PAGE_BODY_H = PAGE_H - PAGE_MARGIN * 2;
const PAGE_RATIO = PAGE_W / PAGE_H;

// Builds the page stack from the document the server described.
function renderPages(host, p) {
  host.innerHTML = '';
  const style = (p.doc_style && (p.doc_style.font || p.doc_style.size))
    ? p.doc_style : { font: 'Times New Roman', size: 12 };

  const sheet = el('div', 'pages');
  host.appendChild(sheet);

  // Everything goes into one flowing column first, then gets dealt out into
  // pages by measuring where each block lands.
  const makePage = () => {
    const page = el('div', 'page');
    const inner = el('div', 'page-body');
    inner.style.fontFamily = (style.font || 'Times New Roman') + ', serif';
    inner.style.fontSize = ((style.size || 12) * 1.333) + 'px';
    page.appendChild(inner);
    sheet.appendChild(page);
    return inner;
  };

  let body = makePage();
  const place = (node) => {
    body.appendChild(node);
    // Overflowed the page? Start another and move this block onto it.
    //
    // Measured with offsetHeight, which is the body's REAL height: it is left
    // auto-height and the page clips it. Asking a full-height element for its
    // scrollHeight always came back a full page, so every block after the first
    // looked like an overflow and got its own page.
    if (body.offsetHeight > PAGE_H && body.children.length > 1) {
      body.removeChild(node);
      body = makePage();
      body.appendChild(node);
    }
  };

  for (const line of (p.heading_lines || [])) place(el('div', 'doc-line', esc(line)));
  if (p.doc_title) place(el('div', 'doc-line doc-title', esc(p.doc_title)));
  for (const b of (p.doc_blocks || [])) {
    if (b.type === 'ul' || b.type === 'ol') {
      b.items.forEach((item, i) => {
        const row = el('div', 'doc-line doc-list');
        row.appendChild(el('span', 'doc-marker', b.type === 'ol' ? `${i + 1}.` : '•'));
        row.appendChild(runsNode(item));
        place(row);
      });
      continue;
    }
    const para = el('div', 'doc-line doc-para' + (b.align ? ' align-' + b.align : ''));
    para.appendChild(runsNode(b.runs));
    place(para);
  }
  if (p.works_cited && p.works_cited.length) {
    body = makePage();
    place(el('div', 'doc-line doc-title', 'Works Cited'));
    p.works_cited.forEach((c) => place(el('div', 'doc-line doc-hanging', esc(c))));
  }
  if (!sheet.children.length) makePage();

  const count = sheet.children.length;
  host.appendChild(el('div', 'page-count', count + (count === 1 ? ' page' : ' pages')));
  return count;
}

// ---- how many pages this will be, live -----------------------------------
// Answers "how long is this actually going to be in Word" without opening the
// hand-in screen. It runs the SAME renderPages() the preview uses, off-screen,
// on the SAME document the server would hand to the .docx builder — so it can't
// drift from the file that eventually comes out.
//
// Off-screen means visibility:hidden and parked off to the left, NOT
// display:none: a display:none element has no layout, every height reads 0, and
// the pagination would put everything on page one.
function pageMeter(kind, id, getDraft) {
  const node = el('div', 'page-meter', '');
  let timer = null;
  let host = null;
  let busy = false;
  let again = false;

  function measure(p) {
    if (!host) {
      host = el('div', 'page-measure');
      document.body.appendChild(host);
    }
    const pages = renderPages(host, p) || 1;
    // How much of the last page is used, so this reads "1.4 pages" rather than
    // jumping 1 -> 2 the moment a line wraps.
    const sheet = host.querySelector && host.querySelector('.pages');
    const last = sheet && sheet.children ? sheet.children[sheet.children.length - 1] : null;
    const lastBody = last && last.children ? last.children[0] : null;
    const used = lastBody && lastBody.offsetHeight ? lastBody.offsetHeight - PAGE_MARGIN * 2 : 0;
    const frac = PAGE_BODY_H ? Math.min(1, Math.max(0, used / PAGE_BODY_H)) : 0;
    const total = (pages - 1) + (frac || (pages > 0 ? 0.05 : 0));
    return Math.max(0.1, Math.round(total * 10) / 10);
  }

  async function run() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const draft = getDraft && getDraft();
      if (draft && draft.flush) await draft.flush();
      const p = await get(`/api/submit-preview?kind=${kind}&id=${id}&light=1`);
      if (!p || !p.ok) { node.textContent = ''; return; }
      const n = measure(p);
      node.textContent = n === 1 ? '1 page in Word' : `about ${n} pages in Word`;
      node.title = 'MLA: Times New Roman 12, double spaced, 1in margins';
    } catch {
      node.textContent = ''; // never let the meter break the editor
    } finally {
      busy = false;
      if (again) { again = false; run(); }
    }
  }

  return {
    node,
    // Debounced: the draft has to be saved before the server can describe it,
    // so this deliberately waits for a pause in typing rather than firing per
    // keystroke.
    update() { clearTimeout(timer); timer = setTimeout(run, 1200); },
    now: run,
    dispose() {
      clearTimeout(timer);
      if (host && host.parentNode && host.parentNode.removeChild) host.parentNode.removeChild(host);
      host = null;
    },
  };
}

function runsNode(runs) {
  const span = el('span');
  for (const r of (runs || [])) {
    const s = el('span', null, esc(r.text));
    if (r.b) s.style.fontWeight = '700';
    if (r.i) s.style.fontStyle = 'italic';
    if (r.u) s.style.textDecoration = 'underline';
    if (r.font) s.style.fontFamily = r.font + ', serif';
    if (r.size) s.style.fontSize = (r.size * 1.333) + 'px';
    span.appendChild(s);
  }
  return span;
}

// The pages are drawn full size and then scaled, so they stay in proportion
// however much room the popup has.
function fitPages(host) {
  const sheet = host.querySelector && host.querySelector('.pages');
  if (!sheet) return;
  const avail = host.clientWidth || PAGE_W;
  const scale = Math.min(1, (avail - 8) / PAGE_W);
  sheet.style.transform = `scale(${scale})`;
  sheet.style.width = PAGE_W + 'px';
  const pages = sheet.children.length || 1;
  sheet.style.height = (pages * PAGE_H + (pages - 1) * 18) + 'px';
}

// ---- the slide preview ---------------------------------------------------
// A slideshow doesn't get the Word-page preview — it gets slides, laid out the
// way the .pptx actually comes out (slide 1 is the title slide, content slides
// get a number, a sage heading with a rule under it, and one card per bullet),
// with a strip of thumbnails you click through like PowerPoint.
//
// Everything is drawn from the SAME slide objects that go into the file, so the
// preview cannot promise something the .pptx doesn't deliver.
function slideStage(slide, index, total) {
  const stage = el('div', 'pv-stage' + (index === 0 ? ' pv-title-slide' : ''));
  const inner = el('div', 'pv-inner');
  if (index === 0) {
    inner.appendChild(el('div', 'pv-rule'));
    inner.appendChild(el('div', 'pv-big-title', esc(slide.title || 'Untitled')));
    const sub = (slide.bullets || []).filter((b) => String(b).trim());
    if (sub.length) inner.appendChild(el('div', 'pv-subtitle', esc(sub.join(' · '))));
    inner.appendChild(el('div', 'pv-dots', '<span></span><span></span><span></span>'));
  } else {
    inner.appendChild(el('div', 'pv-kicker', String(index).padStart(2, '0')));
    inner.appendChild(el('div', 'pv-title', esc(slide.title || 'Untitled slide')));
    inner.appendChild(el('div', 'pv-rule'));
    const cols = el('div', 'pv-cols' + (slide.photo ? ' pv-has-photo' : ''));
    const body = el('div', 'pv-bullets');
    const bullets = (slide.bullets || []).filter((b) => String(b).trim());
    if (!bullets.length) body.appendChild(el('div', 'pv-empty', 'Nothing written on this slide yet'));
    // Over six bullets the real .pptx drops the cards for a plain list, so the
    // preview does the same rather than flattering the output.
    else if (bullets.length > 6) {
      const ul = el('ul', 'pv-plain');
      bullets.forEach((b) => ul.appendChild(el('li', null, esc(b))));
      body.appendChild(ul);
    } else {
      bullets.forEach((b) => {
        const card = el('div', 'pv-card');
        card.appendChild(el('span', 'pv-tab'));
        card.appendChild(el('span', null, esc(b)));
        body.appendChild(card);
      });
    }
    cols.appendChild(body);
    if (slide.photo) cols.appendChild(el('div', 'pv-photo', 'Picture goes here'));
    inner.appendChild(cols);
    inner.appendChild(el('div', 'pv-foot', `${index} / ${total - 1}`));
  }
  stage.appendChild(inner);
  return stage;
}

// Draws the deck into `host` and wires up clicking between slides.
function renderSlides(host, p) {
  host.innerHTML = '';
  const slides = (p.slides || []).length ? p.slides : [{ title: p.assignment || 'Untitled', bullets: [] }];
  let at = 0;

  const stageHost = el('div', 'pv-stage-host');
  const bar = el('div', 'pv-bar');
  const prev = el('button', 'pv-arrow', '‹');
  const counter = el('div', 'pv-counter', '');
  const next = el('button', 'pv-arrow', '›');
  bar.appendChild(prev); bar.appendChild(counter); bar.appendChild(next);
  const strip = el('div', 'pv-strip');

  // Bring the slide you just picked into view, and the next couple with it, so
  // there is always something to click on next without dragging the strip.
  // Only moves when it has to — a card already sitting comfortably in the
  // middle shouldn't jump to the edge under your cursor.
  // Works both ways: going right it makes sure the next two are reachable,
  // going left it does the same for the previous two. `from` is where you
  // came from, which is the only thing that says which way you're heading.
  function keepInView(i, from) {
    const cards = strip.children;
    if (!cards || !cards.length || strip.clientWidth == null) return;
    const here = cards[i];
    if (!here || here.offsetLeft == null) return; // the drive harness has no layout
    const viewLeft = strip.scrollLeft;
    const viewRight = viewLeft + strip.clientWidth;
    const goingLeft = from != null && i < from;
    let to = viewLeft;

    if (goingLeft) {
      const behind = cards[Math.max(0, i - 2)] || here;
      if (behind.offsetLeft < viewLeft) to = behind.offsetLeft - 8;
      // Never at the cost of pushing the card you picked off the right.
      if (here.offsetLeft + here.offsetWidth > to + strip.clientWidth) {
        to = here.offsetLeft + here.offsetWidth - strip.clientWidth + 8;
      }
    } else {
      const ahead = cards[Math.min(cards.length - 1, i + 2)] || here;
      if (ahead.offsetLeft + ahead.offsetWidth > viewRight) {
        to = ahead.offsetLeft + ahead.offsetWidth - strip.clientWidth + 8;
      }
      // Never at the cost of pushing the card you picked off the left.
      if (here.offsetLeft < to) to = here.offsetLeft - 8;
    }

    to = Math.max(0, to);
    if (Math.abs(to - viewLeft) < 2) return;
    if (typeof strip.scrollTo === 'function') strip.scrollTo({ left: to, behavior: 'smooth' });
    else strip.scrollLeft = to;
  }

  function show(i) {
    const from = at;
    at = Math.max(0, Math.min(slides.length - 1, i));
    stageHost.innerHTML = '';
    stageHost.appendChild(slideStage(slides[at], at, slides.length));
    counter.textContent = `Slide ${at + 1} of ${slides.length}`;
    prev.disabled = at === 0;
    next.disabled = at === slides.length - 1;
    [...strip.children].forEach((t, i2) => t.classList.toggle('on', i2 === at));
    keepInView(at, from);
  }

  // Each card is "Slide N" plus a miniature of the slide itself — the same
  // renderer as the big one, just small. The slide's text is sized in cqw off
  // its own width, so it shrinks in proportion with no second layout to keep
  // in step.
  slides.forEach((s, i) => {
    const thumb = el('button', 'pv-thumb');
    thumb.appendChild(el('span', 'pv-thumb-num', 'Slide ' + (i + 1)));
    const mini = el('div', 'pv-mini');
    mini.appendChild(slideStage(s, i, slides.length));
    thumb.appendChild(mini);
    thumb.onclick = () => show(i);
    strip.appendChild(thumb);
  });

  prev.onclick = () => show(at - 1);
  next.onclick = () => show(at + 1);
  // Arrow keys, the way you'd expect in PowerPoint.
  host.tabIndex = 0;
  host.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); show(at + 1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(at - 1); }
  });

  host.appendChild(stageHost);
  host.appendChild(bar);
  host.appendChild(strip);
  show(0);
  return slides.length;
}

async function openDownloadPopup(kind, id, onComplete) {
  const opts = await get(`/api/download-options?kind=${kind}&id=${id}`);
  panel.innerHTML = '';
  panel.className = 'panel handin';
  panel.appendChild(panelHeader('Hand it in', null, false));
  if (!opts || opts.empty) {
    panel.appendChild(el('div', 'deliverable', 'There is nothing to hand in yet — add your work first.'));
    openPanel();
    return;
  }

  // The document itself, right at the top, laid out as real pages. It scrolls
  // on its own so the boxes and buttons below stay put however long the work is.
  const paper = el('div', 'handin-paper');
  paper.appendChild(el('div', 'day-line', 'Reading your work…'));
  panel.appendChild(paper);

  // Everything below the paper lives in one band pinned to the bottom, so the
  // title, the paper and the settings all hold still and only the pages move.
  const settings = el('div', 'handin-settings');
  panel.appendChild(settings);
  const headingHost = el('div');
  settings.appendChild(headingHost);
  // `light` skips the Canvas round-trip that checks for earlier attempts —
  // that question only matters on the Submit screen.
  get(`/api/submit-preview?kind=${kind}&id=${id}&light=1`).then((p) => {
    if (!p || !p.ok) { paper.innerHTML = ''; paper.appendChild(el('div', 'day-line', 'Nothing written yet.')); return; }
    if (p.slides) {
      // A deck, not a document: slides you click through, no MLA heading to
      // edit, and a wider panel because a slide is landscape.
      panel.className = 'panel handin slides';
      paper.className = 'handin-paper handin-deck';
      renderSlides(paper, p);
      return;
    }
    renderPages(paper, p);
    fitPages(paper);
    if (p.heading) headingEditor(headingHost, p, () => openDownloadPopup(kind, id, onComplete));
  }).catch(() => { paper.innerHTML = ''; paper.appendChild(el('div', 'day-line', 'Could not read your work.')); });

  settings.appendChild(el('div', 'section-label', 'File name'));
  const rowWrap = el('div', 'dl-row');
  const nameInput = el('input', 'dl-name');
  nameInput.type = 'text';
  nameInput.value = opts.default_name;

  const select = el('select', 'dl-type');
  opts.formats.forEach((f) => {
    const o = el('option', null, f.label);
    o.value = f.ext;
    select.appendChild(o);
  });
  rowWrap.appendChild(nameInput);
  rowWrap.appendChild(select);
  settings.appendChild(rowWrap);

  const status = el('div', 'day-line');
  status.style.marginTop = '10px';
  settings.appendChild(status);

  // Optional GPTZero check on your own writing. Runs by itself when you open
  // this screen, only if you've saved a key on the API tab.
  const aiBox = el('div', 'ai-check hidden');
  settings.appendChild(aiBox);
  runAiCheck(kind, id, aiBox);

  async function doDownload() {
    status.textContent = 'Saving…';
    const r = await post('/api/download', { kind, id, filename: nameInput.value, format: select.value });
    if (r && r.ok) status.innerHTML = `Saved to your Desktop as <strong>${esc(r.filename)}</strong>.`;
    else status.textContent = (r && r.error) || 'Could not save that file.';
  }
  select.onchange = doDownload;

  const actions = el('div', 'work-actions');
  const dl = el('button', 'btn btn-ghost', 'Save to my Desktop');
  dl.onclick = doDownload;
  actions.appendChild(dl);

  const toCanvas = el('button', 'btn btn-accent', 'Submit to Canvas');
  toCanvas.onclick = () => openSubmitPreview(kind, id, nameInput.value, select.value, onComplete);
  actions.appendChild(toCanvas);

  if (onComplete) {
    const done = el('button', 'btn btn-ghost', 'Mark complete');
    done.onclick = () => { closePanel(false); onComplete(); };
    actions.appendChild(done);
  }
  settings.appendChild(actions);
  openPanel();
}

// The AI-checker readout. One number and what it does and doesn't mean —
// never a list of what the detector reacted to. That was the line Will and I
// drew: a score is information about your own writing, a list of triggers is a
// recipe for making anything pass.
async function runAiCheck(kind, id, box) {
  box.className = 'ai-check';
  box.innerHTML = '';
  box.appendChild(el('div', 'ai-check-line', 'Checking your writing…'));

  let r;
  try { r = await post('/api/ai-check', { kind, id }); }
  catch { box.className = 'ai-check hidden'; return; }

  // Switched off, or nothing worth checking: say nothing at all.
  if (!r || r.state === 'off' || r.state === 'not_writing') { box.className = 'ai-check hidden'; return; }
  box.innerHTML = '';

  if (r.state === 'short') {
    box.appendChild(el('div', 'ai-check-line',
      `Too short to check — GPTZero needs about ${r.min_words} words and this has ${r.words}.`));
    return;
  }
  if (r.state === 'error') {
    box.appendChild(el('div', 'ai-check-line', esc(r.error || 'The checker did not answer.')));
    return;
  }

  const pct = r.ai_pct;
  const level = pct >= 60 ? 'high' : pct >= 25 ? 'mid' : 'low';
  const head = el('div', 'ai-check-head ' + level);
  head.appendChild(el('span', 'ai-check-pct', pct + '%'));
  head.appendChild(el('span', null, 'GPTZero says this reads as AI-written'));
  box.appendChild(head);
  box.appendChild(el('div', 'ai-check-line',
    level === 'high'
      ? 'You wrote this, so that is the detector being wrong — which they often are. Nothing here changes what you should hand in.'
      : 'For what it is worth. These detectors get it wrong in both directions, so do not read much into it either way.'));
  box.appendChild(el('div', 'ai-check-line muted-note',
    'If anyone ever questions your work, your draft history is the real answer — Slate has kept every version and when you wrote it.'));
}

// The four heading lines, editable. Saving re-renders the preview so the
// document above updates with the correction.
function headingEditor(host, p, redraw) {
  const h = p.heading;
  const wrap = el('div', 'heading-box');
  wrap.appendChild(el('div', 'section-label', 'Heading on the document'));

  const grid = el('div', 'heading-grid');
  const field = (label, node) => {
    const cell = el('div', 'heading-field');
    cell.appendChild(el('label', 'api-label', label));
    cell.appendChild(node);
    grid.appendChild(cell);
    return node;
  };

  const nameIn = el('input', 'dl-name'); nameIn.type = 'text';
  nameIn.value = h.student || ''; nameIn.placeholder = 'Your full name';
  field('Your name', nameIn);

  const titleSel = el('select', 'dl-type heading-title');
  for (const t of h.titles) {
    const o = el('option', null, t || '(none)');
    o.value = t;
    if (t === h.teacher_title) o.selected = true;
    titleSel.appendChild(o);
  }
  titleSel.value = h.teacher_title || '';
  field('Title', titleSel);

  const teachIn = el('input', 'dl-name'); teachIn.type = 'text';
  teachIn.value = h.teacher_name || ''; teachIn.placeholder = 'Teacher surname';
  field('Teacher', teachIn);

  const classIn = el('input', 'dl-name'); classIn.type = 'text';
  classIn.value = h.class_name || ''; classIn.placeholder = 'Class';
  field('Class', classIn);
  wrap.appendChild(grid);

  const save = el('button', 'btn btn-ghost btn-sm', 'Save');
  save.onclick = async () => {
    save.disabled = true; save.textContent = 'Saving…';
    await post('/api/heading', {
      class_id: p.class_id,
      student: nameIn.value,
      teacher_title: titleSel.value,
      teacher_name: teachIn.value,
      class_name: classIn.value,
    });
    redraw();
  };
  const acts = el('div', 'api-actions'); acts.appendChild(save);
  wrap.appendChild(acts);
  host.appendChild(wrap);
}

// Step two: show the student the exact thing that would be sent, and let them
// back out to the editor. Nothing has been sent at this point.
async function openSubmitPreview(kind, id, filename, format, onComplete) {
  panel.innerHTML = '';
  panel.className = 'panel handin';
  panel.appendChild(panelHeader('Check it before it goes', null, false));
  panel.appendChild(el('div', 'deliverable', 'Reading your work…'));
  openPanel();

  const p = await get(`/api/submit-preview?kind=${kind}&id=${id}`
    + `&filename=${encodeURIComponent(filename || '')}&format=${encodeURIComponent(format || '')}`);
  panel.innerHTML = '';
  panel.className = 'panel handin';
  panel.appendChild(panelHeader('Check it before it goes', `${p.assignment || ''}${p.class_name ? ' · ' + p.class_name : ''}`, false));

  if (!p || !p.ok) {
    panel.appendChild(el('div', 'deliverable', (p && p.error) || 'Slate could not work out what to send.'));
    const back0 = el('button', 'btn btn-ghost', 'Back');
    back0.onclick = () => openDownloadPopup(kind, id, onComplete);
    const acts0 = el('div', 'work-actions'); acts0.appendChild(back0);
    panel.appendChild(acts0);
    return;
  }

  // What Canvas is getting, in plain words.
  const facts = el('div', 'submit-facts');
  facts.appendChild(el('div', null, '<strong>How:</strong> ' + esc(p.how || '—')));
  if (p.filename) facts.appendChild(el('div', null, `<strong>File:</strong> ${esc(p.filename)} (${fmtBytes(p.bytes)})`));
  if (p.word_count) facts.appendChild(el('div', null, `<strong>Length:</strong> ${p.word_count} words`));
  facts.appendChild(el('div', null, '<strong>Due:</strong> ' + esc(fmtDue(p.due_at, p.due_date))));
  if (p.formatting) facts.appendChild(el('div', null, '<strong>Formatting:</strong> ' + esc(p.formatting)));
  panel.appendChild(facts);

  // The heading that goes at the top. Guessed from the class name, corrected
  // here, remembered for that class from then on.
  if (p.heading) headingEditor(panel, p, () => openSubmitPreview(kind, id, filename, format, onComplete));

  if (p.late) {
    panel.appendChild(el('div', 'submit-warn', 'The deadline for this has already passed. Canvas will mark it late.'));
  }
  if (p.already_submitted_at) {
    const when = new Date(p.already_submitted_at).toLocaleString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    panel.appendChild(el('div', 'submit-warn',
      `You already handed something in on ${esc(when)}`
      + (p.already_attempts > 1 ? ` (${p.already_attempts} attempts)` : '')
      + (p.already_scored ? ' and it has been graded' : '')
      + '. Sending this will add another attempt.'));
  }

  panel.appendChild(el('div', 'section-label', 'Exactly what will be sent'));
  const sendPaper = el('div', 'handin-paper');
  panel.appendChild(sendPaper);
  if (p.slides) {
    sendPaper.className = 'handin-paper handin-deck';
    renderSlides(sendPaper, p);
  } else {
    renderPages(sendPaper, p);
    fitPages(sendPaper);
  }

  const msg = el('div', 'api-msg');
  const actions = el('div', 'work-actions');

  const back = el('button', 'btn btn-ghost', 'Go back and edit');
  back.onclick = () => { closePanel(false); };
  actions.appendChild(back);

  if (p.empty) {
    panel.appendChild(el('div', 'submit-warn', 'There is nothing written yet.'));
  } else if (p.blocked_reason) {
    panel.appendChild(el('div', 'submit-warn', esc(p.blocked_reason) + ' Save it to your Desktop and hand it in yourself.'));
  } else if (p.not_connected) {
    panel.appendChild(el('div', 'submit-warn', 'Canvas is not connected, so Slate cannot send this. Open the API tab first.'));
  } else {
    const go = el('button', 'btn btn-accent', 'Send it to Canvas');
    go.onclick = async () => {
      go.disabled = true; back.disabled = true; go.textContent = 'Sending…';
      const r = await post('/api/submit-to-canvas', { kind, id, filename, format });
      if (!r.ok) {
        go.disabled = false; back.disabled = false; go.textContent = 'Send it to Canvas';
        msg.className = 'api-msg bad';
        msg.textContent = r.error || 'Canvas would not take it.';
        return;
      }
      panel.innerHTML = '';
      panel.appendChild(panelHeader('Handed in', null, false));
      panel.appendChild(el('div', 'deliverable',
        `Canvas has it${r.filename ? ' — ' + esc(r.filename) : ''}. Attempt ${r.attempt}.`));
      const doneActions = el('div', 'work-actions');
      const ok = el('button', 'btn btn-accent', 'Done');
      ok.onclick = () => { closePanel(false); if (onComplete) onComplete(); else render(); };
      doneActions.appendChild(ok);
      panel.appendChild(doneActions);
    };
    actions.appendChild(go);
  }

  const save = el('button', 'btn btn-ghost', 'Save to my Desktop instead');
  save.onclick = () => openDownloadPopup(kind, id, onComplete);
  actions.appendChild(save);

  panel.appendChild(actions);
  panel.appendChild(msg);
}

// Non-typed work (worksheet, photo, poster, recording…): instructions + guide.
function buildGuideWork(body, a) {
  body.appendChild(instructionsSection(a.id, a));
  body.appendChild(el('div', 'section-label', 'How to do it, step by step'));
  if (a.steps && a.steps.length) {
    const ol = el('ol', 'steps');
    a.steps.forEach((s) => ol.appendChild(el('li', null, esc(s))));
    body.appendChild(ol);
  } else {
    body.appendChild(el('div', 'deliverable', 'Work through the instructions above at your own pace.'));
  }
  attachFiles(body, a);

  const actions = el('div', 'work-actions');
  const complete = el('button', 'btn btn-accent', 'Mark complete');
  complete.onclick = async () => {
    await post(`/api/assignments/${a.id}/complete`);
    state.view = 'today'; state.workId = null; render();
  };
  actions.appendChild(complete);
  body.appendChild(actions);
  chatWidget(body, a);
}

// ---- Ask Claude ----------------------------------------------------------
// A support-desk style chat widget pinned to the bottom-right corner: a round
// launcher button that expands into a panel sitting in the same corner. Every
// send goes to a hidden `claude -p` on the server with the assignment, the
// attachment text and whatever has been typed so far, and it can search the web
// to answer properly.
//
// THE PANEL MUST NOT COVER THE WORK. Opening it adds `chat-open` to <body>,
// which reserves a lane down the right-hand side of the layout so the page
// reflows out from under the panel instead of hiding behind it. That is the
// whole difference between this and a floating overlay, and it is what Will
// asked for.
//
// It lives inside #app and is rebuilt on every render like everything else —
// position:fixed does not care who its parent is. Open/closed survives a
// re-render because it is held in `state.chatOpen`, not in the DOM.
//
// It is a TUTOR, not a writer — the server prompt forbids it producing anything
// pasteable and the panel says the same thing. See src/assignmentChat.js.

// Reserving (or releasing) the lane the panel sits in. Called on open, on close
// and by render() when leaving the page, so no other view inherits the gap.
function setChatLane(on) {
  if (document.body && document.body.classList) document.body.classList.toggle('chat-open', !!on);
}

// Replies are prose. Blank lines become paragraphs and single newlines stay as
// line breaks; everything is escaped first, so nothing Claude says can put
// markup on the page.
function chatParagraphs(text) {
  const wrap = el('div', 'chat-text');
  String(text || '').split(/\n{2,}/).forEach((block) => {
    const t = block.trim();
    if (t) wrap.appendChild(el('p', null, esc(t).replace(/\n/g, '<br>')));
  });
  if (!wrap.children.length) wrap.appendChild(el('p', null, esc(text || '')));
  return wrap;
}

function chatBubble(m) {
  const row = el('div', 'chat-msg chat-' + (m.role === 'claude' ? 'claude' : 'you'));
  row.appendChild(el('div', 'chat-who', m.role === 'claude' ? 'Claude' : 'You'));
  row.appendChild(chatParagraphs(m.text));
  return row;
}

function chatWidget(body, a) {
  const root = el('div', 'chat-root');

  // ---- the closed state: one button in the corner
  const launcher = el('button', 'chat-launcher');
  launcher.title = 'Ask Claude about this assignment';
  // Drawn, not an emoji. Round 24 took every emoji out of Slate and a speech
  // bubble from the font renders as a grey blob on the sage pill anyway.
  launcher.appendChild(el('span', 'chat-launcher-icon',
    '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">'
    + '<path d="M4 5.5h16v11H9.5L5.5 20v-3.5H4z" fill="none" stroke="currentColor"'
    + ' stroke-width="1.9" stroke-linejoin="round"/></svg>'));
  launcher.appendChild(el('span', 'chat-launcher-label', 'Ask Claude'));

  // ---- the open state: the panel, same corner
  const wrap = el('div', 'chat-panel');
  const head = el('div', 'chat-head');
  const heading = el('div', 'chat-head-text');
  heading.appendChild(el('div', 'chat-title', 'Ask Claude'));
  heading.appendChild(el('div', 'chat-sub', 'About this assignment. It will not write it for you.'));
  head.appendChild(heading);
  const clear = el('button', 'chat-icon-btn hidden', 'Clear');
  clear.title = 'Delete this conversation';
  const close = el('button', 'chat-icon-btn chat-close', '&#10005;');
  close.title = 'Close';
  head.appendChild(clear);
  head.appendChild(close);
  wrap.appendChild(head);

  const log = el('div', 'chat-log');
  wrap.appendChild(log);

  const foot = el('div', 'chat-foot');
  const status = el('div', 'chat-status', '');
  const box = el('textarea', 'chat-input');
  // Deliberately generic: this panel is on maths worksheets and history essays
  // alike, and a subject-specific example looks wrong on most of them.
  box.placeholder = 'Ask anything about this assignment…';
  box.rows = 2;
  const row = el('div', 'chat-actions');
  const send = el('button', 'btn btn-accent chat-send', 'Send');
  const stop = el('button', 'btn btn-ghost chat-stop hidden', 'Stop');
  row.appendChild(send); row.appendChild(stop);
  foot.appendChild(status);
  foot.appendChild(box);
  foot.appendChild(row);
  wrap.appendChild(foot);

  root.appendChild(launcher);
  root.appendChild(wrap);
  body.appendChild(root);

  // ---- open / closed -------------------------------------------------------
  const paint = () => {
    launcher.classList.toggle('hidden', !!state.chatOpen);
    wrap.classList.toggle('hidden', !state.chatOpen);
    setChatLane(state.chatOpen);
  };
  const open = () => {
    state.chatOpen = true;
    paint();
    if (typeof box.focus === 'function') box.focus();
    showNewest();
  };
  const shut = () => { state.chatOpen = false; paint(); };
  launcher.onclick = open;
  close.onclick = shut;

  // ---- the conversation ----------------------------------------------------
  let messages = [];
  const draw = () => {
    log.innerHTML = '';
    if (!messages.length) {
      const blank = el('div', 'chat-empty');
      blank.appendChild(el('p', null, 'Ask about anything here — what the assignment means, '
        + 'background research, or whether what you have written so far holds up.'));
      blank.appendChild(el('p', null, 'It can look things up on the web.'));
      log.appendChild(blank);
      clear.classList.add('hidden');
    } else {
      messages.forEach((m) => log.appendChild(chatBubble(m)));
      clear.classList.remove('hidden');
    }
  };
  // The log is the scrolling part of the panel, so a new reply lands below the
  // fold. Guarded: the drive harness's DOM shim has no scrollTop worth setting.
  function showNewest() {
    if (typeof log.scrollHeight === 'number') log.scrollTop = log.scrollHeight;
  }
  draw();
  paint();

  get(`/api/assignments/${a.id}/chat`)
    .then((r) => { if (r && r.messages) { messages = r.messages; draw(); showNewest(); } })
    .catch(() => { /* an empty chat is a fine starting point */ });

  // Only touches the controls. The status line is set by the caller, because
  // finishing is exactly when an error message needs to survive.
  const busy = (on) => {
    send.disabled = on;
    box.disabled = on;
    clear.disabled = on;
    stop.classList.toggle('hidden', !on);
  };

  const ask = async () => {
    const question = box.value.trim();
    if (!question || send.disabled) return;
    // Send the newest text, not whatever was last autosaved — Claude is being
    // asked about the draft, so it has to be the draft that is on screen.
    if (pageDraft) { try { await pageDraft.flush(); } catch { /* send it anyway */ } }
    box.value = '';
    // Show the question straight away; the server only commits it if Claude answers.
    messages = messages.concat([{ role: 'you', text: question }]);
    draw();
    showNewest();
    busy(true);
    status.textContent = 'Thinking… this can take a minute if it is looking things up.';
    const ac = new AbortController();
    pageChat = ac;
    try {
      const res = await fetch(`/api/assignments/${a.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: ac.signal,
      });
      const r = await res.json();
      if (r && r.ok) {
        messages = r.messages;
        status.textContent = '';
        // Grammar corrections land in the editor behind the panel. Told to the
        // draft handle as well as the DOM, so the next autosave doesn't put the
        // uncorrected version straight back.
        if (r.draft && pageDraft) {
          pageDraft.adopt(r.draft.html == null ? r.draft.text : r.draft.html);
          status.textContent = r.draft.applied === 1
            ? '1 fix applied to your writing.'
            : `${r.draft.applied} fixes applied to your writing.`;
        }
        draw();
        showNewest();
      } else {
        // Nothing was saved, so drop the optimistic bubble and give the question back.
        messages = messages.slice(0, -1);
        box.value = (r && r.question) || question;
        status.textContent = (r && r.error) || 'That did not work. Try again.';
        draw();
      }
    } catch (err) {
      messages = messages.slice(0, -1);
      box.value = question;
      draw();
      status.textContent = ac.signal.aborted ? 'Stopped.' : 'That did not work. Try again.';
    } finally {
      if (pageChat === ac) pageChat = null;
      busy(false);
    }
  };

  send.onclick = ask;
  stop.onclick = () => { if (pageChat) pageChat.abort(); };
  // Enter sends, Shift+Enter makes a new line — what a chat box is expected to do.
  box.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  };
  clear.onclick = async () => {
    await post(`/api/assignments/${a.id}/chat/clear`, {});
    messages = [];
    status.textContent = '';
    draw();
  };
}
// Files the teacher attached in Canvas. Clicking one downloads it (once) and
// opens it in whatever program this computer already uses for that type —
// Word for a .docx, Excel for a .xlsx, the PDF reader for a PDF. Slate has no
// viewer of its own on purpose.
function attachFiles(body, a) {
  if (!a.files || !a.files.length) return;
  body.appendChild(el('div', 'section-label', a.files.length === 1 ? 'Attached file' : 'Attached files'));
  const row = el('div', 'file-row');
  a.files.forEach((f) => {
    const btn = el('button', 'file-chip');
    btn.appendChild(el('span', 'file-kind', esc((f.kind || 'file').toUpperCase())));
    btn.appendChild(el('span', 'file-name', esc(f.name)));
    const note = el('span', 'file-note', '');
    btn.appendChild(note);
    btn.onclick = async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      note.textContent = f.downloaded ? 'Opening…' : 'Getting it from Canvas…';
      const r = await post(`/api/assignments/${a.id}/files/open`, { index: f.index });
      if (r && r.ok) { f.downloaded = true; note.textContent = 'Opened'; setTimeout(() => { note.textContent = ''; }, 2500); }
      else note.textContent = (r && r.error) || "couldn't open that";
      btn.disabled = false;
    };
    row.appendChild(btn);
  });
  body.appendChild(row);
  // No "Slate is reading these…" line here. The page is fetched before the read
  // finishes, so it sat on screen saying "reading" long after the file had been
  // read. The Instructions box has its own note while it waits, which is the
  // right place for it.
}

// ---- WEEK ----------------------------------------------------------------
// What a day holds, in the order it should be read.
function weekDayItems(d, finished) {
  if (finished) {
    return [
      ...d.done_assignments.map((a) => ({ ...a, kind: 'regular' })),
      ...d.done_projects.map((p) => ({ ...p, kind: 'project' })),
    ];
  }
  return [
    ...d.tests.map((t) => ({ ...t, kind: 'test', title: `${t.type === 'quiz' ? 'Quiz' : 'Test'}: ${t.name}` })),
    ...d.assignments.map((a) => ({ ...a, kind: 'regular' })),
    ...d.projects.map((p) => ({ ...p, kind: 'project' })),
  ];
}

async function renderWeek() {
  const days = await get('/api/week');
  app.appendChild(el('h1', 'view-title', 'This week'));
  app.appendChild(el('div', 'view-sub', 'Everything due over the next 7 days. Click a day to open it.'));

  const showFinished = state.doneTab === 'finished';
  const totals = days.reduce((acc, d) => ({
    left: acc.left + weekDayItems(d, false).length,
    done: acc.done + weekDayItems(d, true).length,
  }), { left: 0, done: 0 });
  app.appendChild(doneSwitcher(totals.left, totals.done));

  const wrap = el('div'); wrap.style.marginTop = '14px';
  for (const d of days) {
    const items = weekDayItems(d, showFinished);
    const col = el('div', 'day-col clickable' + (d.is_today ? ' today' : ''));
    const head = el('div', 'day-head');
    head.appendChild(el('div', 'day-name', esc(d.label) + (d.is_today ? ' · Today' : '')));
    const left = weekDayItems(d, false).length;
    const done = weekDayItems(d, true).length;
    head.appendChild(el('span', 'pill muted',
      showFinished ? (done ? `${done} done` : 'none done')
        : left ? `${left} left` : (done ? 'all done' : 'clear')));
    col.appendChild(head);

    items.forEach((it) => col.appendChild(weekItem(it.kind, it.title, it.class_name, showFinished)));
    if (!items.length) {
      col.appendChild(el('div', 'day-item', '<span style="color:var(--muted)">'
        + (showFinished ? 'Nothing finished' : 'Nothing due') + '</span>'));
    }
    col.onclick = () => openWeekDay(d, showFinished);
    wrap.appendChild(col);
  }
  app.appendChild(wrap);
}

// One day, opened up: a card per thing due, each one a way into its page.
function openWeekDay(d, showFinished) {
  const items = weekDayItems(d, showFinished);
  panel.innerHTML = '';
  panel.appendChild(panelHeader(d.label + (d.is_today ? ' · Today' : ''),
    showFinished ? 'What you finished for this day.' : 'Everything due this day.', false));

  if (!items.length) {
    panel.appendChild(el('div', 'deliverable',
      showFinished ? 'Nothing finished for this day yet.' : 'Nothing due this day.'));
    openPanel();
    return;
  }

  const grid = el('div', 'grid');
  for (const it of items) {
    const card = el('div', 'card' + (showFinished ? ' finished' : ''));
    card.appendChild(el('div', 'card-title', esc(it.title)));
    card.appendChild(el('div', 'card-class', esc(it.class_name)));
    card.appendChild(el('div', 'card-due', 'Due ' + esc(fmtDue(it.due_at, d.day))));
    const pills = el('div', 'pill-row');
    pills.appendChild(el('span', 'pill' + (it.kind === 'regular' ? '' : ' muted'),
      it.kind === 'test' ? 'Test' : it.kind === 'project' ? 'Project' : 'Assignment'));
    if (it.points) pills.appendChild(el('span', 'pill muted', it.points + ' pts'));
    card.appendChild(pills);
    card.onclick = () => {
      closePanel(false);
      if (it.kind === 'test') { state.view = 'test'; state.testId = it.id; }
      else if (it.kind === 'project') { state.view = 'project'; state.projectId = it.id; }
      else { state.view = 'work'; state.workId = it.id; }
      render();
    };
    grid.appendChild(card);
  }
  panel.appendChild(grid);
  openPanel();
}
function weekItem(kind, text, cls, done) {
  const row = el('div', 'day-item' + (done ? ' finished' : ''));
  row.appendChild(el('span', 'dot ' + kind));
  row.appendChild(el('span', null, esc(text) + ` <span style="color:var(--muted)">· ${esc(cls)}</span>`));
  return row;
}

// ---- PROJECTS ------------------------------------------------------------
async function renderProjects() {
  const data = await get('/api/projects');
  app.appendChild(el('h1', 'view-title', 'Projects'));
  app.appendChild(el('div', 'view-sub', 'The bigger pieces of work, soonest deadline first.'));
  if (!data.length) { app.appendChild(emptyOr('No active projects', 'Projects will show up here.')); return; }
  const grid = el('div', 'grid'); grid.style.marginTop = '14px';
  for (const p of data) {
    const card = el('div', 'card');
    card.appendChild(el('div', 'card-title', esc(p.title)));
    card.appendChild(el('div', 'card-class', esc(p.class_name)));
    card.appendChild(el('div', 'card-due', 'Due ' + esc(fmtDue(p.due_at, p.due_date))));
    if (p.points) {
      // A bare span in the card stretches — .card is a flex column.
      const pills = el('div', 'pill-row');
      pills.appendChild(el('span', 'pill', p.points + ' pts'));
      card.appendChild(pills);
    }
    card.onclick = () => { state.view = 'project'; state.projectId = p.id; render(); };
    grid.appendChild(card);
  }
  app.appendChild(grid);
}

// Full page for one project.
async function renderProjectPage() {
  const p = await get('/api/projects/' + state.projectId);
  if (!p || p.error) { state.view = 'projects'; return render(); }

  const back = el('button', 'btn btn-ghost back-btn', '← Back to Projects');
  back.onclick = () => { state.view = 'projects'; state.projectId = null; render(); };
  app.appendChild(back);

  const head = el('div', 'work-head');
  head.appendChild(el('h1', 'view-title', esc(p.title)));
  head.appendChild(el('div', 'view-sub', `${esc(p.class_name)} · ${esc(p.points)} pts · due ${fmtDate(p.due_date)}`));
  app.appendChild(head);

  const body = el('div', 'work-body');
  body.appendChild(instructionsSection(p.id, p));
  attachFiles(body, p);

  // Slideshow projects get a build-your-slides tool; essays get the editor.
  if (p.build_mode === 'slides') buildSlideMaker(body, p);
  else if (p.build_mode === 'essay') buildEssayEditor(body, p);

  // Guide-mode projects have no builder of their own, so they at least get a
  // way to say they're finished.
  if (p.build_mode !== 'slides' && p.build_mode !== 'essay') {
    const actions = el('div', 'work-actions');
    const done = el('button', 'btn btn-accent', 'Mark complete');
    done.onclick = async () => {
      await post(`/api/assignments/${p.id}/complete`);
      state.view = 'projects'; state.projectId = null; render();
    };
    actions.appendChild(done);
    body.appendChild(actions);
  }
  app.appendChild(body);
}

// Slideshow builder: edit slides in-app, autosave, then Submit -> download popup.
function buildSlideMaker(body, p) {
  const normalize = (list) => {
    const out = (list || []).map((s) => ({
      title: s.title || '',
      bullets: (s.bullets && s.bullets.length) ? s.bullets.slice() : [''],
      photo: !!s.photo,
    }));
    // Slide 1 is always the title slide, pre-filled with the assignment name.
    if (!out.length) out.push({ title: p.title, bullets: [p.class_name || ''], photo: false });
    if (!out[0].title.trim()) out[0].title = p.title;
    if (out.length === 1) out.push({ title: '', bullets: [''], photo: false });
    return out;
  };
  let slides = normalize(p.slides);

  // No "Fill suggestions" button for now — Will asked for it off the page.
  // The server side (POST /api/projects/:id/suggestions and
  // outline.generateSuggestions) is still there and still works, so putting it
  // back is a button, not a rebuild.
  const list = el('div', 'slides-list');
  body.appendChild(list);

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => post(`/api/projects/${p.id}/slides`, { slides }), 600);
  }
  // Runs by itself the first time a slideshow project is opened, so the builder
  // isn't a blank page. It only fills in HEADERS.
  async function autoOutline() {
    list.innerHTML = '';
    list.appendChild(el('div', 'deliverable', 'Building your slide outline from the assignment… this takes a few seconds.'));
    const r = await post(`/api/projects/${p.id}/outline`, {});
    if (r && r.ok && r.slides && r.slides.length) slides = normalize(r.slides);
    draw();
  }

  function draw() {
    list.innerHTML = '';
    slides.forEach((slide, i) => {
      const isTitle = i === 0;
      const card = el('div', 'slide-edit' + (isTitle ? ' title-slide' : ''));
      const top = el('div', 'slide-edit-top');
      top.appendChild(el('span', 'slide-num', isTitle ? 'Title slide' : 'Slide ' + (i + 1)));
      if (!isTitle) {
        const del = el('button', 'btn btn-danger btn-sm', 'Remove');
        del.onclick = () => { slides.splice(i, 1); if (slides.length === 1) slides.push({ title: '', bullets: [''], photo: false }); save(); draw(); };
        top.appendChild(del);
      }
      card.appendChild(top);

      const title = el('input', 'slide-title');
      title.type = 'text';
      title.placeholder = isTitle ? 'Name of your presentation' : 'Slide title';
      title.value = slide.title;
      title.oninput = () => { slide.title = title.value; save(); };
      card.appendChild(title);

      if (isTitle) {
        // The title slide takes one line under the title, not bullet points.
        const sub = el('input', 'slide-title slide-sub');
        sub.type = 'text';
        sub.placeholder = 'Subtitle (your class, your name…)';
        sub.value = (slide.bullets || [])[0] || '';
        sub.oninput = () => { slide.bullets = [sub.value]; save(); };
        card.appendChild(sub);
        list.appendChild(card);
        return;
      }

      const bullets = el('textarea', 'slide-bullets');
      bullets.placeholder = 'One point per line…';
      bullets.value = (slide.bullets || []).join('\n');
      bullets.oninput = () => { slide.bullets = bullets.value.split('\n'); save(); };
      card.appendChild(bullets);

      const picRow = el('label', 'pic-toggle');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!slide.photo;
      cb.onchange = () => { slide.photo = cb.checked; save(); };
      picRow.appendChild(cb);
      picRow.appendChild(el('span', null, 'Leave space for a picture on this slide'));
      card.appendChild(picRow);

      list.appendChild(card);
    });
    const add = el('button', 'btn btn-ghost', '+ Add slide');
    add.onclick = () => { slides.push({ title: '', bullets: [''], photo: false }); save(); draw(); };
    list.appendChild(add);
  }
  // First time on a slideshow project: auto-build the outline. After that,
  // show the saved slides (the student's edits).
  if (p.has_custom_slides) draw(); else autoOutline();

  const submit = el('button', 'btn btn-accent', 'Make my PowerPoint');
  submit.style.marginTop = '14px';
  submit.onclick = async () => {
    clearTimeout(saveTimer);
    await post(`/api/projects/${p.id}/slides`, { slides });
    openDownloadPopup('project', p.id, null);
  };
  body.appendChild(submit);
}

// ---- ESSAY EDITOR (project build_mode = 'essay') -------------------------
// A proper writing surface: autosave, live counts, a paragraph outline you can
// jump around, and a "Get unstuck" coach that reads the draft and tells you
// what the section you're stuck on has to do. The coach never writes any of
// the essay — its notes land in their own panel, never in your text.

// Blank-line separated paragraphs, with where each one starts and ends.
function essayBlocks(text) {
  const out = [];
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].trim();
    if (t) out.push({ start: m.index, end: m.index + m[0].length, text: t });
  }
  return out;
}
function blockIndexAt(blocks, pos) {
  for (let i = 0; i < blocks.length; i++) {
    if (pos >= blocks[i].start && pos <= blocks[i].end) return i;
  }
  return -1;
}
function shortText(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n).trimEnd() + '…' : t;
}

// Name each paragraph: intro/thesis, body 1..n, conclusion, works cited.
// The last paragraph is only called the conclusion once the essay is actually
// as long as it needs to be (or it opens with a wrap-up phrase) — mid-draft the
// paragraph you're working on is a body paragraph, not the ending.
function essayRoles(blocks, targetParagraphs) {
  const n = blocks.length;
  const isCitedHeader = (t) => /^\s*(works\s+cited|bibliography|references)\b/i.test(t);
  const isWrapUp = (t) => /^\s*(in conclusion|to conclude|in the end|overall|ultimately|all in all|in summary|to sum up|finally)\b/i.test(t);

  // Once the Works Cited heading appears, everything after it is citations —
  // they usually sit in their own block below a blank line.
  const cited = [];
  let inCited = false;
  for (let i = 0; i < n; i++) {
    if (!inCited && isCitedHeader(blocks[i].text)) inCited = true;
    cited.push(inCited);
  }
  let lastIdx = -1;
  for (let i = n - 1; i >= 0; i--) { if (!cited[i]) { lastIdx = i; break; } }
  const bodyCount = blocks.filter((b, j) => !cited[j] && j > 0).length;
  const essayLen = cited.filter((c) => !c).length;   // citations aren't paragraphs
  const longEnough = targetParagraphs ? essayLen >= targetParagraphs : essayLen >= 4;

  const roles = [];
  let body = 0;
  for (let i = 0; i < n; i++) {
    if (cited[i]) { roles.push('Works cited'); continue; }
    if (i === 0) { roles.push('Intro & thesis'); continue; }
    if (isWrapUp(blocks[i].text) || (i === lastIdx && bodyCount >= 2 && longEnough)) {
      roles.push('Conclusion');
      continue;
    }
    body += 1;
    roles.push('Body ' + body);
  }
  return roles;
}
function wordCount(s) {
  const m = String(s || '').trim().match(/\S+/g);
  return m ? m.length : 0;
}

// Sentences written so far. Abbreviations ("Dr.", "U.S.", "3.14") each look like
// a sentence ending, so they get masked before splitting. Must stay in step with
// countSentences in src/unstuck.js — the server computes the same number.
const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|al|Inc|Ltd|Co|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mon|Tues?|Wed|Thurs?|Fri|Sat|Sun|Vol|pp?|eds?|cf)\./gi;
function countSentences(text) {
  const t = String(text || '')
    .replace(/\b(?:[A-Za-z]\.){2,}/g, 'X')
    .replace(ABBREVIATIONS, '$1')
    .replace(/\b\d+\.\d+/g, '0');
  return t.split(/[.!?]+(?=\s|$)/).map((s) => s.trim()).filter((s) => /\w/.test(s)).length;
}

function buildEssayEditor(body, p) {
  const target = p.essay_target || {};
  const sentenceGoal = target.sentences || 30;

  // How far along the essay is — measured by what's written, not by chunks
  // ticked off. Recomputed on every keystroke.
  const donePct = el('div', 'essay-done');
  body.appendChild(donePct);
  function drawDone() {
    // Works Cited entries are not essay sentences — they'd inflate the percent.
    const blocks = essayBlocks(ta.value);
    const roles = essayRoles(blocks, target.paragraphs);
    const prose = blocks.filter((b, i) => roles[i] !== 'Works cited').map((b) => b.text).join('\n\n');
    const n = countSentences(prose);
    const pct = Math.min(100, Math.round((n / sentenceGoal) * 100));
    donePct.innerHTML = `<span class="essay-pct">${pct}%</span> <span class="essay-pct-sub">of your essay written · ${n} of about ${sentenceGoal} sentences</span>`;
  }

  const head = el('div', 'card-row');
  head.appendChild(el('div', 'section-label', 'Your essay'));
  const submit = el('button', 'btn btn-ghost btn-sm', 'Put it together & hand in');
  head.appendChild(submit);
  body.appendChild(head);

  const wrap = el('div', 'essay-wrap');
  const main = el('div', 'essay-main');
  const side = el('aside', 'essay-side');
  wrap.appendChild(main);
  wrap.appendChild(side);
  body.appendChild(wrap);

  // --- toolbar + writing surface
  const bar = el('div', 'essay-bar');
  const unstuckBtn = el('button', 'btn btn-accent btn-sm', 'Get unstuck');
  const cancelBtn = el('button', 'btn btn-ghost btn-sm hidden', 'Cancel');
  const saveNote = el('span', 'bar-label essay-save');
  bar.appendChild(unstuckBtn);
  bar.appendChild(cancelBtn);
  bar.appendChild(saveNote);
  main.appendChild(bar);

  const ta = el('textarea', 'editor essay-editor');
  ta.placeholder = 'Start writing… it saves as you go.\n\nLeave a blank line between paragraphs — that is how the outline on the right knows where they are.';
  ta.value = p.draft_text || '';
  main.appendChild(listToolbar(ta, () => (ta.listeners.input || []).forEach((fn) => fn())));
  main.appendChild(ta);

  const stats = el('div', 'essay-stats');
  main.appendChild(stats);
  // How long this is in Word, without opening the hand-in screen.
  const meter = pageMeter('essay', p.id, () => pageDraft);
  main.appendChild(meter.node);
  meter.now();

  // --- outline + coach panel
  side.appendChild(el('div', 'section-label', 'Paragraphs'));
  const outline = el('div', 'essay-outline');
  side.appendChild(outline);
  const coach = el('div', 'coach hidden');
  side.appendChild(coach);

  // --- live counts
  function drawStats() {
    const words = wordCount(ta.value);
    const chars = ta.value.length;
    const mins = Math.max(1, Math.round(words / 200));
    const bits = [
      `${words} word${words === 1 ? '' : 's'}`,
      `${chars} character${chars === 1 ? '' : 's'}`,
      `~${mins} min read`,
    ];
    if (target.words) bits.push(`goal ${target.words} words — ${Math.min(100, Math.round((words / target.words) * 100))}%`);
    stats.textContent = bits.join(' · ');
  }

  // --- outline: one row per paragraph, click to jump there
  let blocks = [];
  function drawOutline() {
    blocks = essayBlocks(ta.value);
    outline.innerHTML = '';
    if (!blocks.length) {
      outline.appendChild(el('div', 'bar-label', 'Nothing yet — your paragraphs will show up here.'));
      return;
    }
    const here = blockIndexAt(blocks, ta.selectionStart);
    const roles = essayRoles(blocks, target.paragraphs);
    blocks.forEach((b, i) => {
      const row = el('div', 'outline-row' + (i === here ? ' here' : ''));
      const top = el('div', 'outline-top');
      top.appendChild(el('span', 'outline-num', String(i + 1)));
      top.appendChild(el('span', 'outline-role', esc(roles[i])));
      top.appendChild(el('span', 'outline-words', wordCount(b.text) + 'w'));
      row.appendChild(top);
      row.appendChild(el('div', 'outline-text', esc(shortText(b.text, 44))));
      row.onclick = () => jumpTo(b.start);
      outline.appendChild(row);
    });
    if (target.paragraphs) {
      outline.appendChild(el('div', 'bar-label', `${blocks.length} of ${target.paragraphs} paragraphs`));
    }
  }
  function jumpTo(pos) {
    ta.focus();
    ta.setSelectionRange(pos, pos);
    const line = ta.value.slice(0, pos).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24;
    ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 3);
    drawOutline();
  }

  // --- autosave (debounced) — the draft is the single source of truth
  let deb = null;
  const draft = registerDraft(p.id, ta, () => { saveNote.textContent = 'Saved'; meter.update(); });
  function saveNow() {
    clearTimeout(deb);
    return draft.flush();
  }
  ta.addEventListener('input', () => {
    saveNote.textContent = 'Saving…';
    drawStats();
    drawOutline();
    drawDone();
    clearTimeout(deb);
    deb = setTimeout(saveNow, 1200);
  });
  ['click', 'keyup', 'select'].forEach((ev) => ta.addEventListener(ev, () => {
    const here = blockIndexAt(essayBlocks(ta.value), ta.selectionStart);
    const rows = outline.querySelectorAll('.outline-row');
    rows.forEach((r, i) => r.classList.toggle('here', i === here));
  }));

  // --- where am I stuck? (highlighted text wins, else the paragraph I'm in)
  function stuckNote() {
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (e > s) {
      const sel = ta.value.slice(s, e).trim();
      if (sel) return `the part I highlighted: "${shortText(sel, 240)}"`;
    }
    const bs = essayBlocks(ta.value);
    if (!bs.length) return 'continue from where the draft leaves off';
    const roles = essayRoles(bs, target.paragraphs);
    const i = blockIndexAt(bs, s);
    if (i === -1) {
      const before = bs.filter((b) => b.end <= s).length;
      if (before >= bs.length) return `the new paragraph I am about to write after the ${roles[bs.length - 1].toLowerCase()} (paragraph ${bs.length} of ${bs.length})`;
      return `a new paragraph I want to add between the ${roles[before - 1].toLowerCase()} and the ${roles[before].toLowerCase()}`;
    }
    return `the ${roles[i].toLowerCase()} — paragraph ${i + 1} of ${bs.length}, which starts "${shortText(bs[i].text, 140)}"`;
  }

  // --- the coach
  let inflight = null;
  function coachMessage(msg) {
    coach.classList.remove('hidden');
    coach.innerHTML = '';
    coach.appendChild(el('div', 'coach-line', esc(msg)));
  }
  function showGuidance(g) {
    coach.classList.remove('hidden');
    coach.innerHTML = '';
    const top = el('div', 'coach-top');
    top.appendChild(el('div', 'coach-title', 'Unstuck'));
    const close = el('button', 'panel-close', '&times;');
    close.onclick = () => { coach.classList.add('hidden'); coach.innerHTML = ''; };
    top.appendChild(close);
    coach.appendChild(top);

    if (g.where_you_are) {
      coach.appendChild(el('div', 'coach-head', 'Where you are'));
      coach.appendChild(el('div', 'coach-line', esc(g.where_you_are)));
    }
    if (g.next) {
      coach.appendChild(el('div', 'coach-head', 'What this part has to do'));
      coach.appendChild(el('div', 'coach-line', esc(g.next)));
    }
    if (g.points && g.points.length) {
      coach.appendChild(el('div', 'coach-head', 'Hit these'));
      const ul = el('ul', 'instructions');
      g.points.forEach((pt) => ul.appendChild(el('li', null, esc(pt))));
      coach.appendChild(ul);
    }
    if (g.question) {
      coach.appendChild(el('div', 'coach-head', 'Answer this first'));
      coach.appendChild(el('div', 'coach-q', esc(g.question)));
    }
    coach.appendChild(el('div', 'coach-foot', 'Notes to write from — every word in the essay stays yours.'));
  }

  async function getUnstuck() {
    if (inflight) return;
    if (!ta.value.trim()) {
      coachMessage('Write a sentence or two first — the coach works off what you have already said.');
      return;
    }
    const note = stuckNote();
    inflight = new AbortController();
    unstuckBtn.disabled = true;
    unstuckBtn.textContent = 'Thinking…';
    cancelBtn.classList.remove('hidden');
    coachMessage('Reading your draft…');
    try {
      await saveNow();
      const r = await fetch(`/api/projects/${p.id}/unstuck`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: ta.value, stuck_note: note }),
        signal: inflight.signal,
      });
      const g = await r.json();
      if (g && g.ok) showGuidance(g);
      else coachMessage((g && g.error) || 'Could not get you unstuck just now. Your draft is untouched.');
    } catch (err) {
      if (err.name === 'AbortError') { coach.classList.add('hidden'); coach.innerHTML = ''; }
      else coachMessage('Could not reach the coach. Check that Claude Code is set up on this computer — your draft is untouched.');
    } finally {
      inflight = null;
      unstuckBtn.disabled = false;
      unstuckBtn.textContent = 'Get unstuck';
      cancelBtn.classList.add('hidden');
    }
  }
  unstuckBtn.onclick = getUnstuck;
  cancelBtn.onclick = () => { if (inflight) inflight.abort(); };

  submit.onclick = async () => {
    await saveNow();
    openEssayFinish(p.id);
  };

  drawStats();
  drawOutline();
  drawDone();
}

// ---- finishing an essay: MLA assembly + hand-in --------------------------
// Pulls every paragraph together in MLA format, shows what's still missing,
// and saves the finished file to the Desktop. Slate formats; Will wrote it.
async function openEssayFinish(projectId) {
  panel.innerHTML = '';
  panel.appendChild(panelHeader('Put your essay together', 'MLA format, ready to hand in'));
  const host = el('div');
  panel.appendChild(host);
  openPanel();
  drawEssayFinish(host, projectId, await get(`/api/projects/${projectId}/review`));
}

function drawEssayFinish(host, projectId, r) {
  host.innerHTML = '';
  if (!r || r.error) { host.appendChild(el('div', 'deliverable', 'Could not put that together.')); return; }
  if (!r.paragraph_count) {
    host.appendChild(el('div', 'deliverable', 'There is nothing written yet — write some paragraphs first.'));
    return;
  }

  // The MLA heading details, remembered after the first time.
  host.appendChild(el('div', 'section-label', 'MLA heading'));
  const nameRow = el('div', 'dl-row');
  const nameIn = el('input', 'dl-name'); nameIn.type = 'text'; nameIn.placeholder = 'Your full name'; nameIn.value = r.student_name || '';
  const teachIn = el('input', 'dl-name'); teachIn.type = 'text'; teachIn.placeholder = 'Teacher (e.g. Ms. Rivera)'; teachIn.value = r.teacher_name || '';
  nameRow.appendChild(nameIn); nameRow.appendChild(teachIn);
  host.appendChild(nameRow);
  const titleIn = el('input', 'dl-name'); titleIn.type = 'text';
  titleIn.placeholder = 'Your title for the essay';
  titleIn.value = r.title || '';
  titleIn.style.width = '100%';
  titleIn.style.marginTop = '8px';
  host.appendChild(titleIn);
  const saveNames = el('button', 'btn btn-ghost btn-sm', 'Save');
  saveNames.style.marginTop = '8px';
  saveNames.onclick = async () => {
    saveNames.disabled = true;
    const upd = await post(`/api/projects/${projectId}/review`, {
      student_name: nameIn.value, teacher_name: teachIn.value, title: titleIn.value,
    });
    drawEssayFinish(host, projectId, upd);
  };
  host.appendChild(saveNames);

  // What's done and what isn't.
  host.appendChild(el('div', 'section-label', 'Before you hand it in'));
  const list = el('ul', 'checks');
  r.checks.forEach((c) => {
    const li = el('li', c.ok ? 'ok' : 'todo');
    li.appendChild(el('span', 'check-mark', c.ok ? '✓' : '○'));
    li.appendChild(el('span', null, esc(c.label)));
    list.appendChild(li);
  });
  host.appendChild(list);

  // Your own record that you wrote it, over time.
  if (r.history && r.history.versions) {
    const h = r.history;
    const bits = [`${h.versions} saved version${h.versions === 1 ? '' : 's'}`];
    bits.push(h.days > 1 ? `across ${h.days} days` : 'so far');
    host.appendChild(el('div', 'section-label', 'Your writing record'));
    host.appendChild(el('div', 'bar-label', esc(bits.join(' · ')) + ' — Slate keeps this so you can always show how the essay got written.'));
  }

  host.appendChild(el('div', 'section-label', `Preview — ${r.paragraph_count} paragraphs, ${r.words} words`));
  host.appendChild(el('pre', 'mla-preview', esc(r.preview)));

  const actions = el('div', 'work-actions');
  const dl = el('button', 'btn btn-accent', 'This is done — save it to my Desktop');
  dl.onclick = () => openDownloadPopup('essay', projectId, null);
  actions.appendChild(dl);
  const back = el('button', 'btn btn-ghost', 'Keep working on it');
  back.onclick = () => closePanel();
  actions.appendChild(back);
  host.appendChild(actions);
  if (!r.all_clear) {
    host.appendChild(el('div', 'bar-label', 'You can still save it with items unchecked — those are just reminders.'));
  }
}

// ---- TESTS ---------------------------------------------------------------
let testsPollTimer = null;
// How far ahead the Tests page is looking. 0 = everything, which is how it opens.
const TEST_WINDOWS = [
  { weeks: 1, label: '1 week' },
  { weeks: 2, label: '2 weeks' },
  { weeks: 3, label: '3 weeks' },
  { weeks: 4, label: '4 weeks' },
  { weeks: 0, label: 'All' },
];

function testWindowSwitcher() {
  const wrap = el('div', 'switch-center');
  const group = el('div', 'toggle-group');
  for (const w of TEST_WINDOWS) {
    const btn = el('button', state.testWeeks === w.weeks ? 'active' : '', w.label);
    btn.onclick = () => { state.testWeeks = w.weeks; render(); };
    group.appendChild(btn);
  }
  wrap.appendChild(group);
  return wrap;
}

async function renderTests() {
  const weeks = state.testWeeks || 0;
  const data = await get('/api/tests' + (weeks ? '?weeks=' + weeks : ''));
  app.appendChild(el('h1', 'view-title', 'Tests & Quizzes'));
  app.appendChild(el('div', 'view-sub', 'Drag a notes file onto a test to turn it into flashcards + study notes.'));
  app.appendChild(testWindowSwitcher());
  if (!data.length) {
    app.appendChild(weeks
      ? emptyState('Nothing in the next ' + (weeks === 1 ? 'week' : weeks + ' weeks'),
        'Try a longer time frame, or All.')
      : emptyOr('No tests or quizzes scheduled', 'They will show up here once Canvas has them.'));
    return;
  }
  const grid = el('div', 'grid'); grid.style.marginTop = '14px';
  for (const t of data) {
    const card = el('div', 'card droppable');
    const row = el('div', 'card-row');
    row.appendChild(el('div', 'card-title', esc(t.name)));
    row.appendChild(el('span', 'pill' + (t.type === 'quiz' ? ' muted' : ''), t.type));
    card.appendChild(row);
    card.appendChild(el('div', 'card-class', esc(t.class_name)));
    card.appendChild(el('div', 'card-due', 'Due ' + esc(fmtDue(t.due_at, t.due_date))));
    card.appendChild(el('div', 'card-class', t.mastery + '% studied · ' + t.card_count + ' cards'));
    if (t.notes_status === 'processing') card.appendChild(el('span', 'pill', 'Reading your notes…'));
    else if (t.notes_status === 'done') card.appendChild(el('span', 'pill', 'Notes added'));
    else if (t.notes_status === 'error') card.appendChild(el('span', 'pill muted', 'Could not read that file'));
    card.onclick = () => { state.view = 'test'; state.testId = t.id; render(); };
    makeDropTarget(card, t.id);
    grid.appendChild(card);
  }
  app.appendChild(grid);

  // While any file is being read, refresh this page every few seconds.
  clearTimeout(testsPollTimer);
  if (data.some((t) => t.notes_status === 'processing')) {
    testsPollTimer = setTimeout(() => { if (state.view === 'tests') render(); }, 3000);
  }
}

function makeDropTarget(card, testId) {
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files || []).slice(0, 3);
    if (!files.length) return;
    for (const f of files) await uploadNotesFile(testId, f);
    render();
  });
}

async function uploadNotesFile(testId, file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  // base64 in chunks (spreading a big file into one call blows the stack)
  let bin = '';
  for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
  const r = await post(`/api/tests/${testId}/notes`, { filename: file.name, content_base64: btoa(bin) });
  if (r && r.ok === false) toast(r.error || 'Could not upload that file.');
}

// Small non-blocking message at the bottom of the screen.
function toast(msg) {
  const t = el('div', 'toast', esc(msg));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// Full page for one test/quiz: the study tool.
async function renderTestPage() {
  const t = await get('/api/tests/' + state.testId);
  if (!t || t.error) { state.view = 'tests'; return render(); }

  const back = el('button', 'btn btn-ghost back-btn', '← Back to Tests & Quizzes');
  back.onclick = () => { state.view = 'tests'; state.testId = null; render(); };
  app.appendChild(back);

  const head = el('div', 'work-head');
  head.appendChild(el('h1', 'view-title', esc(t.name)));
  head.appendChild(el('div', 'view-sub', `${esc(t.class_name)} · ${t.type} · due ${esc(fmtDue(t.due_at, t.due_date))}`));
  app.appendChild(head);

  const body = el('div', 'work-body');

  if (t.study_guide_url) {
    const link = el('a', 'pill', 'Open study guide ↗'); link.href = t.study_guide_url; link.target = '_blank';
    link.style.display = 'inline-block'; link.style.marginBottom = '4px';
    body.appendChild(link);
  }

  // Flashcards | Notes switcher, centered. Swapping only redraws the host area,
  // so the running study timer at the bottom is never disturbed.
  const switchWrap = el('div', 'switch-center');
  const switcher = el('div', 'toggle-group');
  const fcBtn = el('button', 'active', 'Flashcards');
  const notesBtn = el('button', '', 'Notes');
  switcher.appendChild(fcBtn); switcher.appendChild(notesBtn);
  switchWrap.appendChild(switcher);
  body.appendChild(switchWrap);
  const host = el('div'); host.style.marginTop = '14px';
  body.appendChild(host);

  function showFlashcards() {
    fcBtn.classList.add('active'); notesBtn.classList.remove('active');
    runFlashcards(host, t.id, t.due_cards);
  }
  function showNotes() {
    notesBtn.classList.add('active'); fcBtn.classList.remove('active');
    host.innerHTML = '';

    // Notes added from the class page, each with the cards it produced.
    for (const n of (t.class_notes || [])) {
      const card = el('div', 'note-card');
      card.appendChild(el('div', 'note-title', esc(n.title)));
      if (n.status === 'thinking') {
        card.appendChild(el('div', 'note-working', 'Working out what is worth studying…'));
      } else if (n.status === 'error') {
        card.appendChild(el('div', 'note-error', esc(n.error)));
      } else {
        card.appendChild(el('div', 'note-meta', `${n.cards} flashcard${n.cards === 1 ? '' : 's'} from this note`));
      }
      if (n.text) card.appendChild(el('pre', 'notes-view', esc(n.text)));
      if (n.image_url) {
        const link = el('a', 'pill', 'See the original photo ↗');
        link.href = n.image_url; link.target = '_blank';
        link.style.display = 'inline-block'; link.style.marginTop = '8px';
        card.appendChild(link);
      }
      host.appendChild(card);
    }
    if ((t.class_notes || []).some((n) => n.status === 'thinking')) schedulePoll();

    if (t.notes_status === 'processing') {
      host.appendChild(el('div', 'deliverable', 'Still reading your notes file — check back in a minute.'));
    } else if (t.notes) {
      host.appendChild(el('pre', 'notes-view', esc(t.notes)));
    } else if (!(t.class_notes || []).length) {
      host.appendChild(el('div', 'deliverable', 'No notes yet. Add notes on this class\'s page, then use Add to Test — or drag a notes file onto this test\'s card on the Tests page.'));
    }
  }
  fcBtn.onclick = showFlashcards;
  notesBtn.onclick = showNotes;
  showFlashcards();

  app.appendChild(body);

  // Study log at the very bottom: total time studied across every session,
  // counting up toward the goal (2 hours for a test, 30 min for a quiz).
  // Stated as plain numbers — no bar, and no per-day figure.
  const goalSec = (t.time_budget_minutes || 120) * 60;
  const loggedSec = t.time_logged || 0;
  const logWrap = el('div', 'studylog');
  logWrap.appendChild(el('div', 'studylog-title', 'Study log'));
  logWrap.appendChild(el('div', 'day-line',
    `${fmtClock(Math.min(loggedSec, goalSec))} of ${fmtClock(goalSec)} goal${loggedSec >= goalSec ? ' — goal reached' : ''}`));
  const timer = makeTimer(loggedSec, (sec) => post(`/api/tests/${t.id}/time`, { seconds: sec }));
  logWrap.appendChild(timer.node);
  app.appendChild(logWrap);
}

function runFlashcards(host, testId, cards) {
  host.innerHTML = '';
  if (!cards || !cards.length) {
    host.appendChild(el('div', 'deliverable', 'No cards due right now — nice work. Come back later for review.'));
    return;
  }
  let i = 0, showBack = false;
  const face = el('div', 'flashcard');
  const actions = el('div', 'flash-actions');
  const counter = el('div', 'bar-label');
  function draw() {
    if (i >= cards.length) {
      host.innerHTML = '';
      host.appendChild(el('div', 'deliverable', 'Done with the cards due today.'));
      return;
    }
    const c = cards[i];
    face.textContent = showBack ? c.back : c.front;
    counter.textContent = `Card ${i + 1} of ${cards.length}` + (showBack ? '' : ' · tap to flip');
    actions.innerHTML = '';
    if (!showBack) {
      const flip = el('button', 'btn btn-ghost', 'Flip'); flip.onclick = () => { showBack = true; draw(); };
      actions.appendChild(flip);
    } else {
      const miss = el('button', 'btn btn-danger', "Didn't know");
      const know = el('button', 'btn btn-accent', 'Knew it');
      miss.onclick = () => grade(false); know.onclick = () => grade(true);
      actions.appendChild(miss); actions.appendChild(know);
    }
  }
  async function grade(remembered) {
    await post(`/api/flashcards/${cards[i].id}/review`, { remembered });
    i += 1; showBack = false; draw();
  }
  face.onclick = () => { if (!showBack) { showBack = true; draw(); } };
  host.appendChild(face); host.appendChild(counter); host.appendChild(actions);
  draw();
}

// ---- CLASSES -------------------------------------------------------------
// The grade on a class card: the overall percent big, then the two halves the
// school actually grades on underneath. A category with nothing marked yet
// shows a dash rather than 0% — no work graded is not the same as zero.
function gradeBlock(c) {
  const wrap = el('div', 'grade-block');
  const big = el('div', 'grade-big', c.grade_pct == null ? '—' : c.grade_pct + '%');
  wrap.appendChild(big);
  if (c.grade_pct == null) wrap.appendChild(el('div', 'grade-none', 'Nothing graded yet'));

  const cats = c.categories || {};
  if (cats.has_split) {
    const split = el('div', 'grade-split');
    [['formative', 'Formative'], ['summative', 'Summative']].forEach(([key, label]) => {
      const g = cats[key] || {};
      const cell = el('div', 'grade-cell');
      cell.appendChild(el('div', 'grade-cell-label', label));
      cell.appendChild(el('div', 'grade-cell-pct', g.pct == null ? '—' : g.pct + '%'));
      cell.appendChild(el('div', 'grade-cell-sub',
        g.count ? `${g.count} graded` : 'none yet'));
      split.appendChild(cell);
    });
    wrap.appendChild(split);
  } else if (c.grade_pct != null) {
    // No Formative/Summative in this class — say so, rather than leaving a
    // hole under the percent where the other cards have two boxes.
    wrap.appendChild(el('div', 'grade-none', 'This class is not split into formative and summative.'));
  }
  return wrap;
}

async function renderClasses() {
  const [data, g] = await Promise.all([get('/api/classes'), get('/api/gpa')]);
  app.appendChild(el('h1', 'view-title', 'Classes'));
  const grid = el('div', 'grid'); grid.style.marginTop = '14px';
  for (const c of data) {
    const card = el('div', 'card');
    const row = el('div', 'card-row');
    row.appendChild(el('div', 'card-title', esc(c.name)));
    row.appendChild(el('span', 'pill', c.grade_letter));
    card.appendChild(row);
    card.appendChild(gradeBlock(c));
    card.onclick = () => { state.view = 'class'; state.classId = c.id; render(); };
    grid.appendChild(card);
  }
  app.appendChild(grid);

  const box = el('div', 'gpa-box');
  box.appendChild(el('div', 'view-sub', 'Overall GPA'));
  box.appendChild(el('div', 'big-number', g.gpa == null ? '—' : g.gpa.toFixed(2)));
  box.appendChild(el('div', 'view-sub', (g.scale || '4.0') + ' scale · ' + (g.classes || 0) + ' classes'));
  app.appendChild(box);
}

// Full page for one class: Grades and Notes, same shape as the test page.
async function renderClassPage() {
  const c = await get('/api/classes/' + state.classId);
  if (!c || c.error) { state.view = 'classes'; return render(); }

  const back = el('button', 'btn btn-ghost back-btn', '← Back to Classes');
  back.onclick = () => { state.view = 'classes'; state.classId = null; render(); };
  app.appendChild(back);

  const head = el('div', 'work-head');
  head.appendChild(el('h1', 'view-title', esc(c.name)));
  head.appendChild(el('div', 'view-sub',
    `${c.grade_letter}${c.grade_pct != null ? ' · ' + c.grade_pct + '%' : ''} · ${c.total_earned}/${c.total_possible} points`));
  app.appendChild(head);

  const body = el('div', 'work-body');
  const switchWrap = el('div', 'switch-center');
  const switcher = el('div', 'toggle-group');
  const gradesBtn = el('button', '', 'Grades');
  const notesBtn = el('button', '', 'Notes');
  switcher.appendChild(gradesBtn); switcher.appendChild(notesBtn);
  switchWrap.appendChild(switcher);
  body.appendChild(switchWrap);
  const host = el('div'); host.style.marginTop = '14px';
  body.appendChild(host);

  function showGrades() {
    state.classTab = 'grades';
    gradesBtn.classList.add('active'); notesBtn.classList.remove('active');
    host.innerHTML = '';
    host.appendChild(gradeBlock(c));
    if (!c.grades.length) { host.appendChild(el('div', 'deliverable', 'No graded work yet.')); return; }
    const table = el('table', 'gtable');
    table.innerHTML = '<tr><th>Assignment</th><th>Counts as</th><th>Date</th><th style="text-align:right">Score</th></tr>';
    for (const gr of c.grades) {
      const tr = el('tr');
      tr.appendChild(el('td', null, esc(gr.title)));
      const kind = el('td');
      if (gr.category) kind.appendChild(el('span', 'cat-tag cat-' + gr.category, esc(gr.category_label)));
      else if (gr.category_label) kind.appendChild(el('span', 'cat-tag', esc(gr.category_label)));
      tr.appendChild(kind);
      tr.appendChild(el('td', null, fmtDate(gr.due_date)));
      tr.appendChild(el('td', 'num', `${gr.earned}/${gr.possible}` + (gr.pct != null ? ` (${gr.pct}%)` : '')));
      table.appendChild(tr);
    }
    host.appendChild(table);
  }
  function showNotes() {
    state.classTab = 'notes';
    notesBtn.classList.add('active'); gradesBtn.classList.remove('active');
    buildNotesList(host, c);
  }
  gradesBtn.onclick = showGrades;
  notesBtn.onclick = showNotes;
  if (state.classTab === 'notes') showNotes(); else showGrades();

  app.appendChild(body);
}

// ---- class notes ---------------------------------------------------------
function buildNotesList(host, c) {
  host.innerHTML = '';

  const bar = el('div', 'api-actions');
  const addBtn = el('button', 'btn btn-accent', 'Add Notes');
  const picker = el('input');
  picker.type = 'file';
  picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
  picker.className = 'hidden';
  addBtn.onclick = () => picker.click();
  picker.onchange = async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    addBtn.disabled = true; addBtn.textContent = 'Uploading…';
    const r = await uploadClassNote(c.id, file);
    addBtn.disabled = false; addBtn.textContent = 'Add Notes';
    if (r && r.ok === false) { toast(r.error || 'Could not upload that photo.'); return; }
    await render();
  };
  bar.appendChild(addBtn); bar.appendChild(picker);
  host.appendChild(bar);
  host.appendChild(el('div', 'api-note',
    'Take a photo of your handwritten or typed notes and Slate types them up for you.'));

  if (!c.notes.length) {
    host.appendChild(emptyState('No notes yet', 'Add a photo of your notes and it will show up here, typed out.'));
    return;
  }

  const list = el('div', 'note-list');
  for (const n of c.notes) list.appendChild(noteCard(n, c));
  host.appendChild(list);

  // While anything is being read, keep checking — the read happens in the
  // background so the page has to notice when it lands.
  if (c.notes.some((n) => n.status === 'reading' || n.tests.some((t) => t.status === 'thinking'))) {
    schedulePoll();
  }
}

let notePoll = null;
function schedulePoll() {
  if (notePoll) return;
  notePoll = setTimeout(async () => {
    notePoll = null;
    if (state.view === 'class' && state.classTab === 'notes') await render();
    else if (state.view === 'test') await render();
  }, 3000);
}

function noteCard(n, c) {
  const card = el('div', 'note-card' + (n.status === 'error' ? ' has-error' : ''));

  const top = el('div', 'note-top');
  const titleWrap = el('div', 'note-title-wrap');
  titleWrap.appendChild(el('div', 'note-title', esc(n.title)));
  const bits = [];
  if (n.status === 'reading') bits.push('reading the photo…');
  else if (n.word_count) bits.push(n.word_count + ' words');
  for (const t of n.tests) {
    if (t.status === 'thinking') bits.push('thinking about ' + esc(t.test_name) + '…');
    else if (t.status === 'done') bits.push(`on ${esc(t.test_name)} · ${t.cards} card${t.cards === 1 ? '' : 's'}`);
    else bits.push(`${esc(t.test_name)}: cards failed`);
  }
  titleWrap.appendChild(el('div', 'note-meta', bits.join(' · ')));
  top.appendChild(titleWrap);
  top.appendChild(noteMenu(n, c));
  card.appendChild(top);

  if (n.status === 'reading') {
    card.appendChild(el('div', 'note-working', 'Reading your notes… this takes a few seconds.'));
  } else if (n.status === 'error') {
    card.appendChild(el('div', 'note-error', esc(n.error)));
    const typeBtn = el('button', 'btn btn-ghost btn-sm', 'Type it in myself');
    typeBtn.onclick = () => openNoteEditor(n);
    card.appendChild(typeBtn);
  } else if (n.preview) {
    card.appendChild(el('div', 'note-preview', esc(n.preview) + (n.text.length > n.preview.length ? '…' : '')));
  }

  for (const t of n.tests) {
    if (t.status === 'thinking') {
      card.appendChild(el('div', 'note-working', `Working out what is worth studying for ${esc(t.test_name)}…`));
    } else if (t.status === 'error') {
      const box = el('div', 'note-error', esc(t.error));
      const retry = el('button', 'btn btn-ghost btn-sm', 'Try again');
      retry.onclick = async () => { await post(`/api/notes/${n.id}/add-to-test`, { test_id: t.test_id }); await render(); };
      box.appendChild(retry);
      card.appendChild(box);
    }
  }
  return card;
}

// The three-dot menu. One open at a time; clicking anywhere else shuts it.
function noteMenu(n, c) {
  const wrap = el('div', 'menu-wrap');
  const dots = el('button', 'menu-btn', '⋯');
  dots.title = 'More';
  const menu = el('div', 'menu hidden');

  const item = (label, cls, fn) => {
    const b = el('button', 'menu-item' + (cls ? ' ' + cls : ''), esc(label));
    b.onclick = (e) => { e.stopPropagation(); menu.classList.add('hidden'); fn(); };
    return b;
  };
  menu.appendChild(item('Edit Note', null, () => openNoteEditor(n)));
  menu.appendChild(item('Add to Test', null, () => openAddToTest(n, c)));
  menu.appendChild(item('Delete Note', 'danger', () => openDeleteNote(n)));

  dots.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = !menu.classList.contains('hidden');
    document.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
    menu.classList.toggle('hidden', wasOpen);
  };
  wrap.appendChild(dots); wrap.appendChild(menu);
  return wrap;
}

async function uploadClassNote(classId, file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
  return post(`/api/classes/${classId}/notes`, { filename: file.name, content_base64: btoa(bin) });
}

function openNoteEditor(n) {
  panel.innerHTML = '';
  panel.appendChild(panelHeader('Edit note', 'Fix anything Slate got wrong.', false));

  const titleIn = el('input', 'dl-name');
  titleIn.type = 'text'; titleIn.value = n.title === 'Untitled note' ? '' : n.title;
  titleIn.placeholder = 'Title';
  panel.appendChild(el('div', 'section-label', 'Title'));
  panel.appendChild(titleIn);

  panel.appendChild(el('div', 'section-label', 'Notes'));
  const area = el('textarea', 'editor note-editor');
  area.value = n.text || '';
  area.placeholder = 'Type your notes here…';
  panel.appendChild(area);

  if (n.image_url) {
    const link = el('a', 'pill', 'See the original photo ↗');
    link.href = n.image_url; link.target = '_blank';
    link.style.display = 'inline-block'; link.style.marginTop = '8px';
    panel.appendChild(link);
  }

  const msg = el('div', 'api-msg');
  const save = el('button', 'btn btn-accent', 'Save note');
  save.onclick = async () => {
    save.disabled = true; save.textContent = 'Saving…';
    const r = await post(`/api/notes/${n.id}`, { title: titleIn.value, text: area.value });
    save.disabled = false; save.textContent = 'Save note';
    if (r && r.ok === false) { msg.className = 'api-msg bad'; msg.textContent = r.error; return; }
    closePanel();
  };
  const acts = el('div', 'api-actions'); acts.appendChild(save);
  panel.appendChild(acts); panel.appendChild(msg);
  openPanel();
}

async function openAddToTest(n, c) {
  const r = await get(`/api/notes/${n.id}/tests`);
  panel.innerHTML = '';
  panel.appendChild(panelHeader('Add to test', 'Slate reads the note and makes flashcards for it.', false));

  if (!r.tests.length) {
    panel.appendChild(el('div', 'deliverable',
      `There are no tests in ${esc(c ? c.name : 'this class')} yet. Once one shows up from Canvas you can add notes to it.`));
    openPanel();
    return;
  }

  const msg = el('div', 'api-msg');
  const list = el('div', 'note-list');
  for (const t of r.tests) {
    const row = el('button', 'test-pick' + (t.already_added ? ' picked' : ''));
    row.appendChild(el('div', 'note-title', esc(t.name)));
    row.appendChild(el('div', 'note-meta',
      `${t.type} · ${fmtDate(t.due_date)}${t.already_added ? ' · already added' : ''}`));
    row.disabled = !!t.already_added;
    row.onclick = async () => {
      msg.className = 'api-msg'; msg.textContent = '';
      row.disabled = true;
      const res = await post(`/api/notes/${n.id}/add-to-test`, { test_id: t.id });
      if (res && res.ok === false) {
        msg.className = 'api-msg bad'; msg.textContent = res.error;
        row.disabled = false;
        return;
      }
      closePanel();
    };
    list.appendChild(row);
  }
  panel.appendChild(list);
  panel.appendChild(msg);
  openPanel();
}

function openDeleteNote(n) {
  panel.innerHTML = '';
  panel.appendChild(panelHeader(`Delete "${n.title}"?`, null, false));
  panel.appendChild(el('div', 'api-note',
    'The note, its photo, and any flashcards it made all go. This cannot be undone.'));
  const acts = el('div', 'api-actions');
  const del = el('button', 'btn btn-danger', 'Delete note');
  del.onclick = async () => { await post(`/api/notes/${n.id}/delete`); closePanel(); };
  const cancel = el('button', 'btn btn-ghost', 'Cancel');
  cancel.onclick = () => closePanel(false);
  acts.appendChild(del); acts.appendChild(cancel);
  panel.appendChild(acts);
  openPanel();
}

// ---- EMAIL ---------------------------------------------------------------
async function renderEmail() {
  const data = await get('/api/emails');
  app.appendChild(el('h1', 'view-title', 'Email'));
  app.appendChild(el('div', 'view-sub', 'Canvas notifications, cleaned up.'));
  if (!data.length) { app.appendChild(emptyOr('No messages', 'Canvas notifications will appear here.')); return; }
  const wrap = el('div'); wrap.style.marginTop = '14px';
  for (const e of data) {
    const item = el('div', 'email-item clickable');
    item.appendChild(el('div', 'email-subject', esc(e.subject)));
    item.appendChild(el('div', 'email-meta', esc(e.from_name) + ' · ' + esc(e.received_label)));
    item.appendChild(el('div', 'email-body', esc(e.body)));
    item.onclick = () => openEmail(e.id);
    wrap.appendChild(item);
  }
  app.appendChild(wrap);
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// The whole message and anything attached to it. Canvas only hands the full
// text over per-message, so this is fetched when it's opened.
async function openEmail(id) {
  panel.innerHTML = '';
  panel.appendChild(panelHeader('Loading…', null, false));
  openPanel();

  const e = await get('/api/emails/' + id);
  panel.innerHTML = '';
  if (!e || e.error) {
    panel.appendChild(panelHeader('Message', null, false));
    panel.appendChild(el('div', 'deliverable', 'That message could not be opened.'));
    return;
  }

  panel.appendChild(panelHeader(e.subject || '(no subject)', `${e.from_name} · ${e.received_label}`, false));
  panel.appendChild(el('pre', 'email-full', esc(e.body || '(this message has no text)')));

  if (e.attachments && e.attachments.length) {
    panel.appendChild(el('div', 'section-label',
      `${e.attachments.length} attachment${e.attachments.length === 1 ? '' : 's'}`));
    const list = el('div', 'attach-list');
    for (const a of e.attachments) {
      const row = a.url ? el('a', 'attach') : el('div', 'attach');
      if (a.url) { row.href = a.url; row.target = '_blank'; row.rel = 'noopener'; }
      row.appendChild(el('div', 'attach-name', esc(a.name)));
      const meta = [fmtBytes(a.size), a.url ? 'opens in your browser' : 'no link'].filter(Boolean);
      row.appendChild(el('div', 'attach-meta', esc(meta.join(' · '))));
      list.appendChild(row);
    }
    panel.appendChild(list);
  } else if (!e.full_text_loaded) {
    panel.appendChild(el('div', 'api-note',
      'Slate could not reach Canvas for the rest of this message, so this is the preview it saved earlier.'));
  }
}

// ---- API page ------------------------------------------------------------
// Where Will connects Slate to his school's Canvas. The token is checked
// against Canvas before it's saved, so a typo says so instead of quietly
// leaving him on sample data.
async function renderApi() {
  const s = await get('/api/canvas');
  app.appendChild(el('h1', 'view-title', 'API'));
  app.appendChild(el('div', 'view-sub', "Connect Slate to your school's Canvas."));

  const box = el('div', 'api-box');
  app.appendChild(box);

  if (s.connected) {
    const head = el('div', 'api-status');
    head.appendChild(el('span', 'api-dot on'));
    head.appendChild(el('div', null,
      '<strong>Connected' + (s.account_name ? ' as ' + esc(s.account_name) : '') + '</strong>'
      + '<div class="api-meta">' + esc(s.base_url) + ' · token ending ' + esc(s.token_hint) + '</div>'));
    box.appendChild(head);

    const row = el('div', 'api-actions');
    const syncBtn = el('button', 'btn btn-accent', 'Sync now');
    syncBtn.onclick = async () => {
      syncBtn.disabled = true; syncBtn.textContent = 'Syncing…';
      await post('/api/sync');
      await refreshStatus(); await render();
    };
    const offBtn = el('button', 'btn btn-danger', 'Disconnect');
    offBtn.onclick = async () => {
      offBtn.disabled = true;
      await post('/api/canvas/disconnect');
      await refreshStatus(); await render();
    };
    row.appendChild(syncBtn); row.appendChild(offBtn);
    box.appendChild(row);
    box.appendChild(el('div', 'api-note',
      'Disconnecting puts Slate back where it started. Your work stays where it is.'));
    // The AI-checker settings belong on this page whether Canvas is hooked up
    // or not — they used to sit below this early return, so once Canvas was
    // connected the box disappeared.
    app.appendChild(aiCheckSettings(s));
    return;
  }

  const head = el('div', 'api-status');
  head.appendChild(el('span', 'api-dot'));
  head.appendChild(el('div', null,
    '<strong>Not connected</strong><div class="api-meta">Slate is showing sample data.</div>'));
  box.appendChild(head);

  const urlIn = el('input', 'dl-name');
  urlIn.type = 'text';
  urlIn.placeholder = 'https://yourschool.instructure.com';
  urlIn.value = s.base_url || '';
  const keyIn = el('input', 'dl-name');
  keyIn.type = 'password';
  keyIn.placeholder = 'Paste your Canvas access token';

  box.appendChild(el('label', 'api-label', "Your school's Canvas address"));
  box.appendChild(urlIn);
  box.appendChild(el('label', 'api-label', 'Access token'));
  box.appendChild(keyIn);

  const msg = el('div', 'api-msg');
  const connect = el('button', 'btn btn-accent', 'Connect');
  connect.onclick = async () => {
    msg.className = 'api-msg';
    connect.disabled = true; connect.textContent = 'Checking…';
    const r = await post('/api/canvas', { base_url: urlIn.value, token: keyIn.value });
    connect.disabled = false; connect.textContent = 'Connect';
    if (!r.ok) {
      msg.className = 'api-msg bad';
      msg.textContent = r.error || "That didn't work.";
      return;
    }
    if (r.error) { msg.className = 'api-msg bad'; msg.textContent = r.error; }
    await refreshStatus();
    await render();
  };
  const actions = el('div', 'api-actions');
  actions.appendChild(connect);
  box.appendChild(actions);
  box.appendChild(msg);

  const help = el('div', 'api-help');
  help.appendChild(el('div', 'api-help-title', 'Where to find your token'));
  const steps = el('ol', 'api-steps');
  for (const line of [
    'Open Canvas in your browser and sign in.',
    'Click Account, then Settings.',
    'Scroll to Approved Integrations and click "+ New Access Token".',
    'Give it a name like "Slate", leave the expiry blank, and click Generate.',
    'Copy the token it shows you and paste it above. Canvas only shows it once.',
  ]) steps.appendChild(el('li', null, esc(line)));
  help.appendChild(steps);
  help.appendChild(el('div', 'api-note',
    'The token stays on this computer. Slate reads from Canvas, and only sends work to it when you press the button on the hand-in preview.'));
  box.appendChild(help);
  app.appendChild(aiCheckSettings(s));
}

// Optional: a GPTZero key. Off unless there's a key here.
function aiCheckSettings(s) {
  const wrap = el('div', 'api-box');
  wrap.appendChild(el('div', 'api-help-title', 'AI checker (optional)'));
  wrap.appendChild(el('div', 'api-note',
    'With a GPTZero key saved, the hand-in screen shows how likely a detector thinks your writing is AI — on work you wrote yourself, so a high score means the detector is wrong. It never changes whether you can hand something in.'));
  wrap.appendChild(el('div', 'api-note',
    'Turning this on means your writing gets sent to GPTZero when you open the hand-in screen. Leave the box empty to keep it off.'));

  const keyIn = el('input', 'dl-name');
  keyIn.type = 'password';
  keyIn.placeholder = s.ai_check && s.ai_check.hint ? 'Saved, ending ' + s.ai_check.hint : 'Paste your GPTZero API key';
  wrap.appendChild(el('label', 'api-label', 'GPTZero API key'));
  wrap.appendChild(keyIn);

  const msg = el('div', 'api-msg');
  const save = el('button', 'btn btn-ghost', 'Save key');
  save.onclick = async () => {
    save.disabled = true;
    const r = await post('/api/ai-check-key', { key: keyIn.value });
    save.disabled = false;
    msg.className = 'api-msg';
    msg.textContent = r.enabled ? 'Saved — the checker is on.' : 'Cleared — the checker is off.';
    keyIn.value = '';
  };
  const acts = el('div', 'api-actions'); acts.appendChild(save);
  wrap.appendChild(acts); wrap.appendChild(msg);
  if (s.ai_check && s.ai_check.enabled) {
    wrap.appendChild(el('div', 'api-note', 'Currently on. Clear the box and save to switch it off.'));
  }
  return wrap;
}

// ---- Admin page ----------------------------------------------------------
function fmtSeen(iso) {
  if (!iso) return 'never signed in';
  const then = new Date(iso), mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 2) return 'active now';
  if (mins < 60) return `last seen ${mins} min ago`;
  if (mins < 60 * 24) return `last seen ${Math.round(mins / 60)}h ago`;
  return 'last seen ' + then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function renderAdmin() {
  const data = await get('/api/admin/users');
  app.appendChild(el('h1', 'view-title', 'Admin'));
  app.appendChild(el('div', 'view-sub', 'Who can use Slate.'));

  if (!data.login_required) {
    const why = data.users.length < 2
      ? 'Sign-in is off because you are the only account. Add someone and it turns on.'
      : 'Sign-in is off until you set a password on your own account — otherwise adding people would lock you out.';
    app.appendChild(el('div', 'admin-banner', esc(why)));
  }

  const bar = el('div', 'api-actions');
  const addBtn = el('button', 'btn btn-accent', 'Add user');
  addBtn.onclick = () => openAddUserPopup();
  bar.appendChild(addBtn);
  app.appendChild(bar);

  const list = el('div', 'admin-list');
  for (const u of data.users) list.appendChild(userRow(u));
  app.appendChild(list);
}

function userRow(u) {
  const row = el('div', 'admin-user' + (u.is_frozen ? ' frozen' : ''));

  const head = el('div', 'admin-user-head');
  const who = el('div', null);
  const badges = [
    u.is_owner ? '<span class="badge">You</span>' : '',
    u.is_admin ? '<span class="badge admin">Admin</span>' : '',
    u.is_frozen ? '<span class="badge frozen">Frozen</span>' : '',
    !u.has_password ? '<span class="badge warn">No password</span>' : '',
  ].join('');
  who.appendChild(el('div', 'admin-name', esc(u.name) + ' ' + badges));
  who.appendChild(el('div', 'admin-meta',
    `${u.devices} device${u.devices === 1 ? '' : 's'} signed in · ${esc(fmtSeen(u.last_seen))}`));
  head.appendChild(who);
  row.appendChild(head);

  const acts = el('div', 'admin-acts');
  const refresh = async (r) => {
    if (r && r.ok === false) { window.alert(r.error); return; }
    await render();
  };

  if (u.devices > 0) {
    const seeBtn = el('button', 'btn btn-ghost btn-sm', 'Devices');
    seeBtn.onclick = () => openDevicesPopup(u);
    acts.appendChild(seeBtn);
    const kickBtn = el('button', 'btn btn-ghost btn-sm', 'Sign out all');
    kickBtn.onclick = async () => refresh(await post(`/api/admin/users/${u.id}/signout`));
    acts.appendChild(kickBtn);
  }

  // Renaming matters more than it looks: the heading on every document handed
  // in comes from the account name, so this is where "Will" becomes
  // "Will Caldwell".
  const nameBtn = el('button', 'btn btn-ghost btn-sm', 'Edit name');
  nameBtn.onclick = () => openRenamePopup(u);
  acts.appendChild(nameBtn);

  const pwBtn = el('button', 'btn btn-ghost btn-sm', u.has_password ? 'Change password' : 'Set password');
  pwBtn.onclick = () => openPasswordPopup(u);
  acts.appendChild(pwBtn);

  if (!u.is_owner) {
    const adminBtn = el('button', 'btn btn-ghost btn-sm', u.is_admin ? 'Remove admin' : 'Make admin');
    adminBtn.onclick = async () => refresh(await post(`/api/admin/users/${u.id}/admin`, { admin: !u.is_admin }));
    acts.appendChild(adminBtn);

    const freezeBtn = el('button', 'btn btn-ghost btn-sm', u.is_frozen ? 'Unfreeze' : 'Freeze');
    freezeBtn.onclick = async () => refresh(await post(`/api/admin/users/${u.id}/freeze`, { frozen: !u.is_frozen }));
    acts.appendChild(freezeBtn);

    const delBtn = el('button', 'btn btn-danger btn-sm', 'Delete');
    delBtn.onclick = () => openDeletePopup(u);
    acts.appendChild(delBtn);
  }
  row.appendChild(acts);
  return row;
}

function openAddUserPopup() {
  panel.innerHTML = '';
  panel.appendChild(panelHeader('Add user', 'They will be able to sign in with this name and password.', false));

  const nameIn = el('input', 'dl-name'); nameIn.type = 'text'; nameIn.placeholder = 'Name';
  const pwIn = el('input', 'dl-name'); pwIn.type = 'password'; pwIn.placeholder = 'Password';
  panel.appendChild(el('div', 'section-label', 'Name'));
  panel.appendChild(nameIn);
  panel.appendChild(el('div', 'section-label', 'Password'));
  panel.appendChild(pwIn);

  const adminWrap = el('label', 'pic-toggle');
  const adminBox = el('input'); adminBox.type = 'checkbox';
  adminWrap.appendChild(adminBox);
  adminWrap.appendChild(el('span', null, 'Make them an admin'));
  panel.appendChild(adminWrap);

  const msg = el('div', 'api-msg');
  const save = el('button', 'btn btn-accent', 'Add user');
  save.onclick = async () => {
    msg.className = 'api-msg';
    save.disabled = true;
    const r = await post('/api/admin/users', { name: nameIn.value, password: pwIn.value, is_admin: adminBox.checked });
    save.disabled = false;
    if (!r.ok) { msg.className = 'api-msg bad'; msg.textContent = r.error; return; }
    closePanel();
  };
  const acts = el('div', 'api-actions'); acts.appendChild(save);
  panel.appendChild(acts);
  panel.appendChild(msg);
  openPanel();
}

function openRenamePopup(u) {
  panel.innerHTML = '';
  panel.appendChild(panelHeader(`Rename ${u.name}`,
    'This is the name that goes at the top of anything handed in.', false));
  const nameIn = el('input', 'dl-name');
  nameIn.type = 'text'; nameIn.value = u.name; nameIn.placeholder = 'Full name';
  panel.appendChild(nameIn);
  const msg = el('div', 'api-msg');
  const save = el('button', 'btn btn-accent', 'Save name');
  save.onclick = async () => {
    msg.className = 'api-msg';
    const r = await post(`/api/admin/users/${u.id}/rename`, { name: nameIn.value });
    if (!r.ok) { msg.className = 'api-msg bad'; msg.textContent = r.error; return; }
    closePanel();
  };
  const acts = el('div', 'api-actions'); acts.appendChild(save);
  panel.appendChild(acts); panel.appendChild(msg);
  openPanel();
}

function openPasswordPopup(u) {
  panel.innerHTML = '';
  panel.appendChild(panelHeader(`Password for ${u.name}`, null, false));
  const pwIn = el('input', 'dl-name'); pwIn.type = 'password'; pwIn.placeholder = 'New password';
  panel.appendChild(pwIn);
  const msg = el('div', 'api-msg');
  const save = el('button', 'btn btn-accent', 'Save password');
  save.onclick = async () => {
    msg.className = 'api-msg';
    const r = await post(`/api/admin/users/${u.id}/password`, { password: pwIn.value });
    if (!r.ok) { msg.className = 'api-msg bad'; msg.textContent = r.error; return; }
    closePanel();
  };
  const acts = el('div', 'api-actions'); acts.appendChild(save);
  panel.appendChild(acts);
  panel.appendChild(msg);
  openPanel();
}

async function openDevicesPopup(u) {
  const r = await get(`/api/admin/users/${u.id}/devices`);
  panel.innerHTML = '';
  panel.appendChild(panelHeader(`${u.name}'s devices`, 'Everywhere this account is signed in.', false));
  const wrap = el('div', 'device-list');
  for (const d of r.devices) {
    const item = el('div', 'device-item');
    item.appendChild(el('div', 'device-name', esc(d.device || 'Unknown device')));
    item.appendChild(el('div', 'admin-meta',
      esc(fmtSeen(d.last_seen)) + (d.ip ? ' · ' + esc(d.ip) : '')));
    wrap.appendChild(item);
  }
  if (!r.devices.length) wrap.appendChild(el('div', 'admin-meta', 'Not signed in anywhere right now.'));
  panel.appendChild(wrap);
  openPanel();
}

function openDeletePopup(u) {
  panel.innerHTML = '';
  panel.appendChild(panelHeader(`Delete ${u.name}?`, null, false));
  panel.appendChild(el('div', 'api-note',
    'This removes the account and signs out every device. Freezing keeps the account and their work; deleting does not.'));
  const acts = el('div', 'api-actions');
  const del = el('button', 'btn btn-danger', 'Delete ' + esc(u.name));
  del.onclick = async () => { await post(`/api/admin/users/${u.id}/delete`); closePanel(); };
  const cancel = el('button', 'btn btn-ghost', 'Cancel');
  cancel.onclick = () => closePanel(false);
  acts.appendChild(del); acts.appendChild(cancel);
  panel.appendChild(acts);
  openPanel();
}

// ---- sign in -------------------------------------------------------------
async function renderLogin() {
  document.body.classList.add('signed-out');
  app.innerHTML = '';
  const box = el('div', 'login-box');
  box.appendChild(el('div', 'login-mark', '&#9679;'));
  box.appendChild(el('h1', 'login-title', 'Slate'));
  box.appendChild(el('div', 'view-sub', 'Sign in to see your work.'));

  const nameIn = el('input', 'dl-name'); nameIn.type = 'text'; nameIn.placeholder = 'Name';
  const pwIn = el('input', 'dl-name'); pwIn.type = 'password'; pwIn.placeholder = 'Password';
  box.appendChild(nameIn); box.appendChild(pwIn);

  const msg = el('div', 'api-msg');
  const go = el('button', 'btn btn-accent', 'Sign in');
  go.onclick = async () => {
    msg.className = 'api-msg';
    go.disabled = true; go.textContent = 'Checking…';
    const r = await post('/api/login', { name: nameIn.value, password: pwIn.value });
    go.disabled = false; go.textContent = 'Sign in';
    if (!r.ok) { msg.className = 'api-msg bad'; msg.textContent = r.error || "That didn't work."; return; }
    document.body.classList.remove('signed-out');
    await boot();
  };
  pwIn.onkeydown = (e) => { if (e.key === 'Enter') go.onclick(); };
  const acts = el('div', 'api-actions'); acts.appendChild(go);
  box.appendChild(acts); box.appendChild(msg);
  app.appendChild(box);
}

// ---- shared --------------------------------------------------------------
// No icon: the app is deliberately emoji-free.
function emptyState(title, sub) {
  const e = el('div', 'empty');
  e.appendChild(el('div', null, '<strong>' + esc(title) + '</strong>'));
  e.appendChild(el('div', null, esc(sub)));
  return e;
}

// ---- router --------------------------------------------------------------
const VIEWS = {
  today: renderToday, work: renderWork, week: renderWeek,
  projects: renderProjects, project: renderProjectPage,
  tests: renderTests, test: renderTestPage,
  classes: renderClasses, class: renderClassPage, email: renderEmail,
  api: renderApi, admin: renderAdmin,
};
// Detail pages highlight their parent tab in the sidebar.
const TAB_FOR = { work: 'today', project: 'projects', test: 'tests', class: 'classes' };
let rendering = false, pending = false;
async function render() {
  // Serialize renders so overlapping calls can't blank the view.
  if (rendering) { pending = true; return; }
  rendering = true;
  try {
    do {
      pending = false;
      // Leaving a page with an editor: save anything typed but not yet autosaved
      // BEFORE the DOM goes away, or the next fetch would read a stale draft.
      if (pageDraft) { const d = pageDraft; pageDraft = null; try { await d.flush(); } catch { /* keep going */ } }
      // Leaving the work page: stop the focus timer and bank its time.
      if (pageTimer) { pageTimer.dispose(); pageTimer = null; }
      // …and drop any question still waiting on Claude. The reserved lane goes
      // with it: only an assignment page has a chat, so any other view would
      // otherwise render with a gap down its right-hand side.
      if (pageChat) { try { pageChat.abort(); } catch { /* already done */ } pageChat = null; }
      setChatLane(false);
      app.innerHTML = '';
      const tabView = TAB_FOR[state.view] || state.view;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === tabView));
      try { await VIEWS[state.view](); } catch (err) { console.error('render error:', err); }
    } while (pending);
  } finally {
    rendering = false;
  }
}
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    state.view = tab.dataset.view;
    state.workId = null; state.projectId = null; state.testId = null; state.classId = null;
    state.classTab = 'grades';
    render();
  };
});

// ---- sync + status -------------------------------------------------------
async function refreshStatus() {
  const s = await get('/api/status');
  const last = s.last_sync ? new Date(s.last_sync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  notConnected = s.canvas_mode === 'none';
  const source = s.canvas_mode === 'mock' ? 'Sample data' : notConnected ? 'Canvas not connected' : 'Canvas';
  $('#sync-status').textContent = s.canvas_mode === 'none' ? source : `${source} · synced ${last}`;
  // The installed app can be quit properly and shows which build it is. The
  // dev copy shows neither — nothing should be able to shut that one down.
  $('#quit-btn').classList.toggle('hidden', !s.installed);
  const tag = $('#build-tag');
  tag.textContent = s.build ? `build ${s.build}` : '';
  tag.classList.toggle('hidden', !(s.installed && s.build));
}

// Shuts the server down for real, then closes the window. An app-mode window
// can close itself; a normal tab can't, so we leave a note behind instead.
async function quitSlate() {
  const btn = $('#quit-btn');
  btn.disabled = true; btn.textContent = 'Closing…';
  if (pageDraft) { try { await pageDraft.flush(); } catch { /* still quitting */ } }
  try { await post('/api/quit'); } catch { /* the server going away is the point */ }
  document.body.innerHTML = '<div class="quit-screen"><p>Slate is closed.</p>'
    + '<p class="muted">You can close this window.</p></div>';
  setTimeout(() => { try { window.close(); } catch { /* blocked in a normal tab */ } }, 250);
}
$('#sync-btn').onclick = async () => {
  const btn = $('#sync-btn'); btn.disabled = true; btn.textContent = 'Syncing…';
  await post('/api/sync');
  await refreshStatus(); await render();
  btn.disabled = false; btn.textContent = 'Sync now';
};
$('#quit-btn').onclick = quitSlate;

// ---- the day rolling over ------------------------------------------------
// Slate stays open in the background now, so a window left up overnight would
// otherwise still be showing yesterday. Nothing runs AT midnight — this just
// notices the local date has changed and redraws, which is enough because
// "today" is worked out fresh on the server for every request.
let currentDay = localDay();
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
setInterval(() => {
  const day = localDay();
  if (day === currentDay) return;
  currentDay = day;
  // Bank a running study timer first, so the seconds already worked land on
  // the day they were worked, not tomorrow.
  if (pageTimer) pageTimer.dispose();
  pageTimer = null;
  render();
}, 30000);

// ---- boot ----------------------------------------------------------------
// Slate is single-user until accounts exist. /api/me says whether anyone has to
// sign in; while nobody does, this is the same straight-to-Today app as before.
let session = null;
async function boot() {
  const me = await get('/api/me');
  session = me.user;
  if (me.login_required && !session) return renderLogin();
  document.body.classList.remove('signed-out');

  // The Admin tab is only any use to admins.
  $('#tab-admin').classList.toggle('hidden', !(session && session.is_admin));
  if (state.view === 'admin' && !(session && session.is_admin)) state.view = 'today';

  const who = $('#who');
  if (me.login_required && session) {
    who.innerHTML = 'Signed in as ' + esc(session.name) + ' · <a href="#" id="signout">Sign out</a>';
    who.classList.remove('hidden');
    $('#signout').onclick = async (e) => {
      e.preventDefault();
      await post('/api/logout');
      state.view = 'today';
      await boot();
    };
  } else {
    who.classList.add('hidden');
  }

  await refreshStatus();
  await render();
}
boot();
