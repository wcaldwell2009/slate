'use strict';

// Full-app drive: boots throwaway servers and walks the whole app.
//
//   npm run drive        -> API + UI phases (fast, no Claude calls)
//   npm run drive:all    -> the above plus the live Claude Code phase
//   npm run drive:loop   -> run, then re-run automatically on every code change
//                           until the whole sweep comes back clean
//
// Phases:
//   api  every HTTP endpoint the UI can reach, plus edge cases and bad input
//   ui   the REAL public/app.js executed against a DOM shim — every view
//        rendered and every button/input/checkbox actually clicked
//   ai   the four AI features against the real hidden `claude -p` terminal
//        (needs Claude Code installed and logged in; takes ~45s)
//
// Everything runs against a temp database and a temp "Desktop", so it never
// touches Will's real data or drops files on his actual Desktop.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');

const ROOT = path.join(__dirname, '..', '..');
const WITH_AI = process.argv.includes('--ai') || process.argv.includes('--all');
const WATCH = process.argv.includes('--watch') || process.argv.includes('--loop');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-drive-'));

// Grab a port the OS says is free, so two sweeps running at once (a watch loop
// plus a manual run, say) can never boot onto each other's server and corrupt
// each other's data — which fails in a very confusing way when it happens.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startServer(port, dir, noAi) {
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      CANVAS_MODE: 'mock',
      SLATE_AI_CHECK_FAKE: '1',  // the AI checker must never reach the real service
      SLATE_OPEN: '0',
      SLATE_DB_PATH: path.join(dir, 'drive.db'),
      SLATE_DATA_DIR: dir,    // notes + downloaded attachments stay in the temp dir
      SLATE_NO_AUTOSYNC: '1', // no background sync moving data under the checks
      SLATE_DESKTOP_DIR: dir,
      ...(noAi ? { SLATE_NO_AI: '1' } : {}),
    },
    stdio: 'ignore',
  });
  return child;
}

async function waitUntilReady(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`);
      const j = await r.json();
      if (j.last_sync) return true;         // seeded and serving
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server on ${port} never became ready`);
}

function runPhase(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code));
  });
}

async function sweep(round) {
  const phases = [
    { name: 'api', script: 'api.js', noAi: true },
    { name: 'ui', script: 'ui.js', noAi: true },
  ];
  if (WITH_AI) phases.push({ name: 'ai', script: 'ai.js', noAi: false });

  const results = [];
  for (const p of phases) {
    const dir = path.join(TMP, `${round}-${p.name}`);
    console.log(`\n##################### ${p.name.toUpperCase()} PHASE #####################`);
    const port = await freePort();
    const server = startServer(port, dir, p.noAi);
    let code = 1;
    try {
      await waitUntilReady(port);
      const base = `http://127.0.0.1:${port}`;
      const args = p.name === 'api' ? [base, dir, ROOT] : [base, ROOT];
      code = await runPhase(p.script, args);
    } catch (err) {
      console.error('  phase could not start:', err.message);
    } finally {
      server.kill();
    }
    results.push({ name: p.name, code });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }

  console.log('\n##################### SUMMARY #####################');
  for (const r of results) console.log(`  ${r.name.padEnd(4)} ${r.code === 0 ? 'PASS' : 'FAIL'}`);
  if (!WITH_AI) console.log('  (live Claude phase skipped — use `npm run drive:all` to include it)');
  return results.every((r) => r.code === 0);
}

// Re-run whenever the app changes. The checks are deterministic, so repeating
// them unchanged proves nothing — a code edit is the only thing that can turn a
// FAIL into a PASS, which is exactly what this waits for.
const WATCH_PATHS = ['src', 'public', 'server.js', 'test'];
function watchForChanges(onChange) {
  const watchers = [];
  let timer = null;
  const fire = (file) => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(file), 300); // debounce editor save bursts
  };
  for (const rel of WATCH_PATHS) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    try {
      watchers.push(fs.watch(full, { recursive: fs.statSync(full).isDirectory() }, (_e, f) => {
        if (!f || /\.(js|css|html|txt|json)$/i.test(f)) fire(f || rel);
      }));
    } catch { /* some platforms refuse recursive watches */ }
  }
  return watchers;
}

(async () => {
  let round = 1;
  let clean = await sweep(round);

  if (!WATCH) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
    process.exit(clean ? 0 : 1);
  }

  if (clean) {
    console.log('\n  Everything passed. Watching for changes — edit any file and the whole');
    console.log('  sweep re-runs on its own. Ctrl+C to stop.');
  } else {
    console.log('\n  Something failed. Fix it and save — the sweep re-runs on its own.');
    console.log('  Ctrl+C to stop.');
  }

  let running = false;
  watchForChanges(async (file) => {
    if (running) return;
    running = true;
    round += 1;
    console.log(`\n\n>>> ${file} changed — round ${round} <<<`);
    clean = await sweep(round);
    console.log(clean
      ? '\n  Clean. Still watching — Ctrl+C to stop.'
      : '\n  Still failing. Fix and save to try again — Ctrl+C to stop.');
    running = false;
  });
})();
