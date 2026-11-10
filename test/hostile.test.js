'use strict';
// Hostile Markdown and templates: truncated input, huge counts, alias loops in YAML, HTML in names, zip bombs.
// Every case must finish quickly with a file or a clear message, and never run a script or load a remote URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { splitFrontMatter } = require('../src/core/frontmatter');
const { buildPage } = require('../src/core/html');
const { resolveOptions } = require('../src/core/options');
const { ExportSession } = require('../src/core/exporter');
const { stylesFromTemplate } = require('../src/core/docx');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'media');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdexport-hostile-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const session = () => new ExportSession({ assetsDir: ASSETS, fontsDir: path.join(ASSETS, 'fonts'), settings: {}, engine: 'builtin' });
const page = (text, extra = {}) => { const fm = splitFrontMatter(text); return buildPage({ text, frontMatter: fm, options: resolveOptions({}, fm.data), mode: 'standalone', assetsDir: ASSETS, ...extra }); };

async function allFormats(name, text, budgetMs) {
  const s = session();
  const docPath = path.join(tmp, `${name}.md`);
  fs.writeFileSync(docPath, text);
  const t0 = Date.now();
  const out = {};
  try {
    for (const kind of ['html', 'docx', 'pdf']) {
      const outPath = path.join(tmp, `${name}.${kind}`);
      out[kind] = await s[kind]({ text, docPath, outPath, pro: {} });
      assert.ok(fs.statSync(outPath).size > 0, `${name}.${kind} written`);
    }
  } finally { await s.close(); }
  const ms = Date.now() - t0;
  assert.ok(ms < budgetMs, `${name}: ${ms} ms (budget ${budgetMs})`);
  return out;
}

test('truncated input: open fences, open front matter, open math, open comment, half table', { timeout: 60000 }, async () => {
  const cases = {
    fence: '# T\n\n```js\nconst a = 1;\n',
    frontmatter: '---\ntitle: never closed\n# Body\n',
    math: 'Before $$\\frac{1}{',
    comment: 'Text <!-- never closed\n# Hidden?',
    table: '| a | b |\n|---|\n| 1 |',
    html: '<div><table><tr><td>cut',
    footnote: 'Ref[^1] and [^2]\n\n[^1]:',
  };
  for (const [name, text] of Object.entries(cases)) await allFormats(`cut-${name}`, text, 20000);
});

test('huge counts: 2,000 table columns, 20,000 list items, 5,000 footnotes, a 2 MB line', { timeout: 180000 }, async () => {
  const cols = 2000;
  const wide = `|${Array.from({ length: cols }, (_, i) => ` c${i} `).join('|')}|\n|${'---|'.repeat(cols)}\n|${' x |'.repeat(cols)}\n`;
  await allFormats('wide-table', wide, 60000);
  await allFormats('many-items', Array.from({ length: 20000 }, (_, i) => `- item ${i}`).join('\n'), 90000);
  const notes = Array.from({ length: 5000 }, (_, i) => `Text[^${i}]`).join(' ') + '\n\n' + Array.from({ length: 5000 }, (_, i) => `[^${i}]: note ${i}`).join('\n');
  await allFormats('many-notes', notes, 90000);
  const p = page('a'.repeat(2 * 1024 * 1024));
  assert.ok(p.html.length > 2 * 1024 * 1024);
});

test('YAML alias loop and alias bomb in front matter: ignored with a warning, fast', () => {
  const bomb = ['---', 'a: &a ["x","x","x","x","x","x","x","x","x"]', 'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]', 'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]', 'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]', 'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]', 'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]', 'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]', '---', '# Body'].join('\n');
  const t0 = Date.now();
  const r = splitFrontMatter(bomb);
  assert.ok(Date.now() - t0 < 2000, 'no blow-up');
  assert.match(r.body, /# Body/);
  const html = page(bomb).html;
  assert.ok(html.length < 1024 * 1024, `page stays small: ${html.length}`);
  const self = splitFrontMatter('---\na: &a [*a]\n---\nx');
  assert.match(self.body, /x/);
});

test('HTML in names and titles stays text: front matter title, header, file name, heading', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const text = `---\ntitle: "${evil}"\nauthor: "${evil}"\nheader: "${evil}"\ncover: true\n---\n# ${evil}\n\n[x](javascript:alert(3)) [y](&#106;avascript:alert(4))\n`;
  const fm = splitFrontMatter(text);
  const p = buildPage({ text, frontMatter: fm, options: resolveOptions({}, fm.data), mode: 'standalone', assetsDir: ASSETS, allowCover: true, title: evil });
  assert.doesNotMatch(p.html, /<script>alert/);
  assert.doesNotMatch(p.html, /<img src=x onerror/i);
  assert.doesNotMatch(p.html, /href="(javascript|&#106;avascript)/i);
  assert.match(p.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(p.html, /script-src 'none'|script-src 'nonce-/);
});

test('Word template zip bomb and junk: refused with a message, no huge allocation', async () => {
  const { zipSync } = require('fflate');
  // styles.xml that inflates to 64 MB from a few KB
  const big = zipSync({ 'word/styles.xml': new Uint8Array(64 * 1024 * 1024) }, { level: 9 });
  assert.ok(big.length < 200 * 1024);
  await assert.rejects(stylesFromTemplate(Buffer.from(big)), /larger than 16 MB/);
  await assert.rejects(stylesFromTemplate(Buffer.from('not a zip at all')), /not a \.docx or \.dotx/);
  await assert.rejects(stylesFromTemplate(Buffer.from(zipSync({ 'a.txt': new Uint8Array(4) }))), /no word\/styles\.xml/);
  assert.equal(await stylesFromTemplate(Buffer.from(zipSync({ 'word/styles.xml': new TextEncoder().encode('<w:styles/>') }))), '<w:styles/>');
  // the export still writes the Word file and says the template was not used
  const s = session();
  const bad = path.join(tmp, 'bomb.dotx'); fs.writeFileSync(bad, big);
  const docPath = path.join(tmp, 'tpl.md'); fs.writeFileSync(docPath, '# Hi\n');
  const r = await s.docx({ text: '# Hi\n', docPath, outPath: path.join(tmp, 'tpl.docx'), pro: { template: bad } });
  await s.close();
  assert.equal(r.templateUsed, false);
  assert.ok(r.warnings.some((w) => /Template not used: .*16 MB/.test(w)));
  assert.ok(fs.existsSync(path.join(tmp, 'tpl.docx')));
  void zlib;
});

test('images: a directory, a FIFO-like name, a huge sparse file and remote URLs never load', { timeout: 30000 }, async () => {
  const dir = path.join(tmp, 'imgs'); fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'folder.png'));
  const sparse = path.join(dir, 'huge.png');
  const fd = fs.openSync(sparse, 'w'); fs.ftruncateSync(fd, 30 * 1024 * 1024); fs.closeSync(fd); // over the 25 MB cap, no real disk use
  const text = '![d](folder.png) ![h](huge.png) ![r](https://example.com/x.png) <img src="http://127.0.0.1:9/a.png">';
  const docPath = path.join(dir, 'img.md'); fs.writeFileSync(docPath, text);
  const out = await allFormats('img', text, 20000);
  void out;
  const html = fs.readFileSync(path.join(tmp, 'img.html'), 'utf8');
  assert.doesNotMatch(html, /src="https?:/);
  fs.rmSync(sparse);
});
