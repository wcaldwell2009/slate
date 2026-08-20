'use strict';

// Business/query layer. Pure functions returning plain objects the UI renders.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDb, getSetting, setSetting } = require('./db');
const { review: reviewCard, isDue, INTERVALS } = require('./flashcards');
const { ymd, todayYmd, daysBetweenYmd } = require('./dates');
const { stripHtml } = require('./llm');

function today() {
  return todayYmd();
}
function parseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---- status --------------------------------------------------------------
function status() {
  const { canvasMode } = require('./canvas/canvasClient');
  return {
    last_sync: getSetting('last_sync'),
    // 'none' until Canvas is connected — Slate sits empty rather than
    // pretending, so the sidebar has to be able to say so.
    canvas_mode: canvasMode(),
    has_claude: !!process.env.ANTHROPIC_API_KEY,
    today: today(),
    // The installed copy shows a Quit button and its build number; the
    // workshop copy on :4173 shows neither (nothing should be able to shut
    // down the dev server by accident — the drive harness clicks every button).
    installed: process.env.SLATE_INSTALLED === '1',
    build: buildNumber(),
  };
}

// dist/build.js stamps build.json into the snapshot. Absent in the workshop.
let buildStamp;
function buildNumber() {
  if (buildStamp === undefined) {
    try {
      buildStamp = Number(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'build.json'), 'utf8')).build) || null;
    } catch {
      buildStamp = null;
    }
  }
  return buildStamp;
}

// ---- assignments ---------------------------------------------------------
function assignmentCard(row) {
  const { isEarlyMorning, timeLabel } = require('./dates');
  const early = isEarlyMorning(row.due_at);
  return {
    id: row.id,
    title: row.title,
    class_name: row.class_name,
    points: row.points,
    due_date: row.due_date,          // the day it has to be DONE on
    due_at: row.due_at || null,      // the real Canvas deadline
    // Set when the deadline is the next morning, so the page can say
    // "hand in 8:00 AM tomorrow" instead of looking like it has the wrong day.
    due_morning_of: early ? timeLabel(row.due_at) : '',
    type: row.type,
    status: row.status,
    time_logged: row.time_logged,
    impact: Math.round((row.points || 0) * (row.weight || 1) * 10) / 10,
  };
}

// A quiet day should still be a working day. When today has two things or
// fewer on it, Slate pulls the next few assignments forward so there's
// something to get ahead on — at most this many.
const LOOKAHEAD_MAX = 3;
const LOOKAHEAD_WHEN_AT_MOST = 2;

// Every list of schoolwork is a list of work for classes Will is actually IN.
// A class that stops coming back from Canvas is archived by sync (dropped, or a
// schedule change) and everything hanging off it goes quiet with it. Any new
// query that joins classes needs this too, or old work reappears.
const LIVE_CLASS = 'c.archived = 0';

// How much today HELD: everything due today whatever its status, plus anything
// carried over from an earlier day. Carried-over work still counts once it's
// been done, or the number would shrink as you worked through the day and a
// busy day would start pulling extra work forward halfway through.
function scheduledForToday(db, t) {
  return db
    .prepare(
      `SELECT COUNT(*) n FROM assignments a JOIN classes c ON c.id = a.class_id
       WHERE ${LIVE_CLASS} AND a.type='regular' AND a.due_date IS NOT NULL AND a.due_date <= ?
         AND (a.due_date = ? OR a.status='todo' OR a.completed_day = ?)`
    )
    .get(t, t, t).n;
}

function todayAssignments(sort = 'due') {
  const db = getDb();
  const { assignmentMinutes } = require('./effort');
  const t = today();
  // Due today OR still not done from an earlier day. Work that was never
  // handed in and never ticked off doesn't disappear at midnight — it rolls
  // over and keeps showing up until it's actually dealt with.
  const rows = db
    .prepare(
      `SELECT a.*, c.name AS class_name, c.weight
       FROM assignments a JOIN classes c ON c.id = a.class_id
       WHERE ${LIVE_CLASS} AND a.type='regular' AND a.status='todo'
         AND a.due_date IS NOT NULL AND a.due_date <= ?
       ORDER BY a.due_date`
    )
    .all(t);
  const cards = rows.map((r) => ({
    ...assignmentCard(r),
    minutes: assignmentMinutes(r),
    upcoming: false,
    // Carried over from a day that has already been and gone.
    overdue: (r.due_date || '') < t,
    days_late: (r.due_date || '') < t ? daysBetweenYmd(r.due_date, t) : 0,
  }));

  // Whether to pull work forward is decided by how much the day HELD, not by
  // how much is left. A day with three things on it was a full day — finishing
  // them means you're done, not that you've earned more work. Carried-over
  // work counts too: it is work for today whatever day it was set.
  const scheduled = scheduledForToday(db, t);

  if (scheduled <= LOOKAHEAD_WHEN_AT_MOST) {
    const ahead = db
      .prepare(
        `SELECT a.*, c.name AS class_name, c.weight
         FROM assignments a JOIN classes c ON c.id = a.class_id
         WHERE ${LIVE_CLASS} AND a.type='regular' AND a.status='todo' AND a.due_date > ?
         ORDER BY a.due_date LIMIT ?`
      )
      .all(t, LOOKAHEAD_MAX);
    for (const r of ahead) {
      cards.push({ ...assignmentCard(r), minutes: assignmentMinutes(r), upcoming: true });
    }
  }

  // Overdue first, then today's, then anything pulled forward — whatever the
  // sort. What is late is the most urgent thing on the page.
  const rank = (c) => (c.upcoming ? 2 : c.overdue ? 0 : 1);
  if (sort === 'impact') cards.sort((a, b) => rank(a) - rank(b) || b.impact - a.impact);
  else cards.sort((a, b) => rank(a) - rank(b) || (a.due_date || '').localeCompare(b.due_date || ''));
  return cards;
}

// Everything ticked off today, whatever day it was due — finish a piece of
// work you pulled forward and it still belongs in today's Finished list.
// Work Canvas imported as already-graded has no completed_day, so it never
// shows up here.
function finishedToday() {
  const db = getDb();
  const { assignmentMinutes } = require('./effort');
  const t = today();
  const rows = db
    .prepare(
      `SELECT a.*, c.name AS class_name, c.weight
       FROM assignments a JOIN classes c ON c.id = a.class_id
       WHERE ${LIVE_CLASS} AND a.type='regular' AND a.status='done' AND a.completed_day = ?
       ORDER BY a.completed_at DESC`
    )
    .all(t);
  return rows.map((r) => ({
    ...assignmentCard(r), minutes: assignmentMinutes(r), upcoming: false, done: true,
    completed_at: r.completed_at || null,
  }));
}

// The day's plan: everything unfinished that's due today, and — if that comes to
// less than the 2-hour target — enough project work to fill the rest of the time.
// Chunks already scheduled for today come first, then the next ones up (working
// ahead). Finish an assignment and the freed-up time pulls in more project work.
function todayPlan(sort = 'due') {
  const db = getDb();
  const { DAILY_TARGET_MINUTES } = require('./effort');
  const assignments = todayAssignments(sort);
  const assignmentMins = assignments.reduce((s, a) => s + a.minutes, 0);
  // Work pulled forward from later in the week, shown when today is quiet.
  const upcoming = assignments.filter((a) => a.upcoming);
  const dueTodayMins = assignments.filter((a) => !a.upcoming).reduce((s, a) => s + a.minutes, 0);
  const target = DAILY_TARGET_MINUTES;

  const t = today();
  // Projects are shown AS PROJECTS. There is no daily plan for them any more —
  // no chunks, no pieces, no "part 2 of 3". The tab is simply what you have on,
  // soonest deadline first, and you decide what to do with it.
  const picked = db
    .prepare(
      `SELECT a.id AS project_id, a.title, a.points, a.due_date, a.due_at, a.build_mode,
              c.name AS class_name
       FROM assignments a JOIN classes c ON c.id = a.class_id
       WHERE ${LIVE_CLASS} AND a.type='project' AND a.status='todo'
       ORDER BY a.due_date LIMIT 8`
    )
    .all()
    .map((r) => ({ ...r, id: r.project_id }));

  // Projects finished today, so the Finished side of the tab has something.
  const doneChunks = db
    .prepare(
      `SELECT a.id AS project_id, a.title, a.points, a.due_date, a.due_at, a.build_mode,
              c.name AS class_name
       FROM assignments a JOIN classes c ON c.id = a.class_id
       WHERE ${LIVE_CLASS} AND a.type='project' AND a.status='done' AND a.completed_day = ?
       ORDER BY a.due_date`
    )
    .all(t)
    .map((r) => ({ ...r, id: r.project_id, done: true }));

  // Project work is no longer scheduled into the day, so it adds no minutes.
  const projectMins = 0;
  const finished = finishedToday();
  return {
    date: t,
    target_minutes: target,
    assignments,
    // Ticked off today. The lists above are what's still to do.
    finished,
    finished_count: finished.length,
    finished_projects: doneChunks,
    assignment_minutes: assignmentMins,
    // How much of the above is actually due today vs pulled forward.
    due_today_count: assignments.length - upcoming.length,
    overdue_count: assignments.filter((a) => a.overdue).length,
    // How many were on today's list to begin with, finished or not. This is
    // what decides whether work gets pulled forward, and it lets the page tell
    // "you had a day and cleared it" apart from "today was always empty".
    scheduled_today_count: scheduledForToday(db, t),
    due_today_minutes: dueTodayMins,
    upcoming_count: upcoming.length,
    projects: picked,
    project_minutes: projectMins,
    total_minutes: assignmentMins + projectMins,
    // true when today's OWN work already fills (or overfills) the target —
    // work pulled forward doesn't count, or a quiet day would look full.
    full_on_assignments: dueTodayMins >= target,
    // Time actually put in today, which starts again from zero each morning.
    worked_seconds: secondsWorkedOn(t),
  };
}

