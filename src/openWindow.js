'use strict';

// Opens Slate in a browser window.
//
// The installed copy asks for an "app window" — a Chromium window with no
// address bar and no tab strip, which is what makes it feel like a desktop app
// instead of a website. The workshop copy just opens a normal tab.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function findAppBrowser() {
  const e = process.env;
  const candidates = [
    [e['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
    [e.ProgramFiles, 'Microsoft\\Edge\\Application\\msedge.exe'],
    [e.ProgramFiles, 'Google\\Chrome\\Application\\chrome.exe'],
    [e['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'],
    [e.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'],
  ];
  for (const [base, rel] of candidates) {
    if (!base) continue;
    const p = path.join(base, rel);
    try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

function openWindow(url, { appWindow = false } = {}) {
  if (process.env.SLATE_OPEN === '0') return;
  try {
    if (appWindow && process.platform === 'win32') {
      const browser = findAppBrowser();
      if (browser) {
        spawn(browser, [`--app=${url}`, '--window-size=1360,900'], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
    }
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' });
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  } catch { /* opening the browser is best-effort */ }
}

module.exports = { openWindow, findAppBrowser };
