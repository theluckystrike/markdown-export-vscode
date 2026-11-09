'use strict';
// markdown-it tokens -> a small block tree used by the DOCX writer and the built-in PDF engine.
//
// Blocks: heading {level, inlines, slug} | para {inlines} | list {ordered, start, items:[{task, blocks}]}
//         code {lang, text} | mermaid {text} | math {tex} | quote {blocks} | table {aligns, head, rows} | hr
//         pagebreak | footnotes {items:[{n, blocks}]}
// Inlines: {t:'text', text, b, i, s, code, sup, sub, u, mark, href} | {t:'br'} | {t:'img', src, alt, title, href}
//          {t:'math', tex, display} | {t:'fnref', n}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch (x) { return m; } }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text of raw HTML without tags, scripts or styles. */
function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|summary|details|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

const INLINE_TAGS = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', ins: 'u', s: 's', del: 's', strike: 's', sup: 'sup', sub: 'sub', mark: 'mark', code: 'code', kbd: 'code', tt: 'code' };

function inlines(children, fnMap) {
  const out = [];
  const marks = { b: 0, i: 0, s: 0, code: 0, sup: 0, sub: 0, u: 0, mark: 0 };
  const links = [];
  const cur = () => {
    const o = {};
    for (const k of Object.keys(marks)) if (marks[k] > 0) o[k] = true;
    if (links.length && links[links.length - 1]) o.href = links[links.length - 1];
    return o;
  };
  const text = (s) => { if (s) out.push({ t: 'text', text: s, ...cur() }); };
  for (const c of children || []) {
    switch (c.type) {
      case 'text': case 'text_special': text(c.content); break;
      case 'softbreak': text(' '); break;
      case 'hardbreak': out.push({ t: 'br' }); break;
      case 'code_inline': marks.code++; text(c.content); marks.code--; break;
      case 'strong_open': marks.b++; break; case 'strong_close': marks.b--; break;
      case 'em_open': marks.i++; break; case 'em_close': marks.i--; break;
      case 's_open': marks.s++; break; case 's_close': marks.s--; break;
      case 'link_open': links.push(c.attrGet('href') || ''); break;
      case 'link_close': links.pop(); break;
      case 'image': out.push({ t: 'img', src: c.attrGet('src') || '', alt: (c.children || []).map((x) => x.content).join('') || c.content || '', title: c.attrGet('title') || '', href: links.length ? links[links.length - 1] : '' }); break;
      case 'math_inline': out.push({ t: 'math', tex: c.content, display: !!(c.meta && c.meta.display) }); break;
      case 'footnote_ref': out.push({ t: 'fnref', n: (fnMap ? fnMap(c.meta.id) : c.meta.id + 1) }); break;
      case 'html_inline': {
        const tag = c.content;
        if (/^<br\s*\/?>$/i.test(tag)) { out.push({ t: 'br' }); break; }
        const m = /^<(\/)?([a-z][a-z0-9]*)/i.exec(tag);
        if (!m) break;
        const name = m[2].toLowerCase();
        if (name === 'img' && !m[1]) { out.push({ t: 'img', src: attr(tag, 'src'), alt: attr(tag, 'alt'), title: attr(tag, 'title'), width: Number(attr(tag, 'width')) || 0, href: links.length ? links[links.length - 1] : '' }); break; }
        if (name === 'a') { if (m[1]) links.pop(); else links.push(attr(tag, 'href')); break; }
        const mk = INLINE_TAGS[name];
        if (mk) marks[mk] = Math.max(0, marks[mk] + (m[1] ? -1 : (/\/>$/.test(tag) ? 0 : 1)));
        break;
      }
      default:
        if (c.content && !/_open$|_close$/.test(c.type)) text(c.content);
    }
  }
  return out;
}

