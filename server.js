'use strict';

// Slate local web server. Serves the UI and a small JSON API on localhost.
// Nothing is exposed to the internet — it binds to 127.0.0.1 only.

require('./src/load-env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const api = require('./src/api');
const users = require('./src/users');
const classNotes = require('./src/classNotes');
const { sync } = require('./src/sync');
const { getDb } = require('./src/db');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// HttpOnly so page scripts can't read it; Lax so it survives normal navigation.
function sessionCookie(token) {
  const base = `${users.SESSION_COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax`;
  return { 'set-cookie': token ? `${base}; Max-Age=${60 * 60 * 24 * 30}` : `${base}; Max-Age=0` };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// Route table: METHOD path (with :params) -> handler(params, body, query)
async function handleApi(req, res, pathname, query) {
  const method = req.method;
  const body = method === 'POST' ? await readBody(req) : {};
  const seg = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);

  // Who's asking. With sign-in off this is always the owner, which is exactly
  // how Slate behaved before accounts existed.
  const token = readCookies(req)[users.SESSION_COOKIE];
  const me = users.currentUser(token);

  try {
    // ---- sign in / out --------------------------------------------------
    // These four have to work before you're signed in, for obvious reasons.
    if (method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, { login_required: users.loginRequired(), user: users.publicUser(me) });
    }
    if (method === 'POST' && pathname === '/api/login') {
      const r = users.signIn(body.name, body.password, {
        userAgent: req.headers['user-agent'],
        ip: req.socket.remoteAddress,
      });
      if (!r.ok) return sendJson(res, 401, r);
      return sendJson(res, 200, { ok: true, user: r.user }, sessionCookie(r.token));
    }
    if (method === 'POST' && pathname === '/api/logout') {
      users.endSession(token);
      return sendJson(res, 200, { ok: true }, sessionCookie(null));
    }
    if (method === 'GET' && pathname === '/api/status') return sendJson(res, 200, api.status());

    // Everything past here needs a signed-in person, once anyone can sign in.
    if (users.loginRequired() && !me) {
      return sendJson(res, 401, { error: 'Sign in to use Slate.' });
    }

    // ---- admin ----------------------------------------------------------
    if (seg[0] === 'admin') {
      if (!me || !me.is_admin) return sendJson(res, 403, { error: 'Admins only.' });
      if (method === 'GET' && pathname === '/api/admin/users') return sendJson(res, 200, users.adminOverview());
      if (method === 'POST' && pathname === '/api/admin/users') return sendJson(res, 200, users.addUser(body));
      if (seg[1] === 'users' && seg[2]) {
        const id = Number(seg[2]);
        if (method === 'GET' && seg[3] === 'devices') return sendJson(res, 200, { devices: users.devicesFor(id) });
        if (method === 'POST' && seg[3] === 'freeze') return sendJson(res, 200, users.setFrozen(id, !!body.frozen));
        if (method === 'POST' && seg[3] === 'admin') return sendJson(res, 200, users.setAdmin(id, !!body.admin));
        if (method === 'POST' && seg[3] === 'password') return sendJson(res, 200, users.setPassword(id, body.password));
        if (method === 'POST' && seg[3] === 'rename') return sendJson(res, 200, users.renameUser(id, body.name));
        if (method === 'POST' && seg[3] === 'signout') return sendJson(res, 200, users.signOutDevices(id));
        if (method === 'POST' && seg[3] === 'delete') return sendJson(res, 200, users.removeUser(id));
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    // Quit button in the sidebar. Only the installed copy offers it — the dev
    // server never sets SLATE_INSTALLED, so a stray click can't kill it.
    if (method === 'POST' && pathname === '/api/quit') {
      if (process.env.SLATE_INSTALLED !== '1') return sendJson(res, 403, { error: 'not the installed app' });
      sendJson(res, 200, { ok: true });
      // Let the response flush, then stop listening properly — quitting and
      // reopening straight away must not leave the port stuck.
      res.on('finish', () => setTimeout(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref(); // don't hang on a slow socket
      }, 150));
      return;
    }
    if (method === 'POST' && pathname === '/api/sync') {
      const counts = await runSync();
      return sendJson(res, 200, { ok: true, counts, ...api.status() });
    }

    // today
    // The day's plan: today's unfinished assignments, plus project work to fill
    // the rest of the 2-hour target.
    if (method === 'GET' && pathname === '/api/today') {
      return sendJson(res, 200, api.todayPlan(query.sort === 'impact' ? 'impact' : 'due'));
    }
    if (method === 'GET' && pathname === '/api/week') return sendJson(res, 200, api.week());

    // assignments
    if (seg[0] === 'assignments' && seg[1]) {
      const id = Number(seg[1]);
      if (method === 'GET' && !seg[2]) return sendJson(res, 200, api.assignmentDetail(id));
      if (method === 'POST' && seg[2] === 'complete') return sendJson(res, 200, api.completeAssignment(id));
      if (method === 'POST' && seg[2] === 'reopen') return sendJson(res, 200, api.reopenAssignment(id));
      if (method === 'POST' && seg[2] === 'time') return sendJson(res, 200, api.addTime(id, Number(body.seconds || 0)));
      if (method === 'POST' && seg[2] === 'draft') {
        return sendJson(res, 200, api.saveDraft(id, body.text == null ? null : String(body.text), body.html));
      }
      if (method === 'POST' && seg[2] === 'doc-style') return sendJson(res, 200, api.saveDocStyle(id, body));
      if (method === 'POST' && seg[2] === 'simplify') return sendJson(res, 200, await api.ensureSimplified(id));
      // Attached Canvas files. `open` downloads it (once) and hands it to
      // whatever program opens that type on this machine. Indexed by position
      // in the list, never by a name from the page, so no path can be smuggled
      // in from the browser.
      if (method === 'POST' && seg[2] === 'files' && seg[3] === 'open') {
        const r = await api.openAssignmentFile(id, Number(body.index));
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      // Reads what's inside the attachments (once, then cached). Normally this
      // happens on its own as part of building the Instructions box.
      if (method === 'POST' && seg[2] === 'read-files') {
        return sendJson(res, 200, { text: await api.ensureAttachmentText(id) });
      }
    }

    // downloads (works for text assignments and slideshow projects)
    if (pathname === '/api/download-options' && method === 'GET') {
      const opts = api.downloadOptions(query.kind, Number(query.id));
      return sendJson(res, opts ? 200 : 404, opts || { error: 'not found' });
    }
    // Handing in through Canvas. The preview is a read; the submit is the only
    // write Slate ever makes, and only when the student presses the button.
    if (pathname === '/api/submit-preview' && method === 'GET') {
      const p = await api.submissionPreview(String(query.kind || ''), Number(query.id), query.filename, query.format,
        { light: query.light === '1' });
      return sendJson(res, p && p.ok ? 200 : 404, p || { error: 'not found' });
    }
    // Test-only window onto what the MOCK Canvas was handed. Never exists
    // against a real Canvas, so it can't leak anything.
    if (pathname === '/api/_submitted' && method === 'GET') {
      const { canvasMode } = require('./src/canvas/canvasClient');
      if (canvasMode() !== 'mock') return sendJson(res, 404, { error: 'not found' });
      const sent = require('./src/canvas/mockCanvas').submitted;
      return sendJson(res, 200, { count: sent.length, sent });
    }
    // Corrections to the heading, remembered per class.
    if (pathname === '/api/heading' && method === 'POST') {
      return sendJson(res, 200, api.saveHeading(Number(body.class_id), body));
    }
    if (pathname === '/api/submit-to-canvas' && method === 'POST') {
      const r = await api.submitToCanvas(String(body.kind || ''), Number(body.id), body.filename, body.format);
      return sendJson(res, 200, r);
    }
    if (pathname === '/api/download' && method === 'POST') {
      const r = await api.performDownload(String(body.kind || ''), Number(body.id), String(body.filename || ''), String(body.format || ''));
      return sendJson(res, 200, r);
    }

    // projects
    if (pathname === '/api/projects' && method === 'GET') return sendJson(res, 200, api.projects());
    if (seg[0] === 'projects' && seg[1]) {
      const id = Number(seg[1]);
      if (method === 'GET' && !seg[2]) return sendJson(res, 200, api.projectDetail(id));
      if (method === 'GET' && seg[2] === 'compile') return sendJson(res, 200, api.compileProject(id));
      // Essay: everything pulled together in MLA, with what's still missing.
      if (method === 'GET' && seg[2] === 'review') {
        const r = api.essayReview(id);
        return sendJson(res, r ? 200 : 404, r || { error: 'not found' });
      }
      if (method === 'POST' && seg[2] === 'review') return sendJson(res, 200, api.saveEssayNames(id, body));
      if (method === 'POST' && seg[2] === 'slides') return sendJson(res, 200, api.saveSlides(id, body.slides || []));
      if (method === 'POST' && seg[2] === 'outline') return sendJson(res, 200, await api.generateSlidesOutline(id));
      // Researched points to work from. Slower than the outline — it actually
      // looks the topic up — so the page shows a waiting state.
      if (method === 'POST' && seg[2] === 'suggestions') return sendJson(res, 200, await api.fillSlideSuggestions(id));
      // Essay editor's Get Unstuck coach. Hitting Cancel (or leaving the page)
      // closes the request, which kills the hidden claude process.
      if (method === 'POST' && seg[2] === 'unstuck') {
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        let out;
        try {
          out = await api.unstuckGuidance(id, body, { signal: ac.signal });
        } catch (err) {
          if (ac.signal.aborted) return; // the writer cancelled; nobody is listening
          throw err;
        }
        if (ac.signal.aborted || res.writableEnded) return;
        return sendJson(res, 200, out);
      }
    }
    if (seg[0] === 'chunks' && seg[1] && method === 'POST' && seg[2] === 'done') {
      return sendJson(res, 200, api.setChunkDone(Number(seg[1]), !!body.done));
    }

    // tests + flashcards
    // ?weeks=1..4 narrows it to what's coming up; anything else means all.
    if (pathname === '/api/tests' && method === 'GET') return sendJson(res, 200, api.tests(query.weeks));
    if (seg[0] === 'tests' && seg[1]) {
      const id = Number(seg[1]);
      if (method === 'GET' && !seg[2]) return sendJson(res, 200, api.testDetail(id));
      if (method === 'POST' && seg[2] === 'time') return sendJson(res, 200, api.addStudyTime(id, Number(body.seconds || 0)));
      if (method === 'POST' && seg[2] === 'notes') {
        return sendJson(res, 200, api.uploadTestNotes(id, String(body.filename || ''), String(body.content_base64 || '')));
      }
    }
    if (seg[0] === 'flashcards' && seg[1] && method === 'POST' && seg[2] === 'review') {
      return sendJson(res, 200, api.reviewFlashcard(Number(seg[1]), !!body.remembered));
    }

    // classes / grades / gpa
    if (pathname === '/api/classes' && method === 'GET') return sendJson(res, 200, api.classes());
    if (seg[0] === 'classes' && seg[1] && seg[2] === 'notes') {
      const classId = Number(seg[1]);
      if (method === 'GET') return sendJson(res, 200, { notes: classNotes.listNotes(classId) });
      if (method === 'POST') {
        const r = classNotes.addNoteFromImage(classId, String(body.filename || ''), String(body.content_base64 || ''));
        return sendJson(res, r.ok ? 200 : 400, r);
      }
    }
    if (seg[0] === 'classes' && seg[1] && method === 'GET') return sendJson(res, 200, api.classDetail(Number(seg[1])));

    // class notes: edit, delete, view the original photo, put on a test
    if (seg[0] === 'notes' && seg[1]) {
      const noteId = Number(seg[1]);
      if (method === 'GET' && !seg[2]) {
        const n = classNotes.getNote(noteId);
        return sendJson(res, n ? 200 : 404, n || { error: 'not found' });
      }
      if (method === 'GET' && seg[2] === 'image') {
        const p = classNotes.noteImagePath(noteId);
        if (!p) { res.writeHead(404); return res.end('not found'); }
        return fs.readFile(p, (err, data) => {
          if (err) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
          res.end(data);
        });
      }
      if (method === 'GET' && seg[2] === 'tests') return sendJson(res, 200, { tests: classNotes.testsForNote(noteId) });
      if (method === 'POST' && !seg[2]) return sendJson(res, 200, classNotes.saveNote(noteId, body));
      if (method === 'POST' && seg[2] === 'delete') return sendJson(res, 200, classNotes.deleteNote(noteId));
      if (method === 'POST' && seg[2] === 'add-to-test') {
        const r = classNotes.addNoteToTest(noteId, Number(body.test_id));
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      if (method === 'POST' && seg[2] === 'remove-from-test') {
        return sendJson(res, 200, classNotes.removeNoteFromTest(noteId, Number(body.test_id)));
      }
    }
    if (pathname === '/api/gpa' && method === 'GET') return sendJson(res, 200, api.gpa());

    // emails
    if (pathname === '/api/emails' && method === 'GET') return sendJson(res, 200, api.emails());
    if (seg[0] === 'emails' && seg[1] && method === 'GET') {
      const e = await api.emailDetail(Number(seg[1]));
      return sendJson(res, e ? 200 : 404, e || { error: 'not found' });
    }

    // Canvas connection (the API page)
    if (pathname === '/api/canvas' && method === 'GET') return sendJson(res, 200, api.canvasSettings());
    if (pathname === '/api/canvas' && method === 'POST') {
      return sendJson(res, 200, await api.connectCanvas(body));
    }
    // Optional GPTZero check. The key is stored server side and only its last
    // four characters are ever sent back to the page.
    if (pathname === '/api/ai-check-key' && method === 'POST') {
      return sendJson(res, 200, require('./src/aiCheck').saveKey(body.key));
    }
    if (pathname === '/api/ai-check' && method === 'POST') {
      const r = await api.aiCheckFor(String(body.kind || ''), Number(body.id));
      return sendJson(res, 200, r);
    }
    if (pathname === '/api/canvas/disconnect' && method === 'POST') {
      return sendJson(res, 200, api.disconnectCanvas());
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('API error:', err);
    return sendJson(res, 500, { error: err.message });
  }
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fall back to branding assets for the logo
      if (rel.startsWith('/branding/')) {
        const bp = path.join(__dirname, rel);
        return fs.readFile(bp, (e2, d2) => {
          if (e2) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'content-type': MIME[path.extname(bp)] || 'application/octet-stream' });
          res.end(d2);
        });
      }
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // Never let the browser hold on to app.js or styles.css. Slate is served
      // from the machine it runs on, so there is nothing to save by caching,
      // and a window left open for hours running yesterday's JavaScript against
      // today's server is a genuinely confusing bug to chase — the page looks
      // right and simply does nothing.
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname, parsed.query);
  if (pathname.startsWith('/branding/')) return serveStatic(res, pathname);
  return serveStatic(res, pathname);
});

