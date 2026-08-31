/* Browser Copilot chat UI — multiple parallel chats, each pinned to a browser tab */
const $ = (id) => document.getElementById(id);
const chatArea = $('chatArea');
const chatList = $('chatList');
const input = $('input');
const sendBtn = $('sendBtn');
const tabSelect = $('tabSelect');

let ws = null;
let ready = false;
const chats = new Map(); // chatId -> Chat
let activeId = null;

const TOOL_LABELS = {
  read_page: () => 'Reading the page',
  fill_field: (i) => `Filling field ${i.elementId ?? ''} → “${String(i.value ?? '').slice(0, 60)}”`,
  fill_many: (i) => `Filling ${i.fields?.length ?? '?'} fields at once`,
  click_element: (i) => `Clicking element ${i.elementId ?? ''}`,
  press_key: (i) => `Pressing ${i.key ?? 'key'}`,
  screenshot: () => 'Taking a screenshot',
  navigate: (i) => `Opening ${String(i.url ?? '').slice(0, 80)}`,
  list_tabs: () => 'Listing your tabs',
  switch_tab: () => 'Switching tab',
};

/* ================= Chat ================= */

class Chat {
  constructor(id) {
    this.id = id;
    this.tabId = null;
    this.busy = false;
    this.title = 'New chat';
    this.lastMeta = '';
    this.streamBubble = null;
    this.streamText = '';
    this.chips = []; // running tool chips

    // message pane
    this.pane = document.createElement('div');
    this.pane.className = 'chat-pane';
    this.pane.hidden = true;
    this.welcome = document.createElement('div');
    this.welcome.className = 'welcome';
    this.welcome.innerHTML = `
      <h2>Chat with Claude about your browser</h2>
      <p>Pick a tab above, then ask Claude to read it or fill things in.<br>
      Each chat works on its own tab — add more chats to run tasks in parallel.</p>
      <p class="fine">Claude fills fields but won’t press Submit/Send/Buy unless you ask it to.</p>`;
    this.pane.appendChild(this.welcome);
    chatArea.appendChild(this.pane);

    // sidebar item
    this.item = document.createElement('div');
    this.item.className = 'chat-item';
    this.item.setAttribute('role', 'button');
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'name';
    this.nameEl.textContent = this.title;
    this.spinEl = document.createElement('span');
    this.spinEl.className = 'spinner';
    this.spinEl.hidden = true;
    this.closeEl = document.createElement('button');
    this.closeEl.className = 'x';
    this.closeEl.textContent = '✕';
    this.closeEl.title = 'Close chat';
    this.item.append(this.spinEl, this.nameEl, this.closeEl);
    chatList.appendChild(this.item);

    this.item.onclick = (e) => {
      if (e.target === this.closeEl) return;
      activateChat(this.id);
    };
    this.item.ondblclick = (e) => {
      if (e.target !== this.closeEl) this.startRename();
    };
    this.nameEl.title = 'Double-click to rename';
    this.closeEl.onclick = () => closeChat(this.id);
  }

  startRename() {
    if (this.item.querySelector('input.rename')) return;
    const field = document.createElement('input');
    field.className = 'rename';
    field.value = this.title;
    this.nameEl.replaceWith(field);
    field.focus();
    field.select();
    const commit = () => {
      const value = field.value.trim();
      field.replaceWith(this.nameEl);
      if (value) this.setTitle(value);
    };
    field.onblur = commit;
    field.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); field.blur(); }
      if (e.key === 'Escape') { field.value = this.title; field.blur(); }
    };
    field.onclick = (e) => e.stopPropagation();
  }

  row(el) {
    const r = document.createElement('div');
    r.className = 'row';
    r.appendChild(el);
    this.pane.appendChild(r);
    this.scroll();
    return el;
  }

  scroll() {
    this.pane.scrollTop = this.pane.scrollHeight;
  }

  addMsg(cls, text) {
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    el.textContent = text;
    return this.row(el);
  }

  ensureStreamBubble() {
    if (!this.streamBubble) {
      this.streamBubble = this.addMsg('claude streaming', '');
      this.streamText = '';
    }
    return this.streamBubble;
  }

  endStream() {
    if (this.streamBubble) {
      this.streamBubble.classList.remove('streaming');
      if (!this.streamBubble.textContent.trim()) this.streamBubble.parentElement.remove();
      this.streamBubble = null;
      this.streamText = '';
    }
  }

  addToolChip(name, inputArgs) {
    this.endStream();
    const chip = document.createElement('div');
    chip.className = 'tool-chip';
    const state = document.createElement('span');
    state.className = 'state spinner';
    const label = document.createElement('span');
    label.className = 'detail';
    const fn = TOOL_LABELS[name];
    label.textContent = fn ? fn(inputArgs || {}) : name;
    chip.append(state, label);
    this.row(chip);
    this.chips.push({ name, chip, state });
  }

  completeToolChip(name, ok, error) {
    const idx = this.chips.findIndex((c) => c.name === name);
    if (idx === -1) return;
    const { chip, state } = this.chips.splice(idx, 1)[0];
    state.classList.remove('spinner');
    state.textContent = ok ? '✓' : '✕';
    chip.classList.add(ok ? 'ok' : 'fail');
    if (!ok && error) chip.title = error;
  }

  setBusy(v) {
    this.busy = v;
    this.spinEl.hidden = !v;
    if (this.id === activeId) syncFooter();
  }

  setTitle(text) {
    this.title = text.length > 30 ? text.slice(0, 30) + '…' : text;
    this.nameEl.textContent = this.title;
    this.nameEl.title = `${text} (double-click to rename)`;
  }

  destroy() {
    this.pane.remove();
    this.item.remove();
  }
}

