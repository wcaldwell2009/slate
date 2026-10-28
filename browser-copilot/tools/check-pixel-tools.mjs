// npm run check:pixel — isolated check of the pixel tools (click_at, drag,
// scroll_at, type_text, press_key, screenshot+save): throwaway headless browser (own port,
// own profile, DPR forced to 2 so the retina path is the one under test), a
// canvas page that records every event it receives, and a temp "Desktop".
//
// The rig page preventDefaults keydown, as noVNC and Guacamole both do. That
// is not cosmetic: in --headless=new a keyDown with text on a focused
// NON-editable element floods the page with thousands of keydown/keypress
// pairs a second (measured 2026-09-09, Opera 135 and Chrome alike; an <input>
// is clean, and a headful window is clean: keydown, keypress, keyup, done).
// Real use is headful. preventDefault also suppresses keypress by spec, so
// keypress is not asserted here — the headful probe showed it firing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-rig-'));
const desktop = path.join(tmp, 'Desktop');
const cdpPort = await freePort();
const webPort = await freePort();
process.env.COPILOT_CDP_PORT = String(cdpPort);
process.env.COPILOT_DESKTOP_DIR = desktop;

const PAGE = `<!doctype html><title>Canvas Rig</title>
<body style="margin:0"><canvas id=c width=600 height=400 tabindex=0 style="display:block;background:#123;width:100vw;height:100vh"></canvas>
<script>
const c=document.getElementById('c'), ctx=c.getContext('2d');
window.log=[];
const rec=(e)=>{const o={t:e.type};
 if('clientX' in e){o.x=e.clientX;o.y=e.clientY;o.button=e.button;o.buttons=e.buttons;o.detail=e.detail;o.shift=e.shiftKey;o.ctrl=e.ctrlKey;}
 if('key' in e){o.key=e.key;o.code=e.code;o.ctrl=e.ctrlKey;o.alt=e.altKey;o.shift=e.shiftKey;o.meta=e.metaKey;o.vk=e.keyCode;}
 if('deltaY' in e){o.dy=e.deltaY;o.dx=e.deltaX;}
 window.log.push(o);};
for(const t of ['mousedown','mouseup','mousemove','click','dblclick','contextmenu','wheel','keydown','keypress','keyup'])
 c.addEventListener(t,(e)=>{rec(e); if(t==='contextmenu'||t==='keydown') e.preventDefault();});
c.addEventListener('mousedown',()=>c.focus());
ctx.fillStyle='#8CA891';ctx.fillRect(100,100,50,50);
</script>`;

const web = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
await new Promise((r) => web.listen(webPort, '127.0.0.1', r));

