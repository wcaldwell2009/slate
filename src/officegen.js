'use strict';

// Generates real Office/document files with ZERO dependencies and no installs:
//   - .pptx  (PowerPoint)  from slides [{title, bullets[]}]
//   - .docx  (Word)        from plain text
//   - .pdf                 from plain text (hand-rolled, Helvetica)
//   - .html                self-contained slideshow
//   - .txt                 plain text
//
// .pptx/.docx are OOXML = a ZIP of XML parts. We build the ZIP ourselves with
// Node's built-in zlib. Everything stays on the user's machine.

const zlib = require('zlib');

// ---------- minimal ZIP writer -------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data: Buffer }]
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const uncomp = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const comp = zlib.deflateRawSync(uncomp);
    const crc = crc32(uncomp);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0, 6);       // flags
    local.writeUInt16LE(8, 8);       // method: deflate
    local.writeUInt16LE(0, 10);      // mod time
    local.writeUInt16LE(0x21, 12);   // mod date (valid, non-zero)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(uncomp.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);      // extra len
    chunks.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);        // version made by
    cen.writeUInt16LE(20, 6);        // version needed
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(uncomp.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);        // extra
    cen.writeUInt16LE(0, 32);        // comment
    cen.writeUInt16LE(0, 34);        // disk
    cen.writeUInt16LE(0, 36);        // internal attrs
    cen.writeUInt32LE(0, 38);        // external attrs
    cen.writeUInt32LE(offset, 42);   // local header offset
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

const xmlEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// ---------- PPTX ----------------------------------------------------------
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

// Slate look. 16:9 slide = 12192000 x 6858000 EMU.
const SLIDE_W = 12192000, SLIDE_H = 6858000;
const C_BG = '14181D', C_SURFACE = '1F252C', C_ACCENT = '8CA891', C_TEXT = 'E8E6E1', C_MUTED = '6B7078';
const MARGIN = 548640;                      // 0.6"
const CONTENT_W = SLIDE_W - MARGIN * 2;

function run(text, sz, color, bold, spc) {
  const attrs = `lang="en-US" sz="${sz}"${bold ? ' b="1"' : ''}${spc ? ` spc="${spc}"` : ''} dirty="0"`;
  return `<a:r><a:rPr ${attrs}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Segoe UI"/></a:rPr><a:t>${xmlEsc(text)}</a:t></a:r>`;
}
function bulletPara(text, sz, color) {
  return `<a:p><a:pPr marL="342900" indent="-342900"><a:spcBef><a:spcPts val="900"/></a:spcBef><a:buClr><a:srgbClr val="${C_ACCENT}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>${run(text, sz, color)}</a:p>`;
}
function para(runsXml, align) { return `<a:p>${align ? `<a:pPr algn="${align}"/>` : ''}${runsXml}</a:p>`; }
function centerPara(runsXml) { return para(runsXml, 'ctr'); }

function textShape(id, name, x, y, cx, cy, paras, anchor) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"${anchor ? ` anchor="${anchor}"` : ''}><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}
function rectShape(id, name, x, y, cx, cy, fill, adj = 8000) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
}
// A filled rounded panel that holds its own text — the bullet "cards".
function panelShape(id, name, x, y, cx, cy, fill, paras) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 9000"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr lIns="365760" tIns="91440" rIns="228600" bIns="91440" anchor="ctr" wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}
// An empty, clearly-marked space to drop a picture into later.
function pictureFrame(id, x, y, cx, cy) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Picture space"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 6000"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="${C_SURFACE}"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="${C_ACCENT}"/></a:solidFill><a:prstDash val="dash"/></a:ln></p:spPr><p:txBody><a:bodyPr anchor="ctr" wrap="square"/><a:lstStyle/>${centerPara(run('Picture goes here', 1200, C_MUTED))}</p:txBody></p:sp>`;
}

function slideDoc(shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS_A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${C_BG}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld></p:sld>`;
}

