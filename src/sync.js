'use strict';

// Sync engine: pulls everything from Canvas (mock or real), cleans it up,
// categorizes it, and writes it into the local database. Read-only against
// Canvas — never writes or submits anything back.

const { getDb, setSetting } = require('./db');
const { getClient, isConnected } = require('./canvas/canvasClient');
const { understand, workMode, buildMode, assessmentKind, cleanTitle } = require('./llm');
const { planChunks } = require('./pacing');
const { generateCards } = require('./flashcards');
const { ymd, todayYmd, workDayFor } = require('./dates');

async function sync({ log = () => {} } = {}) {
  // Nothing to sync from until Canvas is connected. Importantly this does NOT
  // fall back to the mock — Slate stays empty rather than showing made-up work.
  if (!isConnected()) {
    log('Canvas is not connected yet — nothing to sync.');
    return { connected: false, classes: 0, assignments: 0, tests: 0, emails: 0 };
  }
  const db = getDb();
  const client = getClient();
  log(`Sync starting (${client.isMock ? 'MOCK Canvas' : 'REAL Canvas'})...`);

  // Real Canvas is patchy in ways the mock never was: a class with quizzes
  // switched off 404s, a teacher can hide modules, and one course being odd
  // must not cost Will every other class. Each piece is fetched on its own and
  // a failure is noted and stepped over.
  const warnings = [];
  async function tryFetch(what, fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`${what}: ${err.message}`);
      log(`  (skipped ${what} — ${err.message})`);
      return fallback;
    }
  }

  const courses = await client.listCourses();
  const seenClasses = [];
  for (const course of courses) {
    const classId = upsertClass(db, course);
    seenClasses.push(String(course.id));
    const where = `"${course.name}"`;

    // --- How the teacher divides the class up ---
    // Will's school runs Formative / Summative at 50-50 in every class, and
    // that split is what he wants to see. A class on plain Canvas defaults
    // (one "Assignments" group) simply has no split, and the page says so.
    const groups = await tryFetch(`grade categories for ${where}`, () => client.listAssignmentGroups(course.id), []);
    const groupById = {};
    for (const g of groups || []) groupById[String(g.id)] = g.name || '';

    // --- Regular + project assignments ---
    const assignments = await tryFetch(`assignments for ${where}`, () => client.listAssignments(course.id), []);
    for (const a of assignments || []) {
      a._group_name = groupById[String(a.assignment_group_id)] || null;
      // An exam posted as a plain Canvas assignment is still an exam: it goes
      // to Tests & Quizzes, not Projects.
      const kind = assessmentKind(a);
      if (kind) { upsertTestFromAssignment(db, classId, a, kind); continue; }
      const info = await understand({
        raw_title: a.name,
        raw_description: a.description,
        points: a.points_possible,
      });
      upsertAssignment(db, classId, a, info);
    }

    // --- Tests / quizzes ---
    const quizzes = await tryFetch(`quizzes for ${where}`, () => client.listQuizzes(course.id), []);
    for (const q of quizzes || []) {
      upsertTest(db, classId, q);
    }

    // --- Grades ---
    // Two different things, and they are not interchangeable:
    //  1. The COURSE grade comes from the enrollment — it is what Canvas
    //     itself shows, already run through the teacher's category weighting.
    //     Slate must never compute this from raw points; a weighted class
    //     would give a different number and Will would be looking at a grade
    //     that doesn't exist anywhere else.
    //  2. The per-assignment scores come from submissions, and only fill in
    //     the itemised list on the class page.
    const enrolled = await tryFetch(`grade for ${where}`, () => client.getEnrollmentGrade(course.id), null);
    saveCanvasGrade(db, classId, enrolled);

    const past = await tryFetch(`past work for ${where}`, () => client.listPastAssignments(course.id), []);
    const submissions = await tryFetch(`grades for ${where}`, () => client.listSubmissions(course.id), []);
    for (const pa of past || []) {
      pa._group_name = groupById[String(pa.assignment_group_id)] || null;
      const aid = upsertGradedAssignment(db, classId, pa);
      const s = (submissions || []).find((x) => String(x.assignment_id) === String(pa.id));
      if (s && s.score != null) upsertGrade(db, aid, s.score, pa.points_possible);
    }
    // Real Canvas returns nothing from listPastAssignments — the work is
    // already in the assignments table from the sync above, so scores are
    // matched straight onto it.
    recordScores(db, submissions || []);

    // Anything Canvas has actually received counts as done, however it got
    // there — handed in from Slate, from a browser, or on paper and marked by
    // the teacher. Whatever is left over is what carries to the next day.
    markSubmittedDone(db, submissions || []);

    // --- Study guides from modules -> attach to tests + build flashcards ---
    await tryFetch(`study guides for ${where}`, () => attachStudyGuides(db, client, course.id, classId), null);
  }

  // --- Classes that are no longer on the schedule ---
  const hidden = pruneClasses(db, seenClasses, log);

  // --- Project pacing (after all regular work is known) ---
  planAllProjects(db);

  // --- Emails ---
  const emails = await tryFetch('Canvas messages', () => client.listNotifications(), []);
  for (const e of emails || []) upsertEmail(db, e);

  setSetting('last_sync', new Date().toISOString());
  const counts = {
    classes: db.prepare('SELECT COUNT(*) n FROM classes WHERE archived = 0').get().n,
    assignments: db.prepare('SELECT COUNT(*) n FROM assignments').get().n,
    tests: db.prepare('SELECT COUNT(*) n FROM tests').get().n,
    flashcards: db.prepare('SELECT COUNT(*) n FROM flashcards').get().n,
    emails: db.prepare('SELECT COUNT(*) n FROM emails').get().n,
    skipped: warnings.length,
    hidden,
  };
  log(`Sync done: ${JSON.stringify(counts)}`);
  return counts;
}

