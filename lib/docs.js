// Documents Claude makes, and files the user hands to Claude. Everything
// lives under ~/Documents/Browser Copilot — the tools in claude.js are the
// ONLY write access the session has, and every name is flattened to a safe
// basename here, so nothing can be written outside this folder no matter
// what a page or a reply asks for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DOCS_DIR = process.env.COPILOT_DOCS_DIR
  || path.join(os.homedir(), 'Documents', 'Browser Copilot');
export const ATTACH_DIR = path.join(DOCS_DIR, 'attachments');

function ensureDirs() {
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
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

// A file the user attached in the chat. Stamped so two "notes.pdf" never
// collide; the returned path is what the prompt hands to Claude's Read tool.
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
