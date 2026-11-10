'use strict';
// Markdown to PDF & Markdown to Word: PDF, Word (DOCX) and HTML from Markdown, with the browser the user already has.
// No download, no telemetry, no network (unless the user turns on remote images, or clicks Unlock with GitHub Sponsors).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ExportSession, mergeMarkdown } = require('./core/exporter');
const { findBrowser } = require('./core/chrome');
const { findUnicodeFont } = require('./core/pdffallback');
const { buildPage } = require('./core/html');
const { resolveOptions } = require('./core/options');
const { splitFrontMatter } = require('./core/frontmatter');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createPro } = require('./pro');

const PREFIX = 'markdownExport';
const EXT_ID = 'zovo.zovo-markdown-export';
const MD_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;
const FORMATS = { pdf: 'PDF', docx: 'Word (DOCX)', html: 'HTML' };
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

let rating = { success() {}, failure() {} };
let out;
let pro;
let ctx;

function cfg() { return vscode.workspace.getConfiguration(PREFIX); }

function settings(uri) {
  const c = vscode.workspace.getConfiguration(PREFIX, uri);
  const keys = ['pageSize', 'landscape', 'margin', 'header', 'footer', 'toc', 'fontSize', 'breaks', 'allowRemoteImages', 'htmlTheme', 'mermaidTheme', 'fallbackFont', 'docxTemplate', 'coverPage'];
  const s = {};
  for (const k of keys) s[k] = c.get(k);
  s.pageNumbers = true;
  if (!vscode.workspace.isTrusted) { // workspace values of these are ignored in an untrusted folder
    const i = c.inspect('docxTemplate'); s.docxTemplate = (i && i.globalValue) || '';
  }
  return s;
}

function log(line) { out.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`); }

function newSession(uri) {
  const c = vscode.workspace.getConfiguration(PREFIX, uri);
  return new ExportSession({
    assetsDir: path.join(ctx.extensionPath, 'media'),
    fontsDir: path.join(ctx.extensionPath, 'media', 'fonts'),
    settings: settings(uri),
    browserPath: c.get('browserPath') || '',
    engine: c.get('pdfEngine') || 'auto',
  });
}

// ---- reading the source ---------------------------------------------------------------------------------------
async function readSource(uri, { confirmLarge = true } = {}) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return { text: open.getText(), docPath: uri.scheme === 'file' ? uri.fsPath : undefined, untitled: open.isUntitled, name: path.basename(uri.path) };
  if (uri.scheme !== 'file') {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { text: Buffer.from(bytes).toString('utf8'), docPath: undefined, name: path.basename(uri.path) };
  }
  const st = fs.statSync(uri.fsPath);
  const maxMb = Number(cfg().get('maxFileMB')) || 50;
  if (confirmLarge && st.size > maxMb * 1048576) {
    const mb = (st.size / 1048576).toFixed(1);
    const pick = await vscode.window.showWarningMessage(`${path.basename(uri.fsPath)} is ${mb} MB, more than the ${maxMb} MB limit. Exporting it can take minutes and a lot of memory.`, { modal: true }, 'Export Anyway');
    if (pick !== 'Export Anyway') return null;
  }
  return { text: await fs.promises.readFile(uri.fsPath, 'utf8'), docPath: uri.fsPath, name: path.basename(uri.fsPath) };
}

function expandVars(p, docPath) {
  const wf = docPath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(docPath)) : (vscode.workspace.workspaceFolders || [])[0];
  return p.replace(/\$\{workspaceFolder\}/g, wf ? wf.uri.fsPath : '').replace(/\$\{fileDirname\}/g, docPath ? path.dirname(docPath) : '')
    .replace(/^~(?=$|[\\/])/, require('os').homedir());
}

async function outputPath(src, ext, suffix = '') {
  const base = (src.docPath ? path.basename(src.docPath) : src.name || 'Untitled').replace(/\.[^.]+$/, '') + suffix;
  if (!src.docPath) {
    const def = vscode.Uri.file(path.join(((vscode.workspace.workspaceFolders || [])[0] || { uri: { fsPath: require('os').homedir() } }).uri.fsPath, `${base}.${ext}`));
    const u = await vscode.window.showSaveDialog({ defaultUri: def, filters: { [FORMATS[ext]]: [ext] } });
    return u ? u.fsPath : null;
  }
  let dir = path.dirname(src.docPath);
  const setting = String(vscode.workspace.getConfiguration(PREFIX, vscode.Uri.file(src.docPath)).get('outputFolder') || '').trim();
  if (setting && (vscode.workspace.isTrusted || vscode.workspace.getConfiguration(PREFIX).inspect('outputFolder').globalValue === setting)) {
    const p = expandVars(setting, src.docPath);
    dir = path.isAbsolute(p) ? p : path.resolve(dir, p);
  }
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${base}.${ext}`);
}