// ---- classes that left the schedule --------------------------------------
// Canvas is the schedule. A class that has stopped coming back from it — a
// dropped course, a schedule change — is hidden everywhere in Slate.
//
// Hidden, not deleted, on purpose. Drafts, class notes, flashcards and study
// time all hang off a class, and a wrong guess here would destroy work that
// can't be got back. Archiving costs nothing and reverses itself: if the class
// turns up in Canvas again the next sync unhides it with everything intact.
function pruneClasses(db, seenCanvasIds, log = () => {}) {
  // An empty course list means Canvas answered oddly, not that Will dropped out
  // of school. Never prune on it.
  if (!seenCanvasIds.length) return 0;
  const seen = new Set(seenCanvasIds.map(String));
  const rows = db.prepare('SELECT id, name, canvas_class_id, archived FROM classes').all();
  let hidden = 0;
  for (const c of rows) {
    const onSchedule = seen.has(String(c.canvas_class_id));
    if (onSchedule && c.archived) {
      db.prepare('UPDATE classes SET archived = 0 WHERE id = ?').run(c.id);
      log(`  ${c.name} is back on the schedule — showing it again.`);
    } else if (!onSchedule && !c.archived) {
      db.prepare('UPDATE classes SET archived = 1 WHERE id = ?').run(c.id);
      log(`  ${c.name} is not in Canvas anymore — hiding it.`);
      hidden += 1;
    }
  }
  return hidden;
}

// ---- upserts -------------------------------------------------------------
function upsertClass(db, course) {
  const cid = String(course.id);
  const existing = db.prepare('SELECT id FROM classes WHERE canvas_class_id = ?').get(cid);
  if (existing) {
    db.prepare('UPDATE classes SET name = ?, weight = ? WHERE id = ?').run(
      course.name, course.weight != null ? course.weight : 1.0, existing.id
    );
    return existing.id;
  }
  const res = db
    .prepare('INSERT INTO classes (name, canvas_class_id, weight) VALUES (?, ?, ?)')
    .run(course.name, cid, course.weight != null ? course.weight : 1.0);
  return Number(res.lastInsertRowid);
}

