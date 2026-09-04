// Chrome DevTools Protocol layer: tab listing, page reading, filling, clicking, screenshots.
import CDP from 'chrome-remote-interface';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Overridable so a test can point a throwaway copilot server at a throwaway
// headless browser. The copilot's Opera is Will's WORKING browser now — no
// harness may click or type at the real 9222 again (a test once typed into
// his live Slate tab that way).
export const CDP_PORT = Number(process.env.COPILOT_CDP_PORT) || 9222;
// Will browses in Opera, so the copilot drives Opera when it's installed (his
// copy lives in ~/Applications — he is not an admin on this Mac) and falls
// back to Chrome. Same Chromium engine either way; the protocol doesn't care.
//
// Chromium 136+ refuses --remote-debugging-port on a browser's DEFAULT
// profile, so his everyday Opera window can never be attached to — this uses
// a dedicated profile dir instead, seeded once (2026-09-01) with a copy of
// his real profile: same logins, bookmarks and saved session.
const BROWSERS = process.platform === 'win32' ? [
  // Will's PC. Opera installs per-user under LOCALAPPDATA by default.
  { name: 'Opera', bin: path.join(process.env.LOCALAPPDATA || '', 'Programs/Opera/opera.exe'), profile: '.browser-copilot-opera' },
  { name: 'Opera', bin: path.join(process.env.ProgramFiles || '', 'Opera/opera.exe'), profile: '.browser-copilot-opera' },
  { name: 'Chrome', bin: path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'), profile: '.browser-copilot-chrome' },
  { name: 'Chrome', bin: path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'), profile: '.browser-copilot-chrome' },
  { name: 'Edge', bin: path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'), profile: '.browser-copilot-edge' },
  { name: 'Edge', bin: path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'), profile: '.browser-copilot-edge' },
] : [
  // Will's Mac. His Opera lives in ~/Applications (he is not an admin).
  { name: 'Opera', bin: path.join(os.homedir(), 'Applications/Opera.app/Contents/MacOS/Opera'), profile: '.browser-copilot-opera' },
  { name: 'Opera', bin: '/Applications/Opera.app/Contents/MacOS/Opera', profile: '.browser-copilot-opera' },
  { name: 'Chrome', bin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', profile: '.browser-copilot-chrome' },
];
function pickBrowser() {
  for (const b of BROWSERS) {
    try { if (fs.existsSync(b.bin)) return b; } catch { /* keep looking */ }
  }
  return BROWSERS[BROWSERS.length - 1];
}
export function browserName() {
  return pickBrowser().name;
}

const clients = new Map(); // targetId -> Promise<CDP client> (promise-cached so concurrent chats share one connection)

export async function isChromeUp() {
  try {
    await CDP.Version({ port: CDP_PORT });
    return true;
  } catch {
    return false;
  }
}

export function launchChrome(startUrl = null) {
  const b = pickBrowser();
  // VISIBLE, no longer headless (round 61, Will's call): he wants real Opera
  // tabs he can also touch directly, with the copilot watching the same
  // window. No startUrl by default — the seeded profile has his "continue
  // where I left off" state, so Opera brings its own tabs back.
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(os.homedir(), b.profile)}`,
    '--no-first-run',
    '--no-default-browser-check',
    // The live view streams compositor frames, and a window that is covered
    // by another app (Slate, say) normally stops compositing — the viewer
    // froze the moment the Opera window went behind anything. These keep the
    // active tab drawing even when the window is buried.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  if (startUrl) args.push(startUrl);
  const child = spawn(b.bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

// Open a fresh tab and hand back its id so the UI can select and show it.
// Raw HTTP because Chrome 136+ insists on PUT for /json/new.
export async function openTab(url = 'https://www.google.com') {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURI(url)}`, { method: 'PUT' });
  } catch {
    throw new Error(pickBrowser().name + ' is not running — launch it first.');
  }
  if (!res.ok) throw new Error('Chrome would not open a tab (HTTP ' + res.status + ').');
  const t = await res.json();
  return { id: t.id, title: t.title || '', url: t.url || url };
}

export async function listTabs() {
  const targets = await CDP.List({ port: CDP_PORT });
  return targets
    .filter((t) => t.type === 'page' && /^(https?|file):/.test(t.url))
    .map((t) => ({ id: t.id, title: t.title, url: t.url }));
}

async function getClient(targetId) {
  const cached = clients.get(targetId);
  if (cached) return cached;

  const promise = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
      let target;
      try {
        const targets = await CDP.List({ port: CDP_PORT });
        target = targets.find((t) => t.id === targetId);
      } catch (err) {
        lastErr = new Error('Chrome is not reachable on the DevTools port — it may have been closed.');
        continue;
      }
      if (!target) {
        // Retry once in case the list was mid-navigation; then report it plainly.
        lastErr = new Error('That browser tab no longer exists — it was closed. Use list_tabs to pick another tab, or ask the user.');
        if (attempt > 0) break;
        continue;
      }
      try {
        // Connect via the target's own WebSocket URL: more reliable than the id lookup.
        const client = await CDP({ target: target.webSocketDebuggerUrl, port: CDP_PORT });
        client.on('disconnect', () => clients.delete(targetId));
        await client.Runtime.enable();
        await client.Page.enable();
        return client;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Could not connect to the browser tab.');
  })();

  clients.set(targetId, promise);
  promise.catch(() => clients.delete(targetId));
  return promise;
}

async function evalInPage(targetId, expression) {
  const client = await getClient(targetId);
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'page script failed');
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// read_page: tag every interactive element with data-cc-id and return a map of
// the page — fields with labels and current values, buttons, links, page text.
// ---------------------------------------------------------------------------
const READ_PAGE_SCRIPT = `(() => {
  const SELECTOR = 'input, textarea, select, button, a[href], [contenteditable="true"], [role="button"], [role="checkbox"], [role="radio"], [role="combobox"], [role="textbox"], [role="link"]';
  if (typeof window.__ccNext !== 'number') window.__ccNext = 1;

  const visible = (el) => {
    if (el.type === 'hidden' || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };

  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return l.innerText.trim();
    }
    const wrap = el.closest('label');
    if (wrap) return wrap.innerText.trim().slice(0, 120);
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (t) return t.slice(0, 120);
    }
    return el.placeholder || el.name || el.title || '';
  };

  const items = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (!visible(el)) continue;
    if (!el.dataset.ccId) el.dataset.ccId = String(window.__ccNext++);
    const tag = el.tagName.toLowerCase();
    const item = { ccId: el.dataset.ccId, tag };
    if (tag === 'input') item.type = el.type || 'text';
    const role = el.getAttribute('role');
    if (role) item.role = role;

    if (tag === 'a') {
      item.text = (el.innerText || '').trim().slice(0, 100);
      item.href = (el.getAttribute('href') || '').slice(0, 150);
    } else if (tag === 'button' || role === 'button') {
      item.text = (el.innerText || el.value || labelFor(el)).trim().slice(0, 100);
    } else if (tag === 'select') {
      item.label = labelFor(el).slice(0, 120);
      item.value = el.selectedOptions[0] ? el.selectedOptions[0].text.trim() : '';
      item.options = [...el.options].slice(0, 15).map((o) => o.text.trim().slice(0, 60));
      if (el.options.length > 15) item.moreOptions = el.options.length - 15;
    } else if (item.type === 'checkbox' || item.type === 'radio' || role === 'checkbox' || role === 'radio') {
      item.label = labelFor(el).slice(0, 120);
      item.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
      if (item.type === 'radio') item.name = el.name || '';
    } else if (el.isContentEditable) {
      item.editable = true;
      item.label = labelFor(el).slice(0, 120);
      item.value = (el.innerText || '').trim().slice(0, 200);
    } else {
      item.label = labelFor(el).slice(0, 120);
      item.value = (el.value || '').slice(0, 200);
      if (el.required) item.required = true;
      if (el.autocomplete && el.autocomplete !== 'off') item.autocomplete = el.autocomplete;
    }
    items.push(item);
    if (items.length >= 150) break;
  }

  return JSON.stringify({
    url: location.href,
    title: document.title,
    elements: items,
    pageText: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000),
  });
})()`;

export async function readPage(targetId) {
  const json = await evalInPage(targetId, READ_PAGE_SCRIPT);
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// fill_field: set a value on the element tagged with the given ccId, using the
// native value setter + input/change events so React/Vue/Angular forms notice.
// ---------------------------------------------------------------------------
export async function fillField(targetId, ccId, value) {
  const script = `(() => {
    const el = document.querySelector('[data-cc-id="' + ${JSON.stringify(String(ccId))} + '"]');
    if (!el) return JSON.stringify({ ok: false, error: 'No element with that id. Call read_page again — ids reset when the page reloads.' });
    const value = ${JSON.stringify(String(value))};
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const tag = el.tagName.toLowerCase();

    if (tag === 'select') {
      const opt = [...el.options].find((o) => o.value === value)
        || [...el.options].find((o) => o.text.trim().toLowerCase() === value.trim().toLowerCase())
        || [...el.options].find((o) => o.text.trim().toLowerCase().includes(value.trim().toLowerCase()));
      if (!opt) return JSON.stringify({ ok: false, error: 'No option matching "' + value + '". Options: ' + [...el.options].map((o) => o.text.trim()).join(' | ').slice(0, 400) });
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true, nowValue: opt.text.trim() });
    }

    if (el.type === 'checkbox' || el.type === 'radio') {
      const want = !/^(false|no|off|unchecked|0)$/i.test(value.trim());
      if (el.checked !== want) el.click();
      return JSON.stringify({ ok: true, nowChecked: el.checked });
    }

    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return JSON.stringify({ ok: true, nowValue: el.innerText.trim().slice(0, 200) });
    }

    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return JSON.stringify({ ok: true, nowValue: el.value.slice(0, 200) });
  })()`;
  return JSON.parse(await evalInPage(targetId, script));
}

// ---------------------------------------------------------------------------
// click_element: scroll into view, then send a trusted CDP mouse click at the
// element's center; fall back to el.click() if that fails.
// ---------------------------------------------------------------------------
export async function clickElement(targetId, ccId) {
  const locate = `(() => {
    const el = document.querySelector('[data-cc-id="' + ${JSON.stringify(String(ccId))} + '"]');
    if (!el) return JSON.stringify({ ok: false, error: 'No element with that id. Call read_page again — ids reset when the page reloads.' });
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return JSON.stringify({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, text: (el.innerText || el.value || '').trim().slice(0, 80) });
  })()`;
  const pos = JSON.parse(await evalInPage(targetId, locate));
  if (!pos.ok) return pos;

  try {
    const client = await getClient(targetId);
    const base = { x: pos.x, y: pos.y, button: 'left', clickCount: 1 };
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...base, button: 'none' });
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', ...base });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', ...base });
  } catch {
    await evalInPage(
      targetId,
      `document.querySelector('[data-cc-id="' + ${JSON.stringify(String(ccId))} + '"]')?.click()`
    );
  }
  return { ok: true, clicked: pos.text };
}

