'use strict';
// Front matter: a YAML block between --- lines at the very top of the file.
// Bad YAML never stops an export: the block is dropped from the output and a warning names the line.
const yaml = require('js-yaml');

const RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function splitFrontMatter(text) {
  const src = String(text || '');
  const m = RE.exec(src);
  if (!m) return { data: {}, body: src.replace(/^﻿/, ''), error: '', lines: 0 };
  const lines = m[0].split('\n').length - 1;
  const body = src.slice(m[0].length);
  if (m[1].length > 256 * 1024) return { data: {}, body, error: 'Front matter is larger than 256 KB and was ignored.', lines };
  try {
    const data = yaml.load(m[1], { schema: yaml.JSON_SCHEMA, json: true });
    if (data == null) return { data: {}, body, error: '', lines };
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { data: {}, body, error: 'Front matter is not a list of key: value pairs and was ignored.', lines };
    }
    return { data, body, error: '', lines };
  } catch (e) {
    const where = e && e.mark ? ` (line ${e.mark.line + 2})` : '';
    const why = e && e.reason ? e.reason : 'it is not valid YAML';
    return { data: {}, body, error: `Front matter was ignored${where}: ${why}.`, lines };
  }
}

module.exports = { splitFrontMatter };
