'use strict';

// Files a teacher attached to a Canvas assignment.
//
// Two jobs:
//   1. Let Will open the file. It downloads once, lands in the data folder, and
//      opens in whatever program the machine already uses for that type — Word
//      for a .docx, Excel for a .xlsx, the browser or Acrobat for a PDF.
//   2. Read what's inside it, so the Instructions box is built from the whole
//      assignment and not just the description box. Teachers here routinely put
//      the actual directions in an attached .docx or PDF and leave the
//      description empty.
//
// WHERE THE FILES COME FROM. Real Canvas does NOT give an assignment an
// `attachments` field — the Assignment object has no such thing. An attached
// file is an <a class="instructure_file_link"> inside the description HTML,
// pointing at /courses/<cid>/files/<fid>. So they're parsed out of the
// description. The mock's `attachments` array is still honoured, which is what
// the tests and the drive harness run on.
//
// Reading text is zero-dependency and by hand: Office files are ZIPs, so
// document.xml / the slide XML / sharedStrings.xml come out with inflateRaw.
// PDFs and photos can't be done that way and go to Claude instead, the same
// hidden `claude -p` the class-notes reader uses.

const fs = require('fs');
const path = require('path');
const zlib = require('node:zlib');
const { spawn } = require('child_process');

const DATA_DIR = process.env.SLATE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE_DIR = path.join(DATA_DIR, 'attachments');

// Big files are almost never instructions — a 40MB video or a slide deck full
// of photos costs a long download to learn nothing.
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
// How much extracted text is worth keeping. Instructions are short; anything
// past this is a data dump and only makes the simplify prompt worse.
const MAX_TEXT_CHARS = 12000;

function ensureDir() {
  fs.mkdirSync(FILE_DIR, { recursive: true });
  return FILE_DIR;
}

// ---- finding the links ---------------------------------------------------
function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function attrOf(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
    || tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

// Every file link in an assignment description, in the order they appear and
// with the duplicates dropped — a teacher who links the same handout from three
// assignments (or twice in one) shouldn't produce three copies.
function linksFromDescription(html) {
  const out = [];
  const seen = new Set();
  const anchors = String(html || '').match(/<a\b[^>]*>(?:[\s\S]*?<\/a>)?/gi) || [];
  for (const a of anchors) {
    const tag = a.match(/<a\b[^>]*>/i)[0];
    const href = attrOf(tag, 'href');
    const api = attrOf(tag, 'data-api-endpoint');
    const idMatch = (api || href).match(/\/files\/(\d+)/);
    if (!idMatch) continue;
    const fileId = idMatch[1];
    if (seen.has(fileId)) continue;
    seen.add(fileId);

    const courseMatch = (api || href).match(/\/courses\/(\d+)/);
    // Canvas puts the real filename in title=. When a teacher has retyped the
    // link text the title is sometimes just "Link" — then the anchor text is
    // the better name, and if that fails too the file id has to do.
    const title = attrOf(tag, 'title');
    const text = decodeEntities(a.replace(/<[^>]*>/g, '')).trim();
    const name = (/\.\w{2,5}$/.test(title) && title)
      || (/\.\w{2,5}$/.test(text) && text)
      || title || text || `file-${fileId}`;
    out.push({
      file_id: fileId,
      course_id: courseMatch ? courseMatch[1] : null,
      name,
      url: href || null,
      api: api || null,
    });
  }
  return out;
}

// The description with its file links taken out. The files get their own
// buttons on the page, so leaving the links in the text means the filename
// turns up as a bullet in the student's instruction checklist — which is what
// it did: "organelle_worksheet.docx" sat there as step 3.
function stripFileLinks(html) {
  return String(html || '')
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (a) => (/\/files\/\d+|instructure_file_link/i.test(a) ? ' ' : a))
    .replace(/<a\b[^>]*\/?>/gi, (a) => (/\/files\/\d+|instructure_file_link/i.test(a) ? ' ' : a));
}

// The list stored on an assignment, from whichever source has it: the mock's
// attachments array, or the links in a real Canvas description.
function attachmentsFor({ attachments, description }) {
  const fromField = (attachments || []).map((f, i) => ({
    file_id: String(f.id != null ? f.id : `m${i}`),
    course_id: null,
    name: f.display_name || f.filename || `file-${i + 1}`,
    url: f.url || null,
    api: null,
  }));
  if (fromField.length) return fromField;
  return linksFromDescription(description);
}

// ---- reading a ZIP by hand -----------------------------------------------
// Walks the central directory rather than the local headers: a local header can
// carry zeroes for the sizes when the writer streamed the entry, and Office
// files in the wild do exactly that. The central directory is always right.
function zipEntries(buf) {
  const EOCD = 0x06054b50;
  let end = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end < 0) return [];
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entry) {
  const off = entry.localOffset;
  if (buf.readUInt32LE(off) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.compSize);
  try {
    if (entry.method === 0) return raw.toString('utf8');
    return zlib.inflateRawSync(raw).toString('utf8');
  } catch {
    return null;
  }
}

function zipText(buf, name) {
  const entry = zipEntries(buf).find((e) => e.name === name);
  return entry ? zipRead(buf, entry) : null;
}

