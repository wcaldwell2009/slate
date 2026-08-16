'use strict';

// Turns study-guide text into flashcards, and runs simple spaced repetition.
// Cards you know move to longer intervals; cards you miss come back sooner.

const { ymd, todayYmd, addDaysYmd } = require('./dates');
function addDays(days, from = new Date()) {
  return addDaysYmd(ymd(from), days);
}

// Build front/back pairs from raw study-guide text (one fact per line).
function generateCards(text) {
  if (!text) return [];
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 3);

  const cards = [];
  for (const line of lines) {
    // "term - definition" style, but ONLY for real vocab (short left side,
    // no math symbols) so we don't chop formulas at a stray dash/colon.
    const dash = line.match(/^([A-Za-z][A-Za-z '/]{1,38})\s+[-–—]\s+(.+)$/);
    if (dash && !/[=+*/^(){}\d]/.test(dash[1])) {
      cards.push({ front: dash[1].trim(), back: dash[2].trim() });
    } else {
      // Turn a fact into a fill-in prompt by hiding a key word.
      cards.push(makeClozeCard(line));
    }
  }
  return cards;
}

function makeClozeCard(fact) {
  // Hide the last meaningful word (crude but works for study facts).
  const words = fact.split(/\s+/);
  if (words.length < 4) {
    return { front: `Finish: ${fact.split(' ').slice(0, 3).join(' ')} ...`, back: fact };
  }
  const idx = words.length - 1;
  const hidden = words[idx].replace(/[.,;]$/, '');
  const prompt = words.map((w, i) => (i === idx ? '_____' : w)).join(' ');
  return { front: prompt, back: hidden };
}

// Spaced-repetition interval (in days) by confidence level.
const INTERVALS = [0, 1, 2, 4, 8, 16, 30];

// Update a card after a review. remembered=true bumps confidence up.
function review(card, remembered) {
  let level = card.confidence_level || 0;
  level = remembered ? Math.min(level + 1, INTERVALS.length - 1) : Math.max(level - 1, 0);
  const interval = INTERVALS[level];
  return {
    confidence_level: level,
    next_review_date: addDays(Math.max(interval, remembered ? 1 : 0)),
  };
}

// Which cards are due for review today (or never reviewed).
function isDue(card, today = ymd(new Date())) {
  if (!card.next_review_date) return true;
  return card.next_review_date <= today;
}

module.exports = { generateCards, makeClozeCard, review, isDue, INTERVALS, addDays, ymd };
