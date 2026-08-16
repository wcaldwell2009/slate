'use strict';

// Project pacing engine.
//
// Splits a project into EVEN daily work between today and the day before it's
// due — even in amount of WORK, not in number of steps, because the steps
// aren't the same size. "Three body paragraphs, each with evidence" is a lot
// more work than "Works Cited page", so it gets more of the days.
//
// Every work day gets exactly one piece. Big steps stretch across several days
// ("day 2 of 6"); if there are more steps than days, each day gets an even
// handful of them.
//
// Balancing against the rest of the week is NOT this function's job — the Today
// page does that live, only pulling in project work once the assignments
// actually due that day come to less than the daily target.

const { ymd, addDaysYmd, daysBetweenYmd: daysBetween } = require('./dates');

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNTABLE = 'paragraphs?|slides?|sources?|pages?|sections?|questions?|problems?|examples?|photos?';

// Roughly how much work one step is, relative to the others.
function stepWeight(step) {
  const t = String(step || '').toLowerCase();
  let w = 1;
  // "three body paragraphs", "6-8 slides", "3 sources" state their own size.
  const range = t.match(new RegExp(`\\b(\\d{1,2})\\s*(?:-|–|—|to)\\s*(\\d{1,2})\\s+(?:${COUNTABLE})`));
  const digits = t.match(new RegExp(`\\b(\\d{1,2})\\s+(?:\\w+\\s+){0,2}?(?:${COUNTABLE})`));
  const words = t.match(new RegExp(`\\b(one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:\\w+\\s+){0,2}?(?:${COUNTABLE})`));
  if (range) w = Math.round((+range[1] + +range[2]) / 2);
  else if (digits) w = +digits[1];
  else if (words) w = NUM_WORDS[words[1]] || 1;

  if (/\b(write|writing|draft|research|build|design|create|analyz|explain|develop|construct)/.test(t)) w *= 1.5;
  // Finishing touches are real work, but they're not multi-day work.
  if (/\b(works cited|bibliograph|cite|citation|title page|format|proofread|revise|edit|check|list|label)/.test(t)) w *= 0.6;
  return Math.max(0.4, w);
}

// Give each step a whole number of days, proportional to its weight, with every
// step getting at least one day. Largest remainder handles the leftovers.
function allocateDays(weights, n) {
  const m = weights.length;
  const total = weights.reduce((a, b) => a + b, 0) || m;
  const raw = weights.map((w) => (w / total) * n);
  const days = raw.map((r) => Math.max(1, Math.floor(r)));
  let sum = days.reduce((a, b) => a + b, 0);
  // The min-of-1 floor can push us over; take days back off the biggest holders.
  let guard = n + m;
  while (sum > n && guard-- > 0) {
    let bi = 0;
    for (let i = 1; i < m; i++) if (days[i] > days[bi]) bi = i;
    if (days[bi] <= 1) break;
    days[bi] -= 1; sum -= 1;
  }
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  let k = 0;
  while (sum < n) { days[order[k % m][1]] += 1; sum += 1; k += 1; }
  return days;
}

// A multi-day step reads better as start / keep going / finish than "part 2".
function partLabel(step, k, parts) {
  if (parts <= 1) return step;
  const lead = k === 0 ? 'Start' : (k === parts - 1 ? 'Finish' : 'Keep going');
  return `${lead}: ${step} (day ${k + 1} of ${parts})`;
}

// steps: array of step strings.
// dueDate: ISO date string of the project.
// today: ISO date string.
// Returns [{ day, chunk_description }] — one entry per work day.
function planChunks(steps, dueDate, today = ymd(new Date())) {
  const cleanSteps = (steps || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!cleanSteps.length) return [];

  const due = (dueDate || '').slice(0, 10);
  // Work days: today up to and including the day before it's due (finish early).
  let span = due ? daysBetween(today, due) : cleanSteps.length;
  span = Math.max(1, span);
  const workDays = [];
  for (let i = 0; i < span; i++) workDays.push(addDaysYmd(today, i));

  const n = workDays.length;
  const m = cleanSteps.length;
  const chunks = [];

  if (m >= n) {
    // More steps than days: hand each day an even slice of the list.
    for (let i = 0; i < n; i++) {
      const from = Math.floor((i * m) / n);
      const to = Math.max(Math.floor(((i + 1) * m) / n), from + 1);
      chunks.push({ day: workDays[i], chunk_description: cleanSteps.slice(from, to).join('\n') });
    }
    return chunks;
  }

  // More days than steps: stretch the bigger steps over more of them.
  const days = allocateDays(cleanSteps.map(stepWeight), n);
  let d = 0;
  for (let j = 0; j < m; j++) {
    for (let k = 0; k < days[j]; k++) {
      chunks.push({ day: workDays[d++], chunk_description: partLabel(cleanSteps[j], k, days[j]) });
    }
  }
  return chunks;
}

module.exports = { planChunks, stepWeight, allocateDays, ymd, daysBetween };
