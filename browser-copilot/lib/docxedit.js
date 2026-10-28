// Edit a Word file IN PLACE: change the text of word/document.xml and add
// pictures, leaving every other part of the file (styles, fonts, numbering,
// themes, tables, headers) exactly as it was. The old route — read to plain
// text, write a new plain .docx — threw all of that away, which is why an
// edited worksheet came back as a bare text file.
//
// Paragraphs are addressed by NUMBER, from outline() (what read_file shows
// the model). Numbers always refer to the file as it was read, so one call
// can carry many edits without them shifting under each other.
import { zipEntries, zipReadBuf, makeZip } from './office.js';

const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const EMU_PER_INCH = 914400;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unesc(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// ---- reading the package ----------------------------------------------------
function openPackage(buf) {
  const parts = new Map();
  for (const e of zipEntries(buf)) {
    if (e.name.endsWith('/')) continue;
    const data = zipReadBuf(buf, e);
    if (data) parts.set(e.name, data);
  }
  if (!parts.has('word/document.xml')) throw new Error('That is not a Word document (no word/document.xml inside).');
  return parts;
}

// ---- finding paragraphs ------------------------------------------------------
// One pass over the tags we care about. Only OUTERMOST paragraphs are
// numbered — a text box inside a paragraph has its own <w:p>s, and those
// belong to the outer one. Table position is tracked so the outline can say
// "table 1, row 2, cell 3", which is how a worksheet's answer boxes are found.
function scan(xml) {
  const re = /<(\/?)w:(p|tbl|tr|tc)(?=[\s>/])[^>]*?(\/?)>/g;
  const paras = [];
  const tables = []; // stack of {n, row, cell}
  let tableCount = 0;
  let depth = 0;
  let cur = null;
  let m;
  while ((m = re.exec(xml))) {
    const [tag, close, name, selfClose] = m;
    if (name === 'p') {
      if (close) {
        depth--;
        if (depth === 0 && cur) { cur.end = m.index + tag.length; paras.push(cur); cur = null; }
      } else if (selfClose) {
        if (depth === 0) {
          paras.push({ start: m.index, end: m.index + tag.length, table: tables.length ? { ...tables[tables.length - 1] } : null });
        }
      } else {
        if (depth === 0) cur = { start: m.index, table: tables.length ? { ...tables[tables.length - 1] } : null };
        depth++;
      }
      continue;
    }
    if (depth > 0) continue; // tables inside a text box: ignore
    if (name === 'tbl') {
      if (close) tables.pop();
      else if (!selfClose) tables.push({ n: ++tableCount, row: 0, cell: 0 });
    } else if (name === 'tr' && !close && !selfClose && tables.length) {
      const t = tables[tables.length - 1]; t.row++; t.cell = 0;
    } else if (name === 'tc' && !close && !selfClose && tables.length) {
      tables[tables.length - 1].cell++;
    }
  }
  return paras;
}

// Every <w:t> in a paragraph: where its element sits and what it says.
function textNodes(pxml) {
  const out = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m;
  while ((m = re.exec(pxml))) {
    out.push({ start: m.index, end: m.index + m[0].length, text: unesc(m[1]) });
  }
  return out;
}

function paraText(pxml) {
  let s = pxml
    .replace(/<w:tab\/>/g, '<w:t>\t</w:t>')
    .replace(/<w:br\b[^>]*\/>/g, '<w:t>\n</w:t>');
  return textNodes(s).map((t) => t.text).join('');
}

// What read_file shows the model for a .docx: one numbered line per
// paragraph, with its table position, list/heading marks and pictures.
export function outline(buf) {
  const parts = openPackage(buf);
  const xml = parts.get('word/document.xml').toString('utf8');
  const lines = [];
  scan(xml).forEach((p, i) => {
    const pxml = xml.slice(p.start, p.end);
    const bits = [];
    if (p.table) bits.push(`table ${p.table.n}, row ${p.table.row}, cell ${p.table.cell}`);
    const style = (pxml.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
    if (style && /heading|title/i.test(style)) bits.push(style);
    if (/<w:numPr>/.test(pxml)) bits.push('list item');
    const pics = (pxml.match(/<w:drawing>|<w:pict>/g) || []).length;
    if (pics) bits.push(pics === 1 ? 'has a picture' : `has ${pics} pictures`);
    const text = paraText(pxml).replace(/\n/g, ' ⏎ ');
    lines.push(`[${i + 1}]${bits.length ? ' (' + bits.join(', ') + ')' : ''} ${text.trim() ? text : '(empty)'}`);
  });
  return lines.join('\n');
}

// ---- building runs -------------------------------------------------------------
// Text → the inside of a <w:r>: line breaks and tabs become Word's own.
function runInner(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) =>
    line.split('\t').map((seg) => `<w:t xml:space="preserve">${esc(seg)}</w:t>`).join('<w:tab/>')
  ).join('<w:br/>');
}