function upsertAssignment(db, classId, a, info) {
  const cid = String(a.id);
  // Real Canvas has no `attachments` field on an assignment — an attached file
  // is a link in the description HTML. attachmentsFor() handles both shapes.
  const files = JSON.stringify(
    require('./attachments').attachmentsFor({ attachments: a.attachments, description: a.description })
  );
  const steps = JSON.stringify(info.steps || []);
  // due_date is the day the work must be DONE on: anything due before noon
  // belongs to the day before. due_at keeps the real deadline for display.
  const due = workDayFor(a.due_at);
  const subTypes = JSON.stringify(a.submission_types || []);
  const mode = workMode({ submission_types: a.submission_types || [], raw_title: a.name, raw_description: a.description });
  const build = info.type === 'project'
    ? buildMode({ raw_title: a.name, raw_description: a.description, attachments: a.attachments })
    : 'none';
  const groupName = a._group_name || null;
  const category = categoryOf(groupName);
  const existing = db.prepare('SELECT id, status, time_logged FROM assignments WHERE canvas_assignment_id = ?').get(cid);
  if (existing) {
    // Note: never touches status, time_logged, draft_text, or slides_json — student progress survives syncs.
    db.prepare(
      `UPDATE assignments SET class_id=?, title=?, raw_title=?, description=?, raw_description=?,
        steps=?, files=?, type=?, points=?, due_date=?, due_at=?, submission_types=?, work_mode=?, build_mode=?,
        category=?, group_name=? WHERE id=?`
    ).run(classId, info.title, a.name, info.final_deliverable, a.description || '', steps, files,
      info.type, a.points_possible || 0, due, a.due_at || null, subTypes, mode, build,
      category, groupName, existing.id);
    return existing.id;
  }
  const res = db
    .prepare(
      `INSERT INTO assignments
        (class_id, canvas_assignment_id, title, raw_title, description, raw_description,
         steps, files, type, points, due_date, due_at, status, submission_types, work_mode, build_mode,
         category, group_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'todo', ?, ?, ?, ?, ?)`
    )
    .run(classId, cid, info.title, a.name, info.final_deliverable, a.description || '',
      steps, files, info.type, a.points_possible || 0, due, a.due_at || null, subTypes, mode, build,
      category, groupName);
  return Number(res.lastInsertRowid);
}

// Canvas group name -> the two buckets Will's school grades on. Anything else
// (a default "Assignments" group, "Imported Assignments") is neither, and a
// class made only of those simply shows no split.
function categoryOf(groupName) {
  const n = String(groupName || '');
  if (/formative/i.test(n)) return 'formative';
  if (/summative/i.test(n)) return 'summative';
  return null;
}

function upsertGradedAssignment(db, classId, pa) {
  const cid = String(pa.id);
  const due = workDayFor(pa.due_at);
  const groupName = pa._group_name || null;
  const category = categoryOf(groupName);
  const existing = db.prepare('SELECT id, category FROM assignments WHERE canvas_assignment_id = ?').get(cid);
  if (existing) {
    // It may have come in before Slate knew about grade categories; fill that
    // in without touching anything else about a finished piece of work.
    if (category && !existing.category) {
      db.prepare('UPDATE assignments SET category=?, group_name=? WHERE id=?').run(category, groupName, existing.id);
    }
    return existing.id;
  }
  const res = db
    .prepare(
      `INSERT INTO assignments
        (class_id, canvas_assignment_id, title, raw_title, description, type, points, due_date, status,
         category, group_name)
       VALUES (?,?,?,?,?, 'regular', ?, ?, 'done', ?, ?)`
    )
    .run(classId, cid, pa.name, pa.name, '', pa.points_possible || 0, due, category, groupName);
  return Number(res.lastInsertRowid);
}

// Canvas states that mean the work is in. 'unsubmitted' and 'pending_review'
// without a submitted_at are not — a teacher opening the box doesn't count.
const SUBMITTED_STATES = new Set(['submitted', 'graded', 'complete', 'pending_review']);

function markSubmittedDone(db, submissions) {
  for (const s of submissions) {
    const isIn = !!s.submitted_at || SUBMITTED_STATES.has(String(s.workflow_state || '').toLowerCase());
    if (!isIn) continue;
    const row = db
      .prepare("SELECT id, status FROM assignments WHERE canvas_assignment_id = ? AND type='regular'")
      .get(String(s.assignment_id));
    if (!row || row.status === 'done') continue;

    // The day Canvas actually got it, so it lands in the right Finished list.
    // Work handed in on paper has no submitted_at, only a graded_at.
    const when = s.submitted_at || s.graded_at || null;
    if (when) {
      db.prepare("UPDATE assignments SET status='done', completed_at=?, completed_day=? WHERE id=?")
        .run(when, String(when).slice(0, 10), row.id);
    } else {
      // Graded, but Canvas won't say when. Done — with NO stamp, deliberately.
      // Stamping today would drop every previously graded assignment into
      // "Finished today" the first time submissions come through, which is
      // exactly what happened the day this started working. Round 26's rule:
      // no completed_at means historical, not finished today.
      db.prepare("UPDATE assignments SET status='done' WHERE id=?").run(row.id);
    }
  }
}