// ---- Pro extras for one file ------------------------------------------------------------------------------------
// run = { decided: {feature: boolean} } lives for one export run: the panel shows at most once per run and per tool,
// and a free try is counted after the run saved at least one file that used the tool (runExports).
async function proFor(src, uri, kind, run) {
  const s = settings(uri);
  const fm = splitFrontMatter(src.text);
  const o = resolveOptions(s, fm.data);
  const res = { cover: false, template: '', notes: [], uses: [] };
  const decide = async (f) => {
    if (!(f in run.decided)) run.decided[f] = await pro.allowed(f);
    return run.decided[f];
  };
  if (o.cover) {
    if (await decide('cover')) { res.cover = true; res.uses.push('cover'); } else res.notes.push('Cover page skipped (Pro).');
  }
  if (kind === 'docx' && o.docxTemplate) {
    let t = expandVars(o.docxTemplate, src.docPath);
    if (!path.isAbsolute(t) && src.docPath) t = path.resolve(path.dirname(src.docPath), t);
    if (!fs.existsSync(t)) res.notes.push(`Word template not found: ${t}`);
    else if (await decide('template')) { res.template = t; res.uses.push('template'); } else res.notes.push('Word template skipped (Pro).');
  }
  return res;
}

// ---- running exports ---------------------------------------------------------------------------------------------
/**
 * jobs: [{ uri, src?, formats: ['pdf','docx','html'], suffix?, title? }]
 * Returns the list of results. One browser serves all jobs.
 */