// The opening slide: big left-aligned title against an accent rule, subtitle
// under it, and a small three-dot motif in Slate's colors.
function titleSlideXml(title, subtitle) {
  const barY = 1965960, barH = 1737360;
  const textX = MARGIN + 320040;
  const shapes =
    rectShape(2, 'Accent rule', MARGIN, barY, 54864, barH, C_ACCENT, 50000) +
    textShape(3, 'Title', textX, barY - 91440, 9448800, 1280160,
      para(run(title || 'Untitled', 4000, C_ACCENT, true), 'l'), 'b') +
    (subtitle
      ? textShape(4, 'Subtitle', textX, barY + 1280160, 9448800, 548640, para(run(subtitle, 1800, C_MUTED), 'l'), 't')
      : '') +
    rectShape(5, 'Dot 1', MARGIN, 5760720, 91440, 91440, C_ACCENT, 50000) +
    rectShape(6, 'Dot 2', MARGIN + 182880, 5760720, 91440, 91440, C_SURFACE, 50000) +
    rectShape(7, 'Dot 3', MARGIN + 365760, 5760720, 91440, 91440, C_SURFACE, 50000);
  return slideDoc(shapes);
}

// A content slide. Bullets become rounded cards with an accent tab so the deck
// looks designed without needing a photo on every slide. `slide.photo` reserves
// a framed space on the right instead.
function contentSlideXml(slide, index, total) {
  const title = slide.title || '';
  const bullets = (slide.bullets || []).map((b) => String(b)).filter((b) => b.trim());
  const wantsPic = !!slide.photo;

  const bodyY = 1706880;
  const bodyH = SLIDE_H - bodyY - 731520;              // leave room for the footer
  const bodyW = wantsPic ? 6217920 : CONTENT_W;

  let id = 2;
  let shapes =
    textShape(id++, 'Kicker', MARGIN, 274320, 2743200, 320040,
      para(run(String(index).padStart(2, '0'), 1100, C_MUTED, true, 300), 'l'), 't') +
    textShape(id++, 'Title', MARGIN, 594360, CONTENT_W, 822960, para(run(title, 3200, C_ACCENT, true), 'l'), 't') +
    rectShape(id++, 'Underline', MARGIN, 1463040, 1097280, 45720, C_ACCENT, 50000);

  if (bullets.length && bullets.length <= 6) {
    // Card layout — the interesting one.
    const gap = 137160;
    const cardH = Math.min(1005840, Math.floor((bodyH - gap * (bullets.length - 1)) / bullets.length));
    // Centre the stack in the body area so a short list doesn't sit up top with
    // a pile of dead space under it.
    const blockH = cardH * bullets.length + gap * (bullets.length - 1);
    const top = bodyY + Math.floor((bodyH - blockH) / 2);
    bullets.forEach((b, i) => {
      const y = top + i * (cardH + gap);
      shapes += panelShape(id++, `Point ${i + 1}`, MARGIN, y, bodyW, cardH, C_SURFACE,
        para(run(b, 1700, C_TEXT), 'l'));
      // accent tab down the left edge of the card
      const tabH = Math.round(cardH * 0.45);
      shapes += rectShape(id++, `Tab ${i + 1}`, MARGIN + 137160, y + Math.round((cardH - tabH) / 2), 45720, tabH, C_ACCENT, 50000);
    });
  } else if (bullets.length) {
    // Too many to card up nicely — fall back to a clean bullet list.
    shapes += textShape(id++, 'Body', MARGIN, bodyY, bodyW, bodyH,
      bullets.map((b) => bulletPara(b, 1600, C_TEXT)).join(''), 't');
  }

  if (wantsPic) {
    shapes += pictureFrame(id++, MARGIN + bodyW + 274320, bodyY, CONTENT_W - bodyW - 274320, bodyH);
  }

  if (total > 1) {
    shapes += textShape(id++, 'Footer', SLIDE_W - MARGIN - 1828800, SLIDE_H - 640080, 1828800, 274320,
      para(run(`${index} / ${total}`, 1000, C_MUTED), 'r'), 'b');
  }
  return slideDoc(shapes);
}

