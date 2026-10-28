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
// The browser program itself — the PDF maker runs a separate, hidden copy
// of it (own profile, own port) so it never touches the window Will uses.
export function browserBinary() {
  return pickBrowser().bin;
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

// Where "save it to my Desktop" lands. Overridable so a test never writes to
// the real Desktop.
export const DESKTOP_DIR = process.env.COPILOT_DESKTOP_DIR
  || process.env.SLATE_DESKTOP_DIR
  || path.join(os.homedir(), 'Desktop');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

// A file name for a saved shot: the caller's name if given, else the tab's
// title, flattened to a plain basename (no separators, no dotfiles) and
// numbered rather than overwritten if it already exists.
function shotPath(title, name) {
  let base = String(name || '').trim();
  if (!base) base = `Screenshot ${String(title || '').trim().slice(0, 60) || 'tab'} ${stamp()}`;
  base = base.replace(/\.png$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Screenshot';
  fs.mkdirSync(DESKTOP_DIR, { recursive: true });
  let file = path.join(DESKTOP_DIR, base + '.png');
  for (let n = 2; fs.existsSync(file); n++) file = path.join(DESKTOP_DIR, `${base} (${n}).png`);
  return file;
}

// The viewport in CSS pixels plus the device pixel ratio — the numbers every
// coordinate tool needs to agree on.
async function viewportOf(client) {
  const metrics = await client.Page.getLayoutMetrics();
  const v = metrics.cssLayoutViewport || metrics.layoutViewport || {};
  let dpr = 1;
  try {
    const { result } = await client.Runtime.evaluate({ expression: 'window.devicePixelRatio', returnByValue: true });
    dpr = Number(result.value) || 1;
  } catch { /* 1 is a fine guess */ }
  return { w: v.clientWidth || 1200, h: v.clientHeight || 800, dpr };
}

// Screenshot of a tab, WITHOUT bringing it to front — captureScreenshot
// re-renders a hidden tab on demand (round 64), and yanking Will's Opera
// window around is the round 62 complaint.
//
// The image handed to the model is captured at CSS-pixel size (the clip
// scale undoes the device pixel ratio), so a point the model picks on the
// picture IS the page coordinate click_at wants — no conversion, no off-by-
// two-on-a-retina-screen. `save` also writes a full-resolution PNG to the
// Desktop and returns its path.
export async function screenshot(targetId, { save = false, name = '' } = {}) {
  const client = await getClient(targetId);
  const vp = await viewportOf(client);
  const clip = { x: 0, y: 0, width: vp.w, height: vp.h, scale: 1 / vp.dpr };
  const { data } = await client.Page.captureScreenshot({ format: 'jpeg', quality: 70, clip });
  const out = { image: data, width: vp.w, height: vp.h };
  if (save) {
    const png = await client.Page.captureScreenshot({ format: 'png' });
    let title = '';
    try { title = ((await CDP.List({ port: CDP_PORT })).find((t) => t.id === targetId) || {}).title || ''; } catch { /* name only */ }
    const file = shotPath(title, name);
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    out.savedTo = file;
  }
  return out;
}

// A picture of (part of) a tab for putting INTO a document — full
// resolution PNG bytes, not the model's working screenshot. `region` is in
// the same viewport coordinates as screenshot() (x, y, width, height read
// straight off that image); `fullPage` takes the whole scrollable page;
// neither = the visible screen.
export async function captureImage(targetId, { region = null, fullPage = false } = {}) {
  const client = await getClient(targetId);
  const vp = await viewportOf(client);
  let clip;
  if (fullPage) {
    const m = await client.Page.getLayoutMetrics();
    const size = m.cssContentSize || m.contentSize;
    clip = { x: 0, y: 0, width: Math.min(size.width, 4000), height: Math.min(size.height, 12000), scale: 1 };
  } else {
    // Viewport coords → document coords: captureScreenshot's clip is
    // measured from the top of the document, not the visible screen.
    const { result } = await client.Runtime.evaluate({ expression: 'JSON.stringify([scrollX, scrollY])', returnByValue: true });
    const [sx, sy] = JSON.parse(result.value || '[0,0]');
    const r = region || { x: 0, y: 0, width: vp.w, height: vp.h };
    const x = Math.max(0, Number(r.x) || 0);
    const y = Math.max(0, Number(r.y) || 0);
    const width = Math.max(1, Math.min(Number(r.width) || vp.w, vp.w - x));
    const height = Math.max(1, Math.min(Number(r.height) || vp.h, vp.h - y));
    clip = { x: x + sx, y: y + sy, width, height, scale: 1 };
  }
  const shot = await client.Page.captureScreenshot({
    format: 'png', clip, captureBeyondViewport: !!fullPage,
  });
  return { png: Buffer.from(shot.data, 'base64'), width: Math.round(clip.width), height: Math.round(clip.height) };
}

// ---------------------------------------------------------------------------
// Pixel-level control, for pages that are just a picture: a remote desktop
// gateway (Guacamole, noVNC), a game, a drawing app, a PDF viewer. Those draw
// into a <canvas> and listen for real mouse/keyboard events on it, so there is
// nothing for read_page to find and nothing for fill_field to set. CDP input
// events go through the browser's own event pipeline — the canvas's listeners
// fire exactly as they do for a human — and the page forwards them wherever it
// forwards a human's (a WebSocket to the gateway, in the remote-desktop case).
// Coordinates are page CSS pixels, 1:1 with the screenshot() image.
// ---------------------------------------------------------------------------
const MOD_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 };

function modifierMask(mods = []) {
  let m = 0;
  for (const name of mods) m |= MOD_BITS[String(name).toLowerCase()] || 0;
  return m;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampPoint(vp, x, y) {
  return {
    x: Math.max(0, Math.min(vp.w - 1, Math.round(Number(x) || 0))),
    y: Math.max(0, Math.min(vp.h - 1, Math.round(Number(y) || 0))),
  };
}

export async function moveMouse(targetId, x, y) {
  const client = await getClient(targetId);
  const p = clampPoint(await viewportOf(client), x, y);
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...p, button: 'none' });
  return { ok: true, at: p };
}

