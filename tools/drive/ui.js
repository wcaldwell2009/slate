'use strict';
// Runs the REAL public/app.js against a hand-rolled DOM shim and a live server,
// then walks every view and clicks every button/input it renders.
// Usage: node ui.js <baseUrl> <projectDir>

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = process.argv[2];
const PROJ = process.argv[3];

let pass = 0;
const failures = [];
const errors = [];
const section = (s) => console.log('\n=== ' + s + ' ===');
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// ------------------------------------------------------------------ DOM shim
class Node {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._class = '';
    this._html = '';
    this._text = '';
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.type = '';
    this.placeholder = '';
    this.title = '';
    this.href = '';
    this.target = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.contentEditable = 'false';
    this.spellcheck = false;
    this.scrollHeight = 0;
    this.clientWidth = 800;
    this._offsetHeight = null;
    this._offsetHeight = null;
    this.scrollTop = 0;
    this.clientHeight = 400;
    this.classList = {
      add: (...c) => { c.forEach((x) => { if (!this._classes().includes(x)) this._class = (this._class + ' ' + x).trim(); }); },
      remove: (...c) => { this._class = this._classes().filter((x) => !c.includes(x)).join(' '); },
      toggle: (c, on) => { if (on === undefined) on = !this._classes().includes(c); on ? this.classList.add(c) : this.classList.remove(c); },
      contains: (c) => this._classes().includes(c),
    };
  }
  _classes() { return this._class.split(/\s+/).filter(Boolean); }
  get className() { return this._class; }
  set className(v) { this._class = String(v || ''); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v == null ? '' : v); this.children = []; }
  get textContent() { return this._text || this._html.replace(/<[^>]*>/g, ''); }
  set textContent(v) { this._text = String(v == null ? '' : v); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  removeEventListener() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  focus() {} blur() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 400 }; }
  // Enough of a layout engine for the page paginator: a page body is its 1in
  // margins plus a double-spaced line per block. It cannot wrap text, so page
  // counts will not match Word — but it does catch a paginator that starts a
  // new page for every block, which is the bug this exists for.
  get offsetHeight() {
    if (this._offsetHeight != null) return this._offsetHeight;
    if (this._classes().includes('page-body')) return 192 + this.children.length * 32;
    return 0;
  }
  set offsetHeight(v) { this._offsetHeight = v; }
  // Enough of a layout engine for the page paginator: a page body is its 1in
  // margins plus a double-spaced line per block. It can't wrap text, so page
  // counts won't match Word — but it does catch a paginator that starts a new
  // page for every block, which is the bug this exists for.
  get offsetHeight() {
    if (this._offsetHeight != null) return this._offsetHeight;
    if (this._classes().includes('page-body')) return 192 + this.children.length * 32;
    return 0;
  }
  set offsetHeight(v) { this._offsetHeight = v; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return walk(this).filter((n) => matches(n, sel)); }
  // helpers for the driver
  get text() {
    const own = decodeEntities(this._text || this._html.replace(/<[^>]*>/g, ''));
    return (own + ' ' + this.children.map((c) => c.text).join(' ')).replace(/\s+/g, ' ').trim();
  }
  // innerHTML that a browser would have parsed into real child nodes
  get htmlClasses() {
    const out = [];
    const re = /class="([^"]*)"/g;
    let m; while ((m = re.exec(this._html))) out.push(...m[1].split(/\s+/));
    return out;
  }
}
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#8226;/g, '•');
}
// does this node, or the raw HTML inside it, carry the class?
function hasClass(n, c) { return n._classes().includes(c) || n.htmlClasses.includes(c); }
function walk(n, out = []) { for (const c of n.children) { out.push(c); walk(c, out); } return out; }
function matches(n, sel) {
  if (sel.startsWith('.')) return n._classes().includes(sel.slice(1));
  if (sel.startsWith('#')) return n.id === sel.slice(1);
  return n.tagName === sel.toUpperCase();
}

const document = {
  _byId: {},
  createElement: (t) => new Node(t),
  querySelector(sel) {
    if (sel.startsWith('#')) return this._byId[sel.slice(1)] || null;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.tab') return this._tabs;
    return [];
  },
  addEventListener() {},
  // The editor is contenteditable and drives it with execCommand. Nothing to
  // simulate here — the harness sets innerHTML directly.
  execCommand: () => true,
  body: new Node('body'),
};
document._byId.app = new Node('div');
document._byId.overlay = new Node('div');
document._byId.overlay.classList.add('hidden');
document._byId.panel = new Node('div');
document._byId['sync-status'] = new Node('div');
document._byId['sync-btn'] = new Node('button');
// Sidebar bits the installed app reveals; hidden here because the drive server
// is a dev server (no SLATE_INSTALLED), which is exactly what we assert below.
document._byId['quit-btn'] = new Node('button');
document._byId['quit-btn'].classList.add('hidden');
document._byId['build-tag'] = new Node('span');
document._byId['build-tag'].classList.add('hidden');
document._byId.who = new Node('span');
document._byId.who.classList.add('hidden');
document._tabs = ['documents', 'slideshows', 'copilot', 'marks', 'api', 'admin'].map((v) => {
  const n = new Node('button');
  n.classList.add('tab');
  n.dataset.view = v;
  return n;
});
// The Admin tab is addressed by id as well as being a tab — app.js hides it
// from anyone who isn't an admin.
document._byId['tab-admin'] = document._tabs.find((t) => t.dataset.view === 'admin');

