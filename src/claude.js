'use strict';

// One place to ask Claude something, text or image.
//
// Same order every other AI feature in Slate uses:
//   1. ANTHROPIC_API_KEY if there is one (fast)
//   2. the student's own logged-in Claude Code, run in a HIDDEN terminal
//      (`claude -p`, windowsHide) — no key needed, nothing else leaves the box
//   3. give up and say so
// SLATE_NO_AI=1 skips straight to giving up, which is how the tests run.
//
// simplify.js / outline.js / unstuck.js / notesAI.js each grew their own copy of
// this before it existed. They still work and are left alone; anything NEW
// should use this module.
//
// HARD RULE, learned the painful way (round 18): never trust raw stdout. The
// hidden `claude -p` runs in the project folder and therefore reads CLAUDE.md,
// so it will happily open with "hey will" and that text ends up rendered to the
// student. Always ask for JSON and pull the JSON back out with parseJson().

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function aiDisabled() {
  return process.env.SLATE_NO_AI === '1';
}

// ---- transport: the API ---------------------------------------------------
async function viaApi(content, { maxTokens = 4000, signal } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
    signal,
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const parts = Array.isArray(data.content) ? data.content : [];
  return parts.map((p) => p.text || '').join('').trim();
}

// ---- transport: the hidden CLI --------------------------------------------
// windowsHide means no console window ever appears — the installed Slate runs
// with no terminal of its own, so a visible one would be a bug.
function viaCli(prompt, { cwd, timeoutMs = 120000, allowedTools, signal } = {}) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const base = ['-p', '--output-format', 'text'];
    if (allowedTools) base.push('--allowedTools', allowedTools);
    const cmd = isWin ? 'cmd' : 'claude';
    const args = isWin ? ['/c', 'claude', ...base] : base;

    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '', err = '';
    const stop = (why) => { try { child.kill(); } catch { /* already gone */ } reject(new Error(why)); };
    const timer = setTimeout(() => stop('claude timed out'), timeoutMs);
    const onAbort = () => { clearTimeout(timer); stop('cancelled'); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---- asking ---------------------------------------------------------------
// Returns the raw reply text. Throws if no path worked.
async function ask(prompt, opts = {}) {
  if (aiDisabled()) throw new Error('AI is switched off (SLATE_NO_AI=1)');
  const problems = [];
  if (process.env.ANTHROPIC_API_KEY) {
    try { return await viaApi(prompt, opts); }
    catch (e) { problems.push('api: ' + e.message); }
  }
  try { return await viaCli(prompt, opts); }
  catch (e) { problems.push('cli: ' + e.message); }
  throw new Error(problems.join(' | ') || 'no way to reach Claude');
}

const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

function imageMediaType(filePath) {
  return IMAGE_TYPES[path.extname(filePath).toLowerCase()] || null;
}

// Ask about a picture. Over the API the image goes as a base64 block; over the
// CLI we point Claude Code at the file and let its Read tool open it, which is
// why the prompt has to name the file and the cwd has to contain it.
async function askAboutImage(imagePath, prompt, opts = {}) {
  if (aiDisabled()) throw new Error('AI is switched off (SLATE_NO_AI=1)');
  const mediaType = imageMediaType(imagePath);
  if (!mediaType) throw new Error('that is not an image Slate can read (png, jpg, gif or webp)');

  const problems = [];
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const data = fs.readFileSync(imagePath).toString('base64');
      return await viaApi([
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: prompt },
      ], opts);
    } catch (e) { problems.push('api: ' + e.message); }
  }
  try {
    const name = path.basename(imagePath);
    return await viaCli(
      `Read the image file "${name}" in the current directory, then do this:\n\n${prompt}`,
      { ...opts, cwd: path.dirname(imagePath), allowedTools: 'Read' }
    );
  } catch (e) { problems.push('cli: ' + e.message); }
  throw new Error(problems.join(' | ') || 'no way to reach Claude');
}

// Ask about a document — a PDF, or a photo of a worksheet. Claude Code's Read
// tool opens PDFs, which is the whole reason this goes through the CLI: there
// is no way to pull the text out of a PDF by hand without a library, and this
// app has no libraries. Over the API a PDF goes as a document block instead.
async function askAboutFile(filePath, prompt, opts = {}) {
  if (aiDisabled()) throw new Error('AI is switched off (SLATE_NO_AI=1)');
  const ext = path.extname(filePath).toLowerCase();
  if (imageMediaType(filePath)) return askAboutImage(filePath, prompt, opts);

  const problems = [];
  if (process.env.ANTHROPIC_API_KEY && ext === '.pdf') {
    try {
      const data = fs.readFileSync(filePath).toString('base64');
      return await viaApi([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
        { type: 'text', text: prompt },
      ], opts);
    } catch (e) { problems.push('api: ' + e.message); }
  }
  try {
    const name = path.basename(filePath);
    return await viaCli(
      `Read the file "${name}" in the current directory, then do this:\n\n${prompt}`,
      { ...opts, cwd: path.dirname(filePath), allowedTools: 'Read' }
    );
  } catch (e) { problems.push('cli: ' + e.message); }
  throw new Error(problems.join(' | ') || 'no way to reach Claude');
}

// ---- reading the answer ---------------------------------------------------
// A model asked for multi-line text inside JSON will sometimes put a real
// newline in the string rather than \n, which is invalid JSON. Typed-up notes
// are multi-line by nature, so that would break the common case. Escape the raw
// control characters that fall inside string literals and try again.
function escapeRawControlChars(json) {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '\\' && inString) { out += ch + (json[i + 1] || ''); i++; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && ch === '\n') { out += '\\n'; continue; }
    if (inString && ch === '\r') { out += '\\r'; continue; }
    if (inString && ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

// Pulls the first JSON object or array out of a reply and throws away whatever
// Claude wrapped around it.
function parseJson(text) {
  const s = String(text == null ? '' : text);
  const candidates = [
    [s.indexOf('{'), s.lastIndexOf('}')],
    [s.indexOf('['), s.lastIndexOf(']')],
  ].filter(([a, b]) => a !== -1 && b > a).sort((a, b) => a[0] - b[0]);

  for (const [start, end] of candidates) {
    const slice = s.slice(start, end + 1);
    try { return JSON.parse(slice); } catch { /* try repairing it */ }
    try { return JSON.parse(escapeRawControlChars(slice)); } catch { /* try the other shape */ }
  }
  throw new Error('Claude did not answer with JSON');
}

// Run one job at a time. Claude Code is a single CLI on one machine; firing
// several at once makes them all slow and can wedge the login.
let queue = Promise.resolve();
function queued(job) {
  const run = queue.then(job, job);
  // Keep the chain alive even when a job throws, or every later job is skipped.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

module.exports = { ask, askAboutImage, askAboutFile, parseJson, queued, imageMediaType, aiDisabled };