function themeXml() {
  const clr = (n, v) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  const sys = (n, last) => `<a:${n}><a:sysClr val="${last}" lastClr="${last === 'windowText' ? '000000' : 'FFFFFF'}"/></a:${n}>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${NS_A}" name="Office Theme"><a:themeElements><a:clrScheme name="Office">${sys('dk1', 'windowText')}${sys('lt1', 'window')}${clr('dk2', '44546A')}${clr('lt2', 'E7E6E6')}${clr('accent1', '4472C4')}${clr('accent2', 'ED7D31')}${clr('accent3', 'A5A5A5')}${clr('accent4', 'FFC000')}${clr('accent5', '5B9BD5')}${clr('accent6', '70AD47')}${clr('hlink', '0563C1')}${clr('folHlink', '954F72')}</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

function slideMasterXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="${NS_A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Text Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="&#8226;"/><a:defRPr sz="2800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`;
}

function slideLayoutXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="${NS_A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`;
}

// slides: [{ title, bullets[], photo? }] — slide 1 IS the title slide, so what
// Will sees in the builder is exactly what comes out.
// opts: { title, subtitle } are only fallbacks for an unfilled title slide.
function buildPptx(slides, opts = {}) {
  const list = (slides && slides.length) ? slides.slice() : [{ title: opts.title || 'Untitled', bullets: [] }];
  const first = list[0];
  const titleText = (first.title || '').trim() || opts.title || 'Untitled';
  const subtitle = ((first.bullets || []).map((b) => String(b).trim()).filter(Boolean)[0]) || opts.subtitle || '';

  const body = list.slice(1);
  const docs = [{ xml: titleSlideXml(titleText, subtitle) }];
  body.forEach((s, i) => docs.push({ xml: contentSlideXml(s, i + 2, list.length) }));

  const entries = [];

  const slideRefs = docs.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  const slideOverrides = docs.map((_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');

  // slide parts + per-slide rels (no media parts — Slate embeds no pictures)
  docs.forEach((d, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: d.xml });
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>` });
  });

  entries.unshift({ name: '[Content_Types].xml', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}</Types>` });

  entries.push({ name: '_rels/.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>` });

  entries.push({ name: 'ppt/presentation.xml', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${NS_A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slideRefs}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` });

  const presRels = docs.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('');
  entries.push({ name: 'ppt/_rels/presentation.xml.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels}<Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>` });

  entries.push({ name: 'ppt/theme/theme1.xml', data: themeXml() });
  entries.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: slideMasterXml() });
  entries.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>` });

  entries.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: slideLayoutXml() });
  entries.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>` });

  return makeZip(entries);
}

// ---------- DOCX ----------------------------------------------------------
function buildDocx(text) {
  const paras = String(text || '').split('\n').map((line) => {
    if (!line.trim()) return '<w:p/>';
    return `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r></w:p>`;
  }).join('');
  const document =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const entries = [
    { name: '[Content_Types].xml', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: '_rels/.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: document },
  ];
  return makeZip(entries);
}

// ---------- MLA DOCX ------------------------------------------------------
// Proper MLA: Times New Roman 12, double spaced throughout, 1" margins,
// "Lastname 1" running header, indented paragraphs, hanging-indent Works Cited
// on its own page. Takes the doc object from src/mla.js.
const DOUBLE = '<w:spacing w:after="0" w:line="480" w:lineRule="auto"/>';

// A line the student turned into a list item with the editor's toolbar.
// The draft is plain text on purpose, so this is how the shape survives into
// Word and PDF.
function runsPlain(runs) {
  return (runs || []).map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
}

function isListLine(line) {
  return /^\s*(?:[•\-*]\s+|\d+[.)]\s+)/.test(line);
}

// One formatted run. font/size null means "follow the document", which is how
// MLA stays the default until the student picks something themselves.
function runXml(r) {
  const p = [];
  if (r.font) p.push(`<w:rFonts w:ascii="${xmlEsc(r.font)}" w:hAnsi="${xmlEsc(r.font)}" w:cs="${xmlEsc(r.font)}"/>`);
  if (r.b) p.push('<w:b/>');
  if (r.i) p.push('<w:i/>');
  if (r.u) p.push('<w:u w:val="single"/>');
  // Word measures type in half-points.
  if (r.size) p.push(`<w:sz w:val="${Math.round(r.size * 2)}"/><w:szCs w:val="${Math.round(r.size * 2)}"/>`);
  const rPr = p.length ? `<w:rPr>${p.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(r.text || '')}</w:t></w:r>`;
}