export async function pressKey(targetId, key = 'Enter') {
  const client = await getClient(targetId);
  const keys = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  };
  const def = keys[key];
  if (!def) return { ok: false, error: `Unsupported key "${key}". Supported: ${Object.keys(keys).join(', ')}` };
  await client.Input.dispatchKeyEvent({ type: 'keyDown', ...def });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', ...def });
  return { ok: true, pressed: key };
}

export async function screenshot(targetId) {
  const client = await getClient(targetId);
  await client.Page.bringToFront();
  const { data } = await client.Page.captureScreenshot({ format: 'jpeg', quality: 60 });
  return data; // base64
}

// ---------------------------------------------------------------------------
// Live tab view: stream screencast frames (JPEG + the viewport's CSS size) to
// whoever is watching, and forward mouse/keyboard events back into the page so
// the preview in the UI is clickable, not just a picture.
// ---------------------------------------------------------------------------
export async function watchTab(targetId, onFrame) {
  const client = await getClient(targetId);
  // One frame handler per CDP client, shared by every watcher — registering a
  // second handler would double-ack every frame.
  if (!client.__castSubs) {
    client.__castSubs = new Set();
    client.Page.screencastFrame(({ data, metadata, sessionId }) => {
      // Chrome stops sending after a couple of unacked frames.
      client.Page.screencastFrameAck({ sessionId }).catch(() => {});
      for (const fn of client.__castSubs) {
        fn(data, { w: metadata.deviceWidth, h: metadata.deviceHeight });
      }
    });
  }
  client.__castSubs.add(onFrame);
  // Deliberately NO bringToFront here (round 62): the browser is Will's real,
  // visible Opera now, and yanking its front tab around is exactly what he
  // complained about. The view follows the active tab instead (watchActive).
  await client.Page.startScreencast({ format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    client.__castSubs.delete(onFrame);
    if (!client.__castSubs.size) client.Page.stopScreencast().catch(() => {});
  };
}

// The tab Will is actually looking at: the composited one. Only the active
// tab of a window has visibilityState "visible", and only IT produces
// screencast frames — an inactive tab is simply never drawn, no flag changes
// that. Prefers the focused window when two windows each have a visible tab.
export async function activeTabId() {
  let targets;
  try {
    targets = await CDP.List({ port: CDP_PORT });
  } catch {
    return null;
  }
  const visible = [];
  for (const t of targets.filter((x) => x.type === 'page')) {
    try {
      const client = await getClient(t.id);
      const { result } = await client.Runtime.evaluate({
        expression: '(document.visibilityState === "visible") + "|" + document.hasFocus()',
        returnByValue: true,
      });
      const [vis, focus] = String(result.value).split('|');
      if (vis === 'true') visible.push({ id: t.id, focus: focus === 'true' });
    } catch { /* mid-navigation or a target that won't answer — skip it */ }
  }
  const focused = visible.find((v) => v.focus);
  return (focused || visible[0] || {}).id || null;
}

// The viewer. Two facts drive the shape of this (both measured, 2026-09-01):
// a hidden tab NEVER produces screencast frames — no flag changes that — but
// Page.captureScreenshot on a hidden tab re-renders it and is LIVE. So:
//
//   - follow mode (default): image whatever tab is front, via screencast.
//   - pinned (a strip click): image THAT tab and leave Opera alone — smooth
//     screencast while it happens to be front, ~1fps live screenshots while
//     it is hidden. Never bringToFront: yanking Will's window around was the
//     round 62 complaint, and pinning without it is the round 63 one.
export async function watchView(onFrame, onSwitch) {
  let pinnedId = null;  // strip-pinned tab; null = follow the front tab
  let currentId = null; // the tab being imaged right now
  let mode = null;      // 'cast' (screencast) | 'shots' (screenshot loop)
  let stopCast = null;
  let shotTimer = null;
  let grabbing = false;
  let alive = true;
  let busy = false;

  const stopImaging = () => {
    if (stopCast) { stopCast(); stopCast = null; }
    if (shotTimer) { clearInterval(shotTimer); shotTimer = null; }
    mode = null;
  };

  // One live screenshot of a (possibly hidden) tab, with the viewport size
  // the UI needs to map clicks.
  const grab = async (id) => {
    if (grabbing) return;
    grabbing = true;
    try {
      const client = await getClient(id);
      const [shot, metrics] = await Promise.all([
        client.Page.captureScreenshot({ format: 'jpeg', quality: 65 }),
        client.Page.getLayoutMetrics(),
      ]);
      const v = metrics.cssLayoutViewport || metrics.layoutViewport || {};
      if (alive && id === currentId) {
        onFrame(shot.data, { w: v.clientWidth || 1200, h: v.clientHeight || 800 });
      }
    } catch { /* tab mid-navigation or closed; the next tick sorts it out */ }
    grabbing = false;
  };

  const isVisible = async (id) => {
    try {
      const client = await getClient(id);
      const { result } = await client.Runtime.evaluate({
        expression: 'document.visibilityState === "visible"', returnByValue: true,
      });
      return !!result.value;
    } catch { return false; }
  };

  const attach = async (id, visible) => {
    stopImaging();
    currentId = id;
    if (!id) { onSwitch(null, '', '', !!pinnedId); return; }
    if (visible) {
      mode = 'cast';
      stopCast = await watchTab(id, (data, meta) => { if (id === currentId) onFrame(data, meta); });
    } else {
      mode = 'shots';
      await grab(id);
      shotTimer = setInterval(() => { if (alive) grab(id); }, 800);
    }
    let title = '', url = '';
    try {
      const t = (await CDP.List({ port: CDP_PORT })).find((x) => x.id === id);
      if (t) { title = t.title || ''; url = t.url || ''; }
    } catch { /* name is a nicety */ }
    onSwitch(id, title, url, !!pinnedId);
  };

  const tick = async () => {
    if (!alive || busy) return;
    busy = true;
    try {
      // A pinned tab that has been closed falls back to following.
      if (pinnedId) {
        const targets = await CDP.List({ port: CDP_PORT });
        if (!targets.some((t) => t.id === pinnedId)) pinnedId = null;
      }
      const wantId = pinnedId || await activeTabId();
      const visible = wantId ? await isVisible(wantId) : false;
      const wantMode = visible ? 'cast' : 'shots';
      if (alive && wantId && (wantId !== currentId || wantMode !== mode)) {
        await attach(wantId, visible);
      }
    } catch { /* browser gone; frames just stop and the UI says so */ }
    busy = false;
  };

  await tick();
  const timer = setInterval(tick, 900);

  return {
    current: () => currentId,
    // Strip click: show this tab, wherever it is. Opera is not touched.
    async pin(id) {
      pinnedId = id || null;
      await tick();
    },
    // The Follow pill: back to mirroring the front tab.
    async follow() {
      pinnedId = null;
      await tick();
    },
    stop() {
      alive = false;
      clearInterval(timer);
      stopImaging();
    },
  };
}

const PAGE_KEY_DEFS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

// Events arrive from the live view already mapped to page CSS pixels.
// Anything unrecognized is dropped, not guessed at.
export async function sendInput(targetId, ev = {}) {
  const client = await getClient(targetId);
  if (ev.kind === 'mouse' && ['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(ev.type)) {
    await client.Input.dispatchMouseEvent({
      type: ev.type,
      x: Number(ev.x) || 0,
      y: Number(ev.y) || 0,
      button: ev.button === 'left' ? 'left' : 'none',
      buttons: Number(ev.buttons) || 0,
      clickCount: Math.min(Number(ev.clickCount) || 0, 3),
      deltaX: Number(ev.deltaX) || 0,
      deltaY: Number(ev.deltaY) || 0,
    });
  } else if (ev.kind === 'char' && typeof ev.text === 'string' && ev.text) {
    await client.Input.insertText({ text: ev.text.slice(0, 8) });
  } else if (ev.kind === 'key' && PAGE_KEY_DEFS[ev.key]) {
    const def = PAGE_KEY_DEFS[ev.key];
    await client.Input.dispatchKeyEvent({ type: 'keyDown', ...def });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', ...def });
  }
  return { ok: true };
}

export async function navigate(targetId, url) {
  const client = await getClient(targetId);
  await client.Page.navigate({ url });
  // Wait for the load event, but don't hang forever on slow pages.
  await Promise.race([
    client.Page.loadEventFired(),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
  return { ok: true, url };
}
