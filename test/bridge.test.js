'use strict';
// bridge.js is the isolated-world half, and the only way page context reaches
// storage. Anything on the page can post to its channel, so what is pinned here
// is which page messages it believes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(settings) {
  const sent = [];
  const posted = [];
  let onMessage = null;
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        const replies = {
          'cdpa:getSettings': settings,
          'cdpa:getPolicyStore': { policies: {} },
          'cdpa:shouldRefresh': { should: true }
        };
        setTimeout(() => cb({ ok: true, result: replies[msg.type] || { ok: true } }), 0);
      }
    },
    storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } }
  };
  const sandbox = { console, Promise, setTimeout, clearTimeout, Date, chrome,
    location: { origin: 'https://make.powerautomate.com' } };
  sandbox.window = {
    addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; },
    postMessage: (m) => posted.push(m)
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['src/iso/log.js', 'src/maker/bridge.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }
  const page = (data) => onMessage({ source: sandbox.window, data: Object.assign({ channel: 'cdpa-maker' }, data) });
  const types = () => sent.map((m) => m.type);
  return { page, sent, posted, types };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const POLICIES = { policies: { value: [{ name: 'p1' }] }, replaceAll: true };

test('an import nobody asked for is ignored', async () => {
  const b = load({ autoFetch: true });
  await settle();
  b.page({ type: 'importPolicies', payload: POLICIES });
  b.page({ type: 'refreshFailed' });
  await settle();
  assert.ok(!b.types().includes('cdpa:importPolicies'));
  assert.ok(!b.types().includes('cdpa:recordRefreshFailure'));
});

test('an import after the bridge allowed a refresh is stored, once', async () => {
  const b = load({ autoFetch: true });
  await settle();
  b.page({ type: 'ask', ask: 'shouldRefresh', id: 1 });
  await settle();
  b.page({ type: 'importPolicies', payload: POLICIES });
  b.page({ type: 'importPolicies', payload: POLICIES });
  await settle();
  assert.strictEqual(b.types().filter((t) => t === 'cdpa:importPolicies').length, 1);
});

test('with auto-fetch off, a refresh is never allowed', async () => {
  const b = load({ autoFetch: false });
  await settle();
  b.page({ type: 'ask', ask: 'shouldRefresh', id: 1 });
  await settle();
  assert.ok(!b.types().includes('cdpa:shouldRefresh'));
  assert.strictEqual(JSON.stringify(b.posted.find((m) => m.type === 'answer').result), '{"should":false}');
});

test('connector reports are cleaned before they are stored', async () => {
  const b = load({});
  await settle();
  b.page({ type: 'connectorsSeen', connectors: [
    { name: 'shared_ok', displayName: 'OK' }, { name: 5 }, null, { name: 'x'.repeat(300) }
  ] });
  await settle();
  const report = b.sent.find((m) => m.type === 'cdpa:rememberConnectors');
  assert.strictEqual(JSON.stringify(report.connectors), JSON.stringify([{ name: 'shared_ok', displayName: 'OK' }]));
});
