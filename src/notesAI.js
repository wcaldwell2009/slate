'use strict';

// Turns a dropped notes file into flashcards + a study-notes summary.
//
// Preferred path: quietly run Claude Code in a hidden terminal (`claude -p`,
// windowsHide) — it reads the notes, extracts every testable fact as
// front/back flashcards, and writes up the info that doesn't fit flashcards
// as study notes. Uses the student's own logged-in Claude Code; nothing else
// leaves the machine.
//
// Fallback path: if Claude Code is missing, times out, errors, or
// SLATE_NO_AI=1 is set, the built-in rule-based card generator runs instead,
// so dropping a file always produces something.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { generateCards } = require('./flashcards');

// Same as the DB: the installed copy keeps notes outside the app folder so an
// update can't delete them.
const DATA_DIR = process.env.SLATE_DATA_DIR || path.join(__dirname, '..', 'data');
const NOTES_DIR = path.join(DATA_DIR, 'notes');

// Process one file at a time so parallel drops don't fight over the CLI.
let queue = Promise.resolve();

function looksLikeText(buf) {
  const n = Math.min(buf.length, 1000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function runClaude(prompt, cwd, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd' : 'claude';
    const args = isWin
      ? ['/c', 'claude', '-p', '--output-format', 'text', '--allowedTools', 'Read']
      : ['-p', '--output-format', 'text', '--allowedTools', 'Read'];
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildPrompt(testName, fileBaseName, text) {
  const head =
    `You are helping a high-school student study for "${testName}". ` +
    `From their notes, extract:\n` +
    `1. "flashcards": question/answer pairs covering every fact that could be tested. Short fronts, short backs.\n` +
    `2. "notes": the useful info that does NOT work as flashcards — big-picture summaries, how ideas connect, formulas, essay themes. Plain text, short paragraphs and simple lists.\n` +
    `Do not invent facts that are not in the notes. Reply with ONLY valid JSON (no code fences, no commentary):\n` +
    `{"flashcards":[{"front":"...","back":"..."}],"notes":"..."}\n\n`;
  if (text != null) return head + `THE STUDENT'S NOTES:\n${text.slice(0, 30000)}`;
  return head + `The notes are in the file "${fileBaseName}" in the current directory. Read that file first.`;
}

function parseClaudeJson(out) {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON in claude output');
  const obj = JSON.parse(out.slice(start, end + 1));
  const cards = Array.isArray(obj.flashcards)
    ? obj.flashcards.filter((c) => c && c.front && c.back).map((c) => ({ front: String(c.front), back: String(c.back) }))
    : [];
  return { cards, notes: typeof obj.notes === 'string' ? obj.notes : '' };
}

function fallbackExtract(text) {
  if (!text) throw new Error('file is not readable text, and Claude Code was not available to read it');
  const cards = generateCards(text);
  return { cards, notes: text.trim().slice(0, 6000) };
}

function storeResults(testId, filename, cards, notes, source) {
  const db = getDb();
  // Append cards, skipping fronts we already have.
  const have = new Set(
    db.prepare('SELECT front FROM flashcards WHERE test_id=?').all(testId).map((r) => (r.front || '').toLowerCase().trim())
  );
  const insert = db.prepare('INSERT INTO flashcards (test_id, front, back, confidence_level) VALUES (?,?,?,0)');
  let added = 0;
  for (const c of cards) {
    const key = c.front.toLowerCase().trim();
    if (have.has(key)) continue;
    insert.run(testId, c.front, c.back);
    have.add(key);
    added += 1;
  }
  // Append notes under a per-file heading.
  const row = db.prepare('SELECT notes, notes_file FROM tests WHERE id=?').get(testId);
  const header = `── From ${filename}${source === 'fallback' ? ' (basic reader)' : ''} ──`;
  const merged = ((row && row.notes ? row.notes + '\n\n' : '') + header + '\n' + (notes || '(no extra notes)')).trim();
  const files = row && row.notes_file ? `${row.notes_file}, ${filename}` : filename;
  db.prepare("UPDATE tests SET notes=?, notes_status='done', notes_file=? WHERE id=?").run(merged, files, testId);
  return added;
}

// Kick off background processing for an uploaded notes file. Returns at once.
function processNotesFile(testId, filename, buffer) {
  const db = getDb();
  const test = db.prepare('SELECT id, name FROM tests WHERE id=?').get(testId);
  if (!test) return { ok: false, error: 'test not found' };

  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const safeName = `test-${testId}-${filename.replace(/[<>:"/\\|?*]/g, '_')}`;
  const savedPath = path.join(NOTES_DIR, safeName);
  fs.writeFileSync(savedPath, buffer);
  db.prepare("UPDATE tests SET notes_status='processing' WHERE id=?").run(testId);

  const text = looksLikeText(buffer) ? buffer.toString('utf8') : null;

  queue = queue.then(async () => {
    try {
      let result;
      let source = 'claude';
      if (process.env.SLATE_NO_AI === '1') {
        result = fallbackExtract(text);
        source = 'fallback';
      } else {
        try {
          const out = await runClaude(buildPrompt(test.name, safeName, text), NOTES_DIR);
          result = parseClaudeJson(out);
          if (!result.cards.length && !result.notes) throw new Error('claude returned nothing useful');
        } catch (err) {
          console.warn('[notes] Claude Code path failed, using built-in reader:', err.message);
          result = fallbackExtract(text);
          source = 'fallback';
        }
      }
      const added = storeResults(testId, filename, result.cards, result.notes, source);
      console.log(`[notes] "${filename}" -> ${added} new cards for test ${testId} (${source})`);
    } catch (err) {
      console.error('[notes] failed:', err.message);
      getDb().prepare("UPDATE tests SET notes_status='error' WHERE id=?").run(testId);
    }
  });

  return { ok: true, status: 'processing' };
}

module.exports = { processNotesFile };
