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

// attachments: the paths of files sent with this message. They are kept so a
// chat that comes back after a restart still knows which files it was given
// (the words alone said "take a look at the attached file" and nothing else).
export function appendMessage(chatId, role, text, attachments = []) {
  const f = fileFor(chatId);
  if (!f || !text) return;
  ensureDir();
  const chat = getChat(chatId) || { id: chatId, title: '', messages: [] };
  if (!chat.title && role === 'you') chat.title = String(text).slice(0, 60);
  const m = { role, text: String(text), at: new Date().toISOString() };
  if (attachments.length) m.attachments = attachments.slice();
  chat.messages.push(m);
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

// Which browser tab the chat is pinned to — remembered so a page reload
// puts the dropdown (and the viewer) back where they were.
export function setTabId(chatId, tabId) {
  const f = fileFor(chatId);
  if (!f || !fs.existsSync(f)) return;
  const chat = getChat(chatId);
  if (!chat) return;
  chat.tabId = tabId || null;
  fs.writeFileSync(f, JSON.stringify(chat));
}

// The Claude Code session behind this chat. It is saved on disk by the SDK
// with everything in it — files read, screenshots, tool results — so a chat
// that comes back resumes THAT, not a retelling of it.
export function setSessionId(chatId, sessionId) {
  const f = fileFor(chatId);
  if (!f || !fs.existsSync(f) || !sessionId) return;
  const chat = getChat(chatId);
  if (!chat || chat.sessionId === sessionId) return;
  chat.sessionId = sessionId;
  fs.writeFileSync(f, JSON.stringify(chat));
}

// Every file ever attached in this chat, oldest first.
export function attachmentsOf(chatId) {
  const chat = getChat(chatId);
  const seen = new Set();
  for (const m of chat?.messages || []) for (const p of m.attachments || []) seen.add(p);
  return [...seen];
}

export function deleteChat(chatId) {
  const f = fileFor(chatId);
  if (f) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
}

// The story so far, for when the real session cannot be resumed (it was
// never saved, or its file is gone). Newest turns win the budget. The list
// of attached files always goes in, whatever the trim drops, so the files
// can be opened again.
export function transcriptFor(chatId, maxChars = 30000) {
  const chat = getChat(chatId);
  if (!chat || !chat.messages.length) return null;
  const lines = [];
  let used = 0;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    const files = (m.attachments || []).map((p) => `\n[attached: ${p}]`).join('');
    const line = (m.role === 'you' ? 'User: ' : 'You (Claude): ') + m.text + files;
    if (used + line.length > maxChars) break;
    used += line.length;
    lines.unshift(line);
  }
  if (!lines.length) return null;
  const all = attachmentsOf(chatId);
  const fileList = all.length
    ? '\n\nFiles the user attached in this chat (open them again with read_file / Read when you need what is in them — you no longer have their contents):\n' + all.map((p) => '- ' + p).join('\n')
    : '';
  return lines.join('\n\n') + fileList;
}

// For a chat's system prompt: the user's OTHER recent chats, by title, with
// the files attached in each. A new chat used to start knowing nothing; with
// this it can see "you sent me Find the Exploits.docx in another chat" and
// open it, whether or not the model ever thought to call remember.
export function overview(exceptChatId, limit = 12) {
  const others = listChats().filter((c) => c.id !== exceptChatId).reverse().slice(0, limit);
  if (!others.length) return '';
  return others.map((c) => {
    const files = attachmentsOf(c.id);
    const day = String(c.updated || '').slice(0, 10);
    return `- "${c.title || 'untitled'}" (last used ${day}, chat id ${c.id})`
      + files.map((p) => `\n    attached: ${p}`).join('');
  }).join('\n');
}

// Search every chat's words. Newest first; each hit carries its neighbours so
// a question comes back with its answer.
export function search(query, limit = 12) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const hits = [];
  for (const c of listChats().reverse()) {
    c.messages.forEach((m, i) => {
      const t = m.text.toLowerCase();
      if (!words.every((w) => t.includes(w))) return;
      const around = c.messages.slice(Math.max(0, i - 1), i + 2).map((x) => ({
        role: x.role === 'you' ? 'user' : 'you', at: x.at, text: x.text.slice(0, 1500), attachments: x.attachments,
      }));
      hits.push({ chat: c.title, chat_id: c.id, at: m.at, messages: around });
    });
  }
  return hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
