'use strict';

// Builds a starting slide OUTLINE for a slideshow project:
//   - reads the assignment title + instructions,
//   - if the instructions state a slide count (e.g. "6-8 slides"), makes that
//     many slides,
//   - if the assignment says to CHOOSE a subject (e.g. "pick a founding
//     document"), picks a good specific one,
//   - fills in every slide HEADER (title) to cover what's required.
//
// It only fills in headers/structure (organizing + pacing) — the student still
// writes the actual slide content. Claude API -> hidden Claude Code -> rules.

const { spawn } = require('child_process');
const { stripHtml } = require('./llm');

// Pull a target slide count out of instruction text, if stated.
function slideCountFromText(text) {
  const t = String(text || '');
  const range = t.match(/(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s+slides/i);
  if (range) return Math.round((+range[1] + +range[2]) / 2);
  const single = t.match(/(\d{1,2})\s+slides/i);
  if (single) return +single[1];
  return null;
}

function buildPrompt(title, clean) {
  const stated = slideCountFromText(clean);
  return (
    'You are helping a high-school student START a slideshow for an assignment. ' +
    'Output ONLY a JSON array of short slide TITLES (headers), nothing else.\n' +
    'Rules:\n' +
    '- The first title is the overall presentation title.\n' +
    (stated
      ? `- Make EXACTLY ${stated} titles total (the instructions ask for that many slides).\n`
      : '- Use however many slides fit the assignment (usually 5-7), first is the title slide.\n') +
    '- If the assignment tells the student to CHOOSE a specific subject or example, pick one good, well-known specific choice and build the outline around it.\n' +
    '- Cover every part the instructions require (e.g. summary, background, analysis, impact, conclusion).\n' +
    '- Titles are short headers only. Do NOT write slide contents or bullet points — the student writes those.\n\n' +
    `Assignment: ${title}\nInstructions:\n${clean.slice(0, 5000)}\n\n` +
    'Example output: ["The Declaration of Independence","What the Document Says","Historical Context","Key Ideas and Signers","Its Lasting Impact","Conclusion"]'
  );
}

function parseTitles(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const titles = arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  return titles.length ? titles : null;
}

function runClaudeCode(prompt, timeoutMs = 60000, allowedTools = null) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd' : 'claude';
    const base = ['-p', '--output-format', 'text'];
    if (allowedTools) base.push('--allowedTools', allowedTools);
    const args = isWin ? ['/c', 'claude', ...base] : base;
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out); else reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.write(prompt); child.stdin.end();
  });
}

async function withClaudeApi(prompt) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

// Rule-based outline when Claude isn't available: generic headers, count honored.
function fallbackTitles(title, clean, steps) {
  const n = slideCountFromText(clean) || Math.min(Math.max((steps || []).length + 2, 4), 7);
  const titles = [title];
  const cleanSteps = (steps || []).map((s) => String(s).replace(/^(make|build|create)\s+\d+.*slides?.*/i, '').trim()).filter(Boolean);
  for (const s of cleanSteps) { if (titles.length < n - 1) titles.push(s); }
  while (titles.length < n - 1) titles.push(`Main Point ${titles.length}`);
  if (titles.length < n) titles.push('Conclusion');
  return titles.slice(0, n);
}

// Slide 1 is the title slide (its single "bullet" is the subtitle line); the
// rest are content slides the student fills in.
function titlesToSlides(titles, subtitle) {
  return titles.map((t, i) => ({
    title: t,
    bullets: i === 0 ? [subtitle || ''] : [''],
    photo: false,
  }));
}

