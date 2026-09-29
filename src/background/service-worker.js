'use strict';
// The storage owner. Content scripts and extension pages never touch
// chrome.storage directly - they go through the messages below, so there is one
// place that decides how policy data is merged and how refreshes are throttled.
//
// Chrome runs this as a service worker and needs importScripts. Firefox has no
// MV3 service workers: manifest.firefox.json lists background.scripts, which it
// runs as an event page with these same files already loaded before this one.
if (typeof importScripts === 'function') {
  importScripts(
    '/src/common/log.js',
    '/src/common/env.js',
    '/src/common/connector-map.js',
    '/src/common/policy.js',
    '/src/common/filters.js',
    '/src/common/storage.js'
  );
}

var __cdpa = globalThis.__cdpa || (globalThis.__cdpa = {});

// Logging is optional infrastructure. If log.js is missing or did not run, fall
// back to silent channels - a debug switch must never be able to stop the
// extension filtering.
__cdpa.log = __cdpa.log || (function () {
  var off = function () {};
  var silent = { debug: off, info: off, warn: off, error: off, enabled: false,
    time: function () { return off; } };
  return { create: function () { return silent; }, setEnabled: off,
    mirrorToPage: off, watchStorage: off, FLAG_KEY: 'cdpa:debug' };
})();

var log = __cdpa.log.create('background');
__cdpa.log.watchStorage();

var storage = __cdpa.storage;
var policy = __cdpa.policy;
var filters = __cdpa.filters;
var env = __cdpa.env;

var CONFIG_FORMAT = 'connector-declutter-for-power-automate/config@1';
// Files exported before the rename carry the old tag; the shape is identical.
var LEGACY_CONFIG_FORMATS = ['powerautomate-connector-declutter/config@1'];

// Policies the user made in the options page rather than imported from a
// tenant. No tenant list contains them, so a full replace must carry them over.
var LOCAL_POLICY_PREFIX = 'manual-';

function localPolicies(policies) {
  var out = {};
  Object.keys(policies || {}).forEach(function (id) {
    if (id.indexOf(LOCAL_POLICY_PREFIX) === 0) out[id] = policies[id];
  });
  return out;
}

// Turns raw governance payloads into the stored shape, keeping whatever the
// caller did not supply. An admin-portal capture often has only the policies.
function mergeImport(current, payload, source) {
  var next = Object.assign({}, current);
  if (payload.policies !== undefined) {
    var normalised = policy.normalisePolicies(payload.policies);
    // A single-policy import updates that policy and leaves the rest alone; a
    // full list replaces the tenant's set, so policies deleted in the tenant
    // disappear - but the user's own manual blocklist stays.
    next.policies = payload.replaceAll === false
      ? Object.assign({}, current.policies, normalised)
      : Object.assign(localPolicies(current.policies), normalised);
  }
  if (payload.unblockable !== undefined) next.unblockable = policy.normaliseMetadata(payload.unblockable);
  if (payload.virtual !== undefined) next.virtual = policy.normaliseMetadata(payload.virtual);
  if (payload.tenantId) next.tenantId = payload.tenantId;
  log.debug('merged a', source || 'manual', 'import:',
    Object.keys(current.policies || {}).length, '->', Object.keys(next.policies || {}).length,
    'policies,', (next.unblockable || []).length, 'unblockable,',
    (next.virtual || []).length, 'virtual',
    payload.replaceAll === false ? '(single policy, others kept)' : '(full replace)');
  next.importedAt = Date.now();
  next.source = source || 'manual';
  next.refresh = storage.recordSuccess(current.refresh);
  return next;
}

function summarise(store, settings, canonicalEnv) {
  var resolved = canonicalEnv ? policy.resolveForEnvironment(store, canonicalEnv) : null;
  return {
    hasData: storage.hasPolicyData(store),
    tenantId: store.tenantId || null,
    policyCount: Object.keys(store.policies || {}).length,
    importedAt: store.importedAt,
    source: store.source,
    refresh: store.refresh,
    environment: canonicalEnv ? env.toDisplay(canonicalEnv) : null,
    covered: !!(resolved && resolved.covered),
    policyNames: resolved ? resolved.policyNames : [],
    blockedCount: resolved ? resolved.blocked.size : 0,
    settings: settings
  };
}