/* ================= live tab view ================= */
// The Tab view shows the ACTIVE chat's tab, streamed as screencast frames, and
// forwards clicks/typing back into the page — a real window, not a snapshot.
// The composer keeps working underneath it, so you can watch and talk at once.
const tabView = $('tabView');
const tabImg = $('tabImg');
const tabHint = $('tabHint');
let viewMode = 'chat';
let watching = null;  // tabId the server is streaming to us, null when none
let frameMeta = null; // page viewport size in CSS px, from the latest frame

function setMode(mode) {
  viewMode = mode;
  $('viewChat').classList.toggle('active', mode === 'chat');
  $('viewTab').classList.toggle('active', mode === 'tab');
  tabView.hidden = mode !== 'tab';
  if (mode === 'tab') tabView.focus();
  else input.focus();
  syncWatch();
}
$('viewChat').onclick = () => setMode('chat');
$('viewTab').onclick = () => setMode('tab');

// Ask the server for frames of the tab we should be showing — or for silence.
// Called from every place the answer can change: mode switch, chat switch,
// tab dropdown, Claude switching tabs, and reconnect.
function syncWatch() {
  const chat = chats.get(activeId);
  const want = viewMode === 'tab' && ready ? chat?.tabId || tabSelect.value || null : null;
  if (want === watching) return;
  if (watching) ws?.send(JSON.stringify({ type: 'unwatch_tab' }));
  watching = want;
  frameMeta = null;
  tabImg.hidden = true;
  tabImg.removeAttribute('src');
  tabHint.hidden = false;
  if (want) {
    tabHint.textContent = 'Connecting to the tab…';
    ws?.send(JSON.stringify({ type: 'watch_tab', tabId: want }));
  } else {
    tabHint.textContent = 'Pick a tab above to see it here.';
  }
}

// Map a mouse position on the scaled-down image to the page's own pixels.
function pageXY(e) {
  if (!frameMeta) return null;
  const r = tabImg.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return {
    x: Math.round(((e.clientX - r.left) / r.width) * frameMeta.w),
    y: Math.round(((e.clientY - r.top) / r.height) * frameMeta.h),
  };
}

function sendPageInput(event) {
  if (watching && ready) ws?.send(JSON.stringify({ type: 'input', tabId: watching, event }));
}

tabImg.addEventListener('mousedown', (e) => {
  e.preventDefault();
  tabView.focus();
  const p = pageXY(e);
  if (p) sendPageInput({ kind: 'mouse', type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: e.detail || 1 });
});
tabImg.addEventListener('mouseup', (e) => {
  const p = pageXY(e);
  if (p) sendPageInput({ kind: 'mouse', type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: e.detail || 1 });
});
let lastMove = 0;
tabImg.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastMove < 40) return; // hovers matter (menus), floods don't
  lastMove = now;
  const p = pageXY(e);
  if (p) sendPageInput({ kind: 'mouse', type: 'mouseMoved', ...p, buttons: e.buttons });
});
tabImg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = pageXY(e);
  if (p) sendPageInput({ kind: 'mouse', type: 'mouseWheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY });
}, { passive: false });
tabImg.addEventListener('contextmenu', (e) => e.preventDefault());