function assignmentDetail(id) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.*, c.name AS class_name, c.weight
       FROM assignments a JOIN classes c ON c.id = a.class_id WHERE a.id = ?`
    )
    .get(id);
  if (!row) return null;
  let steps = parseJson(row.steps, []);
  // Guide-mode pages always need a step-by-step list: if the description had no
  // bullet list, break it into sentence steps. File links come out first — the
  // attachment has its own button, and its filename is not a step.
  const plainDescription = require('./attachments').stripFileLinks(row.raw_description || '');
  if (row.work_mode === 'guide' && !steps.length) {
    steps = stripHtml(plainDescription)
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/^•\s*/, '').trim())
      .filter((s) => s.length > 4);
  }
  return {
    ...assignmentCard(row),
    description: row.description,
    steps,
    files: fileList(row),
    files_state: row.attachment_state || 'none',
    work_mode: row.work_mode || 'guide',
    draft_text: row.draft_text || '',
    draft_html: draftHtmlFor(row),
    doc_style: docStyle(row),
    instructions_ai: row.instructions_simple || null,
    instructions_plain: require('./simplify').ruleBased(plainDescription),
  };
}

// ---- attached Canvas files -----------------------------------------------
// What the page shows for each attachment: the name, its type, whether Slate
// can read the inside of it, and whether it's already on disk.
function fileList(row) {
  const att = require('./attachments');
  const files = parseJson(row.files, []);
  return files.map((f, i) => ({
    index: i,
    name: f.name,
    kind: att.extOf(f.name).replace('.', '') || 'file',
    readable: att.isReadable(f.name),
    downloaded: fs.existsSync(att.localPathFor(f)),
  }));
}

// Downloads the file if it isn't here yet and hands it to whatever program the
// machine already uses for that type. Slate has no viewer of its own on
// purpose — Word shows a .docx better than anything that could be built here.
async function openAssignmentFile(id, index) {
  const db = getDb();
  const row = db.prepare('SELECT id, files FROM assignments WHERE id=?').get(Number(id));
  if (!row) return { ok: false, error: 'That assignment is gone.' };
  const files = parseJson(row.files, []);
  const file = files[Number(index)];
  if (!file) return { ok: false, error: 'That file is not on this assignment.' };
  const att = require('./attachments');
  try {
    const filePath = await att.ensureDownloaded(file);
    att.openOnComputer(filePath);
    return { ok: true, name: file.name, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Reads every attached file Slate can make sense of, once, and keeps the text.
// Deliberately fail-soft: a file that can't be read leaves the others alone and
// never stops the assignment page working — the same rule the class-notes
// reader follows.
async function ensureAttachmentText(id) {
  const db = getDb();
  const row = db.prepare('SELECT id, files, attachment_text, attachment_state FROM assignments WHERE id=?').get(Number(id));
  if (!row) return '';
  if (row.attachment_state === 'done' || row.attachment_state === 'reading') return row.attachment_text || '';
  const files = parseJson(row.files, []).filter((f) => require('./attachments').isReadable(f.name));
  if (!files.length) {
    db.prepare("UPDATE assignments SET attachment_state='done' WHERE id=?").run(row.id);
    return '';
  }

  db.prepare("UPDATE assignments SET attachment_state='reading' WHERE id=?").run(row.id);
  const att = require('./attachments');
  const parts = [];
  let failed = 0;
  for (const f of files) {
    try {
      const text = await att.readAttachmentText(f);
      if (text) parts.push(`From the attached file "${f.name}":\n${text}`);
    } catch {
      failed += 1; // an unreadable attachment is not an error worth showing
    }
  }
  const joined = parts.join('\n\n').slice(0, att.MAX_TEXT_CHARS);
  const state = parts.length ? 'done' : (failed ? 'error' : 'done');
  db.prepare('UPDATE assignments SET attachment_text=?, attachment_state=? WHERE id=?')
    .run(joined || null, state, row.id);
  return joined;
}

// Simplify an assignment's instructions once and cache them. Works for both
// regular assignments and projects (both live in the assignments table).
//
// The attached files are read FIRST, so the instructions are built from the
// whole assignment. A teacher who writes "see attached" and nothing else used
// to produce an Instructions box that said "see attached".
async function ensureSimplified(id) {
  const db = getDb();
  const row = db.prepare('SELECT id, title, raw_description, instructions_simple FROM assignments WHERE id=?').get(id);
  if (!row) return { instructions: null };
  if (row.instructions_simple) return { instructions: row.instructions_simple };
  let fromFiles = '';
  try { fromFiles = await ensureAttachmentText(id); } catch { /* files are a bonus, not a requirement */ }
  // The file links come out: the files have their own buttons on the page, and
  // leaving them in puts a bare filename in the student's checklist.
  const described = require('./attachments').stripFileLinks(row.raw_description || '');
  const source = fromFiles ? `${described}\n\n${fromFiles}` : described;
  const { simplify } = require('./simplify');
  // Second argument to fall back on: without AI, only the description makes
  // sense to slice sentences out of.
  const text = await simplify(source, row.title, described);
  db.prepare('UPDATE assignments SET instructions_simple=? WHERE id=?').run(text, id);
  return { instructions: text };
}


// ---- fresh Canvas pull, for one assignment --------------------------------
// The chat calls this when a conversation starts, so it answers about what
// Canvas says NOW. Sync runs hourly; a teacher who rewrites the instructions or
// attaches a file at 8am would otherwise be invisible to the chat until 9.
//
// Deliberately fail-soft and read-only: any Canvas hiccup leaves the stored row
// exactly as it was and the chat carries on with what it already had. It only
// ever writes the fields Canvas is the authority on — never the student's
// draft, slides, status or completion.
async function refreshFromCanvas(id) {
  const db = getDb();
  const row = db
    .prepare('SELECT id, class_id, canvas_assignment_id, raw_description, files FROM assignments WHERE id=?')
    .get(Number(id));
  if (!row || !row.canvas_assignment_id) return { ok: false, reason: 'no Canvas id' };

  const { canvasMode, getClient } = require('./canvas/canvasClient');
  if (canvasMode() === 'none') return { ok: false, reason: 'Canvas is not connected' };

  const cls = db.prepare('SELECT canvas_class_id FROM classes WHERE id=?').get(row.class_id);
  if (!cls || !cls.canvas_class_id) return { ok: false, reason: 'no Canvas course id' };

  const client = getClient();
  if (typeof client.getAssignment !== 'function') return { ok: false, reason: 'client cannot fetch one assignment' };

  let fresh;
  try {
    fresh = await client.getAssignment(cls.canvas_class_id, row.canvas_assignment_id);
  } catch (e) {
    console.warn('[chat] Canvas refresh failed:', e.message);
    return { ok: false, reason: e.message };
  }
  if (!fresh) return { ok: false, reason: 'Canvas had nothing for that assignment' };

  const description = fresh.description || '';
  const files = JSON.stringify(
    require('./attachments').attachmentsFor({ attachments: fresh.attachments, description })
  );
  const changed = description !== (row.raw_description || '') || files !== (row.files || '[]');

  db.prepare(
    `UPDATE assignments SET raw_description=?, files=?, points=?, due_at=?, submission_types=?
     WHERE id=?`
  ).run(
    description,
    files,
    fresh.points_possible || 0,
    fresh.due_at || null,
    Array.isArray(fresh.submission_types) ? fresh.submission_types.join(',') : (fresh.submission_types || null),
    row.id
  );

  // The description changed, so anything derived from it is stale. Clearing
  // these is what makes the next read rebuild them instead of serving the old
  // summary of instructions that no longer exist.
  if (changed) {
    db.prepare("UPDATE assignments SET instructions_simple=NULL, attachment_state='none', attachment_text=NULL WHERE id=?")
      .run(row.id);
  }
  return { ok: true, changed };
}

// ---- typed work: drafts + submit-to-file ---------------------------------
function desktopDir() {
  if (process.env.SLATE_DESKTOP_DIR) return process.env.SLATE_DESKTOP_DIR; // test override
  const home = process.env.USERPROFILE || os.homedir();
  for (const c of [path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'Desktop')]) {
    if (fs.existsSync(c)) return c;
  }
  return home;
}

// Keep a version every 10 minutes (or after a big jump) while writing. It's
// Will's own proof of authorship: when he worked and how the draft grew.
const SNAPSHOT_GAP_MS = 10 * 60 * 1000;
function recordSnapshot(db, id, text) {
  const { countWords } = require('./mla');
  const words = countWords(text);
  if (words < 20) return;
  const last = db.prepare('SELECT taken_at, words FROM draft_snapshots WHERE assignment_id=? ORDER BY id DESC LIMIT 1').get(id);
  const now = new Date();
  if (last) {
    const age = now - new Date(last.taken_at);
    if (age < SNAPSHOT_GAP_MS && Math.abs(words - (last.words || 0)) < 150) return;
  }
  db.prepare('INSERT INTO draft_snapshots (assignment_id, taken_at, words, text) VALUES (?,?,?,?)')
    .run(id, now.toISOString(), words, text);
}

// The editor sends HTML; everything else in Slate works on plain text, so both
// are stored and the plain version is derived here rather than by the page.
function saveDraft(id, text, html) {
  const db = getDb();
  let plain = text || '';
  if (html != null) {
    const rich = require('./richtext');
    plain = rich.toPlainText(rich.parseHtml(html));
    db.prepare('UPDATE assignments SET draft_html=?, draft_text=? WHERE id=?').run(String(html), plain, id);
  } else {
    db.prepare('UPDATE assignments SET draft_text=? WHERE id=?').run(plain, id);
  }
  try { recordSnapshot(db, id, plain); } catch { /* history is a nice-to-have */ }
  return { ok: true };
}

// What the editor should open with: the formatted draft if there is one, or
// the old plain draft converted across the first time it's opened.
function draftHtmlFor(row) {
  if (row.draft_html) return row.draft_html;
  return require('./richtext').textToHtml(row.draft_text || '');
}

// Font and size for the finished document. Null/null means MLA — Times New
// Roman 12 — and picking either in the editor overrides it.
function docStyle(row) {
  return {
    font: row.doc_font || null,
    size: row.doc_size || null,
    is_mla: !row.doc_font && !row.doc_size,
  };
}

function saveDocStyle(id, { font, size }) {
  const db = getDb();
  db.prepare('UPDATE assignments SET doc_font=?, doc_size=? WHERE id=?')
    .run(font ? String(font) : null, size ? Number(size) : null, Number(id));
  const row = db.prepare('SELECT doc_font, doc_size FROM assignments WHERE id=?').get(Number(id));
  return { ok: true, style: docStyle(row || {}) };
}

function writingHistory(id) {
  const db = getDb();
  const rows = db.prepare('SELECT taken_at, words FROM draft_snapshots WHERE assignment_id=? ORDER BY id').all(id);
  const a = db.prepare('SELECT time_logged FROM assignments WHERE id=?').get(id);
  const days = new Set(rows.map((r) => String(r.taken_at || '').slice(0, 10)).filter(Boolean));
  return {
    versions: rows.length,
    days: days.size,
    first: rows.length ? rows[0].taken_at : null,
    last: rows.length ? rows[rows.length - 1].taken_at : null,
    minutes_logged: Math.round(((a && a.time_logged) || 0) / 60),
  };
}

function safeBase(name) {
  return (name || 'file').replace(/[<>:"/\\|?*\n\r\t]/g, '').replace(/\.+$/, '').trim().slice(0, 90) || 'file';
}

// The finished essay as an MLA document object (src/mla.js builds it).
// ---- the heading that goes on every handed-in document -------------------
// Name, teacher, class, date — the four lines a teacher expects at the top.
// Each piece is guessed once and then remembered per class, so a correction on
// the hand-in screen sticks. Nothing here is derived fresh at submit time
// except the date.
const TEACHER_TITLES = ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.', 'Coach', 'Pastor', ''];

function headingFor(row) {
  const db = getDb();
  const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(row.class_id) || { name: '' };
  const { readClassName, teacherLabel, splitTeacher } = require('./classNames');
  const { lastNameOf } = require('./mla');
  const guess = readClassName(cls.name);

  // The student's own name comes from their account — that's the one place a
  // person's name is written down now, and the Admin page is where it's fixed.
  const users = require('./users');
  const me = users.owner();
  const student = getSetting('student_name', '') || (me && me.name) || '';

  // The saved name may already include an honorific — older saves did, and
  // people type "Mr. Ortiz" into the box. Split it so the title is never
  // written twice.
  const savedTeacher = getSetting(`teacher_name:${row.class_id}`, null);
  const fromSaved = splitTeacher(savedTeacher != null ? savedTeacher : lastNameOf(guess.teacher));
  const teacherName = fromSaved.name;
  const savedTitle = getSetting(`teacher_title:${row.class_id}`, null);
  const title = savedTitle != null ? savedTitle
    : (fromSaved.title || (teacherName ? 'Mr.' : ''));
  const savedClass = getSetting(`class_short:${row.class_id}`, null);

  return {
    student,
    teacher_title: title,
    teacher_name: teacherName,
    teacher: teacherLabel(title, teacherName),
    class_name: savedClass != null && savedClass !== '' ? savedClass : guess.short,
    raw_class_name: cls.name,
    date: today(),
    titles: TEACHER_TITLES,
  };
}

function saveHeading(classId, { student, teacher_title, teacher_name, class_name }) {
  const { splitTeacher } = require('./classNames');
  if (student != null) setSetting('student_name', String(student).trim());
  if (teacher_name != null) {
    // Typing "Mr. Ortiz" into the name box sets the title too, rather than
    // producing "Mr. Mr. Ortiz" on the paper.
    const parts = splitTeacher(teacher_name);
    setSetting(`teacher_name:${classId}`, parts.name);
    if (parts.title && teacher_title == null) setSetting(`teacher_title:${classId}`, parts.title);
  }
  if (teacher_title != null) setSetting(`teacher_title:${classId}`, String(teacher_title).trim());
  if (class_name != null) setSetting(`class_short:${classId}`, String(class_name).trim());
  return { ok: true };
}

// Every piece of written work is assembled the same way: MLA heading block,
// Times New Roman 12, double spaced. Essays additionally get a centered title
// and a Works Cited page if the draft has one.
function writtenDoc(row, { isEssay = false } = {}) {
  const h = headingFor(row);
  const { buildEssay } = require('./mla');
  const style = docStyle(row);
  // The formatted version, when the editor has been used on this one. The
  // Works Cited split still runs off the plain text either way.
  let blocks = null;
  if (row.draft_html) {
    try { blocks = require('./richtext').parseHtml(row.draft_html); } catch { blocks = null; }
  }
  return buildEssay({
    blocks,
    font: style.font,
    size: style.size,
    draft: row.draft_text || '',
    // An essay is titled by the student — the hand-in checklist nags for it, so
    // leaving it blank there is the point. Ordinary written work just takes the
    // assignment's own name so the page says what it is.
    title: row.essay_title || (isEssay ? '' : row.title || ''),
    student: h.student,
    teacher: h.teacher,
    className: h.class_name,
    date: row.due_date || today(),
  });
}

function essayDoc(row) {
  return writtenDoc(row, { isEssay: true });
}

// Resolve what we're downloading: a text assignment, a slideshow project, or a
// finished essay in MLA format.
function contentFor(kind, id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assignments WHERE id=?').get(id);
  if (!row) return null;
  if (kind === 'project' && row.build_mode === 'slides') {
    const slides = parseJson(row.slides_json, null) || seedSlides(row);
    const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(row.class_id);
    return { ck: 'slides', content: { slides, title: row.title, subtitle: cls ? cls.name : '' }, name: row.title };
  }
  // All written work goes out with the heading and MLA formatting, not just
  // essays — a typed assignment wants a name and a date on it too.
  if (kind === 'essay' || row.work_mode === 'text') {
    return { ck: 'mla', content: writtenDoc(row, { isEssay: kind === 'essay' }), name: row.title };
  }
  return { ck: 'text', content: row.draft_text || '', name: row.title };
}

function isEmptyContent(c) {
  if (c.ck === 'text') return !String(c.content).trim();
  if (c.ck === 'mla') return !(c.content.paragraphs || []).length;
  return !(c.content.slides || []).some((s) => (s.title || '').trim() || (s.bullets || []).some((b) => String(b).trim()));
}

// Options for the download popup: default name + the file types available.
function downloadOptions(kind, id) {
  const { formatsFor } = require('./officegen');
  const c = contentFor(kind, id);
  if (!c) return null;
  return {
    default_name: safeBase(c.name),
    formats: formatsFor(c.ck),
    empty: isEmptyContent(c),
  };
}

// Build the chosen format and save it to the Desktop with the chosen name.
// The student made the content — Slate only packages and saves it.
async function performDownload(kind, id, filename, format) {
  const { buildFile } = require('./officegen');
  const c = contentFor(kind, id);
  if (!c) return { ok: false, error: 'not found' };
  const { ext, bytes } = buildFile(c.ck, format, c.content);
  const base = safeBase(filename || c.name);
  const dir = desktopDir();
  let outName = `${base}.${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(dir, outName))) outName = `${base} (${n++}).${ext}`;
  fs.writeFileSync(path.join(dir, outName), bytes);
  return { ok: true, filename: outName, saved_to: path.join(dir, outName) };
}

