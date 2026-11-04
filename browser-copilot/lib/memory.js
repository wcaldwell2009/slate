// Project memory: things the user asked the copilot to keep ("remember my
// worksheet is due Friday", "the lab login is student42"). It is shared by
// EVERY chat — a chat's own history only lives in that chat, and Will kept
// opening a new chat and finding the copilot had never heard of his project.
// One small JSON file; every new or resumed session gets it in its prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = process.env.COPILOT_MEMORY
  || path.join(os.homedir(), '.browser-copilot-memory.json');

const MAX_PROMPT_CHARS = 12000;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data.projects === 'object' ? data : { projects: {} };
  } catch {
    return { projects: {} };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, FILE);
}

// Projects are matched without caring about case or extra spaces, so
// "Find the Exploits" and "find the exploits " are one project.
function keyOf(data, project) {
  const want = String(project || 'General').trim().replace(/\s+/g, ' ') || 'General';
  const found = Object.keys(data.projects).find((k) => k.toLowerCase() === want.toLowerCase());
  return found || want.slice(0, 80);
}

export function remember(project, note) {
  const text = String(note || '').trim();
  if (!text) throw new Error('Nothing to remember — the note was empty.');
  const data = load();
  const k = keyOf(data, project);
  const list = data.projects[k] || (data.projects[k] = []);
  if (!list.some((n) => n.note === text)) list.push({ note: text.slice(0, 2000), at: new Date().toISOString() });
  save(data);
  return { ok: true, project: k, notes: list.length };
}

export function recall(project) {
  const data = load();
  if (!project) return { projects: data.projects };
  const k = keyOf(data, project);
  return { project: k, notes: data.projects[k] || [] };
}

// Without `contains`, forgets the whole project.
export function forget(project, contains) {
  const data = load();
  const k = keyOf(data, project);
  const list = data.projects[k];
  if (!list) return { ok: false, error: `Nothing is saved under "${k}".` };
  if (contains) {
    const needle = String(contains).toLowerCase();
    const kept = list.filter((n) => !n.note.toLowerCase().includes(needle));
    const removed = list.length - kept.length;
    if (kept.length) data.projects[k] = kept; else delete data.projects[k];
    save(data);
    return { ok: true, project: k, removed };
  }
  delete data.projects[k];
  save(data);
  return { ok: true, project: k, removed: list.length };
}

// The block that goes into the system prompt. Most recently touched projects
// first, so a long memory trims its oldest projects, never the current one.
export function promptBlock() {
  const data = load();
  const entries = Object.entries(data.projects)
    .filter(([, l]) => l.length)
    .sort((a, b) => String(b[1].at(-1).at).localeCompare(String(a[1].at(-1).at)));
  if (!entries.length) return '';
  let out = '';
  for (const [k, list] of entries) {
    const block = `\n## ${k}\n` + list.map((n) => `- ${n.note}`).join('\n') + '\n';
    if (out.length + block.length > MAX_PROMPT_CHARS) break;
    out += block;
  }
  return out;
}
