'use strict';
// Applying Claude's edits to a draft.
//
// This module does not decide what an edit is allowed to *say* — no size caps,
// no word-count gates. It does decide what an edit is allowed to *do to the
// process and the markup*, which is a different thing: a pattern may not hang
// the event loop, and a correction may not leave the draft as invalid HTML.
//
// Two invariants hold everywhere below:
//   1. When `html` is present it is the source of truth. `text` is always
//      derived from it, never edited in parallel. They cannot drift.
//   2. `applied` means the draft really changed. `skipped` carries a reason
//      that is true of what actually happened, not the nearest generic one.

// Retained as exports so anything importing them still resolves. Nothing reads
// them; they are Infinity and mean "no cap".
const MAX_EDITS = Infinity;
const MAX_FIND_CHARS = Infinity;
const MAX_GROWTH_CHARS = Infinity;
const MAX_WORDS_CHANGED = Infinity;

// Which matches an edit touches when `find` appears more than once.
// 'first' (default) | 'all' | 'last' | a 1-based integer.
//
// The default is 'first' on purpose. A bare find of "the" would otherwise
// rewrite every "the" in the essay in one pass and report it as a single edit —
// the likeliest way to get a result nobody intended. An edit that genuinely
// wants every match has to say so with occurrence: 'all'.
const DEFAULT_OCCURRENCE = 'first';

// Ceiling on how long one model-supplied pattern may run before it is killed.
const DEFAULT_REGEX_TIMEOUT_MS = 250;

// Longest pattern we will even try to compile.
const MAX_PATTERN_CHARS = 200;

// ---------------------------------------------------------------------------
// Comparison helpers — unchanged, still exported, no longer used to refuse.
// ---------------------------------------------------------------------------

function wordsOf(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function wordsChanged(a, b) {
  const left = wordsOf(a);
  const right = wordsOf(b);
  const bag = new Map();
  for (const w of left) bag.set(w, (bag.get(w) || 0) + 1);
  let added = 0;
  for (const w of right) {
    const n = bag.get(w) || 0;
    if (n > 0) bag.set(w, n - 1); else added++;
  }
  let removed = 0;
  for (const n of bag.values()) removed += n;
  return added + removed;
}

function onlyPunctuationOrCase(a, b) {
  return wordsOf(a).join(' ') === wordsOf(b).join(' ');
}

// ---------------------------------------------------------------------------
// The one remaining refusal: an edit that asks for nothing.
// ---------------------------------------------------------------------------

function rejectReason(find, replace, edit) {
  const e = edit || {};
  const hasRewrite = e.rewrite != null;
  const hasRegex = typeof e.regex === 'string' && e.regex.length > 0;
  const hasInsert = e.insert != null || e.at != null || e.after != null || e.before != null;
  if (hasRewrite || hasRegex || hasInsert) return null;
  if (!find) return 'it did not say what to change';
  return null;
}

// ---------------------------------------------------------------------------
// Text plumbing
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Block-level wrap, for payloads that sit at a paragraph boundary.
function textToHtml(s) {
  return String(s)
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// Inline wrap, for payloads spliced into the middle of an existing block.
// This is the fix for the nested-<p> corruption: an anchored insert must never
// introduce a block element inside another block element.
function textToInlineHtml(s) {
  return escapeHtml(String(s)).replace(/\n/g, '<br>');
}

// FALLBACK ONLY. Slate's own richtext module is the authority on what a draft's
// plain text is; pass `opts.toPlainText` and this is never called. It is
// written to agree with richtext on the cases we know about (list bullets,
// <br> spacing) so the gap is small when someone forgets.
function htmlToText(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|tr)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) return n;
    n++;
    i = at + needle.length;
  }
}

function offsetsOf(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) return out;
    out.push(at);
    i = at + needle.length;
  }
}

