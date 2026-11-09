'use strict';
// VER15: markdownExport.showProFeatures = false hides the Pro extra and every Zovo Pro command (menus and palette).
const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

test('showProFeatures setting exists, default true', () => {
  const p = pkg.contributes.configuration.properties['markdownExport.showProFeatures'];
  assert.equal(p.type, 'boolean');
  assert.equal(p.default, true);
});

test('Pro commands and the merge menu entry are hidden when showProFeatures is off', () => {
  const pal = pkg.contributes.menus.commandPalette;
  for (const c of ['exportFolderMergedPdf', 'getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) {
    const e = pal.find((m) => m.command === `markdownExport.${c}`);
    assert.ok(e && /config\.markdownExport\.showProFeatures/.test(e.when), c);
  }
  const ex = pkg.contributes.menus['explorer/context'].find((m) => m.command === 'markdownExport.exportFolderMergedPdf');
  assert.match(ex.when, /config\.markdownExport\.showProFeatures/);
});

test('price text is USD 19 everywhere, never USD 15', () => {
  const fs = require('fs'); const path = require('path');
  for (const f of ['package.json', 'README.md', 'src/pro.js', 'src/license/sponsors.js', 'src/license/index.js']) {
    const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(t, /USD 15/, f);
  }
});
