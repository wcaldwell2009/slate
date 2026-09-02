// Chat transcripts, on disk. The Claude session lives in a process, and a
// process dies — a server update, a page reload, the laptop sleeping — so
// the conversation itself must not live there. Same lesson as Slate's own
// chat: the transcript is the durable thing, and a fresh session is handed
// the story so far. One JSON file per chat.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHATS_DIR = process.env.COPILOT_CHATS_DIR
  || path.join(os.homedir(), '.browser-copilot-chats');

function ensureDir() {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
}

// Chat ids come from the page; only a tame id becomes a file name.
function fileFor(chatId) {
  const id = String(chatId || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  return id ? path.join(CHATS_DIR, id + '.json') : null;
}

export function getChat(chatId) {
  const f = fileFor(chatId);
  if (!f || !fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

export function appendMessage(chatId, role, text) {
  const f = fileFor(chatId);
  if (!f || !text) return;
  ensureDir();
  const chat = getChat(chatId) || { id: chatId, title: '', messages: [] };
  if (!chat.title && role === 'you') chat.title = String(text).slice(0, 60);
  chat.messages.push({ role, text: String(text), at: new Date().toISOString() });
  // A very long chat file stays readable but never unbounded.
  if (chat.messages.length > 400) chat.messages = chat.messages.slice(-400);
  chat.updated = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(chat));
}

export function listChats() {
  ensureDir();
  return fs.readdirSync(CHATS_DIR)
    .filter((n) => n.endsWith('.json'))
    .map((n) => getChat(n.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => String(a.updated || '').localeCompare(String(b.updated || '')));
}

export function deleteChat(chatId) {
  const f = fileFor(chatId);
  if (f) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
}

// The story so far, for a session that has just been (re)created. Newest
// turns win the budget — the same trim Slate's chat uses.
export function transcriptFor(chatId, maxChars = 12000) {
  const chat = getChat(chatId);
  if (!chat || !chat.messages.length) return null;
  const lines = [];
  let used = 0;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    const line = (m.role === 'you' ? 'User: ' : 'You (Claude): ') + m.text;
    if (used + line.length > maxChars) break;
    used += line.length;
    lines.unshift(line);
  }
  if (!lines.length) return null;
  return lines.join('\n\n');
}
