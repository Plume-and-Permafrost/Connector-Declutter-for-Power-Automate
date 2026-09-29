'use strict';
// decorate.js runs in page context against a DOM, so it gets a shim rather than a
// plain require. What is worth pinning is the CSS it emits, which rows it marks,
// and that the key lands in the panel header.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { El, makeDocument } = require('./dom-shim.js');
const { rawPolicy, group, storeFrom } = require('./helpers.js');

const ENV = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const SCRIPTS = ['src/common/log.js', 'src/common/env.js', 'src/common/connector-map.js',
  'src/common/policy.js', 'src/common/filters.js', 'src/maker/decorate.js'];

// The real panel: a header carrying the breadcrumb and the close button, then the
// connector rows. Same automation ids as the saved designer page.
function buildPage(automationIds, withPanel) {
  const dom = makeDocument();
  if (withPanel !== false) {
    const header = new El('div');
    header.setAttribute('data-automation-id', 'flow-app-action-header');
    header.appendChild(new El('nav'));
    const close = new El('button');
    close.setAttribute('data-automation-id', 'flow-panel-header-close');
    header.appendChild(close);
    dom.body.appendChild(header);
    dom.header = header;
    dom.close = close;
  }
  dom.rows = automationIds.map((id) => {
    const row = new El('div');
    row.setAttribute('data-automation-id', id);
    dom.body.appendChild(row);
    return row;
  });
  return dom;
}

// Loads decorate.js beside the same modules the MAIN content_scripts entry gives it,
// pushes one config message, and lets the coalescing timer fire.
function run(dom, settings, store, catalogue, popover) {
  // Present only when the test asks for it, so both the popover path and the
  // title-attribute fallback get exercised.
  function FakeHTMLElement() {}
  if (popover) FakeHTMLElement.prototype.showPopover = El.prototype.showPopover;

  const sandbox = {
    console, setTimeout, clearTimeout, Map, Promise,
    HTMLElement: FakeHTMLElement,
    location: { pathname: '/environments/' + ENV + '/flows/x' },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    window: { addEventListener: (t, fn) => { if (t === 'message') sandbox.__onMessage = fn; } },
    document: dom.document
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }
  // What interceptor.js would have stashed as the designer fetched the catalogue.
  if (catalogue) sandbox.__cdpa.catalogue = catalogue;
  const push = (s) => sandbox.__onMessage({
    source: sandbox.window, data: { channel: 'cdpa-maker', type: 'config', settings: s, store }
  });
  push(settings);
  return new Promise((resolve) => setTimeout(() => resolve({
    push,
    settle: () => new Promise((r) => setTimeout(r, 150)),
    style: dom.document.getElementById('cdpa-classification-style'),
    key: dom.document.getElementById('cdpa-classification-key'),
    css: (dom.document.getElementById('cdpa-classification-style') || {}).textContent
  }), 150));
}

const store = storeFrom(rawPolicy({
  environments: [{ name: ENV }],
  defaultConnectorsClassification: 'General',
  connectorGroups: [group('Confidential', ['shared_sharepointonline', 'shared_office365'])]
}));

const RULES = globalThis.__cdpa.filters.defaultRules();
const ON = { colourCode: true, categoryRules: RULES };
const SHOW_ALL = { colourCode: true, categoryRules: RULES, showEverything: true };
const OFFICE = 'flow-op-search-result-_providers_microsoft_powerapps_apis_shared_office365';
const id = (name) => 'flow-op-search-result-_providers_microsoft_powerapps_apis_' + name;

