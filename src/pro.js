'use strict';
// Zovo Pro for Markdown Export. Pro adds three extras: merge a folder into one PDF, a Word template, and a
// cover page. Every export to PDF, Word and HTML (one file, a selection or a whole folder) stays free.
// Each Pro feature has 3 free tries per computer (local counter, no network). After that, one modal explains
// it, only when the user starts that feature. Nothing about Pro shows on its own.
const { createLicense } = require('./license');

const PRO_ENABLED = true; // false: every Pro feature is free and no Pro text shows anywhere
const FREE_TRIES = 3;
const TRIES_KEY = 'zovo.mdexport.proTries.v1';

const FEATURES = {
  merge: { name: 'Merge a folder into one PDF', detail: 'Joins every Markdown file in a folder into one PDF, each file on a new page, with one outline.' },
  template: { name: 'Word template', detail: 'Word exports take the fonts, heading colours and spacing of your own .docx or .dotx file.' },
  cover: { name: 'Cover page', detail: 'Starts PDF, Word and HTML exports with a title page from the front matter title, subtitle, author and date.' },
};

const PRO_TEXT = 'Zovo Pro is USD 19 once on GitHub Sponsors and unlocks Pro in every Zovo extension. Bought it already, or sponsor monthly with USD 10 or more? Choose Unlock with GitHub Sponsors. Unlocking sends one question to GitHub, nothing else. Every export to PDF, Word and HTML stays free.';

function createPro({ vscode, context, license }) {
  const lic = license || (PRO_ENABLED ? createLicense({ vscode, context, sku: 'mdexport-pro', name: 'Zovo', commandPrefix: 'markdownExport' }) : null);
  if (!lic) {
    for (const c of ['getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) {
      context.subscriptions.push(vscode.commands.registerCommand(`markdownExport.${c}`, () => vscode.window.showInformationMessage('Everything in Markdown Export is free.')));
    }
  }
  const tries = () => Object.assign({}, context.globalState.get(TRIES_KEY) || {});

  /**
   * For a Pro feature the user started. Returns {ok, note}: ok true when it may run now; note is a short text
   * for the result message ("free try 1 of 3").
   */
  async function gate(feature) {
    if (!PRO_ENABLED || !lic) return { ok: true, note: '' };
    await lic.ready;
    if (lic.isPro()) { lic.refresh().catch(() => {}); return { ok: true, note: '' }; }
    const t = tries();
    const used = Number(t[feature]) || 0;
    if (used < FREE_TRIES) {
      t[feature] = used + 1;
      await context.globalState.update(TRIES_KEY, t);
      return { ok: true, note: `${FEATURES[feature].name} is Pro: free try ${used + 1} of ${FREE_TRIES}.` };
    }
    const f = FEATURES[feature];
    const ok = await lic.requirePro(f.name, `${f.detail}\n\n${PRO_TEXT}`);
    return { ok: !!ok, note: '' };
  }

  return {
    gate,
    isPro: () => !PRO_ENABLED || !lic || lic.isPro(),
    triesLeft: (feature) => Math.max(0, FREE_TRIES - (Number(tries()[feature]) || 0)),
    license: lic,
  };
}

module.exports = { createPro, PRO_ENABLED, FREE_TRIES, FEATURES, TRIES_KEY };
