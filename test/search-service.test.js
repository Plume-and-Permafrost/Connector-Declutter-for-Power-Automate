'use strict';
// search-service.js reaches into the designer's bundle, so what is worth pinning
// is the reaching: that the class is recognised by shape and not by anything that
// changes between deploys, that a class of the wrong shape is left alone, and
// that each of the three patched methods still calls through for the categories
// that are not ours.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPTS = [
  'src/common/log.js',
  'src/common/views.js',
  'src/maker/search-service.js'
];

// Every sandbox's polling timer, so a test that never finds a class cannot keep
// the run alive for the full minute it would otherwise poll for.
const timers = [];
afterEach(() => { while (timers.length) clearInterval(timers.pop()); });

// The designer's search service, to the extent this file touches it: three
// methods, and a lastSearchResults the result cards are resolved through.
function SearchService(options) {
  const opts = options || {};
  function Service() { this.lastSearchResults = null; }
  Service.prototype.getRuntimeCategories = function () {
    return opts.categories === undefined
      ? [{ key: 'ALL', text: 'All' }, { key: 'BUILTIN', text: 'Built-in' }]
      : opts.categories;
  };
  Service.prototype.filterConnector = function (connector, category) {
    Service.filterCalls.push([connector, category]);
    return category === 'BUILTIN';
  };
  Service.prototype.searchOperations = function (term, actionType, category) {
    Service.searchCalls.push(Array.prototype.slice.call(arguments));
    return Promise.resolve(opts.results || [
      operation('shared_sharepointonline'),
      operation('shared_dropbox'),
      operation('shared_teams')
    ]);
  };
  if (opts.missing) delete Service.prototype[opts.missing];
  Service.filterCalls = [];
  Service.searchCalls = [];
  return Service;
}

function operation(name) {
  return { properties: { api: { name: name } } };
}

// What a built-in operation looks like in the catalogue: no api at all, and its
// group named in operationGroup instead.
function builtIn(name) {
  return { properties: { api: null, operationGroup: { name: name } } };
}

function connector(name) {
  return { name: name, properties: { displayName: name } };
}

