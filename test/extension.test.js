'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const src = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');

test('package: engines floor for Cursor and Windsurf, id, name', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.name, 'zovo-markdown-export');
  for (const w of ['Markdown', 'PDF', 'Word', 'DOCX', 'HTML', 'Export']) assert.ok(pkg.displayName.includes(w), w);
  assert.ok(pkg.displayName.length <= 100);
});

test('package: every command the code registers is declared, and the other way round', () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const code = src('extension.js');
  const registered = new Set([...code.matchAll(/reg\('([A-Za-z]+)'/g)].map((m) => `markdownExport.${m[1]}`));
  for (const c of ['supportDeveloper', 'moreViewers', 'getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense', 'payWithPayPal']) registered.add(`markdownExport.${c}`);
  for (const c of registered) assert.ok(declared.has(c), `declared: ${c}`);
  for (const c of declared) assert.ok(registered.has(c), `registered: ${c}`);
  const menuCmds = Object.values(pkg.contributes.menus).flat().map((m) => m.command).filter(Boolean);
  for (const c of menuCmds) assert.ok(declared.has(c), `menu command exists: ${c}`);
});

test('package: settings in code exist in package.json', () => {
  const props = pkg.contributes.configuration.properties;
  const code = src('extension.js');
  const keys = new Set([...code.matchAll(/'(pageSize|landscape|margin|header|footer|toc|fontSize|breaks|allowRemoteImages|htmlTheme|mermaidTheme|fallbackFont|docxTemplate|coverPage|browserPath|pdfEngine|outputFolder|openAfterExport|maxFileMB)'/g)].map((m) => m[1]));
  for (const k of keys) assert.ok(props[`markdownExport.${k}`], k);
  assert.equal(props['markdownExport.allowRemoteImages'].default, false);
  assert.ok(props['markdownExport.askForRating']);
  assert.ok(props['markdownExport.showSupportLinks']);
});

test('no network code outside the Sponsors unlock', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(ROOT, 'src'));
  for (const f of files) {
    if (f.endsWith(path.join('license', 'sponsors.js'))) continue;
    const s = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /require\(['"](https?|net|tls|dgram|dns)['"]\)|\bfetch\(|XMLHttpRequest|WebSocket\(/, path.relative(ROOT, f));
  }
});

test('license module is MODULE_VERSION 2026-11-10.exec14, files unchanged (sha256 from out/EXEC14-module-ready.txt)', () => {
  const crypto = require('crypto');
  const want = {
    'index.js': '075c4ef3c16b39723d129367cd9a034ac9112cefd9f7c60bbdad708f7ebadd3e',
    'license.js': 'c7085eb8137baa256aa55547227230e7eabc4f32b2ce0e717565755dc905afdf',
    'sponsors.js': 'd74681177ce4be80005a1057815cf65db0b5325f83a14e4d22335e8e1622c1f4',
    'gumroad.js': 'c42ac8513374b123212b0379bb7653cce1ffc0ddf7523152a1764d15d2ba1d90',
  };
  for (const [f, h] of Object.entries(want)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src', 'license', f))).digest('hex'), h, f);
  }
  assert.equal(require('../src/license').MODULE_VERSION, '2026-11-10.exec14');
});

// ---- Pro tries with a fake VS Code ----------------------------------------------------------------------------------
process.env.ZOVO_PRO_FILE = process.env.ZOVO_PRO_FILE || path.join(require('os').tmpdir(), `mdexport-no-pro-${process.pid}`, 'pro.json');
function fakeVscode(answers) {
  const shown = [];
  const commands = new Map();
  const vscode = {
    window: {
      showInformationMessage: async (msg, ...rest) => { const opts = rest[0] && typeof rest[0] === 'object' ? rest.shift() : {}; shown.push({ msg, opts, rest }); return answers.shift(); },
      showWarningMessage: async (msg, ...rest) => { shown.push({ msg, rest }); return undefined; },
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      onDidChangeWindowState: () => ({ dispose() {} }),
      state: { focused: true },
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, getCommands: async () => [] },
    env: { appName: 'Visual Studio Code', uriScheme: 'vscode', openExternal: async (u) => { shown.push({ open: String(u) }); return true; } },
    Uri: { parse: (s) => s },
    extensions: { all: [], getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    authentication: { getSession: async () => undefined },
    EventEmitter: class { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { for (const f of this.l) f(v); } dispose() {} },
  };
  const store = new Map();
  const context = {
    globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); }, keys: () => [...store.keys()], setKeysForSync() {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
    subscriptions: [],
  };
  return { vscode, context, shown, commands };
}

