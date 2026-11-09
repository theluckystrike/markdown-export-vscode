'use strict';
// Markdown parsing shared by every output: markdown-it (CommonMark + GFM tables and strikethrough), footnotes,
// task lists, $math$ and $$math$$, heading ids, page breaks and a sanitizer for raw HTML.
const MarkdownIt = require('markdown-it');
const footnote = require('markdown-it-footnote');
const hljs = require('highlight.js/lib/common');
const katex = require('katex');

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- slugs (GitHub style) -------------------------------------------------------------------------------------
function slugify(text) {
  return String(text).trim().toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-') || 'section';
}

// ---- math ----------------------------------------------------------------------------------------------------
function mathPlugin(md) {
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src; const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
    if (src.charCodeAt(pos + 1) === 0x24) { // $$...$$ inline
      const end = src.indexOf('$$', pos + 2);
      if (end < 0 || end === pos + 2) return false;
      if (!silent) { const t = state.push('math_inline', 'math', 0); t.content = src.slice(pos + 2, end); t.markup = '$$'; t.meta = { display: true }; }
      state.pos = end + 2; return true;
    }
    const next = src.charCodeAt(pos + 1);
    if (!next || next === 0x20 || next === 0x09 || next === 0x0a) return false;
    let end = pos + 1;
    while ((end = src.indexOf('$', end)) !== -1) {
      if (src.charCodeAt(end - 1) === 0x5c /* \ */) { end++; continue; }
      break;
    }
    if (end === -1 || end === pos + 1) return false;
    const before = src.charCodeAt(end - 1);
    if (before === 0x20 || before === 0x09) return false;
    const after = src.charCodeAt(end + 1);
    if (after >= 0x30 && after <= 0x39) return false; // "$5 and $6" is money, not math
    if (!silent) { const t = state.push('math_inline', 'math', 0); t.content = src.slice(pos + 1, end); t.markup = '$'; }
    state.pos = end + 1; return true;
  });
  md.block.ruler.after('blockquote', 'math_block', (state, start, end, silent) => {
    let pos = state.bMarks[start] + state.tShift[start]; let max = state.eMarks[start];
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    if (state.src.slice(pos, pos + 2) !== '$$') return false;
    pos += 2;
    let first = state.src.slice(pos, max);
    let last = '';
    let found = false; let line = start;
    if (first.trim().endsWith('$$')) { first = first.trim().slice(0, -2); found = true; }
    if (silent) return true;
    while (!found) {
      line++;
      if (line >= end) break;
      pos = state.bMarks[line] + state.tShift[line]; max = state.eMarks[line];
      if (pos < max && state.sCount[line] < state.blkIndent) break;
      const l = state.src.slice(pos, max);
      if (l.trim().endsWith('$$')) { last = l.trim().slice(0, -2); found = true; }
    }
    if (!found) return false;
    state.line = line + 1;
    const t = state.push('math_block', 'math', 0);
    t.block = true;
    t.content = (first && first.trim() ? first + '\n' : '') + state.getLines(start + 1, line, state.tShift[start], true) + (last && last.trim() ? last : '');
    t.map = [start, state.line]; t.markup = '$$';
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}

function renderTex(tex, display) {
  try {
    return katex.renderToString(tex, { displayMode: !!display, throwOnError: false, output: 'htmlAndMathml', trust: false, strict: 'ignore', maxSize: 50, maxExpand: 1000 });
  } catch (e) {
    return `<code class="math-error">${escapeHtml(tex)}</code>`;
  }
}

// ---- task lists, heading ids, page breaks ---------------------------------------------------------------------
function structurePlugin(md) {
  md.core.ruler.push('zovo_structure', (state) => {
    const used = new Map();
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'heading_open') {
        const inline = toks[i + 1];
        const text = inline && inline.children ? inline.children.filter((c) => c.type === 'text' || c.type === 'code_inline' || c.type === 'math_inline').map((c) => c.content).join('') : '';
        let slug = slugify(text);
        const n = used.get(slug) || 0;
        used.set(slug, n + 1);
        if (n) slug = `${slug}-${n}`;
        t.attrSet('id', slug);
        t.meta = Object.assign(t.meta || {}, { slug, text });
      } else if (t.type === 'list_item_open') {
        // "[ ] " or "[x] " at the start of the item's first paragraph
        const inline = toks[i + 2];
        if (toks[i + 1] && toks[i + 1].type === 'paragraph_open' && inline && inline.type === 'inline' && inline.children && inline.children.length) {
          const first = inline.children[0];
          const m = first.type === 'text' ? /^\[([ xX])\][  ]/.exec(first.content) : null;
          if (m) {
            first.content = first.content.slice(m[0].length);
            inline.content = inline.content.replace(/^\[[ xX]\][  ]/, '');
            t.meta = Object.assign(t.meta || {}, { task: m[1] !== ' ' });
            t.attrJoin('class', 'task-list-item');
            for (let j = i - 1; j >= 0; j--) { // mark the parent list
              if (toks[j].level === t.level - 1 && (toks[j].type === 'bullet_list_open' || toks[j].type === 'ordered_list_open')) { toks[j].attrJoin('class', 'contains-task-list'); break; }
            }
          }
        }
      } else if (t.type === 'html_block' && /^\s*<!--\s*(page-?break|new-?page)\s*-->\s*$/i.test(t.content)) {
        t.type = 'pagebreak';
      } else if (t.type === 'paragraph_open' && toks[i + 1] && toks[i + 1].type === 'inline' && /^\s*\\(newpage|pagebreak)\s*$/.test(toks[i + 1].content) && toks[i + 2] && toks[i + 2].type === 'paragraph_close') {
        t.type = 'pagebreak'; toks[i + 1].type = 'pagebreak_skip'; toks[i + 1].children = []; toks[i + 2].type = 'pagebreak_skip';
      }
    }
  });
}

