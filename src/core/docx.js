'use strict';
// Markdown model -> Word .docx with the docx package (MIT). Headings use Word's own Heading 1-6 styles, so the
// Navigation pane and Word's own table of contents work on the result.
const D = require('docx');
const images = require('./images');
const { codeLines } = require('./hlruns');
const { plain } = require('./model');
const { templateParts } = require('./options');

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ一-鿿가-힯]/;
function firstStrongRtl(s) {
  for (const ch of String(s)) { if (RTL_RE.test(ch)) return true; if (LTR_RE.test(ch)) return false; }
  return false;
}

const MM_TWIP = 56.6929;
const twip = (mm) => Math.round(mm * MM_TWIP);
const MAX_LEVEL = 8;
const CODE_FONT = 'Consolas';
const LINK_COLOR = '0563C1';

function bookmarkName(slug, n) {
  const base = String(slug).normalize('NFKD').replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '').slice(0, 30) || 'h';
  return `${base}_${n}`;
}

function numberingLevels(ordered) {
  const fmts = [D.LevelFormat.DECIMAL, D.LevelFormat.LOWER_LETTER, D.LevelFormat.LOWER_ROMAN];
  const bullets = ['•', '◦', '▪'];
  const levels = [];
  for (let l = 0; l <= MAX_LEVEL; l++) {
    levels.push({
      level: l,
      format: ordered ? fmts[l % 3] : D.LevelFormat.BULLET,
      text: ordered ? `%${l + 1}.` : bullets[l % 3],
      alignment: D.AlignmentType.START,
      style: { paragraph: { indent: { left: 360 * (l + 1) + 360, hanging: 360 } } },
    });
  }
  return levels;
}

/**
 * ctx: { options, docDir, title, warn(msg), raster?(jobs) -> [{png,width,height}|null], fetchRemote?(url) -> {buffer,mime}|null,
 *        externalStyles?: string (Pro template), cover?: bool (Pro) }
 * returns Buffer
 */
