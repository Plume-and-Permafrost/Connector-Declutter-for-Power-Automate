'use strict';
// Firefox only reads a file called manifest.json, so it cannot load
// manifest.firefox.json from the repo root. This stages a Firefox copy of the
// extension in dist/firefox, which the web-ext scripts in package.json run and
// package from.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'firefox');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(out, 'src'), { recursive: true });
fs.copyFileSync(path.join(root, 'manifest.firefox.json'), path.join(out, 'manifest.json'));

console.log('Firefox build staged in', path.relative(root, out));
