// HTML → PDF. Claude lays a document out as HTML + CSS (which it is very good
// at) and a HIDDEN copy of the browser prints it with Chrome's own PDF
// engine: real text, real fonts, page breaks, pictures — the same output as
// "Save as PDF" in the print dialog.
//
// It is a separate headless browser on its own port and a throwaway profile,
// started on first use and kept for the life of the server. It never opens a
// tab in the copilot's Opera (9222) — that window is Will's working browser.
// Scripts are switched off in the page being printed: the HTML is built from
// whatever is on web pages, so it gets to be a layout and nothing more.
import CDP from 'chrome-remote-interface';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserBinary } from './chrome.js';

let printer = null; // Promise<{ port, child }>

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startPrinter() {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-pdf-'));
  const child = spawn(browserBinary(), [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--allow-file-access-from-files',
  ], { stdio: 'ignore' });
  const cleanup = () => { try { child.kill(); } catch { /* gone */ } };
  process.once('exit', cleanup);
  child.on('exit', () => {
    printer = null;
    fs.rm(profile, { recursive: true, force: true }, () => {});
  });
  for (let i = 0; i < 100; i++) {
    try { await CDP.Version({ port }); return { port, child }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  cleanup();
  throw new Error('The PDF maker could not start a hidden browser.');
}

function getPrinter() {
  if (!printer) {
    printer = startPrinter();
    printer.catch(() => { printer = null; });
  }
  return printer;
}

// Render an HTML FILE (so relative picture paths resolve next to it) to PDF
// bytes. Paper size comes from the HTML's own @page rule when it has one;
// otherwise US Letter.
export async function htmlFileToPdf(htmlPath, { landscape = false } = {}) {
  const { port } = await getPrinter();
  const target = await CDP.New({ port, url: 'about:blank' });
  let client;
  try {
    client = await CDP({ port, target });
    const { Page, Runtime, Emulation } = client;
    await Page.enable();
    await Emulation.setScriptExecutionDisabled({ value: true });
    const loaded = Page.loadEventFired();
    await Page.navigate({ url: pathToFileURL(htmlPath).href });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 15000))]);
    // Web fonts finish after load; Runtime.evaluate still runs with page
    // scripts off.
    await Runtime.evaluate({ expression: 'document.fonts.ready.then(() => true)', awaitPromise: true, timeout: 10000 }).catch(() => {});
    const { result } = await Runtime.evaluate({
      expression: `JSON.stringify([...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.getAttribute('src')))`,
      returnByValue: true,
    });
    const broken = JSON.parse(result.value || '[]');
    const { data } = await Page.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      landscape,
      paperWidth: 8.5, paperHeight: 11,
      marginTop: 0.75, marginBottom: 0.75, marginLeft: 0.75, marginRight: 0.75,
    });
    return { pdf: Buffer.from(data, 'base64'), brokenImages: broken };
  } finally {
    try { await client?.close(); } catch { /* fine */ }
    try { await CDP.Close({ port, id: target.id }); } catch { /* fine */ }
  }
}

export function countPages(pdf) {
  const m = pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return m ? m.length : null;
}