// ---- handing in through Canvas -------------------------------------------
// Slate reads from Canvas everywhere else. This is the only writing it does,
// and only when the student has seen the exact thing on a preview screen and
// pressed the button. Nothing here ever fires on its own.

const MIME_FOR = {
  txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html',
};

// How Canvas will accept this assignment, given what the teacher allowed.
function submitRouteFor(row) {
  const types = parseJson(row.submission_types, []) || [];
  if (types.includes('online_upload')) return 'file';
  if (types.includes('online_text_entry')) return 'text';
  if (types.includes('online_url')) return 'unsupported';
  return 'unsupported';
}

function submitBlockReason(row, route) {
  if (row.type === 'project' && !row.canvas_assignment_id) return 'Slate does not have a Canvas id for this one.';
  if (!row.canvas_assignment_id) return 'Slate does not have a Canvas id for this one.';
  const types = parseJson(row.submission_types, []) || [];
  if (route === 'unsupported') {
    if (types.includes('on_paper')) return 'Your teacher wants this one on paper, so there is nothing to send.';
    if (types.includes('external_tool')) return 'This one is handed in on another website, not through Canvas.';
    if (types.includes('media_recording')) return 'This one wants a recording, which Slate cannot make for you.';
    if (types.includes('none') || !types.length) return 'Canvas is not accepting submissions for this one.';
    return 'Canvas will not take this kind of submission from Slate.';
  }
  return null;
}

