'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { splitFrontMatter } = require('../src/core/frontmatter');
const { resolveOptions, parseMargin, templateParts } = require('../src/core/options');
const md = require('../src/core/markdown');
const { toModel, htmlToText } = require('../src/core/model');
const images = require('../src/core/images');
const { buildPage } = require('../src/core/html');
const { buildDocx } = require('../src/core/docx');
const { buildPdf } = require('../src/core/pdffallback');
const { ExportSession, mergeMarkdown, chromeTemplate } = require('../src/core/exporter');
const chrome = require('../src/core/chrome');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const ASSETS = path.join(ROOT, 'media');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdexport-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function unzipEntry(buf, name) {
  // minimal zip reader for tests (central directory)
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28); const elen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42); const n = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (n === name) {
      const lnlen = buf.readUInt16LE(off + 26); const lelen = buf.readUInt16LE(off + 28);
      const data = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

test('front matter: good, absent and broken YAML', () => {
  const a = splitFrontMatter('---\ntitle: Hi\ntoc: true\n---\n# Body\n');
  assert.deepEqual(a.data, { title: 'Hi', toc: true });
  assert.equal(a.body, '# Body\n');
  const b = splitFrontMatter('# No front matter\n');
  assert.deepEqual(b.data, {});
  const c = splitFrontMatter(fs.readFileSync(path.join(FIX, 'hostile-yaml.md'), 'utf8'));
  assert.deepEqual(c.data, {});
  assert.match(c.error, /Front matter was ignored/);
  assert.match(c.body, /^# Bad front matter/);
  const d = splitFrontMatter('---\n- a\n- b\n---\nx');
  assert.match(d.error, /not a list of key/);
});

test('options: margins, page sizes, front matter over settings, no remote images from a file', () => {
  assert.deepEqual(parseMargin('10mm 20mm'), { top: 10, right: 20, bottom: 10, left: 20 });
  assert.deepEqual(parseMargin('1in'), { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 });
  assert.deepEqual(parseMargin('nonsense'), { top: 20, right: 20, bottom: 20, left: 20 });
  const o = resolveOptions({ pageSize: 'Letter', margin: '15mm', allowRemoteImages: false }, { pageSize: 'a5', landscape: true, allowRemoteImages: true, toc: 'true' });
  assert.equal(o.pageSize, 'A5');
  assert.equal(o.landscape, true);
  assert.deepEqual(o.paper, { width: 210, height: 148 });
  assert.equal(o.margin.top, 15);
  assert.equal(o.allowRemoteImages, false, 'a document cannot turn on network use');
  assert.equal(o.toc, true);
  const n = resolveOptions({}, { export: { pageSize: 'Legal' } });
  assert.equal(n.pageSize, 'Legal');
  assert.deepEqual(templateParts('Page {page} of {pages}'), [{ text: 'Page ' }, { field: 'page' }, { text: ' of ' }, { field: 'pages' }]);
});

test('markdown: sanitizer removes scripts, handlers and javascript: links', () => {
  const s = md.sanitizeHtml('<script>x()</script><img src=a onerror="evil()"><a href="javascript:alert(1)">l</a><iframe src="x"></iframe><b onclick=\'y\'>b</b>');
  assert.doesNotMatch(s, /script|onerror|onclick|iframe|javascript:/i);
  assert.match(s, /<b>b<\/b>/);
  const r = md.sanitizeHtml('<img src="https://x.org/a.png" alt="A">', { blockRemote: true });
  assert.match(r, /img-blocked/);
  assert.doesNotMatch(r, /<img/);
});

test('markdown: page html has no runnable script from the document', () => {
  const text = fs.readFileSync(path.join(FIX, 'hostile-script.md'), 'utf8');
  for (const mode of ['print', 'standalone']) {
    const p = buildPage({ text, docPath: path.join(FIX, 'hostile-script.md'), options: resolveOptions({}, {}), mode, assetsDir: ASSETS });
    const scripts = [...p.html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    for (const s of scripts) assert.match(s, /nonce=/, `only nonce'd scripts: ${s}`);
    assert.doesNotMatch(p.html, /HACKED|PWNED|onerror|onclick|javascript:/);
    assert.match(p.html, /Content-Security-Policy/);
    assert.match(p.html, /Text after the scripts stays/);
    if (mode === 'standalone') assert.match(p.html, /script-src 'none'/);
  }
});

test('markdown: headings get unique ids, tasks, math, page breaks, footnotes', () => {
  const text = '# A\n\n# A\n\n- [ ] open\n- [x] done\n\n$x^2$ costs $5 and $6\n\n<!-- pagebreak -->\n\nNote[^n]\n\n[^n]: The note.\n';
  const p = buildPage({ text, options: resolveOptions({}, {}), mode: 'standalone', assetsDir: ASSETS });
  assert.match(p.html, /id="a"/);
  assert.match(p.html, /id="a-1"/);
  assert.match(p.html, /type="checkbox" class="task-box" disabled>/);
  assert.match(p.html, /type="checkbox" class="task-box" disabled checked>/);
  assert.match(p.html, /class="katex"/);
  assert.match(p.html, /costs \$5 and \$6/);
  assert.match(p.html, /class="page-break"/);
  assert.match(p.html, /footnote/);
  assert.ok(p.hasMath);
});

test('markdown: highlight and mermaid fences', () => {
  const p = buildPage({ text: '```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n', options: resolveOptions({}, {}), mode: 'print', assetsDir: ASSETS });
  assert.match(p.html, /hljs-keyword/);
  assert.match(p.html, /<pre class="mermaid">graph TD; A--&gt;B/);
  assert.match(p.html, /mermaid\.min\.js/);
  const s = buildPage({ text: '```mermaid\ngraph TD; A-->B\n```\n', options: resolveOptions({}, {}), mode: 'standalone', assetsDir: ASSETS });
  assert.match(s.html, /mermaid-note/);
  assert.doesNotMatch(s.html, /<script/);
});

test('images: resolve, inline in standalone HTML, sizes', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR42mP8z8DwnwEJMBFlBQBFJwMDTkXAEgAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(tmp, 'pic.png'), png);
  assert.deepEqual(images.imageSize(png), { width: 2, height: 3 });
  assert.equal(images.resolveImage('https://a.b/c.png', tmp).kind, 'remote');
  assert.equal(images.resolveImage('pic.png', tmp).exists, true);
  assert.equal(images.resolveImage('nope.png', tmp).exists, false);
  assert.equal(images.resolveImage('javascript:alert(1)', tmp).kind, 'bad');
  const warnings = [];
  const p = buildPage({ text: '![p](pic.png) ![r](https://example.com/x.png) ![m](missing.png)', docPath: path.join(tmp, 'doc.md'), options: resolveOptions({}, {}), mode: 'standalone', assetsDir: ASSETS });
  warnings.push(...p.warnings);
  assert.match(p.html, /src="data:image\/png;base64,/);
  assert.match(p.html, /img-blocked/);
  assert.match(p.html, /img-missing/);
  assert.ok(warnings.some((w) => /Remote image not loaded/.test(w)));
  assert.ok(warnings.some((w) => /Image not found/.test(w)));
  assert.deepEqual(images.svgSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"></svg>')), { width: 120, height: 40 });
});

test('model: lists, tables, quotes, footnotes and raw HTML', () => {
  const m = toModel(md.parse('1. a\n2. b\n   - c\n\n| x | y |\n|---|--:|\n| 1 | 2 |\n\n> q\n\nT[^1]\n\n[^1]: n\n\n<div>raw <b>html</b></div>\n').tokens);
  const types = m.map((b) => b.type);
  assert.deepEqual(types, ['list', 'table', 'quote', 'para', 'para', 'footnotes']);
  assert.equal(m[0].ordered, true);
  assert.equal(m[0].items[1].blocks[1].type, 'list');
  assert.deepEqual(m[1].aligns, ['', 'right']);
  assert.equal(m[5].items[0].n, 1);
  assert.equal(htmlToText('<p>a<br>b</p><script>x</script>'), 'a\nb');
});

test('docx: Word heading styles, tables, numbering, footnotes, hyperlinks', async () => {
  const text = '# Title\n\n## Part [link](https://example.com)\n\n1. one\n2. two\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nprint(1)\n```\n\nNote[^1]\n\n<!-- pagebreak -->\n\n[go](#title)\n\n[^1]: Foot.\n';
  const o = resolveOptions({ footer: 'Page {page} of {pages}', header: '{title}' }, { toc: true });
  const buf = await buildDocx(toModel(md.parse(text).tokens), { options: o, docDir: tmp, title: 'T' });
  const doc = unzipEntry(buf, 'word/document.xml');
  assert.match(doc, /w:pStyle w:val="Heading1"/);
  assert.match(doc, /w:pStyle w:val="Heading2"/);
  assert.match(doc, /<w:tbl>/);
  assert.match(doc, /<w:numPr>/);
  assert.match(doc, /w:footnoteReference/);
  assert.match(doc, /<w:hyperlink [^>]*w:anchor="title_1"/);
  assert.match(doc, /\u2612/);
  assert.match(doc, /w:br w:type="page"/);
  assert.match(doc, /w:pgSz w:w="11906" w:h="16838"/);
  assert.match(unzipEntry(buf, 'word/footnotes.xml'), /Foot\./);
  assert.ok(Object.values({ f: unzipEntry(buf, 'word/footer1.xml') || '' }).some((x) => /PAGE/.test(x)));
});

test('docx: landscape Letter and RTL paragraph', async () => {
  const o = resolveOptions({ pageSize: 'Letter', landscape: true }, {});
  const buf = await buildDocx(toModel(md.parse('مرحبا بالعالم\n').tokens), { options: o, docDir: tmp, title: 'T' });
  const doc = unzipEntry(buf, 'word/document.xml');
  assert.match(doc, /w:orient="landscape"/);
  assert.match(doc, /<w:bidi\/>/);
});

test('hostile: 200-level nested list in DOCX, built-in PDF and HTML', async () => {
  const text = fs.readFileSync(path.join(FIX, 'hostile-nested.md'), 'utf8');
  const o = resolveOptions({}, {});
  const model = toModel(md.parse(text).tokens);
  const buf = await buildDocx(model, { options: o, docDir: FIX, title: 'nested' });
  assert.ok(buf.length > 1000);
  const f = path.join(tmp, 'nested.pdf');
  const t0 = Date.now();
  await buildPdf(model, f, { options: o, docDir: FIX, title: 'nested', fontsDir: path.join(ASSETS, 'fonts') });
  assert.equal(fs.readFileSync(f).subarray(0, 5).toString(), '%PDF-');
  assert.ok(Date.now() - t0 < 20000);
  const p = buildPage({ text, options: o, mode: 'standalone', assetsDir: ASSETS });
  assert.match(p.html, /After the list/);
  // 1,000 levels: markdown-it stops; the cut is reported, not silent
  const deep = Array.from({ length: 1000 }, (_, i) => `${'  '.repeat(i)}- l${i}`).join('\n') + '\n\nEND\n';
  const q = buildPage({ text: deep, options: o, mode: 'standalone', assetsDir: ASSETS });
  assert.ok(q.warnings.some((w) => /nests deeper than 500 levels/.test(w)));
});

test('built-in PDF: valid file, table of contents, missing and remote images become text', async () => {
  const text = fs.readFileSync(path.join(FIX, 'hostile-image.md'), 'utf8') + '\n\n## More\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  const o = resolveOptions({}, { toc: true });
  const warnings = [];
  const f = path.join(tmp, 'img.pdf');
  await buildPdf(toModel(md.parse(text).tokens), f, { options: o, docDir: FIX, title: 'img', fontsDir: path.join(ASSETS, 'fonts'), warn: (w) => warnings.push(w) });
  const pdf = fs.readFileSync(f);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 2, 'contents page + body');
  assert.ok(warnings.some((w) => /Image not found/.test(w)));
  assert.ok(warnings.some((w) => /Remote image not loaded/.test(w)));
});

test('exporter: built-in engine session writes PDF, DOCX and HTML; bad YAML is a warning', async () => {
  const s = new ExportSession({ assetsDir: ASSETS, fontsDir: path.join(ASSETS, 'fonts'), settings: {}, engine: 'builtin' });
  const docPath = path.join(FIX, 'hostile-yaml.md');
  const text = fs.readFileSync(docPath, 'utf8');
  for (const kind of ['pdf', 'docx', 'html']) {
    const outPath = path.join(tmp, `yaml.${kind}`);
    const r = await s[kind]({ text, docPath, outPath, pro: {} });
    assert.ok(fs.statSync(outPath).size > 500, kind);
    if (kind !== 'html') assert.equal(r.engine, 'builtin');
    assert.ok(r.warnings.some((w) => /Front matter was ignored/.test(w)), kind);
    assert.ok(!fs.readdirSync(tmp).some((n) => n.endsWith('.part')), 'no partial files left');
  }
  await s.close();
});

test('exporter: cover page only when Pro allows it', async () => {
  const s = new ExportSession({ assetsDir: ASSETS, fontsDir: path.join(ASSETS, 'fonts'), settings: {}, engine: 'builtin' });
  const text = '---\ntitle: Report\ncover:\n  subtitle: Q4\n---\n# Body\n';
  await s.html({ text, docPath: path.join(tmp, 'c.md'), outPath: path.join(tmp, 'c1.html'), pro: {} });
  await s.html({ text, docPath: path.join(tmp, 'c.md'), outPath: path.join(tmp, 'c2.html'), pro: { cover: true } });
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'c1.html'), 'utf8'), /class="cover"/);
  assert.match(fs.readFileSync(path.join(tmp, 'c2.html'), 'utf8'), /class="cover"[\s\S]*Q4/);
  await s.close();
});