// New tab, from inside the viewer. Chrome runs with no window now, so this is
// the only "new tab" there is — it opens, gets selected, and shows up here.
// If Chrome isn't running at all, start it (invisibly) and try again.
$('newTabBtn').onclick = async () => {
  const btn = $('newTabBtn');
  btn.disabled = true;
  tabHint.textContent = 'Opening a tab…';
  tabHint.hidden = false;
  try {
    let r = await fetch('/api/new-tab', { method: 'POST' }).then((x) => x.json());
    if (!r.ok) {
      await fetch('/api/launch-chrome', { method: 'POST' }).then((x) => x.json());
      await checkChrome();
      r = await fetch('/api/new-tab', { method: 'POST' }).then((x) => x.json());
    }
    if (r.ok && r.tab) {
      await loadTabs(r.tab.id);
      tabSelect.value = r.tab.id;
      tabSelect.onchange(); // pins the chat to it and points the stream at it
    } else {
      tabHint.textContent = (r && r.error) || 'Could not open a tab.';
      tabHint.hidden = false;
    }
  } catch {
    tabHint.textContent = 'Could not open a tab.';
    tabHint.hidden = false;
  } finally {
    btn.disabled = false;
  }
};

// Typing goes to the page while the view is focused; click the composer and
// keys are yours again. Browser shortcuts (cmd/ctrl) always stay yours.
const PAGE_KEYS = ['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
tabView.addEventListener('keydown', (e) => {
  if (!watching || e.metaKey || e.ctrlKey) return;
  if (e.key.length === 1) {
    e.preventDefault();
    sendPageInput({ kind: 'char', text: e.key });
  } else if (PAGE_KEYS.includes(e.key)) {
    e.preventDefault();
    sendPageInput({ kind: 'key', key: e.key });
  }
});

/* ================= chat management ================= */

function newChatId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createChat() {
  const chat = new Chat(newChatId());
  chats.set(chat.id, chat);
  activateChat(chat.id);
  return chat;
}

function activateChat(id) {
  activeId = id;
  for (const c of chats.values()) {
    c.pane.hidden = c.id !== id;
    c.item.classList.toggle('active', c.id === id);
  }
  const chat = chats.get(id);
  // point the tab selector at this chat's tab
  if (chat?.tabId && [...tabSelect.options].some((o) => o.value === chat.tabId)) {
    tabSelect.value = chat.tabId;
  }
  syncFooter();
  syncWatch(); // the live view shows the chat you're looking at
  input.focus();
}

function closeChat(id) {
  const chat = chats.get(id);
  if (!chat) return;
  ws?.send(JSON.stringify({ type: 'close_chat', chatId: id }));
  chat.destroy();
  chats.delete(id);
  if (activeId === id) {
    const next = [...chats.keys()].pop();
    if (next) activateChat(next);
    else createChat();
  }
}

function syncFooter() {
  const chat = chats.get(activeId);
  $('busyLine').hidden = !chat?.busy;
  sendBtn.disabled = !ready || !!chat?.busy;
  $('metaLine').textContent = chat?.lastMeta || (ready ? 'Connected' : '');
}

/* ================= websocket ================= */

function connect() {
  ready = false;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  ws.onopen = () => {
    $('metaLine').textContent = 'Starting…';
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleEvent(msg);
  };

  ws.onclose = () => {
    ready = false;
    watching = null; // the server-side stream died with the socket
    sendBtn.disabled = true;
    $('metaLine').textContent = 'Disconnected — reconnecting…';
    // server-side sessions died with the socket; tell each chat
    for (const c of chats.values()) {
      if (c.pane.querySelector('.msg')) c.addMsg('system', 'Connection lost — Claude’s memory for this chat was reset.');
      c.setBusy(false);
    }
    setTimeout(connect, 1500);
  };
}

function handleEvent(msg) {
  if (msg.type === 'connected') {
    ready = true;
    syncFooter();
    syncWatch(); // pick the stream back up after a reconnect
    return;
  }

  // Live-view events carry no chatId — the stream follows the active chat.
  if (msg.type === 'frame') {
    if (viewMode === 'tab' && watching) {
      frameMeta = msg.meta;
      tabImg.src = 'data:image/jpeg;base64,' + msg.data;
      tabImg.hidden = false;
      tabHint.hidden = true;
    }
    return;
  }
  if (msg.type === 'watch_error') {
    tabImg.hidden = true;
    tabHint.textContent = msg.error || 'Could not show that tab.';
    tabHint.hidden = false;
    return;
  }

  const chat = chats.get(msg.chatId);
  if (!chat) return;

  switch (msg.type) {
    case 'ready': // Claude session init — informational
      if (msg.model) chat.lastMeta = `Model: ${msg.model}`;
      if (chat.id === activeId) syncFooter();
      break;

    case 'delta':
      chat.streamText += msg.text;
      chat.ensureStreamBubble().textContent = chat.streamText;
      chat.scroll();
      break;

    case 'text': {
      const bubble = chat.ensureStreamBubble();
      renderMd(bubble, msg.text);
      bubble.classList.remove('streaming');
      chat.streamBubble = null;
      chat.streamText = '';
      chat.scroll();
      break;
    }

    case 'tool':
      chat.addToolChip(msg.name, msg.input);
      break;

    case 'tool_done':
      chat.completeToolChip(msg.name, msg.ok, msg.error);
      break;

    case 'tab_switched':
      loadTabs();
      chat.tabId = msg.tabId;
      chat.addMsg('system', `Claude switched to tab: ${msg.title || msg.tabId}`);
      if (chat.id === activeId) syncWatch(); // the live view follows Claude
      break;

    case 'turn_done':
      chat.endStream();
      chat.setBusy(false);
      chat.chips.splice(0).forEach(({ state }) => {
        state.classList.remove('spinner');
        state.textContent = '·';
      });
      if (typeof msg.costUsd === 'number') chat.lastMeta = `Turn cost $${msg.costUsd.toFixed(4)}`;
      if (!msg.ok && msg.subtype) chat.addMsg('system error', `Turn ended: ${msg.subtype}`);
      if (chat.id === activeId) { syncFooter(); input.focus(); }
      break;

    case 'interrupted':
      chat.endStream();
      chat.setBusy(false);
      chat.addMsg('system', msg.ok ? 'Stopped.' : 'Could not stop the current turn.');
      if (chat.id === activeId) syncFooter();
      break;

    case 'error':
      chat.endStream();
      chat.setBusy(false);
      chat.addMsg('system error', msg.message || 'Unknown error');
      if (chat.id === activeId) syncFooter();
      break;
  }
}

// minimal safe markdown: **bold** and `code` only
function renderMd(el, text) {
  el.textContent = '';
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const p of parts) {
    if (p.startsWith('**') && p.endsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = p.slice(2, -2);
      el.appendChild(b);
    } else if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      const c = document.createElement('code');
      c.textContent = p.slice(1, -1);
      el.appendChild(c);
    } else if (p) {
      el.appendChild(document.createTextNode(p));
    }
  }
}