async function runExports(jobs, title, proRun) {
  const results = [];
  const run = { decided: {}, ...(proRun || {}) };
  const first = jobs[0] && jobs[0].uri;
  const session = newSession(first);
  const total = jobs.reduce((n, j) => n + j.formats.length, 0);
  let failed = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
    token.onCancellationRequested(() => session.kill());
    let done = 0;
    for (const job of jobs) {
      if (token.isCancellationRequested) break;
      let src = job.src;
      try { if (!src) src = await readSource(job.uri, { confirmLarge: jobs.length === 1 }); } catch (e) { failed++; log(`Could not read ${job.uri.fsPath}: ${e.message}`); results.push({ uri: job.uri, error: e.message }); continue; }
      if (!src) continue;
      for (const kind of job.formats) {
        if (token.isCancellationRequested) break;
        const target = job.outPath || await outputPath(src, kind, job.suffix);
        if (!target) continue;
        progress.report({ message: `${path.basename(target)} (${++done} of ${total})`, increment: 100 / total });
        log(`Start ${FORMATS[kind]}: ${target}`);
        const t0 = Date.now();
        try {
          const proOpts = await proFor(src, job.uri, kind, run);
          const r = await session[kind]({ text: src.text, docPath: src.docPath, outPath: target, pro: proOpts, title: job.title, frontMatter: job.frontMatter });
          r.ms = Date.now() - t0; r.outPath = target; r.kind = kind; r.uri = job.uri; r.notes = proOpts.notes;
          r.proUses = proOpts.uses.filter((f) => !(f === 'template' && r.templateUsed === false)); // a template that could not be read uses no try
          results.push(r);
          log(`${FORMATS[kind]}: ${target} (${(r.bytes / 1024).toFixed(0)} KB, ${r.engine === 'browser' && kind === 'pdf' ? r.browser : 'built-in engine'}, ${r.ms} ms)`);
          for (const w of [...r.warnings, ...r.notes]) log(`  note: ${w}`);
        } catch (e) {
          if (token.isCancellationRequested) break;
          failed++;
          results.push({ uri: job.uri, kind, outPath: target, error: e.message });
          log(`${FORMATS[kind]} failed for ${src.docPath || src.name}: ${e.stack || e.message}`);
        }
      }
    }
  }).then(undefined, (e) => log(`Export stopped: ${e.message}`));
  await session.close();
  const ok = results.filter((r) => !r.error);
  // A Pro try counts only now, after a saved file used the tool; one try per tool and run.
  const usedTools = [...new Set([...(run.extraUses || []), ...ok.flatMap((r) => r.proUses || [])])];
  for (const f of ok.length ? usedTools : []) {
    const note = await pro.produced(f);
    if (note) { ok[0].proNotes = [...(ok[0].proNotes || []), note]; log(`  note: ${note}`); vscode.window.setStatusBarMessage(note, 8000); }
  }
  if (ok.length && !failed) {
    // one success per exported source file; the rating module ignores repeats inside one session
    rating.success(jobs[0].uri);
  } else if (failed) rating.failure();
  return results;
}

async function report(results, label) {
  const ok = results.filter((r) => !r.error);
  const bad = results.filter((r) => r.error);
  if (!ok.length && !bad.length) return;
  if (bad.length) {
    const msg = bad.length === 1 ? `Export failed: ${bad[0].error}` : `${bad.length} exports failed. ${ok.length} worked.`;
    const pick = await vscode.window.showErrorMessage(msg, 'Show Details', ...(bad.some((b) => /browser|Chrome|Edge/i.test(b.error)) ? ['Use Built-in Engine'] : []));
    if (pick === 'Show Details') out.show(true);
    if (pick === 'Use Built-in Engine') await cfg().update('pdfEngine', 'builtin', vscode.ConfigurationTarget.Global);
    return;
  }
  const mode = cfg().get('openAfterExport') || 'notify';
  const warnings = [...new Set(ok.flatMap((r) => [...r.warnings, ...(r.notes || [])]))];
  if (mode === 'open' && ok.length === 1) { await vscode.env.openExternal(vscode.Uri.file(ok[0].outPath)); return; }
  if (mode === 'none') return;
  const one = ok.length === 1 ? ok[0] : null;
  const engine = ok.find((r) => r.kind === 'pdf');
  const how = engine ? (engine.engine === 'browser' ? ` with ${engine.browser}` : ' with the built-in engine') : '';
  let msg = one ? `Saved ${path.basename(one.outPath)}${how}.` : `${label || 'Exported'}: ${ok.length} files saved${how}.`;
  if (warnings.length) msg += ` ${warnings.length === 1 ? warnings[0] : `${warnings.length} notes in the output.`}`;
  const proNotes = ok.flatMap((r) => r.proNotes || []);
  if (proNotes.length) msg += ` ${proNotes.join(' ')}`;
  const buttons = one ? ['Open', 'Show in Folder'] : ['Show in Folder'];
  if (warnings.length > 1) buttons.push('Show Notes');
  const pick = await (warnings.length ? vscode.window.showWarningMessage(msg, ...buttons) : vscode.window.showInformationMessage(msg, ...buttons));
  if (pick === 'Open') await vscode.env.openExternal(vscode.Uri.file(one.outPath));
  if (pick === 'Show in Folder') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(ok[0].outPath));
  if (pick === 'Show Notes') out.show(true);
}