test('merge: files joined with page breaks, relative images made absolute', () => {
  const t = mergeMarkdown([{ path: '/a/one.md', text: '---\nx: 1\n---\n# One\n![i](img/p.png)' }, { path: '/b/two.md', text: '# Two' }]);
  assert.match(t, /# One/);
  assert.match(t, /<!-- pagebreak -->/);
  assert.match(t, /!\[i\]\(<\/a\/img\/p\.png>\)/);
  assert.doesNotMatch(t, /x: 1/);
});

test('chrome: candidates per OS, custom path, offline launch flags, header template escapes', () => {
  assert.ok(chrome.candidates('darwin', { HOME: '/Users/x' }).some((c) => c.path.includes('Google Chrome.app')));
  assert.ok(chrome.candidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\L' }).some((c) => /msedge\.exe$/.test(c.path)));
  assert.ok(chrome.candidates('linux', {}).some((c) => c.path === '/usr/bin/chromium'));
  assert.equal(chrome.findBrowser('/definitely/not/here'), null);
  const off = chrome.launchArgs('/tmp/u', false);
  assert.ok(off.includes('--host-resolver-rules=MAP * ~NOTFOUND'));
  assert.ok(off.includes('--disable-background-networking'));
  assert.ok(off.some((a) => a.startsWith('--proxy-server=')));
  assert.ok(!chrome.launchArgs('/tmp/u', true).some((a) => a.startsWith('--proxy-server=')));
  assert.match(chromeTemplate('<b>{title}</b> {page}/{pages}', 'A&B'), /&lt;b&gt;A&amp;B&lt;\/b&gt; <span class="pageNumber"><\/span>\/<span class="totalPages"><\/span>/);
});
