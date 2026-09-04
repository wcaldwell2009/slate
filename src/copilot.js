'use strict';

// Browser Copilot is Will's OTHER project — a chat that reads and fills in his
// Chrome tabs — and it stays its own program, in its own folder, with its own
// dependencies and its own server on its own port. Slate does not absorb it:
// pulling it in would take npm packages Slate deliberately does not have. This
// file only knows how to find it, ask whether it is up, and start it; the
// Copilot tab then just points an iframe at it.
//
// Deliberately a bystander to the rest of Slate, the same way marks.js is:
// nothing here touches the database or anything a student typed, and a smoke
// test greps this file to keep it that way.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Env overrides exist for the harnesses (and for the Windows machine, where
// the folder will live somewhere else if it ever comes over).
// Since 2026-09-04 the copilot lives INSIDE this repo (browser-copilot/,
// brought in with its history) so one clone carries both. The old Desktop
// folder is kept as a fallback for a machine that still has it there.
function copilotDir() {
  if (process.env.SLATE_COPILOT_DIR) return process.env.SLATE_COPILOT_DIR;
  const candidates = [
    path.join(__dirname, '..', 'browser-copilot'),
    path.join(os.homedir(), 'Desktop', 'School Tracker', 'browser-copilot'),
    path.join(os.homedir(), 'Desktop', 'Browser Copilot', 'browser-copilot'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'server.js'))) return c; } catch { /* keep looking */ }
  }
  return candidates[0];
}
function copilotUrl() {
  return (process.env.SLATE_COPILOT_URL || 'http://localhost:4321').replace(/\/+$/, '');
}

function isInstalled() {
  return fs.existsSync(path.join(copilotDir(), 'server.js'));
}

// A dead port answers "no" in well under a second; the timeout is for a port
// something unrelated is sitting on that never answers HTTP.
async function isUp() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(copilotUrl() + '/api/status', { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function status() {
  return { installed: isInstalled(), running: await isUp(), url: copilotUrl() };
}

// Start the copilot's own server and wait for it to come up. Spawned with
// Slate's own node (process.execPath) because node is not necessarily on the
// PATH of whatever launched Slate — the same reason launch.js exists.
async function start() {
  if (await isUp()) return { ok: true, running: true, url: copilotUrl() };
  if (!isInstalled()) {
    return { ok: false, error: 'Browser Copilot is not on this computer — Slate looked in ' + copilotDir() + '.' };
  }
  // The harnesses set SLATE_OPEN=0 so that clicking every button in a sweep
  // never actually launches other programs. Same switch openOnComputer honors.
  if (process.env.SLATE_OPEN === '0') {
    return { ok: false, error: 'Starting other apps is switched off here.' };
  }
  const port = new URL(copilotUrl()).port || '80';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: copilotDir(),
    env: { ...process.env, PORT: port },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isUp()) return { ok: true, running: true, url: copilotUrl() };
  }
  return { ok: false, error: 'Browser Copilot did not come up. Try starting it yourself: npm start in its folder.' };
}

module.exports = { status, start, isUp, isInstalled, copilotDir, copilotUrl };
