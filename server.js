// Browser Copilot — chat with a headless Claude Code session that can see and
// fill in your Chrome tabs. Serves the UI, the tab-list API, and a WebSocket
// that bridges the chat to a Claude Agent SDK session.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as chrome from './lib/chrome.js';
import { ChatSession } from './lib/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4321;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', async (req, res) => {
  res.json({ chrome: await chrome.isChromeUp() });
});

app.get('/api/tabs', async (req, res) => {
  try {
    res.json({ ok: true, tabs: await chrome.listTabs() });
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

app.post('/api/launch-chrome', async (req, res) => {
  if (await chrome.isChromeUp()) return res.json({ ok: true, alreadyRunning: true });
  chrome.launchChrome();
  // Give Chrome a few seconds to expose the DevTools port.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await chrome.isChromeUp()) return res.json({ ok: true });
  }
  res.json({ ok: false, error: 'Chrome did not come up on the DevTools port. Close all Chrome windows and try again.' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const send = (event) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };

  // One Claude session per chat, created lazily; all share this connection.
  const sessions = new Map(); // chatId -> ChatSession
  // One live tab view per connection — the UI shows one tab at a time.
  let stopCast = null;
  const stopWatching = () => {
    if (stopCast) { try { stopCast(); } catch { /* already gone */ } stopCast = null; }
  };
  const getSession = (chatId) => {
    let session = sessions.get(chatId);
    if (!session) {
      session = new ChatSession((event) => send({ ...event, chatId }));
      session.start();
      sessions.set(chatId, session);
    }
    return session;
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
      getSession(chatId).sendMessage(msg.text.trim(), msg.tabId || null, tabLabel, snapshot);
    } else if (msg.type === 'interrupt') {
      const ok = await sessions.get(chatId)?.interrupt();
      send({ type: 'interrupted', ok: !!ok, chatId });
    } else if (msg.type === 'select_tab') {
      const session = sessions.get(chatId);
      if (session) session.currentTabId = msg.tabId || null;
    } else if (msg.type === 'close_chat') {
      sessions.get(chatId)?.dispose();
      sessions.delete(chatId);
    } else if (msg.type === 'watch_tab') {
      // Live view of one tab: stream screencast frames until unwatched.
      stopWatching();
      if (typeof msg.tabId === 'string' && msg.tabId) {
        try {
          stopCast = await chrome.watchTab(msg.tabId, (data, meta) => send({ type: 'frame', data, meta }));
        } catch (err) {
          send({ type: 'watch_error', error: String(err.message || err) });
        }
      }
    } else if (msg.type === 'unwatch_tab') {
      stopWatching();
    } else if (msg.type === 'input' && typeof msg.tabId === 'string' && msg.event) {
      // Clicks/typing from the live view, mapped to page pixels by the UI.
      try { await chrome.sendInput(msg.tabId, msg.event); } catch { /* best-effort */ }
    }
  });

  ws.on('close', () => {
    stopWatching();
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
  });
});

server.listen(PORT, () => {
  console.log(`\n  Browser Copilot running → http://localhost:${PORT}\n`);
});
