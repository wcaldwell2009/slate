'use strict';

// "Get Unstuck" — the essay editor's writing coach.
//
// Takes the draft the student has written so far plus a note about where they
// are stuck, and comes back with direction: what the draft is arguing, what the
// stuck section has to DO, the points to hit, and a question that gets them
// moving again.
//
// It does NOT write the essay. Nothing it returns is a sentence that could be
// pasted into the draft — that stays Will's job, always. Same fallback chain as
// the rest of Slate's AI: Claude API (if a key is set) -> hidden `claude -p`
// terminal -> rule-based coaching that always works offline.

const { spawn } = require('child_process');
const { stripHtml } = require('./llm');

const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// Pull a word count / paragraph count target out of assignment instructions.
// Returns { words, paragraphs } with nulls when nothing is stated.
function targetsFromText(text) {
  const t = stripHtml(text || '');
  let words = null;
  let paragraphs = null;

  const wordRange = t.match(/(\d{2,5})\s*(?:-|–|—|to)\s*(\d{2,5})\s*words/i);
  if (wordRange) words = Math.round((+wordRange[1] + +wordRange[2]) / 2);
  if (words == null) {
    const single = t.match(/(\d{2,5})\s*words/i);
    if (single) words = +single[1];
  }

  const digitPara = t.match(/(\d{1,2})\s*[-–—\s]?\s*paragraph/i);
  if (digitPara) paragraphs = +digitPara[1];
  if (paragraphs == null) {
    const wordPara = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*[-–—\s]?\s*paragraph/i);
    if (wordPara) paragraphs = NUM_WORDS[wordPara[1].toLowerCase()] || null;
  }

  return { words, paragraphs, sentences: sentenceTarget(words, paragraphs) };
}

// Roughly how many sentences this essay wants, so the editor can show a live
// "how far along am I" percent. A school-essay sentence runs ~18 words, and a
// solid body paragraph runs ~6 sentences. With nothing stated, assume the
// standard five-paragraph essay.
const WORDS_PER_SENTENCE = 18;
const SENTENCES_PER_PARAGRAPH = 6;
function sentenceTarget(words, paragraphs) {
  if (words) return Math.max(5, Math.round(words / WORDS_PER_SENTENCE));
  if (paragraphs) return Math.max(5, paragraphs * SENTENCES_PER_PARAGRAPH);
  return 5 * SENTENCES_PER_PARAGRAPH;
}

// Sentence count for a draft. Abbreviations ("Dr.", "U.S.", "3.14") each look
// like a sentence ending, so they get masked out before splitting. The list is
// explicit on purpose — matching any short capitalized word swallowed real
// sentence endings like "One." instead.
const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|al|Inc|Ltd|Co|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mon|Tues?|Wed|Thurs?|Fri|Sat|Sun|Vol|pp?|eds?|cf)\./gi;
function countSentences(text) {
  const t = String(text || '')
    .replace(/\b(?:[A-Za-z]\.){2,}/g, 'X')  // U.S.  e.g.  i.e.
    .replace(ABBREVIATIONS, '$1')
    .replace(/\b\d+\.\d+/g, '0');           // 3.14
  return t.split(/[.!?]+(?=\s|$)/).map((s) => s.trim()).filter((s) => /\w/.test(s)).length;
}

function countWords(text) {
  const m = String(text || '').trim().match(/\S+/g);
  return m ? m.length : 0;
}