export async function clickAt(targetId, x, y, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
  const client = await getClient(targetId);
  const p = clampPoint(await viewportOf(client), x, y);
  const btn = ['left', 'right', 'middle'].includes(button) ? button : 'left';
  const count = Math.max(1, Math.min(3, Number(clickCount) || 1));
  const mods = modifierMask(modifiers);
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...p, button: 'none', modifiers: mods });
  // A double click is two full presses with clickCount 1 then 2 — that is
  // how the browser counts them, and what a page's dblclick listener expects.
  for (let c = 1; c <= count; c++) {
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', ...p, button: btn, clickCount: c, modifiers: mods });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', ...p, button: btn, clickCount: c, modifiers: mods });
    if (c < count) await sleep(60);
  }
  return { ok: true, clicked: { ...p, button: btn, clickCount: count } };
}

// Press at one point, move in steps, release at another — for selecting text
// on a remote desktop, dragging a window, or drawing.
export async function drag(targetId, x1, y1, x2, y2, { button = 'left', steps = 12 } = {}) {
  const client = await getClient(targetId);
  const vp = await viewportOf(client);
  const a = clampPoint(vp, x1, y1);
  const b = clampPoint(vp, x2, y2);
  const btn = ['left', 'right', 'middle'].includes(button) ? button : 'left';
  const buttons = btn === 'left' ? 1 : btn === 'right' ? 2 : 4;
  const n = Math.max(2, Math.min(60, Number(steps) || 12));
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...a, button: 'none' });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', ...a, button: btn, clickCount: 1 });
  for (let i = 1; i <= n; i++) {
    const x = Math.round(a.x + ((b.x - a.x) * i) / n);
    const y = Math.round(a.y + ((b.y - a.y) * i) / n);
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: btn, buttons });
    await sleep(15);
  }
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', ...b, button: btn, clickCount: 1 });
  return { ok: true, from: a, to: b };
}

export async function scrollAt(targetId, x, y, { deltaX = 0, deltaY = 0 } = {}) {
  const client = await getClient(targetId);
  const p = clampPoint(await viewportOf(client), x, y);
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...p, button: 'none' });
  await client.Input.dispatchMouseEvent({
    type: 'mouseWheel', ...p, button: 'none',
    deltaX: Math.max(-2000, Math.min(2000, Number(deltaX) || 0)),
    deltaY: Math.max(-2000, Math.min(2000, Number(deltaY) || 0)),
  });
  return { ok: true, at: p, deltaX, deltaY };
}

