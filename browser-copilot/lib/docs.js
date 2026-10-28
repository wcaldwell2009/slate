// Documents Claude makes, and files the user hands to Claude. Everything
// lives under ~/Documents/Browser Copilot — the tools in claude.js are the
// ONLY write access the session has, and every name is flattened to a safe
// basename here, so nothing can be written outside this folder no matter
// what a page or a reply asks for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isOffice, readToText, buildDocx } from './office.js';
import { outline as docxOutline, editDocx, imageSize } from './docxedit.js';
import { htmlFileToPdf, countPages } from './pdfmake.js';

export const DOCS_DIR = process.env.COPILOT_DOCS_DIR
  || path.join(os.homedir(), 'Documents', 'Browser Copilot');
export const ATTACH_DIR = path.join(DOCS_DIR, 'attachments');
// Pictures captured from the browser for putting into documents, and the
// HTML each PDF was made from (kept so a PDF can be changed and remade).
// Both are folders, so neither clutters the Documents list.
export const IMAGES_DIR = path.join(DOCS_DIR, 'images');
export const SOURCES_DIR = path.join(DOCS_DIR, 'sources');

function ensureDirs() {
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
}

// A path must resolve INSIDE the Browser Copilot folder — names come from a
// model reply, and a reply can be steered by a web page.
function insideDocs(p) {
  const real = path.resolve(DOCS_DIR, String(p || ''));
  const root = path.resolve(DOCS_DIR) + path.sep;
  return real.startsWith(root) ? real : null;
}

function uniqueIn(dir, base, ext) {
  let file = path.join(dir, base + ext);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n})${ext}`);
  return file;
}

// Names arrive from a model reply or a web page: keep only a tame basename.
export function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[/\\:]|[\u0000-\u001f]/g, '').trim();
  if (!base || base.startsWith('.')) return null;
  return base.slice(0, 120);
}

export function saveDoc(name, content) {
  ensureDirs();
  const n = safeName(name);
  if (!n) throw new Error('That file name cannot be used.');
  const text = String(content ?? '');
  // A .docx name means a real Word file, built from the text (one paragraph
  // per line). Everything else is written as-is. This is how an edited Word
  // document goes back to the user openable, not as raw XML.
  if (path.extname(n).toLowerCase() === '.docx') {
    const buf = buildDocx(text);
    fs.writeFileSync(path.join(DOCS_DIR, n), buf);
    return { ok: true, name: n, bytes: buf.length, format: 'docx' };
  }
  fs.writeFileSync(path.join(DOCS_DIR, n), text, 'utf8');
  return { ok: true, name: n, bytes: Buffer.byteLength(text) };
}

export function listDocs() {
  ensureDirs();
  return fs.readdirSync(DOCS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => {
      const st = fs.statSync(path.join(DOCS_DIR, d.name));
      return { name: d.name, bytes: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export function readDoc(name) {
  const n = safeName(name);
  if (!n) throw new Error('That file name cannot be used.');
  const p = path.join(DOCS_DIR, n);
  if (!fs.existsSync(p)) throw new Error(`No document named "${n}".`);
  const cap = 512 * 1024;
  const content = fs.readFileSync(p, 'utf8');
  return content.length > cap
    ? { name: n, content: content.slice(0, cap), truncated: true }
    : { name: n, content };
}

export function docPath(name) {
  const n = safeName(name);
  const p = n && path.join(DOCS_DIR, n);
  return p && fs.existsSync(p) ? p : null;
}

// Read a file the user attached (or one Claude saved), to text. Office files
// (.docx/.pptx/.xlsx) are decoded here — the built-in Read tool cannot, which
// is the whole reason an uploaded Word document did not work. PDFs and images
// stay with Read, which handles them properly. The path must resolve inside
// the Browser Copilot folder, so a reply cannot point this at an arbitrary
// file on the machine.
export function readFile(p) {
  ensureDirs();
  // A bare name ("report.docx") means a saved document.
  const real = path.resolve(DOCS_DIR, String(p || ''));
  const root = path.resolve(DOCS_DIR) + path.sep;
  if (!real.startsWith(root)) {
    throw new Error('That file is not one you uploaded or that I saved.');
  }
  if (!fs.existsSync(real) || !fs.statSync(real).isFile()) {
    throw new Error('That file does not exist. Use list_documents, or check the attached path.');
  }
  if (path.extname(real).toLowerCase() === '.docx') {
    // Numbered paragraphs, so edit_docx can point at exactly the right one.
    const text = docxOutline(fs.readFileSync(real));
    return { name: path.basename(real), kind: 'docx', path: real,
      note: 'Numbered paragraphs — use these numbers with edit_docx to change this file with its formatting kept.',
      content: text.length > 512 * 1024 ? text.slice(0, 512 * 1024) : text };
  }
  const { kind, text } = readToText(real);
  if (kind === 'binary') {
    return { name: path.basename(real), kind, text: null,
      note: 'This is a PDF or image — open it with the Read tool instead, using this path: ' + real };
  }
  const cap = 512 * 1024;
  const capped = text.length > cap;
  return { name: path.basename(real), kind, content: capped ? text.slice(0, cap) : text, truncated: capped };
}

export { isOffice };

// A file the user attached in the chat. Stamped so two "notes.pdf" never
// collide; the returned path is what the prompt hands to Claude's file tools.
export function saveAttachment(name, base64) {
  ensureDirs();
  const n = safeName(name);
  if (!n) throw new Error('That file name cannot be used.');
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw new Error('The file came through empty.');
  if (buf.length > 20 * 1024 * 1024) throw new Error('That file is too big (20 MB max).');
  const p = path.join(ATTACH_DIR, Date.now().toString(36) + '-' + n);
  fs.writeFileSync(p, buf);
  return { ok: true, name: n, path: p, bytes: buf.length };
}

// ---- pictures for documents ---------------------------------------------------
export function saveImage(name, png) {
  ensureDirs();
  const base = (safeName(String(name || '').replace(/\.(png|jpe?g)$/i, '')) || `capture ${Date.now().toString(36)}`).slice(0, 80);
  const file = uniqueIn(IMAGES_DIR, base, '.png');
  fs.writeFileSync(file, png);
  const rel = path.relative(DOCS_DIR, file).split(path.sep).join('/');
  return { ok: true, image: rel, path: file, bytes: png.length };
}

// "images/x.png", "x.png", or an attachment path → the picture's bytes.
export function loadImage(ref) {
  ensureDirs();
  const r = String(ref || '').trim();
  const candidates = [insideDocs(r), insideDocs(path.join('images', r)), path.isAbsolute(r) ? insideDocs(path.relative(DOCS_DIR, r)) : null];
  const hit = candidates.find((c) => c && fs.existsSync(c) && fs.statSync(c).isFile());
  if (!hit) throw new Error(`No picture "${r}". Use the "image" value capture_image gave you, or an attached picture's path.`);
  const data = fs.readFileSync(hit);
  imageSize(data); // throws plainly if it is not a PNG/JPEG/GIF
  return { data, name: path.basename(hit) };
}