function targetUri(arg) {
  if (arg instanceof vscode.Uri) return arg;
  if (arg && arg.uri instanceof vscode.Uri) return arg.uri; // editor title context passes {uri}
  const ed = vscode.window.activeTextEditor;
  if (ed && (ed.document.languageId === 'markdown' || MD_EXT.test(ed.document.fileName))) return ed.document.uri;
  if (currentPreview && currentPreview.uri) return currentPreview.uri;
  return null;
}

async function exportCommand(formats, arg, list) {
  let uris = Array.isArray(list) && list.length > 1 ? list.filter((u) => MD_EXT.test(u.path)) : [targetUri(arg)].filter(Boolean);
  if (!uris.length) {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { Markdown: ['md', 'markdown', 'mdown', 'mkd'] }, openLabel: 'Export' });
    if (!pick || !pick.length) return;
    uris = pick;
  }
  const label = formats.map((f) => FORMATS[f]).join(', ');
  const results = await runExports(uris.map((uri) => ({ uri, formats })), `Exporting to ${label}`);
  await report(results);
}

async function exportMenu(arg) {
  const uri = targetUri(arg);
  const items = [
    { label: '$(file-pdf) PDF', f: ['pdf'], description: engineLabel(uri) },
    { label: '$(file) Word (DOCX)', f: ['docx'] },
    { label: '$(globe) HTML', f: ['html'], description: 'one file, images inside' },
    { label: '$(files) PDF, Word and HTML', f: ['pdf', 'docx', 'html'] },
    { label: '$(open-preview) Open Export Preview', preview: true },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Export Markdown', placeHolder: uri ? path.basename(uri.path) : 'Pick a format' });
  if (!pick) return;
  if (pick.preview) return showPreview(uri);
  return exportCommand(pick.f, uri);
}

async function exportSelection() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) { vscode.window.showInformationMessage('Select some Markdown text first.'); return; }
  const pick = await vscode.window.showQuickPick([{ label: 'PDF', f: 'pdf' }, { label: 'Word (DOCX)', f: 'docx' }, { label: 'HTML', f: 'html' }], { title: 'Export the selection to' });
  if (!pick) return;
  const text = ed.selections.map((s) => ed.document.getText(s)).join('\n\n');
  const uri = ed.document.uri;
  const src = { text, docPath: uri.scheme === 'file' ? uri.fsPath : undefined, name: path.basename(uri.path) };
  const results = await runExports([{ uri, src, formats: [pick.f], suffix: '-selection' }], 'Exporting the selection');
  await report(results);
}

async function findMarkdown(folder, token) {
  const pattern = new vscode.RelativePattern(folder, '**/*.{md,markdown,mdown,mkd}');
  const uris = await vscode.workspace.findFiles(pattern, '{**/node_modules/**,**/.git/**,**/.venv/**,**/dist/**}', 2000, token);
  return uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath, undefined, { numeric: true, sensitivity: 'base' }));
}