// Named keys (US layout). `key` is what the page's KeyboardEvent.key says,
// `code` its physical key, `vk` the Windows virtual key code that noVNC /
// Guacamole and every keysym table map from.
const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', vk: 20 },
  PrintScreen: { key: 'PrintScreen', code: 'PrintScreen', vk: 44 },
  ContextMenu: { key: 'ContextMenu', code: 'ContextMenu', vk: 93 },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
  Control: { key: 'Control', code: 'ControlLeft', vk: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS['F' + i] = { key: 'F' + i, code: 'F' + i, vk: 111 + i };
const KEY_ALIASES = {
  return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', spacebar: 'Space',
  backspace: 'Backspace', del: 'Delete', delete: 'Delete', ins: 'Insert', insert: 'Insert',
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
  arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
  home: 'Home', end: 'End', pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
  capslock: 'CapsLock', printscreen: 'PrintScreen', contextmenu: 'ContextMenu', menu: 'ContextMenu',
  shift: 'Shift', control: 'Control', ctrl: 'Control', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', windows: 'Meta',
};
const MODIFIER_NAMES = ['Shift', 'Control', 'Alt', 'Meta'];

// Shifted US-keyboard symbols → the unshifted key they live on.
const SHIFTED = { '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
const PUNCT_CODES = { '`': ['Backquote', 192], '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], ' ': ['Space', 32] };

// One printable character → a full key definition, or null if it is not on
// a US keyboard (those go through insertText instead).
function charKey(ch) {
  if (ch === '\n' || ch === '\r') return { ...NAMED_KEYS.Enter, modifiers: 0 };
  if (ch === '\t') return { ...NAMED_KEYS.Tab, modifiers: 0 };
  if (/^[a-z]$/.test(ch)) return { key: ch, code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), text: ch, modifiers: 0 };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: 'Key' + ch, vk: ch.charCodeAt(0), text: ch, modifiers: 8 };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, vk: ch.charCodeAt(0), text: ch, modifiers: 0 };
  const base = SHIFTED[ch];
  if (base !== undefined) {
    const d = /^[0-9]$/.test(base) ? ['Digit' + base, base.charCodeAt(0)] : PUNCT_CODES[base];
    return d ? { key: ch, code: d[0], vk: d[1], text: ch, modifiers: 8 } : null;
  }
  const d = PUNCT_CODES[ch];
  return d ? { key: ch, code: d[0], vk: d[1], text: ch, modifiers: 0 } : null;
}

async function tapKey(client, def, modifiers = 0) {
  const ev = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers };
  // A keyDown carrying `text` also produces the keypress/char the page sees
  // when a real key is struck; a modifier-only combination (ctrl+c) carries
  // none, exactly like a real keyboard.
  const withText = def.text && !(modifiers & ~8);
  await client.Input.dispatchKeyEvent({ type: withText ? 'keyDown' : 'rawKeyDown', ...ev, ...(withText ? { text: def.text, unmodifiedText: def.text } : {}) });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', ...ev });
}

// Type text as REAL KEYSTROKES — keydown/keypress/keyup per character — so a
// canvas that listens for keys (a remote desktop, a terminal emulator, a game)
// receives them. insertText, which fill_field relies on, never fires those:
// it only tells an editable element to insert, and a canvas is not one.
// Characters that are not on a US keyboard still go through insertText.
export async function typeText(targetId, text, { delayMs = 12 } = {}) {
  const client = await getClient(targetId);
  const s = String(text ?? '');
  let typed = 0;
  let inserted = 0;
  for (const ch of s) {
    const def = charKey(ch);
    if (def) {
      await tapKey(client, def, def.modifiers);
      typed++;
    } else {
      await client.Input.insertText({ text: ch });
      inserted++;
    }
    if (delayMs) await sleep(Math.min(200, delayMs));
  }
  return { ok: true, typed: [...s].length, keystrokes: typed, insertedDirectly: inserted };
}

// "ctrl+c", "Enter", "shift+Tab", "alt+F4", "ctrl+alt+Delete", "meta+a"…
// Modifier keys are pressed first and released after, in order, the way a
// hand does it.
export async function pressKeys(targetId, combo) {
  const client = await getClient(targetId);
  const parts = String(combo || '').split('+').map((p) => p.trim()).filter(Boolean);
  // "shift++" — a literal plus sign after a modifier.
  if (/\+\s*$/.test(String(combo || '')) && parts.length) parts.push('+');
  if (!parts.length) throw new Error('No key given.');
  const mods = [];
  let main = null;
  parts.forEach((part, i) => {
    const alias = KEY_ALIASES[part.toLowerCase()];
    const isLast = i === parts.length - 1;
    if (alias && MODIFIER_NAMES.includes(alias) && !isLast) {
      mods.push(alias);
      return;
    }
    if (main) throw new Error(`Only one non-modifier key per press: "${combo}".`);
    if (alias) main = NAMED_KEYS[alias];
    else if (NAMED_KEYS[part]) main = NAMED_KEYS[part];
    else if ([...part].length === 1) main = charKey(part);
    if (!main) throw new Error(`Unknown key "${part}". Use a single character, or one of: ${Object.keys(NAMED_KEYS).join(', ')}.`);
  });
  let mask = modifierMask(mods);
  if (main.modifiers) mask |= main.modifiers;
  const modDefs = mods.map((m) => NAMED_KEYS[m]);
  let held = 0;
  for (const d of modDefs) {
    held |= modifierMask([d.key]);
    await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk, modifiers: held });
  }
  await tapKey(client, main, mask);
  for (const d of modDefs.reverse()) {
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk, modifiers: held });
    held &= ~modifierMask([d.key]);
  }
  return { ok: true, pressed: [...mods, main.key === ' ' ? 'Space' : main.key].join('+') };
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
