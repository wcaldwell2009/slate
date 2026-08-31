// Chrome DevTools Protocol layer: tab listing, page reading, filling, clicking, screenshots.
import CDP from 'chrome-remote-interface';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const CDP_PORT = 9222;
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Chrome 136+ refuses --remote-debugging-port on the default profile, so we use a dedicated one.
const PROFILE_DIR = path.join(os.homedir(), '.browser-copilot-chrome');

const clients = new Map(); // targetId -> Promise<CDP client> (promise-cached so concurrent chats share one connection)

export async function isChromeUp() {
  try {
    await CDP.Version({ port: CDP_PORT });
    return true;
  } catch {
    return false;
  }
}

export function launchChrome(startUrl = 'https://www.google.com') {
  const child = spawn(
    CHROME_BIN,
    [
      // Invisible on purpose (Will's choice): no Chrome window anywhere — the
      // clickable live view in the UI is the only place these tabs appear.
      // Same profile as before, so saved logins carry over. If a picky site
      // fights the windowless browser, launch by hand without --headless=new
      // (see the README) and everything else works the same.
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      startUrl,
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
}

// Open a fresh tab and hand back its id so the UI can select and show it.
// Raw HTTP because Chrome 136+ insists on PUT for /json/new.
export async function openTab(url = 'https://www.google.com') {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURI(url)}`, { method: 'PUT' });
  } catch {
    throw new Error('Chrome is not running — launch it first.');
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
  // A background tab doesn't repaint, so no frames would come. Foreground it
  // once at the start; harmless in headless.
  try { await client.Page.bringToFront(); } catch { /* fine */ }
  await client.Page.startScreencast({ format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    client.__castSubs.delete(onFrame);
    if (!client.__castSubs.size) client.Page.stopScreencast().catch(() => {});
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
