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
  save_document: (i) => `Writing ${i.name ?? 'a document'}`,
  read_document: (i) => `Reading ${i.name ?? 'a document'}`,
  list_documents: () => 'Looking through the documents',
  Read: (i) => `Reading ${String(i.file_path ?? 'a file').split('/').pop().replace(/^[a-z0-9]+-/, '')}`,
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
let watching = false;  // whether the server is streaming the live view to us
let frameMeta = null;  // page viewport size in CSS px, from the latest frame

// The dropdown is the one control: the viewer shows whichever tab it names,
// without touching Opera — the front tab streams smoothly, a background tab
// updates about once a second, and both are clickable.
function syncViewToDropdown() {
  if (watching && ready && tabSelect.value) {
    ws?.send(JSON.stringify({ type: 'view_tab', tabId: tabSelect.value }));
  }
}

function setMode(mode) {
  viewMode = mode;
  // Remembered per browser, so clicking away from the Copilot tab in Slate
  // and back lands on the same view.
  try { localStorage.setItem('copilotView', mode); } catch { /* private mode */ }
  $('viewChat').classList.toggle('active', mode === 'chat');
  $('viewTab').classList.toggle('active', mode === 'tab');
  $('viewDocs').classList.toggle('active', mode === 'docs');
  tabView.hidden = mode !== 'tab';
  $('docsView').hidden = mode !== 'docs';
  if (mode === 'tab') tabView.focus();
  else input.focus();
  if (mode === 'docs') refreshDocs();
  syncWatch();
}
$('viewChat').onclick = () => setMode('chat');
$('viewTab').onclick = () => setMode('tab');
$('viewDocs').onclick = () => setMode('docs');

/* ================= documents ================= */
// Files Claude has made — the Browser Copilot folder in Documents. Click a
// file to read it here; Open hands it to the normal app for that type.
let openDocName = null;
function fmtBytes(n) {
  return n > 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
}
async function refreshDocs() {
  if (viewMode !== 'docs') return;
  let r;
  try { r = await fetch('/api/docs').then((x) => x.json()); } catch { return; }
  const list = $('docsList');
  list.innerHTML = '';
  if (!r || !r.ok || !r.docs.length) {
    const empty = document.createElement('div');
    empty.className = 'docs-empty';
    empty.textContent = 'Nothing here yet — ask Claude to write something up and it lands in this list (and in the "Browser Copilot" folder in your Documents).';
    list.appendChild(empty);
    $('docPreview').hidden = true;
    openDocName = null;
    return;
  }
  if (openDocName && !r.docs.some((d) => d.name === openDocName)) {
    openDocName = null;
    $('docPreview').hidden = true;
  }
  for (const d of r.docs) {
    const row = document.createElement('div');
    row.className = 'doc-row' + (d.name === openDocName ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'doc-name';
    name.textContent = d.name;
    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    meta.textContent = fmtBytes(d.bytes) + ' · ' + new Date(d.modified).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const openBtn = document.createElement('button');
    openBtn.className = 'ghost-btn small';
    openBtn.textContent = 'Open';
    openBtn.title = 'Open with the normal app for this file type';
    openBtn.onclick = (e) => {
      e.stopPropagation();
      fetch('/api/docs/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: d.name }) });
    };
    row.append(name, meta, openBtn);
    row.onclick = () => showDoc(d.name);
    list.appendChild(row);
  }
}
async function showDoc(name) {
  let r;
  try {
    r = await fetch('/api/docs/content?name=' + encodeURIComponent(name)).then((x) => x.json());
  } catch { return; }
  if (!r || !r.ok) return;
  openDocName = name;
  const pre = $('docPreview');
  pre.textContent = r.content + (r.truncated ? '\n\n… (long file — Open shows the rest)' : '');
  pre.hidden = false;
  document.querySelectorAll('.doc-row').forEach((n) => n.classList.toggle('active', n.querySelector('.doc-name')?.textContent === name));
}

/* ================= model picker ================= */
$('modelSelect').onchange = async () => {
  const r = await fetch('/api/model', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: $('modelSelect').value }),
  }).then((x) => x.json()).catch(() => null);
  const chat = chats.get(activeId);
  if (chat) {
    chat.lastMeta = r && r.ok ? `New chats will use ${$('modelSelect').value}` : 'Could not change the model';
    syncFooter();
  }
};

