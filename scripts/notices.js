// Writes THIRD-PARTY-NOTICES.md from the packages esbuild bundles plus the shipped fonts and Mermaid.
const fs = require('fs'); const path = require('path'); const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
(async () => {
  const r = await esbuild.build({ entryPoints: [path.join(root, 'src/extension.js'), path.join(root, 'src/core/worker.js')], bundle: true, platform: 'node', external: ['vscode'], write: false, metafile: true, outdir: '/tmp/zovo-notices' });
  const pk = new Set();
  for (const f of Object.keys(r.metafile.inputs)) { const m = /node_modules\/((@[^/]+\/)?[^/]+)/.exec(f); if (m) pk.add(m[1]); }
  let out = '# Third-party notices\n\nMarkdown Export bundles these open-source packages. Each keeps its own licence.\n\n';
  for (const name of [...pk].sort()) {
    const dir = path.join(root, 'node_modules', name);
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const lic = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
    out += `## ${name} ${p.version} (${p.license || 'see file'})\n\n`;
    if (lic) out += '```\n' + fs.readFileSync(path.join(dir, lic), 'utf8').trim() + '\n```\n\n';
  }
  out += '## Mermaid 12.3.0 (MIT), media/vendor/mermaid.min.js\n\n```\n' + fs.readFileSync(path.join(root, 'media/vendor/mermaid.LICENSE'), 'utf8').trim() + '\n```\n\n';
  out += '## KaTeX fonts (SIL Open Font License 1.1), media/katex/fonts and media/fonts/KaTeX_Typewriter-Regular.ttf\n\nCopyright (c) 2009-2010 Design Science, Inc. Copyright (c) 2014-2018 Khan Academy. Licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org).\n\n';
  out += '## Roboto (Apache License 2.0), media/fonts/Roboto-*.ttf\n\nCopyright 2011 Google Inc. Licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).\n';
  fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), out);
  console.log('packages:', pk.size);
})();
