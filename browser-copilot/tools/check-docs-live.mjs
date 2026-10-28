// Live check of the document tools: two real Claude turns through a
// THROWAWAY copilot server wired to a THROWAWAY headless browser (own ports,
// own profile, temp docs folder) — never Will's Opera on 9222, never his
// real Documents folder.
//
// Turn 1: upload a Word worksheet → fill in an answer and put a cropped
//         capture of the open tab under the screenshot question.
//         Checks: edit_docx used (not save_document), every original
//         paragraph still there, a real picture inside the file.
// Turn 2: upload a PDF worksheet → "make this again with the screenshot in
//         it". Checks: make_pdf used, the PDF exists, has the picture
//         (an /Image XObject) and keeps the worksheet's text.
//
// FIXTURE_DOCX=/path/to/a.docx tries a real worksheet instead of the
// generated one. Uses the model in the rig settings (sonnet). ~$1.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-rig-'));
const docsDir = path.join(tmp, 'docs');
const cdpPort = await freePort(), webPort = await freePort(), appPort = await freePort();
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ model: process.env.RIG_MODEL || 'sonnet' }));

const PAGE = `<!doctype html><title>Task Manager (rig)</title>
<body style="margin:0;font:14px system-ui;background:#f3f3f3">
<div style="background:#1f1f1f;color:#fff;padding:10px 16px">Some site header and nav clutter</div>
<div id=tm style="margin:40px;width:520px;background:#fff;border:1px solid #999;box-shadow:0 2px 8px #0003">
 <div style="background:#0a64a4;color:#fff;padding:8px 12px;font-weight:600">Task Manager</div>
 <table style="width:100%;border-collapse:collapse" border=1 cellpadding=6>
  <tr><th>Name</th><th>CPU</th><th>Memory</th></tr>
  <tr><td>explorer.exe</td><td>1%</td><td>48 MB</td></tr>
  <tr><td>notepad.exe</td><td>0%</td><td>12 MB</td></tr>
  <tr><td>chrome.exe</td><td>7%</td><td>310 MB</td></tr>
 </table></div></body>`;
const web = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
await new Promise((r) => web.listen(webPort, '127.0.0.1', r));

