'use strict';
// Image sources in a Markdown file: local paths (relative to the file), data URIs and remote URLs.
// Remote URLs are never fetched unless the user turned on markdownExport.allowRemoteImages.
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function mimeOf(p) { return MIME[path.extname(p).slice(1).toLowerCase()] || ''; }

/** -> {kind:'remote', url} | {kind:'data', mime, buffer} | {kind:'local', path, exists, mime} | {kind:'bad', reason} */
function resolveImage(src, baseDir) {
  const s = String(src || '').trim();
  if (!s) return { kind: 'bad', reason: 'empty image path' };
  if (/^(https?:)?\/\//i.test(s)) return { kind: 'remote', url: s.startsWith('//') ? `https:${s}` : s };
  const dm = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(s);
  if (dm) {
    try {
      const buffer = dm[2] ? Buffer.from(dm[3], 'base64') : Buffer.from(decodeURIComponent(dm[3]), 'utf8');
      return { kind: 'data', mime: dm[1].toLowerCase(), buffer };
    } catch (e) { return { kind: 'bad', reason: 'broken data URI' }; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^file:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return { kind: 'bad', reason: `unsupported image address ${s.slice(0, 80)}` };
  let p;
  try {
    if (/^file:/i.test(s)) p = fileURLToPath(s);
    else {
      let clean = s.split('#')[0].split('?')[0];
      try { clean = decodeURIComponent(clean); } catch (e) { /* keep */ }
      p = path.isAbsolute(clean) ? clean : path.resolve(baseDir || '.', clean);
    }
  } catch (e) { return { kind: 'bad', reason: `bad image path ${s.slice(0, 80)}` }; }
  let exists = false; let size = 0;
  try { const st = fs.statSync(p); exists = st.isFile(); size = st.size; } catch (e) { /* missing */ }
  return { kind: 'local', path: p, exists, size, mime: mimeOf(p) };
}

function fileUrl(p) { return pathToFileURL(p).href; }

/** Reads a local image (up to 25 MB). -> {buffer, mime} or null */
function readLocal(info) {
  if (!info || info.kind !== 'local' || !info.exists || info.size > MAX_IMAGE_BYTES) return null;
  try {
    const buffer = fs.readFileSync(info.path);
    return { buffer, mime: sniffMime(buffer.subarray(0, 64)) || info.mime };
  } catch (e) { return null; }
}

function sniffMime(b) {
  if (!b || b.length < 4) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const head = b.toString('utf8', 0, Math.min(b.length, 16)).trim();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  return '';
}

/** Pixel size of PNG, JPEG, GIF, BMP and WebP buffers. -> {width, height} or null */
function imageSize(b) {
  try {
    if (!b || b.length < 24) return null;
    if (b[0] === 0x89 && b[1] === 0x50) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b[0] === 0x47 && b[1] === 0x49) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b[0] === 0x42 && b[1] === 0x4d) return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const kind = b.toString('latin1', 12, 16);
      if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') { const n = b.readUInt32LE(21); return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 }; }
    }
  } catch (e) { /* fall through */ }
  return null;
}

/** width/height of an SVG from its attributes or viewBox */
function svgSize(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
  const tag = /<svg\b[^>]*>/i.exec(head);
  if (!tag) return null;
  const num = (name) => { const m = new RegExp(`\\s${name}\\s*=\\s*["']?\\s*([0-9.]+)\\s*(px)?["'\\s>]`, 'i').exec(tag[0]); return m ? Number(m[1]) : 0; };
  let w = num('width'); let h = num('height');
  if (!w || !h) {
    const vb = /viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(tag[0]);
    if (vb) { w = w || Number(vb[1]); h = h || Number(vb[2]); }
  }
  return w && h ? { width: w, height: h } : null;
}

function dataUri(buffer, mime) { return `data:${mime};base64,${buffer.toString('base64')}`; }

module.exports = { resolveImage, readLocal, imageSize, svgSize, sniffMime, mimeOf, fileUrl, dataUri, MAX_IMAGE_BYTES };