// Everything the preview screen needs — including the exact bytes' size and a
// look at the content, so nothing is sent unseen.
async function submissionPreview(kind, id, filename, format, { light = false } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assignments WHERE id=?').get(Number(id));
  if (!row) return { ok: false, error: 'not found' };
  const cls = db.prepare('SELECT name, canvas_class_id FROM classes WHERE id=?').get(row.class_id);
  const c = contentFor(kind, Number(id));
  if (!c) return { ok: false, error: 'not found' };

  const { canvasMode } = require('./canvas/canvasClient');
  const route = submitRouteFor(row);
  const blocked = submitBlockReason(row, route);
  const { isEarlyMorning, timeLabel } = require('./dates');

  // A slideshow has no MLA heading — there is nowhere on a slide to put a
  // name/teacher/class/date block, and the hand-in screen must not offer to
  // edit one.
  const isSlides = c.ck === 'slides';
  const heading = isSlides ? null : headingFor(row);
  // The document broken into the pieces the page preview lays out: heading
  // lines, title, formatted blocks, works cited. The plain preview_text below
  // is still what actually gets submitted as text.
  const written = (c.ck === 'mla') ? c.content : null;
  const base = {
    ok: true,
    assignment: row.title,
    class_id: row.class_id,
    // What will sit at the top of the document, editable on the hand-in screen.
    heading,
    doc_style: docStyle(row),
    heading_lines: written
      ? [written.student, written.teacher, written.className, written.date].filter(Boolean)
      : [],
    doc_title: written ? written.title : '',
    doc_blocks: written
      ? (written.blocks || written.paragraphs.map((t) => ({ type: 'p', align: null, runs: [{ text: t }] })))
      : null,
    works_cited: written ? written.worksCited : [],
    // The deck, so the hand-in screen can show real slides you click through
    // instead of a wall of text. slides[0] IS the title slide (round 16).
    slides: isSlides ? (c.content.slides || []) : null,
    formatting: (() => {
      if (isSlides) {
        const n = (c.content.slides || []).length;
        return `${n} slide${n === 1 ? '' : 's'}, PowerPoint`;
      }
      const st = docStyle(row);
      return st.is_mla ? 'Times New Roman 12, double spaced'
        : `${st.font || 'Times New Roman'} ${st.size || 12}, double spaced`;
    })(),
    class_name: cls ? cls.name : '',
    points: row.points,
    due_date: row.due_date,
    due_at: row.due_at || null,
    due_morning_of: isEarlyMorning(row.due_at) ? timeLabel(row.due_at) : '',
    late: !!(row.due_at && new Date(row.due_at).getTime() < Date.now()),
    empty: isEmptyContent(c),
    // 'mock' counts as connected here on purpose: the mock's submit functions
    // record instead of sending, which is the only way the whole submit path
    // gets exercised by the tests. It never reaches a network.
    can_submit: !blocked && canvasMode() !== 'none',
    blocked_reason: blocked,
    not_connected: canvasMode() === 'none',
    route,
  };
  if (blocked) return base;

  // Has Canvas already got something for this? Resubmitting over a graded
  // attempt is a real mistake to make by accident, so the preview says so.
  // Read-only, and a failure here must not stop the preview rendering.
  if (!light && base.can_submit && cls && cls.canvas_class_id && row.canvas_assignment_id) {
    try {
      const client = require('./canvas/canvasClient').getClient();
      const prior = client.getMySubmission
        ? await client.getMySubmission(cls.canvas_class_id, row.canvas_assignment_id)
        : null;
      if (prior && prior.submitted_at) {
        base.already_submitted_at = prior.submitted_at;
        base.already_attempts = prior.attempt || 1;
        base.already_scored = prior.score != null;
      }
    } catch { /* Canvas being unhelpful is not a reason to block the preview */ }
  }

  if (route === 'text') {
    // Written work pastes into a Canvas text box as its plain-text form —
    // heading and all. Only a slideshow has nothing sensible to paste.
    const text = c.ck === 'text' ? String(c.content || '')
      : c.ck === 'mla' ? require('./mla').toText(c.content)
        : null;
    if (text == null) return { ...base, can_submit: false, blocked_reason: 'This one has to go in as a file, but Canvas is only taking typed answers.' };
    return {
      ...base,
      how: 'Typed straight into Canvas',
      preview_text: text,
      word_count: text.trim() ? text.trim().split(/\s+/).length : 0,
    };
  }

  const { buildFile, formatsFor } = require('./officegen');
  const chosen = String(format || (formatsFor(c.ck)[0] || {}).ext || 'txt');
  let built;
  try { built = buildFile(c.ck, chosen, c.content); } catch (err) { return { ...base, can_submit: false, blocked_reason: err.message }; }
  const name = `${safeBase(filename || c.name)}.${built.ext}`;
  return {
    ...base,
    how: 'Uploaded to Canvas as a file',
    filename: name,
    format: built.ext,
    formats: formatsFor(c.ck),
    bytes: built.bytes.length,
    // The text that went into the file, so the preview shows the real content
    // rather than just a filename and a size.
    preview_text: c.ck === 'text' ? String(c.content || '')
      : c.ck === 'mla' ? require('./mla').toText(c.content)
        : require('./officegen').slidesToText(c.content.slides || []),
  };
}

