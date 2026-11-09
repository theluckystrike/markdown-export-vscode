// Renders icon.svg to icon.png (256 x 256) with the installed Chrome, Edge or Brave.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { findBrowser, Browser } = require('../src/core/chrome');
(async () => {
  const root = path.join(__dirname, '..');
  const b = await Browser.launch({ path: findBrowser('').path, allowNetwork: false });
  const html = path.join(root, 'icon-render.html');
  fs.writeFileSync(html, `<html><body style="margin:0;background:transparent">${fs.readFileSync(path.join(root, 'icon.svg'), 'utf8')}</body></html>`);
  const tab = await b.open(pathToFileURL(html).href, { width: 256, height: 256 });
  await tab.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const r = await tab.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 256, height: 256, scale: 1 } });
  fs.writeFileSync(path.join(root, 'icon.png'), Buffer.from(r.data, 'base64'));
  await tab.close(); await b.close(); fs.unlinkSync(html);
})();
