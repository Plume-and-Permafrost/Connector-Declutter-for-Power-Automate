'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cdpa } = require('./helpers.js');
const { filters, storage } = cdpa;

const compiled = () => filters.compile(filters.defaultRules());
const group = (name, displayName, tags) => ({ name, properties: { displayName, tags: tags || [] } });

test('the desktop rule matches the designer connector and desktop action groups', () => {
  const rules = compiled();
  assert.strictEqual(filters.hiddenBy(group('shared_uiflow', 'Desktop flows'), rules), 'desktop');
  assert.strictEqual(
    filters.hiddenBy(group('DesktopFlow.Azure', 'Azure', ['Premium', 'DesktopFlow']), rules),
    'desktop'
  );
});

test('the agentic rule matches MCP, agent and Copilot connectors', () => {
  const rules = compiled();
  ['shared_boxmcpserver', 'shared_supermcp', 'shared_hginsightsmcp'].forEach((n) => {
    assert.strictEqual(filters.hiddenBy(group(n, 'Some MCP Server'), rules), 'agentic', n);
  });
  assert.strictEqual(filters.hiddenBy(group('shared_copilotforsales', 'Copilot for Sales'), rules), 'agentic');
  assert.strictEqual(filters.hiddenBy(group('Skills', 'Skills'), rules), 'agentic');
  assert.strictEqual(filters.hiddenBy(group('VirtualAgent', 'Power Virtual Agents'), rules), 'agentic');
  assert.strictEqual(filters.hiddenBy(group('shared_copilotflow', 'Generative actions'), rules), 'agentic');
});

test('ordinary connectors are not swept up by the agentic rule', () => {
  const rules = compiled();
  // These carry the federatedKnowledgeSource capability, which makes them agent
  // knowledge sources - they are still ordinary connectors and must stay.
  [
    ['shared_sharepointonline', 'SharePoint'],
    ['shared_sql', 'SQL Server'],
    ['shared_salesforce', 'Salesforce'],
    ['shared_approvals', 'Approvals'],
    ['Control', 'Control'],
    ['shared_office365', 'Office 365 Outlook']
  ].forEach(([n, d]) => {
    assert.strictEqual(filters.hiddenBy(group(n, d), rules), null, n);
  });
});

test('disabled rules match nothing', () => {
  const rules = filters.defaultRules().map((r) => Object.assign({}, r, { enabled: false }));
  assert.strictEqual(filters.hiddenBy(group('shared_uiflow', 'Desktop flows'), filters.compile(rules)), null);
});

test('a malformed pattern disables only its own rule', () => {
  const rules = filters.compile([
    { id: 'broken', enabled: true, ids: [], tags: [], pattern: '([unclosed' },
    { id: 'good', enabled: true, ids: ['shared_uiflow'], tags: [], pattern: '' }
  ]);
  assert.strictEqual(filters.hiddenBy(group('shared_uiflow', 'Desktop flows'), rules), 'good');
  assert.strictEqual(filters.hiddenBy(group('shared_other', 'Other'), rules), null);
});

test('refresh backoff grows and caps at a day', () => {
  assert.strictEqual(storage.backoffFor(1), storage.HOUR);
  assert.strictEqual(storage.backoffFor(2), 2 * storage.HOUR);
  assert.strictEqual(storage.backoffFor(5), 16 * storage.HOUR);
  assert.strictEqual(storage.backoffFor(99), storage.MAX_BACKOFF);
});

test('a refresh is not retried before its backoff expires', () => {
  const now = 1_000_000;
  const afterFailure = storage.recordFailure(null, now);
  assert.strictEqual(afterFailure.failureCount, 1);
  assert.ok(!storage.shouldAttemptRefresh(afterFailure, now + storage.HOUR - 1));
  assert.ok(storage.shouldAttemptRefresh(afterFailure, now + storage.HOUR));

  const afterSuccess = storage.recordSuccess(afterFailure, now);
  assert.strictEqual(afterSuccess.failureCount, 0);
  assert.ok(!storage.shouldAttemptRefresh(afterSuccess, now + storage.SUCCESS_INTERVAL - 1));
});

test('a fresh install is allowed to attempt straight away', () => {
  assert.ok(storage.shouldAttemptRefresh(storage.defaultPolicyStore().refresh, Date.now()));
});