// Runs the student's own writing past GPTZero, if they've turned it on. Only
// makes sense for writing — there's nothing to check in a slideshow.
async function aiCheckFor(kind, id) {
  const c = contentFor(kind, Number(id));
  if (!c) return { ok: false, state: 'error', error: 'not found' };
  const text = c.ck === 'text' ? String(c.content || '')
    : c.ck === 'mla' ? require('./mla').toText(c.content)
      : null;
  if (text == null) return { ok: true, state: 'not_writing' };
  return require('./aiCheck').checkWriting(Number(id), text);
}

async function submitToCanvas(kind, id, filename, format) {
  const preview = await submissionPreview(kind, id, filename, format);
  if (!preview.ok) return preview;
  if (preview.empty) return { ok: false, error: 'There is nothing written yet, so there is nothing to hand in.' };
  if (preview.blocked_reason) return { ok: false, error: preview.blocked_reason };
  if (preview.not_connected) return { ok: false, error: 'Connect Canvas on the API tab first.' };

  const db = getDb();
  const row = db.prepare('SELECT * FROM assignments WHERE id=?').get(Number(id));
  const cls = db.prepare('SELECT canvas_class_id FROM classes WHERE id=?').get(row.class_id);
  if (!cls || !cls.canvas_class_id) return { ok: false, error: 'Slate does not know which Canvas class this belongs to.' };

  const { getClient } = require('./canvas/canvasClient');
  const client = getClient();
  const courseId = cls.canvas_class_id;
  const assignmentId = row.canvas_assignment_id;

  try {
    let result;
    if (preview.route === 'text') {
      result = await client.submitText(courseId, assignmentId, preview.preview_text);
    } else {
      const c = contentFor(kind, Number(id));
      const { buildFile } = require('./officegen');
      const built = buildFile(c.ck, preview.format, c.content);
      result = await client.submitFile(courseId, assignmentId, preview.filename, built.bytes,
        MIME_FOR[built.ext] || 'application/octet-stream');
    }
    // Handed in means done.
    db.prepare("UPDATE assignments SET status='done', completed_at=?, completed_day=? WHERE id=?")
      .run(new Date().toISOString(), today(), row.id);
    return {
      ok: true,
      submitted_at: (result && result.submitted_at) || new Date().toISOString(),
      attempt: (result && result.attempt) || 1,
      how: preview.how,
      filename: preview.filename || null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function completeAssignment(id) {
  getDb().prepare("UPDATE assignments SET status='done', completed_at=?, completed_day=? WHERE id=?")
    .run(new Date().toISOString(), today(), id);
  return { ok: true };
}
function reopenAssignment(id) {
  getDb().prepare("UPDATE assignments SET status='todo', completed_at=NULL, completed_day=NULL WHERE id=?").run(id);
  return { ok: true };
}
// ---- time worked ---------------------------------------------------------
// Two different questions, two different numbers. The per-item `time_logged`
// only ever climbs — it answers "am I ready for this test yet". `time_log`
// stamps each stretch with the local day it happened on, which is what makes
// "worked today" start again from zero every morning without anything having to
// run at midnight: a new day simply has no rows yet.
function logTime(kind, refId, seconds) {
  const s = Math.max(0, seconds | 0);
  if (!s) return;
  getDb()
    .prepare('INSERT INTO time_log (day, kind, ref_id, seconds, logged_at) VALUES (?,?,?,?,?)')
    .run(today(), kind, refId == null ? null : Number(refId), s, new Date().toISOString());
}

function secondsWorkedOn(day, { kind, refId } = {}) {
  const db = getDb();
  if (kind && refId != null) {
    return db.prepare('SELECT COALESCE(SUM(seconds),0) s FROM time_log WHERE day=? AND kind=? AND ref_id=?')
      .get(day, kind, Number(refId)).s;
  }
  return db.prepare('SELECT COALESCE(SUM(seconds),0) s FROM time_log WHERE day=?').get(day).s;
}

// What the Today page shows. Resets on its own each local midnight.
function workedToday() {
  const day = today();
  const seconds = secondsWorkedOn(day);
  return { day, seconds, minutes: Math.round(seconds / 60) };
}

function addTime(id, seconds) {
  getDb().prepare('UPDATE assignments SET time_logged = time_logged + ? WHERE id=?').run(Math.max(0, seconds | 0), id);
  logTime('assignment', id, seconds);
  const row = getDb().prepare('SELECT time_logged FROM assignments WHERE id=?').get(id);
  return { time_logged: row ? row.time_logged : 0, ...workedToday() };
}

// ---- weekly view ---------------------------------------------------------
function week() {
  const db = getDb();
  const start = today();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start + 'T00:00:00');
    d.setDate(d.getDate() + i);
    const day = ymd(d);
    // Ids come back so the day popup can open the thing you clicked.
    const assignments = db
      .prepare(
        `SELECT a.id, a.title, a.type, a.points, a.due_at, c.name AS class_name
         FROM assignments a JOIN classes c ON c.id=a.class_id
         WHERE ${LIVE_CLASS} AND a.status='todo' AND a.due_date=? AND a.type='regular' ORDER BY a.points DESC`
      )
      .all(day);
    // Work due that day that is already handled. Only things finished IN Slate
    // (completed_at is set) — Canvas's already-graded imports would otherwise
    // flood the week with old work.
    const doneAssignments = db
      .prepare(
        `SELECT a.id, a.title, a.type, a.points, a.due_at, c.name AS class_name
         FROM assignments a JOIN classes c ON c.id=a.class_id
         WHERE ${LIVE_CLASS} AND a.status='done' AND a.completed_day IS NOT NULL
           AND a.due_date=? AND a.type='regular' ORDER BY a.points DESC`
      )
      .all(day);
    // A project belongs on the day it is DUE. It used to appear on every day it
    // had a piece of work scheduled, which put the same project on five days
    // running and made the week look far busier than it was.
    const projects = db
      .prepare(
        `SELECT a.id, a.title, a.points, a.due_at, c.name AS class_name
         FROM assignments a JOIN classes c ON c.id=a.class_id
         WHERE ${LIVE_CLASS} AND a.type='project' AND a.status='todo' AND a.due_date=? ORDER BY a.points DESC`
      )
      .all(day);
    const doneProjects = db
      .prepare(
        `SELECT a.id, a.title, a.points, a.due_at, c.name AS class_name
         FROM assignments a JOIN classes c ON c.id=a.class_id
         WHERE ${LIVE_CLASS} AND a.type='project' AND a.status='done' AND a.due_date=? ORDER BY a.points DESC`
      )
      .all(day);
    const tests = db
      .prepare(
        `SELECT t.id, t.name, t.type, t.due_at, c.name AS class_name
         FROM tests t JOIN classes c ON c.id=t.class_id WHERE ${LIVE_CLASS} AND t.due_date=?`
      )
      .all(day);
    days.push({
      day,
      label: new Date(day + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      is_today: day === start,
      assignments,
      projects,
      tests,
      // Same day, already handled.
      done_assignments: doneAssignments,
      done_projects: doneProjects,
    });
  }
  return days;
}

// ---- projects ------------------------------------------------------------
function projectProgress(assignmentId) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) n FROM project_chunks WHERE assignment_id=?').get(assignmentId).n;
  const done = db.prepare('SELECT COUNT(*) n FROM project_chunks WHERE assignment_id=? AND done=1').get(assignmentId).n;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

function projects() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.*, c.name AS class_name FROM assignments a JOIN classes c ON c.id=a.class_id
       WHERE ${LIVE_CLASS} AND a.type='project' AND a.status='todo' ORDER BY a.due_date`
    )
    .all();
  // No pieces, no "today's chunk", no progress fraction — projects are not
  // paced into a daily plan any more. Just what it is and when it's due.
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    class_name: r.class_name,
    points: r.points,
    due_date: r.due_date,
    due_at: r.due_at || null,
    build_mode: r.build_mode || 'none',
  }));
}

// How far along an essay is: sentences written vs. how many the assignment
// looks like it wants. The editor recomputes this live as Will types.
function essayPercent(row) {
  if ((row.build_mode || '') !== 'essay') return null;
  const { targetsFromText, countSentences } = require('./unstuck');
  const { splitDraft } = require('./mla');
  const target = targetsFromText(row.raw_description || '').sentences;
  // Count the essay itself — Works Cited entries would inflate the percent.
  const written = countSentences(splitDraft(row.draft_text || '').body.join(' '));
  return { written, target, pct: target ? Math.min(100, Math.round((written / target) * 100)) : 0 };
}

function projectDetail(id) {
  const db = getDb();
  const row = db
    .prepare('SELECT a.*, c.name AS class_name FROM assignments a JOIN classes c ON c.id=a.class_id WHERE a.id=?')
    .get(id);
  if (!row) return null;
  let slides = parseJson(row.slides_json, null);
  if (row.build_mode === 'slides' && !slides) slides = seedSlides(row);
  return {
    id: row.id,
    title: row.title,
    class_name: row.class_name,
    points: row.points,
    due_date: row.due_date,
    due_at: row.due_at || null,
    final_deliverable: row.description,
    files: fileList(row),
    files_state: row.attachment_state || 'none',
    time_logged: row.time_logged || 0,
    build_mode: row.build_mode || 'none',
    slides: slides || [],
    has_custom_slides: !!row.slides_json, // false = still the blank seed
    // Essay projects write into the same draft_text the typed assignments use.
    draft_text: row.draft_text || '',
    draft_html: draftHtmlFor(row),
    doc_style: docStyle(row),
    essay_target: require('./unstuck').targetsFromText(row.raw_description || ''),
    essay_done_pct: essayPercent(row),
    instructions_ai: row.instructions_simple || null,
    instructions_plain: require('./simplify').ruleBased(row.raw_description || ''),
  };
}

// Finishing an essay: pull every paragraph together in MLA format, show what's
// still missing, and show the writing history. Nothing here rewrites the essay —
// it's Will's paragraphs, wrapped in the formatting a teacher expects.
function essayReview(id) {
  const db = getDb();
  const row = db.prepare('SELECT a.*, c.name AS class_name FROM assignments a JOIN classes c ON c.id=a.class_id WHERE a.id=?').get(id);
  if (!row) return null;
  const { toText, checkEssay } = require('./mla');
  const { targetsFromText } = require('./unstuck');
  const doc = essayDoc(row);
  const raw = stripHtml(row.raw_description || '');
  const target = targetsFromText(row.raw_description || '');
  const needsSources = /\b(sources?|cite|citations?|mla|works\s*cited|bibliograph)/i.test(raw);
  const checks = checkEssay(doc, {
    targetWords: target.words,
    targetParagraphs: target.paragraphs,
    needsSources,
  });
  return {
    id: row.id,
    assignment_title: row.title,
    title: doc.title,
    class_name: row.class_name,
    student_name: doc.student,
    teacher_name: doc.teacher,
    date: doc.date,
    preview: toText(doc),
    paragraph_count: doc.paragraphs.length,
    words: doc.words,
    works_cited: doc.worksCited,
    checks,
    all_clear: checks.every((c) => c.ok),
    history: writingHistory(id),
  };
}

// The MLA heading details. Your name is remembered everywhere, the teacher's
// name per class, and the essay title on the essay itself.
function saveEssayNames(id, names = {}) {
  const db = getDb();
  const row = db.prepare('SELECT class_id FROM assignments WHERE id=?').get(id);
  if (!row) return { ok: false, error: 'not found' };
  if (typeof names.student_name === 'string') setSetting('student_name', names.student_name.trim());
  if (typeof names.teacher_name === 'string') setSetting(`teacher_name:${row.class_id}`, names.teacher_name.trim());
  if (typeof names.title === 'string') {
    db.prepare('UPDATE assignments SET essay_title=? WHERE id=?').run(names.title.trim(), id);
  }
  return essayReview(id);
}

// "Get Unstuck": read the draft, hand back direction on the section the writer
// is stuck on. Coaching only — it never writes any of the essay itself.
async function unstuckGuidance(id, body = {}, opts = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assignments WHERE id=?').get(id);
  if (!row) return { ok: false, error: 'not found' };
  // The editor sends its live text so the coach always sees the newest draft.
  if (typeof body.draft === 'string') {
    db.prepare('UPDATE assignments SET draft_text=? WHERE id=?').run(body.draft, id);
    row.draft_text = body.draft;
  }
  const draft = row.draft_text || '';
  if (!draft.trim()) {
    return { ok: false, error: 'Write a sentence or two first — the coach needs your words to work from.' };
  }
  const { getGuidance, targetsFromText } = require('./unstuck');
  const guidance = await getGuidance(
    {
      title: row.title,
      instructions: row.instructions_simple || stripHtml(row.raw_description || ''),
      draft,
      stuckNote: body.stuck_note,
      target: targetsFromText(row.raw_description || ''),
    },
    opts
  );
  return { ok: true, ...guidance };
}

// Auto-build a slide outline from the assignment (count from instructions,
// picks a subject if told to choose one, fills in all the headers). Saves it.
async function generateSlidesOutline(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assignments WHERE id=?').get(id);
  if (!row || row.build_mode !== 'slides') return { ok: false, error: 'not a slideshow project' };
  const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(row.class_id);
  const { generateOutline } = require('./outline');
  const slides = await generateOutline({ ...row, class_name: cls ? cls.name : '' });
  db.prepare('UPDATE assignments SET slides_json=? WHERE id=?').run(JSON.stringify(slides), id);
  return { ok: true, slides };
}

// Researched points to work from, dropped into the slides that are empty.
//
// Only fills bullets the student hasn't written in — anything already typed is
// left completely alone, so pressing this after doing some work can never wipe
// it. The title slide is skipped: its "bullet" is the subtitle line.
async function fillSlideSuggestions(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assignments WHERE id=?').get(Number(id));
  if (!row || row.build_mode !== 'slides') return { ok: false, error: 'not a slideshow project' };
  const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(row.class_id);
  let slides = parseJson(row.slides_json, null) || seedSlides(row);

  const { generateSuggestions } = require('./outline');
  let points = null;
  try {
    points = await generateSuggestions({ ...row, class_name: cls ? cls.name : '' }, slides);
  } catch (e) {
    return { ok: false, error: 'Could not look that up just now — try again in a moment.' };
  }
  if (!points) {
    return { ok: false, error: 'Could not look that up just now — try again in a moment.' };
  }

  let filled = 0;
  slides = slides.map((s, i) => {
    if (i === 0) return s; // the title slide's bullet is its subtitle
    const written = (s.bullets || []).filter((b) => String(b).trim());
    if (written.length) return s; // never overwrite the student's own words
    const mine = points[i] || [];
    if (!mine.length) return s;
    filled += 1;
    return { ...s, bullets: mine.slice() };
  });

  db.prepare('UPDATE assignments SET slides_json=? WHERE id=?').run(JSON.stringify(slides), Number(id));
  return { ok: true, slides, filled };
}

// A starting point so the builder isn't blank. Slide 1 is ALWAYS the title
// slide, pre-filled with the assignment name and the class as its subtitle —
// both editable. The instructions (e.g. "make 6-8 slides") live in the
// Instructions section, NOT as slide titles.
function seedSlides(row) {
  const db = getDb();
  const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(row.class_id);
  return [
    { title: row.title, bullets: [cls ? cls.name : ''], photo: false, notes: '' },
    { title: '', bullets: [''], photo: false, notes: '' },
  ];
}

function saveSlides(id, slides) {
  const clean = Array.isArray(slides)
    ? slides.map((s) => ({
      title: String(s.title || ''),
      bullets: (s.bullets || []).map((b) => String(b)),
      photo: !!s.photo,
      // Speaker notes. This map is a whitelist, so a field missing from it
      // is silently dropped on every autosave — which is what would happen
      // to notes typed into the builder if this line were not here.
      notes: String(s.notes || ''),
    }))
    : [];
  getDb().prepare('UPDATE assignments SET slides_json=? WHERE id=?').run(JSON.stringify(clean), id);
  return { ok: true, count: clean.length };
}

function setChunkDone(chunkId, done) {
  getDb().prepare('UPDATE project_chunks SET done=? WHERE id=?').run(done ? 1 : 0, chunkId);
  const row = getDb().prepare('SELECT assignment_id FROM project_chunks WHERE id=?').get(chunkId);
  return row ? projectDetail(row.assignment_id) : { ok: true };
}

// Compile all chunk work into one review document when the project is done.
function compileProject(id) {
  const db = getDb();
  const row = db.prepare('SELECT a.*, c.name AS class_name FROM assignments a JOIN classes c ON c.id=a.class_id WHERE a.id=?').get(id);
  if (!row) return null;
  const chunks = db.prepare('SELECT day, chunk_description FROM project_chunks WHERE assignment_id=? ORDER BY day').all(id);
  const steps = parseJson(row.steps, []);
  const lines = [];
  lines.push(`# ${row.title}`);
  lines.push(`Class: ${row.class_name}    Points: ${row.points}    Due: ${row.due_date}`);
  lines.push('');
  lines.push(`Final deliverable: ${row.description || ''}`);
  lines.push('');
  lines.push('## What you planned and worked through');
  chunks.forEach((c, i) => {
    lines.push(`${i + 1}. (${c.day}) ${c.chunk_description.replace(/\n/g, '; ')}`);
  });
  if (steps.length) {
    lines.push('');
    lines.push('## Full step list');
    steps.forEach((s, i) => lines.push(`- ${s}`));
  }
  lines.push('');
  lines.push('Review everything above, then put your finished work together for submission.');
  return { title: row.title, text: lines.join('\n') };
}

