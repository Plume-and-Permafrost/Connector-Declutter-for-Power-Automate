'use strict';
// Designer filtering (page context).
//
// The connector browse panel and its search are both fed by two endpoints. By
// removing entries from those responses before the designer parses them, the
// panel, its search and its result counts all stay consistent with each other -
// there is no DOM to fight and nothing to re-hide when the list re-renders.
//
// Filtering is per environment: the request host encodes which environment the
// designer is talking to, so a tab moving between environments picks up the
// right policy with no reload.
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

(function () {
  var CHANNEL = 'cdpa-maker';
  var CONFIG_TIMEOUT_MS = 5000;
  // A 250-item page can filter down to a handful; topping it up keeps the
  // panel's infinite scroll feeling normal instead of stalling on a short page.
  var BACKFILL_TARGET = 40;
  var BACKFILL_MAX_HOPS = 8;

  var GROUPS_RE = /\/powerautomate\/operationGroups(?:\?|$)/i;
  var OPERATIONS_RE = /\/powerautomate\/operations(?:\?|$)/i;
  var BAP_RE = /(^|\.)api\.bap\.microsoft\.com$/i;

  var log = __cdpa.log.create('maker');
  var env = __cdpa.env;
  var policy = __cdpa.policy;
  var filters = __cdpa.filters;
  var hook = __cdpa.httpHook;

  var config = null;
  var configResolve;
  var configReady = new Promise(function (resolve) { configResolve = resolve; });
  // Never let a missing bridge wedge the designer's networking.
  setTimeout(function () {
    if (!config) {
      log.warn('no config arrived within', CONFIG_TIMEOUT_MS + 'ms -',
        'passing every response through unfiltered. Is the extension still loaded?');
    }
    configResolve(null);
  }, CONFIG_TIMEOUT_MS);

  var resolvedByEnv = new Map();
  var compiledRules = null;
  var tokens = [];

  // Everything the catalogue said about each operation group, keyed by lowercased
  // name. decorate.js reads this: the DOM gives it a lowercased name and a display
  // name but no tags, and a tag is the only thing that matches a rule like
  // DesktopFlow. Recorded even when nothing is being filtered, because "show
  // everything" is exactly when the colours matter most.
  var catalogue = __cdpa.catalogue = new Map();

  function remember(item, isOperation) {
    var group = groupOf(item, isOperation);
    if (!group || !group.name) return;
    var key = String(group.name).toLowerCase();
    // Operation items carry no group tags, so they must not overwrite a real entry.
    if (isOperation && catalogue.has(key)) return;
    var described = filters.describe(group);
    catalogue.set(key, described);
    if (described.displayName) unreported.set(group.name, described.displayName);
  }

  // The settings page can only offer a connector to tick if it knows the
  // connector exists, and the only place that list turns up is here. Sent once
  // per response rather than per item, and only for names not sent already.
  var unreported = new Map();

  function reportConnectors() {
    if (!unreported.size) return;
    var connectors = [];
    unreported.forEach(function (displayName, name) {
      connectors.push({ name: name, displayName: displayName });
    });
    unreported.clear();
    log.debug('reporting', connectors.length, 'connector name(s) to storage');
    post({ type: 'connectorsSeen', connectors: connectors });
  }

  function post(message) {
    try {
      message.channel = CHANNEL;
      window.postMessage(message, location.origin);
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'config') return;
    var first = !config;
    config = { settings: msg.settings, store: msg.store };
    __cdpa.log.setEnabled(!!config.settings.debug);
    resolvedByEnv.clear();
    compiledRules = filters.compile(config.settings.categoryRules);
    log.debug(first ? 'config received:' : 'config updated:',
      Object.keys((config.store && config.store.policies) || {}).length, 'policies,',
      compiledRules.length, 'active category rules;',
      'hideBlocked=' + (config.settings.hideBlocked !== false),
      'showEverything=' + !!config.settings.showEverything,
      'autoFetch=' + !!config.settings.autoFetch,
      'colourCode=' + !!config.settings.colourCode);
    configResolve(config);
    maybeAutoFetch();
  });

  function resolveFor(canonicalEnv) {
    if (!resolvedByEnv.has(canonicalEnv)) {
      resolvedByEnv.set(canonicalEnv, policy.resolveForEnvironment(config.store, canonicalEnv));
    }
    return resolvedByEnv.get(canonicalEnv);
  }

  // --- filtering ------------------------------------------------------------

  // For an operationGroups item this is the catalogue entry itself, tags and all.
  function groupOf(item, isOperation) {
    if (!item) return null;
    if (!isOperation) return item;
    var og = item.properties && item.properties.operationGroup;
    if (!og) return null;
    // Operation items carry the operation's own tags, not the group's, so only
    // name and display name are meaningful for category rules here.
    return { name: og.name, properties: { displayName: og.displayName, tags: [] } };
  }

  function keeper(canonicalEnv, isOperation) {
    var settings = config.settings;
    var resolved = settings.hideBlocked ? resolveFor(canonicalEnv) : null;
    return function (item) {
      var group = groupOf(item, isOperation);
      if (!group || !group.name) return true; // unrecognised shape: leave it be
      if (resolved && policy.isGroupBlocked(resolved, group.name)) return false;
      if (compiledRules && compiledRules.length && filters.hiddenBy(group, compiledRules)) return false;
      return true;
    };
  }

  function fetchPage(url, ctx) {
    var headers = {};
    Object.keys(ctx.requestHeaders || {}).forEach(function (k) {
      // Let the browser set its own hop-by-hop and content headers.
      if (k !== 'content-length' && k !== 'host') headers[k] = ctx.requestHeaders[k];
    });
    // No credentials: the catalogue answers Access-Control-Allow-Origin:* with no
    // Access-Control-Allow-Credentials, so asking for cookies makes the browser
    // reject the response outright ("Failed to fetch"). The designer's own XHR
    // sends no cookie either - it is bearer//header authenticated.
    return hook.originalFetch(url, {
      method: ctx.method,
      headers: headers,
      body: ctx.method === 'GET' || ctx.method === 'HEAD' ? undefined : ctx.requestBody,
      credentials: 'omit'
    }).then(function (res) {
      if (!res.ok) {
        log.warn('backfill page', url, 'returned', res.status, '- stopping the top-up');
        return null;
      }
      return res.json();
    });
  }

  function backfill(payload, keep, ctx) {
    return __cdpa.paginate.backfill(payload, keep, {
      target: BACKFILL_TARGET,
      maxHops: BACKFILL_MAX_HOPS,
      fetchPage: function (url) { return fetchPage(url, ctx); }
    });
  }

  function transform(ctx) {
    return configReady.then(function () {
      if (!config || !config.settings) return undefined;
      if (ctx.status !== 200) return undefined;

      var canonicalEnv = env.canonicalFromUrl(ctx.url);
      if (!canonicalEnv) {
        log.debug('no environment in host for', ctx.url, '- leaving it alone');
        return undefined;
      }

      var payload;
      try {
        payload = JSON.parse(ctx.text);
      } catch (e) {
        return undefined;
      }
      if (!payload || !Array.isArray(payload.value)) return undefined;

      var isOperation = OPERATIONS_RE.test(ctx.url);
      var what = isOperation ? 'operations' : 'operationGroups';

      payload.value.forEach(function (item) { remember(item, isOperation); });
      reportConnectors();

      if (config.settings.showEverything) {
        log.debug(what + ': "show everything" is on, passing all',
          payload.value.length, 'entries through');
        return undefined;
      }

      var done = log.time(what + ' filter');
      var keep = keeper(canonicalEnv, isOperation);
      var before = payload.value.length;
      var hidden = [];
      payload.value = payload.value.filter(function (item) {
        if (keep(item)) return true;
        if (log.enabled && hidden.length < 5) {
          var group = groupOf(item, isOperation);
          hidden.push(group && group.name);
        }
        return false;
      });
      done(before + ' -> ' + payload.value.length + ' (env ' + env.toDisplay(canonicalEnv) +
        (hidden.length ? '; hid e.g. ' + hidden.join(', ') : '') + ')');

      if (payload.value.length === before) return undefined; // nothing removed

      if (!payload.nextLink) return JSON.stringify(payload);
      return backfill(payload, keep, ctx).then(function (finished) {
        return JSON.stringify(finished);
      });
    });
  }

  // --- auto-fetch (opt-in) --------------------------------------------------

  // The portal talks to BAP with more than one token, and to regional hosts as
  // well as the global one, so every Authorization header seen is kept as a
  // candidate. Memory only: never persisted, never sent to the background.
  function rememberToken(info) {
    try {
      var host = new URL(info.url).hostname;
      if (!BAP_RE.test(host)) return;
      var auth = info.headers && (info.headers.authorization || info.headers.Authorization);
      if (!auth || tokens.indexOf(auth) !== -1) return;
      tokens.unshift(auth);
      if (tokens.length > 8) tokens.length = 8;
      // Never log the token itself - only that one more candidate exists.
      log.debug('captured a BAP token candidate from', host, '-', tokens.length, 'now held');
      maybeAutoFetch();
    } catch (e) { /* ignore */ }
  }

  var autoFetchStarted = false;

  function maybeAutoFetch() {
    if (autoFetchStarted) return;
    if (!config || !config.settings || !config.settings.autoFetch) return;
    if (!tokens.length) return;
    autoFetchStarted = true;

    askBridge('shouldRefresh').then(function (reply) {
      if (!reply || !reply.should) {
        log.debug('auto-fetch: still inside the backoff window, not attempting');
        return;
      }
      log.debug('auto-fetch: attempting with', tokens.length, 'token candidate(s)');
      return attemptWithTokens(tokens.slice());
    }).catch(function (err) {
      log.warn('auto-fetch could not start:', (err && err.message) || err);
    });
  }

  function govUrl(path) {
    return 'https://api.bap.microsoft.com/providers/PowerPlatform.Governance/v1/' + path;
  }

  function govGet(url, auth) {
    return hook.originalFetch(url, { headers: { authorization: auth, accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) return Promise.reject(new Error('HTTP ' + res.status));
        return res.json();
      });
  }

  // The whole list, following nextLink. It replaces the stored set, so a first
  // page on its own would silently drop every policy after it.
  var MAX_POLICY_PAGES = 20;

  function govGetAll(url, auth) {
    var all = [];
    function page(next, n) {
      return govGet(next, auth).then(function (body) {
        if (!body || !Array.isArray(body.value)) return Promise.reject(new Error('unexpected policy list shape'));
        all = all.concat(body.value);
        if (!body.nextLink) return { value: all };
        if (n >= MAX_POLICY_PAGES) return Promise.reject(new Error('policy list longer than ' + n + ' pages'));
        // The token goes wherever nextLink points, so it must still be BAP.
        var host;
        try { host = new URL(body.nextLink).hostname; } catch (e) { host = ''; }
        if (!BAP_RE.test(host)) return Promise.reject(new Error('nextLink left the BAP API'));
        return page(body.nextLink, n + 1);
      });
    }
    return page(url, 1);
  }

  function attemptWithTokens(candidates) {
    if (!candidates.length) {
      // Every token was rejected - expected for a maker without admin rights.
      log.debug('auto-fetch: every token candidate was rejected. This is normal',
        'unless your account can read DLP policies; backing off.');
      post({ type: 'refreshFailed' });
      return Promise.resolve();
    }
    var auth = candidates.shift();
    var attempt = tokens.length - candidates.length;
    return govGetAll(govUrl('policies?$top=100'), auth).then(function (policies) {
      log.debug('auto-fetch: candidate', attempt, 'accepted -', policies.value.length, 'policies returned');
      // An empty answer is what some tokens get instead of a 403. Storing it
      // would replace real policy data with nothing, so it counts as a miss.
      if (!policies.value.length) return Promise.reject(new Error('no policies visible'));
      return Promise.all([
        govGet(govUrl('connectors/metadata/unblockable'), auth).catch(function () { return null; }),
        govGet(govUrl('connectors/metadata/virtual'), auth).catch(function () { return null; })
      ]).then(function (meta) {
        var payload = { policies: policies, replaceAll: true };
        if (meta[0]) payload.unblockable = meta[0];
        if (meta[1]) payload.virtual = meta[1];
        log.debug('auto-fetch: storing policies; unblockable',
          meta[0] ? 'fetched' : 'unavailable', ', virtual', meta[1] ? 'fetched' : 'unavailable');
        post({ type: 'importPolicies', payload: payload });
      });
    }).catch(function (err) {
      log.debug('auto-fetch: candidate', attempt, 'rejected (' + ((err && err.message) || err) + ')',
        candidates.length ? '- trying the next one' : '- no candidates left');
      return attemptWithTokens(candidates);
    });
  }

  var pendingAsks = new Map();
  var askId = 0;

  function askBridge(kind) {
    var id = ++askId;
    return new Promise(function (resolve) {
      pendingAsks.set(id, resolve);
      post({ type: 'ask', ask: kind, id: id });
      setTimeout(function () {
        if (pendingAsks.has(id)) {
          pendingAsks.delete(id);
          log.warn('the bridge did not answer', JSON.stringify(kind), 'within',
            CONFIG_TIMEOUT_MS + 'ms');
          resolve(null);
        }
      }, CONFIG_TIMEOUT_MS);
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'answer') return;
    var resolve = pendingAsks.get(msg.id);
    if (resolve) {
      pendingAsks.delete(msg.id);
      resolve(msg.result);
    }
  });

  window.addEventListener('pagehide', function () { tokens.length = 0; });

  // --- wiring ---------------------------------------------------------------

  hook.register({
    match: function (url) {
      if (!env.canonicalFromUrl(url)) return false;
      return GROUPS_RE.test(url) || OPERATIONS_RE.test(url);
    },
    observeRequest: rememberToken,
    transform: transform
  });
})();
