// Browser Copilot — chat with a headless Claude Code session that can see and
// fill in your Chrome tabs. Serves the UI, the tab-list API, and a WebSocket
// that bridges the chat to a Claude Agent SDK session.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import * as chrome from './lib/chrome.js';
import * as docs from './lib/docs.js';
import * as chats from './lib/chats.js';
import { MODELS, currentModel, writeSettings } from './lib/settings.js';
import { ChatSession } from './lib/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4321;

const app = express();
app.use(express.json({ limit: '30mb' })); // attachments arrive base64 in the body
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', async (req, res) => {
  res.json({ chrome: await chrome.isChromeUp(), browser: chrome.browserName() });
});

app.get('/api/tabs', async (req, res) => {
  try {
    res.json({ ok: true, tabs: await chrome.listTabs() });
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err) });
  }
});

// ---- documents, model, attachments ----------------------------------------
app.get('/api/docs', (req, res) => {
  try {
    res.json({ ok: true, docs: docs.listDocs() });
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err) });
  }
});

app.get('/api/docs/content', (req, res) => {
  try {
    res.json({ ok: true, ...docs.readDoc(req.query.name) });
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err) });
  }
});

// Opens a document with whatever app the machine uses for that type. The
// path always comes from docs.docPath (a checked name inside the folder),
// never from the request.
app.post('/api/docs/open', (req, res) => {
  const p = docs.docPath(req.body && req.body.name);
  if (!p) return res.json({ ok: false, error: 'No document with that name.' });
  try {
    // "start" is a cmd builtin on Windows, not a program — same shape as
    // Slate's own openers.
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err) });
  }
});

app.get('/api/model', (req, res) => {
  res.json({ ok: true, model: currentModel(), models: MODELS });
});

app.post('/api/model', (req, res) => {
  const model = req.body && req.body.model;
  if (!MODELS.includes(model)) return res.json({ ok: false, error: 'Unknown model.' });
  writeSettings({ model });
  res.json({ ok: true, model });
});

app.post('/api/upload', (req, res) => {
  try {
    res.json(docs.saveAttachment(req.body && req.body.filename, req.body && req.body.content_base64));
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err) });
  }
});

// Saved conversations, so the page can rebuild its chats after any reload.
app.get('/api/chats', (req, res) => {
  try {
    res.json({ ok: true, chats: chats.listChats() });
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err) });
  }
});

app.post('/api/new-tab', async (req, res) => {
  try {
    res.json({ ok: true, tab: await chrome.openTab((req.body && req.body.url) || undefined) });
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err) });
  }
});

// `startUrl` (http/https only) is the page to open in the launched browser —
// Slate passes its own address when it hosts the copilot, so one Launch gives
// Will a window that has Slate AND his tabs, and everything he does in that
// window is what the copilot sees. His everyday Opera can never be attached
// to (Chromium 136+ refuses remote debugging on a default profile), so the
// copilot's window has to BE the everyday one; this is what makes that easy.
function startUrlFrom(body) {
  const u = body && typeof body.startUrl === 'string' ? body.startUrl.trim() : '';
  return /^https?:\/\//i.test(u) ? u : null;
}
// Open `url` in the copilot browser unless a tab already has it. Session
// restore brings Will's old tabs back — Slate included, once he's used it
// there — so launching WITH the url as an argument made a second Slate tab.
async function ensureTab(url) {
  if (!url) return;
  try {
    const want = url.replace(/\/+$/, '');
    const tabs = await chrome.listTabs();
    if (!tabs.some((t) => t.url.replace(/\/+$/, '') === want)) await chrome.openTab(url);
  } catch { /* the tab is a nicety; the launch itself already succeeded */ }
}
app.post('/api/launch-chrome', async (req, res) => {
  const startUrl = startUrlFrom(req.body);
  if (await chrome.isChromeUp()) {
    await ensureTab(startUrl);
    return res.json({ ok: true, alreadyRunning: true });
  }
  chrome.launchChrome();
  // Wait for the DevTools port. A cold Opera with Will's profile (session
  // restore, extensions) takes 15-30s on his Mac; the old 10s cap reported
  // "did not come up" while it was still coming up.
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await chrome.isChromeUp()) {
      // Give session restore a moment to list its tabs before deciding
      // whether the start page is missing.
      await new Promise((r) => setTimeout(r, 1500));
      await ensureTab(startUrl);
      return res.json({ ok: true });
    }
  }
  res.json({ ok: false, error: `${chrome.browserName()} did not come up on the DevTools port after 45s. If a copilot browser window is already open from before, close it and try again.` });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// SESSIONS OUTLIVE THE PAGE. The copilot lives in an iframe that Slate tears
// down every time Will switches Slate tabs, so a per-connection session map
// meant Claude forgot everything on every navigation. Sessions live here at
// module scope, events go to whichever connection is current, transcripts go
// to disk (lib/chats.js), and a session that died — server restart, idle
// reaping — is handed the story so far on its next message.
const sessions = new Map(); // chatId -> ChatSession
let uiSend = null; // the send() of the most recent connection

function flushTurn(chatId, session) {
  if (session.__turnBuf && session.__turnBuf.length) {
    chats.appendMessage(chatId, 'claude', session.__turnBuf.join('\n\n'));
    session.__turnBuf = [];
  }
}

