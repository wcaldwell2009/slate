'use strict';

// Full-feature smoke test. Boots the real server against a throwaway database
// and walks every feature: sync, today, work pages (text + guide), drafts,
// submit-to-file, download, pomodoro time logging, week, projects + chunks +
// compile, tests + study time + flashcards, classes/grades/GPA, emails.
// Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-test-'));
let server;

async function get(p) { return (await fetch(BASE + p)).json(); }
async function post(p, body) {
  return (await fetch(BASE + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  })).json();
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CANVAS_MODE: 'mock',
      SLATE_OPEN: '0',
      SLATE_DB_PATH: path.join(TMP, 'test.db'),
      SLATE_DATA_DIR: TMP,    // notes + downloaded attachments, not the real data folder
      SLATE_DESKTOP_DIR: TMP, // submitted files land here, not the real Desktop
      SLATE_NO_AI: '1',       // notes processing uses the built-in reader in tests
      SLATE_NO_AUTOSYNC: '1', // no background sync moving data under the tests
    },
    stdio: 'ignore',
  });
  // Wait for the server to come up.
  for (let i = 0; i < 50; i++) {
    try { await get('/api/status'); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('server did not start');
});

after(() => {
  if (server) server.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('status + seeded data', async () => {
  const s = await get('/api/status');
  assert.equal(s.canvas_mode, 'mock');
  assert.ok(s.last_sync, 'seeded on first run');
});

test('today: has items, impact sort orders by points x weight', async () => {
  const plan = await get('/api/today');
  assert.ok(plan.assignments.length >= 3, 'several things due today');
  // Overdue work sits above today's whatever the sort — it is the most urgent
  // thing on the page — so impact orders WITHIN each band, not across them.
  const impact = (await get('/api/today?sort=impact')).assignments;
  const band = (a) => (a.upcoming ? 2 : a.overdue ? 0 : 1);
  for (let i = 1; i < impact.length; i++) {
    assert.ok(band(impact[i - 1]) <= band(impact[i]), 'late, then today, then work-ahead');
    if (band(impact[i - 1]) === band(impact[i])) {
      assert.ok(impact[i - 1].impact >= impact[i].impact, 'and by impact inside a band');
    }
  }
});

test('effort: estimates scale with the kind of work, not just the points', () => {
  const { assignmentMinutes, chunkMinutes, formatMinutes, problemCount } = require('../src/effort');
  assert.equal(problemCount('HW 4.2 (p. 212 #1-25 odd)'), 13, 'odd problems only');
  assert.equal(problemCount('Read Chapter 7 & Answer Questions 1-5'), 5);
  assert.equal(problemCount('no numbers here'), 0);

  const writing = assignmentMinutes({ title: 'Reading Response', raw_description: 'Write two paragraphs about chapter 3.', points: 10 });
  const recording = assignmentMinutes({ title: 'Record 1-min intro', raw_description: 'Record a one minute video.', points: 10 });
  assert.ok(writing > recording, 'writing beats a recording at the same points');
  assert.ok(assignmentMinutes({ title: 'Final essay', raw_description: 'Write an essay.', points: 100 }) > writing);
  assert.ok(assignmentMinutes({ title: 'Tiny thing', points: 1 }) >= 10, 'never estimates zero');

  assert.equal(formatMinutes(45), '45 min');
  assert.equal(formatMinutes(75), '1h 15m');
  assert.equal(formatMinutes(120), '2h');

  const c = chunkMinutes({ chunk_description: 'Draft the intro\nFind two sources' }, { points: 100 });
  assert.ok(c >= 15 && c <= 90, 'a day of project work is a sane size');
});

test('today plan: assignments are timed, and projects are whole projects', async () => {
  const plan = await get('/api/today');
  assert.equal(plan.target_minutes, 120);
  for (const a of plan.assignments) assert.ok(a.minutes >= 10 && a.minutes <= 180, 'every assignment is time-estimated');
  assert.equal(plan.assignment_minutes, plan.assignments.reduce((s, a) => s + a.minutes, 0));

  // Projects are no longer paced into a daily plan — no chunks, no pieces, no
  // "part 2 of 3", and no project minutes counted into the 2-hour day.
  assert.equal(plan.project_minutes, 0, 'project work is not scheduled into the day');
  assert.equal(plan.total_minutes, plan.assignment_minutes);
  for (const p of plan.projects) {
    assert.ok(p.project_id && p.title, 'each entry is a whole project');
    assert.equal(p.chunk_id, undefined, 'no chunk ids anywhere');
    assert.equal(p.chunk_description, undefined, 'and no chunk text');
    assert.ok(p.due_date, 'with its own deadline');
  }

  // Finishing an assignment still frees up the day; it just no longer drags
  // project pieces in behind it.
  const first = plan.assignments[0];
  await post(`/api/assignments/${first.id}/complete`);
  const after = await get('/api/today');
  assert.ok(after.assignment_minutes < plan.assignment_minutes, 'the finished work stops counting');
  assert.equal(after.projects.length, plan.projects.length, 'the project list does not react to the clock');
  await post(`/api/assignments/${first.id}/reopen`);
});

test('work modes: text entry vs guide are both present and sensible', async () => {
  const due = (await get('/api/today')).assignments;
  const details = await Promise.all(due.map((a) => get('/api/assignments/' + a.id)));
  const text = details.filter((d) => d.work_mode === 'text');
  const guide = details.filter((d) => d.work_mode === 'guide');
  assert.ok(text.length >= 1, 'at least one typed assignment today');
  assert.ok(guide.length >= 1, 'at least one guide assignment today');
  for (const g of guide) assert.ok(g.steps.length >= 1, `guide "${g.title}" has steps`);
});

test('text work: draft save + download as txt/docx/pdf to desktop', async () => {
  const due = (await get('/api/today')).assignments;
  const details = await Promise.all(due.map((a) => get('/api/assignments/' + a.id)));
  const a = details.find((d) => d.work_mode === 'text');
  assert.ok(a, 'found a text assignment');

  const answer = 'My final answer.\nLine two of my work.';
  await post(`/api/assignments/${a.id}/draft`, { text: answer });
  const again = await get('/api/assignments/' + a.id);
  assert.equal(again.draft_text, answer);

  // Typed work is now assembled with a heading in MLA formatting, same as an
  // essay — so Word and PDF lead, and the plain-text version carries the
  // heading rather than being the raw draft.
  const opts = await get(`/api/download-options?kind=assignment&id=${a.id}`);
  assert.deepEqual(opts.formats.map((f) => f.ext), ['docx', 'pdf', 'txt']);
  assert.equal(opts.empty, false);

  const rtxt = await post('/api/download', { kind: 'assignment', id: a.id, filename: 'My Essay', format: 'txt' });
  assert.equal(rtxt.ok, true);
  assert.match(rtxt.filename, /^My Essay\.txt$/);
  const written = fs.readFileSync(rtxt.saved_to, 'utf8');
  assert.match(written, /My final answer\./, 'what was typed is in there');
  assert.match(written, /Line two of my work\./);

  // docx + pdf produce valid files (zip / %PDF signatures)
  const rdocx = await post('/api/download', { kind: 'assignment', id: a.id, filename: 'My Essay', format: 'docx' });
  assert.equal(fs.readFileSync(rdocx.saved_to).slice(0, 2).toString(), 'PK', 'docx is a zip');
  const rpdf = await post('/api/download', { kind: 'assignment', id: a.id, filename: 'My Essay', format: 'pdf' });
  assert.equal(fs.readFileSync(rpdf.saved_to).slice(0, 5).toString(), '%PDF-', 'pdf header');

  // Re-download same name/type gets a numbered name, not a clobber.
  const rtxt2 = await post('/api/download', { kind: 'assignment', id: a.id, filename: 'My Essay', format: 'txt' });
  assert.notEqual(rtxt2.filename, rtxt.filename);
});

test('officegen: pptx/docx are readable zips, pdf is valid', () => {
  const og = require('../src/officegen');
  const pptx = og.buildFile('slides', 'pptx', { slides: [{ title: 'T', bullets: ['a', 'b'] }], title: 'D', subtitle: 'Class' }).bytes;
  assert.equal(pptx.slice(0, 2).toString(), 'PK');
  assert.ok(pptx.includes(Buffer.from('ppt/presentation.xml')), 'has presentation part');
  const docx = og.buildFile('text', 'docx', 'hi\nthere').bytes;
  assert.equal(docx.slice(0, 2).toString(), 'PK');
  const pdf = og.buildFile('text', 'pdf', 'hello').bytes;
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.slice(-6).toString().includes('EOF'));
});

// Pull one part back out of an OOXML zip so tests can read the actual XML
// (makeZip deflates every entry, so scanning raw bytes only finds filenames).
function unzipEntry(buf, name) {
  const zlib = require('node:zlib');
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const entryName = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    if (entryName === name) return zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize)).toString('utf8');
    i = dataStart + compSize;
  }
  return null;
}

test('pptx: slide 1 is the title slide, no pictures, picture space on request', () => {
  const og = require('../src/officegen');
  const slides = [
    { title: 'The U.S. Constitution', bullets: ['U.S. History'] },
    { title: 'What It Says', bullets: ['Seven articles', 'The Bill of Rights'] },
    { title: 'Why It Lasted', bullets: ['Amendable by design'], photo: true },
  ];
  const bytes = og.buildPptx(slides, { title: 'ignored fallback', subtitle: 'ignored too' });
  assert.equal(bytes.slice(0, 2).toString(), 'PK');

  // Exactly three slides — what's in the builder is what comes out. No extra
  // generated title slide, no credits slide.
  assert.ok(bytes.includes(Buffer.from('ppt/slides/slide3.xml')), 'three slides');
  assert.ok(!bytes.includes(Buffer.from('ppt/slides/slide4.xml')), 'no bonus slides');
  assert.ok(!bytes.includes(Buffer.from('ppt/media/')), 'no embedded media');

  const s1 = unzipEntry(bytes, 'ppt/slides/slide1.xml');
  const s2 = unzipEntry(bytes, 'ppt/slides/slide2.xml');
  const s3 = unzipEntry(bytes, 'ppt/slides/slide3.xml');
  const types = unzipEntry(bytes, '[Content_Types].xml');

  // Slide 1 is the title slide, using the student's own title and subtitle.
  assert.ok(s1.includes('The U.S. Constitution'), 'title slide shows the builder title');
  assert.ok(s1.includes('U.S. History'), 'and its subtitle');
  assert.ok(!s1.includes('ignored fallback'), 'the builder title beats the opts fallback');
  assert.ok(!s1.includes('Picture space'), 'no picture frame on the title slide');

  // Slate branding + the card layout.
  assert.ok(s2.includes('8CA891') && s2.includes('14181D') && s2.includes('1F252C'), 'Slate colours');
  assert.ok(s2.includes('Seven articles') && s2.includes('The Bill of Rights'));
  assert.ok(s2.includes('name="Point 1"') && s2.includes('name="Tab 1"'), 'bullets become accent-tabbed cards');
  assert.ok(s2.includes('2 / 3'), 'slide numbering');

  // Picture space only where it was asked for.
  assert.ok(!s2.includes('Picture space'), 'no space reserved unless toggled on');
  assert.ok(s3.includes('Picture space') && s3.includes('Picture goes here'), 'space reserved where toggled on');

  // No image plumbing left in the package at all.
  assert.ok(!types.includes('image/jpeg') && !types.includes('image/png'), 'no image content types');

  // An empty builder still produces a usable title slide.
  assert.ok(unzipEntry(og.buildPptx([], { title: 'Just a Title' }), 'ppt/slides/slide1.xml').includes('Just a Title'));
});

test('slideshow project: detected, builder seeded, saves + downloads pptx', async () => {
  const projects = await get('/api/projects');
  // The mock "Founding Document Analysis" says make a slideshow.
  const slideProj = (await Promise.all(projects.map((p) => get('/api/projects/' + p.id))))
    .find((p) => p.build_mode === 'slides');
  assert.ok(slideProj, 'a project was detected as a slideshow');
  // Seeded with a pre-filled title slide + one blank content slide — NOT
  // step-derived titles like "Build 6-8 slides" (those belong in instructions).
  assert.equal(slideProj.slides.length, 2, 'title slide + one blank content slide');
  assert.equal(slideProj.slides[0].title, slideProj.title, 'title slide is pre-filled with the assignment name');
  assert.equal(slideProj.slides[0].bullets[0], slideProj.class_name, 'class name as the subtitle');
  assert.ok(!slideProj.slides.some((s) => /slides?\b/i.test(s.title) && /\d/.test(s.title)), 'no "make N slides" slide title');

  const mySlides = [
    { title: 'My Presentation', bullets: ['U.S. History'] },
    { title: 'Introduction', bullets: ['What the document is', 'Why it matters'] },
    { title: 'Impact', bullets: ['Lasting effects'], photo: true },
  ];
  const saved = await post(`/api/projects/${slideProj.id}/slides`, { slides: mySlides });
  assert.equal(saved.count, 3);
  const reload = await get('/api/projects/' + slideProj.id);
  assert.equal(reload.slides[0].title, 'My Presentation');
  assert.equal(reload.slides[2].photo, true, 'the picture-space toggle is saved');
  assert.equal(reload.slides[1].photo, false);

  const opts = await get(`/api/download-options?kind=project&id=${slideProj.id}`);
  assert.deepEqual(opts.formats.map((f) => f.ext), ['pptx', 'html', 'txt']);

  const r = await post('/api/download', { kind: 'project', id: slideProj.id, filename: 'My Slides', format: 'pptx' });
  assert.equal(r.ok, true);
  assert.match(r.filename, /\.pptx$/);
  assert.equal(fs.readFileSync(r.saved_to).slice(0, 2).toString(), 'PK');

  const rhtml = await post('/api/download', { kind: 'project', id: slideProj.id, filename: 'My Slides', format: 'html' });
  assert.match(fs.readFileSync(rhtml.saved_to, 'utf8'), /Introduction/);
});

test('focus time logging accumulates', async () => {
  const due = (await get('/api/today')).assignments;
  const id = due[0].id;
  const t1 = await post(`/api/assignments/${id}/time`, { seconds: 120 });
  const t2 = await post(`/api/assignments/${id}/time`, { seconds: 60 });
  assert.equal(t2.time_logged, t1.time_logged + 60, 'seconds add up');
  assert.ok(t2.time_logged >= 180);
});

test('mark complete removes from today; reopen restores', async () => {
  const before_ = (await get('/api/today')).assignments;
  const id = before_[0].id;
  await post(`/api/assignments/${id}/complete`);
  const mid = (await get('/api/today')).assignments;
  assert.ok(!mid.find((a) => a.id === id));
  await post(`/api/assignments/${id}/reopen`);
  const after_ = (await get('/api/today')).assignments;
  assert.ok(after_.find((a) => a.id === id));
});

test('week: a project shows on the day it is due and no other', async () => {
  const days = await get('/api/week');
  assert.equal(days.length, 7);
  assert.ok(days[0].is_today);
  assert.ok(days.flatMap((d) => d.tests).length >= 2, 'tests visible in week');

  // It used to appear on every day it had a piece of work scheduled, which put
  // the same project on five days running.
  const shown = days.flatMap((d) => d.projects.map((p) => ({ ...p, day: d.day })));
  assert.ok(shown.length >= 1, 'at least one project falls inside the week');
  for (const p of shown) {
    const detail = await get('/api/projects/' + p.id);
    assert.equal(detail.due_date, p.day, `${p.title} sits on its due date`);
  }
  const byId = shown.map((p) => p.id);
  assert.equal(new Set(byId).size, byId.length, 'and appears exactly once');

  // Everything the week lists carries an id, so the day popup can open it.
  for (const d of days) {
    for (const it of [...d.assignments, ...d.projects, ...d.tests, ...d.done_assignments, ...d.done_projects]) {
      assert.ok(it.id, 'every week item has an id to open');
    }
  }
});

test('projects carry no plan: no chunks, no pieces, no progress fraction', async () => {
  // Will asked for the plan gone. It has to be gone from the API too, not just
  // hidden on the page — anything still shipping chunks would grow a UI again.
  const projects = await get('/api/projects');
  assert.ok(projects.length >= 2);
  for (const p of projects) {
    assert.ok(p.title && p.due_date, 'a project still says what it is and when');
    assert.equal(p.progress, undefined, 'no progress fraction');
    assert.equal(p.todays_chunk, undefined, "no today's chunk");
    assert.equal(p.all_done, undefined, 'no all-chunks-done flag');
  }

  const p = await get('/api/projects/' + projects[0].id);
  assert.equal(p.chunks, undefined, 'the project page gets no chunk list');
  assert.equal(p.current_chunk, undefined, 'and no next piece');
  assert.equal(p.progress, undefined);
  assert.equal(p.all_done, undefined);
  // The things that actually matter about a project all survived.
  assert.ok(p.title && p.class_name && p.build_mode);
  assert.ok(Array.isArray(p.files), 'attachments still come through');
});

test('study guides: every test gets cards, even when it is called a "list"', async () => {
  const tests = await get('/api/tests');
  for (const t of tests) {
    assert.ok(t.study_guide_url, `${t.name} found a study guide`);
    assert.ok(t.card_count > 0, `${t.name} has flashcards (got ${t.card_count})`);
  }
  // The English quiz's material is posted as "Vocabulary Set 4 List" — no
  // "study guide" or "review" in the title — and it still has to be found.
  const vocab = tests.find((t) => /Vocabulary/i.test(t.name));
  assert.ok(vocab && vocab.card_count >= 4, 'a vocab list counts as study material');
  const detail = await get('/api/tests/' + vocab.id);
  assert.ok(detail.due_cards.some((c) => c.front && c.back.length > 5), 'and makes real term/definition cards');
});