// Loads the module the way the MAIN content_scripts entry does, then plays the
// part of the bundle: the runtime takes over webpackJsonp.push, a chunk arrives,
// and executing one of its factories is what hands over the require function.
function run(options) {
  const opts = options || {};
  const cache = {};
  const req = { c: cache };
  const posted = [];

  const sandbox = {
    console, Promise, Object, Array, String, JSON,
    // noPoll stands in for the startup poll having long since given up.
    setInterval: opts.noPoll ? () => 0
      : (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; },
    clearInterval: (t) => clearInterval(t),
    setTimeout,
    window: {
      addEventListener: (type, fn) => { if (type === 'message') sandbox.__onMessage = fn; },
      postMessage: (m) => posted.push(m)
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }

  const Service = opts.Service === undefined ? SearchService(opts) : opts.Service;

  // The runtime installs its own callback over the array's push, which is the
  // assignment search-service.js intercepts.
  const jsonp = sandbox.window.webpackJsonp;
  jsonp.push = function (data) {
    const mods = data[1] || {};
    Object.keys(mods).forEach((id) => {
      cache[id] = { exports: {} };
      mods[id](cache[id], cache[id].exports, req);
    });
  };

  if (opts.chunk !== false) {
    jsonp.push([[0], {
      12: (module, exports) => { exports.SearchService = Service; },
      // A module whose exports throw when read: real bundles have getters, and
      // one of them blowing up is not our problem to have.
      34: (module, exports, r) => {
        Object.defineProperty(exports, 'poison', { get() { throw new Error('nope'); },
          enumerable: true });
      }
    }]);
  }

  const push = (settings) => sandbox.__onMessage({
    source: sandbox.window, data: { channel: 'cdpa-maker', type: 'config', settings }
  });
  if (opts.settings) push(opts.settings);

  // Long enough for the 100ms poll to come round at least once.
  return new Promise((r) => setTimeout(r, 250)).then(() => ({
    Service, posted, push, jsonp,
    service: Service ? new Service() : null,
    patched: () => !!Service.prototype.__cdpaPatched,
    keys: () => new Service().getRuntimeCategories().map((c) => c.key)
  }));
}

test('the service is found by shape and given our filters', async () => {
  const r = await run();
  assert.ok(r.patched(), 'the service class was never patched');
  assert.deepStrictEqual(r.keys(),
    ['ALL', 'BUILTIN', 'CDPA_MICROSOFT', 'CDPA_PICKED', 'CDPA_INFLOW']);
});

test('the filters are labelled the way the settings page labels them', async () => {
  const r = await run();
  const added = r.service.getRuntimeCategories().slice(2);
  assert.deepStrictEqual(added.map((c) => c.text), ['Microsoft', 'My Filter', 'In Flow']);
});

test('a class missing any one of the three methods is not it', async () => {
  for (const missing of ['filterConnector', 'getRuntimeCategories', 'searchOperations']) {
    const r = await run({ missing });
    assert.ok(!r.patched(), 'a class with no ' + missing + ' was patched anyway');
  }
});

test('an empty category list is left alone', async () => {
  // Empty means the host has not supplied its localised strings yet and the UI
  // is about to fall back to its own defaults.
  const r = await run({ categories: [] });
  assert.deepStrictEqual(r.keys(), []);
});

test('the designer\'s own categories still go to the designer', async () => {
  const r = await run();
  assert.strictEqual(r.service.filterConnector(connector('shared_dropbox'), 'BUILTIN'), true);
  assert.deepStrictEqual(r.Service.filterCalls.length, 1);
});

test('the Microsoft filter keeps Microsoft products and nothing else', async () => {
  const r = await run();
  const keeps = (name) => r.service.filterConnector(connector(name), 'CDPA_MICROSOFT');
  assert.ok(keeps('shared_sharepointonline'));
  assert.ok(keeps('shared_teams'));
  assert.ok(keeps('Control'), 'the built-ins belong in the Microsoft filter');
  assert.ok(!keeps('shared_dropbox'));
  // Ours are answered here, not passed down.
  assert.strictEqual(r.Service.filterCalls.length, 0);
});

test('"My Filter" is whatever the settings say, as they change', async () => {
  const r = await run();
  const keeps = (name) => r.service.filterConnector(connector(name), 'CDPA_PICKED');
  assert.ok(!keeps('shared_dropbox'), 'nothing is ticked yet');

  r.push({ pickedConnectors: ['shared_dropbox'] });
  assert.ok(keeps('shared_dropbox'));
  assert.ok(!keeps('shared_sharepointonline'));

  r.push({ pickedConnectors: [] });
  assert.ok(!keeps('shared_dropbox'), 'clearing the list did not reach the designer');
});

test('a connector of an unexpected shape is dropped rather than thrown over', async () => {
  const r = await run();
  assert.strictEqual(r.service.filterConnector(null, 'CDPA_MICROSOFT'), false);
  assert.strictEqual(r.service.filterConnector({}, 'CDPA_MICROSOFT'), false);
});

test('searching asks the designer for everything and narrows the answer', async () => {
  const r = await run();
  const found = await r.service.searchOperations('sha', 'action', 'CDPA_MICROSOFT', 'extra');
  assert.deepStrictEqual(found.map((o) => o.properties.api.name),
    ['shared_sharepointonline', 'shared_teams']);
  // A category it does not know would fall through its tag mapper to no filter
  // at all, so the request has to say ALL - and everything after it must survive.
  assert.deepStrictEqual(r.Service.searchCalls, [['sha', 'action', 'ALL', 'extra']]);
});

test('a built-in operation is not lost on the way through a search', async () => {
  // Control, Variable and the rest have properties.api = null, so reading the
  // connector off an operation is not enough to recognise one.
  const r = await run({ results: [
    builtIn('Control'), builtIn('Variable'), operation('shared_teams'),
    builtIn('NotAGroupWeKnow'), operation('shared_dropbox')
  ] });
  const found = await r.service.searchOperations('v', 'action', 'CDPA_MICROSOFT');
  assert.deepStrictEqual(
    found.map((o) => (o.properties.operationGroup || o.properties.api).name),
    ['Control', 'Variable', 'shared_teams']);
});

test('the narrowed results are what a result card resolves against', async () => {
  const r = await run();
  const found = await r.service.searchOperations('sha', 'action', 'CDPA_MICROSOFT');
  assert.strictEqual(r.service.lastSearchResults, found,
    'getOperationById would still be reading the unfiltered list');
});

test('a search in one of the designer\'s own categories is passed straight through', async () => {
  const r = await run();
  const found = await r.service.searchOperations('sha', 'action', 'BUILTIN');
  assert.strictEqual(found.length, 3);
  assert.deepStrictEqual(r.Service.searchCalls, [['sha', 'action', 'BUILTIN']]);
  assert.strictEqual(r.service.lastSearchResults, null, 'the stock path was interfered with');
});

test('patching happens once, however many times the poll comes round', async () => {
  const r = await run();
  const first = r.service.getRuntimeCategories().length;
  await new Promise((res) => setTimeout(res, 250));
  assert.strictEqual(r.service.getRuntimeCategories().length, first,
    'the categories were appended twice');
});

test('a bundle that never arrives is not an error', async () => {
  const r = await run({ chunk: false });
  assert.ok(!r.patched());
});

test('a service that arrives in a later chunk is still found', async () => {
  // The designer's chunk can load long after the startup poll has given up.
  const ctx = await run({ Service: null, noPoll: true });
  const Late = SearchService({});
  ctx.jsonp.push([[1], { 56: (module, exports) => { exports.Late = Late; } }]);
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(Late.prototype.__cdpaPatched, 'the late chunk\'s service was not patched');
});
