'use strict';
// The tint colours are shared: the settings page edits them, decorate.js turns
// them into CSS, and both fall back to the same defaults. These pin that contract.
const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers.js');

const storage = globalThis.__cdpa.storage;

test('default colours are valid opaque hex', () => {
  const colours = storage.defaultColours();
  // Two DLP classifications, plus one per reason a connector would be hidden.
  assert.deepStrictEqual(Object.keys(colours).sort(),
    ['agentic', 'blocked', 'business', 'desktop', 'nonBusiness']);
  for (const [name, value] of Object.entries(colours).concat([['unnamed', storage.UNNAMED_RULE_COLOUR]])) {
    assert.match(value, /^#[0-9a-f]{6}$/i, name + ' is not a 6-digit hex colour');
  }
});

test('every default category rule has a colour of its own', () => {
  // The colour key is the rule id, so a default rule without a matching key would
  // silently fall back to the neutral grey.
  const colours = storage.defaultColours();
  for (const rule of globalThis.__cdpa.filters.defaultRules()) {
    assert.ok(rule.id in colours, 'no colour for the default rule ' + rule.id);
  }
});

test('settings carry the colours, and each call gets its own copy', () => {
  const a = storage.defaultSettings();
  const b = storage.defaultSettings();
  assert.deepStrictEqual(a.colours, storage.defaultColours());
  // Shared object references would let one edit leak into unrelated reads.
  assert.notStrictEqual(a.colours, b.colours);
  a.colours.business = '#000000';
  assert.notStrictEqual(b.colours.business, '#000000');
});

test('settings saved before colours existed still load', () => {
  // withDefaults is what a config exported by an older build goes through.
  const older = { hideBlocked: false, colourCode: true };
  const merged = storage.withDefaults(older, storage.defaultSettings);
  assert.strictEqual(merged.hideBlocked, false);
  assert.strictEqual(merged.colourCode, true);
  assert.deepStrictEqual(merged.colours, storage.defaultColours());
});

test('a stored colour choice survives the merge', () => {
  const stored = { colours: { business: '#123456', nonBusiness: '#abcdef' } };
  const merged = storage.withDefaults(stored, storage.defaultSettings);
  assert.deepStrictEqual(merged.colours, stored.colours);
});

test("decorate's inlined fallback colours match the stored defaults", () => {
  // decorate.js runs in page context, where storage.js is not loaded, so it keeps
  // its own copy of the defaults for unparseable input. Copies drift; this catches it.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'maker', 'decorate.js'), 'utf8');
  const m = /var DEFAULT_COLOURS = (\{[^}]*\});/.exec(src);
  assert.ok(m, 'decorate.js no longer declares DEFAULT_COLOURS');
  // eslint-disable-next-line no-new-func
  const inlined = new Function('return ' + m[1])();
  assert.deepStrictEqual(inlined, storage.defaultColours());

  const grey = /var UNNAMED_RULE_COLOUR = '(#[0-9a-f]{6})';/.exec(src);
  assert.ok(grey, 'decorate.js no longer declares UNNAMED_RULE_COLOUR');
  assert.strictEqual(grey[1], storage.UNNAMED_RULE_COLOUR);
});

test('the panel section settings line up across storage, sections.js and the UI', () => {
  // Three copies of the same four names: storage owns the defaults, sections.js
  // reads them in page context where storage.js is not loaded, and options.js
  // wires each checkbox by id === settings key. A rename in one of the three is
  // silent - the control saves a key nothing reads, and the feature just stops.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const defaults = storage.defaultSettings();
  const src = fs.readFileSync(path.join(root, 'src', 'maker', 'sections.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src', 'ui', 'options.html'), 'utf8');

  const read = [...src.matchAll(/setting: '(\w+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(read, ['hideFavourites', 'hideAiCapabilities', 'hideBuiltInTools'],
    'sections.js no longer hides exactly the three named sections');

  for (const key of read.concat(['expandFavourites'])) {
    assert.ok(key in defaults, key + ' is not a stored setting');
    assert.strictEqual(defaults[key], false, key + ' should be off until it is asked for');
    assert.ok(html.includes('id="' + key + '"'), 'options.html has no checkbox for ' + key);
  }
  assert.match(src, /settings\.expandFavourites/, 'sections.js stopped reading expandFavourites');
});

test('steady rows lines up across storage, hover.js and the UI', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  assert.strictEqual(storage.defaultSettings().steadyRows, false);
  assert.match(fs.readFileSync(path.join(root, 'src', 'maker', 'hover.js'), 'utf8'),
    /settings \|\| \{\}\)\.steadyRows/, 'hover.js stopped reading steadyRows');
  assert.ok(fs.readFileSync(path.join(root, 'src', 'ui', 'options.html'), 'utf8')
    .includes('id="steadyRows"'), 'options.html has no checkbox for steadyRows');
});