/* ================= sending ================= */

function sendMessage() {
  const chat = chats.get(activeId);
  const text = input.value.trim();
  if (!text || !ready || !chat || chat.busy) return;
  chat.welcome?.remove();
  chat.welcome = null;
  if (chat.title === 'New chat') chat.setTitle(text);
  chat.tabId = tabSelect.value || null;
  chat.addMsg('user', text);
  ws.send(JSON.stringify({ type: 'chat', chatId: chat.id, text, tabId: chat.tabId }));
  input.value = '';
  input.style.height = 'auto';
  chat.setBusy(true);
}

sendBtn.onclick = sendMessage;
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

$('stopBtn').onclick = () => {
  if (activeId) ws?.send(JSON.stringify({ type: 'interrupt', chatId: activeId }));
};

$('newChatBtn').onclick = () => createChat();

/* ================= tabs & chrome status ================= */

async function loadTabs(selectId) {
  try {
    const res = await fetch('/api/tabs').then((r) => r.json());
    const prev = selectId || tabSelect.value;
    tabSelect.innerHTML = '';
    if (!res.ok || !res.tabs.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = res.ok ? 'No tabs open' : 'Chrome not connected';
      tabSelect.appendChild(opt);
      return;
    }
    for (const t of res.tabs) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.title || t.url;
      opt.title = t.url;
      tabSelect.appendChild(opt);
    }
    if (prev && [...tabSelect.options].some((o) => o.value === prev)) {
      tabSelect.value = prev;
    }
  } catch {
    /* server down; onclose handles it */
  }
}

tabSelect.onchange = () => {
  const chat = chats.get(activeId);
  if (chat) {
    chat.tabId = tabSelect.value || null;
    ws?.send(JSON.stringify({ type: 'select_tab', chatId: chat.id, tabId: chat.tabId }));
  }
  syncWatch();
};

$('refreshTabs').onclick = () => loadTabs();

async function checkChrome() {
  try {
    const { chrome: up } = await fetch('/api/status').then((r) => r.json());
    $('chromeStatus').className = `status-dot ${up ? 'on' : 'off'}`;
    $('chromeStatus').title = up ? 'Chrome connected' : 'Chrome not connected';
    $('launchChrome').hidden = up;
    return up;
  } catch {
    return false;
  }
}

$('launchChrome').onclick = async () => {
  $('launchChrome').disabled = true;
  $('launchChrome').textContent = 'Launching…';
  const res = await fetch('/api/launch-chrome', { method: 'POST' }).then((r) => r.json());
  $('launchChrome').disabled = false;
  $('launchChrome').textContent = 'Launch Chrome';
  if (!res.ok) alert(res.error || 'Could not launch Chrome');
  await checkChrome();
  await loadTabs();
};

window.addEventListener('focus', async () => {
  await checkChrome();
  await loadTabs();
});

/* ================= init ================= */
(async () => {
  connect();
  createChat();
  await checkChrome();
  await loadTabs();
  setInterval(checkChrome, 10000);
  input.focus();
})();
