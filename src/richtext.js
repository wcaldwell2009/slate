'use strict';

// The editor is a contenteditable box, so a draft can now carry real
// formatting. This turns its HTML into a small block model that the Word
// builder, the PDF builder and the on-screen page preview all render from —
// one shared understanding of the document instead of three.
//
// Blocks:  { type: 'p' | 'ul' | 'ol', align, runs[] }        for paragraphs
//          { type: 'ul' | 'ol', align, items: [runs[], ...] } for lists
// Run:     { text, b, i, u, font, size }   font/size null = follow the document
//
// Deliberately small: the editor only ever produces b/i/u, lists, alignment and
// font/size spans, so that is all this understands. Anything else is flattened
// to its text rather than guessed at.

const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link']);
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre']);

function decode(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, '&');
}

// ---- a very small, tolerant HTML tokenizer --------------------------------
function tokenize(html) {
  const out = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?)\/?>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > last) out.push({ t: 'text', text: html.slice(last, m.index) });
    const name = m[1].toLowerCase();
    out.push({
      t: m[0].startsWith('</') ? 'close' : 'open',
      name,
      attrs: m[2] || '',
      self: VOID_TAGS.has(name) || /\/\s*>$/.test(m[0]),
    });
    last = re.lastIndex;
  }
  if (last < html.length) out.push({ t: 'text', text: html.slice(last) });
  return out;
}

function attr(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs || '');
  return m ? (m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]) : '';
}

