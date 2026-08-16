'use strict';

// Class Notes: photograph your notes, Slate types them up, and any note can be
// attached to a test to become flashcards.
//
// Two AI steps, both through src/claude.js (API key if there is one, otherwise
// the student's own Claude Code in a HIDDEN terminal — no window, no browser):
//
//   1. Reading the photo. Handwriting or a screenshot goes in, clean typed text
//      comes out. There is no offline fallback for this — nothing on the
//      machine can read handwriting — so a failure leaves the note in place
//      with an error on it and the student can type it in by hand instead.
//
//   2. Making flashcards. The whole note goes to Claude and it decides what is
//      actually worth studying. Deliberately NOT a rule that splits sentences:
//      a note is mostly filler, and a card per line is worse than no cards.
//      If this fails the note keeps its place on the test and can be retried —
//      a failed card run must never cost the student their note.

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const claude = require('./claude');

const DATA_DIR = process.env.SLATE_DATA_DIR || path.join(__dirname, '..', 'data');
const NOTES_DIR = path.join(DATA_DIR, 'notes', 'class-notes');

const MAX_UPLOAD_B64 = 12_000_000; // ~9 MB of image
const MAX_CARDS = 40;

const now = () => new Date().toISOString();

// ---- shapes ---------------------------------------------------------------
function noteRow(r, db) {
  const tests = db
    .prepare(
      `SELECT nt.test_id, nt.status, nt.error, nt.cards, t.name
       FROM note_tests nt JOIN tests t ON t.id = nt.test_id
       WHERE nt.note_id = ? ORDER BY nt.added_at`
    )
    .all(r.id);
  const text = r.text || '';
  return {
    id: r.id,
    class_id: r.class_id,
    title: r.title || 'Untitled note',
    text,
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 180),
    word_count: text.trim() ? text.trim().split(/\s+/).length : 0,
    has_image: !!r.image_file,
    image_url: r.image_file ? `/api/notes/${r.id}/image` : null,
    source: r.source || '',
    status: r.status || 'ready',
    error: r.error || '',
    created_at: r.created_at,
    updated_at: r.updated_at,
    tests: tests.map((t) => ({
      test_id: t.test_id, test_name: t.name, status: t.status, error: t.error || '', cards: t.cards || 0,
    })),
  };
}

function getNote(id) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM class_notes WHERE id = ?').get(Number(id));
  return r ? noteRow(r, db) : null;
}

function listNotes(classId) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM class_notes WHERE class_id = ? ORDER BY created_at DESC')
    .all(Number(classId))
    .map((r) => noteRow(r, db));
}