// The course grade exactly as Canvas reports it. Left alone when Canvas has
// nothing to say — a class with no graded work yet reports null, and blanking
// a real grade over a patchy answer would be worse than keeping yesterday's.
function saveCanvasGrade(db, classId, grades) {
  if (!grades) return;
  const score = grades.current_score;
  const letter = grades.current_grade || null;
  if (score == null && !letter) return;
  db.prepare('UPDATE classes SET canvas_score=?, canvas_letter=? WHERE id=?')
    .run(score == null ? null : Number(score), letter, classId);
}

// Scores for work already in the assignments table. points_possible comes from
// the assignment Slate already holds, so nothing extra has to be fetched.
//
// An exam that Canvas served as an assignment lives in `tests`, not
// `assignments`, so it has no row here and is skipped — which is exactly why
// the class grade comes from the enrollment and never from adding these up.
function recordScores(db, submissions) {
  for (const s of submissions) {
    if (s.score == null) continue;
    const row = db
      .prepare('SELECT id, points FROM assignments WHERE canvas_assignment_id = ?')
      .get(String(s.assignment_id));
    if (!row) continue;
    const possible = s.points_possible != null ? Number(s.points_possible) : (row.points || 0);
    upsertGrade(db, row.id, Number(s.score), possible);
  }
}

function upsertGrade(db, assignmentId, earned, possible) {
  const existing = db.prepare('SELECT id FROM grades WHERE assignment_id = ?').get(assignmentId);
  if (existing) {
    db.prepare('UPDATE grades SET points_earned=?, points_possible=? WHERE id=?').run(earned, possible, existing.id);
    return existing.id;
  }
  const res = db
    .prepare('INSERT INTO grades (assignment_id, points_earned, points_possible) VALUES (?,?,?)')
    .run(assignmentId, earned, possible);
  return Number(res.lastInsertRowid);
}