// A folder from the Explorer menu, or a quick pick of the workspace folders and the folders that hold Markdown files
// (no native dialog needed); "Choose another folder..." opens the system dialog.
async function pickFolder(arg, verb = 'Export') {
  if (arg instanceof vscode.Uri) {
    try { if ((await vscode.workspace.fs.stat(arg)).type & vscode.FileType.Directory) return arg; } catch (e) { /* not a folder */ }
    return vscode.Uri.file(path.dirname(arg.fsPath));
  }
  const ws = vscode.workspace.workspaceFolders || [];
  const items = [];
  if (ws.length) {
    const seen = new Map();
    for (const w of ws) seen.set(w.uri.fsPath, { uri: w.uri, n: 0, root: true });
    let found = [];
    try { found = await vscode.workspace.findFiles('**/*.{md,markdown,mdown,mkd}', '{**/node_modules/**,**/.git/**,**/.venv/**,**/dist/**}', 2000); } catch (e) { /* none */ }
    for (const u of found) {
      const d = path.dirname(u.fsPath);
      if (!seen.has(d)) { if (seen.size >= 60) continue; seen.set(d, { uri: vscode.Uri.file(d), n: 0 }); }
      seen.get(d).n++;
    }
    const sorted = [...seen.values()].sort((a, b) => (b.root ? 1 : 0) - (a.root ? 1 : 0) || a.uri.fsPath.localeCompare(b.uri.fsPath, undefined, { numeric: true, sensitivity: 'base' }));
    for (const e of sorted) {
      const wf = vscode.workspace.getWorkspaceFolder(e.uri);
      const rel = wf && !e.root ? path.relative(wf.uri.fsPath, e.uri.fsPath) : path.basename(e.uri.fsPath);
      items.push({ label: `$(folder) ${rel}`, description: e.root ? 'workspace folder, with subfolders' : `${e.n} Markdown file${e.n === 1 ? '' : 's'} here, with subfolders`, uri: e.uri });
    }
  }
  items.push({ label: '$(folder-opened) Choose another folder...', other: true });
  const pick = ws.length ? await vscode.window.showQuickPick(items, { title: `${verb}: which folder?`, placeHolder: 'Every Markdown file in the folder and its subfolders' }) : { other: true };
  if (!pick) return undefined;
  if (pick.uri) return pick.uri;
  const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: ws[0] && ws[0].uri, openLabel: 'Use This Folder' });
  return chosen && chosen[0];
}

async function exportFolder(arg) {
  const folder = await pickFolder(arg, 'Export every Markdown file');
  if (!folder) return;
  const files = await findMarkdown(folder);
  if (!files.length) { vscode.window.showInformationMessage(`No Markdown files in ${path.basename(folder.fsPath)}.`); return; }
  const picks = await vscode.window.showQuickPick([
    { label: 'PDF', f: 'pdf', picked: true }, { label: 'Word (DOCX)', f: 'docx' }, { label: 'HTML', f: 'html' },
  ], { canPickMany: true, title: `Export ${files.length} Markdown file${files.length > 1 ? 's' : ''} in ${path.basename(folder.fsPath)}` });
  if (!picks || !picks.length) return;
  const formats = picks.map((p) => p.f);
  const results = await runExports(files.map((uri) => ({ uri, formats })), `Exporting ${files.length} files`);
  await report(results, `Folder ${path.basename(folder.fsPath)}`);
}

async function exportFolderMergedPdf(arg) {
  if (!(await pro.allowed('merge'))) return;
  const folder = await pickFolder(arg, 'Merge into one PDF');
  if (!folder) return;
  const files = await findMarkdown(folder);
  if (!files.length) { vscode.window.showInformationMessage(`No Markdown files in ${path.basename(folder.fsPath)}.`); return; }
  const parts = [];
  for (const u of files) { try { parts.push({ path: u.fsPath, text: await fs.promises.readFile(u.fsPath, 'utf8') }); } catch (e) { log(`Skipped ${u.fsPath}: ${e.message}`); } }
  const text = mergeMarkdown(parts);
  const name = path.basename(folder.fsPath);
  const docPath = path.join(folder.fsPath, `${name}.md`);
  const outPath = path.join(path.dirname(await outputPath({ docPath, text }, 'pdf')), `${name}.pdf`);
  const results = await runExports([{ uri: folder, src: { text, docPath, name: `${name}.md` }, formats: ['pdf'], outPath, title: name }], `Merging ${files.length} files into one PDF`, { extraUses: ['merge'] });
  await report(results, `Merged ${files.length} files`);
}

function engineLabel(uri) {
  const c = vscode.workspace.getConfiguration(PREFIX, uri);
  if (c.get('pdfEngine') === 'builtin') return 'built-in engine';
  const b = findBrowser(c.get('browserPath') || '');
  return b ? `with ${b.name} (installed, nothing downloaded)` : 'built-in engine (no browser found)';
}