function getSession(chatId) {
  let session = sessions.get(chatId);
  if (!session) {
    // The model picker applies to chats started after it changes.
    session = new ChatSession((event) => {
      if (event.type === 'text') session.__turnBuf.push(event.text);
      if (event.type === 'turn_done') flushTurn(chatId, session);
      if (uiSend) uiSend({ ...event, chatId });
    }, currentModel());
    session.__turnBuf = [];
    // A transcript on disk means this chat is resuming in a fresh session.
    const stored = chats.getChat(chatId);
    session.__needsReplay = !!(stored && stored.messages && stored.messages.length);
    session.start();
    sessions.set(chatId, session);
  }
  session.lastUsed = Date.now();
  return session;
}

// An idle session still holds a hidden claude process; let long-quiet ones
// go. The transcript stays, so the chat resumes seamlessly when poked.
setInterval(() => {
  for (const [id, s] of sessions) {
    if (Date.now() - (s.lastUsed || 0) > 3 * 60 * 60 * 1000) {
      try { s.dispose(); } catch { /* already gone */ }
      sessions.delete(id);
    }
  }
}, 15 * 60 * 1000).unref();

wss.on('connection', (ws) => {
  const send = (event) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  uiSend = send; // chat events follow the newest page

  // One live view per connection — the screencast dies with the socket.
  let watcher = null;
  const stopWatching = () => {
    if (watcher) { try { watcher.stop(); } catch { /* already gone */ } watcher = null; }
  };

  send({ type: 'connected' });

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const chatId = msg.chatId || 'default';

    if (msg.type === 'chat' && typeof msg.text === 'string' && msg.text.trim()) {
      let tabLabel = null;
      let snapshot = null;
      if (msg.tabId) {
        try {
          const tab = (await chrome.listTabs()).find((t) => t.id === msg.tabId);
          if (tab) tabLabel = `"${tab.title}" — ${tab.url}`;
          // Attach a fresh page snapshot so Claude can act without a read_page round trip.
          snapshot = await chrome.readPage(msg.tabId);
        } catch {
          // Chrome not reachable; Claude's tools will report it.
        }
      }
      // Attachment paths must be files the upload endpoint produced — never
      // an arbitrary path a page script could have slipped into the message.
      const attachments = (Array.isArray(msg.attachments) ? msg.attachments : [])
        .filter((p) => typeof p === 'string' && p.startsWith(docs.ATTACH_DIR + path.sep) && fs.existsSync(p))
        .slice(0, 8);
      const session = getSession(chatId);
      let text = msg.text.trim();
      // A resuming session gets the story so far BEFORE this message is
      // added to the transcript, so the current question isn't in it twice.
      if (session.__needsReplay) {
        session.__needsReplay = false;
        const story = chats.transcriptFor(chatId);
        if (story) {
          text = '[This chat is continuing after a restart. The conversation so far:\n'
            + story
            + '\nEnd of the earlier conversation — pick up naturally from there and do not mention this note.]\n\n'
            + text;
        }
      }
      chats.appendMessage(chatId, 'you', msg.text.trim());
      chats.setTabId(chatId, msg.tabId || null);
      session.sendMessage(text, msg.tabId || null, tabLabel, snapshot, attachments);
    } else if (msg.type === 'interrupt') {
      const stopped = sessions.get(chatId);
      const ok = await stopped?.interrupt();
      if (stopped) flushTurn(chatId, stopped); // keep whatever it had said
      send({ type: 'interrupted', ok: !!ok, chatId });
    } else if (msg.type === 'select_tab') {
      const session = sessions.get(chatId);
      if (session) session.currentTabId = msg.tabId || null;
      chats.setTabId(chatId, msg.tabId || null);
    } else if (msg.type === 'close_chat') {
      sessions.get(chatId)?.dispose();
      sessions.delete(chatId);
      chats.deleteChat(chatId); // closing a chat forgets it on purpose
    } else if (msg.type === 'watch_tab') {
      // Live view of the dropdown's tab (rides along as msg.tabId so the
      // right tab is pinned from the first frame). Opera is never touched.
      stopWatching();
      try {
        watcher = await chrome.watchView(
          (data, meta) => send({ type: 'frame', data, meta }),
          (tabId, title, url, pinned) => send({ type: 'watching', tabId, title, url, pinned })
        );
        if (typeof msg.tabId === 'string' && msg.tabId) await watcher.pin(msg.tabId);
      } catch (err) {
        send({ type: 'watch_error', error: String(err.message || err) });
      }
    } else if (msg.type === 'unwatch_tab') {
      stopWatching();
    } else if (msg.type === 'view_tab' && typeof msg.tabId === 'string' && msg.tabId) {
      // The dropdown changed: show that tab in the viewer.
      try {
        if (watcher) await watcher.pin(msg.tabId);
      } catch { /* tab may be gone; a closed pin falls back on its own */ }
    } else if (msg.type === 'input' && msg.event) {
      // Clicks/typing from the live view go to the tab being streamed.
      const target = (watcher && watcher.current()) || null;
      if (target) {
        try { await chrome.sendInput(target, msg.event); } catch { /* best-effort */ }
      }
    }
  });

  ws.on('close', () => {
    stopWatching();
    // Sessions deliberately survive the page going away — see above.
    if (uiSend === send) uiSend = null;
  });
});

server.listen(PORT, () => {
  console.log(`\n  Browser Copilot running → http://localhost:${PORT}\n`);
});