test('tests: study time counts toward mastery; flashcard review updates', async () => {
  const tests = await get('/api/tests');
  const withCards = tests.find((t) => t.card_count > 0);
  assert.ok(withCards, 'a test has flashcards');
  const detail = await get('/api/tests/' + withCards.id);
  assert.ok(detail.due_cards.length > 0, 'cards due for review');

  const st = await post(`/api/tests/${withCards.id}/time`, { seconds: 900 });
  assert.ok(st.time_logged >= 900);

  const before_ = detail.mastery;
  const rv = await post(`/api/flashcards/${detail.due_cards[0].id}/review`, { remembered: true });
  assert.ok(rv.mastery >= before_, 'mastery did not go down after a good review');
});

test('classes, grades, gpa', async () => {
  const classes = await get('/api/classes');
  assert.equal(classes.length, 5);
  const detail = await get('/api/classes/' + classes[0].id);
  assert.ok(detail.grades.length >= 1, 'graded work listed');
  const g = await get('/api/gpa');
  assert.ok(g.gpa > 0 && g.gpa <= 4.0);
});

test('emails render cleanly', async () => {
  const emails = await get('/api/emails');
  assert.ok(emails.length >= 3);
  assert.ok(emails[0].subject && emails[0].body);
});

test('notes drop: file becomes flashcards + notes; study goal is 2h/30m', async () => {
  const tests = await get('/api/tests');
  const t = tests[0];

  // goals: tests 120 min, quizzes 30 min
  for (const x of tests) assert.equal(x.time_budget_minutes, x.type === 'quiz' ? 30 : 120);

  const before = await get('/api/tests/' + t.id);
  const notesText = [
    'photosynthesis - how plants turn sunlight into energy',
    'mitosis - how one cell divides into two identical cells',
    'The powerhouse of the cell is the mitochondria',
  ].join('\n');
  const up = await post(`/api/tests/${t.id}/notes`, {
    filename: 'my notes.txt',
    content_base64: Buffer.from(notesText, 'utf8').toString('base64'),
  });
  assert.equal(up.ok, true);

  // Poll until background processing finishes.
  let detail;
  for (let i = 0; i < 40; i++) {
    detail = await get('/api/tests/' + t.id);
    if (detail.notes_status === 'done' || detail.notes_status === 'error') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(detail.notes_status, 'done');
  assert.ok(detail.total_cards > before.total_cards, 'new flashcards were added');
  assert.ok(detail.notes.includes('my notes.txt'), 'notes recorded with file header');

  // Unreadable (binary) file lands in error state, not a crash.
  const bin = Buffer.from([0, 1, 2, 0, 255, 0, 4, 0]).toString('base64');
  await post(`/api/tests/${t.id}/notes`, { filename: 'junk.bin', content_base64: bin });
  let after;
  for (let i = 0; i < 40; i++) {
    after = await get('/api/tests/' + t.id);
    if (after.notes_status !== 'processing') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(after.notes_status, 'error');
  assert.ok(after.notes.includes('my notes.txt'), 'earlier good notes survive a bad drop');
});

test('outline: slide count is read from instructions; auto-fill honors it', async () => {
  const { slideCountFromText } = require('../src/outline');
  assert.equal(slideCountFromText('Build 6-8 slides for this'), 7);
  assert.equal(slideCountFromText('make exactly 5 slides'), 5);
  assert.equal(slideCountFromText('write an essay'), null);

  const projects = await get('/api/projects');
  const slideProj = (await Promise.all(projects.map((p) => get('/api/projects/' + p.id))))
    .find((p) => p.build_mode === 'slides');
  assert.ok(slideProj);
  // The Founding project says "Build 6-8 slides" -> fallback makes 7 slides.
  const r = await post(`/api/projects/${slideProj.id}/outline`, {});
  assert.equal(r.ok, true);
  assert.equal(r.slides.length, 7, 'honors the 6-8 range (midpoint 7)');
  assert.ok(r.slides[0].title, 'first slide has a title header');

  const reload = await get('/api/projects/' + slideProj.id);
  assert.equal(reload.has_custom_slides, true, 'outline is saved as the slides');
  assert.equal(reload.slides.length, 7);
});

test('simplify: chatter around the answer never reaches the student', () => {
  const { parseSteps } = require('../src/simplify');
  // The hidden claude runs in the project folder, reads CLAUDE.md, and greets.
  assert.equal(
    parseSteps('hey will\n\n{"steps":["Read Chapter 3","Write one paragraph"]}'),
    'Read Chapter 3\nWrite one paragraph',
    'a greeting before the JSON is discarded'
  );
  assert.equal(
    parseSteps('```json\n{"steps":["Do the thing"]}\n```\nHope that helps!'),
    'Do the thing',
    'code fences and sign-offs are discarded'
  );
  assert.equal(parseSteps('{"steps":["- 1. Do it  "]}'), 'Do it', 'stray bullets/numbers are stripped');
  // No JSON at all: keep the instruction lines, drop the greeting.
  assert.equal(
    parseSteps('hey will\nRead the chapter\nAnswer the questions'),
    'Read the chapter\nAnswer the questions'
  );
  assert.equal(parseSteps(''), '');
  assert.ok(!parseSteps('hey will\n{"steps":["Read it"]}').includes('hey will'));
});

test('instructions: detail has a plain summary; simplify caches a version', async () => {
  const due = (await get('/api/today')).assignments;
  const a = due[0];
  const detail = await get('/api/assignments/' + a.id);
  assert.ok(typeof detail.instructions_plain === 'string' && detail.instructions_plain.length > 0, 'has a plain fallback');
  assert.equal(detail.instructions_ai, null, 'not simplified yet');

  const r = await post(`/api/assignments/${a.id}/simplify`, {});
  assert.ok(r.instructions && r.instructions.length > 0, 'returns simplified instructions');

  const detail2 = await get('/api/assignments/' + a.id);
  assert.equal(detail2.instructions_ai, r.instructions, 'cached on the assignment');
});

test('essay project: gets the editor, draft saves, writing formats offered', async () => {
  const projects = await get('/api/projects');
  const details = await Promise.all(projects.map((p) => get('/api/projects/' + p.id)));
  const essay = details.find((p) => /American Dream/i.test(p.title));
  assert.ok(essay, 'the American Dream Essay project exists');
  assert.equal(essay.build_mode, 'essay', 'detected as an essay, not a slideshow');
  assert.equal(essay.essay_target.paragraphs, 5, '"5-paragraph" read out of the instructions');

  const draft = 'The American Dream is still alive, but it costs more than it used to.\n\nCollege is the first place you see it.';
  await post(`/api/assignments/${essay.id}/draft`, { text: draft });
  const reload = await get('/api/projects/' + essay.id);
  assert.equal(reload.draft_text, draft, 'the draft comes back on the project page');

  const opts = await get(`/api/download-options?kind=project&id=${essay.id}`);
  assert.deepEqual(opts.formats.map((f) => f.ext), ['docx', 'pdf', 'txt'], 'essays save as MLA writing files');
  const saved = await post('/api/download', { kind: 'project', id: essay.id, filename: 'American Dream', format: 'docx' });
  assert.equal(fs.readFileSync(saved.saved_to).slice(0, 2).toString(), 'PK');
});

test('get unstuck: reads word/paragraph goals and coaches without writing prose', () => {
  const { targetsFromText, paragraphsOf, ruleBasedGuidance, parseGuidance } = require('../src/unstuck');
  assert.equal(targetsFromText('Write a 5-paragraph argumentative essay').paragraphs, 5);
  assert.equal(targetsFromText('Three paragraphs minimum').paragraphs, 3);
  assert.equal(targetsFromText('750-1000 words please').words, 875);
  assert.equal(targetsFromText('at least 500 words').words, 500);
  const none = targetsFromText('Build a model of a cell');
  assert.equal(none.words, null);
  assert.equal(none.paragraphs, null);
  assert.equal(paragraphsOf('one\n\ntwo\n\nthree').length, 3);
  assert.equal(parseGuidance('not json at all'), null);

  // Offline coaching gives direction, never a sentence for the essay.
  const g = ruleBasedGuidance({ draft: 'A claim I made.\n\nA reason for it.', stuckNote: 'paragraph 3', target: { paragraphs: 5, words: 700 } });
  assert.ok(g.where_you_are.includes('2 paragraphs'));
  assert.ok(g.next && g.question);
  for (const p of g.points) assert.ok(p.length < 60, `"${p}" is a short note, not essay prose`);
});

test('essay outline: paragraphs are split and named (intro / body / conclusion)', () => {
  // Pull the real helpers out of the browser file and exercise them here.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const grab = (name) => {
    const i = src.indexOf('function ' + name + '(');
    assert.ok(i !== -1, `${name} exists in app.js`);
    const j = src.indexOf('\nfunction ', i + 1);
    return src.slice(i, j === -1 ? src.length : j);
  };
  const out = {};
  new Function('out', grab('essayBlocks') + grab('essayRoles') +
    'out.essayBlocks = essayBlocks; out.essayRoles = essayRoles;')(out);
  const { essayBlocks, essayRoles } = out;

  const five = essayBlocks('Intro and thesis.\n\nFirst reason.\n\nSecond reason.\n\nThird reason.\n\nSo that is why.');
  assert.equal(five.length, 5);
  assert.deepEqual(essayRoles(five, 5), ['Intro & thesis', 'Body 1', 'Body 2', 'Body 3', 'Conclusion']);

  // Mid-draft, the paragraph you're working on is a body paragraph, not the end.
  const two = essayBlocks('Intro and thesis.\n\nFirst reason.');
  assert.deepEqual(essayRoles(two, 5), ['Intro & thesis', 'Body 1']);

  // A wrap-up phrase names itself even before the essay is full length.
  const early = essayBlocks('Intro.\n\nA reason.\n\nIn conclusion, that is the point.');
  assert.equal(essayRoles(early, 5)[2], 'Conclusion');

  // A works cited page is not a body paragraph, and it doesn't count toward
  // "is the essay long enough yet" either.
  const cited = essayBlocks('Intro.\n\nOne.\n\nTwo.\n\nThree.\n\nWrapping up here.\n\nWorks Cited\nSmith, John.');
  const roles = essayRoles(cited, 5);
  assert.equal(roles[roles.length - 1], 'Works cited');
  assert.equal(roles[4], 'Conclusion', 'the last real paragraph is still the conclusion');

  // One paragraph short of the target: the last one is still a body paragraph,
  // and the citations must not pad the count to make it look finished.
  const short = essayBlocks('Intro.\n\nOne.\n\nTwo.\n\nNot done yet.\n\nWorks Cited\nSmith, John.');
  assert.equal(essayRoles(short, 5)[3], 'Body 3', 'citations do not count as a paragraph');

  // Citations usually sit in their own block under a blank line — everything
  // after the heading is still citations, and the conclusion keeps its name.
  const split = essayBlocks('Intro.\n\nOne.\n\nTwo.\n\nThree.\n\nThe wrap up.\n\nWorks Cited\n\nMarsh, E. A Book. Press, 2021.\nOkafor, D. Another. Press, 2022.');
  const splitRoles = essayRoles(split, 5);
  assert.deepEqual(splitRoles, ['Intro & thesis', 'Body 1', 'Body 2', 'Body 3', 'Conclusion', 'Works cited', 'Works cited']);
});

test('pacing: work is spread evenly by how big each step actually is', () => {
  const { planChunks, stepWeight } = require('../src/pacing');

  // Bigger steps weigh more, finishing touches weigh less.
  assert.ok(stepWeight('Three body paragraphs, each with evidence') > stepWeight('Thesis with a clear claim'));
  assert.ok(stepWeight('Thesis with a clear claim') > stepWeight('Works Cited page'));
  assert.ok(stepWeight('Build 6-8 slides') > stepWeight('Pick a topic'));

  const steps = ['Thesis with a clear claim', 'Three body paragraphs, each with evidence', 'Works Cited page'];
  const plan = planChunks(steps, '2026-07-31', '2026-07-22');
  assert.equal(plan.length, 9, 'one piece per work day, finishing the day before it is due');
  const days = plan.map((c) => c.day);
  assert.equal(new Set(days).size, days.length, 'no day gets two pieces');
  assert.deepEqual(days, [...days].sort(), 'in date order');
  assert.equal(days[0], '2026-07-22', 'starts today');
  assert.equal(days[days.length - 1], '2026-07-30', 'done the day before it is due');

  const daysFor = (s) => plan.filter((c) => c.chunk_description.includes(s)).length;
  assert.ok(daysFor('Three body paragraphs') >= 4, 'the big step gets most of the days');
  assert.equal(daysFor('Works Cited page'), 1, 'a works cited page is a one-day job');
  assert.ok(daysFor('Thesis') >= 1 && daysFor('Thesis') < daysFor('Three body paragraphs'));

  // Multi-day steps read as start / keep going / finish.
  const big = plan.filter((c) => c.chunk_description.includes('Three body paragraphs'));
  assert.match(big[0].chunk_description, /^Start: .* \(day 1 of \d\)$/);
  assert.match(big[big.length - 1].chunk_description, /^Finish: .* \(day \d of \d\)$/);

  // More steps than days: each day gets an even handful instead.
  const packed = planChunks(['a', 'b', 'c', 'd', 'e', 'f', 'g'], '2026-07-25', '2026-07-22');
  assert.equal(packed.length, 3, 'three work days');
  assert.deepEqual(packed.map((c) => c.chunk_description.split('\n').length), [2, 2, 3]);
  assert.equal(packed.flatMap((c) => c.chunk_description.split('\n')).length, 7, 'nothing dropped');

  // Due tomorrow: it all has to happen today.
  assert.equal(planChunks(['x', 'y'], '2026-07-23', '2026-07-22').length, 1);
  assert.equal(planChunks([], '2026-08-01', '2026-07-22').length, 0);
});

test('essay percent: counted in sentences against what the assignment wants', () => {
  const { countSentences, sentenceTarget, targetsFromText } = require('../src/unstuck');
  assert.equal(countSentences('One. Two! Three?'), 3);
  assert.equal(countSentences('Dr. Smith went to the U.S. in 1999. It cost 3.14 dollars.'), 2, 'abbreviations are not sentence ends');
  assert.equal(countSentences(''), 0);
  assert.equal(countSentences('No punctuation yet'), 1, 'a started sentence counts');

  assert.equal(sentenceTarget(null, 5), 30, 'five paragraphs ~ 30 sentences');
  assert.equal(sentenceTarget(900, null), 50, '900 words ~ 50 sentences');
  assert.equal(sentenceTarget(null, null), 30, 'defaults to a five-paragraph essay');
  assert.equal(targetsFromText('Write a 5-paragraph argumentative essay').sentences, 30);
});

test('essay page: percent done comes from what is written', async () => {
  const projects = await get('/api/projects');
  const details = await Promise.all(projects.map((p) => get('/api/projects/' + p.id)));
  const essay = details.find((p) => /American Dream/i.test(p.title));

  await post(`/api/assignments/${essay.id}/draft`, { text: 'One sentence. Two sentences. Three sentences.' });
  const p = await get('/api/projects/' + essay.id);
  assert.equal(p.essay_done_pct.written, 3);
  assert.equal(p.essay_done_pct.target, 30, 'the 5-paragraph assignment wants ~30 sentences');
  assert.equal(p.essay_done_pct.pct, 10);

  // Works Cited entries are citations, not essay sentences — they must not
  // inflate the percent (three entries would otherwise read as ~9 sentences).
  await post(`/api/assignments/${essay.id}/draft`, {
    text: 'One sentence. Two sentences. Three sentences.\n\nWorks Cited\n\nMarsh, E. A Book. Press, 2021.\nOkafor, D. Another Book. Press, 2022.\nWhitfield, R. A Third. Press, 2020.',
  });
  const withCites = await get('/api/projects/' + essay.id);
  assert.equal(withCites.essay_done_pct.written, 3, 'citations do not count toward progress');

  // An essay's progress is how much of it is written. There is no plan behind
  // it any more, so nothing on the page counts ticked boxes.
  assert.equal(p.chunks, undefined, 'no chunk list on an essay project either');
  assert.equal(p.progress, undefined);
});

test('mla: splits the draft, formats the heading, flags what is missing', () => {
  const { buildEssay, toText, checkEssay, splitDraft, mlaDate, lastNameOf } = require('../src/mla');
  assert.equal(mlaDate('2026-07-22'), '22 July 2026');
  assert.equal(lastNameOf('Will Caldwell'), 'Caldwell');

  const draft = 'My thesis is here.\n\nFirst body paragraph\nwrapped onto two lines.\n\nWorks Cited\nSmith, John. A Book. Press, 2020.\nDoe, Jane. Another Book. Press, 2021.';
  const s = splitDraft(draft);
  assert.equal(s.body.length, 2, 'two body paragraphs');
  assert.equal(s.body[1], 'First body paragraph wrapped onto two lines.', 'soft line breaks are joined');
  assert.equal(s.cited.length, 2, 'both sources land in works cited');

  const doc = buildEssay({ draft, title: 'American Dream Essay', student: 'Will Caldwell', teacher: 'Mr. Ortiz', className: 'English 11', date: '2026-07-31' });
  const text = toText(doc);
  assert.match(text, /^Will Caldwell\nMr\. Ortiz\nEnglish 11\n31 July 2026/, 'MLA heading block in order');
  assert.match(text, /Works Cited/);
  assert.equal(doc.paragraphs.length, 2);

  const checks = checkEssay(doc, { targetParagraphs: 5, needsSources: true });
  const paraCheck = checks.find((c) => /of 5 paragraphs/.test(c.label));
  assert.equal(paraCheck.ok, false, '2 of 5 paragraphs is not done yet');
  assert.equal(checks.find((c) => /Works Cited page/.test(c.label)).ok, true);

  // No name yet -> it asks for one instead of silently writing a placeholder.
  const bare = buildEssay({ draft: 'One paragraph.', title: 'T' });
  assert.equal(checkEssay(bare, {})[0].ok, false);
});

test('mla files: real docx with styles + header, real pdf, plain text', () => {
  const og = require('../src/officegen');
  const { buildEssay } = require('../src/mla');
  const doc = buildEssay({
    draft: 'Opening paragraph with the thesis.\n\nSecond paragraph.\n\nWorks Cited\nSmith, John. A Book. Press, 2020.',
    title: 'Is the American Dream Achievable?', student: 'Will Caldwell', teacher: 'Mr. Ortiz',
    className: 'English 11', date: '2026-07-31',
  });
  const docx = og.buildFile('mla', 'docx', doc).bytes;
  assert.equal(docx.slice(0, 2).toString(), 'PK', 'docx is a zip');
  assert.ok(docx.includes(Buffer.from('word/styles.xml')), 'has a styles part (Times New Roman)');
  assert.ok(docx.includes(Buffer.from('word/header1.xml')), 'has the running header part');
  assert.ok(docx.includes(Buffer.from('word/_rels/document.xml.rels')), 'header/styles are related in');

  const pdf = og.buildFile('mla', 'pdf', doc).bytes;
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.includes(Buffer.from('Times-Roman')), 'MLA pdf uses Times');
  assert.ok(pdf.slice(-6).toString().includes('EOF'));

  const txt = og.buildFile('mla', 'txt', doc).bytes.toString('utf8');
  assert.match(txt, /Will Caldwell/);
  assert.deepEqual(og.formatsFor('mla').map((f) => f.ext), ['docx', 'pdf', 'txt']);
});

