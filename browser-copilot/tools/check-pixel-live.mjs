// npm run check:pixel:live — one live Claude turn (haiku, ~15 cents) through
// a THROWAWAY copilot server wired to a
// throwaway headless browser: a canvas page standing in for a remote desktop.
// Nothing here touches the real copilot (4321) or the real Opera (9222).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import CDP from 'chrome-remote-interface';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-rig-'));
const desktop = path.join(tmp, 'Desktop');
const cdpPort = await freePort(), webPort = await freePort(), appPort = await freePort();
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ model: 'haiku' }));

// A "remote desktop": a canvas with a fake login box drawn on it. Clicks and
// keys are recorded, and typed text is drawn into the box so a screenshot
// shows the result — just like a real remote screen would.
const PAGE = `<!doctype html><title>Remote Lab (rig)</title>
<body style="margin:0;background:#222"><canvas id=c tabindex=0 width=900 height=600 style="display:block"></canvas>
<script>
const c=document.getElementById('c'), ctx=c.getContext('2d');
window.log=[]; let typed='', focused=false;
const box={x:300,y:260,w:300,h:44};
function draw(){ctx.fillStyle='#1d3557';ctx.fillRect(0,0,900,600);
 ctx.fillStyle='#fff';ctx.font='28px sans-serif';ctx.fillText('LAB-VM-07  —  Sign in',300,200);
 ctx.fillStyle='#fff';ctx.fillRect(box.x,box.y,box.w,box.h);ctx.strokeStyle=focused?'#e63946':'#888';ctx.lineWidth=3;ctx.strokeStyle=focused?'#e63946':'#888';ctx.strokeRect(box.x,box.y,box.w,box.h);
 ctx.fillStyle='#000';ctx.font='24px monospace';ctx.fillText(typed||'',box.x+10,box.y+31);
 ctx.fillStyle='#aaa';ctx.font='16px sans-serif';ctx.fillText('Username',box.x,box.y-10);}
c.addEventListener('mousedown',e=>{log.push({t:'mousedown',x:e.clientX,y:e.clientY});focused=e.clientX>=box.x&&e.clientX<=box.x+box.w&&e.clientY>=box.y&&e.clientY<=box.y+box.h;c.focus();draw();});
c.addEventListener('keydown',e=>{e.preventDefault();log.push({t:'keydown',key:e.key});if(!focused)return;if(e.key==='Backspace')typed=typed.slice(0,-1);else if(e.key.length===1)typed+=e.key;draw();});
draw();
</script>`;
const web = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
await new Promise((r) => web.listen(webPort, '127.0.0.1', r));

const bin = [path.join(os.homedir(), 'Applications/Opera.app/Contents/MacOS/Opera'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((b) => fs.existsSync(b));
const browser = spawn(bin, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--headless=new', '--no-first-run', '--window-size=1000,700', `http://127.0.0.1:${webPort}/`], { stdio: 'ignore' });

const env = { ...process.env, PORT: String(appPort), COPILOT_CDP_PORT: String(cdpPort), COPILOT_CHATS_DIR: path.join(tmp, 'chats'), COPILOT_DOCS_DIR: path.join(tmp, 'docs'), COPILOT_DESKTOP_DIR: desktop, COPILOT_SETTINGS: path.join(tmp, 'settings.json') };
for (const k of Object.keys(env)) if (/^CLAUDE/.test(k)) delete env[k];
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[server!] ' + d));

let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

try {
  let tab;
  for (let i = 0; i < 60 && !tab; i++) { await new Promise((r) => setTimeout(r, 500)); try { tab = (await CDP.List({ port: cdpPort })).find((x) => x.url.includes('127.0.0.1')); } catch {} }
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); try { up = (await fetch(`http://127.0.0.1:${appPort}/api/status`)).ok; } catch {} }
  check('rig browser + throwaway server up', !!tab && up);

  const ws = new WebSocket(`ws://127.0.0.1:${appPort}/ws`);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const events = [];
  const done = new Promise((resolve) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      events.push(m);
      if (m.type === 'tool') console.log('  tool:', m.name, JSON.stringify(m.input).slice(0, 120));
      if (m.type === 'text') console.log('  claude:', m.text.slice(0, 300).replace(/\n/g, ' '));
      if (m.type === 'turn_done') resolve(m);
    });
  });
  ws.send(JSON.stringify({
    type: 'chat', chatId: 'rig1', tabId: tab.id,
    text: 'This tab is a remote desktop for my school lab VM, so the page snapshot is empty. Please click into the Username box on the remote screen, type student42 into it, then save a screenshot of the tab to my Desktop called lab proof.',
  }));
  const result = await Promise.race([done, new Promise((r) => setTimeout(() => r({ timeout: true }), 240000))]);
  check('turn finished', result && result.ok === true, JSON.stringify(result));

  const toolNames = events.filter((e) => e.type === 'tool').map((e) => e.name);
  check('used screenshot to look', toolNames.includes('screenshot'), toolNames.join(','));
  check('used click_at', toolNames.includes('click_at'));
  check('used type_text', toolNames.includes('type_text'));

  const c = await CDP({ target: tab.webSocketDebuggerUrl, port: cdpPort });
  const state = JSON.parse((await c.Runtime.evaluate({ expression: 'JSON.stringify({log, typed, focused})', returnByValue: true })).result.value);
  await c.close();
  const inBox = state.log.find((e) => e.t === 'mousedown' && e.x >= 300 && e.x <= 600 && e.y >= 260 && e.y <= 304);
  check('a click landed inside the drawn Username box', !!inBox, JSON.stringify(state.log.filter((e) => e.t === 'mousedown')));
  check('the remote screen received the typed name', state.typed === 'student42', JSON.stringify(state.typed));
  const saved = fs.existsSync(desktop) ? fs.readdirSync(desktop) : [];
  check('a PNG named for the request landed on the (temp) Desktop', saved.some((f) => /lab proof/i.test(f) && f.endsWith('.png')), saved.join(', '));
  check('real Desktop has no new "lab proof" file', !fs.readdirSync(path.join(os.homedir(), 'Desktop')).some((f) => /lab proof/i.test(f)));
  ws.close();
} finally {
  server.kill();
  browser.kill();
  web.close();
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
