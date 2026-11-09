'use strict';
// Export options: settings first, then front matter on top. Every value is checked, so a bad value falls back
// to the default instead of breaking an export.

const PAGE_SIZES = {
  A3: [297, 420], A4: [210, 297], A5: [148, 210], B5: [176, 250],
  Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8],
};

const DEFAULTS = {
  pageSize: 'A4',
  landscape: false,
  margin: '20mm',
  header: '',
  footer: '{page} / {pages}',
  pageNumbers: true,
  toc: false,
  title: '',
  author: '',
  date: '',
  lang: '',
  dir: '',
  breaks: false,
  allowRemoteImages: false,
  htmlTheme: 'auto',
  mermaidTheme: 'default',
  fontSize: 11,
  cover: false,
  coverSubtitle: '',
  docxTemplate: '',
};

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 };

/** "20mm", "1in", 15 (mm) -> millimetres, or null when the value is not a length. */
function toMm(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mm|cm|in|pt|px)?\s*$/i.exec(String(v == null ? '' : v));
  if (!m) return null;
  return Number(m[1]) * UNIT_MM[(m[2] || 'mm').toLowerCase()];
}

/** margin: "20mm" | "10mm 15mm" | "10mm 15mm 10mm 15mm" | {top,right,bottom,left} -> {top,right,bottom,left} in mm */
function parseMargin(v, fallback) {
  const fb = fallback || { top: 20, right: 20, bottom: 20, left: 20 };
  const clamp = (n) => Math.max(0, Math.min(100, n));
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = {};
    for (const k of ['top', 'right', 'bottom', 'left']) { const n = toMm(v[k]); o[k] = clamp(n == null ? fb[k] : n); }
    return o;
  }
  const parts = String(v == null ? '' : v).trim().split(/\s+/).filter(Boolean).map(toMm);
  if (!parts.length || parts.some((n) => n == null)) return { ...fb };
  const [a, b = a, c = a, d = b] = parts;
  return { top: clamp(a), right: clamp(b), bottom: clamp(c), left: clamp(d) };
}

function pageSizeOf(name) {
  const key = Object.keys(PAGE_SIZES).find((k) => k.toLowerCase() === String(name || '').toLowerCase());
  return key || null;
}

const str = (v, max = 500) => (v == null ? '' : (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? String(v).slice(0, max) : '');
const bool = (v, d) => (typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : d)));

/**
 * settings: values from the markdownExport.* configuration (already plain values).
 * fm: front matter object. Keys may also sit under "export" or "markdown-export".
 */
function resolveOptions(settings, fm) {
  const s = settings || {};
  const f0 = fm && typeof fm === 'object' ? fm : {};
  const nested = [f0.export, f0['markdown-export'], f0.pdf].filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  const f = Object.assign({}, f0, ...nested);
  const pick = (k) => (f[k] !== undefined ? f[k] : s[k]);
  const o = {};
  o.pageSize = pageSizeOf(pick('pageSize') || pick('format') || pick('paper')) || pageSizeOf(s.pageSize) || DEFAULTS.pageSize;
  o.landscape = bool(pick('landscape'), DEFAULTS.landscape) || String(f.orientation || '').toLowerCase() === 'landscape';
  o.margin = parseMargin(pick('margin') !== undefined ? pick('margin') : DEFAULTS.margin, parseMargin(s.margin || DEFAULTS.margin));
  o.pageNumbers = bool(pick('pageNumbers'), DEFAULTS.pageNumbers);
  o.header = str(pick('header') !== undefined ? pick('header') : DEFAULTS.header);
  const footer = pick('footer');
  o.footer = footer !== undefined ? str(footer) : (o.pageNumbers ? DEFAULTS.footer : '');
  if (!o.pageNumbers) o.footer = o.footer.replace(/\{pages?\}/g, '').replace(/^[\s/|-]+|[\s/|-]+$/g, '');
  o.toc = bool(pick('toc'), DEFAULTS.toc);
  o.title = str(f.title);
  o.author = str(f.author);
  o.date = str(f.date);
  o.lang = str(f.lang || f.language, 20).replace(/[^A-Za-z0-9-]/g, '');
  o.dir = /^rtl$/i.test(str(f.dir)) ? 'rtl' : (/^ltr$/i.test(str(f.dir)) ? 'ltr' : '');
  o.breaks = bool(pick('breaks'), DEFAULTS.breaks);
  o.allowRemoteImages = bool(s.allowRemoteImages, DEFAULTS.allowRemoteImages); // a setting only: a file cannot turn on network use
  o.htmlTheme = ['auto', 'light', 'dark'].includes(pick('htmlTheme')) ? pick('htmlTheme') : DEFAULTS.htmlTheme;
  o.mermaidTheme = ['default', 'neutral', 'forest', 'dark', 'base'].includes(pick('mermaidTheme')) ? pick('mermaidTheme') : DEFAULTS.mermaidTheme;
  const fs = Number(pick('fontSize'));
  o.fontSize = Number.isFinite(fs) && fs >= 6 && fs <= 30 ? fs : DEFAULTS.fontSize;
  const cover = f.cover !== undefined ? f.cover : s.coverPage;
  o.cover = !!(cover && (cover === true || typeof cover === 'object' || cover === 'true'));
  const co = cover && typeof cover === 'object' && !Array.isArray(cover) ? cover : {};
  o.coverTitle = str(co.title) || o.title;
  o.coverSubtitle = str(co.subtitle || f.subtitle);
  o.coverAuthor = str(co.author) || o.author;
  o.coverDate = str(co.date) || o.date;
  o.docxTemplate = str(f.docxTemplate !== undefined ? f.docxTemplate : s.docxTemplate, 2000);
  const [w, h] = PAGE_SIZES[o.pageSize];
  o.paper = o.landscape ? { width: h, height: w } : { width: w, height: h };
  o.warnings = [];
  return o;
}

/** "{page} / {pages} {title} {date}" -> parts for the renderers. Unknown braces stay as text. */
function templateParts(tpl) {
  const out = [];
  const re = /\{(page|pages|title|date)\}/g;
  let last = 0; let m;
  const t = String(tpl || '');
  while ((m = re.exec(t))) {
    if (m.index > last) out.push({ text: t.slice(last, m.index) });
    out.push({ field: m[1] });
    last = re.lastIndex;
  }
  if (last < t.length) out.push({ text: t.slice(last) });
  return out;
}

module.exports = { resolveOptions, parseMargin, toMm, templateParts, PAGE_SIZES, DEFAULTS };