function styleOf(attrs) {
  const style = attr(attrs, 'style');
  const out = {};
  for (const part of String(style).split(';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

// "14pt" / "14px" / "14" -> 14 (points). Browsers hand back px; a point is
// 4/3 of a px at the default zoom, which is close enough for a font menu.
function pointsFrom(value) {
  const m = /(-?[\d.]+)\s*(pt|px|em|rem)?/i.exec(String(value || ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'pt').toLowerCase();
  if (unit === 'px') return Math.round(n * 0.75 * 2) / 2;
  if (unit === 'em' || unit === 'rem') return Math.round(n * 12 * 2) / 2;
  return Math.round(n * 2) / 2;
}

function cleanFont(value) {
  const first = String(value || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  return first || null;
}

// ---- parse ---------------------------------------------------------------
function parseHtml(html) {
  const blocks = [];
  let block = null;      // current paragraph-ish block
  let list = null;       // current ul/ol
  const marks = [];      // stack of { b, i, u, font, size }

  const active = () => marks.reduce((acc, m) => ({
    b: acc.b || !!m.b, i: acc.i || !!m.i, u: acc.u || !!m.u,
    font: m.font || acc.font, size: m.size || acc.size,
  }), { b: false, i: false, u: false, font: null, size: null });

  const startBlock = (type, align) => { block = { type: type || 'p', align: align || null, runs: [] }; };
  const endBlock = () => {
    if (!block) return;
    trimRuns(block.runs);
    if (list) {
      if (block.runs.length) list.items.push(block.runs);
    } else if (block.runs.length) {
      blocks.push(block);
    }
    block = null;
  };

  const push = (text) => {
    if (!text) return;
    if (!block) startBlock('p', null);
    const a = active();
    const prev = block.runs[block.runs.length - 1];
    if (prev && prev.b === a.b && prev.i === a.i && prev.u === a.u && prev.font === a.font && prev.size === a.size) {
      prev.text += text;
    } else {
      block.runs.push({ text, b: a.b, i: a.i, u: a.u, font: a.font, size: a.size });
    }
  };

  for (const tok of tokenize(String(html || ''))) {
    if (tok.t === 'text') { push(decode(tok.text)); continue; }

    const { name, attrs } = tok;
    if (tok.t === 'open') {
      if (name === 'br') { endBlock(); startBlock('p', null); continue; }
      if (name === 'ul' || name === 'ol') { endBlock(); list = { type: name, align: null, items: [] }; continue; }
      if (BLOCK_TAGS.has(name)) {
        endBlock();
        const st = styleOf(attrs);
        const align = (st['text-align'] || attr(attrs, 'align') || '').toLowerCase() || null;
        startBlock('p', align === 'left' ? null : align);
        continue;
      }
      if (name === 'b' || name === 'strong') { marks.push({ b: true }); continue; }
      if (name === 'i' || name === 'em') { marks.push({ i: true }); continue; }
      if (name === 'u') { marks.push({ u: true }); continue; }
      if (name === 'span' || name === 'font') {
        const st = styleOf(attrs);
        marks.push({
          b: /bold|[6-9]00/.test(st['font-weight'] || ''),
          i: /italic/.test(st['font-style'] || ''),
          u: /underline/.test(st['text-decoration'] || st['text-decoration-line'] || ''),
          font: cleanFont(st['font-family'] || attr(attrs, 'face')),
          size: pointsFrom(st['font-size'] || attr(attrs, 'size')),
        });
        continue;
      }
      continue; // anything else contributes nothing but its text
    }

    // close
    if (name === 'ul' || name === 'ol') {
      endBlock();
      if (list && list.items.length) blocks.push(list);
      list = null;
      continue;
    }
    if (BLOCK_TAGS.has(name)) { endBlock(); continue; }
    if (['b', 'strong', 'i', 'em', 'u', 'span', 'font'].includes(name)) { marks.pop(); continue; }
  }
  endBlock();
  if (list && list.items.length) blocks.push(list);
  return blocks;
}

function trimRuns(runs) {
  if (!runs.length) return;
  runs[0].text = runs[0].text.replace(/^[ \t]+/, '');
  runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/[ \t]+$/, '');
  for (let i = runs.length - 1; i >= 0; i--) if (!runs[i].text) runs.splice(i, 1);
}

// ---- plain text ----------------------------------------------------------
// What the rest of Slate keeps working on: word counts, the essay outline, the
// AI checker, the MLA splitter. Blank lines between blocks, list markers in.
function toPlainText(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'ul' || b.type === 'ol') {
      b.items.forEach((runs, i) => out.push((b.type === 'ol' ? `${i + 1}. ` : '• ') + runsText(runs)));
      out.push('');
      continue;
    }
    out.push(runsText(b.runs));
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function runsText(runs) {
  return (runs || []).map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
}

const htmlEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Plain text back into editor HTML, for drafts written before the editor could
// do formatting. List markers become real lists.
function textToHtml(text) {
  const parts = [];   // { kind: 'p'|'ul'|'ol', text? , items? }

  for (const b of String(text || '').split(/\n\s*\n/)) {
    let lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // A short line ending in a colon, with more under it, is a heading the
    // student typed on its own line — "Big Idea:", "Discussion Questions:".
    // Joining it onto the paragraph below (the usual soft-wrap rule) reads as
    // a mistake, so it keeps its own line.
    while (lines.length > 1 && /:$/.test(lines[0]) && lines[0].length <= 60) {
      parts.push({ kind: 'p', text: lines[0] });
      lines = lines.slice(1);
    }
    if (!lines.length) continue;

    const bullets = lines.every((l) => /^[•\-*]\s+/.test(l));
    const numbers = lines.every((l) => /^\d+[.)]\s+/.test(l));
    if (bullets || numbers) {
      parts.push({
        kind: numbers ? 'ol' : 'ul',
        items: lines.map((l) => l.replace(/^(?:[•\-*]|\d+[.)])\s+/, '')),
      });
    } else {
      parts.push({ kind: 'p', text: lines.join(' ') });
    }
  }

  // Numbered points written with a blank line between them are ONE list, not
  // five lists of one — otherwise every item restarts at 1.
  const merged = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    if (prev && (part.kind === 'ul' || part.kind === 'ol') && prev.kind === part.kind) {
      prev.items = prev.items.concat(part.items);
      continue;
    }
    merged.push(part);
  }

  const out = merged.map((part) => (part.kind === 'p'
    ? `<p>${htmlEsc(part.text)}</p>`
    : `<${part.kind}>${part.items.map((t) => `<li>${htmlEsc(t)}</li>`).join('')}</${part.kind}>`));
  return out.join('') || '<p></p>';
}

function isEmpty(blocks) {
  return !blocks.some((b) => (b.type === 'ul' || b.type === 'ol')
    ? b.items.some((it) => runsText(it))
    : runsText(b.runs));
}

module.exports = { parseHtml, toPlainText, textToHtml, runsText, isEmpty, pointsFrom, cleanFont };