// ---- tests ---------------------------------------------------------------
function testMastery(testId) {
  const db = getDb();
  const cards = db.prepare('SELECT confidence_level FROM flashcards WHERE test_id=?').all(testId);
  const t = db.prepare('SELECT time_logged, time_budget_minutes FROM tests WHERE id=?').get(testId);
  const maxLevel = INTERVALS.length - 1;
  let cardScore = 0;
  if (cards.length) {
    cardScore = cards.reduce((s, c) => s + (c.confidence_level || 0), 0) / (cards.length * maxLevel);
  }
  const timeFrac = t && t.time_budget_minutes ? Math.min(1, (t.time_logged || 0) / (t.time_budget_minutes * 60)) : 0;
  // Blend: knowing the cards matters most; time studied fills the rest.
  const pct = cards.length ? Math.round((cardScore * 0.7 + timeFrac * 0.3) * 100) : Math.round(timeFrac * 100);
  return pct;
}

// `weeks` narrows the list to what is coming in the next N weeks. 0 (or
// anything unrecognised) means everything, which is what the page opens on.
//
// A window looks FORWARD from today: something already sat is not in the next
// two weeks, so it only appears under All. A test with no due date at all is
// kept in every window — a date filter can't judge it, and dropping it would
// hide it completely.
function tests(weeks = 0) {
  const db = getDb();
  const n = Math.max(0, Math.min(4, Number(weeks) || 0));
  let where = LIVE_CLASS;
  const args = [];
  if (n) {
    const t = today();
    const end = new Date(t + 'T00:00:00');
    end.setDate(end.getDate() + n * 7);
    where += ' AND (t.due_date IS NULL OR (t.due_date >= ? AND t.due_date <= ?))';
    args.push(t, ymd(end));
  }
  const rows = db
    .prepare(`SELECT t.*, c.name AS class_name FROM tests t JOIN classes c ON c.id=t.class_id
              WHERE ${where} ORDER BY t.due_date`)
    .all(...args);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    class_name: t.class_name,
    due_date: t.due_date,
    due_at: t.due_at || null,
    time_budget_minutes: t.time_budget_minutes,
    time_logged: t.time_logged,
    study_guide_url: t.study_guide_url,
    mastery: testMastery(t.id),
    card_count: db.prepare('SELECT COUNT(*) n FROM flashcards WHERE test_id=?').get(t.id).n,
    notes_status: t.notes_status || 'none',
  }));
}

