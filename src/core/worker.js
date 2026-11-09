'use strict';
// Runs one large DOCX or built-in-engine PDF export in a worker thread, so its memory is capped and freed when
// it ends, and the VS Code extension host never holds it. Pictures that need the browser are asked from the
// main thread (it owns the browser).
const { parentPort, workerData } = require('worker_threads');
const { ExportSession } = require('./exporter');

let seq = 0;
const waiting = new Map();
parentPort.on('message', (m) => {
  if (m && m.type === 'rasterResult' && waiting.has(m.id)) {
    const { resolve, reject } = waiting.get(m.id); waiting.delete(m.id);
    if (m.error) reject(new Error(m.error));
    else resolve((m.result || []).map((r) => (r ? { png: Buffer.from(r.png), width: r.width, height: r.height } : null)));
  }
});

(async () => {
  const { env, kind, job, browserInfo } = workerData;
  const s = new ExportSession({ ...env, inWorker: true });
  s.browserInfo = browserInfo || null;
  s.raster = (jobs, options) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'raster', id, jobs, options });
  });
  try {
    const r = await s[kind === 'pdf' ? '_pdfBuiltin' : kind](job);
    parentPort.postMessage({ type: 'done', result: r });
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: e.message });
  }
})();
