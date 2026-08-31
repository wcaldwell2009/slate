'use strict';

// Invisible-character inspector ("Layer A" — deterministic Unicode carriers).
//
// Ported from watermarks-remover by Guillaume Meyer and contributors (MIT),
// specifically service/scripts/text_unicode.py:
//   https://github.com/guillaumemeyer/watermarks-remover
// Translated to zero-dependency Node rather than wrapped, because Slate takes
// no dependencies and does not ship a Python runtime. Python's `unicodedata`
// lookups become Unicode property escapes (\p{Cf}, \p{L}, \p{M}), which V8 has
// natively, and NFKC becomes String.prototype.normalize.
//
// ONLY Layer A is ported. The upstream project also has a statistical layer
// that rewords prose to break token-sampling watermarks; that is deliberately
// not here (see CLAUDE.md round 56).
//
// THE IDEA WORTH UNDERSTANDING: a naive stripper deletes every invisible
// character it finds, and thereby destroys real text. Zero-width joiners build
// emoji (👨‍👩‍👧), zero-width non-joiners are ORTHOGRAPHY in Persian and
// Devanagari, tag characters spell out subdivision flags (🏴󠁧󠁢󠁳󠁣󠁴󠁿), and
// variation selectors choose CJK glyph forms. Whether one of these is a hidden
// payload or part of the writing depends ENTIRELY on what sits next to it.
// That context test is the substance of the upstream code and the reason this
// file is not a regex.

// ---- codepoint tables -----------------------------------------------------

// Format/invisible controls with no legitimate free-standing use in prose.
const STRIP = new Set([
  0x00ad,                                     // soft hyphen
  0x034f,                                     // combining grapheme joiner
  0x061c,                                     // Arabic letter mark
  0x115f, 0x1160,                             // Hangul choseong/jungseong filler
  0x17b4, 0x17b5,                             // Khmer inherent vowels
  0x180b, 0x180c, 0x180d, 0x180e, 0x180f,     // Mongolian FVS + vowel separator
  0x200b, 0x200c, 0x200d,                     // ZWSP, ZWNJ, ZWJ
  0x200e, 0x200f,                             // LRM, RLM
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,     // LRE, RLE, PDF, LRO, RLO
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064,     // word joiner, invisible operators
  0x2066, 0x2067, 0x2068, 0x2069,             // LRI, RLI, FSI, PDI
  0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, // deprecated format controls
  0xfeff,                                     // BOM / ZWNBSP
  0xfe00, 0xfe01, 0xfe02, 0xfe03, 0xfe04, 0xfe05, 0xfe06, 0xfe07,
  0xfe08, 0xfe09, 0xfe0a, 0xfe0b, 0xfe0c, 0xfe0d, 0xfe0e, 0xfe0f, // variation selectors
  0x3164, 0xffa0,                             // Hangul fillers (blank jamo)
  0xfff9, 0xfffa, 0xfffb,                     // interlinear annotation
]);

// Characters that look like an ordinary space. Replaced, never deleted.
const SPACE_HOMOGLYPHS = new Map([
  [0x00a0, ' '], [0x1680, ' '], [0x2000, ' '], [0x2001, ' '], [0x2002, ' '],
  [0x2003, ' '], [0x2004, ' '], [0x2005, ' '], [0x2006, ' '], [0x2007, ' '],
  [0x2008, ' '], [0x2009, ' '], [0x200a, ' '], [0x202f, ' '], [0x205f, ' '],
  [0x3000, ' '],
]);

// Cyrillic and fullwidth letters that read as Latin. Off unless asked for:
// a Russian word is not a watermark.
const LATIN_CONFUSABLES = new Map([
  [0x0410, 'A'], [0x0412, 'B'], [0x0415, 'E'], [0x041a, 'K'], [0x041c, 'M'],
  [0x041d, 'H'], [0x041e, 'O'], [0x0420, 'P'], [0x0421, 'C'], [0x0422, 'T'],
  [0x0425, 'X'], [0x0430, 'a'], [0x0435, 'e'], [0x043e, 'o'], [0x0440, 'p'],
  [0x0441, 'c'], [0x0443, 'y'], [0x0445, 'x'], [0x0456, 'i'],
]);
for (let i = 0; i < 26; i++) {
  LATIN_CONFUSABLES.set(0xff21 + i, String.fromCharCode(65 + i));  // fullwidth A-Z
  LATIN_CONFUSABLES.set(0xff41 + i, String.fromCharCode(97 + i));  // fullwidth a-z
}

