'use strict';

// Canvas class names are built for a course catalogue, not for the top of a
// paper: "AP United States Government and Politics- Nunes". This pulls the
// teacher's surname off the end and shortens what's left to something you'd
// actually write in a heading.
//
// Everything here is a GUESS. Whatever it produces is shown on the hand-in
// screen where it can be corrected, and the correction is remembered per class —
// nothing goes onto a document on the strength of these rules alone.

// Trailing "- Nunes", "– Nunes", "(Nunes)", ", Nunes", "/ Nunes".
const TRAILING_TEACHER = /\s*[-–—/(,]\s*([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,2})\)?\s*$/;

// Words that show up in a course name and are never a surname.
const NOT_A_NAME = new Set([
  'honors', 'honours', 'ap', 'ib', 'advanced', 'placement', 'academy', 'general',
  'period', 'semester', 'section', 'block', 'grade', 'level', 'college', 'prep',
  'lab', 'seminar', 'studies', 'literature', 'composition', 'language', 'page',
  'class', 'training', 'science', 'history', 'math', 'mathematics', 'english',
  'spanish', 'french', 'biology', 'chemistry', 'physics', 'algebra', 'geometry',
  'calculus', 'statistics', 'government', 'politics', 'economics', 'bible',
  'health', 'art', 'music', 'band', 'choir', 'theatre', 'theater', 'cybersecurity',
]);

function looksLikeSurname(candidate) {
  const words = String(candidate || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  return words.every((w) => !NOT_A_NAME.has(w.toLowerCase().replace(/[^a-z]/g, '')));
}

// { subject, teacher } — teacher is '' when the name doesn't carry one.
function splitClassName(raw) {
  const name = String(raw || '').trim();
  const m = name.match(TRAILING_TEACHER);
  if (m && looksLikeSurname(m[1])) {
    const subject = name.slice(0, m.index).trim().replace(/[-–—/,]\s*$/, '').trim();
    if (subject) return { subject, teacher: m[1].trim() };
  }
  return { subject: name, teacher: '' };
}

// Longhand a school writes out but nobody puts in a heading.
const SHORTEN = [
  [/\bUnited States of America\b/gi, 'U.S.'],
  [/\bUnited States\b/gi, 'U.S.'],
  [/\bAdvanced Placement\b/gi, 'AP'],
  [/\bIntroduction to\b/gi, 'Intro to'],
  [/\bPrinciples of\b/gi, ''],
  [/\bFundamentals of\b/gi, ''],
  [/\band Politics\b/gi, ''],
  [/\band Composition\b/gi, ''],
  [/\bLanguage and Composition\b/gi, 'Language'],
  [/\bLiterature and Composition\b/gi, 'Literature'],
  [/\bHonou?rs\b/gi, 'Honors'],
  [/\b(\d{1,2})(st|nd|rd|th) Grade\b/gi, ''],
  [/\bMathematics\b/gi, 'Math'],
  [/\bPhysical Education\b/gi, 'PE'],
];

const MAX_LEN = 30;

// A heading-sized version of a class name. Conservative: it trims longhand and
// filler, and only ever drops whole words — it will not invent an abbreviation
// or cut a word in half.
function shortenSubject(subject) {
  let s = String(subject || '').trim();
  if (!s) return '';
  for (const [re, to] of SHORTEN) s = s.replace(re, to);
  s = s.replace(/\s{2,}/g, ' ').replace(/^[\s,\-–—]+|[\s,\-–—]+$/g, '').trim();
  if (s.length <= MAX_LEN) return s;

  // Still long: a colon or dash usually separates the course from its subtitle,
  // and the course alone is the better heading — "English 11: American
  // Literature" wants to become "English 11", not "English 11: American".
  const head = s.split(/\s*[:–—]\s*/)[0].trim();
  if (head && head.length >= 4 && head.length <= MAX_LEN) return head;

  // Still long: drop the little joining words.
  const dropped = s.split(/\s+/).filter((w, i) => i === 0 || !/^(and|of|the|for|in|to|with)$/i.test(w));
  s = dropped.join(' ');
  if (s.length <= MAX_LEN) return s;

  // Still long: keep whole words up to the limit rather than chopping one.
  const kept = [];
  for (const w of s.split(/\s+/)) {
    if (kept.length && (kept.join(' ') + ' ' + w).length > MAX_LEN) break;
    kept.push(w);
  }
  return kept.join(' ') || s.slice(0, MAX_LEN).trim();
}

// The whole job: raw Canvas name in, heading-ready pieces out.
function readClassName(raw) {
  const { subject, teacher } = splitClassName(raw);
  return { subject, teacher, short: shortenSubject(subject) };
}

// A teacher field may already carry an honorific — either because it was saved
// that way before titles were their own field, or because someone typed
// "Mr. Ortiz" into the box. Pull it apart so the title never gets doubled up.
const HONORIFIC = /^\s*(mr|mrs|ms|miss|dr|prof|professor|coach|pastor|sr|sra|srta|mme|mlle)\.?\s+/i;
const CANON = { mr: 'Mr.', mrs: 'Mrs.', ms: 'Ms.', miss: 'Miss', dr: 'Dr.', prof: 'Prof.', professor: 'Prof.', coach: 'Coach', pastor: 'Pastor', sr: 'Sr.', sra: 'Sra.', srta: 'Srta.', mme: 'Mme.', mlle: 'Mlle.' };

function splitTeacher(raw) {
  const s = String(raw || '').trim();
  const m = s.match(HONORIFIC);
  if (!m) return { title: '', name: s };
  const key = m[1].toLowerCase().replace('.', '');
  return { title: CANON[key] || m[1], name: s.slice(m[0].length).trim() };
}

// "Mr." + "Nunes". Blank title is fine — some teachers go by one name.
function teacherLabel(title, name) {
  const t = String(title || '').trim();
  const n = String(name || '').trim();
  if (!n) return '';
  return t ? `${t} ${n}` : n;
}

module.exports = { splitClassName, shortenSubject, readClassName, teacherLabel, splitTeacher, MAX_LEN };