// Byte ranges occupied by tags, so a literal find can't corrupt an attribute.
function tagRanges(html) {
  const ranges = [];
  const re = /<[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function insideTag(offset, ranges) {
  for (const [a, b] of ranges) {
    if (offset > a && offset < b) return true;
    if (offset === a) return true;
  }
  return false;
}

function dropSpansInsideTags(spans, ranges) {
  if (!ranges.length) return spans;
  return spans.filter((s) => !insideTag(s.start, ranges));
}

// ---------------------------------------------------------------------------
// Choosing which matches to act on
// ---------------------------------------------------------------------------

// Returns { chosen } or { outOfRange: true, found } — the caller needs to tell
// "your words aren't in the draft" apart from "there is no 99th one".
function chooseSpans(spans, occurrence) {
  if (!spans.length) return { chosen: [] };
  if (occurrence === 'first') return { chosen: [spans[0]] };
  if (occurrence === 'last') return { chosen: [spans[spans.length - 1]] };
  if (typeof occurrence === 'number' && Number.isFinite(occurrence)) {
    const idx = Math.trunc(occurrence) - 1;
    if (!spans[idx]) return { outOfRange: true, found: spans.length };
    return { chosen: [spans[idx]] };
  }
  return { chosen: spans };
}

// Replacing over markup must not delete the tags inside the span.
//
// The tolerant matcher below deliberately steps over <b>…</b> so a phrase
// copied out of the rendered draft is still found. That means the matched
// region can contain tags that belong to the DOCUMENT, not to the phrase, and
// splicing the replacement over the whole region deletes them — leaving an
// unclosed tag, after which the rest of the draft inherits the formatting.
// It is not cosmetic: richtext.js reads the same markup, so a grammar fix on
// line one turned every later paragraph bold in the .docx as well.
//
// Every tag in the span is re-emitted, in its original order, exactly once. The
// replacement lands where the first piece of text was, so it inherits the
// formatting the match started in. Balanced markup in, balanced markup out.
const TAG_RE = /<[^<>]*>/g;

function spliceHtmlSpan(chunk, replace) {
  const tags = [];
  let firstTextAt = -1;
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(chunk)) !== null) {
    if (m.index > last && firstTextAt === -1) firstTextAt = tags.length;
    tags.push(m[0]);
    last = m.index + m[0].length;
  }
  if (!tags.length) return replace;              // no markup: unchanged
  if (last < chunk.length && firstTextAt === -1) firstTextAt = tags.length;
  const at = firstTextAt === -1 ? tags.length : firstTextAt;
  return tags.slice(0, at).join('') + replace + tags.slice(at).join('');
}

// Splices by offset rather than String.replace, so `$&`, `$1` and `` $` `` in
// the replacement stay literal text. `preserveTags` is for markup sources only.
function spliceSpans(source, spans, replace, preserveTags) {
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    const piece = preserveTags ? spliceHtmlSpan(source.slice(s.start, s.end), replace) : replace;
    out += source.slice(cursor, s.start) + piece;
    cursor = s.end;
  }
  return out + source.slice(cursor);
}

// ---------------------------------------------------------------------------
// Tolerant matching
//
// A phrase copied out of the rendered draft rarely matches the markup
// byte-for-byte: entities, curly quotes and inline tags sit between the
// characters. This pattern steps over all of that, so a correction spanning
// <em>...</em> is found instead of silently skipped.
// ---------------------------------------------------------------------------

const TAG_GAP = '(?:<[^<>]*>)*';
const SPACE = '(?:\\s|&nbsp;|&#160;|<[^<>]*>)+';

const CHAR_CLASSES = {
  '&': '(?:&amp;|&)',
  '<': '(?:&lt;|<)',
  '>': '(?:&gt;|>)',
  '"': '(?:&quot;|&#34;|["\\u201C\\u201D])',
  "'": "(?:&#39;|&apos;|&rsquo;|['\\u2018\\u2019])",
  '’': "(?:&#39;|&apos;|&rsquo;|['\\u2018\\u2019])",
  '‘': "(?:&#39;|&apos;|&lsquo;|['\\u2018\\u2019])",
  '“': '(?:&quot;|&ldquo;|["\\u201C\\u201D])',
  '”': '(?:&quot;|&rdquo;|["\\u201C\\u201D])',
  '-': '(?:[-\\u2010\\u2011\\u2012\\u2013\\u2014]|&ndash;|&mdash;)',
  '–': '(?:[-\\u2013\\u2014]|&ndash;|&mdash;)',
  '—': '(?:[-\\u2013\\u2014]|&ndash;|&mdash;)',
  '…': '(?:\\.\\.\\.|\\u2026|&hellip;)',
};

