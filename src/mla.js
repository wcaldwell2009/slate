'use strict';

// Pulls a finished essay draft together into MLA format.
//
// Slate does not touch a single word of the writing — it only takes the
// paragraphs Will wrote, splits off a Works Cited section if there is one, and
// wraps the whole thing in the MLA furniture: heading block, centered title,
// double spacing, running header, hanging indents.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// MLA dates are "22 July 2026".
function mlaDate(ymdStr) {
  const s = String(ymdStr || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function lastNameOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function blocksOf(text) {
  return String(text || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
}

function countWords(text) {
  const m = String(text || '').trim().match(/\S+/g);
  return m ? m.length : 0;
}

const CITED_RE = /^\s*(works\s+cited|bibliography|references)\s*:?\s*$/i;

// A line the student bulleted or numbered with the editor's toolbar.
const LIST_LINE = /^\s*(?:[•\-*]\s+|\d+[.)]\s+)/;

// Split the draft into body paragraphs and Works Cited entries. A block whose
// first line is "Works Cited" starts the citations; everything after is entries,
// one per line.
function splitDraft(draft) {
  const blocks = blocksOf(draft);
  const body = [];
  const cited = [];
  let inCited = false;
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!inCited && CITED_RE.test(lines[0] || '')) {
      inCited = true;
      lines.slice(1).forEach((l) => cited.push(l));
      continue;
    }
    if (inCited) { lines.forEach((l) => cited.push(l)); continue; }
    // A paragraph's own line breaks are just soft wrapping — join them. A list
    // is the exception: those line breaks are the whole point, so keep them.
    const isList = lines.length > 1 && lines.every((l) => LIST_LINE.test(l));
    body.push(isList ? lines.join('\n') : lines.join(' '));
  }
  return { body, cited };
}

// Build the MLA document object everything else renders from.
function buildEssay({ draft, title, student, teacher, className, date, blocks, font, size }) {
  const { body, cited } = splitDraft(draft);
  return {
    student: String(student || '').trim(),
    teacher: String(teacher || '').trim(),
    className: String(className || '').trim(),
    date: mlaDate(date),
    title: String(title || '').trim(),
    lastName: lastNameOf(student),
    paragraphs: body,
    worksCited: cited,
    words: countWords(body.join(' ')),
    // The formatted version of the same paragraphs, when the draft has one.
    // Renderers use `blocks` if it's there and fall back to `paragraphs`.
    blocks: blocks && blocks.length ? blocks : null,
    // Null means MLA — Times New Roman 12. Set only if the student chose.
    font: font || null,
    size: size || null,
  };
}

function runsToText(runs) {
  return (runs || []).map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
}

// Plain-text rendering — used for the .txt download and the on-screen preview.
function toText(doc) {
  const out = [];
  out.push(doc.student || '[your name]');
  out.push(doc.teacher || '[teacher name]');
  out.push(doc.className || '');
  out.push(doc.date || '');
  out.push('');
  // A missing title is prompted for on the essay checklist. Everywhere else,
  // no title means no title line — "[title]" must never reach a teacher.
  if (doc.title) { out.push(doc.title); out.push(''); }

  // A formatted draft renders from its blocks, the same ones the Word file
  // uses — otherwise the .txt and the .docx disagree about where a heading
  // ends and a paragraph begins.
  if (doc.blocks && doc.blocks.length) {
    for (const b of doc.blocks) {
      if (b.type === 'ul' || b.type === 'ol') {
        b.items.forEach((runs, i) => out.push((b.type === 'ol' ? `${i + 1}. ` : '• ') + runsToText(runs)));
        out.push('');
        continue;
      }
      out.push(runsToText(b.runs));
      out.push('');
    }
  } else {
    doc.paragraphs.forEach((p) => {
      // Nothing is auto-indented — paragraphs start at the margin.
      if (LIST_LINE.test(p)) String(p).split('\n').forEach((l) => out.push(l.trim()));
      else out.push(p);
      out.push('');
    });
  }
  if (doc.worksCited.length) {
    out.push('');
    out.push('Works Cited');
    out.push('');
    doc.worksCited.forEach((c) => out.push(c));
  }
  return out.join('\n');
}

// What still needs doing before this gets handed in. Only checks things Slate
// can actually see — it never judges the writing itself.
function checkEssay(doc, { targetWords, targetParagraphs, needsSources } = {}) {
  const checks = [];
  const add = (ok, label) => checks.push({ ok: !!ok, label });

  add(doc.student, doc.student ? `Your name: ${doc.student}` : 'Add your name for the MLA heading');
  add(doc.teacher, doc.teacher ? `Teacher: ${doc.teacher}` : "Add your teacher's name for the MLA heading");
  add(doc.title, doc.title ? `Title: ${doc.title}` : 'Give it a title');
  add(doc.paragraphs.length > 0, `${doc.paragraphs.length} paragraph${doc.paragraphs.length === 1 ? '' : 's'} written`);

  if (targetParagraphs) {
    add(doc.paragraphs.length >= targetParagraphs,
      `${doc.paragraphs.length} of ${targetParagraphs} paragraphs the assignment asks for`);
  }
  if (targetWords) {
    add(doc.words >= targetWords, `${doc.words} of about ${targetWords} words`);
  } else {
    add(true, `${doc.words} words`);
  }
  if (needsSources) {
    add(doc.worksCited.length > 0,
      doc.worksCited.length
        ? `${doc.worksCited.length} source${doc.worksCited.length === 1 ? '' : 's'} on the Works Cited page`
        : 'Add a "Works Cited" line at the end of your draft, then your sources under it');
  }
  return checks;
}

module.exports = { buildEssay, toText, checkEssay, splitDraft, mlaDate, lastNameOf, countWords };