function firstRunProps(pxml) {
  const runs = pxml.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) || [];
  for (const r of runs) {
    if (/<w:t[\s>]/.test(r)) return (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
  }
  // An empty paragraph keeps its intended run look in the paragraph mark.
  const pPr = (pxml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
  return (pPr.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
}
function lastRunProps(pxml) {
  const runs = pxml.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) || [];
  for (let i = runs.length - 1; i >= 0; i--) {
    if (/<w:t[\s>]/.test(runs[i])) return (runs[i].match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
  }
  return firstRunProps(pxml);
}

// Optional bold/italic/underline override on cloned formatting.
function styleProps(rPr, { bold, italic, underline } = {}) {
  if (bold === undefined && italic === undefined && underline === undefined) return rPr;
  let inner = rPr ? rPr.replace(/^<w:rPr>|<\/w:rPr>$/g, '') : '';
  if (bold !== undefined) inner = inner.replace(/<w:bCs?(?:\s[^>]*)?\/>/g, '') + (bold ? '<w:b/><w:bCs/>' : '');
  if (italic !== undefined) inner = inner.replace(/<w:iCs?(?:\s[^>]*)?\/>/g, '') + (italic ? '<w:i/><w:iCs/>' : '');
  if (underline !== undefined) inner = inner.replace(/<w:u(?:\s[^>]*)?\/>/g, '') + (underline ? '<w:u w:val="single"/>' : '');
  return inner ? `<w:rPr>${inner}</w:rPr>` : '';
}

function openTag(pxml) {
  const t = pxml.match(/^<w:p(?:\s[^>]*?)?\/?>/)[0];
  return t.endsWith('/>') ? t.slice(0, -2) + '>' : t;
}
function paraProps(pxml) {
  return (pxml.match(/<w:pPr>[\s\S]*?<\/w:pPr>|<w:pPr\/>/) || [''])[0];
}
// A paragraph id must be unique in the file; a copied one is dropped.
function freshOpenTag(pxml) {
  return openTag(pxml).replace(/\s+w14:(paraId|textId)="[^"]*"/g, '');
}

function setText(pxml, text, fmt) {
  const rPr = styleProps(firstRunProps(pxml), fmt);
  return `${openTag(pxml)}${paraProps(pxml)}<w:r>${rPr}${runInner(text)}</w:r></w:p>`;
}

function appendText(pxml, text, fmt) {
  const run = `<w:r>${styleProps(lastRunProps(pxml), fmt)}${runInner(text)}</w:r>`;
  if (pxml.endsWith('/>')) return `${openTag(pxml)}${run}</w:p>`;
  return pxml.replace(/<\/w:p>$/, run + '</w:p>');
}

function newParagraphsAfter(pxml, text, fmt) {
  const rPr = styleProps(firstRunProps(pxml), fmt);
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) =>
    `${freshOpenTag(pxml)}${paraProps(pxml)}${line ? `<w:r>${rPr}${runInner(line)}</w:r>` : ''}</w:p>`
  ).join('');
}