const BIDI = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069]);
// Marks and isolates are ordinary in mixed RTL/LTR prose. Overrides (202D/202E)
// are not: they can reorder text that has nothing to do with them.
const PRESERVABLE_BIDI = new Set([0x061c, 0x200e, 0x200f, 0x2066, 0x2067, 0x2068, 0x2069]);
const ZW_FAMILY = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e]);
const EMOJI_GLUE = new Set([0x200d, 0xfe0e, 0xfe0f]);
const SCRIPT_JOINERS = new Set([0x200c, 0x200d]);
const MONGOLIAN_FVS = new Set([0x180b, 0x180c, 0x180d, 0x180f]);
const KHMER_VOWELS = new Set([0x17b4, 0x17b5]);
const HANGUL_FILLERS = new Set([0x115f, 0x1160, 0x3164, 0xffa0]);
// Arabic/Syriac format marks that are normal orthography.
const ORTHOGRAPHIC_CF = new Set([0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605,
  0x06dd, 0x070f, 0x08e2, 0x110bd, 0x110cd]);

const inRange = (cp, lo, hi) => cp >= lo && cp <= hi;
const isVsSupplement = (cp) => inRange(cp, 0xe0100, 0xe01ef);
const isTagChar = (cp) => inRange(cp, 0xe0001, 0xe007f);
const isPrivateUse = (cp) => inRange(cp, 0xe000, 0xf8ff)
  || inRange(cp, 0xf0000, 0xffffd) || inRange(cp, 0x100000, 0x10fffd);
// The 66 noncharacters: permanently unassignable, banned in interchange.
const isNoncharacter = (cp) => inRange(cp, 0xfdd0, 0xfdef) || (cp & 0xfffe) === 0xfffe;
// Unassigned but Default_Ignorable: renderers already draw nothing, so they
// survive a round trip invisibly. Explicit ranges, never a "category is Cn"
// rule — Unicode assigns new characters and a Cn rule would eat them.
const RESERVED_IGNORABLE = new Set([0x2065, 0xe0000]);
const isReservedIgnorable = (cp) => RESERVED_IGNORABLE.has(cp)
  || inRange(cp, 0xfff0, 0xfff8) || inRange(cp, 0xe0080, 0xe00ff) || inRange(cp, 0xe01f0, 0xe0fff);

const isVariationSelector = (cp) => isVsSupplement(cp) || inRange(cp, 0xfe00, 0xfe0f) || MONGOLIAN_FVS.has(cp);

function isStripCp(cp) {
  return STRIP.has(cp) || isVsSupplement(cp) || isTagChar(cp)
    || isNoncharacter(cp) || isReservedIgnorable(cp) || isPrivateUse(cp);
}

function stripKind(cp) {
  if (isTagChar(cp)) return 'tag_chars';
  if (isNoncharacter(cp)) return 'noncharacter';
  if (isReservedIgnorable(cp)) return 'reserved_ignorable';
  if (isVariationSelector(cp)) return 'variation_selector';
  if (BIDI.has(cp)) return 'bidi';
  if (ZW_FAMILY.has(cp)) return 'zwj_family';
  if (isPrivateUse(cp)) return 'private_use';
  return 'strip';
}

// ---- context tests --------------------------------------------------------

const IS_CF = /\p{Cf}/u;
const IS_LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const IS_LETTER = /\p{L}/u;
const chr = (cp) => String.fromCodePoint(cp);

const isCjk = (cp) => inRange(cp, 0x3400, 0x4dbf) || inRange(cp, 0x4e00, 0x9fff)
  || inRange(cp, 0xf900, 0xfaff) || inRange(cp, 0x20000, 0x323af);

function isEmojiBase(cp) {
  if (inRange(cp, 0x1f000, 0x1faff)) return true;
  if (inRange(cp, 0x2190, 0x25ff)) return true;
  if (inRange(cp, 0x2600, 0x27bf)) return true;
  if (inRange(cp, 0x2b00, 0x2bff)) return true;
  if ([0x203c, 0x2049, 0x2139, 0x2934, 0x2935].includes(cp)) return true;
  if ([0x00a9, 0x00ae, 0x2122, 0x3030, 0x303d, 0x3297, 0x3299].includes(cp)) return true;
  return cp === 0x0023 || cp === 0x002a || inRange(cp, 0x0030, 0x0039); // keycap bases
}

