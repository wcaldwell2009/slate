'use strict';

// How long is this actually going to take?
//
// Slate needs a rough time cost for every assignment so the Today page can fill
// the day: unfinished work due today first, and if that comes to less than the
// daily target, parts of upcoming projects get pulled in to fill the rest.
//
// Rule-based on purpose — it runs on every page load and has to be instant.
// Points carry most of the signal (teachers weight by effort), then the kind of
// work, then how many steps there are.

const { stripHtml } = require('./llm');

const DAILY_TARGET_MINUTES = 120; // the 2-hour day Will asked for
const MIN_ASSIGNMENT = 10;
const MAX_ASSIGNMENT = 180;

function clampRound(mins, lo, hi) {
  const m = Math.min(hi, Math.max(lo, mins));
  return Math.max(lo, Math.round(m / 5) * 5); // 5-minute granularity reads better
}

function parseSteps(steps) {
  if (Array.isArray(steps)) return steps;
  try { const p = JSON.parse(steps || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

// Problem sets state their own size: "#1-25 odd", "questions 1-5".
function problemCount(text) {
  const m = String(text || '').match(/(?:#|questions?|problems?|exercises?|nos?\.)\s*(\d{1,3})\s*[-–—]\s*(\d{1,3})/i);
  if (!m) return 0;
  let n = Math.abs(+m[2] - +m[1]) + 1;
  if (/\b(odd|even)\b/i.test(text)) n = Math.ceil(n / 2);
  return n > 0 && n < 200 ? n : 0;
}

// Minutes for one regular assignment row (or a Canvas-shaped object).
function assignmentMinutes(row) {
  const title = row.raw_title || row.title || '';
  const desc = stripHtml(row.raw_description || row.description || '');
  const blob = `${title} ${desc}`;
  const points = Number(row.points || 0);
  const steps = parseSteps(row.steps);

  // Points are the main signal: a 20-point homework is about 40 minutes.
  let mins = Math.max(15, points * 2);

  // ...adjusted for what kind of work it actually is.
  if (/\b(essay|paper|report|write|writing|paragraph|response|reflect)\b/i.test(blob)) mins *= 1.4;
  if (/\b(read|reading|chapter|article|novel)\b/i.test(blob)) mins *= 1.2;
  if (/\b(record|recording|photo|picture|watch|video|listen)\b/i.test(blob)) mins *= 0.7;
  if (/\b(review|study|prep|practice)\b/i.test(blob)) mins *= 0.85;

  // A stated problem count beats guessing from points.
  const n = problemCount(title) || problemCount(desc);
  if (n) mins = Math.max(mins, n * 2.5);

  // Each listed step is more to get through, and long instructions mean more to do.
  mins += steps.length * 4;
  if (desc.length > 400) mins += 10;

  return clampRound(mins, MIN_ASSIGNMENT, MAX_ASSIGNMENT);
}

// Minutes for one day's chunk of a project (its chunk_description is one step
// per line). Kept smaller than a whole assignment — it's a slice of the work.
function chunkMinutes(chunk, project = {}) {
  const lines = String(chunk.chunk_description || '').split('\n').filter((s) => s.trim());
  const points = Number(project.points || 0);
  let mins = Math.max(20, lines.length * 22);
  if (points >= 80) mins *= 1.2; // a 100-point project's steps are bigger steps
  if (/\b(write|draft|essay|research|build|design)\b/i.test(chunk.chunk_description || '')) mins *= 1.1;
  return clampRound(mins, 15, 90);
}

// "1h 15m" / "45 min" — for labels the student reads at a glance.
function formatMinutes(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

module.exports = {
  assignmentMinutes,
  chunkMinutes,
  formatMinutes,
  problemCount,
  DAILY_TARGET_MINUTES,
};
