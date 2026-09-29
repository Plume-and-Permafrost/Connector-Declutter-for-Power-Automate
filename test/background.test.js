'use strict';
// The service worker is the only writer of chrome.storage. What is pinned here:
// concurrent saves do not lose each other's changes, and a full policy import
// keeps what only the user could have made.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPTS = ['src/common/log.js', 'src/common/env.js', 'src/common/connector-map.js',
  'src/common/policy.js', 'src/common/filters.js', 'src/common/storage.js',
  'src/background/service-worker.js'];

// chrome.storage.local with a real gap between read and write, which is where
// a lost update happens.
function fakeChrome() {
  const data = {};
  const chrome = {};
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));
  return Object.assign(chrome, {
    data,
    storage: {
      local: {
        get: (key) => tick().then(() => ({ [key]: data[key] === undefined ? undefined : JSON.parse(JSON.stringify(data[key])) })),
        set: (obj) => tick().then(() => { Object.assign(data, JSON.parse(JSON.stringify(obj))); })
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      getURL: (p) => 'chrome-extension://abc/' + p,
      onMessage: { addListener: (fn) => { chrome.listener = fn; } },
      onInstalled: { addListener: () => {} }
    }
  });
}

function load() {
  const chrome = fakeChrome();
  const sandbox = { console, Promise, setTimeout, clearTimeout, URL, Date, JSON, Object, chrome };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }
  return { cdpa: sandbox.__cdpa, chrome };
}

test('settings saved at the same moment all land', async () => {
  const { cdpa } = load();
  const keys = ['hideFavourites', 'hideAiCapabilities', 'hideBuiltInTools', 'expandFavourites',
    'steadyRows', 'colourCode', 'autoFetch', 'debug'];
  await Promise.all(keys.map((k) => cdpa.storage.setSettings({ [k]: true })));
  const settings = await cdpa.storage.getSettings();
  for (const k of keys) assert.strictEqual(settings[k], true, k + ' was lost to a concurrent save');
});

test('connectors reported by several frames at once are all kept', async () => {
  const { cdpa } = load();
  await Promise.all([1, 2, 3, 4, 5, 6].map((n) =>
    cdpa.storage.addConnectors([{ name: 'shared_c' + n, displayName: 'C' + n }])));
  assert.strictEqual(Object.keys(await cdpa.storage.getConnectors()).length, 6);
});

test('a full import keeps the manual blocklist', () => {
  const { cdpa } = load();
  const current = cdpa.storage.defaultPolicyStore();
  current.policies = {
    'manual-blocklist': { displayName: 'Manual blocklist', blocked: ['shared_dropbox'] },
    'old-tenant-policy': { displayName: 'Gone from the tenant', blocked: [] }
  };
  const next = cdpa.background.mergeImport(current, {
    replaceAll: true,
    policies: { value: [{ name: 'p1', displayName: 'Tenant policy', environmentType: 'AllEnvironments' }] }
  }, 'auto');
  assert.deepStrictEqual(Object.keys(next.policies).sort(), ['manual-blocklist', 'p1']);
});

test('a policy import and a refresh failure recorded together both land', async () => {
  const { cdpa } = load();
  const h = cdpa.background.handlers;
  await Promise.all([
    h.importPolicies({ payload: { policies: { value: [{ name: 'p1', environmentType: 'AllEnvironments' }] } } }),
    h.recordRefreshFailure()
  ]);
  const store = await cdpa.storage.getPolicyStore();
  assert.ok(store.policies.p1, 'the import was lost');
});

test('an imported configuration is sanitised before it is stored', async () => {
  const { cdpa } = load();
  const result = await cdpa.background.handlers.importConfig({ data: {
    format: 'connector-declutter-for-power-automate/config@1',
    settings: { hideBlocked: 'yes please', categoryRules: [{ id: 'a b"c' }] },
    policyStore: { policies: { broken: { displayName: 'x' } } }
  } });
  assert.ok(result.ok);
  const settings = await cdpa.storage.getSettings();
  assert.strictEqual(settings.hideBlocked, true);
  assert.strictEqual(settings.categoryRules[0].id, 'a_b_c');
  const store = await cdpa.storage.getPolicyStore();
  assert.deepStrictEqual(store.policies.broken.blocked, []);
});

test('only the extension\'s own pages can rewrite settings', async () => {
  const { chrome } = load();
  const ask = (url) => new Promise((resolve) => {
    chrome.listener({ type: 'cdpa:setSettings', patch: { debug: true } }, { url }, resolve);
  });
  const fromPage = await ask('https://make.powerautomate.com/environments/x');
  assert.strictEqual(fromPage.ok, false);
  const fromOptions = await ask('chrome-extension://abc/src/ui/options.html');
  assert.strictEqual(fromOptions.ok, true);
});