const bins = [
  path.join(os.homedir(), 'Applications/Opera.app/Contents/MacOS/Opera'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const bin = bins.find((b) => fs.existsSync(b));
if (!bin) throw new Error('no browser');
const browser = spawn(bin, [
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=2',
  '--window-size=800,600', `http://127.0.0.1:${webPort}/`,
], { stdio: 'ignore' });

const chrome = await import(path.join(ROOT, 'lib/chrome.js'));

let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

try {
  let tabs = [];
  for (let i = 0; i < 60 && !tabs.length; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { tabs = (await chrome.listTabs()).filter((t) => t.url.includes('127.0.0.1')); } catch {}
  }
  check('browser up with the rig tab', tabs.length === 1);
  const id = tabs[0].id;
  await new Promise((r) => setTimeout(r, 800));

  // Screenshot: 1:1 with CSS px despite DPR 2, and save lands on the temp Desktop.
  const shot = await chrome.screenshot(id, { save: true, name: 'rig: shot/one?.png' });
  const jpg = Buffer.from(shot.image, 'base64');
  // JPEG SOF0/SOF2 height/width.
  let w = 0, h = 0;
  for (let i = 2; i < jpg.length - 9; i++) {
    if (jpg[i] === 0xff && (jpg[i + 1] === 0xc0 || jpg[i + 1] === 0xc2)) { h = jpg.readUInt16BE(i + 5); w = jpg.readUInt16BE(i + 7); break; }
  }
  check('screenshot pixel size equals reported CSS viewport', w === shot.width && h === shot.height, `${w}x${h} vs ${shot.width}x${shot.height}`);
  check('saved PNG exists on the temp Desktop with a flattened name', shot.savedTo && fs.existsSync(shot.savedTo) && path.dirname(shot.savedTo) === desktop, shot.savedTo);
  const png = fs.readFileSync(shot.savedTo);
  check('saved PNG is full resolution (2x)', png.readUInt32BE(16) === shot.width * 2, `${png.readUInt32BE(16)}`);
  const shot2 = await chrome.screenshot(id, { save: true, name: 'rig: shot/one?.png' });
  check('second save does not overwrite', shot2.savedTo !== shot.savedTo && fs.existsSync(shot2.savedTo), shot2.savedTo);
  const shot3 = await chrome.screenshot(id, { save: true });
  check('default name uses the tab title', /Screenshot Canvas Rig \d{4}-/.test(path.basename(shot3.savedTo)), path.basename(shot3.savedTo));
  check('real Desktop untouched', !fs.existsSync(path.join(os.homedir(), 'Desktop', 'rig shot one.png')));

  // chrome.js has no public eval; use a second CDP client just for reading the log.
  const CDP = (await import('chrome-remote-interface')).default;
  const target = (await CDP.List({ port: cdpPort })).find((t) => t.id === id);
  const c2 = await CDP({ target: target.webSocketDebuggerUrl, port: cdpPort });
  const evalLog = async () => (await c2.Runtime.evaluate({ expression: 'JSON.stringify(window.log.splice(0))', returnByValue: true })).result.value;
  const grab = async () => JSON.parse(await evalLog());
  await grab();

  // click_at: left click lands at the coordinate, focuses the canvas.
  await chrome.clickAt(id, 125, 125);
  let log = await grab();
  const down = log.find((e) => e.t === 'mousedown');
  check('click_at fires mousedown at the coordinate', down && down.x === 125 && down.y === 125 && down.button === 0, JSON.stringify(down));
  check('click_at fires click', log.some((e) => e.t === 'click'));

  await chrome.clickAt(id, 125, 125, { clickCount: 2 });
  log = await grab();
  check('double click reaches dblclick', log.some((e) => e.t === 'dblclick'), log.map((e) => e.t).join(','));

  await chrome.clickAt(id, 200, 150, { button: 'right' });
  log = await grab();
  check('right click reaches contextmenu', log.some((e) => e.t === 'contextmenu'));

  await chrome.clickAt(id, 200, 150, { modifiers: ['shift'] });
  log = await grab();
  check('shift-click carries shiftKey', log.some((e) => e.t === 'mousedown' && e.shift === true));

  await chrome.clickAt(id, 9999, -50);
  log = await grab();
  const clamped = log.find((e) => e.t === 'mousedown');
  check('out-of-range click is clamped inside the viewport', clamped && clamped.x === shot.width - 1 && clamped.y === 0, JSON.stringify(clamped));

  // type_text: real keydown/keypress/keyup per char with shift for capitals.
  await chrome.clickAt(id, 125, 125); await grab();
  await chrome.typeText(id, 'Hi 2!\n');
  log = await grab();
  const downs = log.filter((e) => e.t === 'keydown').map((e) => e.key);
  const presses = log.filter((e) => e.t === 'keypress').map((e) => e.key);
  check('type_text keydowns per character', JSON.stringify(downs) === JSON.stringify(['H', 'i', ' ', '2', '!', 'Enter']), JSON.stringify(downs));
  const H = log.find((e) => e.t === 'keydown' && e.key === 'H');
  const bang = log.find((e) => e.t === 'keydown' && e.key === '!');
  check('capital and symbol carry shift + physical code + vk', H.shift && H.code === 'KeyH' && H.vk === 72 && bang.shift && bang.code === 'Digit1' && bang.vk === 49, JSON.stringify([H, bang]));
  check('keyups match keydowns', log.filter((e) => e.t === 'keyup').length === downs.length);

  // press_key combos.
  await chrome.pressKeys(id, 'ctrl+a');
  log = await grab();
  const ctrlA = log.find((e) => e.t === 'keydown' && e.key === 'a');
  check('ctrl+a: modifier held on the key', ctrlA && ctrlA.ctrl === true && ctrlA.code === 'KeyA', JSON.stringify(ctrlA));
  check('ctrl+a: Control pressed before, released after', log[0].key === 'Control' && log[log.length - 1].key === 'Control' && log[log.length - 1].t === 'keyup', log.map((e) => e.t + ':' + e.key).join(' '));
  check('ctrl+a: no keypress (no char)', !log.some((e) => e.t === 'keypress'));

  await chrome.pressKeys(id, 'ctrl+alt+Delete');
  log = await grab();
  const del = log.find((e) => e.t === 'keydown' && e.key === 'Delete');
  check('ctrl+alt+Delete', del && del.ctrl && del.alt && del.vk === 46, JSON.stringify(del));

  await chrome.pressKeys(id, 'shift+Tab');
  log = await grab();
  check('shift+Tab', log.some((e) => e.t === 'keydown' && e.key === 'Tab' && e.shift));

  await chrome.pressKeys(id, 'F5');
  log = await grab();
  check('F5 has vk 116', log.some((e) => e.t === 'keydown' && e.key === 'F5' && e.vk === 116));

  await chrome.pressKeys(id, 'enter');
  log = await grab();
  check('lower-case alias "enter"', log.some((e) => e.t === 'keydown' && e.key === 'Enter'));

  let threw = null;
  try { await chrome.pressKeys(id, 'ctrl+bogus'); } catch (e) { threw = e.message; }
  check('unknown key is refused, not guessed', /Unknown key "bogus"/.test(threw || ''), threw);

  // scroll + drag + move.
  await chrome.scrollAt(id, 300, 200, { deltaY: 240 });
  log = await grab();
  check('scroll_at fires wheel with deltaY', log.some((e) => e.t === 'wheel' && e.dy === 240), JSON.stringify(log));

  await chrome.drag(id, 100, 100, 300, 250);
  log = await grab();
  const dd = log.find((e) => e.t === 'mousedown'), du = log.find((e) => e.t === 'mouseup');
  const movesHeld = log.filter((e) => e.t === 'mousemove' && e.buttons === 1).length;
  check('drag: press at start, release at end, moves in between with button held', dd && dd.x === 100 && du && du.x === 300 && du.y === 250 && movesHeld >= 10, `${movesHeld} held moves`);

  await chrome.moveMouse(id, 50, 60);
  log = await grab();
  check('move_mouse fires mousemove only', log.length && log.every((e) => e.t === 'mousemove') && log[0].x === 50);

  // The screenshot must not have fronted anything: still no bringToFront call path. (Static check.)
  const src = fs.readFileSync(path.join(ROOT, 'lib/chrome.js'), 'utf8');
  const shotFn = src.slice(src.indexOf('export async function screenshot('), src.indexOf('export async function moveMouse('));
  check('screenshot() never calls bringToFront', !shotFn.includes('bringToFront'));

  await c2.close();
} finally {
  browser.kill();
  web.close();
  await new Promise((r) => setTimeout(r, 1500)); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
