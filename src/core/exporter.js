'use strict';
// Export pipeline without VS Code: Markdown text -> PDF (browser or built-in), DOCX or standalone HTML.
// The VS Code layer (extension.js) only picks files, shows progress and opens the results.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { splitFrontMatter } = require('./frontmatter');
const { resolveOptions, templateParts } = require('./options');
const { parse } = require('./markdown');
const { toModel } = require('./model');
const { buildPage } = require('./html');
const { buildDocx, stylesFromTemplate } = require('./docx');
const { buildPdf } = require('./pdffallback');
const { findBrowser, Browser } = require('./chrome');
const { escapeHtml } = require('./markdown');

const MM_IN = 1 / 25.4;
const WORKER_MIN_CHARS = 1000000; // Markdown longer than this is exported to DOCX or built-in PDF in a worker thread
const WORKER_HEAP_MB = 4096;

function chromeTemplate(tpl, title) {
  if (!tpl) return '<span></span>';
  const parts = templateParts(tpl).map((p) => {
    if (p.text != null) return escapeHtml(p.text);
    if (p.field === 'page') return '<span class="pageNumber"></span>';
    if (p.field === 'pages') return '<span class="totalPages"></span>';
    if (p.field === 'title') return escapeHtml(title || '');
    return '<span class="date"></span>';
  }).join('');
  return `<div style="font-size:8px;color:#59636e;width:100%;text-align:center;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;padding:0 10mm">${parts}</div>`;
}

/**
 * One export session. Reuses one headless browser for many files (folder export) and closes it at the end.
 * env: { assetsDir, fontsDir, settings, browserPath, engine: 'auto'|'browser'|'builtin', log?, isCancelled?() }
 */
class ExportSession {
  constructor(env) {
    this.env = env;
    this.browser = null;
    this.browserInfo = undefined;
    this.tmpDirs = [];
    this.workers = new Set();
  }

  /** {name, path} of the browser this session will use, or null for the built-in engine. */
  browserFor() {
    if (this.browserInfo !== undefined) return this.browserInfo;
    const e = this.env;
    if (e.engine === 'builtin') { this.browserInfo = null; return null; }
    this.browserInfo = findBrowser(e.browserPath) || null;
    return this.browserInfo;
  }

  async _browser(allowNetwork) {
    const info = this.browserFor();
    if (!info) return null;
    if (this.browser && !this.browser.closed && this.browserNet === allowNetwork) return this.browser;
    if (this.browser) await this.browser.close();
    this.browser = await Browser.launch({ path: info.path, allowNetwork, timeoutMs: 120000 });
    this.browserNet = allowNetwork;
    return this.browser;
  }

