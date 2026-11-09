// Bundles src/extension.js into dist/extension.js and copies the runtime assets into media/.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const media = path.join(root, 'media');

function copyAssets() {
  // KaTeX: the CSS with woff2 fonts only (every current browser and VS Code read woff2)
  const kOut = path.join(media, 'katex');
  fs.rmSync(kOut, { recursive: true, force: true });
  fs.mkdirSync(path.join(kOut, 'fonts'), { recursive: true });
  let css = fs.readFileSync(path.join(nm, 'katex/dist/katex.min.css'), 'utf8');
  css = css.replace(/,\s*url\(fonts\/[^)]+\.(woff|ttf)\)\s*format\("(woff|truetype)"\)/g, '');
  fs.writeFileSync(path.join(kOut, 'katex.min.css'), css);
  for (const f of fs.readdirSync(path.join(nm, 'katex/dist/fonts'))) {
    if (f.endsWith('.woff2')) fs.copyFileSync(path.join(nm, 'katex/dist/fonts', f), path.join(kOut, 'fonts', f));
  }
  // Roboto for the built-in PDF engine
  const fOut = path.join(media, 'fonts');
  fs.mkdirSync(fOut, { recursive: true });
  for (const f of ['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Italic.ttf', 'Roboto-MediumItalic.ttf']) {
    fs.copyFileSync(path.join(nm, 'pdfmake/fonts/Roboto', f), path.join(fOut, f));
  }
  fs.copyFileSync(path.join(nm, 'katex/dist/fonts/KaTeX_Typewriter-Regular.ttf'), path.join(fOut, 'KaTeX_Typewriter-Regular.ttf'));
  if (!fs.existsSync(path.join(media, 'vendor', 'mermaid.min.js'))) throw new Error('media/vendor/mermaid.min.js is missing (scripts/fetch-mermaid.sh)');
}

async function main() {
  const production = process.argv.includes('--production');
  copyAssets();
  await esbuild.build({
    entryPoints: { extension: path.join(root, 'src/extension.js'), worker: path.join(root, 'src/core/worker.js') },
    bundle: true,
    outdir: path.join(root, 'dist'),
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    legalComments: 'linked',
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