function mlaPara(text, opts = {}) {
  const props = [DOUBLE];
  if (opts.center) props.push('<w:jc w:val="center"/>');
  if (opts.right) props.push('<w:jc w:val="right"/>');
  if (opts.firstLine) props.push('<w:ind w:firstLine="720"/>');
  if (opts.hanging) props.push('<w:ind w:left="720" w:hanging="720"/>');
  if (opts.list) props.push('<w:ind w:left="720" w:hanging="360"/>');
  const runs = opts.pageBreak
    ? '<w:r><w:br w:type="page"/></w:r>'
    : (opts.runs && opts.runs.length)
      ? opts.runs.map(runXml).join('')
      : `<w:r><w:t xml:space="preserve">${xmlEsc(text || '')}</w:t></w:r>`;
  return `<w:p><w:pPr>${props.join('')}</w:pPr>${runs}</w:p>`;
}

function buildMlaDocx(doc) {
  const body = [];
  // Heading block, flush left, double spaced.
  body.push(mlaPara(doc.student || '[your name]'));
  body.push(mlaPara(doc.teacher || '[teacher name]'));
  if (doc.className) body.push(mlaPara(doc.className));
  if (doc.date) body.push(mlaPara(doc.date));
  // No title means no title line. A placeholder would be handed in verbatim.
  if (doc.title) body.push(mlaPara(doc.title, { center: true }));
  // A formatted draft comes through as blocks with runs; a plain one is still
  // just strings. Both end up as the same paragraphs.
  if (doc.blocks && doc.blocks.length) {
    for (const b of doc.blocks) {
      if (b.type === 'ul' || b.type === 'ol') {
        b.items.forEach((runs, i) => body.push(mlaPara(null, {
          list: true,
          runs: [{ text: b.type === 'ol' ? `${i + 1}. ` : '• ' }, ...runs],
        })));
        continue;
      }
      body.push(mlaPara(null, {
        runs: b.runs,
        center: b.align === 'center',
        right: b.align === 'right',
      }));
    }
  } else {
    // A paragraph the student made into a list keeps its shape: each line its
    // own paragraph, indented and hanging, not one blob with bullets in it.
    doc.paragraphs.forEach((p) => {
      const lines = String(p).split('\n');
      const listy = lines.length > 1 && lines.every((l) => !l.trim() || isListLine(l));
      if (!listy) { body.push(mlaPara(p)); return; }
      lines.filter((l) => l.trim()).forEach((l) => body.push(mlaPara(l.trim(), { list: true })));
    });
  }
  if (doc.worksCited && doc.worksCited.length) {
    body.push(mlaPara('', { pageBreak: true }));
    body.push(mlaPara('Works Cited', { center: true }));
    doc.worksCited.forEach((c) => body.push(mlaPara(c, { hanging: true })));
  }

  const sectPr =
    '<w:sectPr><w:headerReference xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId2" w:type="default"/>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

  const document =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

  // Running header: "Lastname 1" at the top right of every page.
  const header =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEsc(doc.lastName || '')} </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:hdr>`;

  // Times New Roman 12 is the default because that is MLA. If the student
  // picked a font or a size in the editor, theirs becomes the document default
  // instead — that is the whole point of the picker.
  const baseFont = doc.font || 'Times New Roman';
  const baseHalfPts = Math.round((doc.size || 12) * 2);
  const styles =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${xmlEsc(baseFont)}" w:hAnsi="${xmlEsc(baseFont)}" w:cs="${xmlEsc(baseFont)}"/><w:sz w:val="${baseHalfPts}"/><w:szCs w:val="${baseHalfPts}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${DOUBLE}</w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;

  const entries = [
    { name: '[Content_Types].xml', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>` },
    { name: '_rels/.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>` },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/header1.xml', data: header },
  ];
  return makeZip(entries);
}

// ---------- PDF (hand-rolled, Helvetica) ----------------------------------
function pdfEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

