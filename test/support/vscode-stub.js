'use strict';
// A small stand-in for the vscode module (adapted from elf-pe-viewer's test stub): enough for activation, the export
// commands, the Pro tools and the license facade. Tests script the dialogs through `ui` and read what happened from
// `log`. Settings come from the package.json defaults plus `config` overrides.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function create({ workspace } = {}) {
  const log = { info: [], warn: [], error: [], status: [], opened: [], external: [], commands: [], progress: [], quick: [] };
  const ui = { open: [], save: [], input: [], quick: [], info: [], warn: [] };
  const commands = new Map();
  const state = new Map();
  const config = {};
  for (const [k, v] of Object.entries(PKG.contributes.configuration.properties)) config[k.replace(/^markdownExport\./, '')] = v.default;
  class EventEmitter { constructor() { this.l = new Set(); this.event = (f) => { this.l.add(f); return { dispose: () => this.l.delete(f) }; }; } fire(v) { for (const f of this.l) f(v); } dispose() { this.l.clear(); } }
  class Uri {
    constructor(scheme, p, query = '') { this.scheme = scheme; this.path = p; this.fsPath = p; this.query = query; }
    static file(p) { return new Uri('file', path.resolve(p)); }
    static parse(s) { const u = new Uri(s.split(':')[0], s); u.str = s; return u; }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.join(u.path, ...parts)); }
    toString() { return this.str || `${this.scheme}://${this.path}`; }
    with() { return this; }
  }
  class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
  const nextOf = (q, dflt) => (q.length ? q.shift() : dflt);
  const msg = (kind) => async (text, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : {};
    log[kind].push({ text, opts, buttons: rest.map((b) => (typeof b === 'string' ? b : b.title)) });
    return kind === 'info' ? nextOf(ui.info, undefined) : kind === 'warn' ? nextOf(ui.warn, undefined) : undefined;
  };
  const noop = () => ({ dispose() {} });
  const mdFiles = (dir) => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^(node_modules|\.git|dist)$/.test(e.name)) walk(p); } else if (/\.(md|markdown|mdown|mkd)$/i.test(e.name)) out.push(Uri.file(p)); } };
    walk(dir);
    return out;
  };
  const folders = workspace ? [{ uri: Uri.file(workspace), name: path.basename(workspace), index: 0 }] : undefined;
  const vscode = {
    version: '1.90.2',
    EventEmitter, Uri, RelativePattern,
    ViewColumn: { Beside: -2, Active: -1, One: 1 },
    ProgressLocation: { Notification: 15, Window: 10 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
    FileType: { File: 1, Directory: 2 },
    env: { appName: 'Visual Studio Code', uriScheme: 'vscode', machineId: 'test', language: 'en', clipboard: { writeText: async () => {} }, openExternal: async (u) => { log.external.push(String(u)); return true; }, asExternalUri: async (u) => u },
    workspace: {
      workspaceFolders: folders,
      textDocuments: [],
      isTrusted: true,
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), inspect: (k) => ({ globalValue: config[k] }), update: async (k, v) => { config[k] = v; } }),
      getWorkspaceFolder: (u) => (folders || []).find((f) => u.fsPath === f.uri.fsPath || u.fsPath.startsWith(f.uri.fsPath + path.sep)),
      findFiles: async (pattern) => { const base = typeof pattern === 'string' ? (folders ? folders[0].uri.fsPath : null) : pattern.base.fsPath || pattern.base.uri.fsPath; return base ? mdFiles(base) : []; },
      onDidChangeConfiguration: noop, onDidChangeTextDocument: noop, onDidSaveTextDocument: noop,
      fs: {
        stat: async (u) => { const s = fs.statSync(u.fsPath); return { size: s.size, type: s.isDirectory() ? 2 : 1 }; },
        readFile: async (u) => fs.readFileSync(u.fsPath),
        writeFile: async (u, b) => { fs.writeFileSync(u.fsPath, b); },
        createDirectory: async (u) => { fs.mkdirSync(u.fsPath, { recursive: true }); },
        copy: async (a, b) => { fs.copyFileSync(a.fsPath, b.fsPath); },
      },
      openTextDocument: async (u) => ({ uri: u, getText: () => fs.readFileSync(u.fsPath, 'utf8'), languageId: 'markdown', fileName: u.fsPath }),
    },
    window: {
      state: { focused: true },
      activeTextEditor: undefined,
      activeColorTheme: { kind: 2 },
      onDidChangeWindowState: noop, onDidChangeActiveTextEditor: noop, onDidChangeActiveColorTheme: noop,
      registerUriHandler: noop,
      showInformationMessage: msg('info'), showWarningMessage: msg('warn'), showErrorMessage: msg('error'),
      setStatusBarMessage: (t) => { log.status.push(t); return { dispose() {} }; },
      showOpenDialog: async () => nextOf(ui.open, undefined),
      showSaveDialog: async () => nextOf(ui.save, undefined),
      showInputBox: async () => nextOf(ui.input, undefined),
      showQuickPick: async (items, opts) => { const list = await items; log.quick.push({ items: list, opts }); const f = nextOf(ui.quick, undefined); return typeof f === 'function' ? f(list) : f; },
      showTextDocument: async (d) => { log.opened.push(d); return {}; },
      withProgress: async (o, fn) => { log.progress.push(o.title); return fn({ report: (r) => log.progress.push(r.message) }, { isCancellationRequested: false, onCancellationRequested: noop }); },
      createOutputChannel: () => ({ lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }),
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...a) => { log.commands.push([id, ...a]); if (commands.has(id)) return commands.get(id)(...a); return undefined; },
      getCommands: async () => [...commands.keys()],
    },
    extensions: { all: [], getExtension: () => undefined, onDidChange: noop },
    authentication: { getSession: async () => undefined, onDidChangeSessions: noop },
    l10n: { t: (s) => s },
  };
  const secrets = new Map();
  const gs = fs.mkdtempSync(path.join(os.tmpdir(), 'mdexport-gs-'));
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(ROOT),
    extensionPath: ROOT,
    extension: { id: 'zovo.zovo-markdown-export', packageJSON: PKG },
    globalStorageUri: Uri.file(gs),
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()], setKeysForSync() {} },
    workspaceState: { get: (k, d) => d, update: async () => {} },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: noop },
  };
  return { vscode, context, log, ui, commands, state, config, gs };
}

/** Load src/extension.js with a fresh stub; returns the stub with .ext and .restore(). */
function loadExtension(opts) {
  const stub = create(opts);
  const orig = Module._load;
  const root = path.join(ROOT, 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  stub.ext = require(path.join(root, 'extension.js'));
  stub.restore = () => { Module._load = orig; for (const d of stub.context.subscriptions) { try { d.dispose(); } catch (e) { /* gone */ } } fs.rmSync(stub.gs, { recursive: true, force: true }); };
  return stub;
}

module.exports = { create, loadExtension };