function testDetail(id) {
  const db = getDb();
  const t = db.prepare('SELECT t.*, c.name AS class_name FROM tests t JOIN classes c ON c.id=t.class_id WHERE t.id=?').get(id);
  if (!t) return null;
  const cards = db.prepare('SELECT id, front, back, confidence_level, next_review_date FROM flashcards WHERE test_id=?').all(id);
  const due = cards.filter((c) => isDue(c));
  const known = cards.filter((c) => (c.confidence_level || 0) >= 4).length;
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    class_name: t.class_name,
    due_date: t.due_date,
    due_at: t.due_at || null,
    time_budget_minutes: t.time_budget_minutes,
    time_logged: t.time_logged,
    study_guide_url: t.study_guide_url,
    mastery: testMastery(id),
    total_cards: cards.length,
    known_cards: known,
    due_cards: due.map((c) => ({ id: c.id, front: c.front, back: c.back })),
    // The running total climbs toward the goal; today's is what starts again
    // each morning.
    time_logged_today: secondsWorkedOn(today(), { kind: 'test', refId: id }),
    notes: t.notes || '',
    notes_status: t.notes_status || 'none',
    notes_file: t.notes_file || '',
    // Class notes added to this test from the class page. Separate from `notes`
    // above, which is the older drag-a-file-onto-the-test summary.
    class_notes: require('./classNotes').notesForTest(id),
  };
}

function uploadTestNotes(id, filename, contentBase64) {
  if (!filename || !contentBase64) return { ok: false, error: 'missing file' };
  if (contentBase64.length > 8_000_000) return { ok: false, error: 'file too big (max ~6 MB)' };
  const { processNotesFile } = require('./notesAI');
  const buffer = Buffer.from(contentBase64, 'base64');
  return processNotesFile(Number(id), String(filename), buffer);
}

function addStudyTime(id, seconds) {
  getDb().prepare('UPDATE tests SET time_logged = time_logged + ? WHERE id=?').run(Math.max(0, seconds | 0), id);
  logTime('test', id, seconds);
  const t = getDb().prepare('SELECT time_logged FROM tests WHERE id=?').get(id);
  return {
    time_logged: t ? t.time_logged : 0,
    time_logged_today: secondsWorkedOn(today(), { kind: 'test', refId: id }),
    mastery: testMastery(id),
    ...workedToday(),
  };
}

function reviewFlashcard(cardId, remembered) {
  const db = getDb();
  const card = db.prepare('SELECT * FROM flashcards WHERE id=?').get(cardId);
  if (!card) return null;
  const upd = reviewCard(card, !!remembered);
  db.prepare('UPDATE flashcards SET confidence_level=?, next_review_date=? WHERE id=?')
    .run(upd.confidence_level, upd.next_review_date, cardId);
  return { ok: true, mastery: testMastery(card.test_id) };
}

// ---- classes / grades / GPA ---------------------------------------------
// The grade for a class.
//
// CANVAS'S OWN NUMBER WINS. Teachers weight categories — tests 40%, homework
// 20% — and Canvas has already applied that. Adding up raw points gives a
// different figure, so showing the sum would mean Slate quoting Will a grade
// that appears nowhere else and that he might make decisions on. The points
// total is only the fallback for a class Canvas hasn't graded yet.
function classGrade(classId) {
  const db = getDb();
  const cls = db.prepare('SELECT canvas_score, canvas_letter FROM classes WHERE id=?').get(classId) || {};
  const rows = db
    .prepare(
      `SELECT g.points_earned, g.points_possible FROM grades g
       JOIN assignments a ON a.id=g.assignment_id WHERE a.class_id=?`
    )
    .all(classId);
  let earned = 0, possible = 0;
  for (const r of rows) { earned += r.points_earned || 0; possible += r.points_possible || 0; }

  if (cls.canvas_score != null) {
    const pct = Math.round(Number(cls.canvas_score) * 10) / 10;
    return {
      pct,
      // Canvas's own letter if the school set one up, otherwise the usual scale.
      letter: cls.canvas_letter || letterGrade(pct),
      earned,
      possible,
      from_canvas: true,
    };
  }
  const pct = possible ? (earned / possible) * 100 : null;
  return {
    pct: pct == null ? null : Math.round(pct * 10) / 10,
    letter: letterGrade(pct),
    earned,
    possible,
    from_canvas: false,
  };
}

