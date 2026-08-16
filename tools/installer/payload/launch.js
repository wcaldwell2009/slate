'use strict';

// The installed Slate's entry point. Lives at the install root, so __dirname is
// %LOCALAPPDATA%\Slate — everything else is worked out from there. Started
// hidden by Slate.vbs, which is what the Desktop shortcut points at.
//
// Layout:
//   <home>\app\           the snapshot the installer laid down (replaced on update)
//   <home>\data\          slate.db, notes  (never touched by an update)
//   <home>\.env           Canvas token     (never touched by an update)
//   <home>\slate-log.txt  what happened last time it started
//
// Because it runs hidden there is no console to print to, so anything worth
// knowing goes in the log, and anything fatal gets a message box — otherwise a
// failed start is indistinguishable from the icon doing nothing.

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const HOME = __dirname;
const APP = path.join(HOME, 'app');
const LOG = path.join(HOME, 'slate-log.txt');
const PORT = Number(process.env.SLATE_PORT || 4174);
const URL = `http://localhost:${PORT}`;

process.env.SLATE_HOME = HOME;
process.env.SLATE_DATA_DIR = path.join(HOME, 'data');
process.env.SLATE_INSTALLED = '1';
process.env.SLATE_APP_WINDOW = '1';
process.env.PORT = String(PORT);

// ---- logging -------------------------------------------------------------
// One run per file, not an ever-growing log — the only version anyone wants is
// the one from the time it just broke.
try { fs.writeFileSync(LOG, `Slate starting ${new Date().toISOString()}\n`); } catch { /* no log, carry on */ }
function log(...parts) {
  const line = parts.join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* best effort */ }
}
for (const stream of ['log', 'error', 'warn']) {
  const original = console[stream].bind(console);
  console[stream] = (...args) => { log(...args.map(String)); original(...args); };
}

// ---- telling Will something went wrong -----------------------------------
// mshta ships with Windows, so this needs nothing installed.
function alert(message) {
  if (process.platform !== 'win32') return;
  const text = String(message).replace(/[\\'"\r\n]/g, ' ').slice(0, 400);
  try {
    spawn('mshta.exe', [
      `javascript:new ActiveXObject('WScript.Shell')`
      + `.Popup('${text}\\n\\nDetails are in:\\n${LOG.replace(/\\/g, '\\\\')}', 0, 'Slate', 16);close()`,
    ], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* if even this fails there is nothing left to try */ }
}

function die(err) {
  log('FATAL:', err && err.stack ? err.stack : String(err));
  alert("Slate couldn't start.");
  process.exit(1);
}

process.on('uncaughtException', die);
process.on('unhandledRejection', die);
process.on('slate:fatal', die);

// ---- start ---------------------------------------------------------------
// Is Slate already up? Double-clicking the icon a second time should bring the
// window back, not fail on a port that is already taken.
function alreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/status`, { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

if (!fs.existsSync(path.join(APP, 'server.js'))) {
  log('app folder missing at', APP);
  alert('Slate is not installed properly. Run "Install Slate" again.');
  process.exit(1);
}

function startServer() {
  // Run from inside the app folder so the hidden `claude -p` calls and any
  // relative paths resolve the same way they do in the workshop copy.
  process.chdir(APP);
  require(path.join(APP, 'server.js'));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

alreadyRunning().then(async (up) => {
  if (!up) return startServer();

  log('already running — reopening the window');
  require(path.join(APP, 'src', 'openWindow')).openWindow(URL, { appWindow: true });

  // It might have been a server on its way out — Quit then straight back in.
  // If it really is gone a moment later, this launch takes over instead of
  // leaving Will looking at a window that can't reach anything.
  await wait(2000);
  if (!(await alreadyRunning())) {
    log('the copy that answered has gone — starting a fresh one');
    startServer();
  }
});