// Replace `find` inside one paragraph even when Word has split the words
// across several runs (it usually has). The replacement takes the formatting
// of the run where the match starts.
function replaceIn(pxml, find, repl, all) {
  let count = 0;
  let from = 0;
  for (let guard = 0; guard < 500; guard++) {
    const nodes = textNodes(pxml);
    const full = nodes.map((n) => n.text).join('');
    const at = full.indexOf(find, from);
    if (at < 0) break;
    const endAt = at + find.length;
    let pos = 0;
    const hits = []; // { node, text } for every node the match touches
    for (const n of nodes) {
      const s = pos, e = pos + n.text.length;
      pos = e;
      if (e <= at || s >= endAt) continue;
      const before = at > s ? n.text.slice(0, at - s) : '';
      const after = endAt < e ? n.text.slice(endAt - s) : '';
      // The first node carries the replacement; later ones keep only what
      // follows the match.
      hits.push(hits.length ? { node: n, xml: `<w:t xml:space="preserve">${esc(after)}</w:t>` }
        : { node: n, xml: runInner(before + repl + after) });
    }
    for (let i = hits.length - 1; i >= 0; i--) {
      pxml = pxml.slice(0, hits[i].node.start) + hits[i].xml + pxml.slice(hits[i].node.end);
    }
    count++;
    from = at + repl.length;
    if (!all) break;
  }
  return { xml: pxml, count };
}

// ---- pictures --------------------------------------------------------------
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { type: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  throw new Error('That picture is not a PNG, JPEG or GIF.');
}

const CT = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };

function drawingRun(rId, id, name, cx, cy) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS_A}" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="${NS_A}"><a:graphicData uri="${NS_PIC}"><pic:pic xmlns:pic="${NS_PIC}"><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

// Adds the image part, its relationship and (if needed) its content type;
// returns the run to drop into a paragraph.
function makeImageAdder(parts, xmlRef) {
  let relsXml = parts.has('word/_rels/document.xml.rels')
    ? parts.get('word/_rels/document.xml.rels').toString('utf8')
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  let ctXml = parts.get('[Content_Types].xml').toString('utf8');
  const ids = [...xmlRef.xml.matchAll(/<(?:wp:docPr|pic:cNvPr)\s[^>]*\bid="(\d+)"/g)].map((m) => Number(m[1]));
  let nextId = Math.max(1000, ...ids) + 1;
  let n = 0;
  const add = (img, { widthInches } = {}) => {
    const { type, w, h } = imageSize(img.data);
    let media;
    do { n++; media = `word/media/copilot-${n}.${type === 'jpeg' ? 'jpg' : type}`; } while (parts.has(media));
    parts.set(media, img.data);
    let rId;
    do { rId = `rIdCopilot${n}${Math.random().toString(36).slice(2, 6)}`; } while (relsXml.includes(`"${rId}"`));
    relsXml = relsXml.replace('</Relationships>',
      `<Relationship Id="${rId}" Type="${REL_IMAGE}" Target="${media.replace('word/', '')}"/></Relationships>`);
    const ext = media.split('.').pop();
    // One Default per extension, ever — a duplicate corrupts the file.
    if (!new RegExp(`<Default\\s+Extension="${ext}"`, 'i').test(ctXml)) {
      ctXml = ctXml.replace('</Types>', `<Default Extension="${ext}" ContentType="${CT[type]}"/></Types>`);
    }
    // Screenshots are CSS pixels: 96 per inch, capped to fit a page.
    let inches = Number(widthInches) > 0 ? Number(widthInches) : w / 96;
    inches = Math.min(Math.max(inches, 0.3), 6.5);
    const cx = Math.round(inches * EMU_PER_INCH);
    const cy = Math.round(cx * h / w);
    const id = nextId++;
    return drawingRun(rId, id, img.name || `Picture ${id}`, cx, cy);
  };
  const finish = () => {
    parts.set('word/_rels/document.xml.rels', Buffer.from(relsXml, 'utf8'));
    parts.set('[Content_Types].xml', Buffer.from(ctXml, 'utf8'));
  };
  return { add, finish };
}

function ensureNamespaces(xml) {
  return xml.replace(/<w:document\b[^>]*>/, (tag) => {
    let t = tag;
    if (!/\sxmlns:wp=/.test(t)) t = t.replace(/>$/, ` xmlns:wp="${NS_WP}">`);
    if (!/\sxmlns:r=/.test(t)) t = t.replace(/>$/, ` xmlns:r="${NS_R}">`);
    return t;
  });
}

