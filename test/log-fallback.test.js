'use strict';
// Regression guard for a real failure seen in the field: log.js did not run in
// the content-script isolated worlds, so `__cdpa.log.create(...)` threw at load
// and took bridge.js, decorate.js and import-ui.js down with it. Filtering
// stopped completely because a *debug* switch could not be reached.
//
// Every module now carries a silent fallback, so the rule is: with log.js
// absent, the extension still loads and still filters - it just says nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

// One realm holding every module except log.js, mimicking the broken load.
function realmWithoutLog() {
  const ctx = { console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Map, Set,
    RegExp, Error, URL, Array, Object, String, Number, Boolean, WeakMap, Reflect };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const rel of ['common/env.js', 'common/connector-map.js', 'common/policy.js',
    'common/filters.js', 'common/storage.js', 'common/paginate.js']) {
    const file = path.join(SRC, rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  return ctx.__cdpa;
}

test('every module still loads when log.js is missing', () => {
  const cdpa = realmWithoutLog();
  for (const name of ['env', 'connectorMap', 'policy', 'filters', 'storage', 'paginate']) {
    assert.ok(cdpa[name], name + ' failed to load without log.js');
  }
});

test('the fallback logger answers the whole log.js surface', () => {
  const cdpa = realmWithoutLog();
  const log = cdpa.log.create('anything');
  assert.strictEqual(log.enabled, false);
  for (const method of ['debug', 'info', 'warn', 'error']) {
    assert.doesNotThrow(() => log[method]('a', 1, {}), method + ' threw');
  }
  // log.time returns the function callers invoke to close the measurement.
  assert.strictEqual(typeof log.time('label'), 'function');
  assert.doesNotThrow(() => log.time('label')('suffix'));
  for (const method of ['setEnabled', 'mirrorToPage', 'watchStorage']) {
    assert.doesNotThrow(() => cdpa.log[method](true), method + ' threw');
  }
});

test('filtering still works with logging absent', () => {
  const cdpa = realmWithoutLog();
  const store = {
    policies: {
      p1: {
        displayName: 'P', environmentType: 'AllEnvironments', environments: [],
        defaultClassification: 'General',
        blocked: ['shared_dropbox'], business: [], nonBusiness: []
      }
    },
    unblockable: [], virtual: []
  };
  const resolved = cdpa.policy.resolveForEnvironment(store, 'abc');
  assert.ok(cdpa.policy.isGroupBlocked(resolved, 'shared_dropbox'));
  assert.ok(!cdpa.policy.isGroupBlocked(resolved, 'shared_sharepointonline'));

  const rules = cdpa.filters.compile(cdpa.filters.defaultRules());
  const desktop = { name: 'shared_uiflow', properties: { displayName: 'Desktop flows', tags: [] } };
  assert.strictEqual(cdpa.filters.hiddenBy(desktop, rules), 'desktop');
});

test('the real logger is kept when log.js did load first', () => {
  // helpers.js loads log.js ahead of everything, so the fallback must not have
  // overwritten it - otherwise turning debug on would silently do nothing.
  require('./helpers.js');
  assert.strictEqual(typeof globalThis.__cdpa.log.isEnabled, 'function',
    'a fallback stub replaced the real logger');
});