async function buildDocx(model, ctx) {
  const o = ctx.options;
  const warn = ctx.warn || (() => {});
  const contentWidthMm = o.paper.width - o.margin.left - o.margin.right;
  const maxPx = Math.max(100, Math.round(contentWidthMm / 25.4 * 96));
  const maxHPx = Math.max(100, Math.round((o.paper.height - o.margin.top - o.margin.bottom) / 25.4 * 96 * 0.9));

  // ---- pass 1: things that need the browser (Mermaid, display math, SVG/WebP images) or a remote fetch -----------
  const jobs = []; const jobOf = new Map();
  const imgCache = new Map();
  const addJob = (key, job) => { if (!jobOf.has(key)) { jobOf.set(key, jobs.length); jobs.push(job); } };
  async function loadImage(src) {
    if (imgCache.has(src)) return imgCache.get(src);
    const info = images.resolveImage(src, ctx.docDir);
    let r = null;
    if (info.kind === 'local') {
      if (!info.exists) warn(`Image not found: ${info.path}`);
      else r = images.readLocal(info);
    } else if (info.kind === 'data') r = { buffer: info.buffer, mime: images.sniffMime(info.buffer.subarray(0, 64)) || info.mime };
    else if (info.kind === 'remote') {
      if (o.allowRemoteImages && ctx.fetchRemote) r = await ctx.fetchRemote(info.url);
      else warn(`Remote image not loaded (remote images are off): ${info.url}`);
    } else warn(`Image skipped: ${info.reason}`);
    imgCache.set(src, r);
    return r;
  }
  async function walk(blocks) {
    for (const b of blocks) {
      if (b.type === 'mermaid') addJob(`m:${b.text}`, { kind: 'mermaid', src: b.text });
      else if (b.type === 'math') addJob(`x:${b.tex}`, { kind: 'math', src: b.tex });
      if (b.inlines) for (const x of b.inlines) await inlineJob(x);
      if (b.type === 'table') for (const row of [b.head, ...b.rows]) for (const cell of row) for (const x of cell) await inlineJob(x);
      if (b.blocks) await walk(b.blocks);
      if (b.items) for (const it of b.items) await walk(it.blocks);
    }
  }
  async function inlineJob(x) {
    if (x.t !== 'img') return;
    const r = await loadImage(x.src);
    if (r && /svg|webp|avif|x-icon/.test(r.mime)) addJob(`i:${x.src}`, { kind: 'image', src: images.dataUri(r.buffer, r.mime) });
  }
  await walk(model);
  let rendered = [];
  if (jobs.length && ctx.raster) {
    try { rendered = await ctx.raster(jobs); } catch (e) { warn(`Diagrams and formulas stay as text: ${e.message}`); rendered = []; }
  }
  const rasterOf = (key) => (jobOf.has(key) ? rendered[jobOf.get(key)] || null : null);

  // ---- pass 2: build the document -----------------------------------------------------------------------------------
  const footnotes = {};
  const bookmarks = new Map(); let bmN = 0;
  const bm = (slug) => { if (!bookmarks.has(slug)) bookmarks.set(slug, bookmarkName(slug, ++bmN)); return bookmarks.get(slug); };
  const numbering = [{ reference: 'ul', levels: numberingLevels(false) }];
  const olRefs = new Set();
  let instance = 0;
  const olRef = (start) => {
    const ref = `ol-${start}`;
    if (!olRefs.has(ref)) {
      olRefs.add(ref);
      numbering.push({ reference: ref, levels: numberingLevels(true).map((l, k) => (k === 0 ? { ...l, start } : l)) });
    }
    return ref;
  };

  function scaled(w, h, wantW) {
    let width = wantW && wantW > 0 ? Math.min(wantW, maxPx) : w;
    let height = Math.round(h * (width / w));
    if (width > maxPx) { height = Math.round(height * (maxPx / width)); width = maxPx; }
    if (height > maxHPx) { width = Math.round(width * (maxHPx / height)); height = maxHPx; }
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, height) };
  }

  function imageRun(png, w, h, alt, wantW) {
    const size = scaled(w, h, wantW);
    return new D.ImageRun({ type: 'png', data: png, transformation: size, altText: { title: alt || 'image', description: alt || '', name: alt || 'image' } });
  }

  function imageRuns(x) {
    const r = imgCache.get(x.src);
    const alt = x.alt || '';
    if (r) {
      const typ = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' }[r.mime];
      if (typ) {
        const sz = images.imageSize(r.buffer);
        if (sz && sz.width > 0 && sz.height > 0) {
          return [new D.ImageRun({ type: typ, data: r.buffer, transformation: scaled(sz.width, sz.height, x.width), altText: { title: alt || 'image', description: alt, name: alt || 'image' } })];
        }
      }
      const ras = rasterOf(`i:${x.src}`);
      if (ras) {
        if (r.mime === 'image/svg+xml') {
          const size = scaled(ras.width, ras.height, x.width);
          return [new D.ImageRun({ type: 'svg', data: r.buffer, transformation: size, fallback: { type: 'png', data: ras.png }, altText: { title: alt || 'image', description: alt, name: alt || 'image' } })];
        }
        return [imageRun(ras.png, ras.width, ras.height, alt, x.width)];
      }
      warn(`Image kept as text (${r.mime || 'unknown type'} needs Chrome, Edge or Brave for Word): ${x.src.slice(0, 120)}`);
    }
    return [new D.TextRun({ text: `[${alt || 'image'}]`, color: '59636E', italics: true })];
  }

  function textRun(x, extra = {}) {
    const opts = {
      text: x.text,
      bold: !!x.b || extra.bold || undefined,
      italics: !!x.i || extra.italics || undefined,
      strike: !!x.s || undefined,
      underline: x.u ? {} : undefined,
      superScript: !!x.sup || undefined,
      subScript: !!x.sub || undefined,
      highlight: x.mark ? 'yellow' : undefined,
      rightToLeft: RTL_RE.test(x.text) || undefined,
      size: extra.size,
      color: extra.color,
    };
    if (x.code) { opts.font = CODE_FONT; opts.shading = { type: D.ShadingType.CLEAR, fill: 'EFF1F3', color: 'auto' }; opts.size = opts.size || Math.round(o.fontSize * 2 * 0.9); }
    if (extra.link) { opts.color = LINK_COLOR; opts.underline = {}; }
    return new D.TextRun(opts);
  }

  function runs(inl, extra = {}) {
    const out = [];
    let k = 0;
    while (k < inl.length) {
      const x = inl[k];
      if (x.t === 'text' && x.href) {
        const href = x.href; const group = [];
        while (k < inl.length && inl[k].t === 'text' && inl[k].href === href) { group.push(textRun(inl[k], { ...extra, link: true })); k++; }
        if (href.startsWith('#')) {
          const slug = decodeURIComponent(href.slice(1));
          out.push(new D.InternalHyperlink({ anchor: bm(slug), children: group }));
        } else if (/^(https?|mailto|ftp):/i.test(href)) out.push(new D.ExternalHyperlink({ link: href, children: group }));
        else out.push(...group);
        continue;
      }
      if (x.t === 'text') out.push(textRun(x, extra));
      else if (x.t === 'br') out.push(new D.TextRun({ text: '', break: 1 }));
      else if (x.t === 'img') out.push(...imageRuns(x));
      else if (x.t === 'math') out.push(new D.TextRun({ text: x.tex, font: 'Cambria Math', italics: true }));
      else if (x.t === 'fnref') out.push(new D.FootnoteReferenceRun(x.n));
      k++;
    }
    return out;
  }

  const children = [];
  const para = (opts) => new D.Paragraph(opts);
  const quoteBorder = { left: { style: D.BorderStyle.SINGLE, size: 18, color: 'D1D9E0', space: 8 } };

  function codeBlock(text, lang, ind) {
    const lines = codeLines(text, lang);
    const size = Math.round(o.fontSize * 2 * 0.85);
    return lines.map((line, n) => para({
      children: line.length ? line.map((r) => new D.TextRun({ text: r.text, font: CODE_FONT, size, color: r.color || '1F2328', italics: r.italic || undefined, bold: r.bold || undefined })) : [new D.TextRun({ text: '', font: CODE_FONT, size })],
      shading: { type: D.ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' },
      spacing: { before: n === 0 ? 60 : 0, after: n === lines.length - 1 ? 200 : 0, line: 260 },
      indent: ind ? { left: ind } : undefined,
      border: n === 0 ? { top: { style: D.BorderStyle.SINGLE, size: 4, color: 'E1E4E8', space: 4 } } : (n === lines.length - 1 ? { bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'E1E4E8', space: 4 } } : undefined),
      keepLines: lines.length < 20 || undefined,
    }));
  }

  function emit(blocks, st) {
    // st: { indent (twips), quote (bool), list (level or -1) }
    for (const b of blocks) {
      const ind = st.indent || 0;
      const base = { indent: ind ? { left: ind } : undefined, border: st.quote ? quoteBorder : undefined };
      switch (b.type) {
        case 'heading': {
          const text = plain(b.inlines);
          const lvl = Math.min(6, Math.max(1, b.level));
          children.push(para({
            heading: D.HeadingLevel[`HEADING_${lvl}`],
            bidirectional: firstStrongRtl(text) || undefined,
            children: [new D.Bookmark({ id: bm(b.slug || text), children: runs(b.inlines) })],
          }));
          break;
        }
        case 'para': {
          const text = plain(b.inlines);
          children.push(para({ ...base, bidirectional: firstStrongRtl(text) || undefined, children: runs(b.inlines), spacing: { after: st.tight ? 60 : 160 } }));
          break;
        }
        case 'list': listBlock(b, st); break;
        case 'quote': emit(b.blocks, { ...st, indent: ind + 240, quote: true }); break;
        case 'code': children.push(...codeBlock(b.text, b.lang, ind)); break;
        case 'mermaid': {
          const r = rasterOf(`m:${b.text}`);
          if (r) children.push(para({ ...base, alignment: D.AlignmentType.CENTER, children: [imageRun(r.png, r.width, r.height, 'Mermaid diagram')] }));
          else {
            children.push(para({ ...base, children: [new D.TextRun({ text: 'Mermaid diagram, shown as code (install Chrome, Edge or Brave to export it as a drawing):', italics: true, color: '6F4B00', size: 18 })] }));
            children.push(...codeBlock(b.text, '', ind));
          }
          break;
        }
        case 'math': {
          const r = rasterOf(`x:${b.tex}`);
          if (r) children.push(para({ ...base, alignment: D.AlignmentType.CENTER, children: [imageRun(r.png, r.width, r.height, b.tex.slice(0, 200))] }));
          else children.push(para({ ...base, alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: b.tex.trim(), font: 'Cambria Math', italics: true })] }));
          break;
        }
        case 'table': tableBlock(b, ind); break;
        case 'hr': children.push(para({ ...base, border: { bottom: { style: D.BorderStyle.SINGLE, size: 12, color: 'D1D9E0', space: 1 } }, children: [] })); break;
        case 'pagebreak': children.push(para({ children: [new D.PageBreak()] })); break;
        case 'footnotes':
          for (const it of b.items) {
            const ps = [];
            for (const fb of it.blocks) {
              if (fb.inlines) ps.push(new D.Paragraph({ children: runs(fb.inlines.filter((x) => x.t !== 'fnref'), { size: 18 }) }));
              else if (fb.type === 'code') ps.push(...codeBlock(fb.text, fb.lang, 0));
            }
            footnotes[it.n] = { children: ps.length ? ps : [new D.Paragraph('')] };
          }
          break;
        default: break;
      }
    }
  }

  function listBlock(b, st) {
    const level = Math.min(MAX_LEVEL, (st.list ?? -1) + 1);
    const deep = (st.list ?? -1) + 1 > MAX_LEVEL;
    const ref = b.ordered ? olRef(b.start) : 'ul';
    const inst = ++instance;
    const tight = b.items.every((it) => it.blocks.filter((x) => x.type === 'para').length <= 1);
    for (const it of b.items) {
      let first = true;
      for (const blk of it.blocks) {
        if (first && blk.type === 'para') {
          const prefix = it.task === null ? [] : [new D.TextRun({ text: it.task ? '☒ ' : '☐ ', font: 'Segoe UI Symbol' })];
          const text = plain(blk.inlines);
          const opts = {
            children: [...prefix, ...(deep ? [new D.TextRun({ text: '• ' })] : []), ...runs(blk.inlines)],
            spacing: { after: tight ? 40 : 120 },
            bidirectional: firstStrongRtl(text) || undefined,
            border: st.quote ? quoteBorder : undefined,
          };
          if (it.task === null && !deep) opts.numbering = { reference: ref, level, instance: inst };
          else opts.indent = { left: 360 * (level + 1) + 360 + (st.indent || 0) };
          children.push(para(opts));
        } else {
          emit([blk], { ...st, list: level, indent: blk.type === 'list' ? (st.indent || 0) : 360 * (level + 1) + 360 + (st.indent || 0), tight });
        }
        first = false;
      }
      if (!it.blocks.length) children.push(para({ numbering: it.task === null && !deep ? { reference: ref, level, instance: inst } : undefined, children: [] }));
    }
  }

  function tableBlock(b, ind) {
    const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length), 1);
    const align = (k) => ({ left: D.AlignmentType.LEFT, right: D.AlignmentType.RIGHT, center: D.AlignmentType.CENTER }[b.aligns[k]] || undefined);
    const border = { style: D.BorderStyle.SINGLE, size: 4, color: 'D1D9E0' };
    const borders = { top: border, bottom: border, left: border, right: border };
    const mkRow = (cells, header, n) => new D.TableRow({
      tableHeader: header || undefined,
      cantSplit: true,
      children: Array.from({ length: cols }, (_, k) => new D.TableCell({
        borders,
        shading: header ? { type: D.ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' } : (n % 2 ? { type: D.ShadingType.CLEAR, fill: 'FBFCFD', color: 'auto' } : undefined),
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new D.Paragraph({ alignment: align(k), bidirectional: firstStrongRtl(plain(cells[k] || [])) || undefined, children: runs(cells[k] || [], header ? { bold: true } : {}) })],
      })),
    });
    const rows = [];
    if (b.head.length) rows.push(mkRow(b.head, true, 0));
    b.rows.forEach((r, n) => rows.push(mkRow(r, false, n)));
    if (!rows.length) return;
    children.push(new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE }, indent: ind ? { size: ind, type: D.WidthType.DXA } : undefined }));
    children.push(para({ children: [], spacing: { after: 120 } }));
  }

  // cover (Pro) and table of contents
  const front = [];
  if (ctx.cover) {
    front.push(para({ spacing: { before: 3600 }, children: [] }));
    front.push(para({ heading: D.HeadingLevel.TITLE, alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: o.coverTitle || ctx.title || 'Document' })] }));
    if (o.coverSubtitle) front.push(para({ alignment: D.AlignmentType.CENTER, spacing: { after: 400 }, children: [new D.TextRun({ text: o.coverSubtitle, size: 32, color: '59636E' })] }));
    if (o.coverAuthor) front.push(para({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: o.coverAuthor, size: 26 })] }));
    if (o.coverDate) front.push(para({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: o.coverDate, size: 24, color: '59636E' })] }));
    front.push(para({ children: [new D.PageBreak()] }));
  } else if (o.title) {
    const firstHeading = model.find((b) => b.type === 'heading');
    if (!firstHeading || plain(firstHeading.inlines).trim() !== o.title.trim()) front.push(para({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun({ text: o.title })] }));
  }
  if (o.toc) {
    const hs = model.filter((b) => b.type === 'heading' && b.level <= 3);
    if (hs.length) {
      const min = Math.min(...hs.map((h) => h.level));
      front.push(para({ children: [new D.TextRun({ text: 'Contents', bold: true, size: 32 })], spacing: { after: 200 } }));
      for (const h of hs) {
        front.push(para({ indent: { left: 360 * (h.level - min) }, spacing: { after: 60 }, children: [new D.InternalHyperlink({ anchor: bm(h.slug || plain(h.inlines)), children: [new D.TextRun({ text: plain(h.inlines), color: LINK_COLOR })] })] }));
      }
      front.push(para({ children: [new D.PageBreak()] }));
    }
  }

  emit(model, { indent: 0, quote: false, list: -1 });
  if (!children.length) children.push(para({ children: [] }));

  const today = new Date().toISOString().slice(0, 10);
  const tplRuns = (tpl) => templateParts(tpl).map((p) => {
    if (p.text != null) return new D.TextRun({ text: p.text, size: 16, color: '59636E' });
    if (p.field === 'page') return new D.TextRun({ children: [D.PageNumber.CURRENT], size: 16, color: '59636E' });
    if (p.field === 'pages') return new D.TextRun({ children: [D.PageNumber.TOTAL_PAGES], size: 16, color: '59636E' });
    return new D.TextRun({ text: p.field === 'title' ? (ctx.title || '') : (o.date || today), size: 16, color: '59636E' });
  });
  const headers = o.header ? { default: new D.Header({ children: [para({ alignment: D.AlignmentType.CENTER, children: tplRuns(o.header) })] }) } : undefined;
  const footers = o.footer ? { default: new D.Footer({ children: [para({ alignment: D.AlignmentType.CENTER, children: tplRuns(o.footer) })] }) } : undefined;
  const portrait = { width: Math.min(o.paper.width, o.paper.height), height: Math.max(o.paper.width, o.paper.height) };

  const docOpts = {
    creator: o.author || '',
    lastModifiedBy: o.author || '',
    title: ctx.title || '',
    description: '',
    externalStyles: ctx.externalStyles || undefined,
    styles: ctx.externalStyles ? undefined : {
      default: {
        document: { run: { font: 'Calibri', size: Math.round(o.fontSize * 2) }, paragraph: { spacing: { after: 160, line: 276 } } },
        heading1: { run: { size: Math.round(o.fontSize * 2 * 2), bold: true, color: '1F2328' }, paragraph: { spacing: { before: 360, after: 160 }, keepNext: true } },
        heading2: { run: { size: Math.round(o.fontSize * 2 * 1.5), bold: true, color: '1F2328' }, paragraph: { spacing: { before: 320, after: 120 }, keepNext: true } },
        heading3: { run: { size: Math.round(o.fontSize * 2 * 1.25), bold: true, color: '1F2328' }, paragraph: { spacing: { before: 280, after: 100 }, keepNext: true } },
        heading4: { run: { size: Math.round(o.fontSize * 2), bold: true, color: '1F2328' }, paragraph: { spacing: { before: 240, after: 80 }, keepNext: true } },
        heading5: { run: { size: Math.round(o.fontSize * 2 * 0.9), bold: true, color: '1F2328' }, paragraph: { keepNext: true } },
        heading6: { run: { size: Math.round(o.fontSize * 2 * 0.85), bold: true, color: '59636E' }, paragraph: { keepNext: true } },
        title: { run: { size: 56, bold: true, color: '1F2328' }, paragraph: { spacing: { after: 300 } } },
        hyperlink: { run: { color: LINK_COLOR, underline: { type: D.UnderlineType.SINGLE } } },
      },
    },
    numbering: { config: numbering },
    footnotes,
    features: { updateFields: false },
    sections: [{
      properties: {
        page: {
          size: { width: twip(portrait.width), height: twip(portrait.height), orientation: o.landscape ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT },
          margin: { top: twip(o.margin.top), right: twip(o.margin.right), bottom: twip(o.margin.bottom), left: twip(o.margin.left), header: twip(Math.min(12, o.margin.top / 2)), footer: twip(Math.min(12, o.margin.bottom / 2)) },
        },
        titlePage: ctx.cover || undefined,
      },
      headers: ctx.cover && headers ? { ...headers, first: new D.Header({ children: [para({ children: [] })] }) } : headers,
      footers: ctx.cover && footers ? { ...footers, first: new D.Footer({ children: [para({ children: [] })] }) } : footers,
      children: [...front, ...children],
    }],
  };
  if (o.lang) docOpts.styles && (docOpts.styles.default.document.run.language = { value: o.lang });
  const doc = new D.Document(docOpts);
  return D.Packer.toBuffer(doc);
}

/** word/styles.xml from a reference .docx (Pro: custom template). */
async function stylesFromTemplate(buffer) {
  const { unzipSync, strFromU8 } = require('fflate');
  let files;
  try { files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name === 'word/styles.xml' }); } catch (e) { throw new Error('The template is not a .docx or .dotx file.'); }
  const f = files['word/styles.xml'];
  if (!f) throw new Error('The template has no word/styles.xml. Pick a .docx or .dotx file saved by Word or LibreOffice.');
  return strFromU8(f);
}

module.exports = { buildDocx, stylesFromTemplate, bookmarkName };