// Broad script groups where ZWJ/ZWNJ carry meaning rather than hide data.
function joiningScript(cp) {
  const groups = [[0x0600, 0x08ff, 'arabic'], [0x0900, 0x0dff, 'indic'],
    [0x0f00, 0x109f, 'south-asian'], [0x1780, 0x17ff, 'khmer'], [0x1800, 0x18af, 'mongolian']];
  for (const [lo, hi, name] of groups) {
    if (inRange(cp, lo, hi) && IS_LETTER_OR_MARK.test(chr(cp))) return name;
  }
  return null;
}

const isMongolianLetter = (cp) => inRange(cp, 0x1800, 0x18af) && IS_LETTER.test(chr(cp));
const isKhmerLetter = (cp) => inRange(cp, 0x1780, 0x17ff) && IS_LETTER.test(chr(cp));
const isHangulJamo = (cp) => inRange(cp, 0x1100, 0x11ff) || inRange(cp, 0xa960, 0xa97c)
  || inRange(cp, 0xd7b0, 0xd7c6) || inRange(cp, 0x3131, 0x318e) || inRange(cp, 0xffa1, 0xffdc);

// Format controls that visibly govern their own script's layout.
const LAYOUT_CF = [
  [[0x13430, 0x1343f], [0x13000, 0x143ff]],   // Egyptian hieroglyph quadrat
  [[0x1bca0, 0x1bca3], [0x1bc00, 0x1bca3]],   // Duployan shorthand
  [[0x1d173, 0x1d17a], [0x1d100, 0x1d1ff]],   // musical beams/ties/slurs
];
function layoutCfScript(cp) {
  for (const [ctrl, script] of LAYOUT_CF) if (inRange(cp, ctrl[0], ctrl[1])) return script;
  return null;
}

const isGlue = (cp) => EMOJI_GLUE.has(cp) || isVariationSelector(cp)
  || SCRIPT_JOINERS.has(cp) || inRange(cp, 0xe0020, 0xe007f)
  || MONGOLIAN_FVS.has(cp) || KHMER_VOWELS.has(cp) || HANGUL_FILLERS.has(cp);

// A subdivision flag is 🏴 followed by tag letters and closed by U+E007F.
// Only a COMPLETE sequence is real; a loose run of tag characters is a payload.
function validFlagTagIndices(cps) {
  const valid = new Set();
  let i = 0;
  while (i < cps.length) {
    if (cps[i] !== 0x1f3f4) { i++; continue; }
    let j = i + 1;
    while (j < cps.length && inRange(cps[j], 0xe0020, 0xe007e)) j++;
    if (j > i + 1 && j < cps.length && cps[j] === 0xe007f) {
      for (let k = i + 1; k <= j; k++) valid.add(k);
      i = j + 1;
    } else i++;
  }
  return valid;
}

// LRE/RLE ... PDF that actually pair up are legitimate. Overrides never are.
function validBidiEmbeddingIndices(cps) {
  const valid = new Set();
  const stack = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if ([0x202a, 0x202b, 0x202d, 0x202e].includes(cp)) stack.push([cp, i]);
    else if (cp === 0x202c) {
      if (!stack.length) continue;
      const [opener, at] = stack.pop();
      if (opener === 0x202a || opener === 0x202b) { valid.add(at); valid.add(i); }
    }
  }
  return valid;
}

