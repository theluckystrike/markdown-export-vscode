'use strict';
// Zovo Pro for Markdown to PDF, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh). Pro adds three tools: merge a folder into one PDF, a Word template, and a cover
// page. Every export to PDF, Word and HTML (one file, a selection, several files or a whole folder) stays free.
// Each Pro tool has 3 free tries on this computer (local counter, no network). A try counts only after the tool
// produced its output (a saved file); Escape, Cancel or a failed export never uses one. One export run uses at most
// one try per tool, even for a folder. The panel appears only when the user starts a tool with no tries left.
// Nothing about Pro shows on its own: no popup, toast, badge or tab on open or activation.
const { createLicense } = require('./license');

const SKU = 'mdexport-pro';
const FREE_TRIES = 3;
const TRIES_KEY = 'zovo.mdexport.proTries.v1';

const FEATURES = {
  merge: {
    title: 'Merge a folder into one PDF',
    detail: 'Joins every Markdown file in a folder into one PDF, each file on a new page, with one outline.',
  },
  template: {
    title: 'Word template',
    detail: 'Word exports take the fonts, heading colours and spacing of your own .docx or .dotx file.',
  },
  cover: {
    title: 'Cover page',
    detail: 'Starts PDF, Word and HTML exports with a title page from the front matter title, subtitle, author and date.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, prefix = 'markdownExport', productName = 'Markdown to PDF' }) {
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });

  const used = (f) => Number((context.globalState.get(TRIES_KEY) || {})[f]) || 0;
  const triesLeft = (f) => (FEATURES[f] ? Math.max(0, FREE_TRIES - used(f)) : 0);
  const licensed = () => !!lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run now (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f) {
    if (lic.ready) await lic.ready;
    if (licensed()) { if (lic.refresh) Promise.resolve().then(() => lic.refresh()).catch(() => {}); return true; }
    if (triesLeft(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS }));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). Returns a short note or ''. */
  async function produced(f) {
    if (!FEATURES[f] || licensed()) return '';
    const m = { ...(context.globalState.get(TRIES_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIES_KEY, m);
    const l = triesLeft(f);
    return `${FEATURES[f].title} is Zovo Pro: free try ${used(f)} of ${FREE_TRIES} used${l ? `, ${l} left` : ''}.`;
  }

  return {
    SKU, FEATURES, FREE_TRIES,
    allowed, produced, triesLeft,
    isPro: licensed,
    license: lic,
  };
}

module.exports = { createPro, FREE_TRIES, FEATURES, TRIES_KEY, SKU, TOOLS };