// ---- syncing -------------------------------------------------------------
// One sync at a time. The hourly timer and the Sync now button can otherwise
// land on top of each other and both write the same rows; whoever asks second
// just waits for the one already running and gets its answer.
let inFlight = null;
function runSync(opts) {
  if (inFlight) return inFlight;
  inFlight = sync(opts || { log: () => {} }).finally(() => { inFlight = null; });
  return inFlight;
}

// Slate checks Canvas every hour while it's open. No scheduled task, no service
// — it only runs when the app is actually running, which is what Will asked
// for, and it means there is nothing left behind on the machine when it isn't.
// A sync with no Canvas connected returns immediately on its own.
const SYNC_EVERY_MS = Number(process.env.SLATE_SYNC_EVERY_MS) || 60 * 60 * 1000;
function startAutoSync() {
  if (process.env.SLATE_NO_AUTOSYNC === '1') return; // tests + the drive harness
  console.log(`Checking Canvas every ${Math.round(SYNC_EVERY_MS / 60000)} min while Slate is open.`);
  const timer = setInterval(() => {
    runSync({ log: () => {} })
      .then((c) => { if (c && c.connected !== false) console.log('[hourly sync] done', JSON.stringify(c)); })
      // A sync that fails is not worth crashing over — the next one is an hour
      // away and the button still works.
      .catch((err) => console.error('[hourly sync] failed:', err.message));
  }, SYNC_EVERY_MS);
  // Don't hold the process open just for the timer.
  if (timer.unref) timer.unref();
}