// ---- the decision ---------------------------------------------------------
// One character in, one verdict out: keep / strip / replace, plus the label the
// inspector shows. Every early `keep` below is a case where an invisible
// character is doing a real job.
function decide(cp, prevKept, prevInput, nextInput, o) {
  if (o.validFlagTag && !o.stripGlue) return ['keep', chr(cp), null];
  if (o.validBidiEmbedding && !o.stripBidi) return ['keep', chr(cp), null];
  if (PRESERVABLE_BIDI.has(cp) && !o.stripBidi) return ['keep', chr(cp), null];

  if (prevInput != null && !o.stripGlue) {
    if (isVsSupplement(cp) && isCjk(prevInput)) return ['keep', chr(cp), null];
    if (MONGOLIAN_FVS.has(cp) && inRange(prevInput, 0x1800, 0x18af)) return ['keep', chr(cp), null];
    if (inRange(cp, 0xfe00, 0xfe0d) && isCjk(prevInput)) return ['keep', chr(cp), null];
  }
  if (EMOJI_GLUE.has(cp) && !o.stripGlue) {
    if ((cp === 0xfe0e || cp === 0xfe0f) && prevInput != null && isEmojiBase(prevInput)) {
      return ['keep', chr(cp), null];
    }
    if (cp === 0x200d && prevKept != null && nextInput != null
        && isEmojiBase(prevKept) && isEmojiBase(nextInput)) {
      return ['keep', chr(cp), null];
    }
  }
  if (!o.stripGlue) {
    if (SCRIPT_JOINERS.has(cp) && prevInput != null && nextInput != null) {
      const a = joiningScript(prevInput), b = joiningScript(nextInput);
      if (a != null && a === b) return ['keep', chr(cp), null];
    }
    if (MONGOLIAN_FVS.has(cp) && prevKept != null && isMongolianLetter(prevKept)) return ['keep', chr(cp), null];
    if (KHMER_VOWELS.has(cp) && prevKept != null && isKhmerLetter(prevKept)) return ['keep', chr(cp), null];
    if (HANGUL_FILLERS.has(cp) && prevKept != null && isHangulJamo(prevKept)) return ['keep', chr(cp), null];
    if (ORTHOGRAPHIC_CF.has(cp)) return ['keep', chr(cp), null];
    const script = layoutCfScript(cp);
    if (script != null && ((prevInput != null && inRange(prevInput, script[0], script[1]))
      || (nextInput != null && inRange(nextInput, script[0], script[1])))) {
      return ['keep', chr(cp), null];
    }
  }

  if (isStripCp(cp)) return ['strip', '', stripKind(cp)];
  if (o.normalizeSpaces && SPACE_HOMOGLYPHS.has(cp)) return ['replace', SPACE_HOMOGLYPHS.get(cp), 'space'];
  if (o.confusables && LATIN_CONFUSABLES.has(cp)) return ['replace', LATIN_CONFUSABLES.get(cp), 'confusable'];
  // Anything else Unicode calls a format character. The catch-all is why this
  // keeps working as Unicode adds things.
  if (IS_CF.test(chr(cp)) && !SPACE_HOMOGLYPHS.has(cp)) return ['strip', '', 'other_cf'];
  return ['keep', chr(cp), null];
}

