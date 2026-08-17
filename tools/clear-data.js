'use strict';

// Empties Slate of everything that came from Canvas — classes, assignments,
// projects, tests, flashcards, grades and emails — plus the class notes and
// study time hanging off them.
//
// Used to get the sample data out. Also the right thing to run if a Canvas sync
// ever brings in the wrong account and needs starting over.
//
//   node tools/clear-data.js            the workshop copy (./data/slate.db)
//   node tools/clear-data.js --installed  the installed app's database
//   node tools/clear-data.js --all        both
//
// Accounts and settings (including the Canvas token) are left alone.

const path = require('path');
const fs = require('fs');

const TABLES = [
  'note_tests', 'class_notes', 'time_log', 'draft_snapshots', 'chat_messages',
  'grades', 'flashcards', 'tests', 'project_chunks', 'assignments', 'emails', 'classes',
];

function clearOne(dbPath, label) {
  if (!fs.existsSync(dbPath)) {
    console.log(`  ${label}: nothing there yet (${dbPath})`);
    return;
  }
  // db.js reads the path once at load, so each database gets its own process-
  // level require cache — simplest to just open it directly.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const before = {};
  const after = {};
  for (const t of TABLES) {
    try {
      before[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
      db.exec(`DELETE FROM ${t}`);
      after[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    } catch {
      // Table doesn't exist in this database yet — nothing to clear.
    }
  }
  try { db.exec("DELETE FROM settings WHERE key='last_sync'"); } catch { /* fine */ }
  db.close();

  const wiped = Object.keys(before).filter((t) => before[t] > 0);
  console.log(`  ${label}: cleared ${wiped.length ? wiped.map((t) => `${before[t]} ${t}`).join(', ') : 'nothing (already empty)'}`);
}

// Saved photos of notes belong to notes that no longer exist.
function clearNoteImages(dataDir, label) {
  const dir = path.join(dataDir, 'notes');
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  ${label}: removed saved note files`);
  } catch (err) {
    console.log(`  ${label}: could not remove note files (${err.message})`);
  }
}

const args = process.argv.slice(2);
const wantInstalled = args.includes('--installed') || args.includes('--all');
const wantWorkshop = args.includes('--all') || !args.includes('--installed');

console.log('\nClearing Slate data\n-------------------');
if (wantWorkshop) {
  const dataDir = path.join(__dirname, '..', 'data');
  clearOne(path.join(dataDir, 'slate.db'), 'workshop');
  clearNoteImages(dataDir, 'workshop');
}
if (wantInstalled) {
  const home = path.join(process.env.LOCALAPPDATA || '', 'Slate');
  clearOne(path.join(home, 'data', 'slate.db'), 'installed app');
  clearNoteImages(path.join(home, 'data'), 'installed app');
}
console.log('\nDone. Accounts and your Canvas settings were left alone.\n');
