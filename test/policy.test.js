'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rawPolicy, group, storeFrom, ENV, OTHER_ENV, cdpa } = require('./helpers.js');
const { policy, env } = cdpa;

test('environment ids round-trip through the API host', () => {
  assert.strictEqual(
    env.hostFromEnvironmentId('0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'),
    '0a1b2c3d4e5f60718293a4b5c6d7e8.f9.environment.api.powerplatform.com'
  );
  // The default environment's id is not a bare GUID, so a fixed 30/2 split
  // would get this wrong.
  assert.strictEqual(
    env.hostFromEnvironmentId('Default-1234abcd-5678-90ef-ab12-cd34ef567890'),
    'default1234abcd567890efab12cd34ef5678.90.environment.api.powerplatform.com'
  );
  assert.strictEqual(
    env.canonicalFromHost('0a1b2c3d4e5f60718293a4b5c6d7e8.f9.environment.api.powerplatform.com'),
    ENV
  );
  assert.strictEqual(env.canonicalFromHost('make.powerautomate.com'), null);
});

test('OnlyEnvironments applies to listed environments only', () => {
  const store = storeFrom(rawPolicy({ connectorGroups: [group('Blocked', ['shared_dropbox'])] }));
  assert.ok(policy.resolveForEnvironment(store, ENV).covered);
  assert.ok(!policy.resolveForEnvironment(store, OTHER_ENV).covered);
});

test('ExceptEnvironments applies everywhere but the listed environments', () => {
  const store = storeFrom(rawPolicy({
    environmentType: 'ExceptEnvironments',
    connectorGroups: [group('Blocked', ['shared_dropbox'])]
  }));
  assert.ok(!policy.resolveForEnvironment(store, ENV).covered);
  assert.ok(policy.resolveForEnvironment(store, OTHER_ENV).covered);
});

test('AllEnvironments applies regardless of the list', () => {
  const store = storeFrom(rawPolicy({
    environmentType: 'AllEnvironments',
    connectorGroups: [group('Blocked', ['shared_dropbox'])]
  }));
  assert.ok(policy.resolveForEnvironment(store, OTHER_ENV).covered);
});

test('an unrecognised environmentType hides nothing', () => {
  const store = storeFrom(rawPolicy({
    environmentType: 'SomethingMicrosoftAddedLater',
    connectorGroups: [group('Blocked', ['shared_dropbox'])]
  }));
  const resolved = policy.resolveForEnvironment(store, ENV);
  assert.ok(!resolved.covered);
  assert.ok(!policy.isGroupBlocked(resolved, 'shared_dropbox'));
});

test('unblockable connectors survive a Blocked classification', () => {
  const store = storeFrom(
    rawPolicy({ connectorGroups: [group('Blocked', ['shared_dropbox', 'shared_approvals'])] }),
    ['shared_approvals']
  );
  const resolved = policy.resolveForEnvironment(store, ENV);
  assert.ok(policy.isGroupBlocked(resolved, 'shared_dropbox'));
  assert.ok(!policy.isGroupBlocked(resolved, 'shared_approvals'));
});

test('connectors no policy mentions take the default classification', () => {
  const blockByDefault = storeFrom(rawPolicy({
    defaultConnectorsClassification: 'Blocked',
    connectorGroups: [group('Confidential', ['shared_sharepointonline'])]
  }));
  const resolved = policy.resolveForEnvironment(blockByDefault, ENV);
  // Never seen by any policy group, so it is not a candidate and stays visible -
  // fail open rather than hide on a default we cannot enumerate.
  assert.ok(!policy.isGroupBlocked(resolved, 'shared_somethingbrandnew'));
  assert.ok(!policy.isGroupBlocked(resolved, 'shared_sharepointonline'));
});

test('Blocked in any applicable policy wins', () => {
  const store = storeFrom([
    rawPolicy({ name: 'a', connectorGroups: [group('Confidential', ['shared_dropbox'])] }),
    rawPolicy({ name: 'b', connectorGroups: [group('Blocked', ['shared_dropbox'])] })
  ]);
  const resolved = policy.resolveForEnvironment(store, ENV);
  assert.strictEqual(resolved.policyNames.length, 2);
  assert.ok(policy.isGroupBlocked(resolved, 'shared_dropbox'));
});

test('virtual connectors map onto the designer group names', () => {
  const store = storeFrom(rawPolicy({
    connectorGroups: [group('Blocked', ['HttpRequestReceived', 'TeamsWebhookRequestReceived'])]
  }));
  const resolved = policy.resolveForEnvironment(store, ENV);
  assert.ok(policy.isGroupBlocked(resolved, 'Request'));
  assert.ok(policy.isGroupBlocked(resolved, 'Teams'));
  assert.ok(!policy.isGroupBlocked(resolved, 'Http'));
});

