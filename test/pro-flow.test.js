'use strict';
// The extension host with a stub vscode: activation shows nothing and makes no network call; each Pro tool (cover
// page, Word template, merge a folder into one PDF) counts a free try only after a saved file used it, one try per
// run; Escape and failures keep the try; the 4th use shows the Zovo Pro panel once; Cancel still exports the free part.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdexport-flow-'));
process.env.ZOVO_PRO_FILE = path.join(tmp, 'no-zovo', 'pro.json'); // never the real ~/.zovo/pro.json
const { loadExtension } = require('./support/vscode-stub');
const { TRIES_KEY } = require('../src/pro');

const ws = path.join(tmp, 'ws');
const w = (rel, text) => { const p = path.join(ws, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const COVER = w('docs/report.md', '---\ntitle: Quarterly report\nsubtitle: Q3\nauthor: Docs team\ncover: true\n---\n# Results\n\nSales went up.\n');
const PLAIN = w('docs/plain.md', '# Plain\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
w('docs/sub/more.md', '# More\n\nSecond file.\n');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const tries = (s) => s.state.get(TRIES_KEY) || {};
const panels = (s) => s.log.info.filter((m) => /is part of Zovo Pro\./.test(m.text));

function trapNetwork() {
  const calls = [];
  const saved = { fetch: global.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection };
  global.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in test'); };
  http.request = http.get = https.request = https.get = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].host || a[0]))); throw new Error('network blocked in test'); };
  net.connect = net.createConnection = (...a) => { calls.push('net ' + JSON.stringify(a[0])); throw new Error('network blocked in test'); };
  return { calls, restore: () => { global.fetch = saved.fetch; http.request = saved.hr; http.get = saved.hg; https.request = saved.sr; https.get = saved.sg; net.connect = saved.nc; net.createConnection = saved.ncc; } };
}

function start() {
  const s = loadExtension({ workspace: ws });
  s.config.askForRating = false;
  s.config.pdfEngine = 'builtin'; // no browser in unit tests
  s.config.openAfterExport = 'notify';
  s.ext.activate(s.context);
  return s;
}
const cmd = (s, id, ...a) => s.commands.get(`markdownExport.${id}`)(...a);
const clean = () => { for (const f of fs.readdirSync(path.join(ws, 'docs'))) if (/\.(pdf|docx|html)$/.test(f)) fs.rmSync(path.join(ws, 'docs', f)); };

test('activation: commands registered, no message, no network call', async () => {
  const nw = trapNetwork();
  const s = start();
  try {
    for (const c of ['exportPdf', 'exportDocx', 'exportHtml', 'exportAll', 'exportFolder', 'exportFolderMergedPdf', 'openSample', 'getPro', 'payWithPayPal', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) assert.ok(s.commands.has(`markdownExport.${c}`), c);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual([s.log.info.length, s.log.warn.length, s.log.error.length, s.log.status.length], [0, 0, 0, 0]);
    assert.deepEqual(nw.calls, []);
    assert.deepEqual(s.log.external, []);
  } finally { nw.restore(); s.restore(); }
});

test('cover page: one try per run, counted after the file is saved; a failed run keeps the try', async () => {
  const s = start();
  try {
    clean();
    await cmd(s, 'exportHtml', s.vscode.Uri.file(path.join(ws, 'docs', 'missing.md')));
    assert.equal(tries(s).cover, undefined, 'a failed export uses no try');
    await cmd(s, 'exportAll', s.vscode.Uri.file(COVER));
    for (const ext of ['pdf', 'docx', 'html']) assert.ok(fs.existsSync(COVER.replace(/\.md$/, `.${ext}`)), ext);
    assert.equal(tries(s).cover, 1, 'PDF, Word and HTML in one run use one try');
    assert.match(fs.readFileSync(COVER.replace(/\.md$/, '.html'), 'utf8'), /Quarterly report/);
    assert.match(fs.readFileSync(COVER.replace(/\.md$/, '.html'), 'utf8'), /class="[^"]*cover/);
    assert.ok(s.log.status.some((t) => /Cover page is Zovo Pro: free try 1 of 3 used, 2 left\./.test(t)));
    assert.ok(s.log.info.some((m) => /Saved|3 files saved/.test(m.text) && /free try 1 of 3/.test(m.text)), 'the result message names the try');
    assert.equal(panels(s).length, 0);
    // a file without cover uses nothing
    await cmd(s, 'exportHtml', s.vscode.Uri.file(PLAIN));
    assert.equal(tries(s).cover, 1);
  } finally { s.restore(); }
});

test('cover page: after 3 tries one panel per run; Cancel still exports without the cover', async () => {
  const s = start();
  try {
    clean();
    for (let i = 1; i <= 3; i++) { await cmd(s, 'exportHtml', s.vscode.Uri.file(COVER)); assert.equal(tries(s).cover, i); }
    assert.equal(panels(s).length, 0, 'no panel while tries are left');
    fs.rmSync(COVER.replace(/\.md$/, '.html'));
    await cmd(s, 'exportAll', s.vscode.Uri.file(COVER)); // Cancel (no answer)
    assert.equal(panels(s).length, 1, 'one panel for the whole run');
    const p = panels(s)[0];
    assert.equal(p.text, 'Cover page is part of Zovo Pro.');
    assert.equal(p.opts.modal, true);
    assert.deepEqual(p.buttons.slice(0, 3), ['Get Zovo Pro, USD 19', 'Pay with PayPal', 'I already paid']);
    assert.match(p.opts.detail, /You used the 3 free tries/);
    assert.match(p.opts.detail, /Merge a folder into one PDF/);
    assert.match(p.opts.detail, /Word template/);
    assert.ok(!/refund/i.test(p.opts.detail));
    assert.ok(!p.buttons.includes('Pay by card'));
    assert.match(p.opts.detail, /USD 19/);
    assert.doesNotMatch(p.opts.detail, /USD 15/);
    const html = fs.readFileSync(COVER.replace(/\.md$/, '.html'), 'utf8');
    assert.doesNotMatch(html, /class="[^"]*\bcover\b/, 'no cover after Cancel');
    assert.ok(s.log.warn.some((m) => /Cover page skipped \(Pro\)/.test(m.text)) || s.log.info.some((m) => /Cover page skipped/.test(m.text)));
    assert.equal(tries(s).cover, 3);
  } finally { s.restore(); }
});

