// Live check that the copilot does not forget. THROWAWAY server, temp chats /
// docs / memory / settings — never Will's real ones. No browser needed.
//
// 1. Chat A: attach a file with a random code in it, ask Claude to keep it in
//    mind for a named project.
// 2. Kill the server and start a fresh one on the same folders (what an
//    update, a reboot or the 3-hour idle reaper does to a session).
// 3. Chat A again: "what was the code?" — must come back, and the chat file
//    must hold the session id + the attachment path.
// 4. A NEW chat B: "what's the code for <project>?" — must come back through
//    the shared project memory.
// RIG_MODEL (default haiku). ~10-20c.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-rig-'));
const deadCdp = await freePort(); // nothing listens: no browser in this test
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ model: process.env.RIG_MODEL || 'haiku' }));
const CODE = 'ZEBRA-' + Math.floor(1000 + Math.random() * 9000);
const PROJECT = 'Rig Lab 9.9';

let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

async function boot() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), COPILOT_CDP_PORT: String(deadCdp), COPILOT_CHATS_DIR: path.join(tmp, 'chats'), COPILOT_DOCS_DIR: path.join(tmp, 'docs'), COPILOT_DESKTOP_DIR: path.join(tmp, 'Desktop'), COPILOT_SETTINGS: path.join(tmp, 'settings.json'), COPILOT_MEMORY: path.join(tmp, 'memory.json') };
  for (const k of Object.keys(env)) if (/^CLAUDE/.test(k)) delete env[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (d) => process.stdout.write('[server!] ' + d));
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 300)); try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) break; } catch {} }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  return { port, child, ws };
}

function turn(ws, chatId, text, attachments) {
  const events = [];
  return new Promise((resolve) => {
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (m.chatId !== chatId) return;
      events.push(m);
      if (m.type === 'tool') console.log('  tool:', m.name, JSON.stringify(m.input).slice(0, 120));
      if (m.type === 'text') console.log('  claude:', m.text.slice(0, 240).replace(/\n/g, ' '));
      if (m.type === 'turn_done') { ws.off('message', onMsg); resolve({ done: m, events, text: events.filter((e) => e.type === 'text').map((e) => e.text).join('\n') }); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'chat', chatId, text, attachments }));
    setTimeout(() => { ws.off('message', onMsg); resolve({ done: { timeout: true }, events, text: '' }); }, 240000);
  });
}

let srv;
try {
  srv = await boot();
  const up = await fetch(`http://127.0.0.1:${srv.port}/api/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'rig lab sheet.txt', content_base64: Buffer.from(`Rig Lab 9.9 worksheet\nAccess code: ${CODE}\nQ1. What port does HTTPS use?\n`).toString('base64') }),
  }).then((r) => r.json());
  const t1 = await turn(srv.ws, 'chata', `Read this sheet and keep it in mind — it's for my ${PROJECT} project. I'll ask about it later. Just say ok when done.`, [up.path]);
  check('turn 1 finished', t1.done.ok === true);
  const chatFile = JSON.parse(fs.readFileSync(path.join(tmp, 'chats', 'chata.json'), 'utf8'));
  check('chat file has the session id', !!chatFile.sessionId, chatFile.sessionId || '');
  check('chat file kept the attachment path', chatFile.messages.some((m) => (m.attachments || []).includes(up.path)));

  // ---- restart: what killed his sessions every day -------------------------
  srv.ws.close(); srv.child.kill(); await new Promise((r) => setTimeout(r, 1000));
  srv = await boot();
  const t2 = await turn(srv.ws, 'chata', 'What was the access code on that sheet? Answer with just the code.');
  check('after a restart, the same chat still knows the code', t2.text.includes(CODE), t2.text.slice(0, 120));
  const tools2 = t2.events.filter((e) => e.type === 'tool').map((e) => e.name);
  check('…without re-reading the file (the session was resumed)', !tools2.includes('read_file'), tools2.join(',') || 'no tools');

  // ---- a brand-new chat ----------------------------------------------------
  const t3 = await turn(srv.ws, 'chatb', `What's the access code for my ${PROJECT} project? Answer with just the code.`);
  check('a NEW chat knows the project', t3.text.includes(CODE), t3.text.slice(0, 120));
  const mem = fs.existsSync(path.join(tmp, 'memory.json')) ? fs.readFileSync(path.join(tmp, 'memory.json'), 'utf8') : '';
  check('the project is in the shared memory file', /Rig Lab 9\.9/i.test(mem));

  // ---- no "remember" at all: a file in one chat, asked about in another ---
  const CODE2 = 'OTTER-' + Math.floor(1000 + Math.random() * 9000);
  const up2 = await fetch(`http://127.0.0.1:${srv.port}/api/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'Marine Bio packet.txt', content_base64: Buffer.from(`Marine Bio field packet\nTeacher code: ${CODE2}\n`).toString('base64') }),
  }).then((r) => r.json());
  const t4 = await turn(srv.ws, 'chatc', 'What class is this packet for? One word.', [up2.path]);
  check('turn 4 finished', t4.done.ok === true);
  const t5 = await turn(srv.ws, 'chatd', 'What was the teacher code in the marine bio packet I sent you the other day? Just the code.');
  check('a different chat finds a file it was never told to remember', t5.text.includes(CODE2), t5.text.slice(0, 120));
} finally {
  try { srv?.ws.close(); srv?.child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  // The SDK saved this rig's sessions beside Will's real ones; take ours out.
  const sessDir = path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/[^a-zA-Z0-9]/g, '-'));
  try {
    for (const f of fs.readdirSync(path.join(tmp, 'chats'))) {
      const id = JSON.parse(fs.readFileSync(path.join(tmp, 'chats', f), 'utf8')).sessionId;
      if (id) fs.rmSync(path.join(sessDir, id + '.jsonl'), { force: true });
    }
  } catch { /* nothing saved */ }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
