'use strict';
// views.js is data plus four small functions, and the data is the part that can
// be wrong. What is pinned here is the shape of a view, the case-insensitivity
// every caller depends on, and the rule that an empty view filters nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const views = require('../src/common/views.js');
const filters = require('../src/common/filters.js');

test('all three views are offered, in a fixed order', () => {
  const list = views.list({});
  assert.deepStrictEqual(list.map((v) => v.id),
    [views.MICROSOFT, views.PICKED, views.IN_FLOW]);
  assert.deepStrictEqual(list.map((v) => v.label),
    ['Microsoft', 'My Filter', 'In Flow']);
});

test('"In Flow" comes from the page, not from the settings', () => {
  // Its contents are a property of the flow on screen, so anywhere that is
  // unknown - the settings page, a test - it is empty rather than wrong.
  assert.deepStrictEqual(views.list({}).at(-1).names, []);
  assert.deepStrictEqual(
    views.list({}, { inFlow: ['shared_sharepointonline'] }).at(-1).names,
    ['shared_sharepointonline']);
  assert.deepStrictEqual(views.list({}, { inFlow: 'nonsense' }).at(-1).names, []);

  const found = views.compile(
    views.find({}, views.IN_FLOW, { inFlow: ['shared_sharepointonline'] }));
  assert.ok(views.shows(found, 'shared_sharepointonline'));
  assert.ok(!views.shows(found, 'shared_dropbox'));
});

test('"My Filter" is whatever the settings hold', () => {
  const list = views.list({ pickedConnectors: ['shared_dropbox'] });
  assert.deepStrictEqual(list[1].names, ['shared_dropbox']);
});

test('a settings object with no picked list is not an error', () => {
  assert.deepStrictEqual(views.list({})[1].names, []);
  assert.deepStrictEqual(views.list({ pickedConnectors: 'nonsense' })[1].names, []);
  assert.deepStrictEqual(views.list()[1].names, []);
});

test('the Microsoft view holds Microsoft products and not everything Microsoft publishes', () => {
  const microsoft = views.compile(views.find({}, views.MICROSOFT));
  for (const name of ['shared_sharepointonline', 'shared_teams', 'shared_excelonlinebusiness',
    'shared_azureblob', 'shared_powerbi', 'shared_github', 'shared_linkedinv2']) {
    assert.ok(views.shows(microsoft, name), name + ' should be in the Microsoft view');
  }
  // All published by Microsoft; none of them a Microsoft product.
  for (const name of ['shared_dropbox', 'shared_salesforce', 'shared_gmail', 'shared_slack',
    'shared_trello', 'shared_youtube', 'shared_zendesk', 'shared_ftp', 'shared_sftpwithssh']) {
    assert.ok(!views.shows(microsoft, name), name + ' should not be in the Microsoft view');
  }
});

test('the built-ins are all in the Microsoft view', () => {
  const microsoft = views.compile(views.find({}, views.MICROSOFT));
  // Hiding Control or Variable behind a Microsoft filter would surprise everyone.
  for (const name of views.BUILT_IN) {
    assert.ok(views.shows(microsoft, name), name + ' is a built-in and should be in the view');
  }
});

test('names are matched however they are cased', () => {
  const microsoft = views.compile(views.find({}, views.MICROSOFT));
  // The catalogue says "Control" and "dateTime"; the DOM only ever says
  // "control" and "datetime".
  assert.ok(views.shows(microsoft, 'Control'));
  assert.ok(views.shows(microsoft, 'control'));
  assert.ok(views.shows(microsoft, 'SHARED_SHAREPOINTONLINE'));
});

test('the Microsoft list has no duplicates and no stray whitespace', () => {
  const seen = new Set();
  for (const name of views.MICROSOFT_NAMES) {
    assert.strictEqual(name, name.trim(), JSON.stringify(name) + ' has whitespace around it');
    assert.ok(name.length, 'an empty name is in the list');
    const key = name.toLowerCase();
    assert.ok(!seen.has(key), name + ' is in the list twice');
    seen.add(key);
  }
});

test('a view cannot re-admit what the default rules block', () => {
  // A view is an allow-list layered on top of the block-lists, not instead of
  // them: the interceptor asks the view first and the category rules afterwards,
  // so these stay hidden even with the Microsoft view chosen. They are named here
  // because they are Microsoft's - if the rules that block them are ever turned
  // off, the view should still know about them.
  const rules = filters.defaultRules();
  const blocked = new Set();
  rules.forEach((rule) => (rule.ids || []).forEach((id) => blocked.add(id.toLowerCase())));

  const overlap = views.MICROSOFT_NAMES.filter((n) => blocked.has(n.toLowerCase()));
  assert.deepStrictEqual(overlap, [
    'Skills', 'VirtualAgent', 'aibuilder', 'shared_agentsdk', 'shared_azureagentservice',
    'shared_copilotflow', 'shared_microsoftcopilotstudio', 'shared_uiflow'
  ]);
});

test('an empty "My Filter" matches nothing rather than everything', () => {
  // A pill is an explicit click, so an empty one means "show me nothing" and the
  // designer renders its own "No results found for the specified filters". The
  // maker is one click from All.
  const empty = views.compile(views.find({ pickedConnectors: [] }, views.PICKED));
  assert.strictEqual(empty.size, 0);
  assert.ok(!views.shows(empty, 'shared_dropbox'));

  const one = views.compile(views.find({ pickedConnectors: ['shared_dropbox'] }, views.PICKED));
  assert.strictEqual(one.size, 1);
  assert.ok(views.shows(one, 'shared_dropbox'));
  assert.ok(!views.shows(one, 'shared_sharepointonline'));
});

test('no view at all shows everything', () => {
  assert.ok(views.shows(null, 'shared_dropbox'));
  assert.ok(views.shows(null, ''));
  assert.ok(views.shows(null, undefined));
});

test('a name nothing knows about is outside every view', () => {
  const microsoft = views.compile(views.find({}, views.MICROSOFT));
  assert.ok(!views.shows(microsoft, ''));
  assert.ok(!views.shows(microsoft, null));
  assert.ok(!views.shows(microsoft, 'shared_somethinginventedlastweek'));
});