var handlers = {
  getSettings: function () {
    return storage.getSettings();
  },

  setSettings: function (msg) {
    return storage.setSettings(msg.patch);
  },

  getPolicyStore: function () {
    return storage.getPolicyStore();
  },

  // The designer tells us what exists as the maker browses; the settings page
  // reads it back to offer a list to tick.
  getConnectors: function () {
    return storage.getConnectors();
  },

  rememberConnectors: function (msg) {
    return storage.addConnectors(msg.connectors).then(function (known) {
      return { ok: true, count: Object.keys(known).length };
    });
  },

  importPolicies: function (msg) {
    return storage.updatePolicyStore(function (current) {
      return mergeImport(current, msg.payload || {}, msg.source);
    }).then(function (next) {
      return { ok: true, policyCount: Object.keys(next.policies).length };
    });
  },

  // Asked before any network attempt, so a tenant that always 403s is retried
  // on a growing backoff rather than on every page load.
  shouldRefresh: function () {
    return storage.getPolicyStore().then(function (store) {
      var should = storage.shouldAttemptRefresh(store.refresh);
      var r = store.refresh || {};
      log.debug('refresh requested ->', should ? 'allowed' : 'held back',
        '(failures so far:', r.failureCount || 0,
        ', next attempt after:', r.nextAttemptAfter ? new Date(r.nextAttemptAfter).toISOString() : 'never set', ')');
      return { should: should };
    });
  },

  recordRefreshFailure: function () {
    return storage.updatePolicyStore(function (store) {
      store.refresh = storage.recordFailure(store.refresh);
      log.debug('recorded a refresh failure - count now', store.refresh.failureCount,
        ', next attempt after', new Date(store.refresh.nextAttemptAfter).toISOString());
      return store;
    }).then(function () { return { ok: true }; });
  },

  getStatus: function (msg) {
    return Promise.all([storage.getPolicyStore(), storage.getSettings()]).then(function (r) {
      return summarise(r[0], r[1], msg.environment);
    });
  },

  exportConfig: function () {
    return Promise.all([storage.getSettings(), storage.getPolicyStore()]).then(function (r) {
      return {
        format: CONFIG_FORMAT,
        exportedAt: new Date().toISOString(),
        settings: r[0],
        policyStore: r[1]
      };
    });
  },

  importConfig: function (msg) {
    var data = msg.data;
    if (!data || (data.format !== CONFIG_FORMAT && LEGACY_CONFIG_FORMATS.indexOf(data.format) === -1)) {
      log.warn('rejected a configuration import - format was',
        JSON.stringify(data && data.format), 'not', JSON.stringify(CONFIG_FORMAT));
      return Promise.resolve({ ok: false, error: 'Not a Connector Declutter for Power Automate configuration file.' });
    }
    log.debug('importing a configuration exported at', data.exportedAt,
      '- settings:', !!data.settings, ', policy store:', !!data.policyStore);
    var jobs = [];
    if (data.settings) jobs.push(storage.setSettings(data.settings));
    if (data.policyStore) {
      jobs.push(storage.setPolicyStore(
        policy.sanitiseStore(storage.withDefaults(data.policyStore, storage.defaultPolicyStore))));
    }
    return Promise.all(jobs).then(function () { return { ok: true }; });
  }
};

var EXTENSION_PAGE_ONLY = { setSettings: true, importConfig: true, exportConfig: true };

function fromExtensionPage(sender) {
  var base = chrome.runtime.getURL ? chrome.runtime.getURL('') : '';
  return !!(sender && base && typeof sender.url === 'string' && sender.url.indexOf(base) === 0);
}

// Exposed for the tests, which load this file without a browser around it.
__cdpa.background = { mergeImport: mergeImport, handlers: handlers };

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('cdpa:') !== 0) return undefined;
  var name = msg.type.slice('cdpa:'.length);
  var handler = handlers[name];
  if (!handler) {
    log.warn('no handler for message', msg.type);
    return undefined;
  }
  // Content scripts only ever read, report connectors or hand over policies.
  // Rewriting settings or the whole configuration is for the extension's own
  // pages, so a compromised page cannot ask for it through the bridge.
  if (EXTENSION_PAGE_ONLY[name] && !fromExtensionPage(sender)) {
    log.warn('refused', name, 'from', sender && sender.url);
    sendResponse({ ok: false, error: 'not allowed from this context' });
    return undefined;
  }
  var from = sender && sender.url ? new URL(sender.url).host : 'extension page';
  log.debug('<-', name, 'from', from);
  Promise.resolve()
    .then(function () { return handler(msg, sender); })
    .then(function (result) { sendResponse({ ok: true, result: result }); })
    .catch(function (err) {
      log.error(name, 'failed:', err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(function (details) {
  log.debug('onInstalled:', details && details.reason, '- materialising default settings');
  // Materialise defaults so the options page has something to show on first run.
  storage.getSettings().then(function (settings) { return storage.setSettings(settings); });
});