test('the tint is a background-image, never a background-color', async () => {
  // The designer's card sets background-color from a Griffel atomic class, inserted
  // at runtime and therefore after our sheet. At equal specificity later wins, so a
  // background-color tint is silently erased on the live page - which is exactly what
  // happened. background-image is a different longhand and Griffel forbids shorthands,
  // so nothing the designer emits can reset it.
  const { css } = await run(buildPage([OFFICE]), ON, store);
  assert.match(css, /\[data-cdpa-classification="Confidential"\]\{background-image:linear-gradient\(/);
  assert.doesNotMatch(css.split('#cdpa-classification-key')[0], /background-color/,
    'a background-color tint loses to the designer\'s own card styling');
});

test('rows are classified from their automation id alone', async () => {
  const dom = buildPage([
    OFFICE,
    'flow-op-search-result-_providers_microsoft_processsimple_operationgroups_shared_sharepointonline',
    'flow-op-search-result-_providers_microsoft_powerapps_apis_shared_dropbox',
    'flow-op-search-result-_providers_microsoft_processsimple_operationgroups_shared_office365_operations_sendemail'
  ]);
  await run(dom, ON, store);
  const seen = dom.rows.map((r) => r.getAttribute('data-cdpa-classification'));
  // The last id is an operation hanging off a group; it takes the group's colour.
  assert.deepStrictEqual(seen, ['Confidential', 'Confidential', 'General', 'Confidential']);
});

test('the key sits between the breadcrumb and the close button', async () => {
  const dom = buildPage([OFFICE]);
  const { key } = await run(dom, ON, store);
  assert.ok(key, 'no key was added to the panel header');
  assert.strictEqual(key.parentNode, dom.header);
  assert.strictEqual(dom.header.children.indexOf(key), dom.header.children.indexOf(dom.close) - 1);
});

test('the key names both classifications and is reachable without a mouse', async () => {
  const { key } = await run(buildPage([OFFICE]), ON, store);
  const dots = key.children;
  assert.strictEqual(dots.length, 2);
  assert.deepStrictEqual(dots.map((d) => d.getAttribute('data-cdpa-key')), ['Confidential', 'General']);
  assert.deepStrictEqual(dots.map((d) => d.getAttribute('data-cdpa-tip')),
    ['Business (Confidential)', 'Non-business (General)']);
  dots.forEach((d) => {
    // A tooltip only a mouse can reach is not a tooltip for everyone.
    assert.strictEqual(d.getAttribute('tabindex'), '0');
    assert.strictEqual(d.getAttribute('aria-label'), d.getAttribute('data-cdpa-tip'));
    assert.strictEqual(d.getAttribute('role'), 'img');
  });
});

test('the key is rebuilt when the designer re-renders the header', async () => {
  const dom = buildPage([OFFICE]);
  const r = await run(dom, ON, store);
  dom.header.removeChild(r.key); // what a React re-render of the header looks like
  r.push(ON);                    // any config push triggers another pass
  await r.settle();
  const rebuilt = dom.document.getElementById('cdpa-classification-key');
  assert.ok(rebuilt && rebuilt.parentNode === dom.header, 'the key did not come back');
});

test('a missing panel header is not an error', async () => {
  const dom = buildPage([OFFICE], false);
  const { key } = await run(dom, ON, store);
  assert.strictEqual(key, null);
  // Rows still get tinted; the key is a caption, not a precondition.
  assert.strictEqual(dom.rows[0].getAttribute('data-cdpa-classification'), 'Confidential');
});

test('nothing is touched while colour coding is off', async () => {
  const dom = buildPage([OFFICE]);
  const { key, style } = await run(dom, { colourCode: false }, store);
  assert.strictEqual(dom.rows[0].getAttribute('data-cdpa-classification'), null);
  assert.strictEqual(style, null, 'no stylesheet should be injected when the setting is off');
  assert.strictEqual(key, null);
});

test('turning colour coding off again clears up after itself', async () => {
  const dom = buildPage([OFFICE]);
  const r = await run(dom, ON, store);
  assert.ok(r.key);
  r.push({ colourCode: false });
  await r.settle();
  assert.strictEqual(dom.document.getElementById('cdpa-classification-key'), null);
  assert.strictEqual(dom.rows[0].getAttribute('data-cdpa-classification'), null);
});

// --- hide reasons under "show everything" ----------------------------------

const blockedStore = storeFrom(rawPolicy({
  environments: [{ name: ENV }],
  defaultConnectorsClassification: 'General',
  connectorGroups: [
    group('Confidential', ['shared_office365']),
    group('Blocked', ['shared_dropbox'])
  ]
}));

test('with "show everything" on, a row says why it would have been hidden', async () => {
  const dom = buildPage([
    OFFICE,                          // allowed, Business
    id('shared_dropbox'),            // blocked by DLP
    id('shared_uiflow'),             // desktop rule, by id; not blocked here
    id('shared_githubmcp'),          // agentic rule, by the mcp pattern
    id('shared_rss')                 // allowed, Non-business by default
  ]);
  await run(dom, SHOW_ALL, blockedStore);
  assert.deepStrictEqual(dom.rows.map((r) => r.getAttribute('data-cdpa-classification')),
    ['Confidential', 'Blocked', 'rule:desktop', 'rule:agentic', 'General']);
});

test('the DLP blocklist outranks a category rule', async () => {
  // shared_powervirtualagents is in the agentic rule and blocked as well. DLP is the
  // constraint the user cannot lift from the panel, so it is the one that shows.
  const store = storeFrom(rawPolicy({
    environments: [{ name: ENV }],
    connectorGroups: [group('Blocked', ['shared_powervirtualagents'])]
  }));
  const dom = buildPage([id('shared_powervirtualagents')]);
  await run(dom, SHOW_ALL, store);
  assert.strictEqual(dom.rows[0].getAttribute('data-cdpa-classification'), 'Blocked');
});

test('a category rule colours what it catches when DLP allows it', async () => {
  // The other half of the same rule: not blocked, so the rule's own colour shows.
  const dom = buildPage([id('shared_agentsdk'), id('shared_uiflow')]);
  await run(dom, SHOW_ALL, storeFrom(rawPolicy({
    environments: [{ name: ENV }], defaultConnectorsClassification: 'General',
    connectorGroups: []
  })));
  assert.deepStrictEqual(dom.rows.map((r) => r.getAttribute('data-cdpa-classification')),
    ['rule:agentic', 'rule:desktop']);
});

test('hide reasons stay off while "show everything" is off', async () => {
  // With it off, anything still on screen is there because the user disabled that
  // rule - so it takes its ordinary DLP colour, not a "would be hidden" one.
  const dom = buildPage([id('shared_uiflow'), id('shared_dropbox')]);
  await run(dom, ON, blockedStore);
  assert.deepStrictEqual(dom.rows.map((r) => r.getAttribute('data-cdpa-classification')),
    ['General', null]);
});

test('a group is matched by tag through the catalogue the interceptor stashed', async () => {
  // The DOM exposes no tags at all, so a DesktopFlow-tagged group can only be
  // recognised from what the catalogue response said about it.
  const dom = buildPage([id('shared_somethingnew')]);
  const stash = new Map([['shared_somethingnew',
    { name: 'shared_somethingnew', displayName: 'Something New', tags: ['DesktopFlow'] }]]);
  await run(dom, SHOW_ALL, blockedStore, stash);
  assert.strictEqual(dom.rows[0].getAttribute('data-cdpa-classification'), 'rule:desktop');
});

test('without the stash, the display name in the DOM still matches a pattern rule', async () => {
  const dom = buildPage([id('shared_contosothing')]);
  dom.rows[0].setAttribute('aria-label', 'Contoso Copilot');
  await run(dom, SHOW_ALL, blockedStore);
  assert.strictEqual(dom.rows[0].getAttribute('data-cdpa-classification'), 'rule:agentic');
});

test('a rule the user invented gets a tint and a key entry, not a crash', async () => {
  const custom = RULES.concat([{ id: 'mine', label: 'My own rule', enabled: true,
    ids: ['shared_rss'], tags: [], pattern: '' }]);
  const dom = buildPage([id('shared_rss')]);
  const { key, css } = await run(dom, Object.assign({}, SHOW_ALL, { categoryRules: custom }), blockedStore);
  assert.strictEqual(dom.rows[0].getAttribute('data-cdpa-classification'), 'rule:mine');
  assert.match(css, /\[data-cdpa-classification="rule:mine"\]\{background-image:/);
  assert.ok(key.children.some((d) => d.getAttribute('data-cdpa-tip') === 'My own rule'));
});

// --- the key follows the legend --------------------------------------------

test('the key lists only the two classifications until "show everything" is on', async () => {
  const { key } = await run(buildPage([OFFICE]), ON, blockedStore);
  assert.deepStrictEqual(key.children.map((d) => d.getAttribute('data-cdpa-key')),
    ['Confidential', 'General']);
});

test('"show everything" adds a dot per hide reason, named by the rule', async () => {
  const { key } = await run(buildPage([OFFICE]), SHOW_ALL, blockedStore);
  // Blocked before the rules: the same order valueFor decides in, so reading the key
  // left to right reads as "the first of these that applies".
  assert.deepStrictEqual(key.children.map((d) => d.getAttribute('data-cdpa-key')),
    ['Confidential', 'General', 'Blocked', 'rule:desktop', 'rule:agentic']);
  assert.deepStrictEqual(key.children.map((d) => d.getAttribute('data-cdpa-tip')),
    ['Business (Confidential)', 'Non-business (General)', 'Blocked by your DLP policy',
     RULES[0].label, RULES[1].label]);
});

test('toggling "show everything" rebuilds the key and re-judges the rows', async () => {
  const dom = buildPage([id('shared_dropbox')]);
  const r = await run(dom, ON, blockedStore);
  assert.strictEqual(r.key.children.length, 2);
  assert.strictEqual(dom.rows[0].getAttribute('data-cdpa-classification'), null);

  r.push(SHOW_ALL);
  await r.settle();
  assert.strictEqual(dom.document.getElementById('cdpa-classification-key').children.length, 5);
  assert.strictEqual(dom.rows[0].getAttribute('data-cdpa-classification'), 'Blocked');
});

// --- the tooltip ------------------------------------------------------------

test('the tooltip is a top-layer popover, not a positioned pseudo-element', async () => {
  // The panel's search bar sits in a stacking context that paints above the
  // header's, so an absolutely positioned tooltip goes behind it however high its
  // z-index. Only the top layer is outside that ordering - and outside any
  // overflow clipping on the way up.
  const dom = buildPage([OFFICE]);
  const { key, css } = await run(dom, ON, store, null, true);
  const dot = key.children[0];
  dot.rect = { left: 500, top: 20, right: 512, bottom: 32, width: 12, height: 12 };

  dot.dispatch('mouseenter');
  const tip = dom.document.getElementById('cdpa-classification-tip');
  assert.ok(tip, 'no tooltip element was created');
  assert.strictEqual(tip.getAttribute('popover'), 'manual');
  assert.strictEqual(tip.parentNode, dom.body, 'the tooltip must not live inside the panel');
  assert.strictEqual(tip.textContent, 'Business (Confidential)');
  assert.strictEqual(tip.popoverOpen, true);
  assert.doesNotMatch(css, /z-index/, 'z-index cannot win this fight; it should not be relied on');

  dot.dispatch('mouseleave');
  assert.strictEqual(tip.popoverOpen, false);
});

test('the tooltip is right-aligned to its dot and kept on screen', async () => {
  const dom = buildPage([OFFICE]);
  const { key } = await run(dom, ON, store, null, true);
  const dot = key.children[0];
  dot.rect = { left: 500, top: 20, right: 512, bottom: 32, width: 12, height: 12 };

  dot.dispatch('mouseenter');
  const tip = dom.document.getElementById('cdpa-classification-tip');
  tip.rect = { width: 160, height: 22, left: 0, top: 0, right: 160, bottom: 22 };
  dot.dispatch('mouseleave');
  dot.dispatch('mouseenter');
  assert.strictEqual(tip.style.left, (512 - 160) + 'px', 'not right-aligned to the dot');
  assert.strictEqual(tip.style.top, (32 + 6) + 'px', 'not placed below the dot');

  // A dot near the left edge must not push the tooltip off it.
  dot.rect = { left: 4, top: 20, right: 16, bottom: 32, width: 12, height: 12 };
  dot.dispatch('mouseleave');
  dot.dispatch('mouseenter');
  assert.strictEqual(tip.style.left, '8px');
});

test('keyboard focus shows the tooltip too', async () => {
  const dom = buildPage([OFFICE]);
  const { key } = await run(dom, ON, store, null, true);
  key.children[1].dispatch('focus');
  const tip = dom.document.getElementById('cdpa-classification-tip');
  assert.strictEqual(tip.textContent, 'Non-business (General)');
  key.children[1].dispatch('blur');
  assert.strictEqual(tip.popoverOpen, false);
});

test('without popover support the dots fall back to a title tooltip', async () => {
  const { key } = await run(buildPage([OFFICE]), ON, store, null, false);
  assert.deepStrictEqual(key.children.map((d) => d.getAttribute('title')),
    ['Business (Confidential)', 'Non-business (General)']);
});

test('turning colour coding off takes the tooltip with it', async () => {
  const dom = buildPage([OFFICE]);
  const r = await run(dom, ON, store, null, true);
  r.key.children[0].dispatch('mouseenter');
  assert.ok(dom.document.getElementById('cdpa-classification-tip'));

  r.push({ colourCode: false });
  await r.settle();
  assert.strictEqual(dom.document.getElementById('cdpa-classification-tip'), null,
    'the tooltip was left behind in the page');
});

test('virtual groups are recognised from their lowercased DOM name', async () => {
  // The DOM says "http" and "virtualagent"; the policy says Http and PvaAuth…
  // Matching them case-sensitively left every virtual connector untinted.
  const virtualStore = storeFrom(rawPolicy({
    environments: [{ name: ENV }],
    defaultConnectorsClassification: 'General',
    connectorGroups: [
      group('Blocked', ['Http', 'HttpWebhook']),
      group('Confidential', ['HttpRequestReceived'])
    ]
  }));
  const og = (name) => 'flow-op-search-result-_providers_microsoft_processsimple_operationgroups_' + name;
  const dom = buildPage([og('http'), og('request')]);
  await run(dom, SHOW_ALL, virtualStore);
  assert.deepStrictEqual(dom.rows.map((r) => r.getAttribute('data-cdpa-classification')),
    ['Blocked', 'Confidential']);
});

test('a rule id cannot break out of the generated CSS', async () => {
  const evil = [{ id: 'x"]{}body{display:none}[a="', label: 'Evil', enabled: true, ids: [], tags: [], pattern: '' }];
  const { css } = await run(buildPage([OFFICE]), { colourCode: true, showEverything: true, categoryRules: evil }, store);
  // The quote inside the id is escaped, so the whole id stays one attribute value.
  assert.ok(css.includes('[data-cdpa-classification="rule:x\\"]{}body{display:none}[a=\\""]{'),
    'the id closed the selector');
});
