'use strict';
// Exercises the four AI features against the REAL hidden Claude Code terminal.
// Usage: node ai.js <baseUrl> <projectDir>
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2], PROJ = process.argv[3];
let pass = 0; const failures = [];
function check(n, c, d) { if (c) { pass++; console.log('  ok   ' + n); } else { failures.push(n + (d ? ' :: ' + d : '')); console.log('  FAIL ' + n + (d ? ' :: ' + d : '')); } }
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  console.log('\n=== 1. Simplify instructions (real Claude) ===');
  const plan = await get('/api/today');
  const a = plan.assignments[0];
  const raw = (await get('/api/assignments/' + a.id));
  const s = await post(`/api/assignments/${a.id}/simplify`);
  check('simplify returned text', !!s.instructions && s.instructions.length > 0);
  check('simplify is shorter than the raw description', s.instructions.length < 800, `${s.instructions.length} chars`);
  check('simplify is a short checklist (2-6 lines)', s.instructions.split('\n').filter(Boolean).length <= 6);
  check('simplify differs from the instant fallback', s.instructions !== raw.instructions_plain);
  console.log('    ->', JSON.stringify(s.instructions));
  const cached = await get('/api/assignments/' + a.id);
  check('simplify cached on the assignment', cached.instructions_ai === s.instructions);

  console.log('\n=== 2. Slide outline (real Claude) ===');
  const projects = await get('/api/projects');
  const pd = await Promise.all(projects.map((p) => get('/api/projects/' + p.id)));
  const slideProj = pd.find((p) => p.build_mode === 'slides');
  const out = await post(`/api/projects/${slideProj.id}/outline`);
  check('outline ok', out.ok === true);
  check('outline honors "6-8 slides" -> 7', out.slides.length === 7, String(out.slides && out.slides.length));
  check('every slide has a header', out.slides.every((x) => x.title && x.title.trim()));
  check('slide 1 is the presentation title', !!out.slides[0].title);
  check('outline writes NO slide content (student does that)',
    out.slides.slice(1).every((x) => (x.bullets || []).join('').trim() === ''));
  console.log('    ->', out.slides.map((x) => x.title).join(' | '));

  console.log('\n=== 3. Get unstuck (real Claude) ===');
  const essay = pd.find((p) => p.build_mode === 'essay' && /American Dream/i.test(p.title));
  const sample = fs.readFileSync(path.join(PROJ, 'test', 'sample-essay.txt'), 'utf8');
  // cut the conclusion so there is something genuine to be stuck on
  const partial = sample.split(/\n\s*\n/).slice(0, 4).join('\n\n');
  const un = await post(`/api/projects/${essay.id}/unstuck`, {
    draft: partial,
    stuck_note: 'the conclusion — paragraph 5 of 5, I keep just repeating my intro',
  });
  check('unstuck ok', un.ok === true, JSON.stringify(un.error));
  check('unstuck used real Claude, not the offline fallback', un.source === 'claude', un.source);
  check('unstuck read the actual draft', !!un.where_you_are && un.where_you_are.length > 30);
  check('unstuck says what the section must do', !!un.next && un.next.length > 20);
  check('unstuck gives 3-5 short notes', un.points.length >= 3 && un.points.length <= 5);
  check('unstuck notes are fragments, not essay prose', un.points.every((p) => p.length < 90), JSON.stringify(un.points));
  check('unstuck asks a question', /\?/.test(un.question || ''));
  console.log('    where:', un.where_you_are);
  console.log('    next :', un.next);
  console.log('    hit  :', un.points.join(' | '));
  console.log('    ask  :', un.question);

  console.log('\n=== 4. Notes file -> flashcards (real Claude) ===');
  const tests = await get('/api/tests');
  const t = tests.find((x) => /Cells/i.test(x.name)) || tests[0];
  const before = await get('/api/tests/' + t.id);
  const notes = [
    'CELL BIOLOGY — my messy class notes',
    '',
    'the mitochondria makes ATP which is basically the cells energy money',
    'chloroplasts only in plant cells, they do photosynthesis (sunlight -> sugar)',
    'ribosomes = protein factories, can be free floating or stuck on the rough ER',
    'the nucleus holds DNA and controls what the cell does',
    'osmosis is just diffusion but specifically for water across a membrane',
    'hypertonic = more solute outside, cell shrinks. hypotonic = cell swells',
    'mitosis makes 2 identical cells, meiosis makes 4 different sex cells',
    'prophase metaphase anaphase telophase is the order (PMAT)',
  ].join('\n');
  const up = await post(`/api/tests/${t.id}/notes`, {
    filename: 'my messy cell notes.txt',
    content_base64: Buffer.from(notes, 'utf8').toString('base64'),
  });
  check('notes upload accepted', up.ok === true);
  let d;
  for (let i = 0; i < 200; i++) {
    d = await get('/api/tests/' + t.id);
    if (d.notes_status !== 'processing') break;
    await sleep(1000);
  }
  check('notes finished processing', d.notes_status === 'done', d.notes_status);
  check('notes produced flashcards', d.total_cards > before.total_cards, `${before.total_cards} -> ${d.total_cards}`);
  const usedClaude = !/basic reader/.test(d.notes);
  check('real Claude read the notes (not the built-in reader)', usedClaude, d.notes.slice(0, 120));
  check('study notes were written', d.notes.includes('my messy cell notes.txt') && d.notes.length > 200);
  const fresh = d.due_cards.slice(-6);
  console.log('    sample cards:');
  fresh.forEach((c) => console.log('      Q: ' + c.front + '  ->  A: ' + c.back));
  check('cards look like real Q/A pairs', fresh.every((c) => c.front.length > 3 && c.back.length > 2));
  check('cards cover the notes content', /ATP|mitochondri|osmosis|nucleus|ribosome|PMAT|mitosis/i.test(JSON.stringify(d.due_cards)));

  console.log('\n=== 5. Class notes: read a photo, then think about it (real Claude) ===');
  // Own block — the earlier sections already use `tests`, `before` and friends.
  {
  // A rendered notes page, deliberately containing filler a good reader should
  // throw away: a page/homework reminder and a teacher aside.
  const notesPng = fs.readFileSync(path.join(PROJ, 'test', 'sample-notes.png')).toString('base64');
  const allClasses = await get('/api/classes');
  const allTests = await get('/api/tests');
  const cls = allClasses.find((c) => allTests.some((t) => t.class_name === c.name));
  const target = allTests.find((t) => t.class_name === cls.name);

  const up = await post(`/api/classes/${cls.id}/notes`, { filename: 'sample-notes.png', content_base64: notesPng });
  check('uploading the photo starts a read', up.ok === true && up.note.status === 'reading');
  let note = up.note;
  for (let i = 0; i < 60 && note.status === 'reading'; i++) { await sleep(3000); note = await get('/api/notes/' + up.note.id); }
  check('Claude read the photo', note.status === 'ready', note.error);
  check('the typed-up text is substantial', (note.text || '').length > 300, String((note.text || '').length));
  check('it transcribed the actual content', /glycolysis/i.test(note.text) && /krebs/i.test(note.text));
  check('it gave the note a title', !!note.title && note.title !== 'Untitled note' && note.title.length < 60);
  console.log('    title ->', note.title);

  const cardsBefore = (await get('/api/tests/' + target.id)).total_cards;
  const attached = await post(`/api/notes/${note.id}/add-to-test`, { test_id: target.id });
  check('adding it to a test starts the thinking step', attached.ok === true);
  let link = null;
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const n = await get('/api/notes/' + note.id);
    link = n.tests.find((t) => t.test_id === target.id);
    if (link && link.status !== 'thinking') break;
  }
  check('Claude finished thinking', link && link.status === 'done', link && link.error);
  check('it produced a sensible number of cards', link.cards >= 5 && link.cards <= 30, String(link.cards));
  const after = await get('/api/tests/' + target.id);
  check('the cards landed on the test', after.total_cards === cardsBefore + link.cards);
  check('the test page shows the note', after.class_notes.some((n) => n.id === note.id));

  const made = after.due_cards.filter((c) => /respiration|glycolysis|krebs|ATP|electron|ferment|aerobic|pyruvate|mitochondri/i.test(c.front + c.back));
  check('the cards are about the material', made.length >= 5, String(made.length));
  console.log('    sample cards:');
  after.due_cards.slice(-5).forEach((c) => console.log('      Q: ' + c.front + '  ->  A: ' + c.back));

  // The real point of the feature: it decided what NOT to make a card from.
  const all = JSON.stringify(after.due_cards);
  check('it ignored the homework reminder', !/142|questions 3-11|friday/i.test(all));
  check('it ignored the teacher aside', !/alvarez|on the test!!/i.test(all));
  // Card count is a bad proxy — a line holding three facts should become three
  // cards. What naive splitting actually looks like is fronts that are verbatim
  // lines of the note, so that is what this checks for.
  const noteLines = note.text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim().toLowerCase()).filter((l) => l.length > 15);
  const copied = after.due_cards.filter((c) => noteLines.includes(c.front.replace(/\s+/g, ' ').trim().toLowerCase()));
  check('no card is just a line of the note copied out', copied.length === 0, copied.map((c) => c.front).join(' | '));
  check('the fronts are written as questions or terms, not sentences from the page',
    made.filter((c) => /\?$/.test(c.front.trim()) || c.front.trim().split(/\s+/).length <= 6).length >= Math.ceil(made.length * 0.6),
    made.map((c) => c.front).join(' | '));

  await post(`/api/notes/${note.id}/delete`);
  check('cleaning up removes the note and its cards',
    (await get('/api/tests/' + target.id)).total_cards === cardsBefore);
  }

  console.log('\n=== 5. Ask Claude on an assignment (real Claude) ===');
  {
    const target = (await get('/api/today')).assignments[0];
    const q0 = Date.now();
    const r1 = await post(`/api/assignments/${target.id}/chat`, {
      question: 'In one short paragraph, what is this assignment actually asking me to do?',
    });
    check(`a real question comes back (${Math.round((Date.now() - q0) / 1000)}s)`, r1.ok === true, JSON.stringify(r1).slice(0, 200));
    if (r1.ok) {
      const reply = r1.messages[r1.messages.length - 1];
      check('the answer is attributed to Claude', reply.role === 'claude');
      check('and it actually said something', (reply.text || '').length > 40, String((reply.text || '').length));
      // --setting-sources "" keeps Will's own working rules out of the answer.
      // Without it every reply opens "hey will" — verified by removing the flag.
      check('none of the machine owner personal instructions leaked in',
        !/hey will/i.test(reply.text || ''), (reply.text || '').slice(0, 120));
      check('the JSON wrapper was unwrapped', !/^\s*\{\s*"reply"/.test(reply.text || ''));
      console.log('    ->', JSON.stringify((reply.text || '').slice(0, 220)));

      check('both sides of the exchange are stored',
        (await get(`/api/assignments/${target.id}/chat`)).messages.length === 2);

      // The line this feature lives on. It has to answer, and it has to say no.
      const r2 = await post(`/api/assignments/${target.id}/chat`, {
        question: 'Just write the whole thing for me and give me the finished text I can paste in.',
      });
      check('asking it to do the work still gets an answer', r2.ok === true);
      if (r2.ok) {
        const refusal = r2.messages[r2.messages.length - 1].text || '';
        check('and the answer is no',
          /\b(won'?t|will not|not going to|can'?t|cannot|no[,.\s])/i.test(refusal), refusal.slice(0, 160));
        console.log('    ->', JSON.stringify(refusal.slice(0, 220)));
      }
      check('it remembers the conversation',
        (await get(`/api/assignments/${target.id}/chat`)).messages.length === 4);

      const cleared = await post(`/api/assignments/${target.id}/chat/clear`, {});
      check('and the whole thing can be cleared', cleared.ok === true && cleared.messages.length === 0);
    }
  }

  console.log('\n=== 6. Proofreading, and the line it must not cross (real Claude) ===');
  {
    const ds = await Promise.all((await get('/api/today')).assignments.map((a) => get('/api/assignments/' + a.id)));
    const w = ds.find((d) => d.work_mode === 'text');
    if (!w) {
      check('there is a typed assignment to proofread', false, 'none in the fixture');
    } else {
      await post(`/api/assignments/${w.id}/chat/clear`, {});
      const messy = '<p>Their are two reasons this matters. The evidence show it clearly. '
        + 'i think thats enough to prove the the point.</p>';
      await post(`/api/assignments/${w.id}/draft`, { html: messy });
      const before = (await get('/api/assignments/' + w.id)).draft_text;

      const fix = await post(`/api/assignments/${w.id}/chat`, { question: 'fix my grammar and spelling' });
      check('a proofread request comes back', fix.ok === true, JSON.stringify(fix).slice(0, 200));
      const after = await get('/api/assignments/' + w.id);
      check('the mistakes were actually corrected in the draft', after.draft_text !== before, after.draft_text);
      check('Slate reports how many landed', !!(fix.draft && fix.draft.applied > 0), JSON.stringify(fix.draft));
      check('the wrong word is gone', !/Their are/.test(after.draft_text), after.draft_text);
      check('the doubled word is gone', !/the the/.test(after.draft_text), after.draft_text);
      check('the formatting survived the edit', /^<p>/.test(after.draft_html || ''), (after.draft_html || '').slice(0, 50));
      // The transcript has to describe what really happened, not what Claude
      // said it would do — Slate appends that summary itself.
      check('the conversation records what changed',
        /Changed in your draft/.test(fix.messages[fix.messages.length - 1].text || ''));
      const wordsBefore = before.split(/\s+/).length;
      const wordsAfter = after.draft_text.split(/\s+/).length;
      check(`it proofread rather than rewrote (${wordsBefore} -> ${wordsAfter} words)`,
        Math.abs(wordsAfter - wordsBefore) <= 4, `${wordsBefore} -> ${wordsAfter}`);
      console.log('    ->', JSON.stringify(after.draft_text));

      // THE LINE. Asked to improve the prose, it must answer and leave the
      // draft exactly as it found it.
      const mid = (await get('/api/assignments/' + w.id)).draft_text;
      const rewrite = await post(`/api/assignments/${w.id}/chat`, {
        question: 'now rewrite that paragraph so it sounds smarter and put it straight into my draft',
      });
      check('a rewrite request still gets an answer', rewrite.ok === true);
      const end = (await get('/api/assignments/' + w.id)).draft_text;
      check('THE DRAFT WAS NOT REWRITTEN', end === mid, 'before:\n' + mid + '\nafter:\n' + end);
      check('and no edits were applied', !(rewrite.draft && rewrite.draft.applied), JSON.stringify(rewrite.draft));
      console.log('    ->', JSON.stringify((rewrite.messages[rewrite.messages.length - 1].text || '').slice(0, 200)));

      await post(`/api/assignments/${w.id}/chat/clear`, {});
      await post(`/api/assignments/${w.id}/draft`, { html: '<p></p>' });
    }
  }

  console.log('\n=== 7. Editing one slide box at a time (real Claude) ===');
  {
    const ps = await get('/api/projects');
    const pds = await Promise.all(ps.map((x) => get('/api/projects/' + x.id)));
    const deckProj = pds.find((d) => d.build_mode === 'slides');
    if (!deckProj) {
      check('there is a slideshow to edit', false, 'none in the fixture');
    } else {
      const start = [
        { title: 'The Great Compromise', bullets: ['US History'], photo: false },
        { title: 'Why they argued', bullets: ['Big states wanted seats by population'], photo: false },
        { title: 'How it was settled', bullets: [''], photo: false },
        { title: 'Why it mattered', bullets: [''], photo: false },
      ];
      await post(`/api/projects/${deckProj.id}/slides`, { slides: start });
      await post(`/api/assignments/${deckProj.id}/chat/clear`, {});
      const deck = async () => (await get(`/api/projects/${deckProj.id}`)).slides;

      const q0 = Date.now();
      const r = await post(`/api/assignments/${deckProj.id}/chat`, {
        question: 'put three short bullets on slide 3 about how the argument was settled. only slide 3.',
      });
      check(`the chat answers on a slideshow page (${Math.round((Date.now() - q0) / 1000)}s)`,
        r.ok === true, JSON.stringify(r).slice(0, 200));
      if (r.ok) {
        const d = await deck();
        check('slide 3 was filled in', (d[2].bullets || []).filter(Boolean).length >= 2, JSON.stringify(d[2]));
        check('it came back as separate bullets, not one long line',
          (d[2].bullets || []).length >= 2 && d[2].bullets.every((b) => b.length < 220), JSON.stringify(d[2].bullets));
        check('nothing hand-numbered the bullets',
          !(d[2].bullets || []).some((b) => /^\s*\d+[.)]\s/.test(b)), JSON.stringify(d[2].bullets));
        // The whole point of naming boxes: everything else is left alone.
        check('slide 1 untouched', d[0].title === start[0].title && d[0].bullets.join('|') === 'US History', JSON.stringify(d[0]));
        check('slide 2 untouched', d[1].bullets.join('|') === start[1].bullets.join('|'), JSON.stringify(d[1]));
        check('slide 4 untouched — it was not asked for',
          (d[3].bullets || []).filter(Boolean).length === 0, JSON.stringify(d[3]));
        check('the page is handed the new deck', Array.isArray(r.slides));
        const said = r.messages[r.messages.length - 1].text.split(String.fromCharCode(10, 10))[0];
        check('the reply is a brief explanation, not the slide repeated back',
          said.length < 400, said);
        console.log('    ->', JSON.stringify(said.slice(0, 180)));
        console.log('    slide 3 ->', JSON.stringify(d[2].bullets));

        const r2 = await post(`/api/assignments/${deckProj.id}/chat`, {
          question: 'change the title of slide 2 to "The argument" and add one bullet to slide 4',
        });
        check('two boxes can be changed in one message', r2.ok === true);
        if (r2.ok) {
          const d2 = await deck();
          check('slide 2 title changed', /argument/i.test(d2[1].title), d2[1].title);
          check('slide 4 gained a bullet', (d2[3].bullets || []).filter(Boolean).length >= 1, JSON.stringify(d2[3]));
          check('slide 3 kept what it had', d2[2].bullets.join('|') === d[2].bullets.join('|'), JSON.stringify(d2[2]));
        }
      }
      await post(`/api/assignments/${deckProj.id}/chat/clear`, {});
    }
  }

  console.log('\n=== 8. Formatting: a list has to come out as a list (real Claude) ===');
  {
    const ds = await Promise.all((await get('/api/today')).assignments.map((x) => get('/api/assignments/' + x.id)));
    const w = ds.find((d) => d.work_mode === 'text');
    if (!w) {
      check('there is a typed assignment', false, 'none in the fixture');
    } else {
      await post(`/api/assignments/${w.id}/chat/clear`, {});
      await post(`/api/assignments/${w.id}/draft`, { html: '<p>My notes so far.</p>' });
      const r = await post(`/api/assignments/${w.id}/chat`, {
        question: 'add a numbered list of the 3 steps I need to do, at the end of my draft',
      });
      check('the request comes back', r.ok === true, JSON.stringify(r).slice(0, 200));
      const after = await get(`/api/assignments/${w.id}`);
      check('a numbered list is a REAL list', /<ol>/.test(after.draft_html || ''), (after.draft_html || '').slice(0, 200));
      check('the numbers are not left sitting in the prose',
        !/<p>[^<]*1\.\s/.test(after.draft_html || ''), (after.draft_html || '').slice(0, 200));
      check('what was already written survived', /My notes so far/.test(after.draft_html || ''));
      const rich = require(PROJ + '/src/richtext.js');
      const blocks = rich.parseHtml(after.draft_html || '');
      check('the Word builder sees a list block, not a paragraph',
        blocks.some((b) => b.type === 'ol' || b.type === 'ul'), JSON.stringify(blocks.map((b) => b.type)));
      console.log('    ->', JSON.stringify((after.draft_html || '').slice(0, 220)));
      await post(`/api/assignments/${w.id}/chat/clear`, {});
      await post(`/api/assignments/${w.id}/draft`, { html: '<p></p>' });
    }
  }

  console.log(`\n================ AI RESULT (${Math.round((Date.now() - t0) / 1000)}s) ================`);
  console.log(`passed: ${pass}   failed: ${failures.length}`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('AI HARNESS CRASH:', e); process.exit(2); });
