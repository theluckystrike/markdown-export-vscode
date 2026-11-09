'use strict';
// Runs only when Chrome, Edge, Brave or Chromium is installed: the real browser path, offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExportSession } = require('../src/core/exporter');
const { findBrowser } = require('../src/core/chrome');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const ASSETS = path.join(ROOT, 'media');
const browser = findBrowser('');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdexport-btest-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const session = () => new ExportSession({ assetsDir: ASSETS, fontsDir: path.join(ASSETS, 'fonts'), settings: { header: '{title}', footer: '{page} / {pages}' }, engine: 'browser' });

test('browser PDF: Mermaid drawn, math, outline, nothing left behind', { skip: !browser && 'no browser installed', timeout: 120000 }, async () => {
  const s = session();
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('zovo-mdexport-')).length;
  const text = `${fs.readFileSync(path.join(FIX, 'mermaid.md'), 'utf8')}\n\n${fs.readFileSync(path.join(FIX, 'math.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '')}`;
  const out = path.join(tmp, 'b.pdf');
  const r = await s.pdf({ text, docPath: path.join(FIX, 'mermaid.md'), outPath: out, pro: {} });
  await s.close();
  assert.equal(r.engine, 'browser');
  assert.equal(r.ready.mermaid, 2);
  assert.equal(r.ready.mermaidFailed, 0);
  const pdf = fs.readFileSync(out);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/Outlines/);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('zovo-mdexport-')).length;
  assert.ok(after <= before, 'temporary profile removed');
});

test('browser PDF: remote image is refused, script in Markdown never runs', { skip: !browser && 'no browser installed', timeout: 120000 }, async () => {
  const s = session();
  const text = `${fs.readFileSync(path.join(FIX, 'hostile-script.md'), 'utf8')}\n\n<img src="https://example.com/x.png" alt="remote">\n\n<p><img src="http://127.0.0.1:9/x.png"></p>`;
  const out = path.join(tmp, 's.pdf');
  const r = await s.pdf({ text, docPath: path.join(FIX, 'hostile-script.md'), outPath: out, pro: {} });
  await s.close();
  assert.equal(r.engine, 'browser');
  assert.ok(fs.statSync(out).size > 1000);
  const raw = fs.readFileSync(out).toString('latin1');
  assert.doesNotMatch(raw, /HACKED|PWNED/);
});

test('DOCX with a browser: Mermaid and display math become pictures', { skip: !browser && 'no browser installed', timeout: 120000 }, async () => {
  const s = session();
  const text = `${fs.readFileSync(path.join(FIX, 'mermaid.md'), 'utf8')}\n\n$$\\frac{a}{b}$$\n`;
  const out = path.join(tmp, 'm.docx');
  const r = await s.docx({ text, docPath: path.join(FIX, 'mermaid.md'), outPath: out, pro: {} });
  await s.close();
  assert.equal(r.engine, 'browser');
  const zip = fs.readFileSync(out).toString('latin1');
  assert.ok((zip.match(/word\/media\/[^\s"]+\.png/g) || []).length >= 3, 'three PNG pictures');
});

test('HTML with a browser: Mermaid kept as SVG, no script in the file', { skip: !browser && 'no browser installed', timeout: 120000 }, async () => {
  const s = session();
  const out = path.join(tmp, 'm.html');
  await s.html({ text: fs.readFileSync(path.join(FIX, 'mermaid.md'), 'utf8'), docPath: path.join(FIX, 'mermaid.md'), outPath: out, pro: {} });
  await s.close();
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<svg[^>]+aria-roledescription="(flowchart-v2|sequence)"/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /script-src 'none'/);
});

test('browser PDF: a 200-level nested list stays on the page', { skip: !browser && 'no browser installed', timeout: 120000 }, async () => {
  const s = session();
  const out = path.join(tmp, 'n.pdf');
  const docPath = path.join(FIX, 'hostile-nested.md');
  const r = await s.pdf({ text: fs.readFileSync(docPath, 'utf8'), docPath, outPath: out, pro: {} });
  await s.close();
  assert.equal(r.engine, 'browser');
  // the page must not be thousands of points wide: each page is A4 (595 x 842 pt)
  const raw = fs.readFileSync(out).toString('latin1');
  const boxes = [...raw.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => Number(m[1]));
  assert.ok(boxes.length >= 1 && boxes.every((w) => w < 600));
  assert.ok(boxes.length <= 8, `pages: ${boxes.length}`);
});

test('a browser that cannot start: the built-in engine makes the PDF and says so', { timeout: 60000 }, async () => {
  const s = new ExportSession({ assetsDir: ASSETS, fontsDir: path.join(ASSETS, 'fonts'), settings: {}, engine: 'auto', browserPath: '/usr/bin/true' });
  const out = path.join(tmp, 'fb.pdf');
  const r = await s.pdf({ text: '# Fallback\n\nText.\n', docPath: path.join(tmp, 'fb.md'), outPath: out, pro: {} });
  await s.close();
  assert.equal(r.engine, 'builtin');
  assert.ok(r.warnings.some((w) => /could not print this file .* built-in engine made the PDF/.test(w)), r.warnings.join(' | '));
  assert.equal(fs.readFileSync(out).subarray(0, 5).toString(), '%PDF-');
  assert.ok(!fs.readdirSync(os.tmpdir()).some((n) => /^zovo-mdexport-[A-Za-z0-9]{6}$/.test(n)), 'no temporary profile left by the failed browser');
});