// ---- sanitizer for raw HTML in the Markdown ---------------------------------------------------------------------
// The exports never run scripts from the document: a CSP blocks them in every page we render, and this removes
// the obvious carriers first so the HTML export is safe to open too.
// &#106; &#x6A; &colon; &Tab; ... inside an attribute value, so 'java&#115;cript:' is seen as 'javascript:'
function decodeEntities(v) {
  return String(v).replace(/&#x([0-9a-f]+);?/gi, (m, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (m, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&(colon|tab|newline|sol|lpar|rpar|period);?/gi, (m, n) => ({ colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')', period: '.' })[n.toLowerCase()]);
}
const DROP_ELEMENTS = 'script|iframe|frame|frameset|object|embed|applet|base|meta|link|form|noscript|template|portal';
function sanitizeHtml(html, opts = {}) {
  let s = String(html);
  s = s.replace(new RegExp(`<(${DROP_ELEMENTS})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');
  s = s.replace(new RegExp(`<\\/?(${DROP_ELEMENTS})\\b[^>]*>`, 'gi'), '');
  s = s.replace(/<style\b[\s\S]*?<\/style\s*>/gi, (m) => (opts.keepStyle ? m.replace(/@import[^;]*;?/gi, '').replace(/url\s*\([^)]*\)/gi, 'none') : ''));
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s(href|src|xlink:href|action|formaction|srcset|poster|background)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (m, attr, _q, a, b, c) => {
    const v = decodeEntities(a ?? b ?? c ?? '').replace(/[\u0000- ]/g, '').toLowerCase();
    if (/^(javascript|vbscript|livescript):/.test(v) || /^data:(?!image\/(png|jpe?g|gif|webp|svg\+xml|bmp))/.test(v)) return ` ${attr}="#"`;
    return m;
  });
  if (opts.blockRemote) {
    s = s.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const url = src ? (src[2] ?? src[3] ?? src[4] ?? '') : '';
      if (!/^(https?:)?\/\//i.test(decodeEntities(url).trim())) return tag.replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m) => (/(https?:)?\/\//i.test(decodeEntities(m)) ? '' : m));
      const alt = /\salt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
      const label = alt ? (alt[2] ?? alt[3]) : '';
      if (opts.onRemote) opts.onRemote(url);
      return `<span class="img-blocked" title="Remote image not loaded: ${escapeHtml(url)}">${escapeHtml(label || 'image')}</span>`;
    });
    s = s.replace(/<(source|video|audio|track)\b[^>]*>/gi, (tag) => (/\ssrcs?e?t?\s*=\s*["']?\s*(https?:)?\/\//i.test(tag) ? '' : tag));
  }
  return s;
}

// ---- highlight.js -------------------------------------------------------------------------------------------------
const MAX_HIGHLIGHT = 200 * 1024; // longer code blocks stay plain: highlighting them costs seconds and adds nothing
function highlight(code, lang) {
  const l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (code.length <= MAX_HIGHLIGHT && l && hljs.getLanguage(l)) {
    try { return { html: hljs.highlight(code, { language: l, ignoreIllegals: true }).value, lang: l }; } catch (e) { /* plain */ }
  }
  return { html: escapeHtml(code), lang: l };
}

// ---- parser -----------------------------------------------------------------------------------------------------
function createParser(opts = {}) {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: !!opts.breaks, maxNesting: 1000 });
  md.enable(['table', 'strikethrough']);
  md.use(footnote);
  md.use(mathPlugin);
  md.use(structurePlugin);
  md.validateLink = (url) => !/^(javascript|vbscript|file|data):/i.test(url.trim()) || /^data:image\/(gif|png|jpeg|webp|svg\+xml|bmp);/i.test(url.trim());
  return md;
}

function parse(text, opts = {}) {
  const md = createParser(opts);
  const env = {};
  const src = String(text || '');
  const tokens = md.parse(src, env);
  // markdown-it stops at its nesting limit and drops the rest. Say so instead of losing text silently.
  let cutAt = 0;
  let deepest = null;
  for (const t of tokens) if (!deepest || t.level > deepest.level) deepest = t;
  if (deepest && deepest.level >= md.options.maxNesting - 2) cutAt = deepest.map ? deepest.map[0] + 1 : 1;
  return { md, tokens, env, cutAt };
}

/** Headings for a table of contents: [{level, text, slug}] */
function headings(tokens) {
  const out = [];
  for (const t of tokens) if (t.type === 'heading_open' && t.meta) out.push({ level: Number(t.tag.slice(1)), text: t.meta.text, slug: t.meta.slug });
  return out;
}

/**
 * Body HTML. opts.image(src, alt, title) -> {src} | {html} rewrites every image source (local path, data, remote).
 * opts.blockRemote: raw HTML <img> with a remote src becomes its alt text.
 */
function renderBody(parsed, opts = {}) {
  const { md, tokens, env } = parsed;
  const rules = md.renderer.rules;
  const warn = opts.warn || (() => {});
  rules.math_inline = (t, i) => renderTex(t[i].content, t[i].meta && t[i].meta.display);
  rules.math_block = (t, i) => `<div class="math-block">${renderTex(t[i].content, true)}</div>\n`;
  rules.pagebreak = () => '<div class="page-break"></div>\n';
  rules.pagebreak_skip = () => '';
  rules.fence = (t, i) => {
    const tok = t[i];
    const lang = String(tok.info || '').trim().split(/\s+/)[0].toLowerCase();
    if (lang === 'mermaid') return `<pre class="mermaid">${escapeHtml(tok.content)}</pre>\n`;
    if (lang === 'math' || lang === 'latex' && /^\s*\\begin\{/.test(tok.content)) return `<div class="math-block">${renderTex(tok.content, true)}</div>\n`;
    const h = highlight(tok.content, lang);
    return `<pre class="code"><code class="hljs${h.lang ? ` language-${escapeHtml(h.lang)}` : ''}">${h.html}</code></pre>\n`;
  };
  rules.code_block = (t, i) => `<pre class="code"><code class="hljs">${escapeHtml(t[i].content)}</code></pre>\n`;
  const blockRemote = !!opts.blockRemote;
  const onRemote = (url) => warn(`Remote image not loaded: ${url}`);
  rules.html_block = (t, i) => sanitizeHtml(t[i].content, { blockRemote, onRemote, keepStyle: true });
  rules.html_inline = (t, i) => sanitizeHtml(t[i].content, { blockRemote, onRemote });
  rules.image = (t, i, o, e, self) => {
    const tok = t[i];
    const src = tok.attrGet('src') || '';
    const alt = self.renderInlineAsText(tok.children || [], o, e);
    const title = tok.attrGet('title') || '';
    const r = opts.image ? opts.image(src, alt, title) : { src };
    if (r && r.html != null) return r.html;
    return `<img src="${escapeHtml(r.src)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
  };
  const defaultItem = rules.list_item_open || ((t, i, o, e, self) => self.renderToken(t, i, o));
  rules.list_item_open = (t, i, o, e, self) => {
    const tok = t[i];
    const base = defaultItem(t, i, o, e, self);
    if (tok.meta && typeof tok.meta.task === 'boolean') return `${base}<input type="checkbox" class="task-box" disabled${tok.meta.task ? ' checked' : ''}> `;
    return base;
  };
  return md.renderer.render(tokens, md.options, env);
}

module.exports = { parse, renderBody, headings, sanitizeHtml, highlight, renderTex, slugify, escapeHtml };