// ---- PDFs ---------------------------------------------------------------------
// The HTML is kept in sources/ under the PDF's name; a <base> pointing at the
// Browser Copilot folder makes "images/x.png" and "attachments/…" resolve.
export async function makePdf(name, html, { landscape = false } = {}) {
  ensureDirs();
  let n = safeName(name);
  if (!n) throw new Error('That file name cannot be used.');
  if (path.extname(n).toLowerCase() !== '.pdf') n = n.replace(/\.[a-z0-9]+$/i, '') + '.pdf';
  const base = `<base href="${pathToFileURL(DOCS_DIR + path.sep).href}">`;
  let doc = String(html || '');
  if (!doc.trim()) throw new Error('The document is empty.');
  if (/<head[^>]*>/i.test(doc)) doc = doc.replace(/<head[^>]*>/i, (h) => h + base);
  else doc = `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${doc}</body></html>`;
  const src = path.join(SOURCES_DIR, n.replace(/\.pdf$/i, '.html'));
  fs.writeFileSync(src, doc, 'utf8');
  const { pdf, brokenImages } = await htmlFileToPdf(src, { landscape });
  const out = path.join(DOCS_DIR, n);
  fs.writeFileSync(out, pdf);
  const res = { ok: true, name: n, path: out, pages: countPages(pdf), bytes: pdf.length, html_source: src };
  if (brokenImages.length) res.missing_pictures = brokenImages;
  return res;
}

// ---- editing Word files in place -------------------------------------------------
export function editDocxFile(source, outName, edits) {
  ensureDirs();
  const src = insideDocs(source) || insideDocs(path.isAbsolute(String(source)) ? path.relative(DOCS_DIR, String(source)) : '');
  if (!src || !fs.existsSync(src)) throw new Error('That file is not one you uploaded or that I saved. Pass the path read_file was given.');
  if (path.extname(src).toLowerCase() !== '.docx') throw new Error('edit_docx only edits Word (.docx) files.');
  let n = safeName(outName || path.basename(src).replace(/^[a-z0-9]+-/, '').replace(/\.docx$/i, ' edited.docx'));
  if (!n) throw new Error('That file name cannot be used.');
  if (path.extname(n).toLowerCase() !== '.docx') n += '.docx';
  const { buffer, report } = editDocx(fs.readFileSync(src), edits, loadImage);
  const out = path.join(DOCS_DIR, n);
  fs.writeFileSync(out, buffer);
  return { ok: true, name: n, path: out, changes: report };
}

// The raw file, for the Documents preview and the chat's file card.
export function fileForServing(name) {
  const p = docPath(name);
  if (!p) return null;
  const ext = path.extname(p).toLowerCase();
  const types = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
  return { path: p, type: types[ext] || null };
}
