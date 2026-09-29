'use strict';
// hover.js is one static stylesheet, so what is worth pinning is what that sheet
// says: that the reserved box is the same box the designer gives these buttons on
// hover, and that nothing is revealed the designer would have kept hidden.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./dom-shim.js');

const SCRIPTS = ['src/common/log.js', 'src/maker/hover.js'];
const STYLE_ID = 'cdpa-steady-rows-style';

function run(settings) {
  const dom = makeDocument();
  const sandbox = {
    console, setTimeout, clearTimeout, Map, Promise, JSON,
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    window: { addEventListener: (t, fn) => { if (t === 'message') sandbox.__onMessage = fn; } },
    document: dom.document
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }
  const push = (s) => sandbox.__onMessage({
    source: sandbox.window, data: { channel: 'cdpa-maker', type: 'config', settings: s }
  });
  push(settings);
  return {
    push,
    style: () => dom.document.getElementById(STYLE_ID),
    css: () => {
      const style = dom.document.getElementById(STYLE_ID);
      return style ? style.textContent : null;
    }
  };
}

test('nothing is injected until the setting is on', () => {
  assert.strictEqual(run({ colourCode: true }).css(), null);
});

test('the space is reserved with the same display the designer sets on hover', () => {
  // The designer's own rule flips these from display:none to display:inline. Any
  // other value would reserve a different box from the one hover produces, which
  // is the whole bug.
  const css = run({ steadyRows: true }).css();
  assert.match(css, /\{display:inline !important;visibility:hidden\}/);
  assert.doesNotMatch(css, /display:(block|flex|inline-block|inline-flex)/);
});

test('both hover-only controls are covered', () => {
  const css = run({ steadyRows: true }).css();
  for (const cls of ['.info-dot-visible-on-hover', '.favorite-button-visible-on-hover']) {
    assert.ok(css.includes(cls), css + ' does not mention ' + cls);
  }
});

test('they are revealed on exactly the states the designer reveals them on', () => {
  // :focus and :focus-within as well as :hover - keyboard users get the same
  // controls, and leaving one out would hide a control that is there today.
  const reveal = run({ steadyRows: true }).css().split('{display:inline')[1];
  for (const state of [':hover', ':focus', ':focus-within']) {
    assert.ok(reveal.includes(state), 'no rule reveals them on ' + state);
  }
  assert.match(reveal, /\{visibility:visible\}$/);
});

test('the rules are scoped to a connector card', () => {
  // The class names are the designer's, not ours; scoping to the card keeps this
  // off anything else that happens to use them.
  const css = run({ steadyRows: true }).css();
  for (const part of css.split('}').filter(Boolean)) {
    for (const selector of part.split('{')[0].split(',')) {
      assert.match(selector, /^\[data-automation-id\^="flow-op-search-result-"\]/,
        selector + ' is not scoped to a connector card');
    }
  }
});

test('shadows are left alone', () => {
  // A shadow never takes part in layout, so removing it would cost the hover
  // affordance and fix nothing.
  assert.doesNotMatch(run({ steadyRows: true }).css(), /shadow/i);
});

test('turning the setting off takes the stylesheet away', () => {
  const r = run({ steadyRows: true });
  assert.ok(r.style());
  r.push({ steadyRows: false });
  assert.strictEqual(r.style(), null);
});

test('a re-pushed config does not stack up stylesheets', () => {
  const r = run({ steadyRows: true });
  const first = r.style();
  r.push({ steadyRows: true });
  assert.strictEqual(r.style(), first);
});