// Every token here is a fixed-width alternation or a single possessive-ish
// character class, and the pattern is built left to right with no nesting, so
// it cannot backtrack catastrophically the way a model-supplied pattern can.
function tolerantPattern(find) {
  const parts = [];
  const chars = Array.from(String(find));
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      while (i < chars.length && /\s/.test(chars[i])) i++;
      parts.push({ token: SPACE, isSpace: true });
      continue;
    }
    parts.push({ token: CHAR_CLASSES[ch] || reEscape(ch), isSpace: false });
    i++;
  }
  if (!parts.length) return null;
  let src = '';
  for (let k = 0; k < parts.length; k++) {
    if (k > 0 && !parts[k].isSpace && !parts[k - 1].isSpace) src += TAG_GAP;
    src += parts[k].token;
  }
  try {
    return new RegExp(src, 'g');
  } catch (_) {
    return null;
  }
}

function spansOfRegex(source, re) {
  const spans = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (spans.length > 10000) break;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Locating a find string, and the replacement that goes with it
//
// Three passes, first hit wins. Each returns the spans AND the exact string to
// splice, so escaping is decided once per pass instead of differing between
// them — that asymmetry is what let a bare `&` into the markup.
// ---------------------------------------------------------------------------

function locateInHtml(html, find, replace, rawMarkup) {
  // Only guard against matching inside a tag when the find is plain prose. A
  // find that deliberately contains markup is allowed to land on it.
  const ranges = /</.test(find) ? [] : tagRanges(html);
  const asMarkup = (s) => (rawMarkup ? s : escapeHtml(s));

  const literal = dropSpansInsideTags(
    offsetsOf(html, find).map((start) => ({ start, end: start + find.length })),
    ranges
  );
  if (literal.length) return { spans: literal, replacement: asMarkup(replace) };

  const escFind = escapeHtml(find);
  if (escFind !== find) {
    const esc = dropSpansInsideTags(
      offsetsOf(html, escFind).map((start) => ({ start, end: start + escFind.length })),
      ranges
    );
    if (esc.length) return { spans: esc, replacement: asMarkup(replace) };
  }

  const re = tolerantPattern(find);
  if (re) {
    const tol = dropSpansInsideTags(spansOfRegex(html, re), ranges);
    if (tol.length) return { spans: tol, replacement: asMarkup(replace) };
  }
  return null;
}

function locateInText(text, find, replace) {
  const literal = offsetsOf(text, find).map((start) => ({ start, end: start + find.length }));
  if (literal.length) return { spans: literal, replacement: replace };
  const re = tolerantPattern(find);
  if (re) {
    const tol = spansOfRegex(text, re);
    if (tol.length) return { spans: tol, replacement: replace };
  }
  return null;
}

// Kept for compatibility with anything that called it.
function replaceOnce(source, find, replace, occurrence) {
  const found = locateInText(source, find, replace);
  if (!found) return null;
  const picked = chooseSpans(found.spans, occurrence || DEFAULT_OCCURRENCE);
  if (picked.outOfRange || !picked.chosen.length) return null;
  return spliceSpans(source, picked.chosen, found.replacement);
}

// ---------------------------------------------------------------------------
// Guarded regex execution
//
// A model-supplied pattern is arbitrary code with an exponential worst case,
// and JavaScript cannot interrupt a running regex. So it runs on a worker
// thread and the main thread waits with a deadline; if the deadline passes the
// worker is terminated and the edit is skipped. applyEdits stays synchronous,
// which is what the rest of the app expects.
// ---------------------------------------------------------------------------

const REGEX_WORKER_SRC = `
const { workerData } = require('worker_threads');
const { port, signal } = workerData;
port.on('message', (m) => {
  let out;
  try {
    const flags = typeof m.flags === 'string' ? m.flags : 'g';
    const testFlags = flags.includes('g') ? flags : flags + 'g';
    const matched = new RegExp(m.source, testFlags).test(m.input);
    out = matched
      ? { ok: true, matched: true, result: m.input.replace(new RegExp(m.source, flags), m.replace) }
      : { ok: true, matched: false };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e) };
  }
  port.postMessage(out);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
`;

let _rx = { worker: null, port: null, signal: null, wt: null, unavailable: false };

function stopRegexWorker() {
  if (_rx.worker) { try { _rx.worker.terminate(); } catch (_) { /* already gone */ } }
  _rx = { worker: null, port: null, signal: null, wt: _rx.wt, unavailable: _rx.unavailable };
}

function startRegexWorker() {
  if (_rx.worker) return true;
  if (_rx.unavailable) return false;
  let wt = _rx.wt;
  try {
    if (!wt) wt = require('worker_threads');
  } catch (_) {
    _rx.unavailable = true;
    return false;
  }
  if (!wt || !wt.Worker || !wt.MessageChannel || typeof wt.receiveMessageOnPort !== 'function'
      || typeof SharedArrayBuffer === 'undefined') {
    _rx.unavailable = true;
    return false;
  }
  try {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new wt.MessageChannel();
    const worker = new wt.Worker(REGEX_WORKER_SRC, {
      eval: true,
      workerData: { port: port2, signal },
      transferList: [port2],
    });
    worker.unref();
    worker.on('error', () => { stopRegexWorker(); });
    _rx = { worker, port: port1, signal, wt, unavailable: false };
    // Report what warm-up actually decided. Saying "true" after it tore the
    // worker down left runRegexGuarded holding a null port, and the TypeError
    // escaped applyEdits instead of falling through to the inline screen below.
    return warmRegexWorker();
  } catch (_) {
    _rx.unavailable = true;
    return false;
  }
}

// Booting a thread costs real time — measured at 135ms on an idle machine, and
// worse on a loaded one. If that lands inside the deadline then the first
// pattern of the session is judged mostly on how long Node took to start, and a
// timeout kills the worker so the next attempt pays it again. Do the boot here,
// on its own generous budget, before anything is being timed.
const WARMUP_BUDGET_MS = 5000;

// true when the worker answered and is ready to be timed. false means it has
// been torn down and the caller must NOT touch _rx.port or _rx.signal — they
// are null. Every exit reports honestly; an earlier version returned nothing
// here and the caller assumed success.
//
// A failure also marks the guard unavailable for the rest of the process. If it
// could not manage a one-character match inside WARMUP_BUDGET_MS, retrying per
// edit would mean another multi-second main-thread block every time, to reach
// the same answer. The inline structural screen takes over instead.
function warmRegexWorker() {
  const { signal, port, wt } = _rx;
  const giveUp = () => { stopRegexWorker(); _rx.unavailable = true; return false; };

  Atomics.store(signal, 0, 0);
  try {
    port.postMessage({ source: 'a', flags: '', input: 'a', replace: 'a' });
  } catch (_) {
    return giveUp();
  }
  if (Atomics.wait(signal, 0, 0, WARMUP_BUDGET_MS) === 'timed-out') {
    console.warn('[proofread] regex worker did not warm up in time; falling back to the structural screen');
    return giveUp();
  }
  // Drain the reply, or the first real call would read this one.
  for (let spin = 0; spin < 200; spin++) {
    if (wt.receiveMessageOnPort(port)) return true;
    Atomics.wait(signal, 0, 1, 1);
  }
  return giveUp();
}

// { ok, matched, result } | { ok:false, error } | { timedOut:true } | null when
// the guard itself is unavailable.
function runRegexGuarded(source, flags, input, replace, timeoutMs) {
  if (!startRegexWorker()) return null;
  const { signal, port, wt } = _rx;
  Atomics.store(signal, 0, 0);
  try {
    port.postMessage({ source, flags, input, replace });
  } catch (_) {
    stopRegexWorker();
    return null;
  }
  const status = Atomics.wait(signal, 0, 0, timeoutMs);
  if (status === 'timed-out') {
    stopRegexWorker();
    return { timedOut: true };
  }
  // The notify can land a beat before the message is queued on the port.
  for (let spin = 0; spin < 200; spin++) {
    const envelope = wt.receiveMessageOnPort(port);
    if (envelope) return envelope.message;
    Atomics.wait(signal, 0, 1, 1);
  }
  stopRegexWorker();
  return null;
}

// Cheap structural screen. Not a substitute for the deadline — it is what
// stands in when the worker guard is unavailable, and it gives a clearer
// message than "timed out" for the patterns that are obviously explosive.
function unsafePatternReason(src) {
  if (src.length > MAX_PATTERN_CHARS) {
    return `that pattern is too long to be safe (${src.length} characters, limit ${MAX_PATTERN_CHARS})`;
  }
  // A quantified group whose body is itself quantified: (a+)+, (a*)*
  if (/\([^()]*[+*]\??[^()]*\)\s*[+*]/.test(src) || /\([^()]*\{\d+,\d*\}[^()]*\)\s*[+*{]/.test(src)) {
    return 'that pattern can backtrack exponentially (a repeat inside a repeat) — rewrite it without nested + or *';
  }
  // A quantified alternation: (a|a)*, (x|xy)+. Only some of these are actually
  // explosive, but this screen is the conservative fallback for when the
  // deadline guard is unavailable, so it declines the whole shape.
  if (/\((?!\?)[^()]*\|[^()]*\)\s*[+*]/.test(src)) {
    return 'that pattern repeats a group of alternatives, which can backtrack exponentially — anchor it or drop the outer + / *';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

function insertInto(source, payload, where) {
  const { at, after, before, occurrence, ranges } = where || {};
  if (after) {
    let spans = offsetsOf(source, after).map((s) => ({ start: s + after.length, end: s + after.length }));
    if (ranges) spans = dropSpansInsideTags(spans, ranges);
    if (!spans.length) return null;
    const picked = chooseSpans(spans, occurrence);
    if (picked.outOfRange || !picked.chosen.length) return null;
    return spliceSpans(source, picked.chosen, payload);
  }
  if (before) {
    let spans = offsetsOf(source, before).map((s) => ({ start: s, end: s }));
    if (ranges) spans = dropSpansInsideTags(spans, ranges);
    if (!spans.length) return null;
    const picked = chooseSpans(spans, occurrence);
    if (picked.outOfRange || !picked.chosen.length) return null;
    return spliceSpans(source, picked.chosen, payload);
  }
  if (at === 'start') return payload + source;
  return source + payload;
}

// ---------------------------------------------------------------------------
// The main entry point
// ---------------------------------------------------------------------------

// Each edit is one of:
//
//   { find, replace, why }                  targeted change (occurrence: all)
//   { find, replace, occurrence: 'first' }  ...or 'last', or a 1-based number
//   { insert, at: 'end' | 'start', why }    add text without finding anything
//   { insert, after: '...' } / { before: '...' }
//   { regex: '...', flags: 'g', replace: '...' }  guarded by a deadline
//   { rewrite: '...' } or { rewrite: { html, text } }   replace the whole draft
//
// Add `html: true` to an edit to splice its replacement as raw markup instead
// of escaped text.
//
// opts:
//   toPlainText(html)  -> derive plain text. PASS richtext's version.
//   occurrence         -> default for edits that don't set one
//   regexTimeoutMs     -> deadline per pattern (default 250)
//   allowRegex         -> set false to refuse regex edits outright
//
// Returns { html, text, applied, skipped }.
function applyEdits({ html, text }, edits, opts) {
  const options = opts || {};
  const defaultOccurrence = options.occurrence || DEFAULT_OCCURRENCE;
  const timeoutMs = options.regexTimeoutMs == null ? DEFAULT_REGEX_TIMEOUT_MS : options.regexTimeoutMs;
  const allowRegex = options.allowRegex !== false;
  const toPlain = typeof options.toPlainText === 'function' ? options.toPlainText : htmlToText;

  const applied = [];
  const skipped = [];
  let nextHtml = html == null ? null : String(html);
  let nextText = String(text || '');
  const richDraft = nextHtml != null;

  // One pattern per call may burn the deadline; after that the rest are refused
  // without running. Otherwise a list of N bad patterns blocks the event loop
  // for N x the timeout, which is the same freeze the deadline exists to stop,
  // just in instalments.
  let regexHalted = false;

  // Invariant 1: when there is markup, the text is derived from it. Always.
  const syncText = () => { if (richDraft) nextText = toPlain(nextHtml); };

  for (const raw of Array.isArray(edits) ? edits : []) {
    const e = raw || {};
    const find = String(e.find || '');
    const replace = String(e.replace == null ? '' : e.replace);
    const why = String(e.why || '');
    const occurrence = e.occurrence != null ? e.occurrence : defaultOccurrence;
    const rawMarkup = e.html === true;

    const reason = rejectReason(find, replace, e);
    if (reason) { skipped.push({ find, reason }); continue; }

    // --- whole-draft rewrite ------------------------------------------------
    if (e.rewrite != null) {
      const r = typeof e.rewrite === 'string' ? { text: e.rewrite } : e.rewrite;
      if (richDraft) {
        nextHtml = r.html != null ? String(r.html) : textToHtml(r.text != null ? String(r.text) : '');
        syncText();
      } else {
        nextText = r.text != null ? String(r.text) : (r.html != null ? toPlain(String(r.html)) : '');
      }
      applied.push({ kind: 'rewrite', find: '(whole draft)', replace: nextText, why });
      continue;
    }

    // --- regex --------------------------------------------------------------
    // Only when there is no plain `find`. readEdits upstream admits any object
    // carrying string find/replace, so an injected `regex` key riding along
    // with an ordinary correction must not be what actually runs.
    if (!find && typeof e.regex === 'string' && e.regex) {
      if (!allowRegex) {
        skipped.push({ find: e.regex, reason: 'pattern edits are switched off' });
        continue;
      }
      if (regexHalted) {
        skipped.push({
          find: e.regex,
          reason: 'an earlier pattern had to be stopped, so the rest were left alone this turn',
        });
        continue;
      }
      const flags = e.flags == null ? 'g' : String(e.flags);
      const target = richDraft ? nextHtml : nextText;

      const guarded = runRegexGuarded(e.regex, flags, target, replace, timeoutMs);

      let outcome = guarded;
      if (outcome == null) {
        // No worker available — screen structurally, then run inline.
        const unsafe = unsafePatternReason(e.regex);
        if (unsafe) { skipped.push({ find: e.regex, reason: unsafe }); continue; }
        try {
          const testRe = new RegExp(e.regex, flags.includes('g') ? flags : flags + 'g');
          const matched = testRe.test(target);
          outcome = matched
            ? { ok: true, matched: true, result: target.replace(new RegExp(e.regex, flags), replace) }
            : { ok: true, matched: false };
        } catch (err) {
          outcome = { ok: false, error: String((err && err.message) || err) };
        }
      }

      if (outcome.timedOut) {
        regexHalted = true;
        skipped.push({
          find: e.regex,
          reason: `that pattern took too long to run (over ${timeoutMs}ms) and was stopped before it could lock up the editor`,
        });
        continue;
      }
      if (!outcome.ok) {
        skipped.push({ find: e.regex, reason: `that pattern would not compile — ${outcome.error}` });
        continue;
      }
      if (!outcome.matched) {
        skipped.push({ find: e.regex, reason: 'that pattern matched nothing in the draft' });
        continue;
      }
      if (richDraft) { nextHtml = outcome.result; syncText(); } else { nextText = outcome.result; }
      applied.push({ kind: 'regex', find: e.regex, replace, why });
      continue;
    }

    // --- insertion ----------------------------------------------------------
    const wantsInsert = e.insert != null || (!find && (e.at || e.after || e.before));
    if (wantsInsert) {
      const payload = String(e.insert != null ? e.insert : replace);
      const anchored = Boolean(e.after || e.before);

      if (richDraft) {
        // Anchored inserts land mid-block, so the payload must be INLINE.
        // Only a start/end insert may introduce a new block.
        const htmlPayload = rawMarkup
          ? payload
          : (anchored ? textToInlineHtml(payload) : textToHtml(payload));
        const anchorText = String(e.after || e.before || '');
        const ranges = /</.test(anchorText) ? [] : tagRanges(nextHtml);
        let out = insertInto(nextHtml, htmlPayload, {
          at: e.at,
          after: e.after ? String(e.after) : undefined,
          before: e.before ? String(e.before) : undefined,
          occurrence, ranges,
        });
        if (out == null && anchored) {
          out = insertInto(nextHtml, htmlPayload, {
            at: e.at,
            after: e.after ? escapeHtml(String(e.after)) : undefined,
            before: e.before ? escapeHtml(String(e.before)) : undefined,
            occurrence, ranges,
          });
        }
        if (out == null) {
          skipped.push({ find: e.after || e.before || '(insert)', reason: 'could not find the place to insert it' });
          continue;
        }
        nextHtml = out;
        syncText();
      } else {
        const out = insertInto(nextText, payload, {
          at: e.at, after: e.after, before: e.before, occurrence,
        });
        if (out == null) {
          skipped.push({ find: e.after || e.before || '(insert)', reason: 'could not find the place to insert it' });
          continue;
        }
        nextText = out;
      }
      applied.push({ kind: 'insert', find: e.after || e.before || `(${e.at || 'end'})`, replace: payload, why });
      continue;
    }

    // --- targeted find / replace --------------------------------------------
    const source = richDraft ? nextHtml : nextText;
    const found = richDraft
      ? locateInHtml(nextHtml, find, replace, rawMarkup)
      : locateInText(nextText, find, replace);

    if (!found) {
      skipped.push({ find, reason: 'could not find that text in the draft' });
      continue;
    }
    const picked = chooseSpans(found.spans, occurrence);
    if (picked.outOfRange) {
      // Invariant 2: say what actually happened. The words ARE in the draft.
      skipped.push({
        find,
        reason: `that appears ${picked.found} time${picked.found === 1 ? '' : 's'} in the draft, so there is no occurrence ${occurrence}`,
      });
      continue;
    }
    if (!picked.chosen.length) {
      skipped.push({ find, reason: 'could not find that text in the draft' });
      continue;
    }

    const out = spliceSpans(source, picked.chosen, found.replacement, richDraft);
    if (richDraft) { nextHtml = out; syncText(); } else { nextText = out; }
    applied.push({
      kind: 'replace',
      find,
      replace,
      why,
      count: picked.chosen.length,
      total: found.spans.length,
    });
  }

  return { html: nextHtml, text: nextText, applied, skipped };
}

// ---------------------------------------------------------------------------
// The honest account of what happened. Claude says what it meant to change;
// this says what the draft really got.
// ---------------------------------------------------------------------------

function shorten(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}...` : str;
}

function describe(e) {
  const why = e.why ? ` — ${e.why}` : '';
  if (e.kind === 'rewrite') {
    return `• the whole draft was replaced (${String(e.replace).length} characters)${why}`;
  }
  if (e.kind === 'insert') {
    return `• added "${shorten(e.replace, 120)}" at ${e.find}${why}`;
  }
  if (e.kind === 'regex') {
    return `• pattern /${e.find}/ → "${shorten(e.replace, 80)}"${why}`;
  }
  // Say it plainly when one instruction changed several places — this is the
  // most likely way to get a result you did not intend. And when it changed
  // fewer than it matched, say which, so nobody assumes the rest were done too.
  let times = '';
  if (e.count > 1) times = ` — every one of the ${e.count} places it appears`;
  else if (e.total > 1) times = ` — the first of ${e.total} places it appears`;
  return `• "${e.find}" → "${e.replace}"${times}${why}`;
}

function summarise(applied, skipped) {
  const did = applied || [];
  const didnt = skipped || [];
  if (!did.length && !didnt.length) return '';
  const lines = [];
  if (did.length) {
    lines.push(did.length === 1 ? 'Changed in your draft:' : `Changed in your draft (${did.length}):`);
    for (const e of did) lines.push(describe(e));
  }
  if (didnt.length) {
    lines.push(did.length ? '' : 'Nothing was changed.');
    lines.push(didnt.length === 1 ? 'Left alone:' : `Left alone (${didnt.length}):`);
    for (const s of didnt) lines.push(`• "${shorten(s.find, 80)}" — ${s.reason}`);
  }
  return lines.join('\n');
}

// Lets a host shut the worker down cleanly on exit. Safe to ignore.
function dispose() { stopRegexWorker(); }

module.exports = {
  applyEdits, summarise, rejectReason, wordsChanged, onlyPunctuationOrCase,
  MAX_EDITS, MAX_FIND_CHARS, MAX_GROWTH_CHARS, MAX_WORDS_CHANGED,
  // additive, safe to ignore
  replaceOnce, insertInto, countOccurrences, escapeHtml,
  textToHtml, textToInlineHtml, htmlToText, unsafePatternReason, dispose,
  DEFAULT_OCCURRENCE, DEFAULT_REGEX_TIMEOUT_MS,
  // aliases so the names the newer tests import still resolve
  unsafePattern: unsafePatternReason, MAX_REGEX_CHARS: MAX_PATTERN_CHARS,
};
