'use strict';
// DLP policy normalisation and per-environment resolution. Pure: no chrome APIs,
// no network, no storage - so it runs unchanged in the service worker, in
// content scripts, in extension pages and under `node --test`.
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

__cdpa.policy = (function () {
  var log = __cdpa.log.create('policy');

  var BLOCKED = 'Blocked';
  var BUSINESS = 'Confidential';     // "Business" in the admin UI
  var NON_BUSINESS = 'General';      // "Non-business" in the admin UI

  function connectorMap() {
    return __cdpa.connectorMap;
  }

  function names(list) {
    var map = connectorMap();
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (entry) {
      var id = entry && typeof entry === 'object' ? (entry.id || entry.name) : entry;
      var name = map.toConnectorName(id);
      if (name) out.push(name);
    });
    return out;
  }

  // Accepts the raw governance payload in any of the shapes it arrives in: the
  // {value:[...]} list, a bare array, or a single policy object from the detail
  // endpoint. Returns a { [policyId]: normalisedPolicy } map.
  function normalisePolicies(raw) {
    var list;
    if (Array.isArray(raw)) list = raw;
    else if (raw && Array.isArray(raw.value)) list = raw.value;
    else if (raw && (raw.name || raw.displayName)) list = [raw];
    else list = [];

    var out = {};
    log.debug('normalising', list.length, 'policies');
    list.forEach(function (p) {
      if (!p || !p.name) return;
      var groups = Array.isArray(p.connectorGroups) ? p.connectorGroups : [];
      var byClass = {};
      groups.forEach(function (g) {
        if (g && g.classification) byClass[g.classification] = names(g.connectors);
      });
      out[p.name] = {
        displayName: p.displayName || p.name,
        environmentType: p.environmentType || '',
        environments: (Array.isArray(p.environments) ? p.environments : []).map(function (e) {
          return __cdpa.env.canonical(e && typeof e === 'object' ? (e.name || e.id) : e);
        }).filter(Boolean),
        defaultClassification: p.defaultConnectorsClassification || NON_BUSINESS,
        blocked: byClass[BLOCKED] || [],
        business: byClass[BUSINESS] || [],
        nonBusiness: byClass[NON_BUSINESS] || []
      };
    });
    return out;
  }

  // /connectors/metadata/{unblockable,virtual} both return a bare array of
  // { id, metadata } objects.
  function normaliseMetadata(raw) {
    var list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.value) ? raw.value : []);
    return names(list);
  }

  function appliesToEnvironment(policy, canonicalEnvId) {
    if (!policy || !canonicalEnvId) return false;
    var listed = policy.environments.indexOf(canonicalEnvId) !== -1;
    switch (policy.environmentType) {
      case 'AllEnvironments': return true;
      case 'OnlyEnvironments': return listed;
      case 'ExceptEnvironments': return !listed;
      // An environmentType we don't recognise means we can't say whether this
      // policy applies, so we don't let it hide anything.
      default:
        log.warn('unrecognised environmentType', policy.environmentType,
          'on policy', policy.displayName, '- ignoring it');
        return false;
    }
  }

  function classifyIn(policy, connectorName) {
    if (policy.blocked.indexOf(connectorName) !== -1) return BLOCKED;
    if (policy.business.indexOf(connectorName) !== -1) return BUSINESS;
    if (policy.nonBusiness.indexOf(connectorName) !== -1) return NON_BUSINESS;
    return policy.defaultClassification;
  }

  // Collapses every policy that governs this environment into the sets the
  // designer filter needs. Blocked wins across policies; Business wins over
  // Non-business for colour coding; unblockable connectors override everything.
  function resolveForEnvironment(store, canonicalEnvId) {
    var policies = (store && store.policies) || {};
    var unblockable = new Set((store && store.unblockable) || []);
    var applicable = Object.keys(policies).filter(function (id) {
      return appliesToEnvironment(policies[id], canonicalEnvId);
    });

    log.debug('resolving environment', canonicalEnvId, '-', applicable.length, 'of',
      Object.keys(policies).length, 'policies apply');

    var result = {
      covered: applicable.length > 0,
      policyNames: applicable.map(function (id) { return policies[id].displayName; }),
      blocked: new Set(),
      business: new Set(),
      nonBusiness: new Set(),
      unblockable: unblockable,
      // What a connector no applicable policy names explicitly falls back to.
      // Business is the stricter of the two, so it wins when policies disagree.
      defaultClassification: null
    };
    if (!result.covered) return result;

    applicable.forEach(function (id) {
      var d = policies[id].defaultClassification;
      if (d === BUSINESS || result.defaultClassification === null) result.defaultClassification = d;
    });

    // Every connector any applicable policy has an opinion about, plus every
    // group the virtual map can reach.
    var candidates = new Set();
    applicable.forEach(function (id) {
      var p = policies[id];
      p.blocked.forEach(function (n) { candidates.add(n); });
      p.business.forEach(function (n) { candidates.add(n); });
      p.nonBusiness.forEach(function (n) { candidates.add(n); });
    });

    candidates.forEach(function (name) {
      var classification = effectiveClassification(policies, applicable, name);
      if (classification === BLOCKED && !unblockable.has(name)) result.blocked.add(name);
      else if (classification === BUSINESS) result.business.add(name);
      else if (classification === NON_BUSINESS) result.nonBusiness.add(name);
    });

    log.debug('resolved', canonicalEnvId, '- blocked', result.blocked.size,
      'business', result.business.size, 'non-business', result.nonBusiness.size,
      '- policies:', result.policyNames.join(', '));
    return result;
  }

  function effectiveClassification(policies, applicable, connectorName) {
    var sawBusiness = false;
    for (var i = 0; i < applicable.length; i++) {
      var c = classifyIn(policies[applicable[i]], connectorName);
      if (c === BLOCKED) return BLOCKED;
      if (c === BUSINESS) sawBusiness = true;
    }
    return sawBusiness ? BUSINESS : NON_BUSINESS;
  }

  // Is this designer operation group hidden by DLP? A group covered by several
  // policy entries (the Power Virtual Agents channels) is only hidden when all
  // of them are blocked.
  function isGroupBlocked(resolved, groupName) {
    if (!resolved || !resolved.covered) return false;
    var policyNames = connectorMap().policyNamesForGroup(groupName);
    if (!policyNames.length) return false;
    return policyNames.every(function (n) { return resolved.blocked.has(n); });
  }

  // 'Confidential' | 'General' | null - for colour coding only.
  function groupClassification(resolved, groupName) {
    if (!resolved || !resolved.covered) return null;
    var policyNames = connectorMap().policyNamesForGroup(groupName);
    for (var i = 0; i < policyNames.length; i++) {
      if (resolved.business.has(policyNames[i])) return BUSINESS;
    }
    for (var j = 0; j < policyNames.length; j++) {
      if (resolved.nonBusiness.has(policyNames[j])) return NON_BUSINESS;
    }
    // Blocked connectors are hidden, not coloured; anything else the policy does
    // not name explicitly still sits in the default group, so colour it that way
    // rather than leaving most of the panel untinted.
    for (var k = 0; k < policyNames.length; k++) {
      if (resolved.blocked.has(policyNames[k])) return null;
    }
    return resolved.defaultClassification === BLOCKED ? null : resolved.defaultClassification;
  }

  // A stored or imported policy store, made safe to resolve. mergeImport's
  // output is already this shape; a configuration file is whatever someone
  // wrote, and one policy missing an array used to make every resolve throw.
  function stringList(list) {
    return (Array.isArray(list) ? list : []).filter(function (v) {
      return typeof v === 'string' && v;
    });
  }

  function sanitiseStore(store) {
    var s = store && typeof store === 'object' ? store : {};
    var policies = {};
    var raw = s.policies && typeof s.policies === 'object' ? s.policies : {};
    Object.keys(raw).forEach(function (id) {
      var p = raw[id];
      if (!p || typeof p !== 'object') {
        log.warn('dropping stored policy', id, '- not an object');
        return;
      }
      policies[id] = {
        displayName: typeof p.displayName === 'string' ? p.displayName : id,
        environmentType: typeof p.environmentType === 'string' ? p.environmentType : '',
        environments: stringList(p.environments).map(__cdpa.env.canonical),
        defaultClassification: typeof p.defaultClassification === 'string'
          ? p.defaultClassification : NON_BUSINESS,
        blocked: stringList(p.blocked),
        business: stringList(p.business),
        nonBusiness: stringList(p.nonBusiness)
      };
    });
    return Object.assign({}, s, {
      policies: policies,
      unblockable: stringList(s.unblockable),
      virtual: stringList(s.virtual),
      tenantId: typeof s.tenantId === 'string' ? s.tenantId : null
    });
  }

  return {
    BLOCKED: BLOCKED,
    BUSINESS: BUSINESS,
    NON_BUSINESS: NON_BUSINESS,
    normalisePolicies: normalisePolicies,
    normaliseMetadata: normaliseMetadata,
    sanitiseStore: sanitiseStore,
    appliesToEnvironment: appliesToEnvironment,
    resolveForEnvironment: resolveForEnvironment,
    isGroupBlocked: isGroupBlocked,
    groupClassification: groupClassification
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.policy;
