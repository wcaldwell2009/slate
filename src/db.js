'use strict';

// Slate database layer — uses Node's built-in SQLite (node:sqlite).
// No native modules, no install. The DB file lives in ./data/slate.db.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// The installed copy of Slate keeps its data outside the app folder (which is
// deleted and replaced on every update), so SLATE_DATA_DIR points there.
const DATA_DIR = process.env.SLATE_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.SLATE_DB_PATH || path.join(DATA_DIR, 'slate.db');

let db = null;

function getDb() {
  if (db) return db;
  if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS classes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      canvas_class_id TEXT UNIQUE,
      weight          REAL DEFAULT 1.0   -- relative grade weight for impact sort
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id             INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      canvas_assignment_id TEXT UNIQUE,
      title                TEXT NOT NULL,   -- cleaned title
      raw_title            TEXT,            -- original Canvas title
      description          TEXT,            -- simplified summary (final deliverable)
      raw_description      TEXT,            -- original HTML/text from Canvas
      steps                TEXT,            -- JSON array of step strings
      files                TEXT,            -- JSON array of {name,url}
      type                 TEXT DEFAULT 'regular', -- 'regular' | 'project'
      points               REAL DEFAULT 0,
      due_date             TEXT,            -- ISO date (YYYY-MM-DD)
      status               TEXT DEFAULT 'todo', -- 'todo' | 'done'
      time_logged          INTEGER DEFAULT 0,   -- seconds spent (focus timer)
      submission_types     TEXT,            -- JSON array from Canvas
      work_mode            TEXT DEFAULT 'guide', -- 'text' (type answers here) | 'guide' (instructions only)
      draft_text           TEXT,            -- what the student has typed so far
      build_mode           TEXT DEFAULT 'none', -- 'slides' (slideshow builder) | 'none'
      slides_json          TEXT,            -- JSON array of {title,bullets[]} for slideshow projects
      instructions_simple  TEXT,            -- AI-simplified instructions (cached), plain easy words
      essay_title          TEXT             -- the title the student gives their essay (MLA heading)
    );

    CREATE TABLE IF NOT EXISTS project_chunks (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id     INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      day               TEXT,              -- ISO date this chunk is scheduled
      chunk_description TEXT,
      done              INTEGER DEFAULT 0  -- 0/1
    );

    CREATE TABLE IF NOT EXISTS tests (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id            INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      canvas_test_id      TEXT UNIQUE,
      name                TEXT NOT NULL,
      type                TEXT DEFAULT 'test',  -- 'test' | 'quiz'
      due_date            TEXT,
      study_guide_url     TEXT,
      mastery_pct         REAL DEFAULT 0,       -- 0..100 studied
      time_budget_minutes INTEGER DEFAULT 120,  -- study goal: 2h tests, 30m quizzes
      time_logged         INTEGER DEFAULT 0,    -- seconds studied, across sessions
      notes               TEXT,                 -- distilled study notes from dropped files
      notes_status        TEXT DEFAULT 'none',  -- none | processing | done | error
      notes_file          TEXT                  -- original filename(s) dropped
    );

    CREATE TABLE IF NOT EXISTS flashcards (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id          INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      front            TEXT,
      back             TEXT,
      confidence_level INTEGER DEFAULT 0,  -- 0=new, higher=better known
      next_review_date TEXT                -- ISO date
    );

    -- Saved versions of a draft as it gets written. This is Will's own record
    -- that he wrote the thing himself: when he worked, and how it grew.
    CREATE TABLE IF NOT EXISTS draft_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      taken_at      TEXT,     -- ISO datetime
      words         INTEGER,
      text          TEXT
    );

    CREATE TABLE IF NOT EXISTS grades (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id  INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      points_earned  REAL,
      points_possible REAL
    );

    CREATE TABLE IF NOT EXISTS emails (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      canvas_id  TEXT UNIQUE,
      subject    TEXT,
      from_name  TEXT,
      received   TEXT,   -- ISO datetime
      body       TEXT
    );

    -- Every chunk of time worked, stamped with the LOCAL calendar day it was
    -- worked on. The running totals on tests and assignments only ever go up
    -- (they measure readiness), so this is what answers "how much have I done
    -- today" — a new day simply has no rows yet.
    CREATE TABLE IF NOT EXISTS time_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      day       TEXT NOT NULL,    -- YYYY-MM-DD, local
      kind      TEXT NOT NULL,    -- 'test' | 'assignment'
      ref_id    INTEGER,
      seconds   INTEGER NOT NULL,
      logged_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_time_log_day ON time_log(day);

    -- A photo of handwritten or typed notes, typed up by Claude. Belongs to a
    -- class; can be attached to any number of that class's tests.
    CREATE TABLE IF NOT EXISTS class_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      title      TEXT,
      text       TEXT,                   -- the typed-up version; the student can edit it
      image_file TEXT,                   -- original photo, kept in data/notes/class-notes
      source     TEXT,                   -- 'claude' | 'typed'
      status     TEXT DEFAULT 'reading', -- reading | ready | error
      error      TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    -- Which notes have been added to which test. One test holds many notes and
    -- one note can go on several tests; the primary key is what stops the same
    -- note being added to the same test twice.
    CREATE TABLE IF NOT EXISTS note_tests (
      note_id  INTEGER NOT NULL REFERENCES class_notes(id) ON DELETE CASCADE,
      test_id  INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      status   TEXT DEFAULT 'thinking',  -- thinking | done | error
      error    TEXT,
      cards    INTEGER DEFAULT 0,        -- how many flashcards this note produced
      added_at TEXT,
      PRIMARY KEY (note_id, test_id)
    );

    -- Accounts. The owner row is Will: it exists from first run, can't be
    -- deleted or frozen, and is always an admin.
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      password_hash TEXT,                  -- scrypt$salt$hash; null = not set yet
      is_admin      INTEGER DEFAULT 0,
      is_frozen     INTEGER DEFAULT 0,     -- frozen: can't sign in, keeps their work
      is_owner      INTEGER DEFAULT 0,
      created_at    TEXT
    );

    -- One row per signed-in device. This is what the Admin page counts.
    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      device     TEXT,    -- readable, e.g. "Chrome on Windows"
      ip         TEXT,
      created_at TEXT,
      last_seen  TEXT
    );
  `);

  // Additive migrations for databases created before these columns existed.
  const cols = db.prepare('PRAGMA table_info(assignments)').all().map((r) => r.name);
  if (!cols.includes('submission_types')) db.exec('ALTER TABLE assignments ADD COLUMN submission_types TEXT');
  if (!cols.includes('work_mode')) db.exec("ALTER TABLE assignments ADD COLUMN work_mode TEXT DEFAULT 'guide'");
  if (!cols.includes('draft_text')) db.exec('ALTER TABLE assignments ADD COLUMN draft_text TEXT');
  if (!cols.includes('build_mode')) db.exec("ALTER TABLE assignments ADD COLUMN build_mode TEXT DEFAULT 'none'");
  if (!cols.includes('slides_json')) db.exec('ALTER TABLE assignments ADD COLUMN slides_json TEXT');
  if (!cols.includes('instructions_simple')) db.exec('ALTER TABLE assignments ADD COLUMN instructions_simple TEXT');
  if (!cols.includes('essay_title')) db.exec('ALTER TABLE assignments ADD COLUMN essay_title TEXT');
  // The real Canvas deadline, kept alongside due_date. due_date is the day the
  // work has to be DONE on, which for anything due before noon is the day
  // before — see workDayFor() in dates.js.
  if (!cols.includes('due_at')) db.exec('ALTER TABLE assignments ADD COLUMN due_at TEXT');
  // When it was marked done, so Today can show what was finished TODAY —
  // separate from work Canvas imported as already-graded, which has no stamp.
  if (!cols.includes('completed_at')) db.exec('ALTER TABLE assignments ADD COLUMN completed_at TEXT');
  // Last GPTZero result for this draft, cached against a hash of the text so
  // reopening the hand-in screen doesn't spend another check.
  if (!cols.includes('ai_check')) db.exec('ALTER TABLE assignments ADD COLUMN ai_check TEXT');
  // The LOCAL day it was finished. completed_at is a UTC instant, and SQLite's
  // date() on it rolls over at 8pm Eastern — so anything finished in the
  // evening vanished from "Finished today". Same lesson as time_log.day.
  if (!cols.includes('completed_day')) db.exec('ALTER TABLE assignments ADD COLUMN completed_day TEXT');
  // The formatted draft. draft_text stays the plain-text version of the same
  // thing so word counts, the essay outline, the AI checker and the MLA
  // splitter all keep working on plain text as they always have.
  if (!cols.includes('draft_html')) db.exec('ALTER TABLE assignments ADD COLUMN draft_html TEXT');
  // Set only when the student picks a font or size themselves. Null means MLA.
  if (!cols.includes('doc_font')) db.exec('ALTER TABLE assignments ADD COLUMN doc_font TEXT');
  if (!cols.includes('doc_size')) db.exec('ALTER TABLE assignments ADD COLUMN doc_size REAL');
  // What the attached Canvas files actually say, read once and kept. Teachers
  // routinely put the real directions in an attached .docx or PDF and leave the
  // description box nearly empty, so the Instructions box is built from both.
  // Which Canvas assignment group this belongs to. Will's school runs
  // Formative / Summative at 50-50, and that split is the thing he wants to see
  // on a class. `category` is the normalised 'formative' | 'summative' | null;
  // `group_name` keeps whatever the teacher actually called it.
  if (!cols.includes('category')) db.exec('ALTER TABLE assignments ADD COLUMN category TEXT');
  if (!cols.includes('group_name')) db.exec('ALTER TABLE assignments ADD COLUMN group_name TEXT');
  if (!cols.includes('attachment_text')) db.exec('ALTER TABLE assignments ADD COLUMN attachment_text TEXT');
  // 'none' | 'reading' | 'done' | 'error' — the page shows which, and an error
  // never stops the file being opened by hand.
  if (!cols.includes('attachment_state')) db.exec("ALTER TABLE assignments ADD COLUMN attachment_state TEXT DEFAULT 'none'");
  // Which note a card came from, so a note's cards can be found (and cleaned up)
  // later. Null for cards made before class notes existed, and for the older
  // drag-a-file-onto-a-test path.
  const fcols = db.prepare('PRAGMA table_info(flashcards)').all().map((r) => r.name);
  if (!fcols.includes('source_note_id')) db.exec('ALTER TABLE flashcards ADD COLUMN source_note_id INTEGER');
  const tcols = db.prepare('PRAGMA table_info(tests)').all().map((r) => r.name);
  if (!tcols.includes('notes')) db.exec('ALTER TABLE tests ADD COLUMN notes TEXT');
  if (!tcols.includes('notes_status')) db.exec("ALTER TABLE tests ADD COLUMN notes_status TEXT DEFAULT 'none'");
  if (!tcols.includes('notes_file')) db.exec('ALTER TABLE tests ADD COLUMN notes_file TEXT');
  if (!tcols.includes('due_at')) db.exec('ALTER TABLE tests ADD COLUMN due_at TEXT');
  // A class that has stopped appearing in Canvas — dropped, or a schedule
  // change. It disappears from every page but the rows stay put, so nothing the
  // student wrote is lost and one sync brings it all back if it returns.
  const ccols = db.prepare('PRAGMA table_info(classes)').all().map((r) => r.name);
  if (!ccols.includes('archived')) db.exec('ALTER TABLE classes ADD COLUMN archived INTEGER DEFAULT 0');
  // The grade CANVAS says, straight from the enrollment. This is the number the
  // teacher's own weighting produced (tests 40%, homework 20%, and so on), so
  // it is the real grade — adding up raw points would disagree with it and be
  // wrong. Null until Canvas has something to report.
  if (!ccols.includes('canvas_score')) db.exec('ALTER TABLE classes ADD COLUMN canvas_score REAL');
  if (!ccols.includes('canvas_letter')) db.exec('ALTER TABLE classes ADD COLUMN canvas_letter TEXT');
  // Emails: `body` is the preview Canvas gives in the list. The full text and
  // any attachments are fetched when the message is opened, then kept here.
  const ecols = db.prepare('PRAGMA table_info(emails)').all().map((r) => r.name);
  if (!ecols.includes('body_full')) db.exec('ALTER TABLE emails ADD COLUMN body_full TEXT');
  if (!ecols.includes('attachments')) db.exec('ALTER TABLE emails ADD COLUMN attachments TEXT');

  // There is always exactly one owner account, created on first run.
  const owner = db.prepare('SELECT id FROM users WHERE is_owner = 1').get();
  if (!owner) {
    const named = db.prepare("SELECT value FROM settings WHERE key = 'student_name'").get();
    const name = (named && named.value ? String(named.value).trim().split(/\s+/)[0] : '') || 'Will';
    db.prepare(
      `INSERT INTO users (name, password_hash, is_admin, is_frozen, is_owner, created_at)
       VALUES (?, NULL, 1, 0, 1, ?)`
    ).run(name, new Date().toISOString());
  }
}

function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value == null ? null : String(value));
}

function resetDb() {
  const d = getDb();
  for (const t of ['grades', 'flashcards', 'tests', 'project_chunks', 'assignments', 'emails', 'classes']) {
    d.exec(`DELETE FROM ${t};`);
  }
}

module.exports = { getDb, getSetting, setSetting, resetDb, DB_PATH };
