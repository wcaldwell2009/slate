'use strict';
// Full-app exerciser: walks every endpoint and flow the UI can reach.
// Usage: node drive.js <baseUrl> <scratchDir> <projectDir>

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = process.argv[2];
const SCRATCH = process.argv[3];
const PROJ = process.argv[4];

let pass = 0;
const failures = [];
const section = (s) => console.log('\n=== ' + s + ' ===');
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
// Accounts mean cookies. `jar` is what an anonymous browser sends; pass an
// explicit cookie string to act as somebody signed in.
let jar = '';
function headersFor(cookie, json) {
  const h = {};
  if (json) h['content-type'] = 'application/json';
  const c = cookie === undefined ? jar : cookie;
  if (c) h.cookie = c;
  return h;
}
async function get(p, cookie) {
  const r = await fetch(BASE + p, { headers: headersFor(cookie, false) });
  return { status: r.status, body: await r.json() };
}
async function post(p, b, cookie) {
  const r = await fetch(BASE + p, { method: 'POST', headers: headersFor(cookie, true), body: JSON.stringify(b || {}) });
  const setCookie = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json(), setCookie };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unzipEntry(buf, name) {
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
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

(async () => {
  // ---------------------------------------------------------------- status
  section('Status + sync');
  let r = await get('/api/status');
  check('GET /api/status 200', r.status === 200);
  check('status has last_sync', !!r.body.last_sync);
  check('status canvas_mode=mock', r.body.canvas_mode === 'mock');
  check('status has today date', /^\d{4}-\d{2}-\d{2}$/.test(r.body.today || ''));

  const beforeSync = (await get('/api/classes')).body.length;
  r = await post('/api/sync');
  check('POST /api/sync ok', r.body.ok === true);
  check('sync idempotent (class count unchanged)', (await get('/api/classes')).body.length === beforeSync);

  // ---------------------------------------------------------------- today
  section('Today page');
  let plan = (await get('/api/today')).body;
  check('today returns a plan object', !!plan && Array.isArray(plan.assignments));
  check('today target is 120 min', plan.target_minutes === 120);
  check('every assignment has an id/title/minutes',
    plan.assignments.every((a) => a.id && a.title && a.minutes >= 10));
  check('assignment_minutes matches the sum',
    plan.assignment_minutes === plan.assignments.reduce((s, a) => s + a.minutes, 0));
  check('total = assignments + projects',
    plan.total_minutes === plan.assignment_minutes + plan.project_minutes);
  const impact = (await get('/api/today?sort=impact')).body.assignments;
  // Overdue first, then today's, then work-ahead — impact orders within a band.
  const band = (a) => (a.upcoming ? 2 : a.overdue ? 0 : 1);
  let sorted = true, banded = true;
  for (let i = 1; i < impact.length; i++) {
    if (band(impact[i - 1]) > band(impact[i])) banded = false;
    if (band(impact[i - 1]) === band(impact[i]) && impact[i - 1].impact < impact[i].impact) sorted = false;
  }
  check('late work sorts above today, and work-ahead below it', banded,
    impact.map((a) => `${band(a)}:${a.title.slice(0, 18)}`).join(' | '));
  check('impact sort is descending within a band', sorted);
  check('due sort returns the same items',
    (await get('/api/today?sort=due')).body.assignments.length === impact.length);
  check('unknown sort falls back safely', (await get('/api/today?sort=zzz')).body.assignments.length === impact.length);

  // ------------------------------------------------------ every assignment
  section('Every assignment on Today');
  const todayIds = plan.assignments.map((a) => a.id);
  for (const id of todayIds) {
    const d = (await get('/api/assignments/' + id)).body;
    check(`#${id} detail loads`, !!d && !!d.title, JSON.stringify(d && d.error));
    check(`#${id} has a work_mode`, d.work_mode === 'text' || d.work_mode === 'guide');
    check(`#${id} has plain instructions`, typeof d.instructions_plain === 'string' && d.instructions_plain.length > 0);
    if (d.work_mode === 'guide') check(`#${id} guide has steps`, Array.isArray(d.steps) && d.steps.length > 0);

    // simplify (cached second time)
    const s1 = (await post(`/api/assignments/${id}/simplify`)).body;
    check(`#${id} simplify returns text`, !!s1.instructions && s1.instructions.length > 0);
    const d2 = (await get('/api/assignments/' + id)).body;
    check(`#${id} simplify is cached`, d2.instructions_ai === s1.instructions);

    // draft round trip incl. awkward characters
    const draft = `Answer for ${id}.\n\nLine two with <b>tags</b>, "quotes", 'apostrophes' & ampersands — and an em dash.`;
    await post(`/api/assignments/${id}/draft`, { text: draft });
    check(`#${id} draft round-trips exactly`, (await get('/api/assignments/' + id)).body.draft_text === draft);

    // downloads in every offered format
    const opts = (await get(`/api/download-options?kind=assignment&id=${id}`)).body;
    // Typed work is assembled in MLA now, so Word leads; guide work is still
    // plain text with nothing to format.
    const wantFormats = d.work_mode === 'text' ? '["docx","pdf","txt"]' : '["txt","docx","pdf"]';
    check(`#${id} offers the right formats`, JSON.stringify(opts.formats.map((f) => f.ext)) === wantFormats,
      JSON.stringify(opts.formats.map((f) => f.ext)));
    check(`#${id} not empty after typing`, opts.empty === false);
    for (const f of opts.formats) {
      const dl = (await post('/api/download', { kind: 'assignment', id, filename: `A${id}`, format: f.ext })).body;
      check(`#${id} download .${f.ext}`, dl.ok === true && fs.existsSync(dl.saved_to));
      if (dl.ok) {
        const buf = fs.readFileSync(dl.saved_to);
        if (f.ext === 'txt' && d.work_mode !== 'text') {
          check(`#${id} txt content matches draft`, buf.toString('utf8') === draft);
        } else if (f.ext === 'txt') {
          // Typed work carries the heading, so the draft is inside it rather
          // than being the whole file.
          const out = buf.toString('utf8');
          check(`#${id} txt carries the draft under a heading`,
            out.includes('Answer for ' + id) && out.split('\n').length > 5, out.slice(0, 80));
        }
        if (f.ext === 'docx') check(`#${id} docx is a zip`, buf.slice(0, 2).toString() === 'PK');
        if (f.ext === 'pdf') check(`#${id} pdf header+EOF`, buf.slice(0, 5).toString() === '%PDF-' && buf.slice(-6).toString().includes('EOF'));
      }
    }
    // time logging
    const t1 = (await post(`/api/assignments/${id}/time`, { seconds: 60 })).body;
    const t2 = (await post(`/api/assignments/${id}/time`, { seconds: 30 })).body;
    check(`#${id} time accumulates`, t2.time_logged === t1.time_logged + 30);
    check(`#${id} negative time ignored`, (await post(`/api/assignments/${id}/time`, { seconds: -500 })).body.time_logged === t2.time_logged);
  }

  // complete / reopen every one, then restore
  section('Mark complete + reopen (all of today)');
  for (const id of todayIds) {
    await post(`/api/assignments/${id}/complete`);
    const gone = !(await get('/api/today')).body.assignments.find((a) => a.id === id);
    check(`#${id} disappears when complete`, gone);
    await post(`/api/assignments/${id}/reopen`);
    const back = !!(await get('/api/today')).body.assignments.find((a) => a.id === id);
    check(`#${id} comes back when reopened`, back);
  }

  // freeing time pulls in project work
  section('Day plan reacts to finishing work');
  const before = (await get('/api/today')).body;
  await post(`/api/assignments/${todayIds[0]}/complete`);
  const after = (await get('/api/today')).body;
  check('assignment minutes drop after completing', after.assignment_minutes < before.assignment_minutes);
  // Projects are no longer paced into the day, so finishing an assignment must
  // not drag project pieces in behind it.
  check('project minutes stay out of the day', after.project_minutes === 0);
  check('the day totals assignments only', after.total_minutes === after.assignment_minutes);
  check('the project list ignores the clock', after.projects.length === before.projects.length);
  check('and holds whole projects, not pieces',
    after.projects.every((p) => p.project_id && p.title && p.chunk_id === undefined));
  await post(`/api/assignments/${todayIds[0]}/reopen`);

  // ---------------------------------------------------------------- week
  section('Week view');
  const week = (await get('/api/week')).body;
  check('week has 7 days', week.length === 7);
  check('day 1 is today', week[0].is_today === true);
  check('every day has a label', week.every((d) => d.label && d.day));
  check('week shows tests', week.flatMap((d) => d.tests).length >= 2);
  check('week shows project chunks', week.flatMap((d) => d.projects).length >= 2);

  // ------------------------------------------------------------- projects
  section('Projects');
  const projects = (await get('/api/projects')).body;
  check('projects list is non-empty', projects.length >= 2);
  const details = [];
  for (const p of projects) {
    const d = (await get('/api/projects/' + p.id)).body;
    details.push(d);
    check(`project #${p.id} loads`, !!d.title);
    check(`project #${p.id} build_mode is known`, ['none', 'slides', 'essay'].includes(d.build_mode));
  }

  // Will asked for the plan gone. Gone from the API, not just hidden — anything
  // still shipping chunks would quietly grow a UI again.
  section('Projects carry no plan');
  check('the projects list has no progress fraction', projects.every((p) => p.progress === undefined));
  check('and no "today\'s chunk"', projects.every((p) => p.todays_chunk === undefined));
  check('and no all-done flag', projects.every((p) => p.all_done === undefined));
  check('a project page has no chunk list', details.every((d) => d.chunks === undefined));
  check('and no next piece', details.every((d) => d.current_chunk === undefined));
  check('projects still say what they are and when',
    projects.every((p) => p.title && p.class_name && p.due_date));

  // ------------------------------------------------------------ slideshow
  section('Slideshow project — build it all the way out');
  const slideProj = details.find((d) => d.build_mode === 'slides');
  check('a slideshow project exists', !!slideProj);
  if (slideProj) {
    check('title slide pre-filled with the assignment name', slideProj.slides[0].title === slideProj.title);
    check('title slide subtitle is the class', slideProj.slides[0].bullets[0] === slideProj.class_name);
    check('seeded with exactly 2 slides', slideProj.slides.length === 2);

    const out = (await post(`/api/projects/${slideProj.id}/outline`)).body;
    check('auto-outline succeeds', out.ok === true && out.slides.length >= 4);
    check('outline honors "6-8 slides" -> 7', out.slides.length === 7);
    check('outline slide 1 is a title slide', !!out.slides[0].title);
    check('outline slides carry a photo flag', out.slides.every((s) => s.photo === false));

    const full = [
      { title: 'The Declaration of Independence', bullets: ['U.S. History · Will Caldwell'], photo: false },
      { title: 'What the Document Says', bullets: ['A list of grievances against the King', 'A statement of natural rights', 'A formal declaration of separation'], photo: false },
      { title: 'Historical Context', bullets: ['Written in the summer of 1776', 'Debated and edited by the Continental Congress'], photo: true },
      { title: 'Key Ideas', bullets: ['All men are created equal', 'Government needs the consent of the governed'], photo: false },
      { title: 'Its Lasting Impact', bullets: ['Quoted by abolitionists and suffragists', 'Still cited in court arguments today'], photo: false },
      { title: 'Conclusion', bullets: ['A break-up letter that became a founding promise'], photo: false },
    ];
    const saved = (await post(`/api/projects/${slideProj.id}/slides`, { slides: full })).body;
    check('all 6 slides save', saved.count === 6);
    const rl = (await get('/api/projects/' + slideProj.id)).body;
    check('slides come back in order', rl.slides[1].title === 'What the Document Says');
    check('photo toggle persists', rl.slides[2].photo === true && rl.slides[1].photo === false);
    check('has_custom_slides flips true', rl.has_custom_slides === true);

    const sopts = (await get(`/api/download-options?kind=project&id=${slideProj.id}`)).body;
    check('slideshow offers pptx/html/txt', JSON.stringify(sopts.formats.map((f) => f.ext)) === '["pptx","html","txt"]');
    for (const f of sopts.formats) {
      const dl = (await post('/api/download', { kind: 'project', id: slideProj.id, filename: 'Deck', format: f.ext })).body;
      check(`slideshow download .${f.ext}`, dl.ok === true && fs.existsSync(dl.saved_to));
      if (!dl.ok) continue;
      const buf = fs.readFileSync(dl.saved_to);
      if (f.ext === 'pptx') {
        check('pptx is a zip', buf.slice(0, 2).toString() === 'PK');
        check('pptx has 6 slides', !!unzipEntry(buf, 'ppt/slides/slide6.xml') && !unzipEntry(buf, 'ppt/slides/slide7.xml'));
        check('pptx has NO media parts', !buf.includes(Buffer.from('ppt/media/')));
        const s1 = unzipEntry(buf, 'ppt/slides/slide1.xml');
        check('pptx slide 1 is my title slide', s1.includes('The Declaration of Independence'));
        const s3 = unzipEntry(buf, 'ppt/slides/slide3.xml');
        check('pptx picture space only where toggled', s3.includes('Picture space') && !unzipEntry(buf, 'ppt/slides/slide2.xml').includes('Picture space'));
        fs.copyFileSync(dl.saved_to, path.join(SCRATCH, 'verify-deck.pptx'));
      }
      if (f.ext === 'html') {
        const html = buf.toString('utf8');
        check('html has every slide', full.every((s) => html.includes(s.title)));
        check('html has the picture space', html.includes('Picture goes here'));
        check('html embeds no images', !html.includes('<img'));
      }
      if (f.ext === 'txt') check('txt outline labels the title slide', buf.toString('utf8').startsWith('Title slide:'));
    }
  }

  // ---------------------------------------------------------------- essay
  section('Essay project — write it, coach it, hand it in');
  const essayProj = details.find((d) => d.build_mode === 'essay' && /American Dream/i.test(d.title));
  check('the essay project exists', !!essayProj);
  if (essayProj) {
    const eid = essayProj.id;
    check('essay target read from instructions', essayProj.essay_target.paragraphs === 5 && essayProj.essay_target.sentences === 30);

    // empty draft first
    await post(`/api/assignments/${eid}/draft`, { text: '' });
    let ep = (await get('/api/projects/' + eid)).body;
    check('empty essay is 0%', ep.essay_done_pct.pct === 0 && ep.essay_done_pct.written === 0);
    const emptyOpts = (await get(`/api/download-options?kind=essay&id=${eid}`)).body;
    check('empty essay reports empty', emptyOpts.empty === true);
    const emptyUnstuck = (await post(`/api/projects/${eid}/unstuck`, {})).body;
    check('unstuck refuses an empty draft', emptyUnstuck.ok === false && /sentence/i.test(emptyUnstuck.error));
    const emptyReview = (await get(`/api/projects/${eid}/review`)).body;
    check('review handles an empty draft', emptyReview.paragraph_count === 0);

    // partial draft
    await post(`/api/assignments/${eid}/draft`, { text: 'One. Two. Three.' });
    ep = (await get('/api/projects/' + eid)).body;
    check('partial essay is 10%', ep.essay_done_pct.pct === 10 && ep.essay_done_pct.written === 3);

    // the real sample
    const sample = fs.readFileSync(path.join(PROJ, 'test', 'sample-essay.txt'), 'utf8');
    await post(`/api/assignments/${eid}/draft`, { text: sample });
    ep = (await get('/api/projects/' + eid)).body;
    check('full sample essay is 100%', ep.essay_done_pct.pct === 100);
    check('citations excluded from the count', ep.essay_done_pct.written === 30);

    const un = (await post(`/api/projects/${eid}/unstuck`, { draft: sample, stuck_note: 'the conclusion' })).body;
    check('unstuck returns guidance', un.ok === true && !!un.where_you_are && !!un.next);
    check('unstuck gives 3+ points', Array.isArray(un.points) && un.points.length >= 3);
    check('unstuck asks a question', !!un.question);
    check('unstuck notes where I was stuck', un.stuck_on === 'the conclusion');

    const named = (await post(`/api/projects/${eid}/review`, { student_name: 'Will Caldwell', teacher_name: 'Mr. Ortiz', title: 'The Staggered Start' })).body;
    check('review: 5 paragraphs', named.paragraph_count === 5);
    check('review: 3 works cited entries', named.works_cited.length === 3);
    check('review: MLA heading in the preview', /^Will Caldwell\nMr\. Ortiz/.test(named.preview));
    check('review: my own title is used', named.title === 'The Staggered Start');
    check('review: every check passes', named.all_clear === true, JSON.stringify(named.checks.filter((c) => !c.ok)));
    check('review: writing history recorded', named.history.versions >= 1);
    const reread = (await get(`/api/projects/${eid}/review`)).body;
    check('names are remembered', reread.teacher_name === 'Mr. Ortiz' && reread.student_name === 'Will Caldwell');

    const eopts = (await get(`/api/download-options?kind=essay&id=${eid}`)).body;
    check('essay offers docx/pdf/txt', JSON.stringify(eopts.formats.map((f) => f.ext)) === '["docx","pdf","txt"]');
    for (const f of eopts.formats) {
      const dl = (await post('/api/download', { kind: 'essay', id: eid, filename: 'Essay', format: f.ext })).body;
      check(`essay download .${f.ext}`, dl.ok === true && fs.existsSync(dl.saved_to));
      if (!dl.ok) continue;
      const buf = fs.readFileSync(dl.saved_to);
      if (f.ext === 'docx') {
        check('mla docx is a zip', buf.slice(0, 2).toString() === 'PK');
        const doc = unzipEntry(buf, 'word/document.xml');
        check('mla docx has the heading block', doc.includes('Will Caldwell') && doc.includes('Mr. Ortiz'));
        check('mla docx double spaced', doc.includes('w:line="480"'));
        check('mla docx has a page break before works cited', doc.includes('w:br w:type="page"'));
        check('mla docx hanging indent on citations', doc.includes('w:hanging="720"'));
        check('mla docx styles + header parts', !!unzipEntry(buf, 'word/styles.xml') && !!unzipEntry(buf, 'word/header1.xml'));
        fs.copyFileSync(dl.saved_to, path.join(SCRATCH, 'verify-essay.docx'));
      }
      if (f.ext === 'pdf') check('mla pdf is Times', buf.toString('binary').includes('Times-Roman'));
      if (f.ext === 'txt') check('mla txt has works cited', buf.toString('utf8').includes('Works Cited'));
    }

  }

  // ----------------------------------------------------------- file upload
  section('File uploads → notes + flashcards');
  const tests = (await get('/api/tests')).body;
  check('tests list loads', tests.length >= 3);
  check('study goals are 2h test / 30m quiz',
    tests.every((t) => t.time_budget_minutes === (t.type === 'quiz' ? 30 : 120)));

  const files = {
    'bio-notes.txt': [
      'Photosynthesis - the process plants use to turn sunlight into sugar',
      'Mitochondria - the organelle that produces most of the cell ATP',
      'Osmosis - water moving across a membrane toward higher solute concentration',
      'Ribosome - the organelle where proteins are assembled',
      'The cell membrane controls what enters and leaves the cell',
    ].join('\n'),
    'history-notes.md': [
      '# Unit 3 Notes',
      'The Constitutional Convention met in Philadelphia in 1787',
      'The Great Compromise created a two chamber legislature',
      'The Bill of Rights was ratified in 1791',
      'Federalists supported a strong central government',
    ].join('\n'),
    'mixed.txt': [
      'Quadratic formula - x equals negative b plus or minus the square root of b squared minus 4ac all over 2a',
      'A parabola opens upward when a is positive',
      'The vertex is the highest or lowest point of the parabola',
    ].join('\n'),
  };
  const target = tests[0];
  let cardsBefore = (await get('/api/tests/' + target.id)).body.total_cards;

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(SCRATCH, name), content, 'utf8');
    const up = (await post(`/api/tests/${target.id}/notes`, { filename: name, content_base64: b64(content) })).body;
    check(`upload ${name} accepted`, up.ok === true && up.status === 'processing');
    let d;
    for (let i = 0; i < 60; i++) {
      d = (await get('/api/tests/' + target.id)).body;
      if (d.notes_status !== 'processing') break;
      await sleep(250);
    }
    check(`${name} finishes processing`, d.notes_status === 'done', d.notes_status);
    check(`${name} adds flashcards`, d.total_cards > cardsBefore, `${cardsBefore} -> ${d.total_cards}`);
    check(`${name} recorded in the notes`, d.notes.includes(name));
    cardsBefore = d.total_cards;
  }
  const listAfter = (await get('/api/tests')).body.find((t) => t.id === target.id);
  check('tests list shows notes done', listAfter.notes_status === 'done');
  check('tests list card count matches', listAfter.card_count === cardsBefore);

  // re-uploading the same file must not duplicate cards
  const dupName = 'bio-notes.txt';
  await post(`/api/tests/${target.id}/notes`, { filename: dupName, content_base64: b64(files[dupName]) });
  for (let i = 0; i < 60; i++) { const d = (await get('/api/tests/' + target.id)).body; if (d.notes_status !== 'processing') break; await sleep(250); }
  const dupCheck = (await get('/api/tests/' + target.id)).body;
  check('re-uploading the same notes does not duplicate cards', dupCheck.total_cards === cardsBefore, `${cardsBefore} -> ${dupCheck.total_cards}`);

  // binary junk -> error, but earlier notes survive
  const junk = Buffer.from([0, 1, 2, 0, 255, 0, 4, 0, 9, 0]).toString('base64');
  await post(`/api/tests/${target.id}/notes`, { filename: 'junk.bin', content_base64: junk });
  let jd;
  for (let i = 0; i < 60; i++) { jd = (await get('/api/tests/' + target.id)).body; if (jd.notes_status !== 'processing') break; await sleep(250); }
  check('binary file lands in error state, no crash', jd.notes_status === 'error', jd.notes_status);
  check('good notes survive a bad upload', jd.notes.includes('bio-notes.txt'));
  check('cards survive a bad upload', jd.total_cards === cardsBefore);

  // oversized + malformed
  const huge = 'x'.repeat(9_000_000);
  const bigRes = (await post(`/api/tests/${target.id}/notes`, { filename: 'huge.txt', content_base64: b64(huge) })).body;
  check('oversized upload rejected with a message', bigRes.ok === false && /too big/i.test(bigRes.error));
  check('missing file rejected', (await post(`/api/tests/${target.id}/notes`, {})).body.ok === false);
  check('upload to a missing test rejected', (await post('/api/tests/999999/notes', { filename: 'a.txt', content_base64: b64('hi') })).body.ok === false);

  // --------------------------------------------------------- flashcards
  section('Flashcards + study timer');
  let td = (await get('/api/tests/' + target.id)).body;
  check('cards are due for review', td.due_cards.length > 0);
  check('due cards have front and back', td.due_cards.every((c) => c.front && c.back));
  const startMastery = td.mastery;
  let knewIt = 0;
  for (const c of td.due_cards) {
    const rv = (await post(`/api/flashcards/${c.id}/review`, { remembered: true })).body;
    check(`card ${c.id} review accepted`, rv.ok === true, JSON.stringify(rv));
    knewIt++;
  }
  td = (await get('/api/tests/' + target.id)).body;
  check(`mastery rose after ${knewIt} correct reviews`, td.mastery > startMastery, `${startMastery} -> ${td.mastery}`);
  check('reviewed cards leave the due pile', td.due_cards.length < knewIt);

  const missTarget = (await get('/api/tests/' + tests[1].id)).body;
  if (missTarget.due_cards.length) {
    const m = (await post(`/api/flashcards/${missTarget.due_cards[0].id}/review`, { remembered: false })).body;
    check('"did not know" is accepted too', m.ok === true);
  }
  check('reviewing a missing card is handled', (await post('/api/flashcards/999999/review', { remembered: true })).body === null);

  const st1 = (await post(`/api/tests/${target.id}/time`, { seconds: 600 })).body;
  const st2 = (await post(`/api/tests/${target.id}/time`, { seconds: 900 })).body;
  check('study time accumulates', st2.time_logged === st1.time_logged + 900);
  check('study time feeds mastery', typeof st2.mastery === 'number');

  // ------------------------------------------------------ classes/grades
  section('Classes, grades, GPA, email');
  const classes = (await get('/api/classes')).body;
  check('5 classes', classes.length === 5);
  check('classes have letter grades', classes.every((c) => typeof c.grade_letter === 'string'));
  for (const c of classes) {
    const cd = (await get('/api/classes/' + c.id)).body;
    check(`class #${c.id} detail loads`, !!cd.name);
    check(`class #${c.id} grade rows are sane`, cd.grades.every((g) => g.possible > 0));
    check(`class #${c.id} totals add up`,
      Math.abs(cd.total_earned - cd.grades.reduce((s, g) => s + g.earned, 0)) < 0.01);
  }
  const gpa = (await get('/api/gpa')).body;
  check('GPA in range', gpa.gpa > 0 && gpa.gpa <= 4.0);
  const emails = (await get('/api/emails')).body;
  check('emails load', emails.length >= 3);
  check('emails have subject/body/label', emails.every((e) => e.subject && e.body && e.received_label));

  // ---------------------------------------------------------- edge cases
  section('Edge cases + bad input');
  check('unknown API path 404s', (await get('/api/nope')).status === 404);
  check('missing assignment returns null', (await get('/api/assignments/999999')).body === null);
  check('missing project returns null', (await get('/api/projects/999999')).body === null);
  check('missing test returns null', (await get('/api/tests/999999')).body === null);
  check('missing class returns null', (await get('/api/classes/999999')).body === null);
  check('download-options for a bad id 404s', (await get('/api/download-options?kind=assignment&id=999999')).status === 404);
  check('download for a bad id fails cleanly', (await post('/api/download', { kind: 'assignment', id: 999999, filename: 'x', format: 'txt' })).body.ok === false);
  const weird = (await post('/api/download', { kind: 'assignment', id: todayIds[0], filename: 'bad/name:with*chars?', format: 'zzz' })).body;
  const firstExt = (await get(`/api/download-options?kind=assignment&id=${todayIds[0]}`)).body.formats[0].ext;
  check('unknown format falls back to the first one', weird.ok === true && weird.filename.endsWith('.' + firstExt),
    weird.filename);
  check('illegal filename characters are stripped', weird.ok === true && !/[/:*?]/.test(weird.filename));
  check('outline on a non-slideshow project is refused', (await post(`/api/projects/${essayProj.id}/outline`)).body.ok === false);
  check('review for a missing project 404s', (await get('/api/projects/999999/review')).status === 404);
  check('chunk done for a missing chunk is handled', (await post('/api/chunks/999999/done', { done: true })).status === 200);
  check('simplify for a missing assignment is handled', (await post('/api/assignments/999999/simplify')).body.instructions === null);

  // ---- Canvas connection (the API page) ----------------------------------
  // Nothing here may touch a real Canvas. The bad-address check uses a .invalid
  // host, which is reserved and can never resolve, so it fails immediately.
  section('Canvas connection');
  const c0 = (await get('/api/canvas')).body;
  check('canvas settings say not connected on sample data', c0.connected === false);
  check('canvas settings never return the token itself', !('token' in c0) && 'token_hint' in c0);

  const noUrl = (await post('/api/canvas', { base_url: '', token: 'abc' })).body;
  check('connecting without an address is refused', noUrl.ok === false && /address/i.test(noUrl.error));
  const badScheme = (await post('/api/canvas', { base_url: 'myschool.instructure.com', token: 'abc' })).body;
  check('an address without https is refused', badScheme.ok === false && /https/i.test(badScheme.error));
  const noToken = (await post('/api/canvas', { base_url: 'https://school.instructure.com', token: '  ' })).body;
  check('connecting without a token is refused', noToken.ok === false && /token/i.test(noToken.error));
  const unreachable = (await post('/api/canvas', { base_url: 'https://slate-test.invalid', token: 'abc' })).body;
  check('an address that does not exist is refused', unreachable.ok === false && /typo|reach/i.test(unreachable.error),
    unreachable.error);
  check('a failed connect leaves the token unsaved', (await get('/api/canvas')).body.connected === false);
  check('a failed connect keeps sample data working', (await get('/api/today')).body.assignments.length > 0);

  // Quit must be refused here. This IS a dev server, and every check after this
  // line depends on it still being alive.
  const quit = await post('/api/quit');
  check('the dev server refuses to be quit', quit.status === 403);
  const stillThere = await get('/api/status');
  check('and is still running afterwards', stillThere.status === 200);
  check('status says this copy is not the installed one', stillThere.body.installed === false);

  // duplicate filename numbering
  const n1 = (await post('/api/download', { kind: 'assignment', id: todayIds[0], filename: 'DupeName', format: 'txt' })).body;
  const n2 = (await post('/api/download', { kind: 'assignment', id: todayIds[0], filename: 'DupeName', format: 'txt' })).body;
  check('duplicate download names get numbered, never clobbered', n1.filename !== n2.filename && fs.existsSync(n1.saved_to) && fs.existsSync(n2.saved_to));

  // ---- the optional AI checker -------------------------------------------
  // Runs against a stand-in (SLATE_AI_CHECK_FAKE), never the real GPTZero.
  section('AI checker');
  const aiSettings = (await get('/api/canvas')).body.ai_check;
  check('the API page reports whether the checker is on', aiSettings.enabled === true);
  check('and never hands the key back', !('key' in aiSettings));

  const aiDue = (await get('/api/today')).body.assignments.filter((a) => !a.upcoming);
  const aiDetails = await Promise.all(aiDue.map((a) => get('/api/assignments/' + a.id).then((r) => r.body)));
  const aiTarget = aiDetails.find((d) => d.work_mode === 'text');

  await post(`/api/assignments/${aiTarget.id}/draft`, { text: 'short' });
  const tooShort = (await post('/api/ai-check', { kind: 'assignment', id: aiTarget.id })).body;
  check('a two-word draft is not scored', tooShort.state === 'short');

  const ownWriting = 'I think Fitzgerald uses the party scene to show how money works. '.repeat(12);
  await post(`/api/assignments/${aiTarget.id}/draft`, { text: ownWriting });
  const scored = (await post('/api/ai-check', { kind: 'assignment', id: aiTarget.id })).body;
  check('real writing gets a score', scored.state === 'done' && typeof scored.ai_pct === 'number');
  check('the score is a percentage', scored.ai_pct >= 0 && scored.ai_pct <= 100);
  check('it says when it was checked', !!scored.checked_at);
  check('it does NOT explain what tripped the detector',
    !('reasons' in scored) && !('explanation' in scored) && !('highlights' in scored),
    Object.keys(scored).join(','));

  const aiAgain = (await post('/api/ai-check', { kind: 'assignment', id: aiTarget.id })).body;
  check('checking the same draft again is served from cache', aiAgain.cached === true);
  await post(`/api/assignments/${aiTarget.id}/draft`, { text: ownWriting + ' One more sentence.' });
  check('editing the draft means a fresh check',
    (await post('/api/ai-check', { kind: 'assignment', id: aiTarget.id })).body.cached === false);

  // Never a gate: whatever it says, handing in is unaffected.
  check('a score never blocks handing in',
    (await get(`/api/submit-preview?kind=assignment&id=${aiTarget.id}`)).body.can_submit === true);
  const slidesProj = (await get('/api/projects')).body.find((p) => /Founding Document/.test(p.title));
  if (slidesProj) {
    check('a slideshow has no writing to check',
      (await post('/api/ai-check', { kind: 'project', id: slidesProj.id })).body.state === 'not_writing');
  }

  // ---- work that carries over --------------------------------------------
  section('Carrying over');
  const carry = (await get('/api/today')).body;
  const late = carry.assignments.filter((a) => a.overdue);
  check('work never handed in shows up today', late.length >= 1,
    carry.assignments.map((a) => a.title + ':' + a.due_date).join(' | '));
  check('and is marked as late', late.every((a) => a.days_late >= 1));
  check('its due date is genuinely in the past', late.every((a) => a.due_date < carry.date));
  check('the plan counts it', carry.overdue_count === late.length);
  check('late work is at the top of the list', carry.assignments[0].overdue === true);
  check('carried-over work counts toward how busy the day is',
    carry.scheduled_today_count >= late.length);

  const lateId = late[0].id;
  await post(`/api/assignments/${lateId}/complete`);
  const cleared = (await get('/api/today')).body;
  check('doing it clears it off the list', !cleared.assignments.some((a) => a.id === lateId));
  check('and it lands in what you finished today', cleared.finished.some((a) => a.id === lateId));
  await post(`/api/assignments/${lateId}/reopen`);
  check('reopening brings it back as late still',
    (await get('/api/today')).body.assignments.some((a) => a.id === lateId && a.overdue));

  // ---- finished vs unfinished --------------------------------------------
  section('Finished and unfinished');
  const day0 = (await get('/api/today')).body;
  check('the day plan has a finished list', Array.isArray(day0.finished));
  check('and a finished project list', Array.isArray(day0.finished_projects));
  check('nothing is finished to start with', day0.finished_count === 0, JSON.stringify(day0.finished.map((a) => a.title)));
  check("Canvas's already-graded work never counts as finished today",
    day0.finished.length === 0);

  // Due TODAY, not carried over — the week's columns start at today, so a
  // late item would land in a day the week does not show.
  const toFinish = day0.assignments.find((a) => !a.upcoming && !a.overdue);
  await post(`/api/assignments/${toFinish.id}/complete`);
  const day1 = (await get('/api/today')).body;
  check('completing something moves it out of unfinished',
    !day1.assignments.some((a) => a.id === toFinish.id));
  check('and into finished', day1.finished.some((a) => a.id === toFinish.id));
  check('the finished count keeps up', day1.finished_count === day0.finished_count + 1);
  check('finished items are flagged done', day1.finished.every((a) => a.done === true));
  check('and carry when they were finished', day1.finished.every((a) => !!a.completed_at));
  check('finished work stops counting toward the day',
    day1.due_today_minutes < day0.due_today_minutes);

  await post(`/api/assignments/${toFinish.id}/reopen`);
  const day2 = (await get('/api/today')).body;
  check('reopening puts it back in unfinished', day2.assignments.some((a) => a.id === toFinish.id));
  check('and out of finished', !day2.finished.some((a) => a.id === toFinish.id));

  // Week: same split, per day.
  const dueTodayOnly = (await get('/api/today')).body.assignments.find((a) => !a.upcoming && !a.overdue);
  const week0 = (await get('/api/week')).body;
  check('every week day has both lists',
    week0.every((d) => Array.isArray(d.assignments) && Array.isArray(d.done_assignments)));
  const todayCol0 = week0.find((d) => d.is_today);
  check('nothing is finished in the week yet', todayCol0.done_assignments.length === 0);
  await post(`/api/assignments/${toFinish.id}/complete`);
  const week1 = (await get('/api/week')).body;
  const todayCol1 = week1.find((d) => d.is_today);
  check('the week moves it to that day\'s finished list',
    todayCol1.done_assignments.some((a) => a.title === toFinish.title));
  check('and out of that day\'s unfinished list',
    !todayCol1.assignments.some((a) => a.title === toFinish.title));
  check('other days are unaffected',
    week1.filter((d) => !d.is_today).every((d) => d.done_assignments.length === 0));
  await post(`/api/assignments/${toFinish.id}/reopen`);
  check('and the week puts it back',
    (await get('/api/week')).body.find((d) => d.is_today).assignments.some((a) => a.title === toFinish.title));

  // (Finishing pulled-forward work is covered in the smoke suite, which can
  // build a genuinely quiet day; the mock always has a busy one.)

  // Projects split the same way, as whole projects rather than pieces of one.
  const someProject = (await get('/api/today')).body.projects[0];
  if (someProject) {
    await post(`/api/assignments/${someProject.project_id}/complete`);
    const day3 = (await get('/api/today')).body;
    check('a finished project moves to Finished',
      day3.finished_projects.some((p) => p.project_id === someProject.project_id));
    check('and is out of the unfinished list',
      !day3.projects.some((p) => p.project_id === someProject.project_id));
    await post(`/api/assignments/${someProject.project_id}/reopen`);
    check('reopening it puts it back',
      (await get('/api/today')).body.projects.some((p) => p.project_id === someProject.project_id));
  }

  // ---- exams belong on Tests & Quizzes -----------------------------------
  // ---- how far ahead the Tests page is looking --------------------------
  section('Tests time frame');
  const winCount = async (w) => (await get('/api/tests' + (w ? '?weeks=' + w : ''))).body.length;
  const everyTest = await winCount(0);
  const w1 = await winCount(1);
  const w2 = await winCount(2);
  const w3 = await winCount(3);
  const w4 = await winCount(4);
  check('1 week returns strictly fewer than All', w1 < everyTest, { w1, everyTest });
  check('each window is at least as big as the one before',
    w1 <= w2 && w2 <= w3 && w3 <= w4 && w4 <= everyTest, { w1, w2, w3, w4, everyTest });
  check('and the windows are not all the same list', w4 > w1, { w1, w4 });
  const inOne = (await get('/api/tests?weeks=1')).body;
  const todayYmdStr = (await get('/api/status')).body.today;
  check('nothing in the 1-week window is already in the past',
    inOne.every((t) => !t.due_date || t.due_date >= todayYmdStr), inOne.map((t) => t.due_date).join(','));
  check('junk in the query means All', (await winCount('banana')) === everyTest);
  check('a huge number is clamped to 4 weeks', (await winCount(99)) === w4, { got: await winCount(99), w4 });

  // ---- files a teacher attached in Canvas ------------------------------
  section('Attached Canvas files');
  const todayNow = (await get('/api/today')).body.assignments;
  const withFiles = [];
  for (const a of todayNow) {
    const d = (await get('/api/assignments/' + a.id)).body;
    if (d.files && d.files.length) withFiles.push(d);
  }
  check('an assignment carries its attached file', withFiles.length >= 1, withFiles.length);
  const wf = withFiles[0];
  if (wf) {
    check('the file has a name', !!wf.files[0].name, wf.files[0]);
    check('and a type', wf.files[0].kind === 'docx', wf.files[0].kind);
    check('Slate can read inside it', wf.files[0].readable === true);
    // Not checking "not downloaded yet" here: an earlier check in this sweep
    // simplifies this assignment's instructions, which reads its attachments
    // and therefore fetches the file. The smoke suite pins the lazy fetch,
    // where the order is controlled.

    const opened = await post(`/api/assignments/${wf.id}/files/open`, { index: 0 });
    check('opening it succeeds', opened.status === 200 && opened.body.ok === true, opened.body);
    check('it reports the file name back', /organelle/i.test(opened.body.name || ''), opened.body.name);
    const again = (await get('/api/assignments/' + wf.id)).body;
    check('the page now knows it is downloaded', again.files[0].downloaded === true);

    const readBack = await post(`/api/assignments/${wf.id}/read-files`, {});
    check('reading the file gets the words out of it',
      /Label all eight organelles/.test(readBack.body.text || ''), (readBack.body.text || '').slice(0, 80));
    check('which is text the description never had',
      !/eight organelles/i.test(wf.description || ''), wf.description);
    check('and it is marked read', (await get('/api/assignments/' + wf.id)).body.files_state === 'done');

    const badIndex = await post(`/api/assignments/${wf.id}/files/open`, { index: 42 });
    check('a file index that does not exist fails cleanly',
      badIndex.status === 400 && badIndex.body.ok === false, badIndex.body);
    const noIndex = await post(`/api/assignments/${wf.id}/files/open`, {});
    check('a missing index fails cleanly too', noIndex.status === 400, noIndex.body);
  }
  const noFiles = todayNow.map((a) => a.id).find((id) => !withFiles.some((w) => w.id === id));
  if (noFiles) {
    check('an assignment with no attachments has an empty file list',
      ((await get('/api/assignments/' + noFiles)).body.files || []).length === 0);
    check('and reading its files is a harmless no-op',
      (await post(`/api/assignments/${noFiles}/read-files`, {})).body.text === '');
  }

  // This phase runs with SLATE_NO_AI=1, so the point here is the plumbing and
  // the failure path — that a send Claude cannot answer leaves the transcript
  // untouched instead of stranding a question in it. The real conversation is
  // exercised in the live phase (drive:all).
  section('Ask Claude');
  const chatOn = (await get('/api/today')).body.assignments[0];
  const chat0 = await get(`/api/assignments/${chatOn.id}/chat`);
  check('an assignment starts with an empty chat',
    chat0.status === 200 && Array.isArray(chat0.body.messages) && chat0.body.messages.length === 0, chat0.body);
  const chatOff = await post(`/api/assignments/${chatOn.id}/chat`, { question: 'what is this asking?' });
  check('with Claude switched off the send fails politely',
    chatOff.status === 200 && chatOff.body.ok === false, chatOff.body);
  check('and says why in plain words', /switched off/i.test(chatOff.body.error || ''), chatOff.body.error);
  check('and hands the question back so the box can be refilled',
    chatOff.body.question === 'what is this asking?', chatOff.body);
  check('a failed send writes NOTHING to the transcript',
    (await get(`/api/assignments/${chatOn.id}/chat`)).body.messages.length === 0);
  check('an empty question is refused',
    (await post(`/api/assignments/${chatOn.id}/chat`, { question: '   ' })).body.ok === false);
  check('a missing question is refused',
    (await post(`/api/assignments/${chatOn.id}/chat`, {})).body.ok === false);
  check('a chat on an assignment that does not exist fails cleanly',
    (await post('/api/assignments/987654/chat', { question: 'hi' })).body.ok === false);
  const chatCleared = await post(`/api/assignments/${chatOn.id}/chat/clear`, {});
  check('clearing an empty chat is a harmless no-op',
    chatCleared.body.ok === true && chatCleared.body.messages.length === 0, chatCleared.body);
  // Every work page gets one, guide-mode included — a guide assignment is
  // exactly the kind you want to ask questions about.
  const guideForChat = [];
  for (const a of (await get('/api/today')).body.assignments) {
    const d = (await get('/api/assignments/' + a.id)).body;
    if (d.work_mode !== 'text') guideForChat.push(d);
  }
  if (guideForChat.length) {
    check('a guide-mode assignment has a chat too',
      (await get(`/api/assignments/${guideForChat[0].id}/chat`)).status === 200);
  }

  section('Exams are not projects');
  const projectTitles = (await get('/api/projects')).body.map((p) => p.title);
  // "(Final)" on an essay means the final draft, not a final exam — a project
  // called that must stay a project. Only real assessments move.
  check('no exam or quiz is sitting on the Projects page',
    !projectTitles.some((t) => /\b(exam|midterm|quiz)\b/i.test(t) || /\bfinals?\s+(exam|test)\b/i.test(t)),
    projectTitles.join(' | '));
  check('an essay called "(Final)" is still a project',
    projectTitles.some((t) => /American Dream Essay/i.test(t)), projectTitles.join(' | '));
  const testNames = (await get('/api/tests')).body.map((t) => t.name);
  check('the mock exam assignment landed on Tests & Quizzes',
    testNames.some((n) => /Unit 2 Exam/i.test(n)), testNames.join(' | '));
  const exam = (await get('/api/tests')).body.find((t) => /Unit 2 Exam/i.test(t.name));
  check('it is typed as a test, not a quiz', exam.type === 'test');
  check('it kept its due date', !!exam.due_date);
  check('it carries the real deadline for display', !!exam.due_at);
  check('and it opens like any other test', (await get('/api/tests/' + exam.id)).status === 200);
  const todayTitles = (await get('/api/today')).body.assignments.map((a) => a.title);
  check('it is not also sitting in the assignment list',
    !todayTitles.some((t) => /Unit 2 Exam/i.test(t)), todayTitles.join(' | '));

  // ---- emails: preview in the list, everything in the message -----------
  section('Email detail');
  const inbox = (await get('/api/emails')).body;
  check('the list still gives previews', inbox.length >= 3 && inbox.every((e) => e.body));
  const openedMail = (await get('/api/emails/' + inbox[0].id)).body;
  check('opening a message returns the full text', openedMail.body.length > inbox[0].body.length,
    `${inbox[0].body.length} -> ${openedMail.body.length}`);
  check('and says it managed to load it', openedMail.full_text_loaded === true);
  check('and comes with a readable timestamp', (openedMail.received_label || '').length > 6);
  const attachMail = inbox.find((e) => /Unit 4 Test/.test(e.subject));
  const openedAttach = (await get('/api/emails/' + attachMail.id)).body;
  check('attachments come back with the message', openedAttach.attachments.length === 2);
  check('each attachment has a name and a link',
    openedAttach.attachments.every((a) => a.name && /^https?:/.test(a.url)));
  check('a message with no attachments returns an empty list',
    Array.isArray((await get('/api/emails/' + inbox.find((e) => /Lab Report/.test(e.subject)).id)).body.attachments));
  check('opening it twice is served from the saved copy',
    (await get('/api/emails/' + inbox[0].id)).body.body === openedMail.body);
  check('a message that does not exist 404s', (await get('/api/emails/999999')).status === 404);

  // ---- a quiet day pulls work forward ------------------------------------
  // Only fires when today has 2 things or fewer, so this finishes today's work
  // off one at a time and watches for the moment it kicks in.
  section('Working ahead on a light day');
  const startPlan = (await get('/api/today')).body;
  check('a busy day shows no work pulled forward',
    startPlan.due_today_count > 2 ? startPlan.upcoming_count === 0 : true,
    `${startPlan.due_today_count} due today, ${startPlan.upcoming_count} pulled forward`);

  // Whether work comes forward is decided by how many the day HELD, not by how
  // many are left — so finishing a busy day must not summon more.
  check('the day reports how many it started with',
    startPlan.scheduled_today_count >= startPlan.due_today_count);
  const busyDay = startPlan.scheduled_today_count > 2;
  check('the mock day is a busy one', busyDay, String(startPlan.scheduled_today_count));

  const dueTodayIds = startPlan.assignments.filter((a) => !a.upcoming).map((a) => a.id);
  const completed = [];
  for (const id of dueTodayIds) {
    await post(`/api/assignments/${id}/complete`);
    completed.push(id);
    const p = (await get('/api/today')).body;
    check(`nothing pulled forward with ${p.due_today_count} left of a busy day`, p.upcoming_count === 0,
      `${p.scheduled_today_count} scheduled, ${p.upcoming_count} pulled forward`);
    check('the scheduled count does not move as work gets finished',
      p.scheduled_today_count === startPlan.scheduled_today_count);
  }
  const clearedDay = (await get('/api/today')).body;
  check('clearing a busy day leaves nothing left to do', clearedDay.due_today_count === 0);
  check('and does not summon work from later in the week', clearedDay.upcoming_count === 0);
  check('everything finished is in the finished list', clearedDay.finished.length >= completed.length);
  for (const id of completed) await post(`/api/assignments/${id}/reopen`);
  check('reopening everything puts the day back',
    (await get('/api/today')).body.due_today_count === startPlan.due_today_count);

  // ---- time worked today -------------------------------------------------
  section('Worked today');
  const dayStart = (await get('/api/today')).body;
  check('the day plan reports time worked today', typeof dayStart.worked_seconds === 'number');
  const someTest = (await get('/api/tests')).body[0];
  const testStart = (await get(`/api/tests/${someTest.id}`)).body;
  check('a test reports today separately from its running total',
    typeof testStart.time_logged_today === 'number' && typeof testStart.time_logged === 'number');

  const studied = (await post(`/api/tests/${someTest.id}/time`, { seconds: 300 })).body;
  check('studying adds to the running total', studied.time_logged === testStart.time_logged + 300);
  check('and to today', studied.time_logged_today === testStart.time_logged_today + 300);
  check('and to the whole day', studied.seconds === dayStart.worked_seconds + 300);
  check('the day plan agrees', (await get('/api/today')).body.worked_seconds === dayStart.worked_seconds + 300);

  const worked = (await post(`/api/assignments/${todayIds[0]}/time`, { seconds: 120 })).body;
  check('assignment time counts toward the day too', worked.seconds === dayStart.worked_seconds + 420);
  check("but not toward another test's today",
    (await get(`/api/tests/${someTest.id}`)).body.time_logged_today === studied.time_logged_today);
  check('zero seconds changes nothing',
    (await post(`/api/tests/${someTest.id}/time`, { seconds: 0 })).body.seconds === dayStart.worked_seconds + 420);
  check('negative seconds change nothing',
    (await post(`/api/tests/${someTest.id}/time`, { seconds: -600 })).body.seconds === dayStart.worked_seconds + 420);
  check("the running total still only goes up",
    (await get(`/api/tests/${someTest.id}`)).body.time_logged >= testStart.time_logged + 300);

  // ---- class notes -------------------------------------------------------
  // The drive server runs with AI off, so every Claude step here takes its
  // failure path on purpose — the point is that a failure never costs the
  // student their note.
  section('Class notes');
  const allClasses = (await get('/api/classes')).body;
  const allTests = (await get('/api/tests')).body;
  const noteClass = allClasses.find((c) => allTests.some((t) => t.class_name === c.name));
  const noteClassTests = allTests.filter((t) => t.class_name === noteClass.name);
  const otherTest = allTests.find((t) => t.class_name !== noteClass.name);
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  check('a class starts with no notes', (await get(`/api/classes/${noteClass.id}/notes`)).body.notes.length === 0);
  const noFile = (await post(`/api/classes/${noteClass.id}/notes`, {})).body;
  check('uploading nothing is refused', noFile.ok === false);
  const madeUp = (await post('/api/classes/999999/notes', { filename: 'x.png', content_base64: TINY_PNG })).body;
  check('uploading to a class that does not exist is refused', madeUp.ok === false);

  const up = (await post(`/api/classes/${noteClass.id}/notes`, { filename: 'bio-notes.png', content_base64: TINY_PNG })).body;
  check('uploading a photo returns the note immediately', up.ok === true && up.note.id > 0);
  check('the note starts out being read', up.note.status === 'reading');
  const noteId = up.note.id;
  check('the original photo is kept and served back',
    (await fetch(BASE + `/api/notes/${noteId}/image`)).status === 200);
  await sleep(1200);
  const read = (await get(`/api/notes/${noteId}`)).body;
  check('a failed read leaves the note in place', read.id === noteId && read.status === 'error');
  check('the note still belongs to its class', read.class_id === noteClass.id);
  check('the class lists it', (await get(`/api/classes/${noteClass.id}/notes`)).body.notes.length === 1);

  check('a note with no text cannot be added to a test',
    (await post(`/api/notes/${noteId}/add-to-test`, { test_id: noteClassTests[0].id })).body.ok === false);

  const NOTE_TEXT = 'Mitosis has four phases: prophase, metaphase, anaphase, telophase. '
    + 'Interphase is not part of mitosis. Cytokinesis splits the cytoplasm afterwards.';
  const saved = (await post(`/api/notes/${noteId}`, { title: 'Mitosis', text: NOTE_TEXT })).body;
  check('typing the text in saves it', saved.ok === true && saved.note.text === NOTE_TEXT);
  check('and the note is ready again', saved.note.status === 'ready' && saved.note.error === '');
  check('the word count comes back', saved.note.word_count > 10);
  check('editing again keeps the title when only text is sent',
    (await post(`/api/notes/${noteId}`, { text: NOTE_TEXT })).body.note.title === 'Mitosis');

  const pickable = (await get(`/api/notes/${noteId}/tests`)).body.tests;
  check('the test picker only offers tests from the same class', pickable.length === noteClassTests.length);
  check('none are marked as already added yet', pickable.every((t) => !t.already_added));
  if (otherTest) {
    check("a test from another class is refused",
      (await post(`/api/notes/${noteId}/add-to-test`, { test_id: otherTest.id })).body.ok === false);
  }

  const targetTest = noteClassTests[0];
  const cardCountBefore = (await get(`/api/tests/${targetTest.id}`)).body.total_cards;
  const attach = (await post(`/api/notes/${noteId}/add-to-test`, { test_id: targetTest.id })).body;
  check('adding a note to a test works', attach.ok === true);
  check('the note records which test it is on', attach.note.tests.some((t) => t.test_id === targetTest.id));
  check('the picker now says it is already added',
    (await get(`/api/notes/${noteId}/tests`)).body.tests.find((t) => t.id === targetTest.id).already_added === true);
  check('the test now lists the note',
    (await get(`/api/tests/${targetTest.id}`)).body.class_notes.some((n) => n.id === noteId));
  await sleep(1500);
  const afterThink = (await get(`/api/notes/${noteId}`)).body;
  const link = afterThink.tests.find((t) => t.test_id === targetTest.id);
  check('with AI off, card generation reports a failure', link.status === 'error');
  check('and explains it in plain English', link.error.length > 20, link.error);
  check('but the note itself is untouched', afterThink.text === NOTE_TEXT && afterThink.status === 'ready');
  check('and no junk cards were invented',
    (await get(`/api/tests/${targetTest.id}`)).body.total_cards === cardCountBefore);

  const again = (await post(`/api/notes/${noteId}/add-to-test`, { test_id: targetTest.id })).body;
  check('adding the same note to the same test again is not an error', again.ok === true);
  check('and does not add a second copy',
    again.note.tests.filter((t) => t.test_id === targetTest.id).length === 1);

  if (noteClassTests[1]) {
    await post(`/api/notes/${noteId}/add-to-test`, { test_id: noteClassTests[1].id });
    check('one note can go on more than one test',
      (await get(`/api/notes/${noteId}`)).body.tests.length === 2);
  }
  // A second note on the same test — a test has to hold many notes.
  const up2 = (await post(`/api/classes/${noteClass.id}/notes`, { filename: 'second.png', content_base64: TINY_PNG })).body;
  await post(`/api/notes/${up2.note.id}`, { title: 'Meiosis', text: 'Meiosis makes four haploid cells. Crossing over happens in prophase I.' });
  await post(`/api/notes/${up2.note.id}/add-to-test`, { test_id: targetTest.id });
  check('a test can hold several notes',
    (await get(`/api/tests/${targetTest.id}`)).body.class_notes.length === 2);

  check('deleting a note works', (await post(`/api/notes/${noteId}/delete`)).body.ok === true);
  check('it is gone from the class', (await get(`/api/classes/${noteClass.id}/notes`)).body.notes.every((n) => n.id !== noteId));
  check('and off the test it was on',
    (await get(`/api/tests/${targetTest.id}`)).body.class_notes.every((n) => n.id !== noteId));
  check('the other note is still there',
    (await get(`/api/tests/${targetTest.id}`)).body.class_notes.some((n) => n.id === up2.note.id));
  check('a deleted note 404s', (await get(`/api/notes/${noteId}`)).status === 404);
  check('deleting it twice is handled', (await post(`/api/notes/${noteId}/delete`)).body.ok === false);
  check('saving a note that does not exist is handled', (await post('/api/notes/999999', { text: 'x' })).body.ok === false);
  check('the image of a deleted note 404s', (await fetch(BASE + `/api/notes/${noteId}/image`)).status === 404);

  // ---- accounts + admin --------------------------------------------------
  // LAST on purpose. The final checks here switch sign-in on, after which every
  // other endpoint needs a session — so nothing may run after them.
  section('Accounts and admin');
  const a0 = (await get('/api/admin/users')).body;
  check('there is exactly one account to start with', a0.users.length === 1);
  check('and it is the owner, an admin, with no password yet',
    a0.users[0].is_owner === true && a0.users[0].is_admin === true && a0.users[0].has_password === false);
  check('sign-in is off while the owner is alone', a0.login_required === false);
  check('me reports the owner when sign-in is off', (await get('/api/me')).body.user.is_owner === true);

  check('a one-letter name is refused', (await post('/api/admin/users', { name: 'x', password: 'abcd' })).body.ok === false);
  check('a 3-character password is refused', (await post('/api/admin/users', { name: 'Sam', password: 'abc' })).body.ok === false);
  const added = (await post('/api/admin/users', { name: 'Testfriend', password: 'hunter22' })).body;
  check('adding a user works', added.ok === true && added.users.length === 2);
  check('the same name twice is refused', (await post('/api/admin/users', { name: 'testfriend', password: 'hunter22' })).body.ok === false);
  check('adding someone does not switch sign-in on by itself', added.login_required === false);

  const friend = added.users.find((u) => u.name === 'Testfriend');
  const ownerId = added.users.find((u) => u.is_owner).id;
  check('the new user is not an admin and not frozen', friend.is_admin === false && friend.is_frozen === false);
  check('the new user starts with no devices', friend.devices === 0);

  check("the owner can't be frozen", (await post(`/api/admin/users/${ownerId}/freeze`, { frozen: true })).body.ok === false);
  check("the owner can't be deleted", (await post(`/api/admin/users/${ownerId}/delete`)).body.ok === false);
  check("the owner can't be demoted", (await post(`/api/admin/users/${ownerId}/admin`, { admin: false })).body.ok === false);

  const promoted = (await post(`/api/admin/users/${friend.id}/admin`, { admin: true })).body;
  check('a user can be made an admin', promoted.users.find((u) => u.id === friend.id).is_admin === true);
  const demoted = (await post(`/api/admin/users/${friend.id}/admin`, { admin: false })).body;
  check('and unmade', demoted.users.find((u) => u.id === friend.id).is_admin === false);

  // Signing in gives back a session cookie — that is one device.
  const badPw = await post('/api/login', { name: 'Testfriend', password: 'wrong' });
  check('the wrong password is refused', badPw.status === 401 && badPw.body.ok === false);
  check('a wrong password leaves no device behind',
    (await get('/api/admin/users')).body.users.find((u) => u.id === friend.id).devices === 0);
  const signedIn = await post('/api/login', { name: 'Testfriend', password: 'hunter22' });
  check('signing in works', signedIn.body.ok === true && !!signedIn.setCookie);
  check('signing in sets an HttpOnly cookie', /HttpOnly/i.test(signedIn.setCookie || ''));
  const friendCookie = (signedIn.setCookie || '').split(';')[0];
  const withOne = (await get('/api/admin/users')).body.users.find((u) => u.id === friend.id);
  check('that shows up as one signed-in device', withOne.devices === 1, String(withOne.devices));
  check('and the device is named something readable',
    ((await get(`/api/admin/users/${friend.id}/devices`)).body.devices[0].device || '').length > 3);
  const signedIn2 = await post('/api/login', { name: 'Testfriend', password: 'hunter22' });
  check('a second sign-in counts as a second device',
    (await get('/api/admin/users')).body.users.find((u) => u.id === friend.id).devices === 2);
  check('names are matched without case fussiness', signedIn2.body.ok === true);

  check('sign out all clears every device',
    (await post(`/api/admin/users/${friend.id}/signout`)).body.users.find((u) => u.id === friend.id).devices === 0);
  check('the old cookie stops working once signed out',
    (await get('/api/me', friendCookie)).body.user === null || (await get('/api/me', friendCookie)).body.login_required === false);

  // Freezing keeps the account but locks it, and kicks it off every device.
  await post('/api/login', { name: 'Testfriend', password: 'hunter22' });
  const frozen = (await post(`/api/admin/users/${friend.id}/freeze`, { frozen: true })).body;
  check('freezing an account works', frozen.users.find((u) => u.id === friend.id).is_frozen === true);
  check('freezing signs them out everywhere', frozen.users.find((u) => u.id === friend.id).devices === 0);
  const frozenTry = await post('/api/login', { name: 'Testfriend', password: 'hunter22' });
  check('a frozen account cannot sign in', frozenTry.status === 401 && /frozen/i.test(frozenTry.body.error));
  const thawed = (await post(`/api/admin/users/${friend.id}/freeze`, { frozen: false })).body;
  check('unfreezing lets them back in', thawed.users.find((u) => u.id === friend.id).is_frozen === false);
  check('and they can sign in again', (await post('/api/login', { name: 'Testfriend', password: 'hunter22' })).body.ok === true);

  const deleted = (await post(`/api/admin/users/${friend.id}/delete`)).body;
  check('deleting a user removes them', deleted.users.length === 1);
  check('a deleted user cannot sign in', (await post('/api/login', { name: 'Testfriend', password: 'hunter22' })).status === 401);

  // Everything below flips sign-in ON. Nothing may run after it.
  const readd = (await post('/api/admin/users', { name: 'Roommate', password: 'letmein1' })).body;
  check('sign-in is still off before the owner has a password', readd.login_required === false);
  const pw = (await post(`/api/admin/users/${ownerId}/password`, { password: 'ownerpass' })).body;
  check('setting the owner password switches sign-in on', pw.login_required === true);
  check('the owner now shows as having a password', pw.users.find((u) => u.is_owner).has_password === true);
  const lockedOut = await get('/api/today', '');
  check('with sign-in on, a stranger gets 401 instead of the schoolwork', lockedOut.status === 401);
  check('the sign-in page itself still loads', (await get('/api/me', '')).status === 200);
  const roommate = await post('/api/login', { name: 'Roommate', password: 'letmein1' }, '');
  const roommateCookie = (roommate.setCookie || '').split(';')[0];
  check('a signed-in non-admin can see their work', (await get('/api/today', roommateCookie)).status === 200);
  check('but cannot reach the admin page', (await get('/api/admin/users', roommateCookie)).status === 403);
  const ownerIn = await post('/api/login', { name: a0.users[0].name, password: 'ownerpass' }, '');
  check('the owner can sign in with the password just set', ownerIn.body.ok === true);
  check('and still reaches admin',
    (await get('/api/admin/users', (ownerIn.setCookie || '').split(';')[0])).status === 200);

  console.log('\n================ RESULT ================');
  console.log(`passed: ${pass}   failed: ${failures.length}`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('\nHARNESS CRASH:', e); process.exit(2); });