/* ================= attachments ================= */
// Files for Claude to look at. Uploaded as soon as they are picked, listed
// as chips over the composer, and referenced in the next message sent.
const pendingFiles = []; // {name, path}
function renderAttachChips() {
  const row = $('attachRow');
  row.innerHTML = '';
  row.hidden = pendingFiles.length === 0;
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.textContent = f.name;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Remove';
    x.onclick = () => { pendingFiles.splice(i, 1); renderAttachChips(); };
    chip.appendChild(x);
    row.appendChild(chip);
  });
}
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = async () => {
  for (const f of $('fileInput').files) {
    if (f.size > 20 * 1024 * 1024) {
      const chat = chats.get(activeId);
      if (chat) { chat.lastMeta = `"${f.name}" is too big (20 MB max)`; syncFooter(); }
      continue;
    }
    const b64 = await new Promise((res) => {
      const reader = new FileReader();
      reader.onload = () => res(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(f);
    });
    const r = await fetch('/api/upload', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: f.name, content_base64: b64 }),
    }).then((x) => x.json()).catch(() => null);
    if (r && r.ok) {
      pendingFiles.push({ name: r.name, path: r.path });
      renderAttachChips();
    } else {
      const chat = chats.get(activeId);
      if (chat) { chat.lastMeta = (r && r.error) || `Could not attach "${f.name}"`; syncFooter(); }
    }
  }
  $('fileInput').value = '';
};

