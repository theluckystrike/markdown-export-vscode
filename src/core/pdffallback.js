'use strict';
// Built-in PDF engine for computers without Chrome, Edge or Brave: pdfmake (MIT) from the Markdown model.
// Simpler layout than the browser path: no Mermaid drawings (shown as code), formulas as TeX text, PNG and JPEG
// images only. It needs no download and no network.
const fs = require('fs');
const path = require('path');
const images = require('./images');
const { codeLines } = require('./hlruns');
const { plain } = require('./model');
const { templateParts } = require('./options');

const PT = 72 / 25.4;
const MAX_DEPTH = 8;
// Characters Roboto has: Latin, Greek, Cyrillic, common punctuation and currency.
const OUTSIDE_ROBOTO = /[^\u0000-\u052F\u1E00-\u1FFF\u2000-\u206F\u20A0-\u20CF\u2100-\u214F\u2190-\u21FF\u2200-\u22FF\uFB00-\uFB06\uFEFF]/u;
const OUTSIDE_ASCII = /[^\u0020-\u007E\t]/;

const UNICODE_FONTS = {
  darwin: ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/Library/Fonts/Arial Unicode.ttf'],
  win32: ['C:\\Windows\\Fonts\\ARIALUNI.TTF', 'C:\\Windows\\Fonts\\arialuni.ttf'],
  linux: ['/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', '/usr/share/fonts/truetype/arphic/uming.ttc', '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
};

function findUnicodeFont(custom) {
  const list = [custom, ...(UNICODE_FONTS[process.platform] || UNICODE_FONTS.linux)].filter(Boolean);
  for (const p of list) { try { if (/\.(ttf|otf)$/i.test(p) && fs.statSync(p).isFile()) return p; } catch (e) { /* next */ } }
  return '';
}

let pdfmakeInstance = null;
function getPdfmake(fontsDir, unicodeFont) {
  // eslint-disable-next-line global-require
  const pdfmake = pdfmakeInstance || (pdfmakeInstance = require('pdfmake'));
  const fonts = {
    Roboto: {
      normal: path.join(fontsDir, 'Roboto-Regular.ttf'),
      bold: path.join(fontsDir, 'Roboto-Medium.ttf'),
      italics: path.join(fontsDir, 'Roboto-Italic.ttf'),
      bolditalics: path.join(fontsDir, 'Roboto-MediumItalic.ttf'),
    },
    // KaTeX Typewriter (SIL OFL 1.1): a small monospace font for code, ASCII only
    Mono: { normal: path.join(fontsDir, 'KaTeX_Typewriter-Regular.ttf'), bold: path.join(fontsDir, 'KaTeX_Typewriter-Regular.ttf'), italics: path.join(fontsDir, 'KaTeX_Typewriter-Regular.ttf'), bolditalics: path.join(fontsDir, 'KaTeX_Typewriter-Regular.ttf') },
  };
  if (unicodeFont) fonts.Unicode = { normal: unicodeFont, bold: unicodeFont, italics: unicodeFont, bolditalics: unicodeFont };
  pdfmake.setFonts(fonts);
  pdfmake.setUrlAccessPolicy(() => false); // never fetch anything
  const allowed = [path.resolve(fontsDir), unicodeFont ? path.resolve(unicodeFont) : null].filter(Boolean);
  pdfmake.setLocalAccessPolicy((p) => allowed.some((a) => path.resolve(p) === a || path.resolve(p).startsWith(a + path.sep)));
  return pdfmake;
}

/**
 * ctx: { options, docDir, title, fontsDir, unicodeFont?, warn, cover?, fetchRemote? }
 * Writes the PDF to file. Returns {bytes, pages}.
 */
async function buildPdf(model, file, ctx) {
  const o = ctx.options;
  const warn = ctx.warn || (() => {});
  const uni = ctx.unicodeFont === undefined ? findUnicodeFont(o.fallbackFont) : ctx.unicodeFont;
  let warnedGlyphs = false;
  const pageW = o.paper.width * PT; const pageH = o.paper.height * PT;
  const m = o.margin;
  const contentW = pageW - (m.left + m.right) * PT;
  const contentH = pageH - (m.top + m.bottom) * PT;
  const fs0 = o.fontSize;

  const imgCache = new Map();
  async function loadImage(src) {
    if (imgCache.has(src)) return imgCache.get(src);
    const info = images.resolveImage(src, ctx.docDir);
    let r = null;
    if (info.kind === 'local') { if (!info.exists) warn(`Image not found: ${info.path}`); else r = images.readLocal(info); }
    else if (info.kind === 'data') r = { buffer: info.buffer, mime: images.sniffMime(info.buffer.subarray(0, 64)) || info.mime };
    else if (info.kind === 'remote') { if (o.allowRemoteImages && ctx.fetchRemote) r = await ctx.fetchRemote(info.url); else warn(`Remote image not loaded (remote images are off): ${info.url}`); }
    else warn(`Image skipped: ${info.reason}`);
    if (r && !/^image\/(png|jpeg)$/.test(r.mime)) { warn(`The built-in PDF engine shows PNG and JPEG images only; kept as text: ${String(src).slice(0, 120)}`); r = null; }
    imgCache.set(src, r);
    return r;
  }
  async function preload(blocks) {
    for (const b of blocks) {
      const lists = [b.inlines, ...(b.type === 'table' ? [b.head, ...b.rows].flat() : [])].filter(Boolean);
      for (const l of lists) for (const x of l) if (x.t === 'img') await loadImage(x.src);
      if (b.blocks) await preload(b.blocks);
      if (b.items) for (const it of b.items) await preload(it.blocks);
    }
  }
  await preload(model);

  const fontFor = (text, mono) => {
    if (mono) {
      if (OUTSIDE_ASCII.test(text)) return OUTSIDE_ROBOTO.test(text) && uni ? 'Unicode' : 'Roboto';
      return 'Mono';
    }
    if (OUTSIDE_ROBOTO.test(text)) {
      if (uni) return 'Unicode';
      if (!warnedGlyphs) { warnedGlyphs = true; warn('Some characters (for example CJK, Arabic or symbols) have no font in the built-in PDF engine. Install Chrome, Edge or Brave, or set markdownExport.fallbackFont to a .ttf font.'); }
    }
    return undefined;
  };

  function textNodes(inl, extra = {}) {
    const out = [];
    for (const x of inl) {
      if (x.t === 'text') {
        const n = { text: x.text };
        if (x.b || extra.bold) n.bold = true;
        if (x.i || extra.italics) n.italics = true;
        const dec = [x.s && 'lineThrough', (x.u || x.href) && 'underline'].filter(Boolean);
        if (dec.length) n.decoration = dec.length === 1 ? dec[0] : dec;
        if (x.sup) n.sup = true;
        if (x.sub) n.sub = true;
        if (x.mark) n.background = '#fff8c5';
        if (x.code) { n.background = '#eff1f3'; n.fontSize = fs0 * 0.9; }
        const f = fontFor(x.text, !!x.code);
        if (f) n.font = f;
        if (x.href) {
          n.color = '#0969da';
          if (x.href.startsWith('#')) n.linkToDestination = decodeURIComponent(x.href.slice(1));
          else if (/^(https?|mailto):/i.test(x.href)) n.link = x.href;
        }
        if (extra.color && !n.color) n.color = extra.color;
        out.push(n);
      } else if (x.t === 'br') out.push({ text: '\n' });
      else if (x.t === 'math') out.push({ text: x.tex, italics: true, font: fontFor(x.tex) });
      else if (x.t === 'fnref') out.push({ text: String(x.n), sup: true, color: '#0969da', linkToDestination: `fn-${x.n}` });
      else if (x.t === 'img') out.push({ text: `[${x.alt || 'image'}]`, italics: true, color: '#59636e' });
    }
    return out;
  }

  // A paragraph: text, with its images placed as blocks after the text they follow.
  function paragraph(inl, extra = {}) {
    const parts = []; let cur = [];
    for (const x of inl) {
      const r = x.t === 'img' ? imgCache.get(x.src) : null;
      if (r) {
        if (cur.length) { parts.push({ text: textNodes(cur, extra) }); cur = []; }
        const sz = images.imageSize(r.buffer);
        const wantW = x.width ? Math.min(x.width * 0.75, contentW) : null;
        const node = { image: images.dataUri(r.buffer, r.mime), margin: [0, 2, 0, 4] };
        if (sz) { const w = wantW || Math.min(sz.width * 0.75, contentW); node.fit = [w, contentH * 0.9]; } else node.fit = [contentW, contentH * 0.9];
        if (x.href && /^https?:/i.test(x.href)) node.link = x.href;
        parts.push(node);
      } else cur.push(x);
    }
    if (cur.length) parts.push({ text: textNodes(cur, extra) });
    if (parts.length === 1) return parts[0];
    return { stack: parts };
  }

  function codeNode(text, lang) {
    const lines = codeLines(text, lang);
    const t = [];
    lines.forEach((line, k) => {
      if (k) t.push({ text: '\n' });
      for (const r of line) {
        const n = { text: r.text, color: r.color ? `#${r.color}` : '#1f2328' };
        const f = fontFor(r.text, true); if (f !== 'Mono') n.font = f;
        if (r.italic) n.italics = true;
        if (r.bold) n.bold = true;
        t.push(n);
      }
    });
    return {
      table: { widths: ['*'], body: [[{ text: t.length ? t : ' ', font: 'Mono', fontSize: fs0 * 0.85, preserveLeadingSpaces: true, lineHeight: 1.15 }]] },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => '#f6f8fa', paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6 },
      margin: [0, 2, 0, 8],
    };
  }

  function blocks(list, depth) {
    const out = [];
    for (const b of list) {
      const n = block(b, depth);
      if (n) out.push(n);
    }
    return out;
  }

  function block(b, depth) {
    switch (b.type) {
      case 'heading': {
        const node = { text: textNodes(b.inlines), style: `h${b.level}`, id: b.slug || undefined, headlineLevel: b.level };
        if (o.toc && b.level <= 3) node.tocItem = true;
        node.tocMargin = [(b.level - 1) * 12, 0, 0, 0];
        return node;
      }
      case 'para': { const p = paragraph(b.inlines); p.margin = [0, 0, 0, 8]; return p; }
      case 'list': {
        if (depth >= MAX_DEPTH) {
          // Deeper than 8 levels: no more indentation, so a hostile 200-level list still fits the page.
          return { stack: b.items.map((it) => ({ stack: blocks(it.blocks, depth + 1) })) };
        }
        const items = b.items.map((it) => {
          const inner = blocks(it.blocks, depth + 1).map((n) => { if (n && n.margin) n.margin = [n.margin[0], n.margin[1], n.margin[2], 2]; return n; });
          if (it.task !== null) {
            const box = { text: it.task ? '[x] ' : '[ ] ', font: 'Mono' };
            if (inner.length && inner[0].text) inner[0] = { ...inner[0], text: [box, ...(Array.isArray(inner[0].text) ? inner[0].text : [{ text: inner[0].text }])] };
            else inner.unshift({ text: [box] });
          }
          return inner.length === 1 ? inner[0] : { stack: inner };
        });
        const node = b.ordered ? { ol: items, start: b.start } : { ul: items };
        if (b.items.every((it) => it.task !== null)) { node.type = 'none'; }
        node.margin = [0, 0, 0, 8];
        return node;
      }
      case 'quote':
        return {
          table: { widths: ['*'], body: [[{ stack: blocks(b.blocks, depth), color: '#59636e' }]] },
          layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 3 : 0), vLineColor: () => '#d1d9e0', paddingLeft: () => 10, paddingTop: () => 0, paddingBottom: () => 0 },
          margin: [0, 0, 0, 8],
        };
      case 'code': return codeNode(b.text, b.lang);
      case 'mermaid': return { stack: [{ text: 'Mermaid diagram, shown as code. Install Chrome, Edge or Brave to export it as a drawing.', italics: true, fontSize: fs0 * 0.85, color: '#6f4b00' }, codeNode(b.text, '')] };
      case 'math': return { text: b.tex.trim(), italics: true, alignment: 'center', margin: [0, 4, 0, 10], font: fontFor(b.tex) };
      case 'table': {
        const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length), 1);
        const al = (k) => b.aligns[k] || 'left';
        const row = (cells, header) => Array.from({ length: cols }, (_, k) => ({ ...paragraph(cells[k] || [], header ? { bold: true } : {}), alignment: al(k), fillColor: header ? '#f6f8fa' : undefined }));
        const body = [];
        if (b.head.length) body.push(row(b.head, true));
        for (const r of b.rows) body.push(row(r, false));
        if (!body.length) return null;
        return {
          table: { headerRows: b.head.length ? 1 : 0, widths: Array(cols).fill(cols > 4 ? '*' : 'auto'), body, dontBreakRows: true },
          layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => '#d1d9e0', vLineColor: () => '#d1d9e0', paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 3, paddingBottom: () => 3 },
          margin: [0, 0, 0, 10],
          fontSize: cols > 6 ? fs0 * 0.8 : fs0,
        };
      }
      case 'hr': return { canvas: [{ type: 'line', x1: 0, y1: 4, x2: contentW, y2: 4, lineWidth: 2, lineColor: '#d1d9e0' }], margin: [0, 6, 0, 10] };
      case 'pagebreak': return { text: '', pageBreak: 'after' };
      case 'footnotes':
        return {
          stack: [
            { canvas: [{ type: 'line', x1: 0, y1: 4, x2: contentW / 3, y2: 4, lineWidth: 0.6, lineColor: '#d1d9e0' }], margin: [0, 12, 0, 6] },
            ...b.items.map((it) => ({ id: `fn-${it.n}`, text: [{ text: `${it.n}. `, bold: true }, ...it.blocks.flatMap((fb) => (fb.inlines ? textNodes(fb.inlines.filter((x) => x.t !== 'fnref')) : [{ text: fb.text || '' }]))], fontSize: fs0 * 0.85, color: '#59636e', margin: [0, 0, 0, 3] })),
          ],
        };
      default: return null;
    }
  }

  const content = [];
  if (ctx.cover) {
    content.push({
      stack: [
        { text: o.coverTitle || ctx.title || 'Document', fontSize: fs0 * 2.6, bold: true, alignment: 'center', margin: [0, contentH * 0.3, 0, 12], font: fontFor(o.coverTitle || ctx.title || '') },
        o.coverSubtitle ? { text: o.coverSubtitle, fontSize: fs0 * 1.35, color: '#59636e', alignment: 'center', margin: [0, 0, 0, 24], font: fontFor(o.coverSubtitle) } : null,
        o.coverAuthor ? { text: o.coverAuthor, fontSize: fs0 * 1.1, alignment: 'center', font: fontFor(o.coverAuthor) } : null,
        o.coverDate ? { text: o.coverDate, fontSize: fs0 * 1.1, alignment: 'center', color: '#59636e' } : null,
      ].filter(Boolean),
      pageBreak: 'after',
    });
  }
  if (o.toc && model.some((b) => b.type === 'heading' && b.level <= 3)) {
    content.push({ toc: { title: { text: 'Contents', style: 'tocTitle' }, numberStyle: { color: '#59636e' } }, pageBreak: 'after' });
  }
  content.push(...blocks(model, 0));
  if (!content.length) content.push({ text: ' ' });

  const today = new Date().toISOString().slice(0, 10);
  const band = (tpl, top) => (tpl ? (currentPage, pageCount) => {
    if (ctx.cover && currentPage === 1) return null;
    const text = templateParts(tpl).map((p) => (p.text != null ? p.text : p.field === 'page' ? String(currentPage) : p.field === 'pages' ? String(pageCount) : p.field === 'title' ? (ctx.title || '') : (o.date || today))).join('');
    return { text, alignment: 'center', fontSize: 8, color: '#59636e', margin: top ? [m.left * PT, Math.max(8, m.top * PT / 2 - 4), m.right * PT, 0] : [m.left * PT, Math.max(4, m.bottom * PT / 2 - 4), m.right * PT, 0], font: fontFor(text) };
  } : undefined);

  const def = {
    pageSize: { width: pageW, height: pageH },
    pageMargins: [m.left * PT, m.top * PT, m.right * PT, m.bottom * PT],
    info: { title: ctx.title || '', author: o.author || '', creator: 'Markdown Export', producer: 'Markdown Export (built-in engine)' },
    header: band(o.header, true),
    footer: band(o.footer, false),
    content,
    defaultStyle: { font: 'Roboto', fontSize: fs0, lineHeight: 1.25, color: '#1f2328' },
    styles: {
      h1: { fontSize: fs0 * 2, bold: true, margin: [0, 14, 0, 8] },
      h2: { fontSize: fs0 * 1.5, bold: true, margin: [0, 12, 0, 6] },
      h3: { fontSize: fs0 * 1.25, bold: true, margin: [0, 10, 0, 5] },
      h4: { fontSize: fs0, bold: true, margin: [0, 8, 0, 4] },
      h5: { fontSize: fs0 * 0.9, bold: true, margin: [0, 6, 0, 3] },
      h6: { fontSize: fs0 * 0.85, bold: true, color: '#59636e', margin: [0, 6, 0, 3] },
      tocTitle: { fontSize: fs0 * 1.5, bold: true, margin: [0, 0, 0, 10] },
    },
  };
  if (o.lang) def.language = o.lang;

  const pdfmake = getPdfmake(ctx.fontsDir, uni);
  const doc = pdfmake.createPdf(def);
  const buffer = await doc.getBuffer();
  const tmp = `${file}.${process.pid}.part`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
  return { bytes: buffer.length };
}

module.exports = { buildPdf, findUnicodeFont };