test('essay hand-in: review assembles it, names stick, file lands on the desktop', async () => {
  const projects = await get('/api/projects');
  const details = await Promise.all(projects.map((p) => get('/api/projects/' + p.id)));
  const essay = details.find((p) => /American Dream/i.test(p.title));

  const draft = 'The American Dream still gets repeated as a promise, but the numbers do not back it up anymore.\n\nCollege is where the gap shows up first, because tuition has outrun wages for forty years.\n\nWorks Cited\nSmith, John. The Cost of College. Press, 2020.';
  await post(`/api/assignments/${essay.id}/draft`, { text: draft });

  const bare = await get(`/api/projects/${essay.id}/review`);
  assert.equal(bare.title, '', 'the essay has no title until the student gives it one');
  assert.ok(bare.checks.some((c) => /Give it a title/.test(c.label)));

  const named = await post(`/api/projects/${essay.id}/review`, {
    student_name: 'Will Caldwell', teacher_name: 'Mr. Ortiz', title: 'The Ladder Starts Higher Now',
  });
  assert.equal(named.student_name, 'Will Caldwell');
  assert.equal(named.title, 'The Ladder Starts Higher Now', 'the student names their own essay');
  assert.match(named.preview, /The Ladder Starts Higher Now/);
  assert.equal(named.paragraph_count, 2, 'works cited is not counted as a paragraph');
  assert.equal(named.works_cited.length, 1);
  assert.match(named.preview, /Will Caldwell\nMr\. Ortiz/);
  assert.ok(named.checks.some((c) => !c.ok), '2 of 5 paragraphs is still flagged');

  // Names are remembered without re-sending them.
  const again = await get(`/api/projects/${essay.id}/review`);
  assert.equal(again.teacher_name, 'Mr. Ortiz');
  assert.ok(again.history.versions >= 1, 'saving the draft recorded a version');

  const opts = await get(`/api/download-options?kind=essay&id=${essay.id}`);
  assert.deepEqual(opts.formats.map((f) => f.ext), ['docx', 'pdf', 'txt']);
  assert.equal(opts.empty, false);
  const saved = await post('/api/download', { kind: 'essay', id: essay.id, filename: 'American Dream Essay', format: 'docx' });
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(saved.saved_to).slice(0, 2).toString(), 'PK');
});

test('drafts survive marking a project chunk done', async () => {
  const projects = await get('/api/projects');
  const details = await Promise.all(projects.map((p) => get('/api/projects/' + p.id)));
  const essay = details.find((p) => /American Dream/i.test(p.title));

  const text = 'Words I do not want to lose when I click the chunk button.';
  await post(`/api/assignments/${essay.id}/draft`, { text });
  const fresh = await get('/api/projects/' + essay.id);
  if (fresh.current_chunk) {
    await post(`/api/chunks/${fresh.current_chunk.id}/done`, { done: true });
  }
  const after = await get('/api/projects/' + essay.id);
  assert.equal(after.draft_text, text, 'finishing a chunk never touches the draft');
});

test('get unstuck endpoint: needs words first, then returns guidance', async () => {
  const projects = await get('/api/projects');
  const details = await Promise.all(projects.map((p) => get('/api/projects/' + p.id)));
  const essay = details.find((p) => /American Dream/i.test(p.title));

  await post(`/api/assignments/${essay.id}/draft`, { text: '' });
  const empty = await post(`/api/projects/${essay.id}/unstuck`, {});
  assert.equal(empty.ok, false, 'an empty draft never calls Claude');

  const r = await post(`/api/projects/${essay.id}/unstuck`, {
    draft: 'The American Dream is still real, but it is harder to reach than it was in 1925.',
    stuck_note: 'paragraph 2 of 2, the first body paragraph',
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'offline', 'SLATE_NO_AI=1 in tests, so the built-in coach answers');
  assert.ok(r.where_you_are && r.next && r.question, 'gives direction on the stuck section');
  assert.ok(Array.isArray(r.points) && r.points.length >= 3);

  // The draft that was sent is what got saved.
  const back = await get('/api/projects/' + essay.id);
  assert.match(back.draft_text, /harder to reach/);
});

test('sync is idempotent: running twice does not duplicate', async () => {
  const c1 = (await get('/api/classes')).length;
  await post('/api/sync');
  const c2 = (await get('/api/classes')).length;
  assert.equal(c1, c2);
});

test('passwords are salted, hashed, and never stored in the clear', () => {
  const users = require('../src/users');
  const stored = users.hashPassword('hunter22');
  assert.ok(!stored.includes('hunter22'), 'the password itself is nowhere in the stored value');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/, 'scrypt$salt$hash');
  assert.notEqual(users.hashPassword('hunter22'), stored, 'a fresh salt every time');
  assert.equal(users.checkPassword('hunter22', stored), true);
  assert.equal(users.checkPassword('hunter23', stored), false);
  assert.equal(users.checkPassword('', stored), false);
  assert.equal(users.checkPassword('hunter22', null), false, 'an account with no password lets nobody in');
  assert.equal(users.checkPassword('hunter22', 'garbage'), false);
});

