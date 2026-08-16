'use strict';

// Turns a Canvas assignment's raw instructions into a short, plain-language
// "here's exactly what to do" summary.
//
// Best path: Claude — via ANTHROPIC_API_KEY if set (fast), otherwise a hidden
// Claude Code terminal (`claude -p`, windowsHide). Fallback: a rule-based
// trim so there's always something. Never invents requirements.

const { spawn } = require('child_process');
const { stripHtml } = require('./llm');

const EMPTY = 'No written instructions were posted for this one — check the assignment on Canvas.';

// Rule-based fallback: strip formatting, keep a few short action lines.
function ruleBased(raw) {
  const clean = stripHtml(raw);
  if (!clean.trim()) return EMPTY;
  const sentences = clean.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/^[•\-\d.)\s]+/, '').trim()).filter((s) => s.length > 3);
  const lines = sentences.slice(0, 4).map((s) => (s.length > 110 ? s.slice(0, 107).trimEnd() + '…' : s));
  return lines.join('\n') || clean.slice(0, 300);
}

// Ask for JSON, not loose text. The hidden `claude -p` runs inside the project
// folder, so it picks up CLAUDE.md and will happily open with a greeting — that
// used to land in the student's Instructions box as a bullet reading "hey will".
// Wrapping the answer in JSON means any chatter around it gets thrown away.
function buildPrompt(title, cleanText) {
  return (
    'Rewrite these assignment instructions as a short, dead-simple checklist for a ' +
    'busy high-school student. Rules: ONE thing to do per item; use the fewest, ' +
    'simplest words possible; cut anything that is not a direct action (no grading ' +
    'policies, no restating the title, no fluff); 2 to 5 items; do NOT add ' +
    'requirements that are not stated; no bullet symbols, no numbering.\n' +
    'Reply with ONLY this JSON and nothing else — no greeting, no commentary, no ' +
    'code fences:\n{"steps":["first thing to do","second thing to do"]}\n\n' +
    `Assignment: ${title}\nInstructions:\n${cleanText.slice(0, 6000)}`
  );
}

// Pull the checklist out of a reply that may have chatter wrapped around it.
function parseSteps(out) {
  const text = String(out || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(obj.steps)) {
        const steps = obj.steps
          .map((s) => String(s).replace(/^[•\-\d.)\s]+/, '').trim())
          .filter(Boolean)
          .slice(0, 6);
        if (steps.length) return steps.join('\n');
      }
    } catch { /* fall through to the line-based rescue below */ }
  }
  // No usable JSON: keep the lines that look like instructions, drop chatter.
  const lines = text.split('\n')
    .map((l) => l.replace(/^[•\-\d.)\s]+/, '').trim())
    .filter(Boolean)
    .filter((l) => !/^(hey|hi|hello|sure|okay|ok|here|here's|here is)\b/i.test(l))
    .filter((l) => !/^```/.test(l));
  return lines.slice(0, 6).join('\n');
}

function runClaudeCode(prompt, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd' : 'claude';
    const args = isWin ? ['/c', 'claude', '-p', '--output-format', 'text'] : ['-p', '--output-format', 'text'];
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function withClaudeApi(prompt) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  return ((data.content && data.content[0] && data.content[0].text) || '').trim();
}

// Process one at a time so we never spawn a pile of claude processes at once.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Returns the simplified instructions string (always resolves to something).
// `raw` is everything worth reasoning about — the description AND the text of
// any attached file. `fallbackRaw` is what the rule-based path may use when
// there is no AI: it can only slice the first few sentences off the top, so
// feeding it the attachment dump produces nonsense bullets like the filename
// and Slate's own "From the attached file …" header. Reasoning gets everything;
// sentence-slicing gets the description only.
async function simplify(raw, title, fallbackRaw) {
  const clean = stripHtml(raw);
  if (!clean.trim()) return EMPTY;
  const prompt = buildPrompt(title || 'Assignment', clean);

  if (process.env.ANTHROPIC_API_KEY) {
    try { const t = parseSteps(await withClaudeApi(prompt)); if (t) return t; } catch (e) { console.warn('[simplify] API failed:', e.message); }
  }
  if (process.env.SLATE_NO_AI !== '1') {
    try { const t = parseSteps(await enqueue(() => runClaudeCode(prompt))); if (t) return t; }
    catch (e) { console.warn('[simplify] Claude Code failed, using rule-based:', e.message); }
  }
  return ruleBased(fallbackRaw != null ? fallbackRaw : raw);
}

module.exports = { simplify, ruleBased, parseSteps, EMPTY };
