'use strict';
// The extension's sources are classic scripts that hang their exports off a
// shared global, so they load unchanged in content scripts, in the service
// worker and here. Requiring them in dependency order populates that global.
require('../src/common/log.js');
require('../src/common/env.js');
require('../src/common/connector-map.js');
require('../src/common/policy.js');
require('../src/common/filters.js');
require('../src/common/paginate.js');
require('../src/common/storage.js');

const api = '/providers/Microsoft.PowerApps/apis/';

// Builds the raw governance payload shape so tests exercise normalisation too.
function rawPolicy(overrides) {
  return Object.assign({
    name: 'policy-1',
    displayName: 'Test policy',
    environmentType: 'OnlyEnvironments',
    environments: [{ name: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9' }],
    defaultConnectorsClassification: 'General',
    connectorGroups: []
  }, overrides);
}

function group(classification, connectorNames) {
  return {
    classification,
    connectors: connectorNames.map((n) => ({
      id: n.includes('.') || !n.startsWith('shared_') ? n : api + n
    }))
  };
}

function storeFrom(policies, unblockable) {
  return {
    policies: globalThis.__cdpa.policy.normalisePolicies({ value: [].concat(policies) }),
    unblockable: globalThis.__cdpa.policy.normaliseMetadata(
      (unblockable || []).map((n) => ({ id: api + n, metadata: { unblockable: true } }))
    )
  };
}

const ENV = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const OTHER_ENV = 'fedcba9876543210fedcba9876543210';

module.exports = { rawPolicy, group, storeFrom, ENV, OTHER_ENV, cdpa: globalThis.__cdpa };