// ---- Office formats ------------------------------------------------------
function xmlToText(xml, { paraTags = [], breakTags = [] } = {}) {
  let s = String(xml || '');
  for (const t of breakTags) s = s.replace(new RegExp(`<${t}\\b[^>]*/?>`, 'gi'), '\n');
  for (const t of paraTags) s = s.replace(new RegExp(`</${t}>`, 'gi'), '\n');
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function docxText(buf) {
  const xml = zipText(buf, 'word/document.xml');
  if (!xml) return '';
  return xmlToText(xml, { paraTags: ['w:p'], breakTags: ['w:br', 'w:tab'] });
}

function pptxText(buf) {
  const slides = zipEntries(buf)
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
  const out = [];
  for (const s of slides) {
    const xml = zipRead(buf, s);
    if (!xml) continue;
    const text = xmlToText(xml, { paraTags: ['a:p'], breakTags: ['a:br'] });
    if (text) out.push(`Slide ${out.length + 1}\n${text}`);
  }
  return out.join('\n\n');
}

// Spreadsheets are usually a data file rather than directions, so this only
// pulls the words out — the shared string table is where the labels live and
// that is enough to tell what the sheet is for.
function xlsxText(buf) {
  const xml = zipText(buf, 'xl/sharedStrings.xml');
  if (!xml) return '';
  const bits = (xml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/gi) || [])
    .map((t) => decodeEntities(t.replace(/<[^>]+>/g, '')).trim())
    .filter(Boolean);
  return bits.join('\n');
}

function looksLikeZip(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

const PLAIN = new Set(['.txt', '.md', '.csv', '.rtf', '.json']);
const OFFICE = new Set(['.docx', '.pptx', '.xlsx']);
const ASK_CLAUDE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

// Can Slate get anything out of this at all? Used to avoid spending a download
// on a video, a zip of photos, or some binary nobody can read.
function isReadable(name) {
  const e = extOf(name);
  return PLAIN.has(e) || OFFICE.has(e) || ASK_CLAUDE.has(e) || e === '.html' || e === '.htm';
}

// Text straight out of the bytes. Returns '' for anything that needs Claude.
function textFromBytes(buf, name) {
  const e = extOf(name);
  if (PLAIN.has(e)) return buf.toString('utf8');
  if (e === '.html' || e === '.htm') return xmlToText(buf.toString('utf8'), { paraTags: ['p', 'div', 'li', 'tr'], breakTags: ['br'] });
  if (OFFICE.has(e) && looksLikeZip(buf)) {
    if (e === '.docx') return docxText(buf);
    if (e === '.pptx') return pptxText(buf);
    if (e === '.xlsx') return xlsxText(buf);
  }
  return '';
}

// ---- downloading ---------------------------------------------------------
function safeName(fileId, name) {
  const base = String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(-90);
  return `${fileId}-${base}`;
}

function localPathFor(file) {
  return path.join(FILE_DIR, safeName(file.file_id, file.name));
}

// Downloads once and keeps it. Returns the path on disk.
//
// The bytes come from the Canvas client, never from a fetch() here — that's what
// lets the mock serve a real file and the whole path get tested without a
// network. It also keeps every outbound request in the one file that is
// supposed to own them.
async function ensureDownloaded(file) {
  const target = localPathFor(file);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;

  const { getClient } = require('./canvas/canvasClient');
  const buf = await getClient().downloadFile(file);
  if (!buf || !buf.length) throw new Error('Canvas sent an empty file');
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('that file is too big to open here');

  ensureDir();
  fs.writeFileSync(target, buf);
  return target;
}

// ---- opening it on Will's computer ---------------------------------------
// Hands the file to whatever already opens that type. No viewer of Slate's own:
// Word renders a .docx better than anything that could be written here, and the
// file is on his machine either way.
function openOnComputer(filePath) {
  if (process.env.SLATE_OPEN === '0') return false; // tests
  if (!fs.existsSync(filePath)) throw new Error('that file is not downloaded');
  try {
    if (process.platform === 'win32') {
      // The empty "" is the window title `start` insists on before the path,
      // otherwise a quoted path is read as the title and nothing opens.
      spawn('cmd', ['/c', 'start', '""', filePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch (e) {
    throw new Error('Windows would not open that file: ' + e.message);
  }
}

// ---- what's inside it ----------------------------------------------------
async function readAttachmentText(file) {
  if (!isReadable(file.name)) return '';
  const filePath = await ensureDownloaded(file);
  const buf = fs.readFileSync(filePath);

  const direct = textFromBytes(buf, file.name);
  if (direct && direct.trim()) return direct.trim().slice(0, MAX_TEXT_CHARS);

  // PDFs and photographs of a worksheet: no way to do this by hand, so Claude
  // reads the file. Structured output only — raw stdout from the hidden CLI is
  // never trustworthy (see the note at the top of claude.js).
  if (!ASK_CLAUDE.has(extOf(file.name))) return '';
  const { askAboutFile, parseJson, queued } = require('./claude');
  const prompt = [
    'This file was attached to a school assignment. Type out what it actually says:',
    'the instructions, questions, prompts, headings and any list of steps.',
    'Copy the wording, do not summarize it and do not answer anything in it.',
    'Skip page furniture like headers, footers and page numbers.',
    '',
    'Reply with JSON and nothing else:',
    '{"text": "everything the file says, as plain text with line breaks"}',
  ].join('\n');
  const reply = await queued(() => askAboutFile(filePath, prompt, { timeoutMs: 180000 }));
  const data = parseJson(reply);
  const text = typeof data.text === 'string' ? data.text : '';
  return text.trim().slice(0, MAX_TEXT_CHARS);
}

module.exports = {
  FILE_DIR,
  MAX_TEXT_CHARS,
  linksFromDescription,
  stripFileLinks,
  attachmentsFor,
  isReadable,
  extOf,
  textFromBytes,
  docxText,
  pptxText,
  xlsxText,
  zipEntries,
  zipText,
  localPathFor,
  ensureDownloaded,
  openOnComputer,
  readAttachmentText,
};
