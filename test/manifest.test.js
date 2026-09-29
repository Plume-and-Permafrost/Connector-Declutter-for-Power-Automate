'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const manifest = readJson('manifest.json');
const firefox = readJson('manifest.firefox.json');
const entries = manifest.content_scripts;

test('no two content_scripts entries for one URL share a file', () => {
  // Chrome injects a given path into a document once. When the same file is
  // listed in both the MAIN and the ISOLATED entry for an origin, the first
  // entry claims it and the second silently receives nothing - which is how the
  // isolated world ended up without env.js, policy.js and its logger, and why
  // colour coding did nothing at all. There is no warning for this; the test is
  // the warning.
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sameUrl = entries[i].matches.some((m) => entries[j].matches.includes(m));
      if (!sameUrl) continue;
      const shared = entries[i].js.filter((f) => entries[j].js.includes(f));
      assert.deepStrictEqual(shared, [],
        `entries ${i} and ${j} both match ${entries[i].matches} and share ${shared.join(', ')} - ` +
        'only the first entry will get those files');
    }
  }
});

test('every content script file exists', () => {
  const files = new Set(entries.flatMap((e) => e.js));
  files.add(manifest.background.service_worker);
  firefox.background.scripts.forEach((f) => files.add(f));
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is listed in the manifest but missing`);
  }
});

test('the Firefox manifest differs from the Chrome one only where it must', () => {
  // Everything but the background declaration and Firefox's own settings is
  // shared. An edit made to one manifest and forgotten in the other - a new
  // content script, a host permission, a version bump - fails here.
  const strip = (m) => {
    const copy = Object.assign({}, m);
    delete copy.background;
    delete copy.browser_specific_settings;
    return copy;
  };
  assert.deepStrictEqual(strip(firefox), strip(manifest));
  assert.ok(firefox.browser_specific_settings && firefox.browser_specific_settings.gecko.id,
    'manifest.firefox.json needs a gecko add-on id');
});

test('Firefox background scripts match what the Chrome service worker imports', () => {
  // Chrome runs background.service_worker and pulls its dependencies in with
  // importScripts; Firefox has no MV3 service workers and loads
  // background.scripts in order instead. The two lists must agree or one
  // browser loses a module.
  const sw = manifest.background.service_worker;
  const src = fs.readFileSync(path.join(root, sw), 'utf8');
  const call = src.match(/importScripts\(([^)]*)\)/);
  assert.ok(call, `${sw} has no importScripts call`);
  const imported = [...call[1].matchAll(/'\/?([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(firefox.background.scripts, [...imported, sw]);
});

// Each script asks for members off the shared __cdpa namespace. Those come from
// sibling files in the same entry, so a member no file in the entry defines is a
// crash the moment that line runs - exactly the decorate.js failure this suite
// was written for.
const PROVIDES = {
  'src/common/log.js': ['log'],
  'src/iso/log.js': ['log'],
  'src/common/env.js': ['env'],
  'src/common/connector-map.js': ['connectorMap'],
  'src/common/policy.js': ['policy'],
  'src/common/filters.js': ['filters'],
  'src/common/views.js': ['views'],
  'src/common/paginate.js': ['paginate'],
  'src/common/http-hook.js': ['httpHook'],
  'src/common/storage.js': ['storage'],
  'src/maker/in-flow.js': ['inFlow'],
  // Not a module, but it publishes the catalogue stash decorate.js reads.
  'src/maker/interceptor.js': ['catalogue']
};

function usedBy(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const used = new Set();
  const re = /__cdpa\.([a-zA-Z][a-zA-Z0-9]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) used.add(m[1]);
  // Its own exports are assignments, not dependencies.
  (PROVIDES[file] || []).forEach((name) => used.delete(name));
  return used;
}

test('every entry supplies what its scripts reach for', () => {
  entries.forEach((entry, i) => {
    const available = new Set(entry.js.flatMap((f) => PROVIDES[f] || []));
    entry.js.forEach((file) => {
      for (const name of usedBy(file)) {
        assert.ok(available.has(name),
          `${file} uses __cdpa.${name}, which nothing in entry ${i} (${entry.matches}, ` +
          `world ${entry.world || 'ISOLATED'}) provides`);
      }
    });
  });
});