test('the connector picker lines up across storage, views.js and the UI', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

  const defaults = storage.defaultSettings();
  assert.deepStrictEqual(defaults.pickedConnectors, [], 'the picked list should start empty');

  // Which pill is selected is the designer's own state. Storing a copy of it
  // would only give the two somewhere to disagree.
  assert.ok(!('activeView' in defaults), 'the extension is storing a selected filter again');

  // Ticking a connector must not put a copy of it in an exported configuration:
  // the 1,600-odd names the designer has shown live under their own key.
  assert.ok(!('connectorCatalogue' in defaults), 'the catalogue leaked into the settings');

  const options = read('src', 'ui', 'options.html');
  assert.ok(options.includes('id="connectorPicker"'), 'options.html has no connector picker');
  assert.ok(options.includes('id="clearPicked"'), 'options.html has no clear-all button');
  assert.ok(options.includes('id="clearDialog"'), 'the clear-all warning is not there to be shown');
  assert.match(read('src', 'ui', 'options.js'), /pickedConnectors: \[\]/,
    'options.js stopped being able to clear the list');

  // The pills are built from the same list the picker writes.
  assert.match(read('src', 'maker', 'search-service.js'), /views\.list\(settings,/,
    'search-service.js stopped building its pills from the settings');
});

test('settings a previous version stored but this one has retired are dropped', () => {
  // withDefaults copies every stored key, so a retired setting would otherwise
  // live on in storage and ride along in the config export forever.
  const stored = Object.assign(storage.defaultSettings(), {
    displayMode: 'hide', hideIncompatibleGroup: false, colourCode: true
  });
  const loaded = storage.withDefaults(stored, storage.defaultSettings);
  assert.ok('displayMode' in loaded, 'withDefaults itself should not be doing the pruning');

  // getSettings prunes on read; this is the same predicate, without chrome.storage.
  const known = storage.defaultSettings();
  const survivors = Object.keys(loaded).filter((k) => k in known);
  assert.ok(!survivors.includes('displayMode'));
  assert.ok(!survivors.includes('hideIncompatibleGroup'));
  assert.ok(survivors.includes('colourCode'));
});

test('imported settings are given the types their readers expect', () => {
  const clean = storage.sanitiseSettings({
    hideBlocked: 'no',
    colourCode: true,
    colours: { business: 'red; background:url(x)', nonBusiness: '#abc', desktop: 7 },
    pickedConnectors: ['shared_x', 5, null, ''],
    categoryRules: [
      { id: 'x"]{} body{display:none} [a="', label: 'Evil', ids: ['a', 1], tags: 'nope' },
      { id: 'desktop', enabled: false },
      { id: 'desktop' },
      'not a rule',
      { label: 'no id' }
    ]
  });
  assert.strictEqual(clean.hideBlocked, true, 'a non-boolean falls back to the default');
  assert.strictEqual(clean.colourCode, true);
  assert.strictEqual(clean.colours.business, storage.defaultColours().business);
  assert.strictEqual(clean.colours.nonBusiness, '#abc');
  assert.strictEqual(clean.colours.desktop, storage.defaultColours().desktop);
  assert.deepStrictEqual(clean.pickedConnectors, ['shared_x']);
  assert.strictEqual(clean.categoryRules.length, 2, 'duplicates, non-objects and id-less rules go');
  assert.match(clean.categoryRules[0].id, /^[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual(clean.categoryRules[0].ids, ['a']);
  assert.deepStrictEqual(clean.categoryRules[0].tags, []);
  assert.strictEqual(clean.categoryRules[1].enabled, false);
});

test('the default rules survive sanitising unchanged', () => {
  const rules = globalThis.__cdpa.filters.defaultRules();
  assert.deepStrictEqual(globalThis.__cdpa.filters.sanitiseRules(rules), rules);
});