async function showEngine() {
  const c = cfg();
  const custom = c.get('browserPath') || '';
  const b = c.get('pdfEngine') === 'builtin' ? null : findBrowser(custom);
  const font = findUnicodeFont(c.get('fallbackFont') || '');
  let msg;
  if (c.get('pdfEngine') === 'builtin') msg = 'PDFs use the built-in engine (setting markdownExport.pdfEngine).';
  else if (b) msg = `PDFs are printed by ${b.name}, already installed at ${b.path}. Nothing is downloaded. It runs hidden with a temporary profile and no network.`;
  else if (custom) msg = `The browser path in settings does not exist: ${custom}. PDFs use the built-in engine.`;
  else msg = 'No Chrome, Edge, Brave or Chromium was found, so PDFs use the built-in engine: simpler layout, Mermaid as code. Nothing is downloaded.';
  msg += font ? ` Built-in engine font for CJK and other scripts: ${path.basename(font)}.` : '';
  const pick = await vscode.window.showInformationMessage(msg, 'Set Browser Path', 'Open Settings');
  if (pick === 'Set Browser Path') await vscode.commands.executeCommand('workbench.action.openSettings', `${PREFIX}.browserPath`);
  if (pick === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', PREFIX);
}

// ---- Export Preview ---------------------------------------------------------------------------------------------
let currentPreview = null;

class Preview {
  constructor(uri) {
    this.uri = uri;
    this.paper = ctx.workspaceState.get('markdownExport.paper', 'print');
    this.panel = vscode.window.createWebviewPanel('markdownExport.preview', `Export Preview: ${path.basename(uri.path)}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      enableCommandUris: support.commandUris(PREFIX),
      retainContextWhenHidden: false,
      localResourceRoots: this.roots(),
    });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'icon.png');
    this.disposables = [];
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === this.uri.toString()) this.schedule(e.document.getText().length > PREVIEW_MAX_BYTES ? 0 : 400, true); }, null, this.disposables);
    vscode.workspace.onDidSaveTextDocument((d) => { if (d.uri.toString() === this.uri.toString()) this.schedule(50); }, null, this.disposables);
    vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed && ed.document.languageId === 'markdown' && ed.document.uri.scheme !== 'output' && ed.document.uri.toString() !== this.uri.toString()) this.follow(ed.document.uri); }, null, this.disposables);
    vscode.window.onDidChangeActiveColorTheme(() => this.schedule(50), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(PREFIX)) this.schedule(50); }, null, this.disposables);
    this.render();
  }

  roots() {
    const r = [vscode.Uri.joinPath(ctx.extensionUri, 'media')];
    if (this.uri.scheme === 'file') r.push(vscode.Uri.file(path.dirname(this.uri.fsPath)));
    for (const f of vscode.workspace.workspaceFolders || []) r.push(f.uri);
    return r;
  }

  follow(uri) {
    this.uri = uri;
    this.panel.title = `Export Preview: ${path.basename(uri.path)}`;
    this.panel.webview.options = { ...this.panel.webview.options, localResourceRoots: this.roots() };
    this.render();
  }

  schedule(ms, onlyIfSmall) {
    clearTimeout(this.timer);
    if (onlyIfSmall && ms === 0) return; // large files refresh on save only
    this.timer = setTimeout(() => this.render(), ms);
  }

  async render() {
    let src;
    try { src = await readSource(this.uri, { confirmLarge: false }); } catch (e) { this.panel.webview.html = this.message(`Could not read the file: ${e.message}`); rating.failure(); return; }
    if (!src) return;
    let text = src.text;
    const big = Buffer.byteLength(text) > PREVIEW_MAX_BYTES;
    if (big) { const cut = text.lastIndexOf('\n', 200 * 1024); text = text.slice(0, cut > 0 ? cut : 200 * 1024); }
    const s = settings(this.uri);
    const fm = splitFrontMatter(text);
    const o = resolveOptions(s, fm.data);
    const wv = this.panel.webview;
    const dark = this.paper === 'theme' && [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind);
    o.htmlTheme = dark ? 'dark' : 'light';
    const base = wv.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media')).toString();
    const engine = engineLabel(this.uri);
    const notice = big ? `<div class="engine-note">This file is ${(Buffer.byteLength(src.text) / 1048576).toFixed(1)} MB. The preview shows the first 200 KB and refreshes on save. Exports use the whole file.</div>` : '';
    const page = buildPage({
      text, frontMatter: fm, docPath: src.docPath, options: o, mode: 'webview', assetsDir: path.join(ctx.extensionPath, 'media'),
      webviewBase: base, cspSource: wv.cspSource, allowCover: o.cover,
      imageUrl: (info) => wv.asWebviewUri(vscode.Uri.file(info.path)).toString(),
      extraBodyClass: `preview paper-${this.paper}`,
      beforeBody: `<style>${PREVIEW_CSS}${support.FOOTER_CSS}</style>
<style>.sheet{width:${o.paper.width}mm;padding:${o.margin.top}mm ${o.margin.right}mm ${o.margin.bottom}mm ${o.margin.left}mm}</style>
<header class="bar" role="toolbar" aria-label="Export">
  <button data-export="pdf" title="Export to PDF">PDF</button><button data-export="docx" title="Export to Word">Word</button><button data-export="html" title="Export to HTML">HTML</button>
  <span class="engine" title="${escapeAttr(`${o.pageSize}${o.landscape ? ' landscape' : ''}, PDF ${engine}`)}">${escapeHtml(o.pageSize)}${o.landscape ? ' landscape' : ''} · PDF ${escapeHtml(engine)}</span>
  <button data-paper title="Switch between white paper and the editor theme">${this.paper === 'theme' ? 'Theme colours' : 'White paper'}</button>
  <button data-settings title="Page size, margins, header, footer">Settings</button>
</header>${notice}<main class="desk"><div class="sheet">`,
      afterBody: `</div></main>${support.footerHtml(PREFIX, support.showLinks(vscode, PREFIX), 'zovo-support-fixed')}`,
      extraScript: PREVIEW_SCRIPT,
    });
    // the page's own <article> sits inside .sheet
    wv.html = page.html;
    this.rendered = true;
  }

  message(text) { return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px">${escapeHtml(text)}</body></html>`; }

  async onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'export' && FORMATS[m.format]) return exportCommand([m.format], this.uri);
    if (m.type === 'paper') { this.paper = this.paper === 'theme' ? 'print' : 'theme'; await ctx.workspaceState.update('markdownExport.paper', this.paper); return this.render(); }
    if (m.type === 'settings') return vscode.commands.executeCommand('workbench.action.openSettings', PREFIX);
    if (m.type === 'link' && typeof m.href === 'string' && /^https?:\/\//i.test(m.href)) return vscode.env.openExternal(vscode.Uri.parse(m.href));
    if (m.type === 'rendered' && !this.counted) { this.counted = true; }
  }

  dispose() {
    clearTimeout(this.timer);
    for (const d of this.disposables) { try { d.dispose(); } catch (e) { /* gone */ } }
    if (currentPreview === this) currentPreview = null;
  }
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

const PREVIEW_CSS = `
html.mode-webview body{background:var(--vscode-editor-background);color:var(--fg);padding:0}
.bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border-bottom:1px solid var(--vscode-panel-border,transparent);font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground)}
.bar button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px;padding:3px 10px;cursor:pointer}
.bar button:hover{background:var(--vscode-button-hoverBackground)}
.bar button[data-paper],.bar button[data-settings]{color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));background:var(--vscode-button-secondaryBackground,transparent)}
.bar button{white-space:nowrap;flex:none}
.bar .engine{flex:1 1 auto;margin-left:6px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.desk{padding:16px 16px 40px}
.sheet{margin:0 auto;background:var(--bg);color:var(--fg);box-shadow:0 1px 6px rgba(0,0,0,.35);min-height:60vh}
body.paper-theme .sheet{box-shadow:none;border:1px solid var(--vscode-panel-border,#8884)}
html.mode-webview .engine-note{margin:8px 16px 0;font-family:var(--vscode-font-family)}
.sheet .page-break{border-top:1px dashed #8888;margin:16px -8px}
`;

const PREVIEW_SCRIPT = `(function(){
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.export) { vscode.postMessage({ type: 'export', format: b.dataset.export }); return; }
    if (b && b.hasAttribute('data-paper')) { vscode.postMessage({ type: 'paper' }); return; }
    if (b && b.hasAttribute('data-settings')) { vscode.postMessage({ type: 'settings' }); return; }
    const a = e.target.closest('a[href]');
    if (a && /^https?:/i.test(a.getAttribute('href')) && !a.closest('.zovo-support')) { e.preventDefault(); vscode.postMessage({ type: 'link', href: a.getAttribute('href') }); }
  });
  // the sheet keeps its real paper width and is scaled to fit the panel, like a print preview
  const fit = () => { const s = document.querySelector('.sheet'); const d = document.querySelector('.desk'); if (!s || !d) return; s.style.zoom = 1; const z = Math.min(1, (d.clientWidth - 32) / s.offsetWidth); s.style.zoom = z > 0.2 ? z : 0.2; };
  fit(); window.addEventListener('resize', fit);
  if (window.__zovoReady) window.__zovoReady.then((r) => { fit(); vscode.postMessage({ type: 'rendered', r }); });
})();`;

function showPreview(arg) {
  const uri = targetUri(arg);
  if (!uri) { vscode.window.showInformationMessage('Open a Markdown file first.'); return; }
  if (currentPreview) { currentPreview.follow(uri); currentPreview.panel.reveal(undefined, true); return; }
  currentPreview = new Preview(uri);
}

// ---- walkthrough sample -------------------------------------------------------------------------------------------
// The bundled sample is copied to the extension's own storage folder, so exports land next to it there and never in
// the extension folder. Exports of this copy do not count for the rating ask (rate.js skips globalStorageUri).
async function openSample() {
  const srcDir = vscode.Uri.joinPath(ctx.extensionUri, 'walkthrough', 'sample');
  const dst = vscode.Uri.joinPath(ctx.globalStorageUri, 'sample');
  await vscode.workspace.fs.createDirectory(dst);
  for (const name of ['release-notes.md', 'zovo-logo.png']) {
    await vscode.workspace.fs.copy(vscode.Uri.joinPath(srcDir, name), vscode.Uri.joinPath(dst, name), { overwrite: true });
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(dst, 'release-notes.md'));
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ---- activate ----------------------------------------------------------------------------------------------------
function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Markdown Export');
  context.subscriptions.push(out);
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'Markdown to PDF' });
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  if (pro.license) context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (u) => pro.license.handleUri(u) }));
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${PREFIX}.${id}`, fn));
  reg('exportPdf', (a, l) => exportCommand(['pdf'], a, l));
  reg('exportDocx', (a, l) => exportCommand(['docx'], a, l));
  reg('exportHtml', (a, l) => exportCommand(['html'], a, l));
  reg('exportAll', (a, l) => exportCommand(['pdf', 'docx', 'html'], a, l));
  reg('exportMenu', (a) => exportMenu(a));
  reg('exportSelection', () => exportSelection());
  reg('exportFolder', (a) => exportFolder(a));
  reg('exportFolderMergedPdf', (a) => exportFolderMergedPdf(a));
  reg('showPreview', (a) => showPreview(a));
  reg('showEngine', () => showEngine());
  reg('openSample', () => openSample().catch((e) => vscode.window.showErrorMessage(`Could not open the sample: ${e.message}`)));
  reg('openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
}

function deactivate() {}

module.exports = { activate, deactivate };