function wrapLines(text, maxChars) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.length) { out.push(''); continue; }
    let line = '';
    for (const word of raw.split(/\s+/)) {
      if ((line + (line ? ' ' : '') + word).length > maxChars) {
        if (line) out.push(line);
        line = word.length > maxChars ? word.slice(0, maxChars) : word;
      } else {
        line += (line ? ' ' : '') + word;
      }
    }
    out.push(line);
  }
  return out;
}

function buildPdf(text) {
  const fontSize = 11, leading = 15, top = 760, left = 56, bottom = 56, maxChars = 92, perPage = Math.floor((top - bottom) / leading);
  const allLines = wrapLines(text, maxChars);
  const pages = [];
  for (let i = 0; i < allLines.length; i += perPage) pages.push(allLines.slice(i, i + perPage));
  if (!pages.length) pages.push(['']);

  const objects = [];
  const kids = [];
  // 1 catalog, 2 pages, 3 font, then per page: content + page object
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let objNum = 4;
  for (const pageLines of pages) {
    let stream = `BT /F1 ${fontSize} Tf ${leading} TL ${left} ${top} Td\n`;
    stream += pageLines.map((l) => `(${pdfEscape(l)}) Tj T*`).join('\n');
    stream += '\nET';
    const contentObj = objNum++;
    const pageObj = objNum++;
    objects[contentObj] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    kids.push(`${pageObj} 0 R`);
  }
  objects[2] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objNum; i++) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objNum}\n0000000000 65535 f \n`;
  for (let i = 1; i < objNum; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objNum} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

// ---------- MLA PDF -------------------------------------------------------
// Same layout rules as the docx: Times 12, double spaced, 1" margins, running
// header, 0.5" first-line indents, hanging-indent Works Cited on a new page.
function buildMlaPdf(doc) {
  const FS = 12, LEAD = 24, LEFT = 72, RIGHT = 540, TOP = 720, BOTTOM = 72, INDENT = 36;
  const MAXCH = 85;
  const perPage = Math.floor((TOP - BOTTOM) / LEAD) + 1;
  const widthOf = (s) => String(s).length * FS * 0.5; // close enough for Times

  const lines = [];
  const push = (text, opts) => lines.push({ text, indent: 0, center: false, pageBreak: false, ...(opts || {}) });
  push(doc.student || '[your name]');
  push(doc.teacher || '[teacher name]');
  if (doc.className) push(doc.className);
  if (doc.date) push(doc.date);
  // No title means no title line — a placeholder would be handed in verbatim.
  if (doc.title) push(doc.title, { center: true });

  // A formatted draft renders from the same blocks the Word file uses. The PDF
  // is base-14 fonts only, so bold/italic map onto Times' faces and per-run
  // font choices fall back to the document's.
  if (doc.blocks && doc.blocks.length) {
    for (const b of doc.blocks) {
      if (b.type === 'ul' || b.type === 'ol') {
        b.items.forEach((runs, i) => {
          const marker = b.type === 'ol' ? `${i + 1}. ` : '• ';
          wrapLines(marker + runsPlain(runs), MAXCH - 6).forEach((l, j) => push(l, { indent: INDENT + (j ? 24 : 0) }));
        });
        continue;
      }
      const text = runsPlain(b.runs);
      const opts = b.align === 'center' ? { center: true } : {};
      wrapLines(text, MAXCH).forEach((l) => push(l, opts));
    }
  } else {
  (doc.paragraphs || []).forEach((p) => {
    // A bulleted or numbered block keeps one line per item, indented.
    if (isListLine(p) && String(p).includes('\n')) {
      String(p).split('\n').filter((l) => l.trim()).forEach((item) => {
        wrapLines(item.trim(), MAXCH - 6).forEach((l, i) => push(l, { indent: INDENT + (i ? 24 : 0) }));
      });
      return;
    }
    wrapLines(p, MAXCH).forEach((l) => push(l));
  });
  }
  if (doc.worksCited && doc.worksCited.length) {
    push('', { pageBreak: true });
    push('Works Cited', { center: true });
    doc.worksCited.forEach((c) => {
      wrapLines(c, MAXCH).forEach((l, i) => push(l, { indent: i === 0 ? 0 : INDENT }));
    });
  }

  const pages = [[]];
  for (const ln of lines) {
    if (ln.pageBreak) { pages.push([]); continue; }
    if (pages[pages.length - 1].length >= perPage) pages.push([]);
    pages[pages.length - 1].push(ln);
  }

  const objects = [];
  const kids = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>';
  let objNum = 4;
  pages.forEach((pageLines, pageIdx) => {
    let stream = `BT /F1 ${FS} Tf\n`;
    // Running header, top right, half an inch down.
    const head = `${doc.lastName || ''} ${pageIdx + 1}`.trim();
    if (head) stream += `1 0 0 1 ${(RIGHT - widthOf(head)).toFixed(1)} 756 Tm (${pdfEscape(head)}) Tj\n`;
    pageLines.forEach((ln, i) => {
      const y = TOP - i * LEAD;
      const x = ln.center ? (LEFT + RIGHT) / 2 - widthOf(ln.text) / 2 : LEFT + ln.indent;
      stream += `1 0 0 1 ${x.toFixed(1)} ${y} Tm (${pdfEscape(ln.text)}) Tj\n`;
    });
    stream += 'ET';
    const contentObj = objNum++;
    const pageObj = objNum++;
    objects[contentObj] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    kids.push(`${pageObj} 0 R`);
  });
  objects[2] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objNum; i++) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objNum}\n0000000000 65535 f \n`;
  for (let i = 1; i < objNum; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objNum} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