// Returns an array of slide objects [{title, bullets[], photo}].
// row.class_name (when present) becomes the title slide's subtitle.
async function generateOutline(row) {
  const subtitle = row.class_name || '';
  const clean = stripHtml(row.raw_description || '');
  let steps = [];
  try { steps = JSON.parse(row.steps || '[]'); } catch { steps = []; }
  const prompt = buildPrompt(row.title || 'Presentation', clean || row.title || '');

  if (process.env.ANTHROPIC_API_KEY) {
    try { const t = parseTitles(await withClaudeApi(prompt)); if (t) return titlesToSlides(t, subtitle); }
    catch (e) { console.warn('[outline] API failed:', e.message); }
  }
  if (process.env.SLATE_NO_AI !== '1') {
    try { const t = parseTitles(await runClaudeCode(prompt)); if (t) return titlesToSlides(t, subtitle); }
    catch (e) { console.warn('[outline] Claude Code failed, using rules:', e.message); }
  }
  return titlesToSlides(fallbackTitles(row.title || 'Presentation', clean, steps), subtitle);
}

// ---- suggested points to work from ---------------------------------------
// Fills each slide with researched talking points so there is something real to
// react to instead of an empty box.
//
// WHAT THIS IS AND IS NOT. These are the POINTS TO COVER and the facts behind
// them — accurate, specific, sourced from a real look at the topic. They are
// not finished presentation copy written in the student's voice, and the prompt
// says so twice. Slate has held that line since round 12 and this stays on the
// same side of it: research to work from, not the work itself. The student
// rewrites or deletes every line.
function buildSuggestionPrompt(title, clean, titles) {
  return (
    'A high-school student is building a slideshow and wants researched notes to work from.\n' +
    'RESEARCH THE TOPIC FIRST using the tools you have, then give the key points for each slide.\n\n' +
    'HARD RULES:\n' +
    '- Give the SUBSTANCE: specific facts, dates, names, numbers, causes and effects. Accuracy matters more than polish.\n' +
    '- These are NOTES the student rewrites in their own words. Do NOT write finished, ready-to-present sentences in a student voice.\n' +
    '- Do NOT invent facts. If you are not sure of something, leave it out.\n' +
    '- 2 to 4 points per slide, one fact or idea each, under about 15 words.\n' +
    '- Nothing for the first slide: it is the title slide.\n\n' +
    `Assignment: ${title}\n` +
    `Instructions:\n${String(clean || '').slice(0, 3000)}\n\n` +
    'The slides are:\n' +
    titles.map((t, i) => `${i + 1}. ${t}`).join('\n') + '\n\n' +
    'Reply with ONLY a JSON array, one array of points per slide, in the same order, ' +
    'with an empty array for slide 1. No commentary, no code fences.\n' +
    'Example: [[],["Signed 4 July 1776 by 56 delegates","Drafted mainly by Jefferson over 17 days"],["..."]]'
  );
}

function parseSuggestions(text, count) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (let i = 0; i < count; i++) {
    const row = Array.isArray(arr[i]) ? arr[i] : [];
    out.push(row.map((s) => String(s).trim()).filter(Boolean).slice(0, 4));
  }
  // Nothing usable came back is a failure, not an answer of empty slides.
  return out.some((r) => r.length) ? out : null;
}

// Research needs the web. The hidden `claude -p` gets WebSearch/WebFetch for
// this one job and nothing else — no Read, no Write, no Bash.
const RESEARCH_TOOLS = 'WebSearch,WebFetch';

async function generateSuggestions(row, slides) {
  const titles = (slides || []).map((s) => s.title || '');
  if (titles.length < 2) return null;
  const clean = stripHtml(row.raw_description || '');
  const prompt = buildSuggestionPrompt(row.title || 'Presentation', clean, titles);

  if (process.env.SLATE_NO_AI === '1') return null;
  // The API has no web access here, so research goes through Claude Code.
  // Longer timeout than the outline: it is actually looking things up.
  try {
    const reply = await runClaudeCode(prompt, 240000, RESEARCH_TOOLS);
    return parseSuggestions(reply, titles.length);
  } catch (e) {
    console.warn('[suggestions] Claude Code failed:', e.message);
    return null;
  }
}

module.exports = { generateOutline, generateSuggestions, slideCountFromText, parseSuggestions };