function toModel(tokens) {
  let i = 0;
  const fnNumbers = new Map();
  const fnMap = (id) => { if (!fnNumbers.has(id)) fnNumbers.set(id, fnNumbers.size + 1); return fnNumbers.get(id); };

  function blocksUntil(closeType) {
    const out = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (closeType && t.type === closeType) { i++; return out; }
      const b = block();
      if (b) out.push(b);
    }
    return out;
  }

  function block() {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const inl = tokens[i + 1]; i += 3;
        return { type: 'heading', level: Number(t.tag.slice(1)), inlines: inlines(inl.children, fnMap), slug: (t.meta && t.meta.slug) || '' };
      }
      case 'paragraph_open': {
        const inl = tokens[i + 1]; i += 3;
        return { type: 'para', inlines: inlines(inl.children, fnMap) };
      }
      case 'bullet_list_open': case 'ordered_list_open': {
        const ordered = t.type === 'ordered_list_open';
        const start = ordered ? Number(t.attrGet('start') || 1) : 1;
        const close = ordered ? 'ordered_list_close' : 'bullet_list_close';
        i++;
        const items = [];
        while (i < tokens.length && tokens[i].type !== close) {
          if (tokens[i].type === 'list_item_open') {
            const task = tokens[i].meta && typeof tokens[i].meta.task === 'boolean' ? tokens[i].meta.task : null;
            i++;
            items.push({ task, blocks: blocksUntil('list_item_close') });
          } else i++;
        }
        i++;
        return { type: 'list', ordered, start: Number.isFinite(start) ? start : 1, items };
      }
      case 'blockquote_open': i++; return { type: 'quote', blocks: blocksUntil('blockquote_close') };
      case 'fence': {
        i++;
        const lang = String(t.info || '').trim().split(/\s+/)[0].toLowerCase();
        if (lang === 'mermaid') return { type: 'mermaid', text: t.content };
        if (lang === 'math') return { type: 'math', tex: t.content };
        return { type: 'code', lang, text: t.content.replace(/\n$/, '') };
      }
      case 'code_block': i++; return { type: 'code', lang: '', text: t.content.replace(/\n$/, '') };
      case 'math_block': i++; return { type: 'math', tex: t.content };
      case 'hr': i++; return { type: 'hr' };
      case 'pagebreak': i++; while (tokens[i] && tokens[i].type === 'pagebreak_skip') i++; return { type: 'pagebreak' };
      case 'pagebreak_skip': i++; return null;
      case 'html_block': {
        i++;
        const imgs = [...t.content.matchAll(/<img\b[^>]*>/gi)].map((m) => ({ t: 'img', src: attr(m[0], 'src'), alt: attr(m[0], 'alt'), title: attr(m[0], 'title'), width: Number(attr(m[0], 'width')) || 0 }));
        const txt = htmlToText(t.content);
        if (!txt && !imgs.length) return null;
        const inl = [];
        if (txt) inl.push({ t: 'text', text: txt });
        if (imgs.length) { if (inl.length) inl.push({ t: 'br' }); for (const im of imgs) inl.push(im, { t: 'text', text: ' ' }); }
        return { type: 'para', inlines: inl, html: true };
      }
      case 'table_open': {
        i++;
        const head = []; const rows = []; const aligns = [];
        let inHead = false; let row = null;
        while (i < tokens.length && tokens[i].type !== 'table_close') {
          const x = tokens[i];
          if (x.type === 'thead_open') inHead = true;
          else if (x.type === 'thead_close') inHead = false;
          else if (x.type === 'tr_open') row = [];
          else if (x.type === 'tr_close') { (inHead ? head : rows).push(row); row = null; }
          else if (x.type === 'th_open' || x.type === 'td_open') {
            const st = x.attrGet('style') || '';
            const al = /text-align:\s*(left|right|center)/.exec(st);
            if (inHead) aligns.push(al ? al[1] : '');
            const inl = tokens[i + 1];
            row.push(inl && inl.type === 'inline' ? inlines(inl.children, fnMap) : []);
          }
          i++;
        }
        i++;
        return { type: 'table', aligns, head: head[0] || [], rows };
      }
      case 'footnote_block_open': {
        i++;
        const items = [];
        while (i < tokens.length && tokens[i].type !== 'footnote_block_close') {
          if (tokens[i].type === 'footnote_open') {
            const id = tokens[i].meta.id; i++;
            const blocks = blocksUntil('footnote_close');
            items.push({ n: fnMap(id), blocks });
          } else i++;
        }
        i++;
        items.sort((a, b) => a.n - b.n);
        return { type: 'footnotes', items };
      }
      case 'footnote_anchor': i++; return null;
      default: i++; return null;
    }
  }
  return blocksUntil(null);
}

/** Plain text of inlines (for TOC entries, alt text, bookmarks). */
function plain(inl) { return (inl || []).map((x) => (x.t === 'text' ? x.text : x.t === 'math' ? x.tex : x.t === 'img' ? x.alt : x.t === 'br' ? ' ' : '')).join(''); }

module.exports = { toModel, inlines, plain, htmlToText, decodeEntities };