// Blank-line separated blocks = the paragraphs the writer actually typed.
function paragraphsOf(draft) {
  return String(draft || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
}

function firstWords(text, n) {
  const w = String(text || '').trim().split(/\s+/).filter(Boolean).slice(0, n);
  return w.join(' ') + (w.length >= n ? '…' : '');
}

// ---- the prompt ----------------------------------------------------------
// Written to be a coach, not a ghostwriter. The hard rule is repeated because
// this runs unattended and the output goes straight in front of a student.
function buildPrompt({ title, instructions, draft, stuckNote }) {
  return (
    'You are a writing coach sitting next to a high-school student who is stuck in the ' +
    'middle of an essay they are writing for school.\n\n' +
    'ABSOLUTE RULE: do not write any part of the essay. Never produce a sentence the ' +
    'student could paste into the draft. You point at what the section has to do; they ' +
    'write every word of it. If you catch yourself drafting a sentence for the essay, ' +
    'turn it into a question or a short note instead. This is not negotiable — writing ' +
    'their essay for them would be cheating, and it would take the thinking away from ' +
    'the person who needs to do it.\n\n' +
    'Read the draft and reply with ONLY this JSON, nothing else:\n' +
    '{\n' +
    '  "where_you_are": "one sentence, talking to the student as \\"you\\", naming the ' +
    'argument the draft is ACTUALLY making so far — this is what gets them back into ' +
    'their own train of thought",\n' +
    '  "next": "one sentence: the JOB of the section they are stuck on (what it has to ' +
    'accomplish), never the words for it",\n' +
    '  "points": ["3 to 4 short notes on what belongs in this section — fragments, under ' +
    '12 words each, NOT sentences, NOT essay prose"],\n' +
    '  "question": "one question that unblocks them once they answer it out loud"\n' +
    '}\n\n' +
    `Essay assignment: ${title || 'Essay'}\n` +
    (instructions ? `Assignment instructions:\n${String(instructions).slice(0, 1500)}\n` : '') +
    `\nWhere the student is stuck: ${stuckNote}\n` +
    `\nTheir draft so far:\n"""\n${String(draft).slice(0, 12000)}\n"""`
  );
}

function parseGuidance(text) {
  const start = String(text || '').indexOf('{');
  const end = String(text || '').lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const points = Array.isArray(obj.points)
    ? obj.points.map((p) => String(p).trim()).filter(Boolean).slice(0, 5)
    : [];
  const where = String(obj.where_you_are || '').trim();
  const next = String(obj.next || '').trim();
  if (!where && !next && !points.length) return null;
  return {
    where_you_are: where,
    next,
    points,
    question: String(obj.question || '').trim(),
  };
}

// ---- runners -------------------------------------------------------------
// Hidden terminal: windowsHide keeps the console from flashing on screen.
// An abort signal (the student hit Cancel, or closed the page) kills the child.
function runClaudeCode(prompt, timeoutMs = 90000, signal) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd' : 'claude';
    const args = isWin ? ['/c', 'claude', '-p', '--output-format', 'text'] : ['-p', '--output-format', 'text'];
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '', done = false;

    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(arg);
    };
    const timer = setTimeout(() => { child.kill(); finish(reject, new Error('claude timed out')); }, timeoutMs);
    function onAbort() { child.kill(); finish(reject, new Error('cancelled')); }
    if (signal) {
      if (signal.aborted) { child.kill(); return finish(reject, new Error('cancelled')); }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (code === 0 && out.trim()) finish(resolve, out);
      else finish(reject, new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function withClaudeApi(prompt, signal) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
    signal,
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

// One claude process at a time, same as the other AI features.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---- offline / no-Claude coaching ---------------------------------------
// Structural advice built from the draft itself. Never great, never useless,
// and it still never writes a line of the essay.
function ruleBasedGuidance({ draft, stuckNote, target }) {
  const paras = paragraphsOf(draft);
  const words = countWords(draft);
  const opener = firstWords(paras[0] || draft, 14);

  const where = paras.length
    ? `You have ${paras.length} paragraph${paras.length === 1 ? '' : 's'} and about ${words} words down. The draft opens with: "${opener}"`
    : `You have about ${words} words down so far.`;

  let next;
  if (paras.length <= 1) {
    next = 'This next part has to take the claim you opened with and back it up with one specific piece of evidence.';
  } else if (target && target.paragraphs && paras.length >= target.paragraphs - 1) {
    next = 'This part has to land the argument — pull the reasons together and say what they add up to, without repeating them.';
  } else {
    next = 'This part has to move the argument one step past the paragraph before it: a new reason, not a restatement of the last one.';
  }

  const points = [
    'the one point this section proves',
    'the evidence or example behind it',
    'why that evidence actually backs your claim',
    'the handoff into what comes next',
  ];
  if (target && target.words && words < target.words) {
    points.push(`roughly ${Math.max(0, target.words - words)} words still to go`);
  }

  return {
    where_you_are: where,
    next,
    points,
    question: 'Say it out loud in one sentence: what should the reader believe after this part that they did not believe before it?',
    stuck_on: stuckNote,
    source: 'offline',
  };
}

// Main entry. Always resolves to guidance — never throws at the caller.
async function getGuidance({ title, instructions, draft, stuckNote, target }, opts = {}) {
  const note = (stuckNote && String(stuckNote).trim()) || 'continue from where the draft leaves off';
  const prompt = buildPrompt({ title, instructions, draft, stuckNote: note });
  const signal = opts.signal;

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const g = parseGuidance(await withClaudeApi(prompt, signal));
      if (g) return { ...g, stuck_on: note, source: 'claude' };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn('[unstuck] API failed:', e.message);
    }
  }
  if (process.env.SLATE_NO_AI !== '1') {
    try {
      const g = parseGuidance(await enqueue(() => runClaudeCode(prompt, 90000, signal)));
      if (g) return { ...g, stuck_on: note, source: 'claude' };
    } catch (e) {
      if (e.message === 'cancelled') throw e;
      console.warn('[unstuck] Claude Code failed, using offline coaching:', e.message);
    }
  }
  return ruleBasedGuidance({ draft, stuckNote: note, target });
}

module.exports = {
  getGuidance,
  ruleBasedGuidance,
  targetsFromText,
  sentenceTarget,
  countSentences,
  paragraphsOf,
  countWords,
  parseGuidance,
};