// Notes attached to a test, with the cards each one produced. This is what the
// test page shows.
function notesForTest(testId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT n.*, nt.status AS link_status, nt.error AS link_error, nt.cards AS link_cards
       FROM note_tests nt JOIN class_notes n ON n.id = nt.note_id
       WHERE nt.test_id = ? ORDER BY nt.added_at`
    )
    .all(Number(testId));
  return rows.map((r) => ({
    id: r.id,
    title: r.title || 'Untitled note',
    text: r.text || '',
    image_url: r.image_file ? `/api/notes/${r.id}/image` : null,
    status: r.link_status,
    error: r.link_error || '',
    cards: r.link_cards || 0,
  }));
}

// ---- reading a photo ------------------------------------------------------
const READ_PROMPT =
  'This is a photo or screenshot of a high-school student\'s class notes — handwritten or typed.\n' +
  'Type them up cleanly:\n' +
  '- Transcribe everything legible, keeping the original order, headings and list structure.\n' +
  '- Fix obvious spelling slips and expand shorthand where the meaning is clear.\n' +
  '- Do NOT add facts, explanations or content that is not on the page.\n' +
  '- If part is unreadable, write [unclear] there rather than guessing.\n' +
  '- Give it a short title (under 8 words) describing the topic.\n\n' +
  'Reply with ONLY valid JSON, no code fences and no commentary:\n' +
  '{"title":"...","text":"..."}';

function parseRead(reply) {
  const obj = claude.parseJson(reply);
  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  if (!text) throw new Error('nothing readable came back');
  const title = typeof obj.title === 'string' && obj.title.trim()
    ? obj.title.trim().slice(0, 120)
    : text.split('\n')[0].slice(0, 60) || 'Untitled note';
  return { title, text };
}

function safeFileName(noteId, filename) {
  const cleaned = String(filename || 'note.png').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-80);
  return `note-${noteId}-${cleaned}`;
}

// Saves the image and creates the note straight away, then reads it in the
// background. The note exists from the first moment, so a failed read is
// recoverable instead of losing the upload.
function addNoteFromImage(classId, filename, contentBase64) {
  const db = getDb();
  const cls = db.prepare('SELECT id FROM classes WHERE id = ?').get(Number(classId));
  if (!cls) return { ok: false, error: 'class not found' };
  if (!filename || !contentBase64) return { ok: false, error: 'no file was sent' };
  if (contentBase64.length > MAX_UPLOAD_B64) return { ok: false, error: 'That photo is too big (about 9 MB is the limit).' };

  const info = db
    .prepare("INSERT INTO class_notes (class_id, title, text, source, status, created_at, updated_at) VALUES (?,?,?,?,'reading',?,?)")
    .run(Number(classId), 'Reading your notes…', '', 'claude', now(), now());
  const noteId = Number(info.lastInsertRowid);

  let savedPath;
  try {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    const safe = safeFileName(noteId, filename);
    savedPath = path.join(NOTES_DIR, safe);
    fs.writeFileSync(savedPath, Buffer.from(contentBase64, 'base64'));
    db.prepare('UPDATE class_notes SET image_file = ? WHERE id = ?').run(safe, noteId);
  } catch (err) {
    failNote(noteId, `The photo could not be saved: ${err.message}`);
    return { ok: true, note: getNote(noteId) };
  }

  if (!claude.imageMediaType(savedPath)) {
    failNote(noteId, 'Slate can read png, jpg, gif and webp photos. Try a screenshot instead.');
    return { ok: true, note: getNote(noteId) };
  }

  claude.queued(async () => {
    try {
      const reply = await claude.askAboutImage(savedPath, READ_PROMPT, { timeoutMs: 180000, maxTokens: 4000 });
      const { title, text } = parseRead(reply);
      getDb()
        .prepare("UPDATE class_notes SET title=?, text=?, status='ready', error='', updated_at=? WHERE id=?")
        .run(title, text, now(), noteId);
      console.log(`[notes] read note ${noteId} (${text.length} chars)`);
    } catch (err) {
      console.warn('[notes] could not read note', noteId, '-', err.message);
      failNote(noteId, claude.aiDisabled()
        ? 'Reading photos is switched off in this copy of Slate. Type your notes in instead.'
        : "Slate couldn't read that photo. You can type the notes in yourself, or try a clearer picture.");
    }
  });

  return { ok: true, note: getNote(noteId) };
}

function failNote(noteId, message) {
  getDb()
    .prepare("UPDATE class_notes SET status='error', error=?, title=CASE WHEN title='Reading your notes…' THEN 'Untitled note' ELSE title END, updated_at=? WHERE id=?")
    .run(message, now(), noteId);
}

// ---- editing + deleting ---------------------------------------------------
function saveNote(id, { title, text }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM class_notes WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: 'note not found' };
  const cleanText = String(text == null ? row.text : text);
  const cleanTitle = String(title == null ? row.title : title).trim().slice(0, 120) || 'Untitled note';
  // Typing something in is itself the fix for a failed read, so clear the error.
  const status = cleanText.trim() ? 'ready' : row.status;
  db.prepare("UPDATE class_notes SET title=?, text=?, status=?, error=CASE WHEN ?='ready' THEN '' ELSE error END, updated_at=? WHERE id=?")
    .run(cleanTitle, cleanText, status, status, now(), Number(id));
  return { ok: true, note: getNote(id) };
}

function deleteNote(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM class_notes WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: 'note not found' };
  // The cards it produced go with it — leaving them behind would mean studying
  // from a note that no longer exists.
  db.prepare('DELETE FROM flashcards WHERE source_note_id = ?').run(row.id);
  db.prepare('DELETE FROM note_tests WHERE note_id = ?').run(row.id);
  db.prepare('DELETE FROM class_notes WHERE id = ?').run(row.id);
  if (row.image_file) {
    try { fs.unlinkSync(path.join(NOTES_DIR, row.image_file)); } catch { /* already gone */ }
  }
  return { ok: true, class_id: row.class_id };
}

function noteImagePath(id) {
  const row = getDb().prepare('SELECT image_file FROM class_notes WHERE id = ?').get(Number(id));
  if (!row || !row.image_file) return null;
  const p = path.join(NOTES_DIR, row.image_file);
  return fs.existsSync(p) ? p : null;
}

// ---- the thinking step ----------------------------------------------------
function cardPrompt(noteTitle, testName, testType, text) {
  return (
    `A high-school student is studying for "${testName}" (a ${testType}). These are their class notes.\n\n` +
    'Read the whole thing and work out what is actually worth studying before writing anything. Think about:\n' +
    '- facts, definitions, key concepts and vocabulary\n' +
    '- dates, names, numbers and formulas\n' +
    '- cause and effect, processes and sequences, comparisons and contrasts\n' +
    '- what a teacher is likely to put on the test\n\n' +
    'Then write flashcards for the material that deserves them. This is the important part:\n' +
    '- Do NOT make one card per line, per sentence or per paragraph.\n' +
    '- Skip admin and filler — page numbers, homework reminders, "see textbook", dates of lessons, doodles.\n' +
    '- Skip anything too vague to have a right answer.\n' +
    '- Merge duplicates. One idea, one card.\n' +
    '- A good front is a real question or a term. A good back is the shortest complete answer.\n' +
    '- Sparse or trivial notes should produce few cards, or none. Quality over count.\n' +
    `- Never more than ${MAX_CARDS} cards.\n\n` +
    'Reply with ONLY valid JSON, no code fences and no commentary:\n' +
    '{"flashcards":[{"front":"...","back":"...","topic":"..."}]}\n\n' +
    `NOTE TITLE: ${noteTitle}\nNOTES:\n${String(text).slice(0, 40000)}`
  );
}

// Structured validation, not prose parsing: anything that isn't a usable
// front/back pair is dropped rather than guessed at.
function parseCards(reply) {
  const obj = claude.parseJson(reply);
  const list = Array.isArray(obj) ? obj : obj.flashcards;
  if (!Array.isArray(list)) throw new Error('no flashcards array in the reply');

  const seen = new Set();
  const cards = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const front = String(raw.front == null ? '' : raw.front).trim().slice(0, 300);
    const back = String(raw.back == null ? '' : raw.back).trim().slice(0, 1200);
    if (!front || !back) continue;
    const key = front.toLowerCase();
    if (seen.has(key)) continue; // Claude repeating itself
    seen.add(key);
    const topic = raw.topic == null ? '' : String(raw.topic).trim().slice(0, 80);
    cards.push({ front, back, topic });
    if (cards.length >= MAX_CARDS) break;
  }
  if (!cards.length) throw new Error('no usable flashcards came back');
  return cards;
}

function storeCards(testId, noteId, cards) {
  const db = getDb();
  // Never duplicate a front already on this test, whoever made it.
  const have = new Set(
    db.prepare('SELECT front FROM flashcards WHERE test_id=?').all(testId).map((r) => (r.front || '').toLowerCase().trim())
  );
  const insert = db.prepare(
    'INSERT INTO flashcards (test_id, front, back, confidence_level, source_note_id) VALUES (?,?,?,0,?)'
  );
  let added = 0;
  for (const c of cards) {
    const key = c.front.toLowerCase();
    if (have.has(key)) continue;
    insert.run(testId, c.front, c.back, noteId);
    have.add(key);
    added += 1;
  }
  return added;
}

// Attach a note to a test and start thinking. Returns immediately; the page
// polls the note until the link says done or error.
function addNoteToTest(noteId, testId) {
  const db = getDb();
  const note = db.prepare('SELECT * FROM class_notes WHERE id = ?').get(Number(noteId));
  if (!note) return { ok: false, error: 'note not found' };
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(Number(testId));
  if (!test) return { ok: false, error: 'test not found' };
  if (test.class_id !== note.class_id) return { ok: false, error: 'That test belongs to a different class.' };
  if (!String(note.text || '').trim()) {
    return { ok: false, error: 'This note has no text yet, so there is nothing to make cards from.' };
  }

  const existing = db.prepare('SELECT * FROM note_tests WHERE note_id=? AND test_id=?').get(note.id, test.id);
  if (existing && existing.status === 'thinking') return { ok: true, already: true, note: getNote(note.id) };
  if (existing && existing.status === 'done') {
    // Already on this test — say so rather than making a second set of cards.
    return { ok: true, already: true, note: getNote(note.id) };
  }
  if (existing) {
    db.prepare("UPDATE note_tests SET status='thinking', error='', added_at=? WHERE note_id=? AND test_id=?")
      .run(now(), note.id, test.id);
  } else {
    db.prepare("INSERT INTO note_tests (note_id, test_id, status, cards, added_at) VALUES (?,?,'thinking',0,?)")
      .run(note.id, test.id, now());
  }

  claude.queued(async () => {
    try {
      const reply = await claude.ask(
        cardPrompt(note.title || 'Class notes', test.name, test.type || 'test', note.text),
        { timeoutMs: 240000, maxTokens: 8000 }
      );
      const cards = parseCards(reply);
      const added = storeCards(test.id, note.id, cards);
      getDb().prepare("UPDATE note_tests SET status='done', error='', cards=? WHERE note_id=? AND test_id=?")
        .run(added, note.id, test.id);
      console.log(`[notes] note ${note.id} -> ${added} cards on test ${test.id}`);
    } catch (err) {
      console.warn('[notes] flashcards failed for note', note.id, '-', err.message);
      // The note stays attached and keeps its text. Only the cards failed.
      getDb().prepare("UPDATE note_tests SET status='error', error=? WHERE note_id=? AND test_id=?")
        .run(claude.aiDisabled()
          ? 'Flashcard making is switched off in this copy of Slate.'
          : "Slate couldn't make flashcards from this note. Your note is safe — try again in a moment.",
        note.id, test.id);
    }
  });

  return { ok: true, note: getNote(note.id) };
}

function removeNoteFromTest(noteId, testId) {
  const db = getDb();
  db.prepare('DELETE FROM flashcards WHERE source_note_id=? AND test_id=?').run(Number(noteId), Number(testId));
  db.prepare('DELETE FROM note_tests WHERE note_id=? AND test_id=?').run(Number(noteId), Number(testId));
  return { ok: true, note: getNote(noteId) };
}

// The tests a note can be added to: the ones in its own class.
function testsForNote(noteId) {
  const db = getDb();
  const note = db.prepare('SELECT class_id FROM class_notes WHERE id = ?').get(Number(noteId));
  if (!note) return [];
  const on = new Set(db.prepare('SELECT test_id FROM note_tests WHERE note_id=?').all(Number(noteId)).map((r) => r.test_id));
  return db
    .prepare('SELECT id, name, type, due_date FROM tests WHERE class_id=? ORDER BY due_date')
    .all(note.class_id)
    .map((t) => ({ ...t, already_added: on.has(t.id) }));
}

module.exports = {
  listNotes, getNote, notesForTest, addNoteFromImage, saveNote, deleteNote,
  noteImagePath, addNoteToTest, removeNoteFromTest, testsForNote,
  parseCards, parseRead, NOTES_DIR,
};