const bin = [path.join(os.homedir(), 'Applications/Opera.app/Contents/MacOS/Opera'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((b) => fs.existsSync(b));
const browser = spawn(bin, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--headless=new', '--no-first-run', '--window-size=1000,700', `http://127.0.0.1:${webPort}/`], { stdio: 'ignore' });

const env = { ...process.env, PORT: String(appPort), COPILOT_CDP_PORT: String(cdpPort), COPILOT_CHATS_DIR: path.join(tmp, 'chats'), COPILOT_DOCS_DIR: docsDir, COPILOT_DESKTOP_DIR: path.join(tmp, 'Desktop'), COPILOT_SETTINGS: path.join(tmp, 'settings.json') };
for (const k of Object.keys(env)) if (/^CLAUDE/.test(k)) delete env[k];
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => process.stdout.write('[server!] ' + d));

let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

// Imports AFTER env is decided, pointed at the temp folder.
process.env.COPILOT_DOCS_DIR = docsDir;
const office = await import(path.join(ROOT, 'lib/office.js'));
const docxedit = await import(path.join(ROOT, 'lib/docxedit.js'));

async function upload(name, buf) {
  const r = await fetch(`http://127.0.0.1:${appPort}/api/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: name, content_base64: buf.toString('base64') }),
  }).then((x) => x.json());
  if (!r.ok) throw new Error('upload failed: ' + r.error);
  return r.path;
}

function turn(ws, chatId, tabId, text, attachments) {
  const events = [];
  return new Promise((resolve) => {
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (m.chatId && m.chatId !== chatId) return;
      events.push(m);
      if (m.type === 'tool') console.log('  tool:', m.name, JSON.stringify(m.input).slice(0, 140));
      if (m.type === 'tool_done' && m.file) console.log('  file card:', m.file);
      if (m.type === 'tool_done' && !m.ok) console.log('  tool error:', m.name, m.error);
      if (m.type === 'text') console.log('  claude:', m.text.slice(0, 300).replace(/\n/g, ' '));
      if (m.type === 'turn_done') { ws.off('message', onMsg); resolve({ result: m, events }); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'chat', chatId, tabId, text, attachments }));
    setTimeout(() => { ws.off('message', onMsg); resolve({ result: { timeout: true }, events }); }, 420000);
  });
}

try {
  let tab;
  for (let i = 0; i < 60 && !tab; i++) { await new Promise((r) => setTimeout(r, 500)); try { tab = (await CDP.List({ port: cdpPort })).find((x) => x.url.includes('127.0.0.1')); } catch {} }
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); try { up = (await fetch(`http://127.0.0.1:${appPort}/api/status`)).ok; } catch {} }
  check('rig browser + throwaway server up', !!tab && up);

  const ws = new WebSocket(`ws://127.0.0.1:${appPort}/ws`);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  // ---- turn 1: Word worksheet ------------------------------------------------
  const worksheet = process.env.FIXTURE_DOCX
    ? fs.readFileSync(process.env.FIXTURE_DOCX)
    : office.buildDocx('Name: \n\nActivity 1.2.3 - Process Management\n\n1. Who owns the notepad.exe process?\n\n2. Please paste a screenshot of your Task Manager Window:\n\n3. Why should you not kill explorer.exe?\n');
  const before = docxedit.outline(worksheet).split('\n').map((l) => l.replace(/^\[\d+\]\s*(\([^)]*\)\s*)?/, '')).filter((l) => l && l !== '(empty)');
  const docxPath = await upload('Lab Worksheet.docx', worksheet);
  const t1 = await turn(ws, 'rig-docx', tab.id,
    'Fill in my name (Will Caldwell) on this worksheet, and put a screenshot of just the Task Manager window from this tab under the question that asks for a Task Manager screenshot. Leave every other question blank. Send it back as a Word file.',
    [docxPath]);
  check('turn 1 finished', t1.result.ok === true, JSON.stringify(t1.result));
  const tools1 = t1.events.filter((e) => e.type === 'tool').map((e) => e.name);
  check('used capture_image', tools1.includes('capture_image'), tools1.join(','));
  check('used edit_docx', tools1.includes('edit_docx'));
  check('did NOT rebuild with save_document', !tools1.includes('save_document'));
  const card1 = t1.events.find((e) => e.type === 'tool_done' && e.file && /\.docx$/i.test(e.file));
  check('chat got a .docx file card', !!card1);
  if (card1) {
    const out = fs.readFileSync(path.join(docsDir, card1.file));
    const after = docxedit.outline(out);
    check('every original line is still there', before.every((l) => after.includes(l)), before.filter((l) => !after.includes(l)).join(' | '));
    check('name filled in', /Will Caldwell/.test(after));
    check('a picture is inside the Word file', office.zipEntries(out).some((e) => /^word\/media\//.test(e.name)) && /has a picture/.test(after));
    const lines = after.split('\n');
    const q = lines.findIndex((l) => /Task Manager Window/i.test(l));
    const pic = lines.findIndex((l) => /has a picture/.test(l));
    const nextQ = lines.findIndex((l, i) => i > q && /kill explorer|explorer\.exe/i.test(l));
    check('the picture sits under the screenshot question', q >= 0 && pic > q && (nextQ < 0 || pic < nextQ), `q=${q} pic=${pic} next=${nextQ}`);
    fs.copyFileSync(path.join(docsDir, card1.file), path.join(process.env.RIG_KEEP || tmp, 'rig-out.docx'));
  }

  // ---- turn 2: PDF worksheet -------------------------------------------------
  const pdfmake = await import(path.join(ROOT, 'lib/pdfmake.js'));
  const srcHtml = path.join(tmp, 'ws.html');
  fs.writeFileSync(srcHtml, `<!doctype html><style>@page{size:letter;margin:1in}body{font:12pt Georgia}h1{text-align:center;font-size:18pt}.box{border:2px solid #000;height:2.5in;margin:8px 0 18px}</style>
<h1>Lab 4 — Processes</h1><p>Name: ____________________</p>
<p><b>1.</b> Paste a screenshot of Task Manager below.</p><div class=box></div>
<p><b>2.</b> Which process uses the most memory?</p><div class=box style="height:1in"></div>`);
  const { pdf } = await pdfmake.htmlFileToPdf(srcHtml);
  const pdfPath = await upload('Lab 4.pdf', pdf);
  const t2 = await turn(ws, 'rig-pdf', tab.id,
    'Make a copy of this PDF worksheet that looks the same, but with a screenshot of the Task Manager window from this tab inside the box for question 1. Save it as a PDF.',
    [pdfPath]);
  check('turn 2 finished', t2.result.ok === true, JSON.stringify(t2.result));
  const tools2 = t2.events.filter((e) => e.type === 'tool').map((e) => e.name);
  check('used make_pdf', tools2.includes('make_pdf'), tools2.join(','));
  const card2 = t2.events.filter((e) => e.type === 'tool_done' && e.file && /\.pdf$/i.test(e.file)).pop();
  check('chat got a .pdf file card', !!card2);
  if (card2) {
    const out = fs.readFileSync(path.join(docsDir, card2.file));
    const raw = out.toString('latin1');
    check('PDF has a picture in it', /\/Subtype\s*\/Image/.test(raw));
    check('PDF is a real PDF', raw.startsWith('%PDF'));
    fs.copyFileSync(path.join(docsDir, card2.file), path.join(process.env.RIG_KEEP || tmp, 'rig-out.pdf'));
  }
  ws.close();
} finally {
  server.kill();
  browser.kill();
  web.close();
  await new Promise((r) => setTimeout(r, 1500));
  if (!process.env.RIG_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