test('Get Zovo Pro in the panel opens the USD 19 tier only', async () => {
  const s = start();
  try {
    s.state.set(TRIES_KEY, { cover: 3 });
    s.ui.info.push('Get Zovo Pro, USD 19');
    await cmd(s, 'exportHtml', s.vscode.Uri.file(COVER));
    assert.deepEqual(s.log.external.filter((u) => /github\.com\/sponsors/.test(u)), ['https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878']);
  } finally { s.restore(); }
});

test('merge a folder into one PDF: Escape keeps the try, each merged PDF uses one, the 4th click shows the panel first', async () => {
  const s = start();
  try {
    const out = path.join(ws, 'ws.pdf');
    s.ui.quick.push(undefined); // Escape on the folder pick
    await cmd(s, 'exportFolderMergedPdf');
    assert.equal(tries(s).merge, undefined);
    for (let i = 1; i <= 3; i++) {
      fs.rmSync(out, { force: true });
      s.ui.quick.push((items) => items[0]); // the workspace folder
      await cmd(s, 'exportFolderMergedPdf');
      assert.ok(fs.existsSync(out), `merged PDF ${i}`);
      assert.equal(fs.readFileSync(out).subarray(0, 5).toString(), '%PDF-');
      assert.equal(tries(s).merge, i);
    }
    const q = s.log.quick[1];
    assert.match(q.items[0].label, /ws$/);
    assert.ok(q.items.some((it) => /docs$/.test(it.label) && /2 Markdown files here/.test(it.description)));
    assert.ok(q.items.some((it) => /sub$/.test(it.label)));
    assert.match(q.items.at(-1).label, /Choose another folder/);
    fs.rmSync(out);
    const picks = s.log.quick.length;
    await cmd(s, 'exportFolderMergedPdf'); // no tries left: the panel, before any folder pick
    assert.equal(panels(s).length, 1);
    assert.equal(panels(s)[0].text, 'Merge a folder into one PDF is part of Zovo Pro.');
    assert.equal(s.log.quick.length, picks, 'no folder pick after Cancel');
    assert.ok(!fs.existsSync(out));
  } finally { s.restore(); }
});

test('Word template: a try only when the template is used for a saved Word file', async () => {
  const s = start();
  try {
    clean();
    await cmd(s, 'exportDocx', s.vscode.Uri.file(PLAIN)); // a free Word file to use as the template
    const tpl = path.join(tmp, 'template.docx');
    fs.copyFileSync(PLAIN.replace(/\.md$/, '.docx'), tpl);
    s.config.docxTemplate = tpl;
    await cmd(s, 'exportHtml', s.vscode.Uri.file(PLAIN));
    assert.equal(tries(s).template, undefined, 'HTML does not use the template');
    await cmd(s, 'exportDocx', s.vscode.Uri.file(PLAIN));
    assert.equal(tries(s).template, 1);
    s.config.docxTemplate = path.join(tmp, 'nope.docx');
    await cmd(s, 'exportDocx', s.vscode.Uri.file(PLAIN));
    assert.equal(tries(s).template, 1, 'a missing template uses no try');
  } finally { s.restore(); }
});

test('folder export (free): the quick pick lists the folders, no Pro try, no panel', async () => {
  const s = start();
  try {
    clean();
    s.ui.quick.push((items) => items.find((it) => /docs$/.test(it.label)));
    s.ui.quick.push((items) => items.filter((it) => it.f === 'html'));
    await cmd(s, 'exportFolder');
    assert.ok(fs.existsSync(path.join(ws, 'docs', 'plain.html')));
    assert.ok(fs.existsSync(path.join(ws, 'docs', 'sub', 'more.html')));
    assert.equal(tries(s).merge, undefined);
    assert.equal(panels(s).length, 0);
  } finally { s.restore(); }
});

test('walkthrough sample: copied to the extension storage and opened; exports land there', async () => {
  const s = start();
  try {
    await cmd(s, 'openSample');
    const doc = s.log.opened[0];
    assert.ok(doc.uri.fsPath.startsWith(s.gs), 'opened from global storage');
    assert.ok(fs.existsSync(path.join(s.gs, 'sample', 'zovo-logo.png')));
    await cmd(s, 'exportHtml', doc.uri);
    const html = fs.readFileSync(path.join(s.gs, 'sample', 'release-notes.html'), 'utf8');
    assert.match(html, /Release notes 2\.4/);
    assert.match(html, /<table/);
    assert.match(html, /katex/);
    assert.match(html, /data:image\/png;base64/);
    assert.equal(s.log.error.length, 0);
  } finally { s.restore(); }
});