test('a group fed by several policy entries hides only when all are blocked', () => {
  const partial = storeFrom(rawPolicy({
    connectorGroups: [
      group('Blocked', ['PvaAuth', 'PvaFacebook', 'PvaMicrosoftTeams']),
      group('Confidential', ['PvaOmniChannel', 'PvaCustomDemoMobile'])
    ]
  }));
  assert.ok(!policy.isGroupBlocked(policy.resolveForEnvironment(partial, ENV), 'VirtualAgent'));

  const all = storeFrom(rawPolicy({
    connectorGroups: [group('Blocked', [
      'PvaAuth', 'PvaFacebook', 'PvaMicrosoftTeams', 'PvaOmniChannel', 'PvaCustomDemoMobile'
    ])]
  }));
  assert.ok(policy.isGroupBlocked(policy.resolveForEnvironment(all, ENV), 'VirtualAgent'));
});

test('classification is reported for colour coding', () => {
  const store = storeFrom(rawPolicy({
    connectorGroups: [
      group('Confidential', ['shared_sharepointonline']),
      group('General', ['shared_bitly'])
    ]
  }));
  const resolved = policy.resolveForEnvironment(store, ENV);
  assert.strictEqual(policy.groupClassification(resolved, 'shared_sharepointonline'), 'Confidential');
  assert.strictEqual(policy.groupClassification(resolved, 'shared_bitly'), 'General');
  // A connector the policy does not name still sits in the default group. That can
  // be a large share of the panel, and those rows would otherwise never be tinted.
  assert.strictEqual(policy.groupClassification(resolved, 'shared_unknown'), 'General');
});

test('colour coding follows the default classification', () => {
  const store = storeFrom(rawPolicy({
    defaultConnectorsClassification: 'Confidential',
    connectorGroups: [
      group('General', ['shared_bitly']),
      group('Blocked', ['shared_dropbox'])
    ]
  }));
  const resolved = policy.resolveForEnvironment(store, ENV);
  assert.strictEqual(resolved.defaultClassification, 'Confidential');
  assert.strictEqual(policy.groupClassification(resolved, 'shared_bitly'), 'General');
  assert.strictEqual(policy.groupClassification(resolved, 'shared_unnamed'), 'Confidential');
  // Blocked connectors are hidden rather than tinted, so they get no colour.
  assert.strictEqual(policy.groupClassification(resolved, 'shared_dropbox'), null);
});

test('a Blocked default leaves colour coding silent', () => {
  // Everything unnamed is hidden in that case, so there is nothing to tint and
  // no colour should be invented for it.
  const store = storeFrom(rawPolicy({ defaultConnectorsClassification: 'Blocked' }));
  const resolved = policy.resolveForEnvironment(store, ENV);
  assert.strictEqual(policy.groupClassification(resolved, 'shared_unnamed'), null);
});

test('Business wins as the default when applicable policies disagree', () => {
  const store = storeFrom([
    rawPolicy({ name: 'p1', defaultConnectorsClassification: 'General' }),
    rawPolicy({ name: 'p2', defaultConnectorsClassification: 'Confidential' })
  ]);
  const resolved = policy.resolveForEnvironment(store, ENV);
  assert.strictEqual(resolved.defaultClassification, 'Confidential');
});

test('an empty store hides nothing', () => {
  const resolved = policy.resolveForEnvironment({ policies: {}, unblockable: [] }, ENV);
  assert.ok(!resolved.covered);
  assert.ok(!policy.isGroupBlocked(resolved, 'shared_dropbox'));
});

test('a malformed stored policy cannot make resolving throw', () => {
  const store = policy.sanitiseStore({
    policies: {
      good: storeFrom(rawPolicy({ connectorGroups: [group('Blocked', ['shared_dropbox'])] })).policies['policy-1'],
      halfWritten: { displayName: 'x', environmentType: 'AllEnvironments' },
      notAPolicy: 'hello'
    },
    unblockable: 'shared_x'
  });
  assert.deepStrictEqual(Object.keys(store.policies).sort(), ['good', 'halfWritten']);
  assert.deepStrictEqual(store.unblockable, []);
  const resolved = policy.resolveForEnvironment(store, ENV);
  assert.ok(policy.isGroupBlocked(resolved, 'shared_dropbox'));
});