test('devices are named in a way Will can recognise', () => {
  const { describeDevice } = require('../src/users');
  const ua = (s) => describeDevice(s);
  // Edge and Chrome both claim to be Safari, and Edge also claims Chrome, so
  // the order these are matched in is the whole test.
  assert.equal(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Edg/120'), 'Edge on Windows');
  assert.equal(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'), 'Chrome on Windows');
  assert.equal(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile Safari/604.1'), 'Safari on iPhone');
  assert.equal(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/121.0'), 'Firefox on Mac');
  assert.equal(ua(''), 'Unknown device');
});

test('flashcard replies are validated as data, never trusted as prose', () => {
  const { parseCards } = require('../src/classNotes');

  // The happy path, including the chatter Claude Code adds when it has read
  // CLAUDE.md — the reason every AI feature here parses JSON (round 18).
  const good = parseCards('hey will, here you go:\n```json\n{"flashcards":['
    + '{"front":"What is mitosis?","back":"Cell division making two identical cells","topic":"Cells"},'
    + '{"front":"Phases of mitosis?","back":"Prophase, metaphase, anaphase, telophase"}'
    + ']}\n```\nHope that helps!');
  assert.equal(good.length, 2);
  assert.equal(good[0].front, 'What is mitosis?');
  assert.equal(good[0].topic, 'Cells');
  assert.equal(good[1].topic, '', 'topic is optional');

  // Anything that isn't a usable pair is dropped rather than guessed at.
  const messy = parseCards(JSON.stringify({ flashcards: [
    { front: 'Keep me', back: 'ok' },
    { front: '', back: 'no front' },
    { front: 'no back', back: '   ' },
    { front: 'Keep me', back: 'a duplicate front' },
    'not an object',
    null,
  ] }));
  assert.equal(messy.length, 1);
  assert.equal(messy[0].front, 'Keep me');

  // A bare array is accepted too — models drop the wrapper often enough.
  assert.equal(parseCards('[{"front":"a","back":"b"}]').length, 1);

  // Never let a runaway reply flood a test with cards.
  const many = parseCards(JSON.stringify({
    flashcards: Array.from({ length: 90 }, (_, i) => ({ front: 'q' + i, back: 'a' + i })),
  }));
  assert.equal(many.length, 40);

  for (const bad of ['', 'no json here at all', '{"flashcards":"nope"}', '{"flashcards":[]}', '{"other":1}']) {
    assert.throws(() => parseCards(bad), undefined, `should have rejected: ${bad}`);
  }
});

test('a typed-up photo is read as structured data too', () => {
  const { parseRead } = require('../src/classNotes');
  const r = parseRead('Sure! {"title":"Cell Division","text":"Mitosis has four phases."} done');
  assert.equal(r.title, 'Cell Division');
  assert.equal(r.text, 'Mitosis has four phases.');
  // No title is survivable — the first line becomes one.
  assert.equal(parseRead('{"text":"Photosynthesis basics\\nmore"}').title, 'Photosynthesis basics');

  // Typed-up notes are multi-line, and a model asked for multi-line text inside
  // JSON will sometimes emit a REAL newline instead of \n — which is invalid
  // JSON and would fail every normal transcription. It gets repaired.
  const raw = parseRead('{"title":"Cells","text":"Line one\nLine two\n\tindented"}');
  assert.equal(raw.text, 'Line one\nLine two\n\tindented');

  // No text at all is not survivable: there is nothing to save.
  assert.throws(() => parseRead('{"title":"Empty","text":"   "}'));
  assert.throws(() => parseRead('I could not read that image.'));
});

test('time worked today starts again from zero each day', () => {
  // Own process with its own throwaway DB: this pokes rows straight into
  // time_log with specific days, which the running test server can't do.
  const { execFileSync } = require('node:child_process');
  const dbFile = path.join(TMP, 'timelog.db');
  const script = `
    const api = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'api.js'))});
    const { getDb } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db.js'))});
    const { todayYmd, addDaysYmd } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'dates.js'))});
    const today = todayYmd();
    const yesterday = addDaysYmd(today, -1);
    const put = (day, secs) => getDb()
      .prepare('INSERT INTO time_log (day, kind, ref_id, seconds, logged_at) VALUES (?,?,?,?,?)')
      .run(day, 'test', 1, secs, day + 'T12:00:00.000Z');

    const out = {};
    out.emptyDay = api.workedToday().seconds;
    put(yesterday, 3600);
    put(yesterday, 1800);
    out.afterYesterdayOnly = api.workedToday().seconds;
    put(today, 900);
    put(today, 300);
    out.afterToday = api.workedToday().seconds;
    out.yesterdayTotal = api.secondsWorkedOn(yesterday);
    out.tomorrow = api.secondsWorkedOn(addDaysYmd(today, 1));
    out.perTest = api.secondsWorkedOn(today, { kind: 'test', refId: 1 });
    out.otherTest = api.secondsWorkedOn(today, { kind: 'test', refId: 2 });
    out.day = api.workedToday().day;
    console.log(JSON.stringify(out));
  `;
  const raw = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, SLATE_DB_PATH: dbFile, SLATE_NO_AI: '1' },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split('\n').pop());

  assert.equal(r.emptyDay, 0, 'a day with nothing logged is zero');
  assert.equal(r.afterYesterdayOnly, 0, "yesterday's hours do not count toward today");
  assert.equal(r.afterToday, 1200, "only today's seconds are added up");
  assert.equal(r.yesterdayTotal, 5400, 'yesterday still has its own total');
  assert.equal(r.tomorrow, 0, 'tomorrow starts at zero — nothing has to run at midnight');
  assert.equal(r.perTest, 1200, 'time can be totalled for one test');
  assert.equal(r.otherTest, 0, 'and does not leak between tests');
  assert.match(r.day, /^\d{4}-\d{2}-\d{2}$/);
});

test('anything due before noon belongs to the day before', () => {
  const { workDayFor, isEarlyMorning, timeLabel, todayYmd, addDaysYmd } = require('../src/dates');
  const at = (day, h, m = 0) => { const d = new Date(day + 'T00:00:00'); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const day = todayYmd();
  const dayBefore = addDaysYmd(day, -1);

  // An 8am deadline has to be finished the night before.
  assert.equal(workDayFor(at(day, 8, 0)), dayBefore);
  assert.equal(workDayFor(at(day, 11, 59)), dayBefore);
  assert.equal(isEarlyMorning(at(day, 8, 0)), true);

  // Noon onwards stays put — that is a day you can still work on it.
  assert.equal(workDayFor(at(day, 12, 0)), day);
  assert.equal(workDayFor(at(day, 23, 59)), day);
  assert.equal(isEarlyMorning(at(day, 12, 0)), false);
  assert.equal(isEarlyMorning(at(day, 23, 59)), false);

  // The label and the shift must agree, or the page explains the wrong thing.
  for (const h of [0, 6, 9, 11, 12, 15, 23]) {
    const iso = at(day, h);
    assert.equal(isEarlyMorning(iso), workDayFor(iso) !== day, `hour ${h} label disagrees with the shift`);
  }

  assert.equal(workDayFor(null), null, 'no deadline, no day');
  assert.equal(workDayFor('not a date'), null);
  assert.equal(isEarlyMorning(null), false);
  assert.match(timeLabel(at(day, 8, 5)), /8:05/);
  assert.equal(timeLabel(null), '');
});

test('sync puts an 8am deadline on the day before, and keeps the real time', async () => {
  // The mock has one assignment due 8:00 tomorrow (see mockCanvas 5002).
  const plan = await get('/api/today');
  const early = plan.assignments.find((a) => a.due_morning_of);
  assert.ok(early, "the 8am-tomorrow assignment landed on today's list");
  assert.match(early.due_morning_of, /8:00/, 'the real deadline is kept for the label');
  assert.equal(early.due_date, plan.date, 'and the day it must be DONE is today');
  assert.ok(new Date(early.due_at).getTime() > new Date(plan.date + 'T23:00:00').getTime(),
    'while the actual Canvas deadline is still tomorrow');
});

test('a fresh Slate starts EMPTY — no sample data unless it is asked for', async () => {
  // A second server on its own database with CANVAS_MODE unset: exactly what
  // Will gets when he opens the installed app for the first time.
  const { spawn: spawnOne } = require('node:child_process');
  const PORT2 = 4598;   // 4601 is inside a Windows-reserved port range
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const env = { ...process.env, PORT: String(PORT2), SLATE_OPEN: '0', SLATE_NO_AI: '1',
    SLATE_DB_PATH: path.join(TMP, 'fresh.db'), SLATE_DESKTOP_DIR: TMP };
  delete env.CANVAS_MODE;   // the whole point: no mode set, no sample data
  delete env.CANVAS_API_TOKEN;
  delete env.CANVAS_BASE_URL;

  const fresh = spawnOne(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  const g = async (p) => (await fetch(BASE2 + p)).json();
  const p2 = async (p, b) => (await fetch(BASE2 + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}),
  })).json();
  try {
    let up = false;
    for (let i = 0; i < 25 && fresh.exitCode === null; i++) {
      try { await g('/api/status'); up = true; break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    assert.ok(up, `the fresh server started (exit ${fresh.exitCode})`);

    const s = await g('/api/status');
    assert.equal(s.canvas_mode, 'none', 'it knows Canvas is not connected');
    assert.equal(s.last_sync, null, 'and it has never synced');

    assert.deepEqual(await g('/api/classes'), [], 'no made-up classes');
    assert.deepEqual(await g('/api/projects'), [], 'no made-up projects');
    assert.deepEqual(await g('/api/tests'), [], 'no made-up tests');
    assert.deepEqual(await g('/api/emails'), [], 'no made-up emails');
    const plan = await g('/api/today');
    assert.equal(plan.assignments.length, 0, 'nothing to do');
    assert.equal(plan.projects.length, 0);

    // Sync now, with nothing connected, must NOT quietly load the mock.
    const synced = await p2('/api/sync');
    assert.equal(synced.ok, true, 'the button still works');
    assert.deepEqual(await g('/api/classes'), [], 'and it stays empty');
    assert.equal((await g('/api/status')).canvas_mode, 'none');

    // The Canvas page should be offering to connect, not claiming it has.
    const canvas = await g('/api/canvas');
    assert.equal(canvas.connected, false);
    assert.equal(canvas.base_url, '');
  } finally {
    fresh.kill();
  }
});

test('one awkward class does not sink the whole sync', () => {
  // Real Canvas 404s a course that has quizzes switched off, hides modules, and
  // so on. Slate has to step over that and still bring in everything else —
  // this is what broke on Will's first real sync.
  //
  // Runs in its OWN process against its OWN database. An earlier version called
  // sync() inside the test runner, which loads src/db with the DEFAULT path —
  // so it wiped and re-synced Will's actual workshop database, and with a real
  // token present it called real Canvas. ANYTHING that calls sync() directly
  // must be sandboxed like this.
  const { execFileSync } = require('node:child_process');
  const runner = path.join(TMP, 'awkward-sync.js');
  fs.writeFileSync(runner, [
    "const SRC = process.env.SRC_DIR;",
    "const mock = require(SRC + '/canvas/mockCanvas.js');",
    "const { sync } = require(SRC + '/sync.js');",
    "const { getDb } = require(SRC + '/db.js');",
    "(async () => {",
    "  const firstCourse = (await mock.listCourses())[0].id;",
    "  const realQuizzes = mock.listQuizzes;",
    "  mock.listQuizzes = async (id) => {",
    "    if (id === firstCourse) throw new Error('Canvas API 404 on /courses/x/quizzes');",
    "    return realQuizzes(id);",
    "  };",
    "  mock.listModules = async () => { throw new Error('Canvas API 403 on /modules'); };",
    "  mock.listNotifications = async () => { throw new Error('Canvas API 500 on /conversations'); };",
    "  const counts = await sync();",
    "  const db = getDb();",
    "  console.log(JSON.stringify({",
    "    ...counts,",
    "    brokenClassTests: db.prepare('SELECT COUNT(*) n FROM tests WHERE class_id=(SELECT id FROM classes WHERE canvas_class_id=?)').get(String(firstCourse)).n,",
    "    syncedAt: db.prepare(\"SELECT COUNT(*) n FROM settings WHERE key='last_sync'\").get().n,",
    "  }));",
    "})();",
  ].join(String.fromCharCode(10)));

  const raw = execFileSync(process.execPath, [runner], {
    env: {
      ...process.env,
      SRC_DIR: path.join(__dirname, '..', 'src').split(path.sep).join('/'),
      CANVAS_MODE: 'mock',            // never the real Canvas
      SLATE_NO_AI: '1',
      SLATE_DB_PATH: path.join(TMP, 'awkward.db'),  // never the real database
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split(String.fromCharCode(10)).pop());

  assert.ok(r.skipped >= 3, `the failures were counted, not swallowed (${r.skipped})`);
  assert.ok(r.classes >= 5, 'every class still came in');
  assert.ok(r.assignments > 10, 'and all their work');
  assert.ok(r.tests > 0, 'the classes whose quizzes DID load still have tests');
  assert.equal(r.brokenClassTests, 0, 'only the broken class missed out');
  assert.equal(r.syncedAt, 1, 'the sync still counts as done');
});

test('a preview page holds exactly what a Word page holds', () => {
  // The live page count is only worth anything if it agrees with Word, so the
  // geometry is pinned here. Measured through Word itself over COM with MLA
  // documents of a known line count: 23 lines is one page, 24 lines is two.
  //
  // This has to be asserted on the SOURCE. The drive harness's DOM shim has no
  // layout engine, so it cannot reproduce a page break — same lesson as the
  // fixed-height .page-body bug in round 35.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf('.page-body {'));
  const lineHeight = Number((block.match(/line-height:\s*([\d.]+)/) || [])[1]);
  const fontSize = Number((block.match(/font-size:\s*(\d+)px/) || [])[1]);
  const padding = Number((block.match(/padding:\s*(\d+)px/) || [])[1]);
  assert.ok(lineHeight && fontSize && padding, 'found the page-body geometry');

  const bodyHeight = 1056 - padding * 2;     // 11in page less 1in margins
  const line = fontSize * lineHeight;
  assert.equal(Math.floor(bodyHeight / line), 23, `a page must hold 23 lines, got ${bodyHeight / line}`);
  assert.ok(24 * line > bodyHeight, '24 lines has to spill onto a second page');

  // line-height 2 is the tempting wrong answer: Word doubles the FONT's line
  // height (~1.15em for Times New Roman), not the point size, so plain 2 fits
  // 27 lines to a page and quietly under-counts by about one page in six.
  assert.notEqual(lineHeight, 2, 'line-height:2 is not what Word calls double spacing');
});

test('every assignment is filed as formative or summative', () => {
  const { categoryOf } = require('../src/sync');
  // It comes from the Canvas assignment group, which is where the school
  // actually decides this — never from guessing at the title.
  assert.equal(categoryOf('Formative'), 'formative');
  assert.equal(categoryOf('Summative'), 'summative');
  assert.equal(categoryOf('summative assessments'), 'summative');
  // A class left on Canvas defaults has neither, and must not be forced into one.
  assert.equal(categoryOf('Assignments'), null);
  assert.equal(categoryOf('Imported Assignments'), null);
  assert.equal(categoryOf(null), null);
  assert.equal(categoryOf(''), null);
});

test('a class shows its overall grade plus the formative/summative split', () => {
  const { execFileSync } = require('node:child_process');
  const runner = path.join(TMP, 'cats.js');
  fs.writeFileSync(runner, [
    "const SRC = process.env.SRC_DIR;",
    "const { sync } = require(SRC + '/sync.js');",
    "const api = require(SRC + '/api.js');",
    "(async () => {",
    "  await sync();",
    "  const classes = api.classes();",
    "  const bio = classes.find((c) => /Biology/.test(c.name));",
    "  const spanish = classes.find((c) => /Spanish/.test(c.name));",
    "  const detail = api.classDetail(bio.id);",
    "  console.log(JSON.stringify({",
    "    overall: bio.grade_pct,",
    "    cats: bio.categories,",
    "    plainClassSplit: spanish.categories.has_split,",
    "    plainClassGrade: spanish.grade_pct,",
    "    detailSplit: detail.categories.has_split,",
    "    labels: detail.grades.map((g) => g.category_label),",
    "  }));",
    "})();",
  ].join(String.fromCharCode(10)));

  const raw = execFileSync(process.execPath, [runner], {
    env: {
      ...process.env,
      SRC_DIR: path.join(__dirname, '..', 'src').split(path.sep).join('/'),
      CANVAS_MODE: 'mock',
      SLATE_NO_AI: '1',
      SLATE_DB_PATH: path.join(TMP, 'cats.db'),
      SLATE_DATA_DIR: TMP,
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split(String.fromCharCode(10)).pop());

  assert.ok(r.overall != null, 'the overall grade is there');
  assert.equal(r.cats.has_split, true, 'this class uses formative/summative');
  assert.ok(r.cats.formative.pct != null, 'formative has a figure');
  assert.equal(
    r.cats.formative.pct,
    Math.round((r.cats.formative.earned / r.cats.formative.possible) * 1000) / 10,
    "a category's percent is that category's own points, not the whole class"
  );
  // Nothing graded in a category is a dash, NOT 0% — those mean opposite things
  // and a 0 next to Summative would look like a failing grade.
  assert.equal(r.cats.summative.count, 0);
  assert.equal(r.cats.summative.pct, null, 'nothing graded reads as null, never 0');

  // A class on plain Canvas groups has no split, and must still show a grade.
  assert.equal(r.plainClassSplit, false);
  assert.ok(r.plainClassGrade != null);

  assert.equal(r.detailSplit, true, 'the class page shows the same split');
  assert.ok(r.labels.length > 0 && r.labels.every(Boolean), 'every graded row says what it counts as');
  assert.ok(r.labels.every((l) => ['Formative', 'Summative'].includes(l)), r.labels.join(','));
});

test('Slate re-checks Canvas on its own while it is open', async () => {
  // "Every hour when my computer is on and the program is open" — a timer in
  // the running server, deliberately not a Windows scheduled task: it exists
  // only while Slate does, and leaves nothing behind on the machine.
  const { spawn } = require('node:child_process');
  const PORT2 = 4611;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-auto-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT2),
      CANVAS_MODE: 'mock',
      SLATE_OPEN: '0',
      SLATE_NO_AI: '1',
      SLATE_DB_PATH: path.join(dir, 'auto.db'),
      SLATE_DATA_DIR: dir,
      SLATE_DESKTOP_DIR: dir,
      SLATE_SYNC_EVERY_MS: '1500', // an hour is impractical to sit through
      SLATE_NO_AUTOSYNC: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const stat = async () => (await fetch(BASE2 + '/api/status')).json();

  try {
    for (let i = 0; i < 60; i++) {
      try { await stat(); break; } catch { await wait(200); }
    }
    const first = (await stat()).last_sync;
    assert.ok(first, 'synced once to begin with');

    // Nothing is clicked. If the timer works, last_sync moves by itself.
    await wait(4000);
    assert.notEqual((await stat()).last_sync, first, 'last_sync moved on its own');

    // The timer and the Sync now button must never run at the same time and
    // write the same rows — the second caller waits for the first.
    const [a, b] = await Promise.all([
      fetch(BASE2 + '/api/sync', { method: 'POST' }).then((r) => r.json()),
      fetch(BASE2 + '/api/sync', { method: 'POST' }).then((r) => r.json()),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.deepEqual(a.counts, b.counts, 'both got the same run, because it only ran once');
  } finally {
    child.kill();
    await wait(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
  }
});

test('list parameters go to Canvas as name[], which is not optional', async () => {
  // `student_ids=self` makes /students/submissions answer HTTP 500. Not 400,
  // not an empty list — a 500, which tryFetch politely stepped over. That is
  // how Will went a week with no grades and with nothing ever marked as
  // received by Canvas. Canvas wants `student_ids[]=self`.
  const asked = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    asked.push(String(url));
    return { ok: true, status: 200, async json() { return []; } };
  };
  try {
    // A real client needs a base url + token; give it throwaway ones. Nothing
    // leaves the machine — fetch is stubbed above.
    process.env.CANVAS_MODE = 'real';
    process.env.CANVAS_BASE_URL = 'https://example.instructure.com';
    process.env.CANVAS_API_TOKEN = 'not-a-real-token';
    delete require.cache[require.resolve('../src/canvas/canvasClient')];
    const { getClient } = require('../src/canvas/canvasClient');
    await getClient().listSubmissions(123);
  } finally {
    global.fetch = realFetch;
    delete process.env.CANVAS_MODE;
    delete process.env.CANVAS_BASE_URL;
    delete process.env.CANVAS_API_TOKEN;
    delete require.cache[require.resolve('../src/canvas/canvasClient')];
  }

  assert.equal(asked.length, 1, 'it asked Canvas once');
  assert.match(asked[0], /student_ids%5B%5D=self/, 'sent as student_ids[]=self: ' + asked[0]);
  assert.doesNotMatch(asked[0], /student_ids=self/, 'never as a bare student_ids=');
});

test('the class grade is the one Canvas reports, not a sum of points', () => {
  // Teachers weight categories — tests 40%, homework 20%. Canvas has already
  // applied that; adding up raw points gives a different number, and quoting
  // Will a grade that exists nowhere else is worse than showing nothing.
  const { execFileSync } = require('node:child_process');
  const runner = path.join(TMP, 'grades.js');
  fs.writeFileSync(runner, [
    "const SRC = process.env.SRC_DIR;",
    "const { sync, markSubmittedDone } = require(SRC + '/sync.js');",
    "const api = require(SRC + '/api.js');",
    "const { getDb } = require(SRC + '/db.js');",
    "const mock = require(SRC + '/canvas/mockCanvas.js');",
    "(async () => {",
    "  await sync();",
    "  const db = getDb();",
    "  const bio = api.classes().find((c) => /Biology/.test(c.name));",
    "  const detail = api.classDetail(bio.id);",
    "  const summed = detail.total_possible",
    "    ? Math.round((detail.total_earned / detail.total_possible) * 1000) / 10 : null;",
    "  const out = {",
    "    shown: bio.grade_pct,",
    "    letter: bio.grade_letter,",
    "    summed,",
    "    gradedItems: detail.grades.length,",
    "    gradeRows: db.prepare('SELECT COUNT(*) n FROM grades').get().n,",
    "    gpa: api.gpa().gpa,",
    "  };",
    "  db.prepare('UPDATE classes SET canvas_score=NULL, canvas_letter=NULL WHERE id=?').run(bio.id);",
    "  out.withoutCanvas = api.classes().find((c) => c.id === bio.id).grade_pct;",
    "  await sync();",
    "  out.restored = api.classes().find((c) => c.id === bio.id).grade_pct;",
    "  const real = mock.getEnrollmentGrade;",
    "  mock.getEnrollmentGrade = async () => null;",
    "  await sync();",
    "  out.afterQuietCanvas = api.classes().find((c) => c.id === bio.id).grade_pct;",
    "  mock.getEnrollmentGrade = real;",
    "  const two = db.prepare(\"SELECT id, canvas_assignment_id FROM assignments WHERE type='regular' AND status='todo' LIMIT 2\").all();",
    "  markSubmittedDone(db, [{ assignment_id: two[0].canvas_assignment_id, workflow_state: 'graded', score: 18 }]);",
    "  const paper = db.prepare('SELECT title, status, completed_at, completed_day FROM assignments WHERE id=?').get(two[0].id);",
    "  out.paperDone = paper.status;",
    "  out.paperStamped = !!(paper.completed_at || paper.completed_day);",
    "  out.paperInFinishedToday = api.todayPlan().finished.some((f) => f.title === paper.title);",
    "  markSubmittedDone(db, [{ assignment_id: two[1].canvas_assignment_id, workflow_state: 'graded', submitted_at: '2026-08-13T14:02:00Z' }]);",
    "  out.handedDay = db.prepare('SELECT completed_day d FROM assignments WHERE id=?').get(two[1].id).d;",
    "  console.log(JSON.stringify(out));",
    "})();",
  ].join(String.fromCharCode(10)));

  const raw = execFileSync(process.execPath, [runner], {
    env: {
      ...process.env,
      SRC_DIR: path.join(__dirname, '..', 'src').split(path.sep).join('/'),
      CANVAS_MODE: 'mock',
      SLATE_NO_AI: '1',
      SLATE_DB_PATH: path.join(TMP, 'grades.db'),
      SLATE_DATA_DIR: TMP,
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split(String.fromCharCode(10)).pop());

  assert.equal(r.shown, 94.8, "shows Canvas's own score");
  assert.equal(r.letter, 'A', "and Canvas's own letter");
  assert.notEqual(r.summed, r.shown, 'the points total says something else — that is the point');
  assert.ok(r.gradeRows > 0, 'per-assignment scores were recorded');
  assert.ok(r.gradedItems > 0, 'and the class page can list them');
  assert.ok(r.gpa > 0, 'the GPA is built from real grades');

  assert.equal(r.withoutCanvas, r.summed, 'no Canvas grade falls back to adding up points');
  assert.equal(r.restored, 94.8, 'and the next sync brings the Canvas grade back');
  assert.equal(r.afterQuietCanvas, 94.8, 'a quiet Canvas never blanks a grade it already gave');

  // Graded on paper: Canvas has a score but no submitted_at. Marking it done is
  // right; stamping it TODAY is not — that dumps a whole term of graded work
  // into "Finished today" the first time submissions come through.
  assert.equal(r.paperDone, 'done');
  assert.equal(r.paperStamped, false, 'no finished-today stamp without a date from Canvas');
  assert.equal(r.paperInFinishedToday, false);
  assert.equal(r.handedDay, '2026-08-13', 'work Canvas received is stamped with the day it got it');
});

test('a file link in real Canvas markup is found, opened and read', async () => {
  const att = require('../src/attachments');

  // This is Will's ACTUAL markup. Real Canvas has no `attachments` field on an
  // assignment — a teacher's attachment is an <a> inside the description, which
  // is why the files column was empty for all 35 of his assignments until this
  // existed.
  const real = '<p>Read it and answer.</p><p><a class="instructure_file_link instructure_scribd_file inline_disabled"'
    + ' title="Trolley Land – Ethics Reflection.pdf"'
    + ' href="https://jcseagles.instructure.com/courses/5844/files/740090?verifier=xRAx&amp;wrap=1"'
    + ' data-api-endpoint="https://jcseagles.instructure.com/api/v1/courses/5844/files/740090"'
    + ' data-api-returntype="File">Trolley Land – Ethics Reflection.pdf</a></p>';
  const links = att.linksFromDescription(real);
  assert.equal(links.length, 1, 'found the attachment');
  assert.equal(links[0].file_id, '740090');
  assert.equal(links[0].course_id, '5844');
  assert.match(links[0].name, /Ethics Reflection\.pdf$/);

  // The same handout linked twice is one attachment, not two. His yearbook
  // assignments link the identical file from three different pages.
  assert.equal(att.linksFromDescription(real + real).length, 1, 'deduped by file id');
  // Canvas sometimes writes title="Link"; the anchor text is the better name.
  assert.equal(
    att.linksFromDescription('<a class="instructure_file_link" title="Link" href="/courses/1/files/22">Info.pdf</a>')[0].name,
    'Info.pdf'
  );
  // An ordinary link is not an attachment.
  assert.equal(att.linksFromDescription('<a href="https://example.com/x">read this</a>').length, 0);

  // ---- through the running server ----
  const bio = (await get('/api/classes')).find((c) => /Biology/.test(c.name));
  assert.ok(bio, 'the mock has a Biology class');
  const today = await get('/api/today');
  const all = [...today.assignments, ...today.finished];
  const worksheet = all.find((a) => /Organelle/i.test(a.title));
  assert.ok(worksheet, 'found the assignment with an attachment');

  const detail = await get('/api/assignments/' + worksheet.id);
  assert.equal(detail.files.length, 1, 'the page lists the attached file');
  assert.equal(detail.files[0].kind, 'docx');
  assert.equal(detail.files[0].readable, true);
  // Lazy: Canvas is not touched until the file is actually wanted. (This holds
  // because nothing has simplified this assignment's instructions yet — doing
  // that reads the attachments. A test added above this one that simplifies it
  // would move the fetch earlier.)
  assert.equal(detail.files[0].downloaded, false, 'nothing is fetched until it is asked for');

  // Opening it downloads it once and hands it to the machine. SLATE_OPEN=0 in
  // the test env stops it actually launching Word.
  const opened = await post(`/api/assignments/${worksheet.id}/files/open`, { index: 0 });
  assert.equal(opened.ok, true, opened.error || '');
  assert.ok(fs.existsSync(opened.path), 'the file landed on disk');
  // Inside the server's own data folder and nowhere else. (FILE_DIR read from
  // THIS process would point at the real data folder — the server has its own
  // SLATE_DATA_DIR, which is the whole point of the sandbox.)
  assert.ok(opened.path.startsWith(path.join(TMP, 'attachments')), 'inside the data folder: ' + opened.path);
  assert.equal((await get('/api/assignments/' + worksheet.id)).files[0].downloaded, true);

  // An index that isn't there fails cleanly instead of throwing. Files are
  // addressed by POSITION, never by a name from the page, so there is no path
  // for the browser to smuggle in.
  const bad = await post(`/api/assignments/${worksheet.id}/files/open`, { index: 99 });
  assert.equal(bad.ok, false);
  assert.ok(bad.error, 'and says why');
});

test('Office files give up their text without a single dependency', () => {
  const att = require('../src/attachments');
  const og = require('../src/officegen');

  // Round-trips through Slate's own writers, so this tests the by-hand ZIP
  // reader against a real OOXML package rather than a convenient fake.
  const docx = og.buildDocx('Hello there\n\nSecond paragraph', { title: 'T' });
  const docText = att.textFromBytes(docx, 'thing.docx');
  assert.match(docText, /Hello there/);
  assert.match(docText, /Second paragraph/);

  const pptx = og.buildPptx([
    { title: 'Photosynthesis', bullets: ['Biology'] },
    { title: 'The Equation', bullets: ['Six carbon dioxide', 'Six water'] },
  ]);
  const slideText = att.textFromBytes(pptx, 'deck.pptx');
  assert.match(slideText, /Photosynthesis/);
  assert.match(slideText, /Six water/, 'every slide, not just the first');

  assert.equal(att.textFromBytes(Buffer.from('just words'), 'notes.txt'), 'just words');
  // A PDF has to go to Claude, so nothing comes back from the bytes alone.
  assert.equal(att.textFromBytes(Buffer.from('%PDF-1.4'), 'x.pdf'), '');
  // And a video is never worth downloading to find that out.
  assert.equal(att.isReadable('lecture.mp4'), false);
  assert.equal(att.isReadable('worksheet.pdf'), true);
});

test('the attached file feeds the instructions, not just the description', async () => {
  // The whole point: teachers here put the real directions in the attachment
  // and leave the description box saying "worksheet attached".
  const today = await get('/api/today');
  const all = [...today.assignments, ...today.finished];
  const worksheet = all.find((a) => /Organelle/i.test(a.title));
  const detail = await get('/api/assignments/' + worksheet.id);

  const readText = await post(`/api/assignments/${worksheet.id}/read-files`, {});
  assert.match(readText.text, /Label all eight organelles/, 'read the words out of the .docx');
  assert.match(readText.text, /complete sentences/, 'the later lines too');
  assert.match(readText.text, /organelle_worksheet\.docx/, 'and says which file they came from');

  // The description never said any of that — proof it came from the file.
  assert.doesNotMatch(detail.description || '', /eight organelles/i);
  assert.equal((await get('/api/assignments/' + worksheet.id)).files_state, 'done');
});

test('a class that leaves Canvas is hidden, not destroyed', () => {
  // Will changed his schedule two days into the year: the new classes arrived
  // and the old ones stayed, because sync only ever added. Canvas is the
  // schedule now — a course that stops coming back gets archived.
  //
  // Archived, not deleted, and that is the part worth protecting: drafts, class
  // notes and flashcards all hang off a class. Same child-process sandbox as
  // the awkward-class test above — anything calling sync() needs it.
  const { execFileSync } = require('node:child_process');
  const runner = path.join(TMP, 'dropped-class.js');
  fs.writeFileSync(runner, [
    "const SRC = process.env.SRC_DIR;",
    "const mock = require(SRC + '/canvas/mockCanvas.js');",
    "const { sync } = require(SRC + '/sync.js');",
    "const { getDb } = require(SRC + '/db.js');",
    "const api = require(SRC + '/api.js');",
    "(async () => {",
    "  await sync();",
    "  const db = getDb();",
    "  const dropped = db.prepare('SELECT id FROM classes WHERE canvas_class_id = ?').get('105');",
    "  const rowsBefore = db.prepare('SELECT COUNT(*) n FROM assignments WHERE class_id=?').get(dropped.id).n;",
    "  const mine = db.prepare('SELECT id FROM assignments WHERE class_id=? ORDER BY id LIMIT 1').get(dropped.id);",
    "  db.prepare('UPDATE assignments SET draft_text=? WHERE id=?').run('my own writing', mine.id);",
    "  const all = mock.listCourses;",
    "  mock.listCourses = async () => (await all()).filter((c) => c.id !== 105);",
    "  const counts = await sync();",
    "  const names = () => api.classes().map((c) => c.name).join('|');",
    "  const weekNames = api.week().flatMap((d) => [...d.assignments, ...d.projects, ...d.tests,",
    "    ...d.done_assignments, ...d.done_projects].map((i) => i.class_name || '')).join('|');",
    "  const out = {",
    "    hidden: counts.hidden,",
    "    activeClasses: api.classes().length,",
    "    stillListed: /Spanish/.test(names()),",
    "    inTheWeek: /Spanish/.test(weekNames),",
    "    inToday: api.todayPlan().assignments.some((a) => /Spanish/.test(a.class_name || '')),",
    "    inTests: api.tests().some((t) => /Spanish/.test(t.class_name || '')),",
    "    gpaClasses: api.gpa().classes,",
    "    rowsBefore,",
    "    rowsAfter: db.prepare('SELECT COUNT(*) n FROM assignments WHERE class_id=?').get(dropped.id).n,",
    "    draftKept: db.prepare('SELECT draft_text d FROM assignments WHERE id=?').get(mine.id).d,",
    "  };",
    "  mock.listCourses = all;",
    "  await sync();",
    "  out.backAfterReturning = api.classes().length;",
    "  mock.listCourses = async () => [];",
    "  const empty = await sync();",
    "  out.afterEmptyAnswer = api.classes().length;",
    "  out.emptyHid = empty.hidden;",
    "  console.log(JSON.stringify(out));",
    "})();",
  ].join(String.fromCharCode(10)));

  const raw = execFileSync(process.execPath, [runner], {
    env: {
      ...process.env,
      SRC_DIR: path.join(__dirname, '..', 'src').split(path.sep).join('/'),
      CANVAS_MODE: 'mock',            // never the real Canvas
      SLATE_NO_AI: '1',
      SLATE_DB_PATH: path.join(TMP, 'dropped.db'),  // never the real database
      SLATE_DATA_DIR: TMP,
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split(String.fromCharCode(10)).pop());

  assert.equal(r.hidden, 1, 'the dropped class was hidden');
  assert.equal(r.activeClasses, 4, 'the other four stayed');
  assert.equal(r.stillListed, false, 'it is off the classes page');
  assert.equal(r.inTheWeek, false, 'and out of the week');
  assert.equal(r.inToday, false, 'and off Today');
  assert.equal(r.inTests, false, 'and out of Tests & Quizzes');
  assert.equal(r.gpaClasses, 4, 'and out of the GPA');

  assert.equal(r.rowsAfter, r.rowsBefore, 'nothing was deleted');
  assert.equal(r.draftKept, 'my own writing', 'his writing survived');
  assert.equal(r.backAfterReturning, 5, 'it comes back if the schedule flips back');

  // The one that matters most: a bad answer from Canvas must never read as
  // "Will dropped out of school".
  assert.equal(r.afterEmptyAnswer, 5, 'an empty course list hides nothing');
  assert.equal(r.emptyHid, 0, 'and reports nothing hidden');
});

test('exams posted as assignments go to Tests & Quizzes, not Projects', () => {
  const { assessmentKind } = require('../src/llm');
  const k = (name, points = 100) => assessmentKind({ name, points_possible: points });

  assert.equal(k('Unit 3 Exam'), 'test');
  assert.equal(k('Midterm Exam', 150), 'test');
  assert.equal(k('Final Exam', 200), 'test');
  assert.equal(k('Chapter 5 Test'), 'test');
  assert.equal(k('Semester Benchmark Assessment', 80), 'test');
  assert.equal(k('Vocabulary Quiz 4', 20), 'quiz');

  // Work ABOUT an assessment is still ordinary work.
  assert.equal(k('Exam Review Sheet', 20), null);
  assert.equal(k('Study Guide for Unit 3 Exam', 15), null);
  assert.equal(k('Test Corrections', 10), null);
  assert.equal(k('Quiz Prep', 5), null);
  assert.equal(k('Practice Test', 10), null);

  // And so is everything that isn't an assessment at all — including a project
  // whose title says "(Final)", meaning the final draft.
  assert.equal(k('American Dream Essay (Final)', 100), null);
  assert.equal(k('Lab Report: Osmosis in Potato Cells', 40), null);
  assert.equal(k('Parabola in Real Life Poster', 80), null);
  assert.equal(k('Reading Response', 10), null);
});

test('exams end up on the tests list with their real deadline', async () => {
  const tests = await get('/api/tests');
  const exam = tests.find((t) => /Unit 2 Exam/i.test(t.name));
  assert.ok(exam, 'the exam assignment became a test');
  assert.equal(exam.type, 'test');
  assert.ok(exam.due_at, 'and kept the real Canvas deadline for display');

  const projects = await get('/api/projects');
  assert.ok(!projects.some((p) => /Unit 2 Exam/i.test(p.title)), 'and is not on Projects');
  const plan = await get('/api/today');
  assert.ok(!plan.assignments.some((a) => /Unit 2 Exam/i.test(a.title)), 'nor in the assignment list');
});

test('opening an email gives the whole message and its attachments', async () => {
  const inbox = await get('/api/emails');
  assert.ok(inbox.length >= 3);

  const withFiles = inbox.find((e) => /Unit 4 Test/.test(e.subject));
  const opened = await get('/api/emails/' + withFiles.id);
  assert.ok(opened.body.length > withFiles.body.length, 'the full text beats the preview');
  assert.equal(opened.full_text_loaded, true);
  assert.equal(opened.attachments.length, 2);
  for (const a of opened.attachments) {
    assert.ok(a.name && a.name.length > 3, 'every attachment is named');
    assert.match(a.url, /^https?:/, 'and links somewhere');
    assert.ok(typeof a.size === 'number');
  }

  // Once fetched it is kept, so reopening does not need Canvas again.
  const again = await get('/api/emails/' + withFiles.id);
  assert.equal(again.body, opened.body);
  assert.equal(again.attachments.length, 2);

  const plain = await get('/api/emails/' + inbox.find((e) => /Lab Report/.test(e.subject)).id);
  assert.deepEqual(plain.attachments, [], 'a message with nothing attached says so');
});

test('handing in: preview first, then submit — and only when asked', async () => {
  const due = (await get('/api/today')).assignments;
  const details = await Promise.all(due.map((a) => get('/api/assignments/' + a.id)));

  // A typed assignment Canvas takes as text.
  const typed = details.find((d) => d.work_mode === 'text');
  await post(`/api/assignments/${typed.id}/draft`, { text: 'My answer about Chapter 3 and social class.' });

  const p = await get(`/api/submit-preview?kind=assignment&id=${typed.id}`);
  assert.equal(p.ok, true);
  assert.equal(p.can_submit, true);
  assert.equal(p.empty, false);
  assert.match(p.preview_text, /Chapter 3/, 'the preview is the real text, not a summary');
  assert.ok(p.how, 'it says how it will go in');
  assert.ok(p.due_at || p.due_date, 'and when it is due');

  // Looking at the preview must not send anything.
  const before = (await get('/api/_submitted')).count;
  await get(`/api/submit-preview?kind=assignment&id=${typed.id}`);
  assert.equal((await get('/api/_submitted')).count, before, 'previewing sends nothing');

  const sent = await post('/api/submit-to-canvas', { kind: 'assignment', id: typed.id });
  assert.equal(sent.ok, true, sent.error);
  const log = await get('/api/_submitted');
  assert.equal(log.count, before + 1, 'exactly one submission');
  const last = log.sent[log.sent.length - 1];
  assert.equal(last.kind, 'text');
  assert.match(last.body, /Chapter 3/, 'Canvas got what the preview showed');
  assert.equal((await get('/api/assignments/' + typed.id)).status, 'done', 'handed in means done');

  // Put it back so the rest of the suite still has it on today's list.
  await post(`/api/assignments/${typed.id}/reopen`);
});

test('handing in: file uploads, and the ones Canvas will not take', async () => {
  const projects = await get('/api/projects');
  const pd = await Promise.all(projects.map((p) => get('/api/projects/' + p.id)));

  // A slideshow goes as a file, not as typed text.
  const slides = pd.find((p) => p.build_mode === 'slides');
  const sp = await get(`/api/submit-preview?kind=project&id=${slides.id}&format=pptx`);
  assert.equal(sp.ok, true);
  assert.equal(sp.route, 'file');
  assert.match(sp.filename, /\.pptx$/);
  assert.ok(sp.bytes > 1000, 'the preview knows the real file size');
  assert.ok(sp.preview_text.length > 0, 'and still shows what is inside it');

  const before = (await get('/api/_submitted')).count;
  const sent = await post('/api/submit-to-canvas', { kind: 'project', id: slides.id, format: 'pptx' });
  assert.equal(sent.ok, true, sent.error);
  const log = await get('/api/_submitted');
  assert.equal(log.count, before + 1);
  assert.equal(log.sent[log.sent.length - 1].kind, 'file');
  assert.match(log.sent[log.sent.length - 1].filename, /\.pptx$/);

  // Work Canvas does not accept online is refused with a reason, not attempted.
  const all = await get('/api/today');
  const details = await Promise.all(all.assignments.map((a) => get('/api/assignments/' + a.id)));
  const onPaper = details.find((d) => (d.submission_types || []).includes('on_paper'));
  if (onPaper) {
    const pp = await get(`/api/submit-preview?kind=assignment&id=${onPaper.id}`);
    assert.equal(pp.can_submit, false);
    assert.match(pp.blocked_reason, /paper/i);
    const n = (await get('/api/_submitted')).count;
    const refused = await post('/api/submit-to-canvas', { kind: 'assignment', id: onPaper.id });
    assert.equal(refused.ok, false);
    assert.equal((await get('/api/_submitted')).count, n, 'and nothing was sent');
  }
});

test('handing in: an empty draft is never sent', async () => {
  const due = (await get('/api/today')).assignments;
  const details = await Promise.all(due.map((a) => get('/api/assignments/' + a.id)));
  const typed = details.find((d) => d.work_mode === 'text');
  assert.ok(typed, 'a typed assignment is still on today');
  await post(`/api/assignments/${typed.id}/draft`, { text: '   ' });

  const p = await get(`/api/submit-preview?kind=assignment&id=${typed.id}`);
  assert.equal(p.empty, true, 'the preview says there is nothing there');
  const before = (await get('/api/_submitted')).count;
  const r = await post('/api/submit-to-canvas', { kind: 'assignment', id: typed.id });
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing/i);
  assert.equal((await get('/api/_submitted')).count, before, 'nothing left the machine');
});

test('handing in: the preview warns if Canvas already has something', async () => {
  const due = (await get('/api/today')).assignments;
  const details = await Promise.all(due.map((a) => get('/api/assignments/' + a.id)));
  const typed = details.find((d) => d.work_mode === 'text');
  await post(`/api/assignments/${typed.id}/draft`, { text: 'First go at this one.' });

  // Earlier tests in this file may already have submitted this one, so count
  // attempts rather than assuming a clean slate.
  const before = await get(`/api/submit-preview?kind=assignment&id=${typed.id}`);
  const attemptsBefore = before.already_attempts || 0;

  await post('/api/submit-to-canvas', { kind: 'assignment', id: typed.id });
  await post(`/api/assignments/${typed.id}/reopen`);

  const after = await get(`/api/submit-preview?kind=assignment&id=${typed.id}`);
  assert.ok(after.already_submitted_at, 'the preview knows Canvas already has one');
  assert.equal(after.already_attempts, attemptsBefore + 1, 'and counts the attempts');
  assert.ok(after.can_submit, 'and still lets you send another — it warns, it does not block');
});

test('AI checker: reads a score, never explains what tripped it', () => {
  const ai = require('../src/aiCheck');

  // GPTZero has moved its response shape around; both forms must read.
  const modern = ai.readScore({ documents: [{ class_probabilities: { ai: 0.83, human: 0.12, mixed: 0.05 }, predicted_class: 'ai' }] });
  assert.equal(modern.ai_pct, 83);
  assert.equal(modern.mixed_pct, 5);
  assert.equal(modern.verdict, 'ai');
  const older = ai.readScore({ documents: [{ completely_generated_prob: 0.07 }] });
  assert.equal(older.ai_pct, 7);

  // Nothing usable must throw rather than invent a number.
  assert.throws(() => ai.readScore({}));
  assert.throws(() => ai.readScore({ documents: [] }));
  assert.throws(() => ai.readScore({ documents: [{}] }));

  // The whole module carries a score and nothing that reads as a fix-it list.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiCheck.js'), 'utf8');
  assert.ok(!/reasons?|why it|triggers?|flagged because|to avoid|rewrite/i.test(src.replace(/^\s*\/\/.*$/gm, '')),
    'the checker must not produce guidance on what to change');
  assert.equal(ai.wordCount('one two three'), 3);
  assert.equal(ai.wordCount('   '), 0);
});

test('AI checker: off unless a key is saved, and never blocks handing in', async () => {
  // The test server has no key and no fake mode, so it must be silent.
  const due = (await get('/api/today')).assignments;
  const details = await Promise.all(due.map((a) => get('/api/assignments/' + a.id)));
  const typed = details.find((d) => d.work_mode === 'text');
  await post(`/api/assignments/${typed.id}/draft`, { text: 'A real paragraph of my own writing about the book. '.repeat(8) });

  const off = await post('/api/ai-check', { kind: 'assignment', id: typed.id });
  assert.equal(off.state, 'off', 'no key means the feature says nothing');

  const canvas = await get('/api/canvas');
  assert.equal(canvas.ai_check.enabled, false);
  assert.equal(canvas.ai_check.hint, '', 'no key, nothing to hint at');
  assert.ok(!('key' in canvas.ai_check), 'the key itself never goes to the page');

  // With it off, handing in still works exactly as before.
  const preview = await get(`/api/submit-preview?kind=assignment&id=${typed.id}`);
  assert.equal(preview.can_submit, true, 'the checker is not a gate');
});

test('AI checker: scores writing, caches it, and skips short drafts', () => {
  // Own process: SLATE_AI_CHECK_FAKE has to be set before the module loads, and
  // this must never reach the real GPTZero.
  const { execFileSync } = require('node:child_process');
  const runner = path.join(TMP, 'aicheck.js');
  fs.writeFileSync(runner, [
    "const SRC = process.env.SRC_DIR;",
    "const { getDb } = require(SRC + '/db.js');",
    "const ai = require(SRC + '/aiCheck.js');",
    "(async () => {",
    "  const db = getDb();",
    "  db.prepare(\"INSERT INTO classes (name, canvas_class_id) VALUES ('C','c1')\").run();",
    "  const cid = db.prepare('SELECT id FROM classes').get().id;",
    "  db.prepare(\"INSERT INTO assignments (class_id, title, type, status) VALUES (?,'A','regular','todo')\").run(cid);",
    "  const id = db.prepare('SELECT id FROM assignments').get().id;",
    "  const long = 'This is a sentence of my own writing. '.repeat(20);",
    "  const out = {};",
    "  out.short = await ai.checkWriting(id, 'too few words here');",
    "  out.first = await ai.checkWriting(id, long);",
    "  out.second = await ai.checkWriting(id, long);",
    "  out.changed = await ai.checkWriting(id, long + ' LOOKS-LIKE-AI');",
    "  out.enabled = ai.hasKey();",
    "  console.log(JSON.stringify(out));",
    "})();",
  ].join(String.fromCharCode(10)));

  const raw = execFileSync(process.execPath, [runner], {
    env: {
      ...process.env,
      SRC_DIR: path.join(__dirname, '..', 'src').split(path.sep).join('/'),
      SLATE_DB_PATH: path.join(TMP, 'aicheck.db'),
      SLATE_AI_CHECK_FAKE: '1',
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split(String.fromCharCode(10)).pop());

  assert.equal(r.enabled, true);
  assert.equal(r.short.state, 'short', 'a couple of sentences is not worth scoring');
  assert.equal(r.short.min_words, 50);

  assert.equal(r.first.state, 'done');
  assert.equal(r.first.ai_pct, 4, 'ordinary writing scores low');
  assert.equal(r.first.cached, false);

  assert.equal(r.second.ai_pct, 4);
  assert.equal(r.second.cached, true, 'reopening the same draft does not spend another check');

  assert.equal(r.changed.cached, false, 'editing the draft means a fresh check');
  assert.equal(r.changed.ai_pct, 91);
});

test('finished today means finished today, whatever it was due', () => {
  // Own process and database: this pokes completed_day directly to check the
  // day boundary, which the running server cannot be made to do.
  const { execFileSync } = require('node:child_process');
  const runner = path.join(TMP, 'finished.js');
  fs.writeFileSync(runner, [
    "const SRC = process.env.SRC_DIR;",
    "const { getDb } = require(SRC + '/db.js');",
    "const api = require(SRC + '/api.js');",
    "const { todayYmd, addDaysYmd } = require(SRC + '/dates.js');",
    "const db = getDb();",
    "const t = todayYmd();",
    "db.prepare(\"INSERT INTO classes (name, canvas_class_id) VALUES ('C','c1')\").run();",
    "const cid = db.prepare('SELECT id FROM classes').get().id;",
    "const add = (title, due) => { db.prepare(\"INSERT INTO assignments (class_id,title,type,status,due_date,points) VALUES (?,?,'regular','todo',?,10)\").run(cid, title, due); return db.prepare('SELECT id FROM assignments WHERE title=?').get(title).id; };",
    "const dueToday = add('Due today', t);",
    "const dueLater = add('Due next week', addDaysYmd(t, 6));",
    "const out = {};",
    "api.completeAssignment(dueToday);",
    "api.completeAssignment(dueLater);",
    "out.finished = api.todayPlan().finished.map(a => a.title).sort();",
    "// An evening finish must not roll into tomorrow: completed_at is UTC, the day is local.",
    "db.prepare(\"UPDATE assignments SET completed_at=? WHERE id=?\").run(t + 'T23:30:00.000Z', dueToday);",
    "out.stillThere = api.todayPlan().finished.some(a => a.title === 'Due today');",
    "// Finished on a different day drops off today's list.",
    "db.prepare('UPDATE assignments SET completed_day=? WHERE id=?').run(addDaysYmd(t, -1), dueLater);",
    "out.yesterdayGone = !api.todayPlan().finished.some(a => a.title === 'Due next week');",
    "// Canvas's already-graded imports have no completed_day and never appear.",
    "db.prepare(\"INSERT INTO assignments (class_id,title,type,status,due_date,points) VALUES (?,'Old graded','regular','done',?,10)\").run(cid, t);",
    "out.importedHidden = !api.todayPlan().finished.some(a => a.title === 'Old graded');",
    "api.reopenAssignment(dueToday);",
    "out.afterReopen = api.todayPlan().finished.map(a => a.title);",
    "out.backInUnfinished = api.todayPlan().assignments.some(a => a.title === 'Due today');",
    "console.log(JSON.stringify(out));",
  ].join(String.fromCharCode(10)));

  const raw = execFileSync(process.execPath, [runner], {
    env: {
      ...process.env,
      SRC_DIR: path.join(__dirname, '..', 'src').split(path.sep).join('/'),
      SLATE_DB_PATH: path.join(TMP, 'finished.db'),
      CANVAS_MODE: 'mock',
      SLATE_NO_AI: '1',
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split(String.fromCharCode(10)).pop());

  assert.deepEqual(r.finished, ['Due next week', 'Due today'],
    'work due another day still counts as finished today');
  assert.equal(r.stillThere, true, 'an evening finish does not roll into tomorrow');
  assert.equal(r.yesterdayGone, true, "yesterday's finishes are not today's");
  assert.equal(r.importedHidden, true, 'Canvas imports with no stamp never show');
  // 'Due next week' was moved to yesterday above, so today's list ends empty.
  assert.deepEqual(r.afterReopen, [], 'reopening takes it back out');
  assert.equal(r.backInUnfinished, true, 'and puts it back in unfinished');
});

test('class names shorten to something you would write in a heading', () => {
  const { readClassName, splitTeacher, shortenSubject } = require('../src/classNames');

  const real = readClassName('AP United States Government and Politics- Nunes');
  assert.equal(real.short, 'AP U.S. Government');
  assert.equal(real.teacher, 'Nunes');

  assert.equal(readClassName('12th Grade Bible- MacIntosh Gloetzner').short, 'Bible');
  assert.equal(readClassName('Honors Statistics- Farrokh').teacher, 'Farrokh');
  assert.equal(readClassName('English IV- Nunes').short, 'English IV');
  assert.equal(readClassName('AP Cybersecurity- Silvestri').short, 'AP Cybersecurity');
  assert.equal(readClassName('English 11: American Literature').short, 'English 11',
    'a subtitle after a colon is dropped rather than cut mid-phrase');

  // No teacher in the name means no teacher guessed — never invent one.
  assert.equal(readClassName('Senior Class Page').teacher, '');
  assert.equal(readClassName('Senior Class Page').short, 'Senior Class Page');
  assert.equal(readClassName('Algebra II Honors').teacher, '', 'Honors is not a surname');

  // Nothing is ever cut mid-word.
  for (const raw of ['World History: Modern Era and Global Conflict', 'Introduction to Computer Science - Chen']) {
    const short = readClassName(raw).short;
    assert.ok(short.length <= 30, `${short} is heading-sized`);
    assert.ok(!/\s$/.test(short) && short === short.trim());
    for (const w of short.split(' ')) assert.ok(w.length > 1 || /^[AI]$/.test(w), `"${w}" is a whole word`);
  }

  // An honorific in the teacher field is pulled out, so it never doubles up.
  assert.deepEqual(splitTeacher('Mr. Ortiz'), { title: 'Mr.', name: 'Ortiz' });
  assert.deepEqual(splitTeacher('Mrs Rivera'), { title: 'Mrs.', name: 'Rivera' });
  assert.deepEqual(splitTeacher('Ortiz'), { title: '', name: 'Ortiz' });
  assert.equal(shortenSubject(''), '');
});

test('every handed-in document gets a heading and keeps lists intact', async () => {
  const due = (await get('/api/today')).assignments;
  const details = await Promise.all(due.map((a) => get('/api/assignments/' + a.id)));
  const typed = details.find((d) => d.work_mode === 'text');

  const draft = 'Here is my answer.\n\n• first point\n• second point\n\nAnd a closing line.';
  await post(`/api/assignments/${typed.id}/draft`, { text: draft });

  const p = await get(`/api/submit-preview?kind=assignment&id=${typed.id}`);
  assert.ok(p.heading, 'the preview carries the heading');
  assert.ok(Array.isArray(p.heading.titles) && p.heading.titles.includes('Mrs.'), 'Mr/Mrs can be picked');
  assert.equal(p.formatting, 'Times New Roman 12, double spaced');
  assert.match(p.heading.date, /^\d{4}-\d{2}-\d{2}$/, 'the date fills itself in');

  // The heading lands on the document, and the list keeps one item per line.
  assert.match(p.preview_text, /• first point\n\s*• second point/, 'the bullets survive');
  assert.ok(!/\[title\]|\[your name\]/.test(p.preview_text) || !p.heading.student,
    'no placeholder text is ever handed in when the details are filled');

  // Corrections stick, per class.
  await post('/api/heading', {
    class_id: p.class_id, student: 'Will Caldwell',
    teacher_title: 'Mrs.', teacher_name: 'Rivera', class_name: 'AP Gov',
  });
  const after = await get(`/api/submit-preview?kind=assignment&id=${typed.id}`);
  assert.equal(after.heading.student, 'Will Caldwell');
  assert.equal(after.heading.teacher, 'Mrs. Rivera');
  assert.equal(after.heading.class_name, 'AP Gov');
  assert.match(after.preview_text, /Will Caldwell/);
  assert.match(after.preview_text, /Mrs\. Rivera/);
  assert.ok(!/Mrs\. Mrs\./.test(after.preview_text), 'the title is never written twice');

  // Typing the title into the name box sets both rather than doubling up.
  await post('/api/heading', { class_id: p.class_id, teacher_name: 'Mr. Ortiz' });
  const split = await get(`/api/submit-preview?kind=assignment&id=${typed.id}`);
  assert.equal(split.heading.teacher, 'Mr. Ortiz');
  assert.equal(split.heading.teacher_name, 'Ortiz');
});

test('work is pulled forward only when the day was quiet to begin with', () => {
  // Own database so the number of assignments due today can be controlled.
  const { execFileSync } = require('node:child_process');
  const runner = path.join(TMP, 'lookahead.js');
  fs.writeFileSync(runner, [
    "const SRC = process.env.SRC_DIR;",
    "const { getDb } = require(SRC + '/db.js');",
    "const api = require(SRC + '/api.js');",
    "const { todayYmd, addDaysYmd } = require(SRC + '/dates.js');",
    "const db = getDb();",
    "const t = todayYmd();",
    "const later = addDaysYmd(t, 4);",
    "db.prepare(\"INSERT INTO classes (name, canvas_class_id) VALUES ('C','c1')\").run();",
    "const cid = db.prepare('SELECT id FROM classes').get().id;",
    "const add = (title, due) => { db.prepare(\"INSERT INTO assignments (class_id,title,type,status,due_date,points) VALUES (?,?,'regular','todo',?,10)\").run(cid, title, due); return db.prepare('SELECT id FROM assignments WHERE title=?').get(title).id; };",
    "for (let i = 1; i <= 5; i++) add('Later ' + i, later);",
    "const out = {};",
    "// Nothing due today at all: a quiet day, so work comes forward.",
    "out.emptyDay = api.todayPlan().upcoming_count;",
    "const a1 = add('Today 1', t);",
    "const a2 = add('Today 2', t);",
    "out.twoDue = api.todayPlan().upcoming_count;",
    "const a3 = add('Today 3', t);",
    "out.threeDue = api.todayPlan().upcoming_count;",
    "out.scheduled = api.todayPlan().scheduled_today_count;",
    "// Clearing a three-assignment day must NOT summon more work.",
    "[a1, a2, a3].forEach(id => api.completeAssignment(id));",
    "const cleared = api.todayPlan();",
    "out.afterClearing = cleared.upcoming_count;",
    "out.leftToDo = cleared.due_today_count;",
    "out.finished = cleared.finished.length;",
    "out.stillScheduled = cleared.scheduled_today_count;",
    "// Reopening one puts that single assignment back and still no work-ahead.",
    "api.reopenAssignment(a3);",
    "out.afterReopen = api.todayPlan().upcoming_count;",
    "console.log(JSON.stringify(out));",
  ].join(String.fromCharCode(10)));

  const raw = execFileSync(process.execPath, [runner], {
    env: {
      ...process.env,
      SRC_DIR: path.join(__dirname, '..', 'src').split(path.sep).join('/'),
      SLATE_DB_PATH: path.join(TMP, 'lookahead.db'),
      CANVAS_MODE: 'mock',
      SLATE_NO_AI: '1',
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split(String.fromCharCode(10)).pop());

  assert.equal(r.emptyDay, 3, 'an empty day fills up, capped at 3');
  assert.equal(r.twoDue, 3, 'two due today is still quiet enough to work ahead');
  assert.equal(r.threeDue, 0, 'three is a full day — nothing pulled forward');
  assert.equal(r.scheduled, 3);

  assert.equal(r.afterClearing, 0, "clearing a full day does not summon more work");
  assert.equal(r.leftToDo, 0, 'and leaves nothing to do');
  assert.equal(r.finished, 3, 'all three show as finished');
  assert.equal(r.stillScheduled, 3, 'the day still counts as having held three');
  assert.equal(r.afterReopen, 0, 'reopening one does not change what kind of day it was');
});

test('the editor keeps formatting, and plain text stays plain', () => {
  const rich = require('../src/richtext');

  const blocks = rich.parseHtml(
    '<p>Start <b>bold</b> then <i>italic</i> then <span style="font-family: Arial; font-size: 18px">big</span>.</p>'
    + '<ul><li>first</li><li>second <u>under</u></li></ul>'
    + '<p style="text-align:center">Centred.</p>'
  );
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'p');
  assert.deepEqual(blocks[0].runs.map((r) => r.text), ['Start ', 'bold', ' then ', 'italic', ' then ', 'big', '.']);
  assert.equal(blocks[0].runs[1].b, true);
  assert.equal(blocks[0].runs[3].i, true);
  assert.equal(blocks[0].runs[5].font, 'Arial');
  assert.equal(blocks[0].runs[5].size, 13.5, '18px is 13.5pt');
  assert.equal(blocks[1].type, 'ul');
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[2].align, 'center');

  // Plain text is what word counts, the outline and the AI checker read.
  const plain = rich.toPlainText(blocks);
  assert.ok(!/[<>]/.test(plain), 'no tags survive');
  assert.match(plain, /Start bold then italic then big\./);
  assert.match(plain, /• first/);

  // Drafts written before the editor existed open as real paragraphs and lists.
  const back = rich.textToHtml('An answer.\n\n• one\n• two');
  assert.match(back, /<p>An answer\.<\/p>/);
  assert.match(back, /<ul><li>one<\/li><li>two<\/li><\/ul>/);

  // Nothing to lose: an empty editor is empty, not a stray paragraph.
  assert.equal(rich.isEmpty(rich.parseHtml('<p></p><p><br></p>')), true);
  assert.equal(rich.isEmpty(rich.parseHtml('<p>x</p>')), false);
});

test('MLA is the default, and picking a font overrides it in the real file', async () => {
  const og = require('../src/officegen');
  const { buildEssay } = require('../src/mla');
  const rich = require('../src/richtext');
  const zlib = require('node:zlib');
  const entry = (buf, name) => {
    let i = 0;
    while (i < buf.length - 4) {
      if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
      const cs = buf.readUInt32LE(i + 18), nl = buf.readUInt16LE(i + 26), el = buf.readUInt16LE(i + 28);
      const n = buf.slice(i + 30, i + 30 + nl).toString('utf8');
      const ds = i + 30 + nl + el;
      if (n === name) return zlib.inflateRawSync(buf.slice(ds, ds + cs)).toString('utf8');
      i = ds + cs;
    }
    return null;
  };
  const blocks = rich.parseHtml('<p>Normal with <b>bold</b> and <i>italic</i>.</p><ul><li>one</li><li>two</li></ul>');
  const base = { draft: 'Normal with bold and italic.', blocks, student: 'Will Caldwell', teacher: 'Mr. Nunes', className: 'AP U.S. Government', date: '2026-08-14', title: 'T' };

  // Untouched: MLA.
  const mla = entry(og.buildMlaDocx(buildEssay(base)), 'word/styles.xml');
  assert.match(mla, /w:ascii="Times New Roman"/);
  assert.match(mla, /w:sz w:val="24"/, '12pt is 24 half-points');

  // Chosen: theirs.
  const mine = og.buildMlaDocx(buildEssay({ ...base, font: 'Arial', size: 14 }));
  const styles = entry(mine, 'word/styles.xml');
  assert.match(styles, /w:ascii="Arial"/);
  assert.match(styles, /w:sz w:val="28"/, '14pt is 28 half-points');

  // Formatting inside the writing survives either way.
  const doc = entry(mine, 'word/document.xml');
  assert.match(doc, /<w:b\/>/, 'bold made it into the file');
  assert.match(doc, /<w:i\/>/, 'italic made it into the file');
  assert.equal((doc.match(/w:hanging="360"/g) || []).length, 2, 'both list items are list-indented');
  assert.match(doc, /w:line="480"/, 'still double spaced');
});

test('a heading typed on its own line stays on its own line', () => {
  const rich = require('../src/richtext');

  // Will's actual assignment shape: a short label, then the paragraph under it.
  // Joining those (the normal soft-wrap rule) read as a mistake on the page.
  const blocks = rich.parseHtml(rich.textToHtml(
    'Big Idea: \nJames Madison says that faction is the biggest threat.\n\nConnection:\n\nTerm: Faction'
  ));
  const texts = blocks.map((b) => rich.runsText(b.runs));
  assert.equal(texts[0], 'Big Idea:');
  assert.match(texts[1], /^James Madison says/);
  assert.equal(texts[2], 'Connection:');

  // A long first line ending in a colon is prose, not a heading — leave it be.
  const prose = rich.parseHtml(rich.textToHtml(
    'He made the point in the clearest way anyone had managed all semester, which was this:\nthat factions cannot be removed.'
  ));
  assert.equal(prose.length, 1, 'that is one paragraph, not a heading and a paragraph');

  // Numbered points with blank lines between them are ONE list. Before this,
  // each was its own list and every question rendered as "1.".
  const questions = rich.parseHtml(rich.textToHtml(
    '1. First question?\n\n2. Second question?\n\n3. Third question?'
  ));
  assert.equal(questions.length, 1);
  assert.equal(questions[0].type, 'ol');
  assert.equal(questions[0].items.length, 3);
});

test('Word, PDF and text all render the same document', () => {
  const og = require('../src/officegen');
  const mla = require('../src/mla');
  const rich = require('../src/richtext');
  const zlib = require('node:zlib');

  const html = rich.textToHtml('Big Idea:\nThe point of it all.\n\n1. First?\n\n2. Second?\n\n3. Third?');
  const doc = mla.buildEssay({
    draft: rich.toPlainText(rich.parseHtml(html)),
    blocks: rich.parseHtml(html),
    student: 'William Caldwell', teacher: 'Mr. Nunes',
    className: 'AP U.S. Government', date: '2026-08-13', title: 'Summer Reading',
  });

  // Plain text
  const text = mla.toText(doc);
  assert.match(text, /Big Idea:\n\nThe point of it all\./, 'the heading keeps its own line');
  assert.ok(!/^ +\S/m.test(text), 'and nothing is auto-indented any more');
  assert.match(text, /1\. First\?/);
  assert.match(text, /2\. Second\?/);
  assert.match(text, /3\. Third\?/, 'the numbering runs 1-2-3, not 1-1-1');

  // Word
  const entry = (buf, name) => {
    let i = 0;
    while (i < buf.length - 4) {
      if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
      const cs = buf.readUInt32LE(i + 18), nl = buf.readUInt16LE(i + 26), el = buf.readUInt16LE(i + 28);
      const n = buf.slice(i + 30, i + 30 + nl).toString('utf8');
      const ds = i + 30 + nl + el;
      if (n === name) return zlib.inflateRawSync(buf.slice(ds, ds + cs)).toString('utf8');
      i = ds + cs;
    }
    return null;
  };
  const xml = entry(og.buildMlaDocx(doc), 'word/document.xml');
  const paras = [...xml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)].map((m) => m[1]);
  assert.ok(paras.includes('Big Idea:'), 'the heading is its own paragraph in Word');
  assert.ok(paras.some((t) => /^1\. /.test(t)) && paras.some((t) => /^3\. /.test(t)),
    'Word numbers them 1 through 3');

  // PDF
  const pdf = og.buildMlaPdf(doc).toString('latin1');
  assert.match(pdf, /^%PDF-/);
  const shown = [...pdf.matchAll(/\((.*?)\)\s*Tj/g)].map((m) => m[1]);
  assert.ok(shown.includes('Big Idea:'), 'the heading is its own line in the PDF');
  assert.ok(shown.some((t) => /^3\. Third/.test(t)), 'the PDF numbers them too');
});

test('the page the paginator measures is never given a fixed height', () => {
  // The preview splits pages by asking .page-body how tall it is. Give that
  // element a CSS height and it reports a full page whether it holds one line
  // or thirty — which put every single block on a page of its own. The test
  // harness has no layout engine and cannot catch that, so this reads the
  // stylesheet instead.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const rule = /\.page-body\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.page-body is still styled');
  assert.ok(!/(^|;|\s)height\s*:/.test(rule[1]),
    '.page-body must stay auto-height — the paginator measures it: ' + rule[1].trim());
  assert.match(rule[1], /padding:\s*96px/, 'and keep its 1-inch margins');

  // The page around it is the fixed one, and it clips.
  const page = /\.page\s*\{([^}]*)\}/.exec(css);
  assert.ok(page, '.page is still styled');
  assert.match(page[1], /height:\s*1056px/, '11 inches at 96dpi');
  assert.match(page[1], /width:\s*816px/, '8.5 inches at 96dpi');
  assert.match(page[1], /overflow:\s*hidden/, 'the page clips what runs past it');

  // And the app measures the body against the whole page, not the text area,
  // because offsetHeight of the body includes its own padding.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /body\.offsetHeight > PAGE_H\b/,
    'pagination compares the body height against the full page height');
});

test('nothing auto-indents: paragraphs start at the margin in every format', () => {
  const og = require('../src/officegen');
  const mla = require('../src/mla');
  const rich = require('../src/richtext');
  const zlib = require('node:zlib');
  const entry = (buf, name) => {
    let i = 0;
    while (i < buf.length - 4) {
      if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
      const cs = buf.readUInt32LE(i + 18), nl = buf.readUInt16LE(i + 26), el = buf.readUInt16LE(i + 28);
      const n = buf.slice(i + 30, i + 30 + nl).toString('utf8');
      const ds = i + 30 + nl + el;
      if (n === name) return zlib.inflateRawSync(buf.slice(ds, ds + cs)).toString('utf8');
      i = ds + cs;
    }
    return null;
  };
  const html = rich.textToHtml('A first paragraph.\n\nA second one.\n\n1. A point\n\n2. Another');
  const doc = mla.buildEssay({
    draft: rich.toPlainText(rich.parseHtml(html)), blocks: rich.parseHtml(html),
    student: 'W C', teacher: 'Mr. N', className: 'Gov', date: '2026-08-14', title: 'T',
  });

  const xml = entry(og.buildMlaDocx(doc), 'word/document.xml');
  assert.ok(!/firstLine/.test(xml), 'Word gets no first-line indent');
  assert.equal((xml.match(/w:hanging="360"/g) || []).length, 2, 'but list items are still list-indented');

  assert.ok(!/^ +\S/m.test(mla.toText(doc)), 'the plain text starts at the margin');

  // The same for a plain draft with no formatted version.
  const plain = mla.buildEssay({ draft: 'One.\n\nTwo.', student: 'W C', teacher: 'Mr. N', className: 'Gov', date: '2026-08-14', title: 'T' });
  assert.ok(!/firstLine/.test(entry(og.buildMlaDocx(plain), 'word/document.xml')));
  assert.ok(!/^ +\S/m.test(mla.toText(plain)));

  // And the on-screen page.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const rule = /\.doc-para\s*\{([^}]*)\}/.exec(css);
  assert.ok(!rule || !/text-indent\s*:\s*[1-9]/.test(rule[1]), 'the preview does not indent either');
});

test('unfinished work carries over instead of vanishing at midnight', () => {
  const { execFileSync } = require('node:child_process');
  const runner = path.join(TMP, 'carryover.js');
  fs.writeFileSync(runner, [
    "const SRC = process.env.SRC_DIR;",
    "const { getDb } = require(SRC + '/db.js');",
    "const api = require(SRC + '/api.js');",
    "const { todayYmd, addDaysYmd } = require(SRC + '/dates.js');",
    "const db = getDb();",
    "const t = todayYmd();",
    "db.prepare(\"INSERT INTO classes (name, canvas_class_id) VALUES ('C','c1')\").run();",
    "const cid = db.prepare('SELECT id FROM classes').get().id;",
    "const add = (title, due, status) => { db.prepare(\"INSERT INTO assignments (class_id,title,type,status,due_date,points) VALUES (?,?,'regular',?,?,10)\").run(cid, title, status || 'todo', due); return db.prepare('SELECT id FROM assignments WHERE title=?').get(title).id; };",
    "const late = add('Missed on Monday', addDaysYmd(t, -3));",
    "add('Due today', t);",
    "add('Handed in late', addDaysYmd(t, -2), 'done');",
    "add('Next week', addDaysYmd(t, 5));",
    "const out = {};",
    "const plan = api.todayPlan();",
    "out.titles = plan.assignments.map(a => a.title);",
    "out.overdue = plan.assignments.filter(a => a.overdue).map(a => a.title);",
    "out.daysLate = (plan.assignments.find(a => a.overdue) || {}).days_late;",
    "out.overdueCount = plan.overdue_count;",
    "out.scheduled = plan.scheduled_today_count;",
    "api.completeAssignment(late);",
    "const after = api.todayPlan();",
    "out.afterDoing = after.assignments.map(a => a.title);",
    "out.inFinished = after.finished.map(a => a.title);",
    "console.log(JSON.stringify(out));",
  ].join(String.fromCharCode(10)));

  const raw = execFileSync(process.execPath, [runner], {
    env: {
      ...process.env,
      SRC_DIR: path.join(__dirname, '..', 'src').split(path.sep).join('/'),
      SLATE_DB_PATH: path.join(TMP, 'carryover.db'),
      CANVAS_MODE: 'mock', SLATE_NO_AI: '1',
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split(String.fromCharCode(10)).pop());

  assert.ok(r.titles.includes('Missed on Monday'), 'work never handed in still shows up');
  assert.ok(r.titles.includes('Due today'));
  assert.ok(!r.titles.includes('Handed in late'), 'work that IS done does not come back');
  assert.equal(r.titles[0], 'Missed on Monday', 'and it sorts to the top — it is the most urgent');
  assert.deepEqual(r.overdue, ['Missed on Monday']);
  assert.equal(r.daysLate, 3);
  assert.equal(r.overdueCount, 1);
  assert.equal(r.scheduled, 2, 'carried-over work counts toward how busy the day is');

  assert.ok(!r.afterDoing.includes('Missed on Monday'), 'doing it clears it');
  assert.ok(r.inFinished.includes('Missed on Monday'), 'and it lands in what you finished today');
});

test('Canvas saying it is turned in counts as done', () => {
  // Sandboxed: own process, own database, mock Canvas. Never the real one.
  const { execFileSync } = require('node:child_process');
  const runner = path.join(TMP, 'submitted.js');
  fs.writeFileSync(runner, [
    "const SRC = process.env.SRC_DIR;",
    "const { getDb } = require(SRC + '/db.js');",
    "const mock = require(SRC + '/canvas/mockCanvas.js');",
    "const { sync } = require(SRC + '/sync.js');",
    "const { todayYmd, addDaysYmd } = require(SRC + '/dates.js');",
    "(async () => {",
    "  const t = todayYmd();",
    "  const yesterday = addDaysYmd(t, -1);",
    "  await sync();",
    "  const db = getDb();",
    "  const before = db.prepare(\"SELECT id, canvas_assignment_id, status FROM assignments WHERE type='regular' AND status='todo' LIMIT 2\").all();",
    "  // Canvas now reports one handed in and one still not.",
    "  const realSubs = mock.listSubmissions;",
    "  mock.listSubmissions = async (courseId) => {",
    "    const base = await realSubs(courseId);",
    "    return base.concat([",
    "      { assignment_id: Number(before[0].canvas_assignment_id), workflow_state: 'submitted', submitted_at: yesterday + 'T14:00:00Z' },",
    "      { assignment_id: Number(before[1].canvas_assignment_id), workflow_state: 'unsubmitted', submitted_at: null },",
    "    ]);",
    "  };",
    "  await sync();",
    "  const after = before.map(b => db.prepare('SELECT status, completed_day FROM assignments WHERE id=?').get(b.id));",
    "  console.log(JSON.stringify({ submitted: after[0], notSubmitted: after[1], yesterday }));",
    "})();",
  ].join(String.fromCharCode(10)));

  const raw = execFileSync(process.execPath, [runner], {
    env: {
      ...process.env,
      SRC_DIR: path.join(__dirname, '..', 'src').split(path.sep).join('/'),
      SLATE_DB_PATH: path.join(TMP, 'submitted.db'),
      CANVAS_MODE: 'mock', SLATE_NO_AI: '1',
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(raw.trim().split(String.fromCharCode(10)).pop());

  assert.equal(r.submitted.status, 'done', 'Canvas has it, so it is done');
  assert.equal(r.submitted.completed_day, r.yesterday, 'stamped the day Canvas received it');
  assert.equal(r.notSubmitted.status, 'todo', 'nothing turned in, so it carries over');
  assert.equal(r.notSubmitted.completed_day, null);
});



// ---- sources, and a receipt short enough to read -------------------------
test('the receipt collapses whole-box changes instead of listing each one', () => {
  const { summarise } = require('../src/proofread');
  const box = (b) => ({ kind: 'rewrite', box: b, replace: 'x'.repeat(200), why: '' });
  // Four slides used to print four bullet lines. Will asked for "added bullet
  // points for slides 2-4" instead, and a run of numbers is what reads.
  const note = summarise([box('slide2.bullets'), box('slide3.bullets'), box('slide4.bullets')], []);
  assert.equal(note, 'Updated bullets on slides 2-4.');
  assert.ok(!note.includes('•'), 'no per-change list for whole-box edits');

  const mixed = summarise([box('slide1.notes'), box('slide2.notes'), box('slide5.title')], []);
  assert.match(mixed, /notes on slides 1 and 2/);
  assert.match(mixed, /title on slide 5/);

  // Word-level fixes keep their before/after — that IS the information.
  const words = summarise([{ kind: 'replace', find: 'teh', replace: 'the', why: 'spelling', count: 1, total: 1 }], []);
  assert.match(words, /"teh" → "the"/);

  // A refusal is still spelled out whatever else happened.
  const refused = summarise([box('slide7.notes')], [{ find: 'x', reason: 'could not find that text in the draft' }]);
  assert.match(refused, /Left alone/);
});

test('sources come back as data, and only real links survive', () => {
  const { readAnswer } = require('../src/assignmentChat');
  const allowed = new Set(['slide2.bullets', 'slide2.notes']);
  const a = readAnswer(JSON.stringify({
    reply: 'Added bullets to slide 2.',
    edits: [],
    sources: [
      { title: 'Senate', url: 'https://senate.gov/x', where: 'slide2.bullets', quote: 'Big states' },
      { title: 'nasty', url: 'javascript:alert(1)', where: 'slide2.bullets' },
      { title: 'local', url: 'file:///c:/secrets.txt' },
      { title: 'real but unknown box', url: 'https://example.com', where: 'slide99.title' },
    ],
  }), { allowed });

  // The list is rendered as clickable links, so anything that is not http(s)
  // is a way to get something nasty onto the page from a model reply.
  assert.equal(a.sources.length, 2, 'javascript: and file: urls must be dropped');
  assert.equal(a.sources[0].where, 'slide2.bullets');
  // A box that is not on this page would highlight nothing, so the link stays
  // but loses its anchor rather than looking broken.
  assert.equal(a.sources[1].where, '');
});

test('a Sources block written into the reply is stripped, not shown twice', () => {
  const { readAnswer } = require('../src/assignmentChat');
  const a = readAnswer(JSON.stringify({
    reply: 'Added bullets to slide 2.\n\nSources:\n- https://senate.gov/x',
    sources: [{ title: 'Senate', url: 'https://senate.gov/x' }],
  }));
  assert.equal(a.reply, 'Added bullets to slide 2.');

  // A reply that merely uses the word is left alone.
  const b = readAnswer(JSON.stringify({ reply: 'Check your sources:\nthe textbook is fine.' }));
  assert.match(b.reply, /textbook is fine/);
});

test('the prompt says the assignment came from Canvas', () => {
  const { buildPrompt } = require('../src/assignmentChat');
  // Without this the model answered "I cannot open Canvas myself" to a question
  // about the Canvas assignment it was holding.
  const p = buildPrompt({ title: 'Essay', raw_description: 'Write it.' }, [], 'what does canvas say');
  assert.match(p, /IS the Canvas assignment/);
  assert.match(p, /Never claim you cannot see Canvas/);
});

test('speaker notes never belong in a bullets box', () => {
  const { buildPrompt } = require('../src/assignmentChat');
  const row = {
    build_mode: 'slides',
    slides_json: JSON.stringify([{ title: 'A', bullets: ['x'] }, { title: 'B', bullets: ['y'] }]),
  };
  const p = buildPrompt(row, [], 'add notes for each bullet point');
  // "notes for each bullet" is the phrasing that put prose into the bullets.
  assert.match(p, /NEVER PUT THEM IN \.bullets/);
  assert.match(p, /still means slideN\.notes/);
});
// ---- speaker notes -------------------------------------------------------
// Notes live in their own parts in a .pptx, and getting the package wrong is
// silent until PowerPoint refuses the whole file. These pin the four pieces.
function pptxPartNames(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) === 0x04034b50) {
      const nlen = buf.readUInt16LE(i + 26);
      const elen = buf.readUInt16LE(i + 28);
      out.push(buf.toString('utf8', i + 30, i + 30 + nlen));
      i = i + 30 + nlen + elen + buf.readUInt32LE(i + 18);
    } else i++;
  }
  return out;
}

test('speaker notes reach the PowerPoint as real notes parts', () => {
  const og = require('../src/officegen');
  const buf = og.buildPptx([
    { title: 'Deck', bullets: ['Class'], notes: 'Open with a question.' },
    { title: 'Second', bullets: ['a', 'b'] },
    { title: 'Third', bullets: ['c'], notes: 'Two lines.\nSecond line.' },
  ], {});
  const names = pptxPartNames(buf);

  // One notes part per slide that HAS notes — slide 2 has none and must not
  // get an empty one, or PowerPoint shows a deck where every slide has notes.
  assert.ok(names.includes('ppt/notesSlides/notesSlide1.xml'));
  assert.ok(!names.includes('ppt/notesSlides/notesSlide2.xml'), 'slide 2 has no notes');
  assert.ok(names.includes('ppt/notesSlides/notesSlide3.xml'));
  assert.ok(names.includes('ppt/notesMasters/notesMaster1.xml'));

  // THE NOTES MASTER MUST HAVE ITS OWN THEME PART. Pointing it at theme1,
  // which the slide master already owns, made PowerPoint call the entire file
  // corrupt and refuse to open it. Found with COM; there is no way to see it
  // from the XML alone.
  assert.ok(names.includes('ppt/theme/theme2.xml'), 'notes master needs its own theme');
  const nmRels = unzipEntry(buf, 'ppt/notesMasters/_rels/notesMaster1.xml.rels');
  assert.match(nmRels, /theme2\.xml/);

  // Declared, and related both ways.
  const ct = unzipEntry(buf, '[Content_Types].xml');
  assert.ok(ct.includes('/ppt/notesSlides/notesSlide1.xml'));
  assert.ok(ct.includes('/ppt/notesMasters/notesMaster1.xml'));
  assert.ok(ct.includes('/ppt/theme/theme2.xml'));
  assert.match(unzipEntry(buf, 'ppt/slides/_rels/slide1.xml.rels'), /notesSlide1\.xml/);
  const nsRels = unzipEntry(buf, 'ppt/notesSlides/_rels/notesSlide1.xml.rels');
  assert.match(nsRels, /slides\/slide1\.xml/);
  assert.match(nsRels, /notesMaster1\.xml/);

  // p:presentation is a SEQUENCE: notesMasterIdLst goes after sldMasterIdLst
  // and before sldIdLst. Anywhere else is a schema violation and a repair prompt.
  const pres = unzipEntry(buf, 'ppt/presentation.xml');
  assert.ok(pres.indexOf('<p:sldMasterIdLst>') < pres.indexOf('<p:notesMasterIdLst>'));
  assert.ok(pres.indexOf('<p:notesMasterIdLst>') < pres.indexOf('<p:sldIdLst>'));

  const xml = unzipEntry(buf, 'ppt/notesSlides/notesSlide3.xml');
  assert.match(xml, /Two lines\./);
  assert.match(xml, /Second line\./, 'each line is its own paragraph');
});

test('a deck with no notes builds no notes machinery at all', () => {
  const og = require('../src/officegen');
  const buf = og.buildPptx([{ title: 'A', bullets: ['x'] }, { title: 'B', bullets: ['y'] }], {});
  const names = pptxPartNames(buf);
  assert.ok(!names.some((x) => x.includes('notesSlide')));
  assert.ok(!names.some((x) => x.includes('notesMaster')));
  assert.ok(!names.includes('ppt/theme/theme2.xml'));
  assert.ok(!/notesMasterIdLst/.test(unzipEntry(buf, 'ppt/presentation.xml')));
  // Whitespace is not notes.
  const blank = og.buildPptx([{ title: 'A', bullets: ['x'], notes: '   \n ' }], {});
  assert.ok(!pptxPartNames(blank).some((x) => x.includes('notesSlide')));
});

test('notes survive a save, and are a box the chat can name', () => {
  const chat = require('../src/assignmentChat');
  const slides = [
    { title: 'One', bullets: ['a'], notes: 'first note' },
    { title: 'Two', bullets: ['b'], notes: '' },
  ];
  const row = { build_mode: 'slides', slides_json: JSON.stringify(slides), title: 'Deck' };
  const p = chat.buildPrompt(row, [], 'hi');
  assert.match(p, /slide1\.notes/);
  assert.match(p, /slide2\.notes/);
  assert.match(p, /do NOT appear on the slide/i, 'the prompt has to say what notes are');
  assert.match(p, /first note/, 'existing notes are sent so an edit can find them');
});
// ---- Ask Claude ----------------------------------------------------------
// The chat is the one place in Slate where the student types freely at a model
// that knows their assignment AND their draft. What keeps it on the right side
// of the no-ghostwriting rule is entirely in the prompt, so the prompt gets
// pinned here the same way aiCheck's "no reasons list" rule is.
test('the chat prompt refuses to write the assignment, in as many words', () => {
  const chat = require('../src/assignmentChat');
  const rules = chat.TUTOR_RULES;
  assert.match(rules, /NEVER write any part of the assignment/,
    'the ban has to be stated, not implied');
  assert.match(rules, /If they ask you to write it/,
    'it must refuse on request rather than quietly complying');
  assert.match(rules, /no thesis statements/i);
  assert.match(rules, /Rewriting it is not/,
    'quoting the draft is fine, rewriting it is the line');
});

test('the chat sends the assignment, the draft and the history', () => {
  const chat = require('../src/assignmentChat');
  const p = chat.buildPrompt(
    {
      title: 'Founding Document Analysis',
      class_name: 'English IV',
      raw_description: '<p>Pick a document and analyse it.</p>',
      attachment_text: 'RUBRIC: five paragraphs minimum.',
      draft_text: 'The Constitution was built out of compromise.',
    },
    [{ role: 'you', text: 'where do I start?' }, { role: 'claude', text: 'pick the document first' }],
    'is my thesis strong enough?'
  );
  assert.ok(p.includes('Founding Document Analysis'), 'the assignment');
  assert.ok(p.includes('Pick a document and analyse it.'), 'instructions, with the HTML stripped');
  assert.ok(!p.includes('<p>'), 'no raw HTML goes to the model');
  assert.ok(p.includes('RUBRIC: five paragraphs minimum.'), 'what was in the attached file');
  assert.ok(p.includes('The Constitution was built out of compromise.'), 'the draft');
  assert.ok(p.includes('where do I start?') && p.includes('pick the document first'), 'the conversation so far');
  assert.ok(p.includes('is my thesis strong enough?'), 'and the new question');
  assert.match(p, /\{"reply"/, 'structured output, per round 18 — never raw stdout');
});

test('an empty draft says so rather than pretending there is one', () => {
  const chat = require('../src/assignmentChat');
  const p = chat.buildPrompt({ title: 'x', draft_text: '' }, [], 'help');
  assert.match(p, /has not written anything yet/);
});

test('the chat reply survives whatever wrapping Claude puts round it', () => {
  const { readReply } = require('../src/assignmentChat');
  assert.equal(readReply('{"reply":"plain answer"}'), 'plain answer');
  assert.equal(readReply('Sure!\n{"reply":"the answer"}'), 'the answer',
    'a preamble outside the JSON is discarded');
  // Claude Code appends its own "Sources:" block after the JSON, which the
  // parser drops — which is why the prompt asks for sources INSIDE the string.
  assert.equal(readReply('{"reply":"answer"}\n\nSources:\n- https://example.com'), 'answer');
  assert.equal(readReply('{"reply":"line one\nline two"}'), 'line one\nline two',
    'a real newline inside the string is repaired, not a parse failure');
  assert.equal(readReply('it just talked instead'), 'it just talked instead',
    'ignoring the JSON must not lose the whole message');
  assert.equal(readReply('  '), null, 'nothing at all is a failure');
});

test('chat history is trimmed from the front, never the back', () => {
  const { transcript } = require('../src/assignmentChat');
  const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'claude' : 'you', text: 'msg ' + i }));
  const t = transcript(many);
  assert.ok(t.includes('msg 39'), 'the newest turn always survives');
  assert.ok(!t.includes('msg 0'), 'the oldest falls off');
  assert.ok(t.split('\n\n').length <= 12);
});

// Will's own ~/.claude/settings.json injects his working rules ("start every
// reply with hey will") into EVERY claude on this machine, this app's hidden
// calls included. That is the actual source of the round 18 bug. Asserted on
// the source because the leak only shows up against a real CLI.
test('the hidden claude never loads the machine owner personal settings', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'claude.js'), 'utf8');
  assert.match(src, /'--setting-sources',\s*''/,
    'viaCli must pass --setting-sources "" or personal instructions leak into student-facing text');
  const call = src.slice(src.indexOf('function viaCli'), src.indexOf('function viaCli') + 700);
  assert.ok(call.includes('NO_PERSONAL_SETTINGS'), 'and it has to be on the args the spawn actually uses');
});

// ---- proofreading --------------------------------------------------------
// The ONLY path where a model changes what Will wrote. The prompt asks for
// mechanical corrections; proofread.js is what actually enforces it, so this is
// the guardrail and it gets tested like one.
test('proofreading lets an ordinary correction through', () => {
  const { applyEdits } = require('../src/proofread');
  const draft = 'Their going to the shop. i saw it hapen yesterday.';
  const out = applyEdits({ html: null, text: draft }, [
    { find: 'Their going', replace: 'They are going', why: 'wrong word' },
    { find: 'i saw', replace: 'I saw', why: 'capital I' },
    { find: 'hapen', replace: 'happen', why: 'spelling' },
  ]);
  assert.equal(out.applied.length, 3);
  assert.equal(out.skipped.length, 0);
  assert.equal(out.text, 'They are going to the shop. I saw it happen yesterday.');
});

test('proofreading refuses to rewrite a sentence', () => {
  const { applyEdits } = require('../src/proofread');
  const draft = 'The war was bad and lots of people died because of it in the end.';
  const out = applyEdits({ html: null, text: draft }, [{
    find: 'The war was bad and lots of people died because of it in the end.',
    replace: 'The conflict proved catastrophic, claiming countless lives before its conclusion.',
    why: 'stronger wording',
  }]);
  assert.equal(out.applied.length, 0, 'a reword must never reach the draft');
  assert.equal(out.text, draft, 'the draft is untouched');
  assert.match(out.skipped[0].reason, /rewrites the sentence|adds new writing/);
});

test('proofreading refuses text that is not already in the draft', () => {
  const { applyEdits } = require('../src/proofread');
  const draft = 'One short line.';
  // Passes the mechanical test on its own, so this isolates the other gate:
  // the text being corrected has to be the student's, sitting in the draft.
  const out = applyEdits({ html: null, text: draft }, [
    { find: 'teh', replace: 'the', why: 'spelling' },
  ]);
  assert.equal(out.applied.length, 0);
  assert.equal(out.text, draft);
  assert.match(out.skipped[0].reason, /could not find/);

  // And inventing a whole new sentence — the shape a ghostwriter would use —
  // is refused whichever gate catches it first.
  const invented = applyEdits({ html: null, text: draft }, [
    { find: 'A sentence that is not there', replace: 'Something brand new', why: 'add' },
  ]);
  assert.equal(invented.applied.length, 0);
  assert.equal(invented.text, draft);
});

test('proofreading will not replace something that appears twice', () => {
  const { applyEdits } = require('../src/proofread');
  // Ambiguous: Slate cannot tell which one was meant, so it changes neither.
  const out = applyEdits({ html: null, text: 'teh cat and teh dog' }, [
    { find: 'teh', replace: 'the', why: 'spelling' },
  ]);
  assert.equal(out.applied.length, 0);
  assert.equal(out.text, 'teh cat and teh dog');
});

test('proofreading counts a punctuation-only change as safe however long', () => {
  const { applyEdits, onlyPunctuationOrCase } = require('../src/proofread');
  const long = 'however the evidence is clear and the argument holds up under scrutiny';
  assert.ok(onlyPunctuationOrCase(long, 'However, the evidence is clear, and the argument holds up under scrutiny.'));
  const out = applyEdits({ html: null, text: long + ' end' }, [
    { find: long, replace: 'However, the evidence is clear, and the argument holds up under scrutiny.', why: 'commas' },
  ]);
  assert.equal(out.applied.length, 1, 'same words, only punctuation and capitals moved');
});

test('proofreading caps how much can change at once', () => {
  const { applyEdits, MAX_EDITS, MAX_FIND_CHARS } = require('../src/proofread');
  const many = Array.from({ length: MAX_EDITS + 5 }, (_, i) => ({ find: 'w' + i, replace: 'x' + i, why: '' }));
  const out = applyEdits({ html: null, text: many.map((e) => e.find).join(' ') }, many);
  assert.ok(out.applied.length <= MAX_EDITS, 'no more than MAX_EDITS in one message');
  assert.ok(out.skipped.some((s) => /too many/.test(s.reason)));
  // And no single edit may swallow a paragraph.
  const para = 'x'.repeat(MAX_FIND_CHARS + 10);
  const big = applyEdits({ html: null, text: para }, [{ find: para, replace: para + '!', why: '' }]);
  assert.equal(big.applied.length, 0);
  assert.match(big.skipped[0].reason, /too much text/);
});

test('proofreading edits the formatted draft, entities and all', () => {
  const { applyEdits } = require('../src/proofread');
  const html = '<p>Fish &amp; chips is teh best.</p>';
  const out = applyEdits({ html, text: 'Fish & chips is teh best.' }, [
    { find: 'teh', replace: 'the', why: 'spelling' },
  ]);
  assert.equal(out.applied.length, 1);
  assert.equal(out.html, '<p>Fish &amp; chips is the best.</p>');
  assert.ok(!out.html.includes('&amp;amp;'), 'the entity must not be double-escaped');
  // A phrase whose & is escaped in the markup still has to be findable.
  const amp = applyEdits({ html, text: 'Fish & chips is teh best.' }, [
    { find: 'Fish & chips is', replace: 'Fish and chips is', why: 'spell it out' },
  ]);
  assert.equal(amp.applied.length, 1);
  assert.equal(amp.html, '<p>Fish and chips is teh best.</p>');
});

test('the transcript reports what actually changed, not what Claude claimed', () => {
  const { applyEdits, summarise } = require('../src/proofread');
  const out = applyEdits({ html: null, text: 'i went home.' }, [
    { find: 'i went', replace: 'I went', why: 'capital I' },
    { find: 'i went home.', replace: 'I made my way back to the house that evening.', why: 'nicer' },
  ]);
  const note = summarise(out.applied, out.skipped);
  assert.match(note, /Changed in your draft/);
  assert.match(note, /Left alone/, 'a refused edit has to be reported, not silently dropped');
  assert.ok(!out.text.includes('made my way back'));
});

test('the chat prompt allows corrections and bans rewriting in the same breath', () => {
  const { TUTOR_RULES, readEdits } = require('../src/assignmentChat');
  assert.match(TUTOR_RULES, /ONLY mechanical corrections/);
  assert.match(TUTOR_RULES, /NEVER use edits to reword, improve, tighten, expand or restructure/);
  assert.match(TUTOR_RULES, /Making their writing better IS writing it for them/);
  // Edits only ever come out of real JSON: a reply that ignored the format
  // must not be able to change the draft.
  assert.deepEqual(readEdits('just some prose about your draft'), []);
  assert.deepEqual(readEdits('{"reply":"ok","edits":[{"find":"a","replace":"b","why":"c"}]}'),
    [{ find: 'a', replace: 'b', why: 'c' }]);
  assert.deepEqual(readEdits('{"reply":"ok"}'), []);
});

// Two tools, and only those two. This is the second place in Slate that hands
// Claude Code the web; it has no business reading or writing this machine.
test('the chat gets the web and nothing else', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'assignmentChat.js'), 'utf8');
  assert.match(src, /const CHAT_TOOLS = 'WebSearch,WebFetch';/,
    'exactly those two tools — adding one here hands the machine over');
  // Whatever the constant says, the tool list actually handed to Claude has to
  // be that constant and nothing else.
  const passed = [...src.matchAll(/allowedTools:\s*([A-Za-z_'"][^,\n]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(passed, ['CHAT_TOOLS'], 'the only tool list passed is CHAT_TOOLS');
});