// The live view MIRRORS the browser: it always shows whatever tab is active
// in the window, and follows along when that changes — the server does the
// following. So the only question here is on or off.
function syncWatch() {
  const want = viewMode === 'tab' && ready;
  if (want === watching) return;
  watching = want;
  frameMeta = null;
  tabImg.hidden = true;
  tabImg.removeAttribute('src');
  tabHint.hidden = false;
  tabHint.textContent = want ? 'Connecting…' : '';
  // The dropdown's tab rides along so the server pins it from the first frame.
  ws?.send(JSON.stringify(want
    ? { type: 'watch_tab', tabId: tabSelect.value || undefined }
    : { type: 'unwatch_tab' }));
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
  // The server routes input to the tab it is currently streaming.
  if (watching && ready) ws?.send(JSON.stringify({ type: 'input', event }));
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
      tabSelect.onchange(); // pins the chat AND the viewer to the fresh tab
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

// A chat coming back from disk: same Chat object, bubbles rebuilt. The
// server keeps (or replays) Claude's memory for it, so it just continues.
function restoreChat(stored) {
  const chat = new Chat(stored.id);
  chats.set(chat.id, chat);
  chat.tabId = stored.tabId || null; // back onto the browser tab it was on
  if (stored.title) chat.setTitle(stored.title);
  if (stored.messages && stored.messages.length) {
    chat.welcome?.remove();
    chat.welcome = null;
    for (const m of stored.messages) {
      if (m.role === 'you') {
        chat.addMsg('user', m.text);
      } else {
        const bubble = chat.addMsg('claude', '');
        renderMd(bubble, m.text);
      }
    }
  }
  return chat;
}

function activateChat(id) {
  activeId = id;
  try { localStorage.setItem('copilotActiveChat', id); } catch { /* private mode */ }
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
  syncViewToDropdown(); // each chat brings its own tab into the viewer
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
    watching = false; // the server-side stream died with the socket
    sendBtn.disabled = true;
    $('metaLine').textContent = 'Disconnected — reconnecting…';
    // Sessions and transcripts survive on the server now; nothing is lost.
    for (const c of chats.values()) c.setBusy(false);
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
  if (msg.type === 'watching') {
    // The viewer moved to a different tab (or found none).
    frameMeta = null;
    if (!msg.tabId) {
      tabImg.hidden = true;
      tabHint.textContent = 'Nothing to show — open a tab.';
      tabHint.hidden = false;
    }
    return;
  }
  if (msg.type === 'watch_error') {
    tabImg.hidden = true;
    tabHint.textContent = msg.error || 'Could not show the browser.';
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
      chat.tabId = msg.tabId;
      chat.addMsg('system', `Claude switched to tab: ${msg.title || msg.tabId}`);
      if (chat.id === activeId) {
        loadTabs(msg.tabId).then(() => {
          tabSelect.value = msg.tabId;
          syncViewToDropdown(); // the viewer follows Claude's move
        });
      } else {
        loadTabs();
      }
      break;

    case 'turn_done':
      chat.endStream();
      chat.setBusy(false);
      chat.chips.splice(0).forEach(({ state }) => {
        state.classList.remove('spinner');
        state.textContent = '·';
      });
      if (!msg.ok && msg.subtype) chat.addMsg('system error', `Turn ended: ${msg.subtype}`);
      if (chat.id === activeId) { syncFooter(); if (viewMode !== 'tab') input.focus(); }
      refreshDocs(); // a no-op unless the Documents view is up
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
  let text = input.value.trim();
  if (!text && pendingFiles.length) text = 'Take a look at the attached file.';
  if (!text || !ready || !chat || chat.busy) return;
  chat.welcome?.remove();
  chat.welcome = null;
  if (chat.title === 'New chat') chat.setTitle(text);
  chat.tabId = tabSelect.value || null;
  const attachments = pendingFiles.map((f) => f.path);
  const shown = pendingFiles.length
    ? text + '\n(attached: ' + pendingFiles.map((f) => f.name).join(', ') + ')'
    : text;
  chat.addMsg('user', shown);
  ws.send(JSON.stringify({ type: 'chat', chatId: chat.id, text, tabId: chat.tabId, attachments }));
  pendingFiles.length = 0;
  renderAttachChips();
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
  syncViewToDropdown(); // the viewer shows what the dropdown says
};

$('refreshTabs').onclick = () => loadTabs();

let browserName = 'browser';
async function checkChrome() {
  try {
    const { chrome: up, browser } = await fetch('/api/status').then((r) => r.json());
    if (browser) browserName = browser; // Opera on Will's machine, Chrome as fallback
    $('chromeStatus').className = `status-dot ${up ? 'on' : 'off'}`;
    $('chromeStatus').title = up ? `${browserName} connected` : `${browserName} not connected`;
    $('launchChrome').hidden = up;
    $('launchChrome').textContent = `Launch ${browserName}`;
    return up;
  } catch {
    return false;
  }
}

// When the copilot is framed inside Slate, the referrer is Slate's own
// address; launching with it opens Slate in the copilot's browser too, so
// that window can be the one Will actually uses.
function hostUrl() {
  try {
    if (window.top === window || !document.referrer) return null;
    return new URL(document.referrer).origin + '/';
  } catch { return null; }
}

$('launchChrome').onclick = async () => {
  $('launchChrome').disabled = true;
  $('launchChrome').textContent = 'Launching…';
  const res = await fetch('/api/launch-chrome', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startUrl: hostUrl() }),
  }).then((r) => r.json());
  $('launchChrome').disabled = false;
  $('launchChrome').textContent = `Launch ${browserName}`;
  if (!res.ok) alert(res.error || `Could not launch ${browserName}`);
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
  // Tabs first, so restored chats can point the dropdown at their tab.
  await checkChrome();
  await loadTabs();
  // Bring saved conversations back — the copilot reloads every time Slate
  // re-renders its tab, and that must not cost a single message.
  let saved = [];
  try {
    saved = (await fetch('/api/chats').then((r) => r.json())).chats || [];
  } catch { /* fresh start */ }
  let remembered = {};
  try {
    remembered = {
      chat: localStorage.getItem('copilotActiveChat'),
      mode: localStorage.getItem('copilotView'),
    };
  } catch { /* private mode */ }
  if (saved.length) {
    for (const s of saved) restoreChat(s);
    // Reopen the chat that was up, or the newest one.
    activateChat(remembered.chat && chats.has(remembered.chat)
      ? remembered.chat
      : saved[saved.length - 1].id);
  } else {
    createChat();
  }
  // Back to the view that was up — Tab reconnects its stream on its own.
  if (remembered.mode === 'tab' || remembered.mode === 'docs') setMode(remembered.mode);
  try {
    const m = await fetch('/api/model').then((r) => r.json());
    if (m && m.model) $('modelSelect').value = m.model;
  } catch { /* the picker just shows the default */ }
  setInterval(checkChrome, 10000);
  input.focus();
})();