// ---------- HTML slideshow ------------------------------------------------
// Same design as the pptx: slide 1 is the title slide, bullets become cards,
// and a slide marked for a picture gets an empty framed space.
function buildHtmlSlides(slides, title) {
  const list = (slides && slides.length) ? slides.slice() : [{ title: title || 'Untitled', bullets: [] }];
  const first = list[0];
  const headTitle = (first.title || '').trim() || title || 'Untitled';
  const subtitle = ((first.bullets || []).map((b) => String(b).trim()).filter(Boolean)[0]) || '';
  const total = list.length;

  const titleSlide = `<section class="slide title"><div class="bar"></div><div><h1>${xmlEsc(headTitle)}</h1>${subtitle ? `<p class="sub">${xmlEsc(subtitle)}</p>` : ''}</div><div class="dots"><i class="on"></i><i></i><i></i></div></section>`;

  const sec = list.slice(1).map((s, i) => {
    const bl = (s.bullets || []).map((b) => String(b)).filter((b) => b.trim());
    const cards = bl.length && bl.length <= 6
      ? `<div class="cards">${bl.map((b) => `<div class="card">${xmlEsc(b)}</div>`).join('')}</div>`
      : (bl.length ? `<ul>${bl.map((b) => `<li>${xmlEsc(b)}</li>`).join('')}</ul>` : '');
    const frame = s.photo ? '<div class="picspace">Picture goes here</div>' : '';
    return `<section class="slide"><div class="kicker">${String(i + 2).padStart(2, '0')}</div>
<div class="row"><div class="txt"><h2>${xmlEsc(s.title || '')}</h2><div class="ul-rule"></div>${cards}</div>${frame}</div>
<div class="pagenum">${i + 2} / ${total}</div></section>`;
  }).join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${xmlEsc(headTitle)}</title>
<style>body{margin:0;font-family:'Segoe UI',Arial,sans-serif;background:#14181D;color:#E8E6E1}
.slide{position:relative;min-height:100vh;padding:9vh 7vw;box-sizing:border-box;border-bottom:1px solid #1F252C;display:flex;flex-direction:column;justify-content:center}
.slide.title{flex-direction:row;align-items:center;gap:34px}
.bar{width:6px;align-self:stretch;max-height:220px;background:#8CA891;border-radius:3px}
h1{font-size:60px;margin:0;color:#8CA891;line-height:1.1}
.sub{font-size:21px;color:#6B7078;margin:16px 0 0}
.dots{position:absolute;left:7vw;bottom:8vh;display:flex;gap:12px}
.dots i{width:11px;height:11px;border-radius:50%;background:#1F252C;display:block}
.dots i.on{background:#8CA891}
.kicker{position:absolute;top:6vh;left:7vw;font-size:13px;letter-spacing:3px;color:#6B7078;font-weight:600}
.pagenum{position:absolute;right:7vw;bottom:6vh;font-size:13px;color:#6B7078}
.row{display:flex;gap:3vw;align-items:stretch}
.txt{flex:1;min-width:0}
h2{font-size:40px;margin:0 0 14px;color:#8CA891}
.ul-rule{width:72px;height:5px;background:#8CA891;border-radius:3px;margin-bottom:26px}
.cards{display:flex;flex-direction:column;gap:12px}
.card{background:#1F252C;border-radius:14px;padding:20px 24px 20px 34px;font-size:22px;line-height:1.45;position:relative}
.card::before{content:"";position:absolute;left:14px;top:50%;transform:translateY(-50%);width:5px;height:45%;background:#8CA891;border-radius:3px}
ul{font-size:21px;line-height:1.7;padding-left:22px}li{margin-bottom:10px}
.picspace{flex:0 0 34%;border:2px dashed #8CA891;border-radius:14px;background:#1F252C;display:flex;align-items:center;justify-content:center;color:#6B7078;font-size:15px;min-height:300px}</style></head>
<body>${titleSlide}${sec}</body></html>`;
}

// ---------- format registry ----------------------------------------------
// kind 'text'  -> content is a string
// kind 'slides'-> content is { slides:[{title,bullets}], title }
const FORMATS = {
  text: [
    { ext: 'txt', label: 'Text (.txt)', mime: 'text/plain', build: (c) => Buffer.from(String(c || ''), 'utf8') },
    { ext: 'docx', label: 'Word (.docx)', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', build: (c) => buildDocx(c) },
    { ext: 'pdf', label: 'PDF (.pdf)', mime: 'application/pdf', build: (c) => buildPdf(c) },
  ],
  slides: [
    { ext: 'pptx', label: 'PowerPoint (.pptx)', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', build: (c) => buildPptx(c.slides, { title: c.title, subtitle: c.subtitle }) },
    { ext: 'html', label: 'Web page (.html)', mime: 'text/html', build: (c) => Buffer.from(buildHtmlSlides(c.slides, c.title), 'utf8') },
    { ext: 'txt', label: 'Text outline (.txt)', mime: 'text/plain', build: (c) => Buffer.from(slidesToText(c.slides, c.title), 'utf8') },
  ],
  // kind 'mla' -> content is the doc object from src/mla.js
  mla: [
    { ext: 'docx', label: 'Word, MLA (.docx)', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', build: (c) => buildMlaDocx(c) },
    { ext: 'pdf', label: 'PDF, MLA (.pdf)', mime: 'application/pdf', build: (c) => buildMlaPdf(c) },
    { ext: 'txt', label: 'Plain text (.txt)', mime: 'text/plain', build: (c) => Buffer.from(require('./mla').toText(c), 'utf8') },
  ],
};

function slidesToText(slides, title) {
  const list = (slides && slides.length) ? slides : [];
  const lines = [];
  list.forEach((s, i) => {
    const label = i === 0 ? 'Title slide' : `Slide ${i + 1}`;
    lines.push(`${label}: ${s.title || (i === 0 ? title || '' : '')}`);
    (s.bullets || []).filter((b) => String(b).trim()).forEach((b) => lines.push(`  • ${b}`));
    if (s.photo && i > 0) lines.push('  [space left for a picture]');
    lines.push('');
  });
  return lines.join('\n');
}

function formatsFor(kind) {
  return (FORMATS[kind] || FORMATS.text).map((f) => ({ ext: f.ext, label: f.label }));
}
function buildFile(kind, format, content) {
  const list = FORMATS[kind] || FORMATS.text;
  const f = list.find((x) => x.ext === format) || list[0];
  return { ext: f.ext, mime: f.mime, bytes: f.build(content) };
}

module.exports = { buildPptx, buildDocx, buildPdf, buildMlaDocx, buildMlaPdf, buildHtmlSlides, slidesToText, formatsFor, buildFile, makeZip };