// Make sure the DB exists and is seeded on first run.
// Slate starts EMPTY and stays empty until real Canvas is connected on the API
// page. The mock data still exists and the test harnesses still run on it —
// they ask for it by setting CANVAS_MODE=mock — but it is never poured into
// Will's own app behind his back.
function ensureSeeded() {
  const db = getDb();
  const n = db.prepare('SELECT COUNT(*) n FROM classes').get().n;
  if (n > 0) return Promise.resolve();
  if ((process.env.CANVAS_MODE || '').toLowerCase() !== 'mock') return Promise.resolve();
  console.log('CANVAS_MODE=mock: filling an empty database with sample data...');
  return sync({ log: (m) => console.log(m) });
}

const { openWindow } = require('./src/openWindow');

// Quitting Slate and reopening it a second later would otherwise land on a port
// the old process hasn't finished letting go of, and the new one would die
// silently — which, when it starts hidden from a Desktop icon, looks exactly
// like double-clicking doing nothing at all. So we wait the port out.
function listen(attempt = 0) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && attempt < 20) {
        setTimeout(() => listen(attempt + 1).then(resolve, reject), 500);
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(PORT, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

ensureSeeded()
  .then(listen)
  .then(() => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  Slate is running.  Open  ${url}\n  (Close this window to quit Slate.)\n`);
    startAutoSync();
    openWindow(url, { appWindow: process.env.SLATE_APP_WINDOW === '1' });
  })
  .catch((err) => {
    console.error('Slate could not start:', err.message);
    // The installed copy runs hidden, so it listens for this and tells Will
    // out loud instead of dying where nobody can see it (launch.js exits for
    // us there). With nothing listening, exit rather than sitting there alive
    // but not serving — anything waiting on the port deserves a fast answer.
    process.emit('slate:fatal', err);
    process.exit(1);
  });