test('pro: allowed() never uses a try; produced() counts one; 3 tries, then one panel; nothing on activation', async () => {
  const { createPro, TOOLS } = require('../src/pro');
  assert.deepEqual(TOOLS, ['Merge a folder into one PDF', 'Word template', 'Cover page']);
  const f = fakeVscode([undefined]);
  const pro = createPro({ vscode: f.vscode, context: f.context });
  assert.equal(f.shown.length, 0, 'no popup on activation');
  assert.equal(await pro.allowed('merge'), true);
  assert.equal(await pro.allowed('merge'), true);
  assert.equal(pro.triesLeft('merge'), 3, 'starting a tool (then Escape) uses nothing');
  for (let i = 1; i <= 3; i++) {
    assert.equal(await pro.allowed('merge'), true);
    assert.match(await pro.produced('merge'), new RegExp(`free try ${i} of 3 used`));
  }
  assert.equal(f.shown.length, 0);
  assert.equal(await pro.allowed('merge'), false);
  assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].msg, 'Merge a folder into one PDF is part of Zovo Pro.');
  assert.deepEqual(f.shown[0].rest.slice(0, 3), ['Get Zovo Pro, USD 19', 'Pay with PayPal', 'I already paid']);
  assert.match(f.shown[0].opts.detail, /Word template and Cover page here/);
  // other features keep their own tries
  assert.equal(await pro.allowed('cover'), true);
  assert.equal(pro.triesLeft('cover'), 3);
  for (const c of ['markdownExport.getPro', 'markdownExport.payWithPayPal', 'markdownExport.unlockWithSponsors', 'markdownExport.enterLicenseKey', 'markdownExport.removeLicense']) assert.ok(f.commands.has(c), c);
});

test('pro: Get Zovo Pro from the panel opens only the USD 19 Sponsors tier', async () => {
  const { createPro } = require('../src/pro');
  const f = fakeVscode(['Get Zovo Pro, USD 19']);
  const pro = createPro({ vscode: f.vscode, context: f.context });
  for (let i = 0; i < 3; i++) await pro.produced('template');
  assert.equal(await pro.allowed('template'), false);
  const opened = f.shown.filter((x) => x.open);
  assert.deepEqual(opened.map((o) => o.open), ['https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878']);
});

test('pro: a licensed user never sees a panel and uses no tries', async () => {
  const { createPro } = require('../src/pro');
  const f = fakeVscode([]);
  const fakeLic = { ready: Promise.resolve(), isPro: () => true, refresh: async () => false, requirePro: async () => { throw new Error('no panel'); } };
  const pro = createPro({ vscode: f.vscode, context: f.context, license: fakeLic });
  for (let i = 0; i < 5; i++) { assert.equal(await pro.allowed('cover'), true); assert.equal(await pro.produced('cover'), ''); }
  assert.equal(pro.triesLeft('cover'), 3);
});

test('package: display name starts with the measured phrase "Markdown to PDF"; no rival full name alone', () => {
  assert.ok(pkg.displayName.startsWith('Markdown to PDF '), pkg.displayName);
  assert.ok(pkg.description.startsWith('Markdown to PDF'), pkg.description);
  assert.ok(!/^Markdown PDF\b/.test(pkg.displayName));
  assert.ok(!pkg.displayName.includes('Markdown to PDF & Word'), 'not another listing\'s full name');
  for (const k of ['markdown to pdf', 'markdown to word', 'markdown to docx', 'markdown to html', 'md to pdf']) assert.ok(pkg.keywords.includes(k), k);
  assert.equal(pkg.version, '0.1.1');
});
