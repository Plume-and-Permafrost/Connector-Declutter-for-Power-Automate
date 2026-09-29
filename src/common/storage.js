'use strict';
// Settings and stored policy data, plus the refresh-throttling maths.
//
// The backoff helpers are pure so they can be tested without a browser; the
// chrome.storage wrappers are thin on purpose.
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

__cdpa.storage = (function () {
  var log = __cdpa.log.create('storage');

  var SETTINGS_KEY = 'settings';
  var POLICY_KEY = 'policyStore';
  // Every connector the designer has shown us, so the settings page can offer a
  // list to tick. Its own key rather than part of the settings: it is a cache
  // rebuilt by browsing, and well over a thousand names have no business in a config export.
  var CONNECTORS_KEY = 'connectorCatalogue';

  var HOUR = 60 * 60 * 1000;
  var MAX_BACKOFF = 24 * HOUR;
  var SUCCESS_INTERVAL = 24 * HOUR;

  // Base colours for classification tinting. Stored opaque; the decorator applies
  // the transparency, and lightens them for dark mode.
  // Two for the DLP classifications, and one for each reason a connector would
  // normally be hidden - those only ever show up with "show everything" on, where
  // the whole point is to say why a row would not otherwise be there. The category
  // keys are category rule ids, so a rule the user adds simply needs a matching key.
  function defaultColours() {
    return {
      business: '#7a5ea8',      // Confidential
      nonBusiness: '#4c8c4a',   // General
      blocked: '#c4314b',       // hidden by DLP
      desktop: '#0f6cbd',       // hidden by the desktop category rule
      agentic: '#c2610a'        // hidden by the MCP/agent/Copilot category rule
    };
  }

  // What a category rule with no colour of its own gets. Deliberately neutral: it
  // says "a rule hides this" without implying which.
  var UNNAMED_RULE_COLOUR = '#6b6b6b';

  function defaultSettings() {
    return {
      // Core behaviour
      hideBlocked: true,
      categoryRules: __cdpa.filters.defaultRules(),
      autoFetch: false,
      colourCode: false,
      colours: defaultColours(),
      // Stop a hover changing a connector row's size, and with it the grid's
      // layout. Off by default: it is a fix for the designer's own styling, and
      // the cost is that every row is always as tall as a hovered one.
      steadyRows: false,
      // Panel sections. The designer stacks three collapsible sections above the
      // connector list; these say which of them to remove, and whether to open
      // Favourites when it renders collapsed. Off by default - the extension
      // hides connectors nobody can use, and a whole section is a taste.
      hideFavourites: false,
      hideAiCapabilities: false,
      hideBuiltInTools: false,
      expandFavourites: false,
      // What the editable one of our two connector filter pills contains. Which
      // pill is selected is the designer's own state, not ours. See
      // src/common/views.js.
      pickedConnectors: [],
      // Temporary escape hatch driven from the popup
      showEverything: false,
      // Verbose console logging across all four execution contexts
      debug: false
    };
  }

  function defaultPolicyStore() {
    return {
      tenantId: null,
      policies: {},
      unblockable: [],
      virtual: [],
      importedAt: null,
      source: null,
      refresh: { lastAttemptAt: null, lastSuccessAt: null, failureCount: 0, nextAttemptAfter: 0 }
    };
  }

  function withDefaults(stored, fallback) {
    var out = fallback();
    if (stored && typeof stored === 'object') {
      Object.keys(stored).forEach(function (k) {
        if (stored[k] !== undefined) out[k] = stored[k];
      });
    }
    return out;
  }

  function hasPolicyData(store) {
    return !!(store && store.policies && Object.keys(store.policies).length);
  }

  // --- refresh throttling (pure) -------------------------------------------

  function backoffFor(failureCount) {
    if (!failureCount || failureCount < 1) return HOUR;
    return Math.min(MAX_BACKOFF, HOUR * Math.pow(2, failureCount - 1));
  }

  function shouldAttemptRefresh(refresh, now) {
    var at = typeof now === 'number' ? now : Date.now();
    if (!refresh) return true;
    return at >= (refresh.nextAttemptAfter || 0);
  }

  function recordSuccess(refresh, now) {
    var at = typeof now === 'number' ? now : Date.now();
    return { lastAttemptAt: at, lastSuccessAt: at, failureCount: 0, nextAttemptAfter: at + SUCCESS_INTERVAL };
  }

  function recordFailure(refresh, now) {
    var at = typeof now === 'number' ? now : Date.now();
    var count = ((refresh && refresh.failureCount) || 0) + 1;
    return {
      lastAttemptAt: at,
      lastSuccessAt: (refresh && refresh.lastSuccessAt) || null,
      failureCount: count,
      nextAttemptAfter: at + backoffFor(count)
    };
  }

  // --- chrome.storage wrappers ---------------------------------------------

  function area() {
    return chrome.storage.local;
  }

  // chrome.storage.local rejects on quota. Callers mostly ignore that, so this
  // is the one place a failed write gets said out loud.
  function write(key, value) {
    var obj = {};
    obj[key] = value;
    if (log.enabled) {
      var bytes = 0;
      try { bytes = JSON.stringify(value).length; } catch (e) { bytes = -1; }
      log.debug('writing', key, '-', bytes < 0 ? 'unmeasurable' : bytes + ' bytes');
    }
    return area().set(obj).catch(function (err) {
      log.error('could not write', key + ':', err && err.message ? err.message : err);
      throw err;
    });
  }

  // Read-modify-write jobs on one key run one after another. Messages are
  // handled concurrently, so two saves landing together would otherwise both
  // read the same value and the second write would drop the first one's change.
  var queues = {};

  function serial(key, job) {
    var run = (queues[key] || Promise.resolve()).then(job, job);
    queues[key] = run.catch(function () {}); // one failure must not stall the queue
    return run;
  }

  // Settings a previous version stored and this one no longer has are dropped on
  // read, so they stop riding along in the config export. defaultSettings is the
  // whole key set, and everything that reads a setting reads one of those.
  function prune(settings) {
    var known = defaultSettings();
    Object.keys(settings).forEach(function (k) {
      if (!(k in known)) {
        log.debug('dropping the retired setting', k);
        delete settings[k];
      }
    });
    return settings;
  }

  // Every setting given the type its readers expect, whatever was stored or
  // imported. A value of the wrong type falls back to the default for that key.
  var HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  function sanitise(settings) {
    var defaults = defaultSettings();
    Object.keys(defaults).forEach(function (k) {
      if (typeof defaults[k] === 'boolean' && typeof settings[k] !== 'boolean') {
        settings[k] = defaults[k];
      }
    });
    settings.categoryRules = __cdpa.filters.sanitiseRules(settings.categoryRules);
    var colours = {};
    var stored = settings.colours && typeof settings.colours === 'object' ? settings.colours : {};
    Object.keys(stored).forEach(function (k) {
      if (typeof stored[k] === 'string' && HEX_RE.test(stored[k])) colours[k] = stored[k];
    });
    settings.colours = Object.assign(defaultColours(), colours);
    settings.pickedConnectors = (Array.isArray(settings.pickedConnectors) ? settings.pickedConnectors : [])
      .filter(function (n) { return typeof n === 'string' && n && n.length <= 256; });
    return settings;
  }

  function getSettings() {
    return area().get(SETTINGS_KEY).then(function (r) {
      return sanitise(prune(withDefaults(r[SETTINGS_KEY], defaultSettings)));
    });
  }

  function setSettings(patch) {
    return serial(SETTINGS_KEY, function () {
      return getSettings().then(function (current) {
        var next = sanitise(prune(Object.assign({}, current, patch || {})));
        return write(SETTINGS_KEY, next).then(function () { return next; });
      });
    });
  }

  // name -> display name, for every operation group the designer has fetched
  // while the extension was watching. Merged rather than replaced: browsing one
  // environment should not forget what another one showed.
  function getConnectors() {
    return area().get(CONNECTORS_KEY).then(function (r) {
      return r[CONNECTORS_KEY] || {};
    });
  }

  function addConnectors(seen) {
    return serial(CONNECTORS_KEY, function () { return addConnectorsNow(seen); });
  }

  function addConnectorsNow(seen) {
    return getConnectors().then(function (known) {
      var added = 0;
      (seen || []).forEach(function (c) {
        if (!c || !c.name) return;
        var display = c.displayName || known[c.name] || c.name;
        if (known[c.name] === display) return;
        known[c.name] = display;
        added++;
      });
      if (!added) return known;
      log.debug('learned', added, 'connector name(s);', Object.keys(known).length, 'known');
      return write(CONNECTORS_KEY, known).then(function () { return known; });
    });
  }

  function getPolicyStore() {
    return area().get(POLICY_KEY).then(function (r) {
      var store = withDefaults(r[POLICY_KEY], defaultPolicyStore);
      return __cdpa.policy ? __cdpa.policy.sanitiseStore(store) : store;
    });
  }

  function setPolicyStore(store) {
    return serial(POLICY_KEY, function () {
      return write(POLICY_KEY, store).then(function () { return store; });
    });
  }

  // update(current) -> next store, or a promise of one. Serialised with every
  // other write to the policy store.
  function updatePolicyStore(update) {
    return serial(POLICY_KEY, function () {
      return getPolicyStore().then(update).then(function (next) {
        return write(POLICY_KEY, next).then(function () { return next; });
      });
    });
  }

  return {
    SETTINGS_KEY: SETTINGS_KEY,
    POLICY_KEY: POLICY_KEY,
    CONNECTORS_KEY: CONNECTORS_KEY,
    HOUR: HOUR,
    MAX_BACKOFF: MAX_BACKOFF,
    SUCCESS_INTERVAL: SUCCESS_INTERVAL,
    UNNAMED_RULE_COLOUR: UNNAMED_RULE_COLOUR,
    defaultColours: defaultColours,
    defaultSettings: defaultSettings,
    defaultPolicyStore: defaultPolicyStore,
    withDefaults: withDefaults,
    sanitiseSettings: function (s) { return sanitise(prune(withDefaults(s, defaultSettings))); },
    hasPolicyData: hasPolicyData,
    backoffFor: backoffFor,
    shouldAttemptRefresh: shouldAttemptRefresh,
    recordSuccess: recordSuccess,
    recordFailure: recordFailure,
    getSettings: getSettings,
    setSettings: setSettings,
    getPolicyStore: getPolicyStore,
    setPolicyStore: setPolicyStore,
    updatePolicyStore: updatePolicyStore,
    getConnectors: getConnectors,
    addConnectors: addConnectors
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.storage;