function upsertTest(db, classId, q) {
  const cid = String(q.id);
  const title = q.title || q.name || 'Test';
  const isQuiz = /quiz/i.test(title) || (q.points_possible || 0) < 50;
  const type = isQuiz ? 'quiz' : 'test';
  const budget = isQuiz ? 30 : 120; // study goal: 30 min per quiz, 2h per test
  const due = workDayFor(q.due_at);
  const existing = db.prepare('SELECT id FROM tests WHERE canvas_test_id = ?').get(cid);
  if (existing) {
    db.prepare('UPDATE tests SET class_id=?, name=?, type=?, due_date=?, due_at=? WHERE id=?')
      .run(classId, title, type, due, q.due_at || null, existing.id);
    return existing.id;
  }
  const res = db
    .prepare(
      `INSERT INTO tests (class_id, canvas_test_id, name, type, due_date, due_at, time_budget_minutes)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(classId, cid, title, type, due, q.due_at || null, budget);
  return Number(res.lastInsertRowid);
}

// An exam/test/quiz that Canvas served as an ordinary assignment. Stored in the
// tests table so it gets flashcards and a study timer like any other test.
// The canvas id is namespaced — an assignment id and a quiz id can collide, and
// canvas_test_id is unique.
function upsertTestFromAssignment(db, classId, a, kind) {
  const cid = `a:${a.id}`;
  const title = cleanTitle(a.name) || a.name || 'Exam';
  const due = workDayFor(a.due_at);
  const budget = kind === 'quiz' ? 30 : 120;
  const existing = db.prepare('SELECT id FROM tests WHERE canvas_test_id = ?').get(cid);
  if (existing) {
    db.prepare('UPDATE tests SET class_id=?, name=?, type=?, due_date=?, due_at=? WHERE id=?')
      .run(classId, title, kind, due, a.due_at || null, existing.id);
    return existing.id;
  }
  // It may have come in as an assignment before this rule existed. Move it
  // rather than showing the same exam in two places.
  const stale = db.prepare('SELECT id FROM assignments WHERE canvas_assignment_id = ?').get(String(a.id));
  if (stale) db.prepare('DELETE FROM assignments WHERE id = ?').run(stale.id);

  const res = db
    .prepare(
      `INSERT INTO tests (class_id, canvas_test_id, name, type, due_date, due_at, time_budget_minutes)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(classId, cid, title, kind, due, a.due_at || null, budget);
  return Number(res.lastInsertRowid);
}

function upsertEmail(db, e) {
  const existing = db.prepare('SELECT id FROM emails WHERE canvas_id = ?').get(String(e.id));
  if (existing) return existing.id;
  const res = db
    .prepare('INSERT INTO emails (canvas_id, subject, from_name, received, body) VALUES (?,?,?,?,?)')
    .run(String(e.id), e.subject || '', e.from_name || 'Canvas', e.received || '', e.body || '');
  return Number(res.lastInsertRowid);
}

// ---- study guides + flashcards ------------------------------------------
// Teachers don't always call it a "study guide" — a vocab list or a page of
// notes is just as good to make flashcards from.
const STUDY_MATERIAL = /study\s*guide|review|notes?|vocab|terms?|glossary|key\s*concepts|practice|outline|list/i;

async function attachStudyGuides(db, client, courseId, classId) {
  const modules = await client.listModules(courseId);
  const guides = [];
  for (const m of modules) {
    const items = await client.listModuleItems(courseId, m.id);
    for (const item of items) {
      if (!STUDY_MATERIAL.test(item.title || '')) continue;
      const content = await client.getFileText(item);
      // A title match with nothing behind it makes no flashcards — skip it so
      // it can never be picked over a guide that actually has content.
      if (!content || !content.trim()) continue;
      guides.push({ url: item.html_url, content });
    }
  }
  if (!guides.length) return;

  // Attach the first matching guide to each test in this class that lacks one.
  const tests = db.prepare('SELECT id, name, study_guide_url FROM tests WHERE class_id = ?').all(classId);
  for (const t of tests) {
    // Prefer a guide whose content mentions words from the test name.
    const guide = pickGuideForTest(guides, t.name);
    if (!guide) continue;
    if (!t.study_guide_url) {
      db.prepare('UPDATE tests SET study_guide_url = ? WHERE id = ?').run(guide.url, t.id);
    }
    // Build flashcards if none exist yet for this test.
    const have = db.prepare('SELECT COUNT(*) n FROM flashcards WHERE test_id = ?').get(t.id).n;
    if (!have && guide.content) {
      const cards = generateCards(guide.content);
      const insert = db.prepare('INSERT INTO flashcards (test_id, front, back, confidence_level) VALUES (?,?,?,0)');
      for (const c of cards) insert.run(t.id, c.front, c.back);
    }
  }
}

function pickGuideForTest(guides, testName) {
  if (guides.length === 1) return guides[0];
  const words = (testName || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  let best = guides[0];
  let bestScore = -1;
  for (const g of guides) {
    const c = (g.content || '').toLowerCase();
    const score = words.reduce((s, w) => s + (c.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = g; }
  }
  return best;
}

// ---- project pacing ------------------------------------------------------
function planAllProjects(db) {
  const today = todayYmd();
  const projects = db.prepare("SELECT id, steps, due_date FROM assignments WHERE type='project'").all();
  for (const p of projects) {
    const have = db.prepare('SELECT COUNT(*) n FROM project_chunks WHERE assignment_id = ?').get(p.id).n;
    if (have) continue; // don't stomp progress; only plan new projects
    let steps = [];
    try { steps = JSON.parse(p.steps || '[]'); } catch { steps = []; }
    if (!steps.length) steps = ['Get started on this project.'];
    const chunks = planChunks(steps, p.due_date, today);
    const insert = db.prepare('INSERT INTO project_chunks (assignment_id, day, chunk_description, done) VALUES (?,?,?,0)');
    for (const c of chunks) insert.run(p.id, c.day, c.chunk_description);
  }
}

module.exports = { sync, pruneClasses, markSubmittedDone, recordScores, saveCanvasGrade, categoryOf };