// ---- names ----------------------------------------------------------------
// Node has no character-name database, so common carriers are named by hand
// and everything else falls back to its kind.
const NAMES = new Map([
  [0x00a0, 'NO-BREAK SPACE'], [0x00ad, 'SOFT HYPHEN'], [0x034f, 'COMBINING GRAPHEME JOINER'],
  [0x061c, 'ARABIC LETTER MARK'], [0x115f, 'HANGUL CHOSEONG FILLER'], [0x1160, 'HANGUL JUNGSEONG FILLER'],
  [0x1680, 'OGHAM SPACE MARK'], [0x17b4, 'KHMER VOWEL INHERENT AQ'], [0x17b5, 'KHMER VOWEL INHERENT AA'],
  [0x180e, 'MONGOLIAN VOWEL SEPARATOR'], [0x2000, 'EN QUAD'], [0x2001, 'EM QUAD'],
  [0x2002, 'EN SPACE'], [0x2003, 'EM SPACE'], [0x2004, 'THREE-PER-EM SPACE'],
  [0x2005, 'FOUR-PER-EM SPACE'], [0x2006, 'SIX-PER-EM SPACE'], [0x2007, 'FIGURE SPACE'],
  [0x2008, 'PUNCTUATION SPACE'], [0x2009, 'THIN SPACE'], [0x200a, 'HAIR SPACE'],
  [0x200b, 'ZERO WIDTH SPACE'], [0x200c, 'ZERO WIDTH NON-JOINER'], [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'], [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'], [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'], [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'], [0x202f, 'NARROW NO-BREAK SPACE'],
  [0x205f, 'MEDIUM MATHEMATICAL SPACE'], [0x2060, 'WORD JOINER'],
  [0x2061, 'FUNCTION APPLICATION'], [0x2062, 'INVISIBLE TIMES'],
  [0x2063, 'INVISIBLE SEPARATOR'], [0x2064, 'INVISIBLE PLUS'], [0x2065, 'RESERVED (INVISIBLE)'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'], [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'], [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x3000, 'IDEOGRAPHIC SPACE'], [0x3164, 'HANGUL FILLER'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE (BOM)'], [0xffa0, 'HALFWIDTH HANGUL FILLER'],
  [0xfff9, 'INTERLINEAR ANNOTATION ANCHOR'], [0xfffa, 'INTERLINEAR ANNOTATION SEPARATOR'],
  [0xfffb, 'INTERLINEAR ANNOTATION TERMINATOR'],
]);
const KIND_NAMES = {
  tag_chars: 'TAG CHARACTER', variation_selector: 'VARIATION SELECTOR',
  private_use: 'PRIVATE USE CHARACTER', noncharacter: 'NONCHARACTER',
  reserved_ignorable: 'RESERVED IGNORABLE', other_cf: 'FORMAT CHARACTER',
  confusable: 'LOOKALIKE LETTER', bidi: 'DIRECTION CONTROL',
  zwj_family: 'ZERO-WIDTH CHARACTER', space: 'UNUSUAL SPACE', strip: 'INVISIBLE CHARACTER',
};
function nameFor(cp, kind) {
  if (NAMES.has(cp)) return NAMES.get(cp);
  if (inRange(cp, 0xfe00, 0xfe0f)) return 'VARIATION SELECTOR-' + (cp - 0xfe00 + 1);
  if (isVsSupplement(cp)) return 'VARIATION SELECTOR-' + (cp - 0xe0100 + 17);
  return KIND_NAMES[kind] || 'INVISIBLE CHARACTER';
}
const hex = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
// A tag character shadows printable ASCII one-for-one, so a run of them spells
// something. Reading it back is the whole trick.
const tagToAscii = (cp) => (inRange(cp, 0xe0020, 0xe007e) ? String.fromCharCode(cp - 0xe0000) : null);

// Space homoglyphs are weak evidence on their own — they arrive from ordinary
// copy-paste far more often than from anything deliberate.
const confidenceOf = (kind) => (kind === 'space' || kind === 'confusable' ? 'informational' : 'probable');

// Walk by CODE POINT while remembering the string index. The tag block and the
// variation supplement are astral, so a charCodeAt loop reports surrogate
// halves — two wrong answers instead of one right one.
function codePoints(text) {
  const cps = [], idx = [];
  let i = 0;
  for (const ch of String(text == null ? '' : text)) { cps.push(ch.codePointAt(0)); idx.push(i); i += ch.length; }
  return { cps, idx };
}

function walk(text, o) {
  const { cps, idx } = codePoints(text);
  const flags = validFlagTagIndices(cps);
  const bidiPairs = validBidiEmbeddingIndices(cps);
  const events = [];
  let out = '', prevKept = null;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const [action, ch, kind] = decide(cp, prevKept, i > 0 ? cps[i - 1] : null,
      i + 1 < cps.length ? cps[i + 1] : null,
      { ...o, validFlagTag: flags.has(i), validBidiEmbedding: bidiPairs.has(i) });
    if (action === 'keep') {
      out += ch;
      // Glue must NOT advance "previous kept", or a ZWJ chain loses its base
      // and the rest of the emoji falls apart.
      if (!isGlue(cp)) prevKept = cp;
      continue;
    }
    events.push({ index: idx[i], codepoint: cp, hex: hex(cp), name: nameFor(cp, kind),
      kind, category: kind, confidence: confidenceOf(kind), action,
      decodes_to: tagToAscii(cp) });
    if (action === 'replace') { out += ch; prevKept = ch.codePointAt(0); }
  }
  return { out, events };
}

// Report everything suspicious, including things clean() would leave alone.
function scan(text, options) {
  const o = options || {};
  const { events } = walk(text, {
    normalizeSpaces: true, confusables: !!o.aggressive,
    stripGlue: !!o.stripGlue, stripBidi: true,
  });
  const counts = Object.create(null);
  for (const e of events) counts[e.kind] = (counts[e.kind] || 0) + 1;
  const hidden = events.filter((e) => e.kind === 'tag_chars' && e.decodes_to)
    .map((e) => e.decodes_to).join('');
  return { total: events.length, counts, marks: events, hidden_message: hidden || null,
    clean: events.length === 0, length: String(text == null ? '' : text).length };
}

// Conservative by default: keeps direction marks and everything load-bearing.
function clean(text, options) {
  const o = options || {};
  const { out, events } = walk(text, {
    normalizeSpaces: o.normalizeSpaces !== false,
    confusables: !!o.aggressive,
    stripGlue: !!o.stripGlue,
    stripBidi: !!o.stripBidi,
  });
  let result = out;
  let nfkcChanged = false;
  if (o.nfkc) { const before = result; result = result.normalize('NFKC'); nfkcChanged = result !== before; }
  const removed = events.filter((e) => e.action === 'strip');
  const replaced = events.filter((e) => e.action === 'replace');
  return { text: result, removed, replaced, removed_count: removed.length,
    replaced_count: replaced.length, nfkc_changed: nfkcChanged,
    input_length: String(text == null ? '' : text).length, output_length: result.length };
}

module.exports = { scan, clean, hex, tagToAscii, nameFor, KIND_NAMES };
