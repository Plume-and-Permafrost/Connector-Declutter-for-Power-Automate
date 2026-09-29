'use strict';
// Stages the Chrome/Edge copy of the extension in dist/chrome - manifest.json and
// src/ and nothing else - so build:chrome zips exactly what the store needs,
// without tests, node_modules or reference material alongside it.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'chrome');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(out, 'src'), {
  recursive: true,
  filter: (from) => path.basename(from) !== '.DS_Store'
});
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(out, 'manifest.json'));

console.log('Chrome build staged in', path.relative(root, out));
