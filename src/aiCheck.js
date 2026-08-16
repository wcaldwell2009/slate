'use strict';

// Runs a piece of the student's own writing past GPTZero and reports ONE
// number: how likely it says the text is AI-written.
//
// What this deliberately does NOT do: explain what tripped the detector, or
// list what detectors look for. That would be a tuning loop — it works just as
// well on writing somebody didn't do — and Will and I agreed it stays out.
// A score is information about your own work; a list of triggers is a recipe.
//
// It is also never a gate. The number is shown next to the hand-in preview and
// changes nothing about whether the work can be submitted.
//
// Off unless a key is saved on the API page. The key lives in the settings
// table (server side, same as the Canvas token) and is never sent to the page.

const crypto = require('crypto');
const { getDb, getSetting } = require('./db');

const ENDPOINT = 'https://api.gptzero.me/v2/predict/text';
const MIN_WORDS = 50;      // GPTZero is meaningless on a couple of sentences
const MAX_CHARS = 50000;

function hasKey() {
  return !!(getSetting('gptzero_api_key') || process.env.GPTZERO_API_KEY || fakeMode());
}

// Tests and the drive harness must never touch the real service.
function fakeMode() {
  return process.env.SLATE_AI_CHECK_FAKE === '1';
}

function hashOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 32);
}

function wordCount(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// GPTZero has moved its response shape around, so pull the number out of
// whichever field is present rather than trusting one path.
function readScore(data) {
  const doc = data && Array.isArray(data.documents) ? data.documents[0] : null;
  if (!doc) throw new Error('GPTZero sent back something unexpected');
  const probs = doc.class_probabilities || {};
  let ai = null;
  if (typeof probs.ai === 'number') ai = probs.ai;
  else if (typeof doc.completely_generated_prob === 'number') ai = doc.completely_generated_prob;
  if (ai == null) throw new Error('GPTZero sent back no score');

  const mixed = typeof probs.mixed === 'number' ? probs.mixed : null;
  return {
    ai_pct: Math.round(ai * 100),
    mixed_pct: mixed == null ? null : Math.round(mixed * 100),
    verdict: String(doc.predicted_class || data.document_classification || '').toLowerCase() || null,
  };
}

async function callGptZero(text) {
  if (fakeMode()) {
    // Deterministic stand-in so the whole path is testable offline. Text with
    // the marker scores high; everything else scores low.
    const ai = /LOOKS-LIKE-AI/.test(text) ? 0.91 : 0.04;
    return readScore({
      documents: [{ class_probabilities: { ai, human: 1 - ai, mixed: 0 }, predicted_class: ai > 0.5 ? 'ai' : 'human' }],
    });
  }
  const key = getSetting('gptzero_api_key') || process.env.GPTZERO_API_KEY;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ document: String(text).slice(0, MAX_CHARS), multilingual: false }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('GPTZero would not accept that key.');
  if (res.status === 429) throw new Error('GPTZero says you are out of checks for now.');
  if (!res.ok) throw new Error(`GPTZero answered with an error (${res.status}).`);
  return readScore(await res.json());
}

// Cached against a hash of the exact text, so reopening the hand-in screen
// without changing anything doesn't spend another check.
function cachedFor(row, text) {
  try {
    const saved = JSON.parse(row.ai_check || 'null');
    if (saved && saved.hash === hashOf(text)) return { ...saved, cached: true };
  } catch { /* nothing usable saved */ }
  return null;
}

function save(assignmentId, text, result) {
  getDb()
    .prepare('UPDATE assignments SET ai_check=? WHERE id=?')
    .run(JSON.stringify({ ...result, hash: hashOf(text), checked_at: new Date().toISOString() }), assignmentId);
}

// Returns { ok, state, ... }. `state` is what the page keys off:
//   'off'    no key saved — the feature is switched off
//   'short'  too little writing for a score to mean anything
//   'done'   there's a number
//   'error'  the service said no; the message is safe to show
async function checkWriting(assignmentId, text) {
  if (!hasKey()) return { ok: true, state: 'off' };
  const words = wordCount(text);
  if (words < MIN_WORDS) return { ok: true, state: 'short', words, min_words: MIN_WORDS };

  const db = getDb();
  const row = db.prepare('SELECT id, ai_check FROM assignments WHERE id=?').get(Number(assignmentId));
  if (!row) return { ok: false, state: 'error', error: 'not found' };

  const hit = cachedFor(row, text);
  if (hit) return { ok: true, state: 'done', ai_pct: hit.ai_pct, mixed_pct: hit.mixed_pct, verdict: hit.verdict, checked_at: hit.checked_at, cached: true };

  try {
    const result = await callGptZero(text);
    save(row.id, text, result);
    return { ok: true, state: 'done', ...result, checked_at: new Date().toISOString(), cached: false };
  } catch (err) {
    return { ok: true, state: 'error', error: err.message };
  }
}

function saveKey(key) {
  const clean = String(key || '').trim();
  const { setSetting } = require('./db');
  setSetting('gptzero_api_key', clean);
  return { ok: true, enabled: !!clean };
}

function keyStatus() {
  const key = getSetting('gptzero_api_key') || '';
  return {
    enabled: hasKey(),
    hint: key ? '…' + key.slice(-4) : '',
    min_words: MIN_WORDS,
  };
}

module.exports = { checkWriting, hasKey, saveKey, keyStatus, readScore, hashOf, wordCount, MIN_WORDS };
