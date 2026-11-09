'use strict';
// Drives a browser the user already has (Chrome, Edge, Brave, Chromium, Vivaldi) over the DevTools protocol
// on a pipe. Nothing is downloaded. The browser runs headless with a fresh temporary profile that is deleted
// afterwards, background networking off, and (unless remote images are on) every network request refused.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function candidates(platform, env) {
  const e = env || process.env;
  if (platform === 'darwin') {
    const apps = [
      ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
      ['Google Chrome Beta', 'Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'],
      ['Google Chrome Canary', 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
      ['Microsoft Edge Beta', 'Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta'],
      ['Vivaldi', 'Vivaldi.app/Contents/MacOS/Vivaldi'],
      ['Arc', 'Arc.app/Contents/MacOS/Arc'],
    ];
    const roots = ['/Applications', path.join(e.HOME || os.homedir(), 'Applications')];
    const out = [];
    for (const [name, rel] of apps) for (const r of roots) out.push({ name, path: path.join(r, rel) });
    return out;
  }
  if (platform === 'win32') {
    const roots = [e.PROGRAMFILES, e['PROGRAMFILES(X86)'], e.LOCALAPPDATA].filter(Boolean);
    const rels = [
      ['Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
      ['Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
      ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['Chromium', 'Chromium\\Application\\chrome.exe'],
      ['Vivaldi', 'Vivaldi\\Application\\vivaldi.exe'],
    ];
    const out = [];
    for (const [name, rel] of rels) for (const r of roots) out.push({ name, path: path.win32.join(r, rel) });
    return out;
  }
  const names = [
    ['Google Chrome', 'google-chrome'], ['Google Chrome', 'google-chrome-stable'], ['Chromium', 'chromium'],
    ['Chromium', 'chromium-browser'], ['Microsoft Edge', 'microsoft-edge'], ['Microsoft Edge', 'microsoft-edge-stable'],
    ['Brave', 'brave-browser'], ['Brave', 'brave'], ['Vivaldi', 'vivaldi'],
  ];
  const dirs = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome', '/var/lib/flatpak/exports/bin'];
  const out = [];
  for (const [name, bin] of names) for (const d of dirs) out.push({ name, path: path.join(d, bin) });
  return out;
}

function isExecutable(p) {
  try { const st = fs.statSync(p); return st.isFile(); } catch (e) { return false; }
}

/**
 * Finds a browser. custom: a path from the setting (wins when it exists). Returns {name, path} or null.
 * customMissing is true when the setting names a file that does not exist.
 */
function findBrowser(custom, platform = process.platform, env = process.env) {
  if (custom && String(custom).trim()) {
    const p = String(custom).trim();
    if (isExecutable(p)) return { name: path.basename(p).replace(/\.exe$/i, ''), path: p, custom: true };
    // A macOS .app bundle path: look inside it
    if (/\.app\/?$/.test(p)) {
      const inner = path.join(p, 'Contents', 'MacOS');
      try { const f = fs.readdirSync(inner)[0]; if (f && isExecutable(path.join(inner, f))) return { name: f, path: path.join(inner, f), custom: true }; } catch (e) { /* none */ }
    }
    return null;
  }
  const envPath = env.CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && isExecutable(envPath)) return { name: path.basename(envPath), path: envPath };
  for (const c of candidates(platform, env)) if (isExecutable(c.path)) return c;
  return null;
}

function launchArgs(userDir, allowNetwork) {
  const a = [
    '--headless', '--remote-debugging-pipe', `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-component-extensions-with-background-pages',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--no-pings', '--metrics-recording-only',
    '--safebrowsing-disable-auto-update', '--disable-breakpad', '--disable-crash-reporter', '--password-store=basic', '--use-mock-keychain',
    '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,PrivacySandboxSettings4',
    '--mute-audio', '--hide-scrollbars', '--disable-gpu', '--font-render-hinting=none', '--allow-file-access-from-files',
    '--disable-popup-blocking', '--disable-prompt-on-repost', '--deny-permission-prompts',
  ];
  if (!allowNetwork) a.push('--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND');
  a.push('about:blank');
  return a;
}

class Browser {
  /** opts: { path, allowNetwork, timeoutMs, log } */
  static async launch(opts) {
    const b = new Browser(opts);
    try {
      await b._start();
    } catch (e) {
      // a browser that cannot start must not leave its temporary profile behind
      try { b.proc.kill('SIGKILL'); } catch (x) { /* gone */ }
      await Promise.race([b.exited, new Promise((r) => setTimeout(r, 2000))]);
      removeDir(b.userDir);
      throw e;
    }
    return b;
  }

  constructor(opts) {
    this.opts = opts;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zovo-mdexport-'));
  }

  async _start() {
    const args = launchArgs(this.userDir, !!this.opts.allowNetwork);
    this.proc = spawn(this.opts.path, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { if (this.stderr.length < 20000) this.stderr += d.toString(); });
    this.out = this.proc.stdio[3];
    this.in = this.proc.stdio[4];
    this.in.on('data', (chunk) => this._onData(chunk));
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => { this.closed = true; this._failAll(new Error(`The browser stopped (exit code ${code}). ${this.stderr.split('\n').filter((l) => /error|fail/i.test(l)).slice(-2).join(' ')}`.trim())); resolve(code); }));
    this.proc.on('error', (e) => { this.closed = true; this._failAll(e); });
    this.out.on('error', () => {});
    const v = await this.send('Browser.getVersion', {}, undefined, 20000);
    this.version = v.product;
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let i;
    while ((i = this.buf.indexOf(0)) !== -1) {
      const raw = this.buf.subarray(0, i).toString('utf8');
      this.buf = this.buf.subarray(i + 1);
      let m;
      try { m = JSON.parse(raw); } catch (e) { continue; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message || JSON.stringify(m.error)}`)); else p.resolve(m.result || {});
      } else if (m.method) {
        for (const h of this.handlers) { try { h(m); } catch (e) { /* handler error */ } }
      }
    }
  }

  _failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  send(method, params = {}, sessionId, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('The browser is not running.'));
    const id = ++this.seq;
    const msg = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      const ms = timeoutMs || this.opts.timeoutMs || 60000;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The browser did not answer ${method} within ${Math.round(ms / 1000)} s.`)); }, ms);
      this.pending.set(id, { resolve, reject, timer, method });
      this.out.write(msg + '\0');
    });
  }

  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }

  waitEvent(pred, timeoutMs) {
    return new Promise((resolve, reject) => {
      const off = this.on((m) => { if (pred(m)) { clearTimeout(t); off(); resolve(m); } });
      const t = setTimeout(() => { off(); reject(new Error('Timed out while the page loaded.')); }, timeoutMs);
    });
  }

  /** Opens a page tab and loads a file:// URL. Returns a Page. */
  async open(url, { timeoutMs = 120000, width = 1000, height = 1400, allowNetwork = false } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    if (!allowNetwork) {
      // Refuse every request that is not a local file or inline data. The CSP and the proxy flag already stop
      // them; this is the third lock.
      page.offFetch = this.on((m) => {
        if (m.sessionId !== sessionId || m.method !== 'Fetch.requestPaused') return;
        const u = m.params.request.url;
        if (/^(file|data|blob|about):/i.test(u)) this.send('Fetch.continueRequest', { requestId: m.params.requestId }, sessionId).catch(() => {});
        else { page.blocked.push(u); this.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {}); }
      });
      await this.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    }
    page.offConsole = this.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') page.errors.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push(m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    });
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    const loaded = this.waitEvent((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', timeoutMs);
    const nav = await this.send('Page.navigate', { url }, sessionId, timeoutMs);
    if (nav.errorText) throw new Error(`The browser could not open the page: ${nav.errorText}`);
    await loaded;
    return page;
  }

  async close() {
    if (!this.closed) {
      try { await this.send('Browser.close', {}, undefined, 5000); } catch (e) { /* kill below */ }
    }
    const done = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
    if (done === 'timeout') { try { this.proc.kill('SIGKILL'); } catch (e) { /* gone */ } await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))]); }
    removeDir(this.userDir);
  }

  kill() {
    try { this.proc.kill('SIGKILL'); } catch (e) { /* gone */ }
    setTimeout(() => removeDir(this.userDir), 1500);
  }
}

function removeDir(d) {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* the OS temp cleaner gets it */ }
}

class Page {
  constructor(browser, targetId, sessionId) {
    Object.assign(this, { browser, targetId, sessionId });
    this.blocked = [];
    this.errors = [];
  }

  send(method, params, timeoutMs) { return this.browser.send(method, params, this.sessionId, timeoutMs); }

  async evaluate(expression, timeoutMs = 60000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result ? r.result.value : undefined;
  }

  /** Waits for window.__zovoReady (Mermaid, images and fonts). */
  async ready(timeoutMs = 90000) {
    try { return (await this.evaluate('window.__zovoReady ? window.__zovoReady : Promise.resolve({})', timeoutMs)) || {}; } catch (e) { return { error: e.message }; }
  }

  /** Prints to a PDF file through a stream, so a 1,000-page PDF never sits in memory as one string. */
  // tagged: an accessible (tagged) PDF. It roughly doubles the size, so very large documents skip it.
  async printToFile(file, params, timeoutMs = 300000, tagged = true) {
    let r;
    try {
      r = await this.send('Page.printToPDF', { ...params, transferMode: 'ReturnAsStream', generateDocumentOutline: true, generateTaggedPDF: !!tagged }, timeoutMs);
    } catch (e) {
      if (!/generateDocumentOutline|generateTaggedPDF|Invalid parameters/i.test(e.message)) throw e;
      r = await this.send('Page.printToPDF', { ...params, transferMode: 'ReturnAsStream' }, timeoutMs);
    }
    const tmp = `${file}.${process.pid}.part`;
    const fd = fs.openSync(tmp, 'w');
    let bytes = 0;
    try {
      if (r.stream) {
        for (;;) {
          const chunk = await this.send('IO.read', { handle: r.stream, size: 1 << 20 }, 60000);
          if (chunk.data) { const b = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'binary'); fs.writeSync(fd, b); bytes += b.length; }
          if (chunk.eof) break;
        }
        await this.send('IO.close', { handle: r.stream }).catch(() => {});
      } else if (r.data) {
        const b = Buffer.from(r.data, 'base64'); fs.writeSync(fd, b); bytes = b.length;
      }
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return bytes;
  }

  /** PNG of each element in the array the expression returns (null entries stay null). For DOCX pictures. */
  async screenshots(elementsExpr, scale = 2) {
    const boxes = await this.evaluate(`JSON.stringify((${elementsExpr}).map(e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }))`);
    const list = JSON.parse(boxes || '[]');
    const out = [];
    for (const b of list) {
      if (!b || !(b.w > 0 && b.h > 0)) { out.push(null); continue; }
      const w = Math.min(Math.ceil(b.w), 4000); const h = Math.min(Math.ceil(b.h), 6000);
      const r = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.floor(b.x), y: Math.floor(b.y), width: w, height: h, scale }, captureBeyondViewport: true, fromSurface: true }, 60000);
      out.push({ png: Buffer.from(r.data, 'base64'), width: w, height: h });
    }
    return out;
  }

  async close() {
    if (this.offFetch) this.offFetch();
    if (this.offConsole) this.offConsole();
    await this.browser.send('Target.closeTarget', { targetId: this.targetId }, undefined, 10000).catch(() => {});
  }
}

module.exports = { findBrowser, candidates, launchArgs, Browser };