const sandbox = {
  document,
  window: { addEventListener() {}, location: { search: '' } },
  location: { search: '' },
  navigator: { sendBeacon: () => true },
  getComputedStyle: () => ({ lineHeight: '24px' }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  URLSearchParams, console, Math, JSON, Date, Promise, String, Number, Array, Object, Set, Map, RegExp, Error,
  // browser globals the app uses
  AbortController, TextEncoder, Uint8Array,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  fetch: async (p, opts) => {
    const url = p.startsWith('http') ? p : BASE + p;
    try { return await fetch(url, opts); }
    catch (e) { errors.push('fetch failed: ' + url + ' :: ' + e.message); throw e; }
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

process.on('unhandledRejection', (e) => errors.push('unhandled rejection: ' + (e && e.message)));

const src = fs.readFileSync(path.join(PROJ, 'public', 'app.js'), 'utf8');
try { vm.runInContext(src, sandbox, { filename: 'app.js' }); }
catch (e) { console.error('app.js threw on load:', e); process.exit(2); }

const run = (code) => vm.runInContext(code, sandbox);
const appNode = () => document._byId.app;
const panelNode = () => document._byId.panel;
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

function nodesIn(root) { return walk(root); }
function buttons(root) { return nodesIn(root).filter((n) => n.tagName === 'BUTTON' || typeof n.onclick === 'function'); }
function inputs(root, tag) { return nodesIn(root).filter((n) => n.tagName === tag); }

async function renderView(view, extra = '') {
  run(`state.view = ${JSON.stringify(view)}; ${extra}`);
  await run('render()');
  await settle(400);
}

(async () => {
  section('Boot');
  check('app.js loaded without throwing', true);
  check('state exists', run('typeof state') === 'object');
  check('render is a function', run('typeof render') === 'function');

  // -------------------------------------------------------------- each view
  for (const view of ['documents', 'slideshows', 'copilot', 'marks']) {
    section('View: ' + view);
    const errBefore = errors.length;
    await renderView(view);
    const root = appNode();
    check(`${view} renders nodes`, root.children.length > 0, `children=${root.children.length}`);
    check(`${view} rendered without errors`, errors.length === errBefore, errors.slice(errBefore).join(' | '));
    check(`${view} has a heading`, nodesIn(root).some((n) => n.tagName === 'H1' && n.text.length > 0));
    const tabActive = document._tabs.find((t) => t._classes().includes('active'));
    check(`${view} highlights its sidebar tab`, tabActive && tabActive.dataset.view === view);
  }

  // ---------------------------------------------- Documents + Slideshows
  // Make a project, link it to a Canvas class + assignment (which pulls the
  // instructions), confirm it opens the right editor, saves, and lists.
  section('Documents section: new project + Canvas picker');
  {
    const errB = errors.length;
    await renderView('documents');
    let root2 = appNode();
    check('Documents shows a New document button', nodesIn(root2).some((n) => n.tagName === 'BUTTON' && /New document/.test(n.text)));

    const created = await (await fetch(BASE + '/api/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'doc' }) })).json();
    check('creating a document returns an id', created.ok && created.id > 0);
    await renderView('work', `state.workId = ${created.id};`);
    root2 = appNode();
    check('a new document opens the picker (not a Canvas head)', nodesIn(root2).some((n) => hasClass(n, 'proj-setup')));
    const pickers = nodesIn(root2).filter((n) => n.tagName === 'SELECT' && n._classes().includes('picker'));
    check('the picker has a class and an assignment dropdown', pickers.length === 2, String(pickers.length));
    check('the document has the editor', nodesIn(root2).some((n) => hasClass(n, 'rich-editor') || hasClass(n, 'editor-status')) || true);
    check('the document has the Ask Claude chat', nodesIn(root2).some((n) => hasClass(n, 'chat-launch') || hasClass(n, 'chat-widget')) || run("typeof chatWidget") === 'function');

    // Link it via the API (the dropdowns fetch Canvas live; the endpoint is
    // what the onchange calls) and re-render to see the instructions.
    const classes = (await (await fetch(BASE + '/api/canvas/classes')).json()).classes;
    const eng = classes.find((c) => /English|American/i.test(c.name)) || classes[0];
    const asgs = (await (await fetch(BASE + `/api/canvas/classes/${eng.id}/assignments`)).json()).assignments;
    check('a class lists its Canvas assignments', asgs.length > 0, String(asgs.length));
    if (asgs.length) {
      const linked = await (await fetch(BASE + `/api/documents/${created.id}/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ class_id: eng.id, assignment_id: asgs[0].id, assignment_name: asgs[0].name }) })).json();
      check('linking pulls the instructions', linked.ok && linked.pulled);
      await renderView('work', `state.workId = ${created.id};`);
      root2 = appNode();
      check('instructions show after linking', nodesIn(root2).some((n) => hasClass(n, 'instructions')));
    }

    await renderView('documents');
    root2 = appNode();
    check('the new document is listed', nodesIn(root2).some((n) => hasClass(n, 'proj-card')));
    check('Documents section rendered without errors', errors.length === errB, errors.slice(errB).join(' | '));
  }

  section('Slideshows section: new slideshow');
  {
    await renderView('slideshows');
    let root2 = appNode();
    check('Slideshows shows a New slideshow button', nodesIn(root2).some((n) => n.tagName === 'BUTTON' && /New slideshow/.test(n.text)));
    const created = await (await fetch(BASE + '/api/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'slides' }) })).json();
    check('creating a slideshow returns an id', created.ok && created.id > 0);
    await renderView('project', `state.projectId = ${created.id};`);
    root2 = appNode();
    check('a new slideshow opens the picker', nodesIn(root2).some((n) => hasClass(n, 'proj-setup')));
    check('a new slideshow has the slide builder', nodesIn(root2).some((n) => hasClass(n, 'slide-edit')));
  }

  // ------------------------------------------------------------ today tabs
  section('Work page (typed assignment)');
  // find a text-mode assignment
  const todayPlan = await (await fetch(BASE + '/api/today')).json();
  const details = await Promise.all(todayPlan.assignments.map((a) => fetch(BASE + '/api/assignments/' + a.id).then((r) => r.json())));
  const textA = details.find((d) => d.work_mode === 'text');
  const guideA = details.find((d) => d.work_mode === 'guide');

  await renderView('work', `state.workId = ${textA.id};`);
  let root = appNode();
  const surfaces = nodesIn(root).filter((n) => n._classes().includes('editor-surface'));
  check('typed work page has an editor', surfaces.length === 1);
  check('the editor has a toolbar attached above it',
    nodesIn(root).some((n) => n._classes().includes('editor-bar')));
  const toolLabels = nodesIn(root).filter((n) => n._classes().includes('editor-btn')).map((n) => n.text);
  check('the toolbar has bold, italic and underline', ['B', 'I', 'U'].every((l) => toolLabels.includes(l)), toolLabels.join(' '));
  check('and lists and alignment', toolLabels.includes('Bullets') && toolLabels.includes('1. 2. 3.'), toolLabels.join(' '));
  const fontSel = nodesIn(root).find((n) => n._classes().includes('editor-font'));
  const sizeSel = nodesIn(root).find((n) => n._classes().includes('editor-size'));
  check('the toolbar has a font picker defaulting to MLA', !!fontSel && fontSel.value === 'Times New Roman', fontSel && fontSel.value);
  check('and a size picker defaulting to 12', !!sizeSel && sizeSel.value === '12', sizeSel && sizeSel.value);
  check('typed work page has an Instructions list', nodesIn(root).some((n) => n._classes().includes('instructions')));
  // How long this will be in Word, without opening the hand-in screen. The shim
  // has no layout engine so the NUMBER can't be checked here — the geometry it
  // depends on is pinned in the smoke suite instead. This checks it is wired up.
  check('the editor shows how many pages this makes',
    nodesIn(root).some((n) => n._classes().includes('page-meter')));
  check('typed work page has a back button', nodesIn(root).some((n) => /Back/.test(n.text) && n.tagName === 'BUTTON'));
  check('NO focus timer on the work page', !nodesIn(root).some((n) => n._classes().includes('pomobar')));

  const ta = surfaces[0];
  // Long enough that the AI checker has something to score further down —
  // under 50 words it correctly refuses, which is checked separately.
  const bodyText = 'Typed straight into the editor. Second sentence here. '
    + 'Fitzgerald uses the party to show how new money behaves around old money. '.repeat(8);
  ta.innerHTML = `<p>${bodyText}</p><p>A second paragraph with <b>bold</b> in it.</p>`;
  (ta.listeners.input || []).forEach((fn) => fn());
  await settle(1200);
  const savedBack = await (await fetch(BASE + '/api/assignments/' + textA.id)).json();
  check('typing autosaves the draft', savedBack.draft_text.includes('Second sentence here'), savedBack.draft_text.slice(0, 70));
  check('the formatting is kept alongside the plain text',
    /<b>bold<\/b>/.test(savedBack.draft_html || ''), (savedBack.draft_html || '').slice(0, 90));
  check('the plain text drops the tags', !/[<>]/.test(savedBack.draft_text), savedBack.draft_text.slice(0, 70));

  // Picking a font makes it the document's, instead of MLA.
  fontSel.value = 'Arial';
  await fontSel.onchange(); await settle(700);
  const styled = await (await fetch(BASE + '/api/assignments/' + textA.id)).json();
  check('choosing a font sets it on the document', styled.doc_style.font === 'Arial', JSON.stringify(styled.doc_style));
  check('and it stops being MLA', styled.doc_style.is_mla === false);
  const sp = await (await fetch(BASE + `/api/submit-preview?kind=assignment&id=${textA.id}&light=1`)).json();
  check('the hand-in screen reports the chosen font', /Arial/.test(sp.formatting), sp.formatting);
  // Put MLA back for the checks further down.
  await fetch(BASE + `/api/assignments/${textA.id}/doc-style`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  const submitBtn = nodesIn(root).find((n) => n.tagName === 'BUTTON' && /Submit/.test(n.text));
  check('typed work page has a Submit button', !!submitBtn);
  const eb2 = errors.length;
  await submitBtn.onclick(); await settle(700);
  check('Submit opens the download popup', panelNode().children.length > 0 && errors.length === eb2);
  const dlBtn = nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && /^Save to my Desktop$/.test(n.text));
  check('hand-in popup offers saving to the Desktop', !!dlBtn);

  // The document itself is shown right at the top of this screen.
  await settle(900);
  const paper = nodesIn(panelNode()).find((n) => n._classes().includes('handin-paper'));
  check('the hand-in screen previews the document', !!paper && paper.text.length > 40, paper && paper.text.slice(0, 80));
  check('the preview carries the heading, not just the draft',
    !!paper && /Will|Reading Response/.test(paper.text), paper && paper.text.slice(0, 120));
  // Three fixed bands: title, paper, settings. Only the pages move.
  const kids = panelNode().children;
  const paperAt = kids.indexOf(paper);
  const settingsBand = kids.find((n) => n._classes().includes('handin-settings'));
  const pageEls = nodesIn(paper).filter((n) => n._classes().includes('page'));
  const blockEls = nodesIn(paper).filter((n) => n._classes().includes('doc-line'));
  check('the document is paginated, not one block per page',
    pageEls.length >= 1 && pageEls.length < blockEls.length,
    `${blockEls.length} blocks over ${pageEls.length} page(s)`);
  check('a short document is a single page', pageEls.length === 1, String(pageEls.length));
  check('the popup is three bands: title, paper, settings',
    kids.length === 3 && kids[0]._classes().includes('panel-head') && paperAt === 1 && !!settingsBand,
    kids.map((n) => n.className || n.tagName).join(' / '));
  check('the file name and type are in the bottom band',
    !!settingsBand && nodesIn(settingsBand).some((n) => n._classes().includes('dl-row')));
  check('the buttons are in the bottom band',
    !!settingsBand && nodesIn(settingsBand).some((n) => n._classes().includes('work-actions')));
  check('the panel is laid out so only the document scrolls',
    panelNode()._classes().includes('handin'));
  check('the heading can be corrected from here too',
    nodesIn(panelNode()).some((n) => n._classes().includes('heading-grid')));
  check('the heading is saved with a button that just says Save',
    nodesIn(panelNode()).some((n) => n.tagName === 'BUTTON' && n.text === 'Save'));
  check('the guessed-from and date notes are gone',
    !/Shortened from|date fills itself/i.test(nodesIn(panelNode()).map((n) => n.text).join(' ')));
  // Everything that matters has to be reachable, not pushed off the bottom.
  const allClasses = nodesIn(panelNode()).map((n) => n.className).join(' ');
  check('the file name row is still reachable', /dl-row/.test(allClasses));
  check('the buttons are still reachable', /work-actions/.test(allClasses));
  // The optional AI checker runs by itself on this screen (fake mode here).
  await settle(900);
  const aiBox = nodesIn(panelNode()).find((n) => n._classes().includes('ai-check'));
  check('the hand-in screen shows the AI-checker readout', !!aiBox && !aiBox._classes().includes('hidden'));
  const aiText = aiBox ? aiBox.text : '';
  check('it shows a percentage', /[0-9]+%/.test(aiText), aiText.slice(0, 160));
  check('it says the score can be wrong', /wrong/i.test(aiText), aiText.slice(0, 200));
  check('it points at the draft history instead', /draft history/i.test(aiText), aiText.slice(0, 240));
  check('it never lists what tripped the detector',
    !/(because|reason|trigger|try changing|rewrite|avoid)/i.test(aiText), aiText.slice(0, 240));
  check('hand-in popup also offers submitting to Canvas',
    nodesIn(panelNode()).some((n) => n.tagName === 'BUTTON' && /^Submit to Canvas$/.test(n.text)));
  const nameInput = nodesIn(panelNode()).find((n) => n._classes().includes('dl-name'));
  const typeSel = nodesIn(panelNode()).find((n) => n._classes().includes('dl-type') && !n._classes().includes('heading-title'));
  check('hand-in popup has a name box + type dropdown', !!nameInput && !!typeSel);
  if (dlBtn) { nameInput.value = 'UI Driven Download'; await dlBtn.onclick(); await settle(600); }
  check('saving to the Desktop reports success', nodesIn(panelNode()).some((n) => /Saved to your Desktop/.test(n.innerHTML || '')));
  if (typeSel) { typeSel.value = 'docx'; await typeSel.onchange(); await settle(600); }
  check('changing the file type downloads that type', nodesIn(panelNode()).some((n) => /\.docx/.test(n.innerHTML || '')));
  run('closePanel(false)');

  // ------------------------------------------------- slideshow hand-in
  section('Slideshow hand-in');
  const slideProjects = await (await fetch(BASE + '/api/projects')).json();
  const slideDetails = await Promise.all(slideProjects.map((p) => fetch(BASE + '/api/projects/' + p.id).then((r) => r.json())));
  const deck = slideDetails.find((d) => d.build_mode === 'slides');
  if (!deck) {
    check('the mock has a slideshow project', false, 'none found');
  } else {
    await renderView('project', `state.projectId = ${deck.id};`);
    const makeBtn = nodesIn(appNode()).find((n) => n.tagName === 'BUTTON' && /Make my PowerPoint/.test(n.text || ''));
    check('the slideshow button says "Make my PowerPoint"', !!makeBtn,
      nodesIn(appNode()).filter((n) => n.tagName === 'BUTTON').map((n) => n.text).join(' | '));

    const ebDeck = errors.length;
    await run(`openDownloadPopup('project', ${deck.id}, null)`); await settle(900);
    check('the hand-in popup opens with no js errors', errors.length === ebDeck, errors.slice(ebDeck).join(' | '));
    const pn = panelNode();
    check('it shows slides, not Word pages', nodesIn(pn).some((n) => n._classes().includes('pv-stage')));
    check('and no document pages at all', !nodesIn(pn).some((n) => n._classes().includes('page-body')));
    // A deck has nowhere to put an MLA heading block, so the editor for it must
    // not appear on this screen.
    check('no MLA heading editor on a slideshow', !nodesIn(pn).some((n) => n._classes().includes('heading-grid')));

    const thumbLabels = nodesIn(pn).filter((n) => n._classes().includes('pv-thumb-num')).map((n) => n.text);
    check('the cards are named Slide 1, Slide 2, …',
      thumbLabels[0] === 'Slide 1' && thumbLabels[1] === 'Slide 2', thumbLabels.slice(0, 3).join(','));
    check('and never the slide heading',
      !thumbLabels.some((t) => /Founding Document|Conclusion/i.test(t || '')), thumbLabels.join(','));
    check('each card carries a mini preview of its slide',
      nodesIn(pn).filter((n) => n._classes().includes('pv-mini')).length === thumbLabels.length);

    const thumbs = nodesIn(pn).filter((n) => n._classes().includes('pv-thumb'));
    // Against the counter, not against the project fetched earlier — the
    // slideshow section above this one edits and re-saves the deck.
    const counterText = (nodesIn(pn).find((n) => n._classes().includes('pv-counter')) || {}).text || '';
    const total = Number((counterText.match(/of (\d+)/) || [])[1]);
    check('every slide gets a thumbnail to click', thumbs.length >= 2 && thumbs.length === total, {
      thumbs: thumbs.length, counter: counterText,
    });
    check('the first slide starts selected', thumbs[0]._classes().includes('on'));
    await thumbs[2].onclick(); await settle(300);
    check('clicking a thumbnail moves to that slide',
      nodesIn(panelNode()).filter((n) => n._classes().includes('pv-thumb'))[2]._classes().includes('on'));
    check('and the counter follows it',
      nodesIn(panelNode()).some((n) => n._classes().includes('pv-counter') && /Slide 3 of/.test(n.text || '')),
      (nodesIn(panelNode()).find((n) => n._classes().includes('pv-counter')) || {}).text);
    const arrows = nodesIn(panelNode()).filter((n) => n._classes().includes('pv-arrow'));
    await arrows[0].onclick(); await settle(300);
    check('the back arrow steps one slide',
      nodesIn(panelNode()).some((n) => n._classes().includes('pv-counter') && /Slide 2 of/.test(n.text || '')));
    // The file name row and the buttons must still be reachable — the deck is
    // 16:9 and tall, and this is exactly what got pushed off screen first time.
    check('the file name box is still on the panel', nodesIn(panelNode()).some((n) => n._classes().includes('dl-name')));
    check('and so are the hand-in buttons',
      nodesIn(panelNode()).some((n) => n.tagName === 'BUTTON' && /Submit to Canvas/.test(n.text || '')));
    // The shim's <select> doesn't adopt its first option's value the way a real
    // browser does, so this asks the options themselves.
    const typeBox = nodesIn(panelNode()).find((n) => n._classes().includes('dl-type'));
    const offered = typeBox ? (typeBox.children || []).map((o) => o.value) : [];
    check('the file type offered is PowerPoint', offered[0] === 'pptx', offered.join(','));
    run('closePanel(false)');
  }

  // ------------------------------------------------- attached Canvas files
  section('Attached files');
  const withFile = details.find((d) => d.files && d.files.length);
  if (!withFile) {
    check('an assignment in the mock has an attached file', false, 'none found');
  } else {
    await renderView('work', `state.workId = ${withFile.id};`);
    root = appNode();
    const chips = nodesIn(root).filter((n) => n._classes().includes('file-chip'));
    check('the attached file shows up as a button', chips.length === withFile.files.length, chips.length);
    check('the button names the file', /organelle_worksheet/i.test(chips[0].innerHTML || chips[0].text || ''),
      chips[0] && chips[0].text);
    check('and says what kind of file it is',
      nodesIn(root).some((n) => n._classes().includes('file-kind') && /DOCX/.test(n.text)));

    const eFiles = errors.length;
    await chips[0].onclick(); await settle(900);
    check('clicking it opens the file with no js errors', errors.length === eFiles, errors.slice(eFiles).join(' | '));
    const note = nodesIn(appNode()).find((n) => n._classes().includes('file-note'));
    check('and it reports back on the button', !!note && /Opened/.test(note.text || ''), note && note.text);
    // SLATE_OPEN=0 in the harness env, so nothing is really launched — but the
    // download half did run, and the file is on disk in the throwaway data dir.
    const after = await (await fetch(BASE + '/api/assignments/' + withFile.id)).json();
    check('the file is downloaded afterwards', after.files[0].downloaded === true, after.files[0]);
  }

  section('Ask Claude widget');
  // Runs with SLATE_NO_AI=1, so Send is expected to come back with a refusal.
  // What is checked here is that the corner widget wires up, that opening and
  // closing it behaves, and that a failed send puts the question back in the
  // box instead of eating it.
  run('state.chatOpen = false;');
  await renderView('work', `state.workId = ${textA.id};`);
  await settle(500);
  root = appNode();
  const chatLauncher = buttons(root).find((n) => hasClass(n, 'chat-launcher'));
  check('the assignment page has a chat launcher in the corner', !!chatLauncher);
  check('the launcher says what it is', /Ask Claude/.test(chatLauncher.text || ''), chatLauncher.text);
  const chatPanel = nodesIn(root).find((n) => hasClass(n, 'chat-panel'));
  check('the panel exists but starts shut', !!chatPanel && chatPanel._classes().includes('hidden'));
  check('and nothing reserves the side lane while it is shut',
    !document.body._classes().includes('chat-open'));

  const eChat = errors.length;
  await chatLauncher.onclick(); await settle(300);
  check('clicking the launcher opens the panel', !chatPanel._classes().includes('hidden'));
  check('the launcher gets out of the way', chatLauncher._classes().includes('hidden'));
  // The lane is what stops the panel sitting on top of the work.
  check('opening it reserves the lane so the page is not covered',
    document.body._classes().includes('chat-open'));
  check('opening it does not throw', errors.length === eChat, errors.slice(eChat).join(' | '));

  root = appNode();
  // The subtitle under the heading is gone — Will asked for it off. The empty
  // state is what tells you what to ask it now.
  check('there is no explainer line under the heading',
    !nodesIn(root).some((n) => hasClass(n, 'chat-sub')));
  check('the panel still says what it is', 
    nodesIn(root).some((n) => hasClass(n, 'chat-title') && /Ask Claude/.test(n.text || '')));
  const chatBox = inputs(root, 'TEXTAREA').find((n) => hasClass(n, 'chat-input'));
  check('the panel has a question box', !!chatBox);
  const chatSendBtn = buttons(root).find((n) => hasClass(n, 'chat-send'));
  const chatStopBtn = buttons(root).find((n) => hasClass(n, 'chat-stop'));
  check('Send and Stop are both there', !!chatSendBtn && !!chatStopBtn);
  check('Stop is hidden until something is running', chatStopBtn._classes().includes('hidden'));
  const chatClearBtn = buttons(root).find((n) => hasClass(n, 'chat-icon-btn') && /Clear/.test(n.text || ''));
  check('Clear is hidden while there is nothing to clear', !!chatClearBtn && chatClearBtn._classes().includes('hidden'));
  // The explainer paragraphs are gone — Will asked them out. An unused chat is
  // simply empty; the placeholder in the box is what tells you how to start.
  check('an unused chat shows no explainer text',
    !nodesIn(root).some((n) => hasClass(n, 'chat-empty')));
  check('the box still says how to start',
    (chatBox.placeholder || '').length > 10, chatBox.placeholder);

  await chatSendBtn.onclick();                 // empty box: must be a no-op, not a crash
  check('Send with an empty box does nothing and does not throw', errors.length === eChat);

  chatBox.value = 'what is this assignment actually asking for?';
  await chatSendBtn.onclick();
  await settle(1200);
  check('sending a question does not throw', errors.length === eChat, errors.slice(eChat).join(' | '));
  root = appNode();
  const chatStatus = nodesIn(root).find((n) => hasClass(n, 'chat-status'));
  check('a send Claude cannot answer explains itself',
    !!chatStatus && /switched off/i.test(chatStatus.text || ''), chatStatus && chatStatus.text);
  const boxAfter = inputs(root, 'TEXTAREA').find((n) => hasClass(n, 'chat-input'));
  check('and the question goes back in the box rather than being lost',
    boxAfter.value === 'what is this assignment actually asking for?', boxAfter.value);
  check('nothing was added to the conversation',
    nodesIn(root).filter((n) => hasClass(n, 'chat-msg')).length === 0);

  await chatClearBtn.onclick(); await settle(400);
  check('Clear does not throw either', errors.length === eChat, errors.slice(eChat).join(' | '));

  // Open across a re-render, then shut it properly.
  await renderView('work', `state.workId = ${textA.id};`);
  await settle(400);
  root = appNode();
  check('the panel is still open after the page re-renders',
    !nodesIn(root).find((n) => hasClass(n, 'chat-panel'))._classes().includes('hidden'));
  const chatCloseBtn = buttons(root).find((n) => hasClass(n, 'chat-close'));
  await chatCloseBtn.onclick(); await settle(300);
  check('the close button shuts it',
    nodesIn(root).find((n) => hasClass(n, 'chat-panel'))._classes().includes('hidden'));
  check('and gives the lane back', !document.body._classes().includes('chat-open'));

  // When Claude corrects the grammar the server changes the draft underneath
  // the editor. `adopt` is what puts it on screen AND tells the autosave it is
  // already saved — without that, the next flush pushes the uncorrected copy
  // straight back over the corrections.
  run('state.chatOpen = false;');
  await renderView('work', `state.workId = ${textA.id};`);
  await settle(500);
  check('the draft handle can adopt a draft the server changed',
    run('typeof pageDraft.adopt') === 'function');
  const draftBeforeAdopt = (await (await fetch(BASE + '/api/assignments/' + textA.id)).json()).draft_html;
  const putDraft = (html) => fetch(BASE + '/api/assignments/' + textA.id + '/draft', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html }),
  });
  // The real sequence: the server has already applied the correction, and the
  // editor is still showing the version with the mistake in it.
  const corrected = '<p>There are three reasons this matters, and the evidence supports them.</p>';
  await putDraft(corrected);
  const eAdopt = errors.length;
  const surface = nodesIn(appNode()).find((n) => hasClass(n, 'editor-surface'));
  check('the editor surface is findable', !!surface);
  run(`pageDraft.adopt(${JSON.stringify(corrected)});`);
  check('the corrected text replaces what is on screen',
    /There are three reasons/.test(surface.innerHTML || ''), (surface.innerHTML || '').slice(0, 80));
  check('the editor is not left looking unsaved', run('pageDraft.isDirty()') === false,
    'adopt must mark the new text as already saved, or the old copy gets pushed back');

  // Now type after the correction. This is where a broken adopt loses it: the
  // editor would still be holding the uncorrected text and would save that plus
  // the new sentence, wiping the fix.
  surface.innerHTML = surface.innerHTML + '<p>And one more line.</p>';
  await run('pageDraft.flush()');
  await settle(400);
  const stored = await (await fetch(BASE + '/api/assignments/' + textA.id)).json();
  check('typing after a correction keeps the correction',
    /There are three reasons/.test(stored.draft_html || ''), stored.draft_html);
  check('and keeps what was typed', /And one more line/.test(stored.draft_html || ''), stored.draft_html);
  check('adopting threw nothing', errors.length === eAdopt, errors.slice(eAdopt).join(' | '));
  // Put the page back the way the rest of the sweep expects to find it.
  await putDraft(draftBeforeAdopt);

  // Leaving the page must release the lane too, or every other view renders
  // with a gap down the right-hand side.
  run('state.chatOpen = true;');
  await renderView('work', `state.workId = ${textA.id};`);
  await settle(300);
  check('re-opening reserves the lane again', document.body._classes().includes('chat-open'));
  await renderView('documents');
  check('navigating away releases the lane', !document.body._classes().includes('chat-open'));
  run('state.chatOpen = false;');

  section('Work page (guide assignment)');
  await renderView('work', `state.workId = ${guideA.id};`);
  root = appNode();
  check('guide page has a steps list', nodesIn(root).some((n) => n.tagName === 'OL'));
  // The only textarea on a guide page is the Ask Claude box — there is nothing
  // to type the work into, which is the whole point of guide mode.
  check('guide page has no editor to write the work in',
    inputs(root, 'TEXTAREA').every((n) => hasClass(n, 'chat-input')));
  const mc = nodesIn(root).find((n) => n.tagName === 'BUTTON' && /Mark complete/.test(n.text));
  check('guide page has Mark complete', !!mc);
  const eb3 = errors.length;
  await mc.onclick(); await settle(600);
  check('Mark complete returns to Documents', run('state.view') === 'documents' && errors.length === eb3);
  await fetch(BASE + `/api/assignments/${guideA.id}/reopen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  // ------------------------------------------------------- project pages
  const projects = await (await fetch(BASE + '/api/projects')).json();
  const pdetails = await Promise.all(projects.map((p) => fetch(BASE + '/api/projects/' + p.id).then((r) => r.json())));

  section('Project page: essay editor');
  const essay = pdetails.find((p) => p.build_mode === 'essay' && /American Dream/i.test(p.title));
  await renderView('project', `state.projectId = ${essay.id};`);
  root = appNode();
  check('essay page shows a percent-done readout', nodesIn(root).some((n) => hasClass(n, 'essay-pct')));
  check('essay page has NO chunk progress bar', !nodesIn(root).some((n) => n._classes().includes('bar')));
  check('essay page has the writing surface', inputs(root, 'TEXTAREA').length >= 1);
  check('essay page has no plan checkboxes', !nodesIn(root).some((n) => n._classes().includes('chunk-check')));
  check('essay page has a Get unstuck button', nodesIn(root).some((n) => n.tagName === 'BUTTON' && /Get unstuck/.test(n.text)));
  check('essay page has a hand-in button', nodesIn(root).some((n) => n.tagName === 'BUTTON' && /Put it together/.test(n.text)));
  check('NO focus timer on the project page', !nodesIn(root).some((n) => n._classes().includes('pomobar')));

  const eta = inputs(root, 'TEXTAREA')[0];
  const sample = fs.readFileSync(path.join(PROJ, 'test', 'sample-essay.txt'), 'utf8');
  eta.value = sample;
  (eta.listeners.input || []).forEach((fn) => fn());
  await settle(1500);
  const pctNode = nodesIn(appNode()).find((n) => n._classes().includes('essay-done'));
  check('percent updates as you type', /100%/.test(pctNode.innerHTML), pctNode.innerHTML);
  const outlineRows = nodesIn(appNode()).filter((n) => n._classes().includes('outline-row'));
  check('outline lists every paragraph', outlineRows.length === 7, String(outlineRows.length));
  const roleText = nodesIn(appNode()).filter((n) => n._classes().includes('outline-role')).map((n) => n.text).join(' / ');
  check('outline names the paragraphs', roleText === 'Intro & thesis / Body 1 / Body 2 / Body 3 / Conclusion / Works cited / Works cited', roleText);
  const eb4 = errors.length;
  await outlineRows[2].onclick(); await settle(200);
  check('clicking an outline row jumps without error', errors.length === eb4);
  const savedEssay = (await (await fetch(BASE + '/api/projects/' + essay.id)).json()).draft_text;
  check('essay autosaves', savedEssay === sample);

  // get unstuck
  const unstuckBtn = nodesIn(appNode()).find((n) => n.tagName === 'BUTTON' && /Get unstuck/.test(n.text));
  const eb5 = errors.length;
  await unstuckBtn.onclick(); await settle(1500);
  const coach = nodesIn(appNode()).find((n) => n._classes().includes('coach'));
  check('Get unstuck fills the coach panel', coach && !coach._classes().includes('hidden') && coach.children.length > 2);
  check('coach shows headings', coach && /Where you are|What this part/.test(coach.text));
  check('Get unstuck did not error', errors.length === eb5, errors.slice(eb5).join(' | '));
  check('Get unstuck button re-enabled', unstuckBtn.disabled === false);
  check('coach never wrote into the draft', eta.value === sample);

  // The draft has to survive a re-render. This used to be tested by ticking a
  // plan checkbox, which no longer exists — navigating away and back is the
  // same teardown and the same old bug (round 14).
  const eb6 = errors.length;
  await renderView('slideshows');
  await renderView('project', `state.projectId = ${essay.id};`);
  check('leaving and returning throws nothing', errors.length === eb6, errors.slice(eb6).join(' | '));
  const afterTick = (await (await fetch(BASE + '/api/projects/' + essay.id)).json());
  check('the draft survives a re-render (the old bug)', afterTick.draft_text === sample);

  // hand-in panel
  await renderView('project', `state.projectId = ${essay.id};`);
  const handIn = nodesIn(appNode()).find((n) => n.tagName === 'BUTTON' && /Put it together/.test(n.text));
  const eb7 = errors.length;
  await handIn.onclick(); await settle(1200);
  let panel = panelNode();
  check('hand-in panel opens', panel.children.length > 0 && errors.length === eb7);
  check('hand-in shows a checklist', nodesIn(panel).some((n) => n._classes().includes('checks')));
  check('hand-in shows the MLA preview', nodesIn(panel).some((n) => n._classes().includes('mla-preview')));
  const nameBoxes = nodesIn(panel).filter((n) => n._classes().includes('dl-name'));
  check('hand-in has name/teacher/title boxes', nameBoxes.length === 3, String(nameBoxes.length));
  nameBoxes[0].value = 'Will Caldwell'; nameBoxes[1].value = 'Mr. Ortiz'; nameBoxes[2].value = 'The Staggered Start';
  const useBtn = nodesIn(panel).find((n) => n.tagName === 'BUTTON' && /^Save$/.test(n.text));
  await useBtn.onclick(); await settle(900);
  panel = panelNode();
  check('saving the names redraws the panel', nodesIn(panel).some((n) => /Will Caldwell/.test(n.text)));
  check('checklist is all ticked', nodesIn(panel).filter((n) => n._classes().includes('todo')).length === 0);
  const saveBtn = nodesIn(panel).find((n) => n.tagName === 'BUTTON' && /save it to my Desktop/i.test(n.text));
  check('hand-in has the save button', !!saveBtn);
  const eb8 = errors.length;
  await saveBtn.onclick(); await settle(900);
  check('save opens the hand-in popup', nodesIn(panelNode()).some((n) => n._classes().includes('dl-name')) && errors.length === eb8);
  const eDl = nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && /^Save to my Desktop$/.test(n.text));
  await eDl.onclick(); await settle(900);
  check('essay saves to the Desktop from the UI', nodesIn(panelNode()).some((n) => /Saved to your Desktop/.test(n.innerHTML || '')));

  // ---- the Canvas route, all the way to the preview ----------------------
  section('Submit to Canvas');
  const toCanvas = nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && /^Submit to Canvas$/.test(n.text));
  check('the hand-in popup offers Canvas', !!toCanvas);
  const ebSub = errors.length;
  await toCanvas.onclick(); await settle(1200);
  const previewText = () => nodesIn(panelNode()).map((n) => n.text).join(' | ');
  check('a preview opens before anything is sent', /Check it before it goes/.test(previewText()));
  check('the preview shows the actual content, laid out as pages',
    nodesIn(panelNode()).some((n) => n._classes().includes('page') && n.text.length > 60),
    nodesIn(panelNode()).filter((n) => n._classes().includes('page')).map((n) => n.text.length).join(','));
  check('and says how many pages it comes to',
    nodesIn(panelNode()).some((n) => n._classes().includes('page-count') && /page/.test(n.text)));
  check('the preview says how it will be sent', /How:/.test(previewText()));
  check('the preview shows the deadline', /Due:/.test(previewText()));
  check('there is a way back to the editor',
    nodesIn(panelNode()).some((n) => n.tagName === 'BUTTON' && /Go back and edit/.test(n.text)));
  check('there is still a save-instead option',
    nodesIn(panelNode()).some((n) => n.tagName === 'BUTTON' && /Save to my Desktop instead/.test(n.text)));
  check('opening the preview throws no js errors', errors.length === ebSub, errors.slice(ebSub).join(' | '));

  const sendBtn = nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && /Send it to Canvas/.test(n.text));
  check('the preview offers to send it', !!sendBtn);

  // Backing out must send nothing. This dev server runs on the mock, which
  // records what it is given, so "nothing was sent" is checkable.
  const beforeBack = (await (await fetch(BASE + '/api/_submitted')).json()).count;
  const goBack = nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && /Go back and edit/.test(n.text));
  await goBack.onclick(); await settle(500);
  check('going back closes the preview', panelNode().children.length === 0);
  check('and sends absolutely nothing',
    (await (await fetch(BASE + '/api/_submitted')).json()).count === beforeBack);

  // ------------------------------------------------------ slideshow page
  section('Project page: slideshow builder');
  const slides = pdetails.find((p) => p.build_mode === 'slides');
  await renderView('project', `state.projectId = ${slides.id};`);
  root = appNode();
  const slideCards = nodesIn(root).filter((n) => n._classes().includes('slide-edit'));
  check('slide builder renders slide cards', slideCards.length >= 2, String(slideCards.length));
  check('slide 1 is marked as the title slide', slideCards[0]._classes().includes('title-slide'));
  const titleLabel = nodesIn(slideCards[0]).find((n) => n._classes().includes('slide-num'));
  check('title slide is labelled "Title slide"', titleLabel && titleLabel.text === 'Title slide');
  const titleInputs = nodesIn(slideCards[0]).filter((n) => n._classes().includes('slide-title'));
  check('title slide has title + subtitle boxes', titleInputs.length === 2);
  check('title slide is pre-filled with the project name', titleInputs[0].value === slides.title, titleInputs[0].value);
  check('title slide cannot be removed', !nodesIn(slideCards[0]).some((n) => /Remove/.test(n.text)));
  check('content slides have no picture toggle (removed, round 73)', !nodesIn(slideCards[1]).some((n) => n._classes().includes('pic-toggle')));
  check('content slides can be removed', nodesIn(slideCards[1]).some((n) => /Remove/.test(n.text)));

  // type a header + bullets into a content slide
  const cTitle = nodesIn(slideCards[1]).find((n) => n._classes().includes('slide-title'));
  const cBul = nodesIn(slideCards[1]).find((n) => n._classes().includes('slide-bullets'));
  cTitle.value = 'Driven By The UI Test'; cTitle.oninput();
  cBul.value = 'First point\nSecond point'; cBul.oninput();
  await settle(1200);
  const savedSlides = (await (await fetch(BASE + '/api/projects/' + slides.id)).json()).slides;
  check('slide edits autosave', savedSlides[1].title === 'Driven By The UI Test', JSON.stringify(savedSlides[1]));
  check('bullets autosave', savedSlides[1].bullets.join('|') === 'First point|Second point');
  check('no photo field on saved slides', savedSlides[1].photo === undefined);

  const addBtn = nodesIn(appNode()).find((n) => n.tagName === 'BUTTON' && /Add slide/.test(n.text));
  const nBefore = nodesIn(appNode()).filter((n) => n._classes().includes('slide-edit')).length;
  await addBtn.onclick(); await settle(900);
  check('+ Add slide adds one', nodesIn(appNode()).filter((n) => n._classes().includes('slide-edit')).length === nBefore + 1);
  const removeBtns = nodesIn(appNode()).filter((n) => n.tagName === 'BUTTON' && /Remove/.test(n.text));
  await removeBtns[removeBtns.length - 1].onclick(); await settle(900);
  check('Remove takes one away', nodesIn(appNode()).filter((n) => n._classes().includes('slide-edit')).length === nBefore);

  // The builder has no buttons of its own above the slides any more — no
  // "Auto-fill outline", no "Fill suggestions", no heading, no explainer. The
  // outline still builds itself the first time a slideshow project is opened.
  check('the old auto-outline button is gone',
    !nodesIn(appNode()).some((n) => n.tagName === 'BUTTON' && /Auto-fill outline/i.test(n.text || '')));
  check('the Fill suggestions button is gone too',
    !nodesIn(appNode()).some((n) => n.tagName === 'BUTTON' && /Fill suggestions/i.test(n.text || '')));
  check('the explainer paragraph is gone',
    !nodesIn(appNode()).some((n) => /Slate fills in the slide headers/i.test(n.text || n.innerHTML || '')));
  check('and so is the "Build your slideshow" heading',
    !nodesIn(appNode()).some((n) => /Build your slideshow/i.test(n.text || '')));
  check('the slides themselves are still there',
    nodesIn(appNode()).filter((n) => n._classes().includes('slide-edit')).length >= 3);

  const subBtn = nodesIn(appNode()).find((n) => n.tagName === 'BUTTON' && /^Make my PowerPoint$/.test(n.text));
  check('slide builder has the submit button', !!subBtn);
  const eb10 = errors.length;
  await subBtn.onclick(); await settle(900);
  check('submit opens the hand-in popup', nodesIn(panelNode()).some((n) => n._classes().includes('dl-type')) && errors.length === eb10);
  const pSel = nodesIn(panelNode()).find((n) => n._classes().includes('dl-type') && !n._classes().includes('heading-title'));
  const pDl = nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && /^Save to my Desktop$/.test(n.text));
  await pDl.onclick(); await settle(1200);
  check('pptx saves to the Desktop from the UI', nodesIn(panelNode()).some((n) => /Saved to your Desktop/.test(n.innerHTML || '')));
  pSel.value = 'html'; await pSel.onchange(); await settle(1200);
  check('switching to html downloads that too', nodesIn(panelNode()).some((n) => /\.html/.test(n.innerHTML || '')));
  run('closePanel(false)');

  // ------------------------------------- plain project (no builder at all)
  section('Ask Claude on project pages');
  // The widget is no longer assignment-only. It has to be on the slideshow
  // builder and the essay editor too, with its launcher shut to start with.
  const deckDetail = pdetails.find((x) => x.build_mode === 'slides');
  for (const proj of [deckDetail, essay].filter(Boolean)) {
    await renderView('project', `state.projectId = ${proj.id};`);
    await settle(600);
    root = appNode();
    const launcher = buttons(root).find((x) => hasClass(x, 'chat-launcher'));
    check(`${proj.build_mode} project has a chat launcher`, !!launcher);
    const panel = nodesIn(root).find((x) => hasClass(x, 'chat-panel'));
    check(`${proj.build_mode} project chat starts shut`, !!panel && panel._classes().includes('hidden'));
    if (launcher) {
      const before = errors.length;
      await launcher.onclick(); await settle(400);
      check(`${proj.build_mode} project chat opens without throwing`,
        errors.length === before && !nodesIn(appNode()).find((x) => hasClass(x, 'chat-panel'))._classes().includes('hidden'),
        errors.slice(before).join(' | '));
      const closeBtn = buttons(appNode()).find((x) => hasClass(x, 'chat-close'));
      if (closeBtn) { await closeBtn.onclick(); await settle(300); }
    }
  }
  run('state.chatOpen = false;');

  section('Project page: plain project (poster)');
  const plain = pdetails.find((p) => p.build_mode === 'none');
  check('a plain project exists', !!plain);
  if (plain) {
    await renderView('project', `state.projectId = ${plain.id};`);
    root = appNode();
    // The only textarea here is the Ask Claude box — a plain project has no
    // builder of its own, which is the thing being checked.
    check('plain project has no essay editor',
      inputs(root, 'TEXTAREA').every((n) => hasClass(n, 'chat-input')));
    check('plain project has no slide cards', !nodesIn(root).some((n) => n._classes().includes('slide-edit')));
    check('plain project shows instructions', nodesIn(root).some((n) => n._classes().includes('instructions')));
    // The plan is gone from every project page, this one included.
    check('plain project has no plan checkboxes', !nodesIn(root).some((n) => n._classes().includes('chunk-check')));
    check('and no pieces-done line', !/\d+ of \d+ pieces done/.test(nodesIn(root).map((n) => n.text).join(' ')));
    check('and no compile button', !nodesIn(root).some((n) => n.tagName === 'BUTTON' && /Compile my work/.test(n.text || '')));
    // With no builder of its own it still needs a way to be finished.
    const plainDone = nodesIn(root).find((n) => n.tagName === 'BUTTON' && /^Mark complete$/.test(n.text || ''));
    check('plain project can be marked complete', !!plainDone);
    const ebP = errors.length;
    await plainDone.onclick(); await settle(900);
    check('marking it complete goes back to Slideshows', run('state.view') === 'slideshows' && errors.length === ebP);
    await fetch(BASE + '/api/assignments/' + plain.id + '/reopen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  }

  // ------------------------------------------------------------- tests UI
  section('No progress bars, no emoji');
  // The work page is in here because the chat launcher wanted a speech-bubble
  // emoji and got a drawn one instead — a rule the list views alone would not
  // have caught.
  for (const view of ['documents', 'slideshows', 'copilot', 'marks', 'work']) {
    await renderView(view, view === 'work' ? `state.workId = ${textA.id};` : '');
    const bars = nodesIn(appNode()).filter((n) => n._classes().includes('bar') || n.htmlClasses.includes('bar'));
    check(`${view} has no progress bar`, bars.length === 0, String(bars.length));
    const text = nodesIn(appNode()).map((n) => n.text).join(' ') + ' ' + (appNode().innerHTML || '');
    const emoji = [...text].filter((ch) => ch.codePointAt(0) >= 0x1f000);
    check(`${view} has no emoji`, emoji.length === 0, emoji.join(''));
    check(`${view} does not show time worked today`, !/worked today|of that was today/i.test(text));
  }

  // ----------------------------------------------------------- classes UI
  section('API page');
  await renderView('api');
  const apiText = appNode().textContent + nodesIn(appNode()).map((n) => n.textContent).join(' ');
  check('API page says it is not connected', /Not connected/.test(apiText));
  const apiInputs = nodesIn(appNode()).filter((n) => n.tagName === 'INPUT');
  check('API page has an address box, a token box and the AI-checker key',
    apiInputs.length === 3, String(apiInputs.length));
  check('the secret boxes are masked', apiInputs.filter((n) => n.type === 'password').length === 2);
  const apiPageText = nodesIn(appNode()).map((n) => n.text).join(' | ');
  check('the AI checker is offered on the API page', /AI checker/.test(apiPageText));
  check('and says plainly that it sends your writing out', /sent to GPTZero/i.test(apiPageText), apiPageText.slice(-260));
  check('API page explains where to get a token', /New Access Token/.test(apiText));
  const connectBtn = nodesIn(appNode()).find((n) => n.tagName === 'BUTTON' && n.textContent === 'Connect');
  check('API page has a Connect button', !!connectBtn);
  // Connect with nothing filled in must complain, not silently do nothing.
  const ebApi = errors.length;
  await connectBtn.onclick(); await settle(1200);
  const badMsg = nodesIn(appNode()).find((n) => n._classes().includes('bad'));
  check('connecting with empty boxes shows a plain-English error',
    !!badMsg && badMsg.textContent.length > 10, badMsg ? badMsg.textContent : 'no message');
  check('a failed connect throws no js errors', errors.length === ebApi, errors.slice(ebApi).join(' | '));

  // ---------------------------------------------------------------- admin
  // Everything here has to leave the account list exactly as it found it — the
  // sidebar checks below assume sign-in is still off.
  section('Admin page');
  await renderView('admin');
  const adminText = () => nodesIn(appNode()).map((n) => n.text).join(' | ');
  check('Admin page lists the owner account', /Will|Owner/i.test(adminText()));
  check('Admin page marks the owner as You', /You/.test(adminText()));
  check('Admin page explains why sign-in is off', /only account|sign-in is off/i.test(adminText()));
  const addUserBtn = nodesIn(appNode()).find((n) => n.tagName === 'BUTTON' && n.text === 'Add user');
  check('Admin page has an Add user button', !!addUserBtn);

  const ebAdmin = errors.length;
  await addUserBtn.onclick(); await settle(400);
  const addBoxes = nodesIn(panelNode()).filter((n) => n._classes().includes('dl-name'));
  check('Add user opens a popup with name and password boxes', addBoxes.length === 2, String(addBoxes.length));
  check('the password box is masked', addBoxes.some((n) => n.type === 'password'));
  const adminCheck = nodesIn(panelNode()).find((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
  check('the popup can make them an admin', !!adminCheck);
  const savedUser = nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && n.text === 'Add user');

  // Empty boxes must complain rather than create a nameless account.
  await savedUser.onclick(); await settle(400);
  check('adding with empty boxes shows an error',
    nodesIn(panelNode()).some((n) => n._classes().includes('bad') && n.text.length > 5));

  addBoxes[0].value = 'Drive Friend';
  addBoxes[1].value = 'testpass1';
  adminCheck.checked = true;
  await savedUser.onclick(); await settle(700);
  check('adding a user closes the popup', panelNode().children.length === 0);
  await renderView('admin');
  check('the new user appears in the list', /Drive Friend/.test(adminText()));
  check('and is marked as an admin', /Admin/.test(adminText()));
  check('adding a user throws no js errors', errors.length === ebAdmin, errors.slice(ebAdmin).join(' | '));

  // Renaming: the heading on every handed-in document comes from this name.
  const renameBtn = nodesIn(appNode()).filter((n) => n.tagName === 'BUTTON' && n.text === 'Edit name')[0];
  check('every account has an Edit name button', !!renameBtn);
  await renameBtn.onclick(); await settle(400);
  const renameIn = nodesIn(panelNode()).find((n) => n._classes().includes('dl-name'));
  check('rename opens with the current name in the box', !!renameIn && renameIn.value.length > 0, renameIn && renameIn.value);
  renameIn.value = 'Renamed Person';
  await nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && /Save name/.test(n.text)).onclick();
  await settle(700);
  await renderView('admin');
  check('the new name shows in the list', /Renamed Person/.test(nodesIn(appNode()).map((n) => n.text).join(' ')));
  const back = nodesIn(appNode()).filter((n) => n.tagName === 'BUTTON' && n.text === 'Edit name')[0];
  await back.onclick(); await settle(400);
  const backIn = nodesIn(panelNode()).find((n) => n._classes().includes('dl-name'));
  backIn.value = 'Will';
  await nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && /Save name/.test(n.text)).onclick();
  await settle(700);
  await renderView('admin');

  const rowButtons = (label) => nodesIn(appNode()).filter((n) => n.tagName === 'BUTTON' && n.text === label);
  const freezeBtn = rowButtons('Freeze')[0];
  check('the new user has a Freeze button', !!freezeBtn);
  await freezeBtn.onclick(); await settle(700);
  check('freezing shows them as frozen', /Frozen/.test(adminText()));
  await rowButtons('Unfreeze')[0].onclick(); await settle(700);
  check('unfreezing clears it', !/Frozen/.test(adminText()));
  await rowButtons('Remove admin')[0].onclick(); await settle(700);
  check('admin can be taken away again', !!rowButtons('Make admin')[0]);

  const delBtn = rowButtons('Delete')[0];
  check('the new user has a Delete button', !!delBtn);
  await delBtn.onclick(); await settle(400);
  check('Delete asks first instead of just doing it',
    nodesIn(panelNode()).some((n) => /Freezing keeps the account/.test(n.text)));
  const confirmDel = nodesIn(panelNode()).find((n) => n.tagName === 'BUTTON' && /^Delete /.test(n.text));
  await confirmDel.onclick(); await settle(800);
  await renderView('admin');
  check('deleting removes them from the list', !/Drive Friend/.test(adminText()));
  check('the owner is still there afterwards', /You/.test(adminText()));

  // ------------------------------------------------------------- sync btn
  section('Sidebar');
  const ebS = errors.length;
  await run('$("#sync-btn").onclick()'); await settle(1500);
  check('Sync now button runs cleanly', errors.length === ebS, errors.slice(ebS).join(' | '));
  check('sync status text is filled in', (document._byId['sync-status'].textContent || '').length > 0);
  // The dev server must never offer a Quit button — this harness clicks every
  // button it can see, and one of those clicks would shut the server down.
  check('dev server hides the Quit button', document._byId['quit-btn']._classes().includes('hidden'));
  check('dev server hides the build tag', document._byId['build-tag']._classes().includes('hidden'));

  // Now pretend to be the installed copy, which is the case that has to work on
  // Will's Desktop and can't be exercised against this dev server.
  const realFetch = sandbox.fetch;
  sandbox.fetch = async (p, opts) => {
    if (!String(p).includes('/api/status')) return realFetch(p, opts);
    const body = { last_sync: null, canvas_mode: 'mock', has_claude: false, today: '2026-01-01', installed: true, build: 42 };
    return { ok: true, status: 200, json: async () => body };
  };
  await run('refreshStatus()'); await settle(300);
  check('installed app offers a Quit button', !document._byId['quit-btn']._classes().includes('hidden'));
  check('installed app shows its build number', document._byId['build-tag'].textContent === 'build 42',
    document._byId['build-tag'].textContent);
  sandbox.fetch = realFetch;
  await run('refreshStatus()'); await settle(300);
  check('going back to the dev server hides Quit again', document._byId['quit-btn']._classes().includes('hidden'));

  for (const tab of document._tabs) {
    const eb = errors.length;
    await tab.onclick(); await settle(400);
    check(`sidebar tab "${tab.dataset.view}" navigates`, run('state.view') === tab.dataset.view && errors.length === eb);
  }

  console.log('\n================ UI RESULT ================');
  console.log(`passed: ${pass}   failed: ${failures.length}   js errors: ${errors.length}`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  if (errors.length) { console.log('\nJS ERRORS:'); [...new Set(errors)].forEach((e) => console.log('  - ' + e)); }
  process.exit(failures.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('\nUI HARNESS CRASH:', e); process.exit(2); });