// The Formative / Summative split. Will's school weights them 50-50 and both
// numbers matter to him separately, so they get their own figure rather than
// being folded into the total.
//
// Within a category it IS a straight points total — the weighting Canvas
// applies is BETWEEN categories, which is exactly what the overall grade
// already accounts for. Returns null for a category with nothing graded yet,
// so the page can show a dash instead of a misleading 0%.
function categoryGrades(classId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.category, g.points_earned, g.points_possible
       FROM grades g JOIN assignments a ON a.id = g.assignment_id
       WHERE a.class_id = ? AND a.category IS NOT NULL`
    )
    .all(classId);
  const out = {};
  for (const key of ['formative', 'summative']) {
    const mine = rows.filter((r) => r.category === key);
    let earned = 0, possible = 0;
    for (const r of mine) { earned += r.points_earned || 0; possible += r.points_possible || 0; }
    const pct = possible ? Math.round((earned / possible) * 1000) / 10 : null;
    out[key] = { pct, letter: letterGrade(pct), earned, possible, count: mine.length };
  }
  // Does this class even use the split? A class on plain Canvas defaults has
  // one "Assignments" group and no formative/summative anywhere.
  const uses = db
    .prepare('SELECT COUNT(*) n FROM assignments WHERE class_id=? AND category IS NOT NULL')
    .get(classId).n;
  out.has_split = uses > 0;
  return out;
}

function letterGrade(pct) {
  if (pct == null) return '—';
  if (pct >= 93) return 'A';
  if (pct >= 90) return 'A-';
  if (pct >= 87) return 'B+';
  if (pct >= 83) return 'B';
  if (pct >= 80) return 'B-';
  if (pct >= 77) return 'C+';
  if (pct >= 73) return 'C';
  if (pct >= 70) return 'C-';
  if (pct >= 67) return 'D+';
  if (pct >= 60) return 'D';
  return 'F';
}

function gradePoints(pct) {
  if (pct == null) return null;
  if (pct >= 93) return 4.0;
  if (pct >= 90) return 3.7;
  if (pct >= 87) return 3.3;
  if (pct >= 83) return 3.0;
  if (pct >= 80) return 2.7;
  if (pct >= 77) return 2.3;
  if (pct >= 73) return 2.0;
  if (pct >= 70) return 1.7;
  if (pct >= 67) return 1.3;
  if (pct >= 60) return 1.0;
  return 0.0;
}

function classes() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM classes WHERE archived = 0 ORDER BY name').all();
  return rows.map((c) => {
    const g = classGrade(c.id);
    return {
      id: c.id,
      name: c.name,
      weight: c.weight,
      grade_pct: g.pct,
      grade_letter: g.letter,
      categories: categoryGrades(c.id),
    };
  });
}

function classDetail(id) {
  const db = getDb();
  const c = db.prepare('SELECT * FROM classes WHERE id=?').get(id);
  if (!c) return null;
  const items = db
    .prepare(
      `SELECT a.title, a.due_date, a.category, a.group_name, g.points_earned, g.points_possible
       FROM grades g JOIN assignments a ON a.id=g.assignment_id
       WHERE a.class_id=? ORDER BY a.due_date DESC`
    )
    .all(id);
  const g = classGrade(id);
  return {
    id: c.id,
    name: c.name,
    weight: c.weight,
    grade_pct: g.pct,
    grade_letter: g.letter,
    total_earned: g.earned,
    total_possible: g.possible,
    categories: categoryGrades(id),
    grades: items.map((i) => ({
      title: i.title,
      due_date: i.due_date,
      // Which half of the grade this one counted towards.
      category: i.category || null,
      category_label: i.category ? i.category[0].toUpperCase() + i.category.slice(1) : (i.group_name || ''),
      earned: i.points_earned,
      possible: i.points_possible,
      pct: i.points_possible ? Math.round((i.points_earned / i.points_possible) * 1000) / 10 : null,
    })),
    notes: require('./classNotes').listNotes(id),
    tests: db.prepare('SELECT id, name, type, due_date FROM tests WHERE class_id=? ORDER BY due_date').all(id),
  };
}

function gpa() {
  const cls = classes().filter((c) => c.grade_pct != null);
  if (!cls.length) return { gpa: null, scale: '4.0' };
  const pts = cls.map((c) => gradePoints(c.grade_pct));
  const avg = pts.reduce((a, b) => a + b, 0) / pts.length;
  return { gpa: Math.round(avg * 100) / 100, scale: '4.0', classes: cls.length };
}

// ---- emails --------------------------------------------------------------
// Opening a message: the whole text plus any attachments. Canvas only hands
// those over per-conversation, so it's fetched the first time it's opened and
// kept from then on. A Canvas that won't answer falls back to the preview
// rather than showing an error where the message should be.
async function emailDetail(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(Number(id));
  if (!row) return null;

  const shape = (body, attachments, loaded) => ({
    id: row.id,
    subject: row.subject,
    from_name: row.from_name,
    received: row.received,
    received_label: row.received
      ? new Date(row.received).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '',
    body,
    attachments,
    full_text_loaded: loaded,
  });

  if (row.body_full) {
    let atts = [];
    try { atts = JSON.parse(row.attachments || '[]'); } catch { atts = []; }
    return shape(row.body_full, atts, true);
  }

  const { getClient, isConnected } = require('./canvas/canvasClient');
  if (!isConnected() || !row.canvas_id) return shape(row.body || '', [], false);
  try {
    const client = getClient();
    if (typeof client.getConversation !== 'function') return shape(row.body || '', [], false);
    const full = await client.getConversation(row.canvas_id);
    const body = String(full.body || row.body || '');
    const atts = (full.attachments || []).map((a) => ({
      name: String(a.display_name || a.name || 'attachment'),
      url: String(a.url || ''),
      size: Number(a.size || 0),
    }));
    db.prepare('UPDATE emails SET body_full=?, attachments=? WHERE id=?')
      .run(body, JSON.stringify(atts), row.id);
    return shape(body, atts, true);
  } catch (err) {
    console.warn('[email] could not open message', row.id, '-', err.message);
    return shape(row.body || '', [], false);
  }
}

function emails() {
  return getDb()
    .prepare('SELECT id, subject, from_name, received, body FROM emails ORDER BY received DESC')
    .all()
    .map((e) => ({
      ...e,
      received_label: e.received ? new Date(e.received).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '',
    }));
}

// ---- Canvas connection (the API page) ------------------------------------
// The token lives in the settings table, not .env — settings sit in the data
// folder, which updates never touch, so connecting once survives every update.
function canvasSettings() {
  const { canvasMode } = require('./canvas/canvasClient');
  const token = getSetting('canvas_api_token') || '';
  return {
    base_url: getSetting('canvas_base_url') || '',
    // Never send the token back to the page. Show enough to recognise it.
    token_hint: token ? '…' + token.slice(-4) : '',
    // Only 'real' counts. Before this, a fresh Slate with no Canvas at all
    // reported connected:true, because "not mock" was treated as "real".
    connected: canvasMode() === 'real',
    account_name: getSetting('canvas_account_name') || '',
    last_sync: getSetting('last_sync'),
    // The optional GPTZero key. Only ever the last 4 characters go back.
    ai_check: require('./aiCheck').keyStatus(),
  };
}

async function connectCanvas({ base_url, token }) {
  const { verifyCredentials } = require('./canvas/canvasClient');
  const check = await verifyCredentials(base_url, token);
  if (!check.ok) return { ok: false, error: check.error };

  setSetting('canvas_base_url', check.base_url);
  setSetting('canvas_api_token', String(token).trim());
  setSetting('canvas_account_name', check.name);

  // Pull everything straight away — "connect" should mean the app is full of
  // real work by the time the page comes back.
  let counts = null;
  try {
    counts = (await require('./sync').sync({ log: () => {} })).counts || null;
  } catch (err) {
    return { ok: true, synced: false, name: check.name, error: `Connected, but the first sync failed: ${err.message}` };
  }
  return { ok: true, synced: true, name: check.name, counts, ...canvasSettings() };
}

function disconnectCanvas() {
  setSetting('canvas_base_url', '');
  setSetting('canvas_api_token', '');
  setSetting('canvas_account_name', '');
  return { ok: true, ...canvasSettings() };
}

module.exports = {
  status,
  todayAssignments, todayPlan, assignmentDetail, completeAssignment, reopenAssignment, addTime,
  submissionPreview, submitToCanvas, aiCheckFor, headingFor, saveHeading,
  workedToday, secondsWorkedOn, logTime,
  refreshFromCanvas,
  saveDraft, downloadOptions, performDownload, saveDocStyle, docStyle, draftHtmlFor,
  saveSlides, ensureSimplified, openAssignmentFile, ensureAttachmentText,
  week,
  projects, projectDetail, setChunkDone, compileProject, unstuckGuidance,
  essayReview, saveEssayNames, writingHistory,
  tests, testDetail, addStudyTime, reviewFlashcard, uploadTestNotes,
  generateSlidesOutline, fillSlideSuggestions,
  classes, classDetail, gpa,
  emails, emailDetail,
  canvasSettings, connectCanvas, disconnectCanvas,
};