  _tmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zovo-mdexport-page-'));
    this.tmpDirs.push(d);
    return d;
  }

  async close() {
    if (this.browser) { try { await this.browser.close(); } catch (e) { /* gone */ } this.browser = null; }
    for (const d of this.tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* temp */ } }
  }

  kill() {
    if (this.browser) this.browser.kill();
    for (const w of this.workers) w.terminate();
  }

  prepare(text, docPath, extraFm) {
    const fm = splitFrontMatter(text);
    if (extraFm) Object.assign(fm.data, extraFm);
    const options = resolveOptions(this.env.settings || {}, fm.data);
    options.fallbackFont = (this.env.settings || {}).fallbackFont || '';
    return { fm, options };
  }

  /**
   * PDF. job: { text, docPath, outPath, pro: {cover} , title? }
   * returns { engine: 'browser'|'builtin', browser?: name, warnings, bytes }
   */
  async pdf(job) {
    const { fm, options } = this.prepare(job.text, job.docPath, job.frontMatter);
    if (!job.pro || !job.pro.cover) options.cover = false;
    const warnings = [];
    const info = this.browserFor();
    if (this.env.engine === 'browser' && !info) throw new Error('No Chrome, Edge, Brave or Chromium was found. Set markdownExport.browserPath, or set markdownExport.pdfEngine to "auto" to use the built-in engine.');
    if (info) {
      try {
        return await this._pdfBrowser(job, fm, options, warnings);
      } catch (e) {
        if (this.env.engine === 'browser' || job.noFallback) throw e;
        warnings.push(`${info.name} could not print this file (${e.message}). The built-in engine made the PDF instead.`);
        if (this.browser) { this.browser.kill(); this.browser = null; }
      }
    }
    if (this._big(job)) {
      const r = await this._inWorker('pdf', job);
      r.warnings = dedupe([...warnings, ...r.warnings]);
      return r;
    }
    const r = await this._pdfBuiltin(job);
    r.warnings = dedupe([...warnings, ...r.warnings]);
    return r;
  }

  async _pdfBuiltin(job) {
    const { fm, options } = this.prepare(job.text, job.docPath, job.frontMatter);
    if (!job.pro || !job.pro.cover) options.cover = false;
    const warnings = [];
    const parsed = parse(fm.body, { breaks: options.breaks });
    if (parsed.cutAt) warnings.push(`The Markdown nests deeper than 500 levels near line ${parsed.cutAt}. Text from there on was left out.`);
    const model = toModel(parsed.tokens);
    if (fm.error) warnings.push(fm.error);
    const title = this._title(options, model, job);
    const r = await buildPdf(model, job.outPath, { options, docDir: path.dirname(job.docPath || '.'), title, fontsDir: this.env.fontsDir, warn: (w) => warnings.push(w), cover: options.cover });
    return { engine: 'builtin', warnings: dedupe(warnings), bytes: r.bytes };
  }

  _big(job) { return !this.env.inWorker && !this.env.noWorker && String(job.text || '').length > WORKER_MIN_CHARS; }

  /** Runs one export in a worker thread (large files). */
  _inWorker(kind, job) {
    const { Worker } = require('worker_threads');
    const env = { ...this.env };
    delete env.isCancelled; delete env.log;
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: { env, kind, job, browserInfo: kind === 'docx' ? this.browserFor() : null },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
      this.workers.add(w);
      let settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; this.workers.delete(w); fn(v); } };
      w.on('message', async (m) => {
        if (m.type === 'raster') {
          try { const result = await this.raster(m.jobs, m.options); w.postMessage({ type: 'rasterResult', id: m.id, result }); } catch (e) { w.postMessage({ type: 'rasterResult', id: m.id, error: e.message }); }
        } else if (m.type === 'done') { finish(resolve, m.result); w.terminate(); }
        else if (m.type === 'error') { finish(reject, new Error(m.error)); w.terminate(); }
      });
      w.on('error', (e) => finish(reject, new Error(/memory|ERR_WORKER_OUT_OF_MEMORY/i.test(`${e.code} ${e.message}`) ? `This file needs more than ${WORKER_HEAP_MB} MB of memory to export to ${kind === 'docx' ? 'Word' : 'PDF'}. Split it into smaller files.` : e.message)));
      w.on('exit', (code) => finish(reject, new Error(code ? `The export stopped (code ${code}).` : 'The export stopped.')));
    });
  }

  _title(options, model, job) {
    if (options.title) return options.title;
    if (job.title) return job.title;
    const h1 = model.find((b) => b.type === 'heading' && b.level === 1);
    if (h1) return h1.inlines.map((x) => x.text || '').join('');
    return path.basename(job.docPath || 'document').replace(/\.[^.]+$/, '');
  }

  async _pdfBrowser(job, fm, options, warnings) {
    const page = buildPage({ text: job.text, frontMatter: fm, docPath: job.docPath, options, mode: 'print', assetsDir: this.env.assetsDir, title: job.title, allowCover: options.cover });
    warnings.push(...page.warnings);
    const dir = this._tmp();
    const htmlFile = path.join(dir, 'page.html');
    fs.writeFileSync(htmlFile, page.html);
    const sizeMb = Buffer.byteLength(page.html) / 1048576;
    const timeoutMs = 120000 + Math.round(sizeMb * 30000);
    const browser = await this._browser(!!options.allowRemoteImages);
    const tab = await browser.open(require('url').pathToFileURL(htmlFile).href, { timeoutMs, allowNetwork: !!options.allowRemoteImages });
    try {
      const ready = await tab.ready(Math.max(90000, timeoutMs / 2));
      if (ready.mermaidFailed) warnings.push(`${ready.mermaidFailed} Mermaid diagram(s) have errors and are shown as code.`);
      if (ready.brokenImages) warnings.push(`${ready.brokenImages} image(s) could not be loaded.`);
      if (tab.blocked.length) warnings.push(`Blocked ${tab.blocked.length} network request(s) from the document (remote content is off).`);
      const hasBands = !!(options.header || options.footer);
      const params = {
        printBackground: true,
        landscape: false,
        paperWidth: options.paper.width * MM_IN,
        paperHeight: options.paper.height * MM_IN,
        marginTop: options.margin.top * MM_IN,
        marginBottom: options.margin.bottom * MM_IN,
        marginLeft: options.margin.left * MM_IN,
        marginRight: options.margin.right * MM_IN,
        displayHeaderFooter: hasBands,
        headerTemplate: chromeTemplate(options.header, page.title),
        footerTemplate: chromeTemplate(options.footer, page.title),
        preferCSSPageSize: false,
        scale: 1,
      };
      const bytes = await tab.printToFile(job.outPath, params, timeoutMs * 2, sizeMb < 2);
      return { engine: 'browser', browser: this.browserInfo.name, warnings: dedupe(warnings), bytes, ready };
    } finally {
      await tab.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
    }
  }

  /** Renders snippets in the browser and returns PNGs (DOCX: Mermaid, display math, SVG and WebP images). */
  async raster(jobs, options) {
    const info = this.browserFor();
    if (!info || !jobs.length) return [];
    const { renderTex, escapeHtml: esc } = require('./markdown');
    const items = jobs.map((j, k) => {
      if (j.kind === 'mermaid') return `<div class="r" id="r${k}"><pre class="mermaid">${esc(j.src)}</pre></div>`;
      if (j.kind === 'math') return `<div class="r" id="r${k}"><div class="t">${renderTex(j.src, true)}</div></div>`;
      return `<div class="r" id="r${k}"><img class="t" src="${esc(j.src)}" style="max-width:1600px"></div>`;
    }).join('\n');
    const fake = '# x\n\n$x$\n\n```mermaid\ngraph TD; A-->B\n```\n'; // forces KaTeX CSS and the Mermaid script in
    const page = buildPage({ text: fake, docPath: path.join(os.tmpdir(), 'raster.md'), options: { ...options, toc: false, cover: false }, mode: 'print', assetsDir: this.env.assetsDir });
    const html = page.html.replace(/<article class="doc">[\s\S]*?<\/article>/, `<article class="doc raster">${items}</article>`)
      .replace('</head>', '<style>body{background:#fff;margin:0}.raster .r{display:block;width:960px;margin:0 0 12px}.raster .t{display:inline-block;padding:4px 8px;background:#fff}.raster .t .katex-display{margin:0}.raster pre.mermaid{margin:0;padding:0;text-align:left;background:#fff}</style></head>');
    const dir = this._tmp();
    const htmlFile = path.join(dir, 'raster.html');
    fs.writeFileSync(htmlFile, html);
    const browser = await this._browser(false);
    const tab = await browser.open(require('url').pathToFileURL(htmlFile).href, { width: 1000, height: 1200 });
    try {
      await tab.ready(120000);
      const shots = await tab.screenshots(`[...document.querySelectorAll('.raster > .r')].map(r => r.querySelector('pre.mermaid:not(.mermaid-failed) > svg, .t'))`, 2);
      // screenshots are at 2x; report CSS pixels as the size
      return shots.map((s) => (s ? { png: s.png, width: s.width, height: s.height } : null));
    } finally {
      await tab.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
    }
  }

  /** DOCX. job: { text, docPath, outPath, pro: {cover, template} } */
  async docx(job) {
    if (this._big(job)) return this._inWorker('docx', job);
    const { fm, options } = this.prepare(job.text, job.docPath, job.frontMatter);
    const warnings = [];
    if (fm.error) warnings.push(fm.error);
    const parsed = parse(fm.body, { breaks: options.breaks });
    if (parsed.cutAt) warnings.push(`The Markdown nests deeper than 500 levels near line ${parsed.cutAt}. Text from there on was left out.`);
    const model = toModel(parsed.tokens);
    const title = this._title(options, model, job);
    let externalStyles;
    if (job.pro && job.pro.template) {
      try {
        if (fs.statSync(job.pro.template).size > 50 * 1024 * 1024) throw new Error('The template is larger than 50 MB.');
        externalStyles = await stylesFromTemplate(fs.readFileSync(job.pro.template));
      } catch (e) { warnings.push(`Template not used: ${e.message}`); }
    }
    const canRaster = !!this.browserFor();
    const buf = await buildDocx(model, {
      options, docDir: path.dirname(job.docPath || '.'), title, warn: (w) => warnings.push(w),
      raster: canRaster ? (jobs) => this.raster(jobs, options) : null,
      externalStyles, cover: !!(job.pro && job.pro.cover && options.cover),
    });
    const tmp = `${job.outPath}.${process.pid}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, job.outPath);
    if (!canRaster && model.some((b) => b.type === 'mermaid')) warnings.push('Mermaid diagrams are shown as code in Word, because no Chrome, Edge or Brave was found.');
    return { engine: canRaster ? 'browser' : 'builtin', warnings: dedupe(warnings), bytes: buf.length, templateUsed: !!externalStyles };
  }

  /** Standalone HTML. job: { text, docPath, outPath, pro: {cover} } */
  async html(job) {
    const { fm, options } = this.prepare(job.text, job.docPath, job.frontMatter);
    if (!job.pro || !job.pro.cover) options.cover = false;
    let page = buildPage({ text: job.text, frontMatter: fm, docPath: job.docPath, options, mode: 'standalone', assetsDir: this.env.assetsDir, title: job.title });
    const warnings = [...page.warnings];
    let html = page.html;
    if (page.hasMermaid && this.browserFor()) {
      // Draw the diagrams once in the browser and keep the SVG, so the HTML file needs no script.
      try {
        page = buildPage({ text: job.text, frontMatter: fm, docPath: job.docPath, options, mode: 'standalone', assetsDir: this.env.assetsDir, title: job.title, withMermaidScript: true });
        const dir = this._tmp();
        const f = path.join(dir, 'page.html');
        fs.writeFileSync(f, page.html);
        const browser = await this._browser(false);
        const tab = await browser.open(require('url').pathToFileURL(f).href);
        try {
          await tab.ready(120000);
          html = await tab.evaluate(`(() => {
            document.querySelectorAll('script[data-zovo]').forEach(s => s.remove());
            const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
            if (m) m.setAttribute('content', "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';");
            return '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
          })()`);
        } finally { await tab.close(); }
      } catch (e) {
        warnings.push(`Mermaid diagrams are shown as code: ${e.message}`);
        html = buildPage({ text: job.text, frontMatter: fm, docPath: job.docPath, options, mode: 'standalone', assetsDir: this.env.assetsDir, title: job.title }).html;
      }
    } else if (page.hasMermaid) warnings.push('Mermaid diagrams are shown as code, because no Chrome, Edge or Brave was found.');
    const tmp = `${job.outPath}.${process.pid}.part`;
    fs.writeFileSync(tmp, html);
    fs.renameSync(tmp, job.outPath);
    return { engine: page.hasMermaid && this.browserFor() ? 'browser' : 'builtin', warnings: dedupe(warnings), bytes: Buffer.byteLength(html) };
  }
}

function dedupe(list) { return [...new Set(list)]; }

/** Joins Markdown files into one document for a merged PDF (Pro). Each file starts on a new page. */
function mergeMarkdown(files) {
  const parts = [];
  for (const f of files) {
    let t = f.text;
    const fm = splitFrontMatter(t);
    t = fm.body;
    // relative images keep working: rewrite them to absolute paths of their own folder
    const dir = path.dirname(f.path);
    t = t.replace(/(!\[[^\]]*\]\()\s*<?([^)\s>]+)>?/g, (m, a, src) => (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src) ? m : `${a}<${path.resolve(dir, decodeURIComponentSafe(src)).replace(/\\/g, '/')}>`));
    parts.push(t.trim());
  }
  return parts.join('\n\n<!-- pagebreak -->\n\n');
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

module.exports = { ExportSession, mergeMarkdown, chromeTemplate };