// ---- applying edits ---------------------------------------------------------
// edits: [{ op, paragraph, ... }]
//   replace        { find, replace, paragraph?, all? }   (no paragraph = whole document)
//   set_text       { paragraph, text, bold?, italic?, underline? }
//   append_text    { paragraph, text, bold?, ... }
//   insert_after   { paragraph, text, bold?, ... }        (each line = a new paragraph)
//   insert_image   { paragraph, image, width_inches?, where: 'after'|'inside', align? }
//   delete         { paragraph }
// loadImage(ref) → { data: Buffer, name } is supplied by the caller, which
// owns where pictures may come from.
export function editDocx(buf, edits, loadImage) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('No edits given.');
  const parts = openPackage(buf);
  const ref = { xml: parts.get('word/document.xml').toString('utf8') };
  const paras = scan(ref.xml);
  const state = paras.map((p) => ({ xml: ref.xml.slice(p.start, p.end), before: [], after: [], table: p.table }));
  const images = makeImageAdder(parts, ref);
  const report = [];
  let usedImages = false;

  const pick = (e) => {
    const i = Number(e.paragraph);
    if (!Number.isInteger(i) || i < 1 || i > state.length) {
      throw new Error(`Paragraph ${e.paragraph} does not exist (the document has ${state.length}). Use the numbers from read_file.`);
    }
    return state[i - 1];
  };
  const fmt = (e) => ({ bold: e.bold, italic: e.italic, underline: e.underline });

  for (const e of edits) {
    const op = e && e.op;
    if (op === 'replace') {
      const find = String(e.find ?? '');
      if (!find) throw new Error('replace needs the text to find.');
      const targets = e.paragraph ? [pick(e)] : state;
      let total = 0;
      for (const s of targets) {
        if (total && !e.all) break;
        const r = replaceIn(s.xml, find, String(e.replace ?? ''), !!e.all);
        s.xml = r.xml; total += r.count;
      }
      report.push(total ? `replaced "${find.slice(0, 40)}" ×${total}` : `NOT FOUND: "${find.slice(0, 40)}"`);
    } else if (op === 'set_text') {
      const s = pick(e); s.xml = setText(s.xml, e.text, fmt(e)); report.push(`set paragraph ${e.paragraph}`);
    } else if (op === 'append_text') {
      const s = pick(e); s.xml = appendText(s.xml, e.text, fmt(e)); report.push(`added to paragraph ${e.paragraph}`);
    } else if (op === 'insert_after') {
      const s = pick(e); s.after.push(newParagraphsAfter(s.xml, e.text, fmt(e))); report.push(`new text after paragraph ${e.paragraph}`);
    } else if (op === 'insert_image') {
      const s = pick(e);
      const img = loadImage(e.image);
      const run = images.add(img, { widthInches: e.width_inches });
      usedImages = true;
      if (e.where === 'inside') {
        s.xml = s.xml.endsWith('/>') ? `${openTag(s.xml)}${run}</w:p>` : s.xml.replace(/<\/w:p>$/, run + '</w:p>');
      } else {
        const jc = ['center', 'right'].includes(e.align) ? `<w:pPr><w:jc w:val="${e.align}"/></w:pPr>` : '';
        s.after.push(`<w:p>${jc}${run}</w:p>`);
      }
      report.push(`picture ${img.name} ${e.where === 'inside' ? 'in' : 'after'} paragraph ${e.paragraph}`);
    } else if (op === 'delete') {
      const s = pick(e);
      // A table cell must keep at least one paragraph or Word rejects the file.
      s.xml = s.table ? '<w:p/>' : '';
      report.push(`deleted paragraph ${e.paragraph}`);
    } else {
      throw new Error(`Unknown edit "${op}". Use replace, set_text, append_text, insert_after, insert_image or delete.`);
    }
  }

  // Stitch back from the end so the original offsets stay valid.
  let xml = ref.xml;
  for (let i = paras.length - 1; i >= 0; i--) {
    const s = state[i];
    xml = xml.slice(0, paras[i].start) + s.before.join('') + s.xml + s.after.join('') + xml.slice(paras[i].end);
  }
  if (usedImages) { xml = ensureNamespaces(xml); images.finish(); }
  parts.set('word/document.xml', Buffer.from(xml, 'utf8'));

  // [Content_Types].xml first, the way Office writes it.
  const names = [...parts.keys()].sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0));
  return { buffer: makeZip(names.map((name) => ({ name, data: parts.get(name) }))), report };
}

export const _internals = { scan, paraText, replaceIn };
