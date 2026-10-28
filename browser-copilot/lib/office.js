// Read and write Office files (Word .docx, PowerPoint .pptx, Excel .xlsx)
// with ZERO dependencies — they are ZIPs of XML, and Node's zlib is all it
// takes. Ported from Slate's src/attachments.js and src/officegen.js so the
// copilot can read a file the user uploads and hand an edited .docx back.
//
// The built-in Read tool handles text, images and PDFs but NOT Office files
// (it sees the raw ZIP bytes), which is why an uploaded Word document "did
// not work". read_file below fills exactly that gap.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

// ---- reading a ZIP by hand ------------------------------------------------
// Walk the central directory, not the local headers: a streamed Office file
// writes zeroes for the sizes in its local headers, and the central directory
// is always right.
export function zipEntries(buf) {
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

// Raw bytes of one entry (media files are binary — zipRead's utf8 would
// mangle them).
export function zipReadBuf(buf, entry) {
  const off = entry.localOffset;
  if (buf.readUInt32LE(off) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  return zlib.inflateRawSync(raw);
}

function zipText(buf, name) {
  const entry = zipEntries(buf).find((e) => e.name === name);
  return entry ? zipRead(buf, entry) : null;
}

// ---- Office → text --------------------------------------------------------
function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

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

function xlsxText(buf) {
  const xml = zipText(buf, 'xl/sharedStrings.xml');
  if (!xml) return '';
  const bits = (xml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/gi) || [])
    .map((t) => decodeEntities(t.replace(/<[^>]+>/g, '')).trim())
    .filter(Boolean);
  return bits.join('\n');
}

const OFFICE_READERS = { '.docx': docxText, '.pptx': pptxText, '.xlsx': xlsxText };

export function isOffice(name) {
  return path.extname(String(name || '')).toLowerCase() in OFFICE_READERS;
}

// Read a file to text: Office by format, everything else as UTF-8. PDFs and
// images are NOT handled here — they go to the built-in Read tool, which sees
// them properly.
export function readToText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const reader = OFFICE_READERS[ext];
  if (reader) {
    const text = reader(fs.readFileSync(filePath));
    return { kind: ext.slice(1), text };
  }
  if (['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'].includes(ext)) {
    return { kind: 'binary', text: null };
  }
  return { kind: 'text', text: fs.readFileSync(filePath, 'utf8') };
}

// ---- text → .docx ---------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const uncomp = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const comp = zlib.deflateRawSync(uncomp);
    const crc = crc32(uncomp);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(uncomp.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(uncomp.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function xmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// A plain .docx from text: one paragraph per line, blank lines preserved.
export function buildDocx(text) {
  const paras = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => {
    if (!line.trim()) return '<w:p/>';
    return `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r></w:p>`;
  }).join('');
  const document =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const entries = [
    { name: '[Content_Types].xml', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: '_rels/.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: document },
  ];
  return makeZip(entries);
}

export const _internals = { zipEntries, zipText, docxText };
