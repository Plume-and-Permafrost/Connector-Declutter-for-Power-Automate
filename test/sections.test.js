'use strict';
// sections.js runs in page context against a DOM, so it gets the shim rather than
// a plain require. What is worth pinning is which accordion item it recognises,
// that it only ever hides one the settings asked for, and that opening Favourites
// is offered once rather than fought over with the user.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { El, makeDocument } = require('./dom-shim.js');

const SCRIPTS = ['src/common/log.js', 'src/maker/sections.js'];

// One accordion section, with the same nesting and the same class names as the
// saved designer page: the heading is a span *beside* the expand icon, so it is
// only readable off the button's whole text, and "See all" is a sibling of the
// heading rather than a child of the collapsible panel.
function section(heading, options) {
  const opts = options || {};
  const item = new El('div');
  item.className = 'fui-AccordionItem ___unj38t0 fbxl46w f1eybr6b';

  const wrapper = new El('div');
  const header = new El('div');
  header.className = 'fui-AccordionHeader ___lc5ldk0 f19n0e5';

  const button = new El('button');
  button.className = 'fui-AccordionHeader__button ___ecb1fz0 f1ewtqcl';
  button.setAttribute('aria-expanded', opts.expanded === false ? 'false' : 'true');

  const icon = new El('span');
  icon.className = 'fui-AccordionHeader__expandIcon';
  const label = new El('span');
  label.className = 'fui-Text';
  label.textContent = heading;

  button.appendChild(icon);
  button.appendChild(label);
  header.appendChild(button);
  wrapper.appendChild(header);

  // Absent in the designer when the section is short enough to show whole.
  if (opts.seeAll !== false) {
    const seeAll = new El('button');
    seeAll.className = 'fui-Link ___cczths0 f2hkw1w';
    seeAll.textContent = 'See all (9)';
    seeAll.clicks = 0;
    seeAll.addEventListener('click', () => { seeAll.clicks++; });
    wrapper.appendChild(seeAll);
    item.seeAll = seeAll;
  }

  const panel = new El('div');
  panel.className = 'fui-AccordionPanel';
  // A connector row's own link, to prove "See all" is found beside the heading
  // rather than anywhere in the item.
  const rowLink = new El('button');
  rowLink.className = 'fui-Link';
  rowLink.clicks = 0;
  rowLink.addEventListener('click', () => { rowLink.clicks++; });
  panel.appendChild(rowLink);
  item.rowLink = rowLink;

  item.appendChild(wrapper);
  item.appendChild(panel);

  // The real accordion toggles itself on click; counting them is how "offered
  // once" is checked.
  button.clicks = 0;
  button.addEventListener('click', () => {
    button.clicks++;
    button.setAttribute('aria-expanded',
      button.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
  });

  item.button = button;
  return item;
}

// The panel's own header, carrying the breadcrumb and the close button. Its
// presence is what tells sections.js the panel is still open.
function panelHeader() {
  const header = new El('div');
  header.setAttribute('data-automation-id', 'flow-app-action-header');
  return header;
}

function accordionOf(headings) {
  const accordion = new El('div');
  accordion.className = 'fui-Accordion';
  accordion.items = (headings || []).map((h) => {
    const item = section(h.heading === undefined ? h : h.heading, h);
    accordion.appendChild(item);
    return item;
  });
  return accordion;
}

function buildPanel(headings) {
  const dom = makeDocument();
  dom.panelHeader = panelHeader();
  dom.body.appendChild(dom.panelHeader);
  dom.accordion = accordionOf(headings);
  dom.body.appendChild(dom.accordion);
  dom.items = dom.accordion.items;
  return dom;
}

// Loads sections.js beside the logger the MAIN content_scripts entry gives it,
// pushes one config message, and lets the coalescing timer fire.
function run(dom, settings) {
  const sandbox = {
    console, setTimeout, clearTimeout, Map, Promise, JSON,
    // Captured rather than ignored: the DOM changing is the only thing that
    // drives a pass once the settings have stopped moving.
    MutationObserver: function (cb) {
      sandbox.__mutation = cb;
      this.observe = () => {};
      this.disconnect = () => { sandbox.__mutation = null; };
    },
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
  const settle = () => new Promise((r) => setTimeout(r, 150));
  push(settings);
  return settle().then(() => ({
    push,
    settle,
    // What the real MutationObserver would do after the designer re-rendered.
    mutate: () => { if (sandbox.__mutation) sandbox.__mutation(); return settle(); },
    marks: () => dom.items.map((i) => i.getAttribute('data-cdpa-section')),
    css: () => {
      const style = dom.document.getElementById('cdpa-section-style');
      return style ? style.textContent : null;
    }
  }));
}

const PANEL = [
  { heading: 'Favorites', expanded: false },
  { heading: 'AI capabilities', expanded: true },
  { heading: 'Built-in tools', expanded: true }
];

test('nothing is touched while every section setting is off', async () => {
  const dom = buildPanel(PANEL);
  const r = await run(dom, { hideBlocked: true, colourCode: true });
  assert.strictEqual(r.css(), null, 'a stylesheet was injected with nothing to hide');
  assert.deepStrictEqual(r.marks(), [null, null, null]);
});

test('each section is recognised, and only the ones asked for are hidden', async () => {
  const dom = buildPanel(PANEL);
  const r = await run(dom, { hideBuiltInTools: true });
  assert.deepStrictEqual(r.marks(), ['favourites', 'ai', 'builtin'],
    'every accordion item is marked, hidden or not');
  assert.strictEqual(r.css(), '[data-cdpa-section="builtin"]{display:none !important}');
});

test('hiding all three emits one rule each', async () => {
  const dom = buildPanel(PANEL);
  const r = await run(dom, {
    hideFavourites: true, hideAiCapabilities: true, hideBuiltInTools: true
  });
  assert.strictEqual(r.css(),
    '[data-cdpa-section="favourites"]{display:none !important}' +
    '[data-cdpa-section="ai"]{display:none !important}' +
    '[data-cdpa-section="builtin"]{display:none !important}');
});

test('display:none is important, because the item styles itself at runtime', async () => {
  // The item's own display comes from a Griffel atomic class inserted with
  // insertRule, so it always lands after this sheet and wins at equal specificity -
  // the same trap decorate.js documents for the row tints.
  const r = await run(buildPanel(PANEL), { hideFavourites: true });
  assert.match(r.css(), /display:none !important/);
});

test('the heading is read through spelling, case and punctuation', async () => {
  const dom = buildPanel(['Favourites', 'AI Capabilities', 'BUILT IN TOOLS']);
  const r = await run(dom, { hideFavourites: true });
  assert.deepStrictEqual(r.marks(), ['favourites', 'ai', 'builtin']);
});

test('a heading it does not recognise is left visible', async () => {
  // Only the English headings are known, so a designer in another language must
  // keep all three sections rather than lose the wrong one.
  const dom = buildPanel(['Favoris', 'Fonctionnalités IA', 'Outils intégrés']);
  const r = await run(dom, {
    hideFavourites: true, hideAiCapabilities: true, hideBuiltInTools: true
  });
  assert.deepStrictEqual(r.marks(), ['other', 'other', 'other']);
  // The rules are still emitted; nothing in the panel carries the values they match.
  assert.doesNotMatch(r.css(), /"other"/);
});

test('opening Favourites clicks "See all", not the heading', async () => {
  // Expanding the section shows the first few favourites; only "See all" shows
  // them all, which is what the setting is for.
  const dom = buildPanel(PANEL);
  await run(dom, { expandFavourites: true });
  const favourites = dom.items[0];
  assert.strictEqual(favourites.seeAll.clicks, 1);
  assert.strictEqual(favourites.button.clicks, 0, 'the section was expanded as well');
  assert.strictEqual(favourites.rowLink.clicks, 0,
    'a link inside a connector row was mistaken for "See all"');
});

test('only the Favourites section is opened', async () => {
  const dom = buildPanel(PANEL);
  await run(dom, { expandFavourites: true });
  assert.strictEqual(dom.items[1].seeAll.clicks, 0);
  assert.strictEqual(dom.items[2].seeAll.clicks, 0);
});

test('with no "See all" link, a collapsed Favourites section is expanded instead', async () => {
  // The link is absent when nothing is truncated; then the accordion is all there is.
  const dom = buildPanel([{ heading: 'Favorites', expanded: false, seeAll: false }]);
  await run(dom, { expandFavourites: true });
  assert.strictEqual(dom.items[0].button.clicks, 1);
  assert.strictEqual(dom.items[0].button.getAttribute('aria-expanded'), 'true');
});

test('with no "See all" link and the section already open, nothing is clicked', async () => {
  const dom = buildPanel([{ heading: 'Favorites', expanded: true, seeAll: false }]);
  await run(dom, { expandFavourites: true });
  assert.strictEqual(dom.items[0].button.clicks, 0);
});

test('navigating back out of the full list does not throw the user into it again', async () => {
  // Clicking "See all" replaces the sections with the favourites list, so the
  // accordion goes away and comes back when the user navigates back. The panel
  // header stays put throughout, which is what the latch is keyed on.
  const dom = buildPanel(PANEL);
  const r = await run(dom, { expandFavourites: true });
  assert.strictEqual(dom.items[0].seeAll.clicks, 1);

  dom.body.removeChild(dom.accordion);
  await r.mutate();
  const back = accordionOf(PANEL);
  dom.body.appendChild(back);
  await r.mutate();
  assert.strictEqual(back.items[0].seeAll.clicks, 0,
    'the full list was reopened the moment the user went back');
});

test('closing and reopening the panel opens Favourites again', async () => {
  const dom = buildPanel(PANEL);
  const r = await run(dom, { expandFavourites: true });
  assert.strictEqual(dom.items[0].seeAll.clicks, 1);

  // Closing the panel takes its header and the accordion with it.
  dom.body.removeChild(dom.panelHeader);
  dom.body.removeChild(dom.accordion);
  await r.mutate();

  const reopened = accordionOf(PANEL);
  dom.body.appendChild(panelHeader());
  dom.body.appendChild(reopened);
  await r.mutate();
  assert.strictEqual(reopened.items[0].seeAll.clicks, 1);
});

test('a hidden Favourites section is not opened', async () => {
  const dom = buildPanel(PANEL);
  await run(dom, { expandFavourites: true, hideFavourites: true });
  assert.strictEqual(dom.items[0].seeAll.clicks, 0,
    'there is nothing to open once the section is hidden');
  assert.strictEqual(dom.items[0].button.clicks, 0);
});

test('turning every section setting off removes the stylesheet and the marks', async () => {
  const dom = buildPanel(PANEL);
  const r = await run(dom, { hideBuiltInTools: true });
  assert.ok(r.css());
  r.push({ hideBuiltInTools: false });
  await r.settle();
  assert.strictEqual(r.css(), null);
  assert.deepStrictEqual(r.marks(), [null, null, null],
    'the marks outlived the setting that put them there');
});

test('changing which sections are hidden rewrites the rules in place', async () => {
  const dom = buildPanel(PANEL);
  const r = await run(dom, { hideBuiltInTools: true });
  const style = dom.document.getElementById('cdpa-section-style');
  r.push({ hideFavourites: true });
  await r.settle();
  assert.strictEqual(dom.document.getElementById('cdpa-section-style'), style,
    'the stylesheet was recreated rather than rewritten');
  assert.strictEqual(r.css(), '[data-cdpa-section="favourites"]{display:none !important}');
  assert.deepStrictEqual(r.marks(), ['favourites', 'ai', 'builtin'],
    'marks are identities, not settings - they should survive a settings change');
});

test('an item whose header has not rendered yet is left for the next pass', async () => {
  const dom = buildPanel(PANEL);
  const bare = new El('div');
  bare.className = 'fui-AccordionItem';
  dom.accordion.appendChild(bare);
  const r = await run(dom, { hideFavourites: true });
  assert.strictEqual(bare.getAttribute('data-cdpa-section'), null,
    'an item was classified from a header that was not there');

  bare.appendChild(section('Favorites').children[0]);
  await r.mutate();
  assert.strictEqual(bare.getAttribute('data-cdpa-section'), 'favourites');
});
