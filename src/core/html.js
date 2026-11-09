'use strict';
// Builds a full HTML page from Markdown, for three uses:
//   print       the page the user's own Chrome, Edge or Brave prints to PDF (file:// images and assets)
//   standalone  the HTML export: one file, images and fonts inlined, no scripts
//   webview     the Export Preview panel in VS Code
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse, renderBody, headings, escapeHtml } = require('./markdown');
const { splitFrontMatter } = require('./frontmatter');
const images = require('./images');

let cssCache = null;
function readAsset(assetsDir, rel) { return fs.readFileSync(path.join(assetsDir, rel), 'utf8'); }

function baseCss(assetsDir) {
  if (!cssCache || cssCache.dir !== assetsDir) {
    cssCache = { dir: assetsDir, page: readAsset(assetsDir, 'page.css'), hljs: readAsset(assetsDir, 'hljs.css'), katex: readAsset(assetsDir, 'katex/katex.min.css'), fonts: null };
  }
  return cssCache;
}

/** KaTeX CSS with its font URLs pointed at file://, the webview, or inlined as data URIs. */
function katexCss(assetsDir, mode, webviewBase) {
  const c = baseCss(assetsDir);
  if (mode === 'standalone') {
    return c.katex.replace(/url\((['"]?)fonts\/([A-Za-z0-9_.-]+\.woff2)\1\)/g, (m, q, file) => {
      try { return `url(data:font/woff2;base64,${fs.readFileSync(path.join(assetsDir, 'katex', 'fonts', file)).toString('base64')})`; } catch (e) { return 'url()'; }
    });
  }
  const base = mode === 'webview' ? `${webviewBase}/katex/fonts/` : images.fileUrl(path.join(assetsDir, 'katex', 'fonts')) + '/';
  return c.katex.replace(/url\((['"]?)fonts\/([A-Za-z0-9_.-]+)\1\)/g, (m, q, file) => `url(${base}${file})`);
}

function tocHtml(list, title) {
  const items = list.filter((h) => h.level <= 3);
  if (!items.length) return '';
  const min = Math.min(...items.map((h) => h.level));
  return `<nav class="toc"><p class="toc-title">${escapeHtml(title || 'Contents')}</p>\n`
    + items.map((h) => `<div class="toc-l${h.level - min + 1}"><a href="#${escapeHtml(h.slug)}">${escapeHtml(h.text)}</a></div>`).join('\n')
    + '</nav>\n<div class="page-break"></div>\n';
}

function coverHtml(o) {
  return `<section class="cover"><div class="cover-inner"><h1 class="cover-title">${escapeHtml(o.coverTitle || o.docTitle)}</h1>`
    + (o.coverSubtitle ? `<p class="cover-subtitle">${escapeHtml(o.coverSubtitle)}</p>` : '')
    + (o.coverAuthor ? `<p class="cover-author">${escapeHtml(o.coverAuthor)}</p>` : '')
    + (o.coverDate ? `<p class="cover-date">${escapeHtml(o.coverDate)}</p>` : '')
    + '</div></section>\n<div class="page-break"></div>\n';
}

/**
 * Renders the Markdown body for one mode.
 * ctx: { mode, docDir, options, imageUrl?(info) for webview, warn(msg) }
 */
function renderMarkdown(body, ctx) {
  const o = ctx.options;
  const parsed = parse(body, { breaks: o.breaks });
  const blockRemote = !o.allowRemoteImages;
  const seenWarn = new Set();
  const warn = (m) => { if (!seenWarn.has(m)) { seenWarn.add(m); ctx.warn(m); } };
  const image = (src, alt) => {
    const info = images.resolveImage(src, ctx.docDir);
    const label = escapeHtml(alt || src);
    if (info.kind === 'remote') {
      if (blockRemote) { warn(`Remote image not loaded (remote images are off): ${info.url}`); return { html: `<span class="img-blocked" title="Remote image not loaded: ${escapeHtml(info.url)}">${label}</span>` }; }
      return { src: info.url };
    }
    if (info.kind === 'bad') { warn(`Image skipped: ${info.reason}`); return { html: `<span class="img-missing">${label}</span>` }; }
    if (info.kind === 'data') return { src: images.dataUri(info.buffer, info.mime) };
    if (!info.exists) { warn(`Image not found: ${info.path}`); return { html: `<span class="img-missing" title="Image not found: ${escapeHtml(info.path)}">${label}</span>` }; }
    if (ctx.mode === 'webview') return { src: ctx.imageUrl ? ctx.imageUrl(info) : images.fileUrl(info.path) };
    if (ctx.mode === 'standalone') {
      const r = images.readLocal(info);
      if (r && r.mime) return { src: images.dataUri(r.buffer, r.mime) };
      warn(`Image too large to inline, linked instead: ${info.path}`);
      return { src: images.fileUrl(info.path) };
    }
    return { src: images.fileUrl(info.path) };
  };
  if (parsed.cutAt) warn(`The Markdown nests deeper than 500 levels near line ${parsed.cutAt}. Text from there on was left out.`);
  const html = renderBody(parsed, { image, blockRemote, warn });
  return { html, headings: headings(parsed.tokens), parsed };
}

/**
 * Builds the page.
 * input: { text, docPath, title?, options, mode, assetsDir, webviewBase?, cspSource?, imageUrl?, withMermaidScript?, extraBodyClass? }
 * returns { html, warnings, hasMermaid, hasMath, headings, title, frontMatter }
 */
function buildPage(input) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const fm = input.frontMatter || splitFrontMatter(input.text);
  if (fm.error) warn(fm.error);
  const o = input.options;
  const mode = input.mode || 'print';
  const docDir = input.docPath ? path.dirname(input.docPath) : process.cwd();
  const { html: bodyHtml, headings: hs } = renderMarkdown(fm.body, { mode, docDir, options: o, imageUrl: input.imageUrl, warn });
  const firstH1 = hs.find((h) => h.level === 1);
  const docTitle = o.title || input.title || (firstH1 && firstH1.text) || (input.docPath ? path.basename(input.docPath).replace(/\.[^.]+$/, '') : 'Document');
  const hasMermaid = /<pre class="mermaid">/.test(bodyHtml);
  const hasMath = /class="katex/.test(bodyHtml);
  const c = baseCss(input.assetsDir);
  const nonce = crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  const theme = mode === 'print' ? 'light' : (o.htmlTheme || 'auto');

  let body = bodyHtml;
  if (mode === 'standalone' && hasMermaid && !input.withMermaidScript) {
    body = body.replace(/<pre class="mermaid">([\s\S]*?)<\/pre>/g, (m, src) => `<div class="mermaid-note">Mermaid diagram, shown as code. Install Chrome, Edge or Brave to export it as a drawing.</div><pre class="code"><code>${src}</code></pre>`);
  }
  const pre = [];
  if (o.cover && input.allowCover !== false) pre.push(coverHtml({ ...o, docTitle }));
  if (o.toc) pre.push(tocHtml(hs, input.tocTitle));
  body = pre.join('') + body;

  const scripts = [];
  const mermaidSrc = mode === 'webview' ? `${input.webviewBase}/vendor/mermaid.min.js` : images.fileUrl(path.join(input.assetsDir, 'vendor', 'mermaid.min.js'));
  const runMermaid = hasMermaid && (mode !== 'standalone' || input.withMermaidScript);
  if (runMermaid) scripts.push(`<script nonce="${nonce}" data-zovo src="${escapeHtml(mermaidSrc)}"></script>`);
  if (mode !== 'standalone' || runMermaid) {
    scripts.push(`<script nonce="${nonce}" data-zovo>${readyScript(o.mermaidTheme, mode)}</script>`);
  }
  if (input.extraScript && mode === 'webview') scripts.push(`<script nonce="${nonce}">${input.extraScript}</script>`);

  let csp;
  if (mode === 'webview') {
    const src = input.cspSource;
    csp = `default-src 'none'; img-src ${src} blob: data:${o.allowRemoteImages ? ' https: http:' : ''}; style-src ${src} 'unsafe-inline'; font-src ${src} data:; script-src 'nonce-${nonce}';`;
  } else if (mode === 'print' || runMermaid) {
    // Only the two nonce'd scripts run (Mermaid and the ready check). Scripts in the Markdown never do.
    csp = `default-src 'none'; img-src file: data: blob:${o.allowRemoteImages ? ' https: http:' : ''}; style-src 'unsafe-inline' file:; font-src file: data:; script-src 'nonce-${nonce}';`;
  } else {
    csp = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";
  }

  const lang = o.lang ? ` lang="${escapeHtml(o.lang)}"` : '';
  const dir = o.dir ? ` dir="${o.dir}"` : '';
  const baseHref = mode === 'print' && input.docPath ? `<base href="${escapeHtml(images.fileUrl(docDir) + '/')}">` : '';
  const html = `<!DOCTYPE html>
<html${lang}${dir} class="theme-${theme} mode-${mode}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
${baseHref}
<title>${escapeHtml(docTitle)}</title>
${o.author ? `<meta name="author" content="${escapeHtml(o.author)}">` : ''}
<style>${c.page}</style>
<style>${c.hljs}</style>
${hasMath ? `<style>${katexCss(input.assetsDir, mode, input.webviewBase)}</style>` : ''}
<style>:root{--base-font-size:${o.fontSize}pt}</style>
</head>
<body class="markdown-body${input.extraBodyClass ? ` ${input.extraBodyClass}` : ''}">
${input.beforeBody || ''}<article class="doc">
${body}
</article>${input.afterBody || ''}
${scripts.join('\n')}
</body>
</html>
`;
  return { html, warnings, hasMermaid, hasMath, headings: hs, title: docTitle, frontMatter: fm, nonce };
}

// Runs in the page. window.__zovoReady resolves when Mermaid, images and fonts are done.
function readyScript(mermaidTheme, mode) {
  return `(function(){
  var dark = ${mode === 'print' ? 'false' : "document.documentElement.classList.contains('theme-dark') || (document.documentElement.classList.contains('theme-auto') && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) || document.body.classList.contains('vscode-dark-paper')"};
  window.__zovoReady = (async function(){
    var out = { mermaid: 0, mermaidFailed: 0, images: 0, brokenImages: 0 };
    try {
      var nodes = document.querySelectorAll('pre.mermaid');
      out.mermaid = nodes.length;
      if (nodes.length && window.mermaid) {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : ${JSON.stringify(mermaidTheme || 'default')}, deterministicIds: true });
        try { await window.mermaid.run({ nodes: nodes, suppressErrors: true }); } catch (e) { out.error = String(e && e.message || e); }
        document.querySelectorAll('pre.mermaid').forEach(function(n){
          if (!n.querySelector('svg') || n.querySelector('svg[aria-roledescription="error"]')) { out.mermaidFailed++; n.classList.add('mermaid-failed'); }
        });
      } else if (nodes.length) { out.mermaidFailed = nodes.length; }
    } catch (e) { out.error = String(e && e.message || e); }
    var imgs = Array.prototype.slice.call(document.images);
    out.images = imgs.length;
    await Promise.all(imgs.map(function(img){ return img.complete ? 0 : new Promise(function(r){ img.addEventListener('load', r); img.addEventListener('error', r); setTimeout(r, 15000); }); }));
    out.brokenImages = imgs.filter(function(i){ return !i.naturalWidth; }).length;
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    return out;
  })();
})();`;
}

module.exports = { buildPage, katexCss, tocHtml };
