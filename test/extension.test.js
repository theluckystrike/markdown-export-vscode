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
  for (const c of ['supportDeveloper', 'moreViewers', 'getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) registered.add(`markdownExport.${c}`);
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

test('license files are the factory copies', () => {
  const factory = path.join(ROOT, '..', '..', 'sprint', 'license');
  if (!fs.existsSync(factory)) return;
  for (const f of ['index.js', 'license.js', 'sponsors.js']) {
    assert.equal(fs.readFileSync(path.join(ROOT, 'src', 'license', f), 'utf8'), fs.readFileSync(path.join(factory, f), 'utf8'), f);
  }
});

// ---- Pro gate with a fake VS Code ------------------------------------------------------------------------------------
function fakeVscode(answers) {
  const shown = [];
  const commands = new Map();
  const vscode = {
    window: {
      showInformationMessage: async (msg, ...rest) => { shown.push({ msg, rest }); return answers.shift(); },
      showWarningMessage: async (msg, ...rest) => { shown.push({ msg, rest }); return undefined; },
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
    env: { openExternal: async (u) => { shown.push({ open: String(u) }); return true; } },
    Uri: { parse: (s) => s },
    authentication: { getSession: async () => undefined },
    EventEmitter: class { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { for (const f of this.l) f(v); } },
  };
  const store = new Map();
  const context = {
    globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); }, keys: () => [...store.keys()], setKeysForSync() {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
    subscriptions: [],
  };
  return { vscode, context, shown, commands };
}

test('pro: 3 free tries per feature, then one modal; nothing shown on activation', async () => {
  const { createPro } = require('../src/pro');
  const f = fakeVscode([undefined]);
  const pro = createPro({ vscode: f.vscode, context: f.context });
  assert.equal(f.shown.length, 0, 'no popup on activation');
  for (let i = 1; i <= 3; i++) {
    const g = await pro.gate('merge');
    assert.equal(g.ok, true);
    assert.match(g.note, new RegExp(`free try ${i} of 3`));
  }
  assert.equal(f.shown.length, 0);
  const g4 = await pro.gate('merge');
  assert.equal(g4.ok, false);
  assert.equal(f.shown.length, 1);
  assert.match(f.shown[0].msg, /Merge a folder into one PDF is part of Zovo Pro/);
  assert.ok(f.shown[0].rest.includes('Unlock with GitHub Sponsors'));
  // other features keep their own tries
  assert.equal((await pro.gate('cover')).ok, true);
  assert.equal(pro.triesLeft('cover'), 2);
  for (const c of ['markdownExport.getPro', 'markdownExport.unlockWithSponsors', 'markdownExport.enterLicenseKey', 'markdownExport.removeLicense']) assert.ok(f.commands.has(c), c);
});

test('pro: Get Zovo Pro from the modal opens only the Sponsors page', async () => {
  const { createPro } = require('../src/pro');
  const f = fakeVscode([]);
  const pro = createPro({ vscode: f.vscode, context: f.context });
  for (let i = 0; i < 3; i++) await pro.gate('template');
  f.vscode.window.showInformationMessage = async (msg, opts, ...buttons) => { f.shown.push({ msg, buttons }); return buttons.find((b) => /^Get /.test(b)); };
  const g = await pro.gate('template');
  assert.equal(g.ok, false);
  const opened = f.shown.filter((x) => x.open);
  assert.equal(opened.length, 1);
  assert.match(opened[0].open, /^https:\/\/github\.com\/sponsors\/theluckystrike/);
});
