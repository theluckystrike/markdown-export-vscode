'use strict';
// Turns highlight.js HTML into coloured text runs for DOCX and the built-in PDF engine (GitHub light colours).
const { highlight } = require('./markdown');
const { decodeEntities } = require('./model');

const COLORS = [
  [/^hljs-(doctag|keyword|template-tag|template-variable|type)$/, 'CF222E'],
  [/^hljs-(title|function_)$/, '8250DF'],
  [/^hljs-(attr|attribute|literal|meta|number|operator|variable|selector-attr|selector-class|selector-id|section)$/, '0550AE'],
  [/^hljs-(regexp|string)$/, '0A3069'],
  [/^hljs-(built_in|symbol|bullet)$/, '953800'],
  [/^hljs-(comment|code|formula)$/, '59636E'],
  [/^hljs-(name|quote|selector-tag|selector-pseudo|addition)$/, '116329'],
  [/^hljs-deletion$/, '82071E'],
];

function colorOf(classes) {
  for (const c of classes.split(/\s+/).reverse()) for (const [re, col] of COLORS) if (re.test(c)) return col;
  return '';
}

/** -> lines: [[{text, color, italic, bold}]] */
function codeLines(code, lang) {
  const h = highlight(code, lang);
  const runs = [];
  const stack = [];
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  let m;
  while ((m = re.exec(h.html))) {
    if (m[1] !== undefined) stack.push({ color: colorOf(m[1]), italic: /hljs-comment|hljs-emphasis/.test(m[1]), bold: /hljs-strong|hljs-section/.test(m[1]) });
    else if (m[0] === '</span>') stack.pop();
    else {
      const st = [...stack].reverse().find((s) => s.color) || {};
      runs.push({ text: decodeEntities(m[2]), color: st.color || '', italic: stack.some((s) => s.italic), bold: stack.some((s) => s.bold) });
    }
  }
  const lines = [[]];
  for (const r of runs) {
    const parts = r.text.split('\n');
    parts.forEach((p, k) => {
      if (k > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ ...r, text: p });
    });
  }
  return lines;
}

module.exports = { codeLines };
