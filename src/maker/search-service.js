'use strict';
// Our own pills in the designer's connector filter (page context).
//
// The designer's filter - All, Built-in, Shared, Custom - is not markup we can
// add to. The list of pills and the predicate behind each one both live in one
// class inside its bundle:
//
//   getRuntimeCategories()                -> [{ key, text }, …]  the pills
//   filterConnector(connector, category)  -> boolean             browsing
//   searchOperations(term, actionType, category, …) -> Promise   searching
//
// So that class is what gets extended. Appending to getRuntimeCategories means
// the designer renders our pills itself, with its own markup, its own selected
// state and its own empty state ("No results found for the specified filters")
// when a filter matches nothing. There is nothing here that has to be kept in
// step with a re-render, and nothing that stops working when Fluent renames a
// class.
//
// Building the pills out of cloned DOM instead does not work, and it is worth
// saying why: React binds its handlers through its own fiber tree, and a node we
// create has no fiber. Such a pill looks right and does nothing when clicked.
//
// The class is found by SHAPE - the three method names above - rather than by
// webpack module id or by any minified identifier, because those change on every
// deploy. If the shape ever stops matching, nothing is patched, this logs and
// gives up, and the designer keeps its stock behaviour.
//
// This is a different layer from the response filtering in interceptor.js and
// they do not overlap: that one hides what the maker cannot use, always, on the
// wire; this one is the maker choosing a subset of what is left, one click at a
// time, and it is the designer's own state.

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
  var log = __cdpa.log.create('search-service');
  var views = __cdpa.views;
  // Optional: without it, "In Flow" is offered empty rather than not at all, so
  // one pill going quiet cannot take the other two with it.
  var inFlow = __cdpa.inFlow;
  var CHANNEL = 'cdpa-maker';

  // Prefixed so a key of ours can never collide with one the designer adds
  // later, and so an unknown key in its own state is obviously not ours.
  var KEY_PREFIX = 'CDPA_';
  // The category the designer understands as "no filter". Our pills ask for this
  // and narrow the answer themselves.
  var ALL = 'ALL';

  var POLL_MS = 100;
  var POLL_LIMIT = 600; // ~60s, then give up rather than spin for the session

  // Every method the class must have before it is believed to be the right one.
  var REQUIRED = ['filterConnector', 'getRuntimeCategories', 'searchOperations'];

  var settings = {};
  // key -> compiled view. Built once up front so the pills work before the
  // bridge has delivered anything: the Microsoft list is fixed, and an empty
  // "My Filter" is a correct, if uninteresting, answer.
  var byKey = {};

  function keyFor(view) { return KEY_PREFIX + String(view.id).toUpperCase(); }

  // The views as they stand right now: two from the settings, one from the flow
  // on screen.
  function currentViews() {
    return views.list(settings, { inFlow: inFlow ? inFlow.list() : [] });
  }

  function rebuild() {
    var next = {};
    var order = [];
    currentViews().forEach(function (view) {
      var key = keyFor(view);
      // compile(), not active(): a pill is an explicit click, so an empty view
      // means "show me nothing", which the designer renders as its own empty
      // state. It is one click back to All.
      next[key] = views.compile(view);
      order.push(key + '=' + next[key].size);
    });
    byKey = next;
    return order;
  }

  rebuild();

  // The flow's connectors change as it is edited and saved, with no settings
  // change to ride along on.
  if (inFlow) {
    inFlow.onChange(function () {
      log.debug('filters now:', rebuild().join(', '));
    });
  }

  function ours(category) {
    return Object.prototype.hasOwnProperty.call(byKey, category) ? byKey[category] : null;
  }

  // What a pill matches when browsing: the operation group itself.
  function matchConnector(view, connector) {
    return views.shows(view, connector && connector.name);
  }

  // …and when searching: an operation, which names its group underneath.
  //
  // operationGroup and not api: a built-in operation has properties.api = null and
  // is filed under Control, Variable, Schedule and the rest in operationGroup
  // instead, so reading api alone drops every built-in from every search made
  // under one of our pills. A connector operation carries both, and they agree.
  function matchOperation(view, operation) {
    var props = (operation && operation.properties) || {};
    var group = props.operationGroup || props.api;
    return views.shows(view, group && group.name);
  }

  // --- getting hold of __webpack_require__ ----------------------------------
  //
  // This build's jsonp callback ignores data[2] (executeModules), so pushing a
  // module of our own and letting it run does not work here. Instead every
  // chunk's module factories are wrapped on the way past; the first one the app
  // executes hands us the require function, whose .c is the module cache.

  var wreq = null;
  var jsonp = (window.webpackJsonp = window.webpackJsonp || []);

  function wrapFactories(data) {
    var mods = data && data[1];
    if (!mods) return;
    Object.keys(mods).forEach(function (id) {
      var orig = mods[id];
      if (typeof orig !== 'function' || orig.__cdpaWrapped) return;
      var wrapped = function (module, exports, req) {
        if (!wreq && req && req.c) {
          wreq = req;
          log.debug('captured the bundle\'s require function');
        }
        var result = orig.apply(this, arguments);
        // A module just ran, so the class may exist now - including in a chunk
        // loaded long after the startup poll below has given up.
        scheduleScan();
        return result;
      };
      wrapped.__cdpaWrapped = true;
      mods[id] = wrapped;
    });
  }

  jsonp.forEach(wrapFactories); // anything queued before this script ran

  // The runtime does `s = a.push.bind(a); a.push = t`, so the assignment is what
  // there is to intercept: this puts our wrapper in front of the real callback.
  var pushImpl = jsonp.push;
  try {
    Object.defineProperty(jsonp, 'push', {
      configurable: true,
      get: function () { return pushImpl; },
      set: function (runtimeCallback) {
        pushImpl = function (data) {
          wrapFactories(data);
          return runtimeCallback.apply(this, arguments);
        };
      }
    });
  } catch (e) {
    log.warn('could not hook webpackJsonp.push -', e.message,
      '- the custom filters will not appear');
  }

  // --- finding and patching the class ---------------------------------------

  function findServiceClass(req) {
    for (var id in req.c) {
      var exports;
      try {
        exports = req.c[id] && req.c[id].exports;
      } catch (e) { continue; }
      if (!exports || typeof exports !== 'object') continue;

      for (var key in exports) {
        var value;
        // A getter on a module's exports can throw; that is not our problem.
        try {
          value = exports[key];
        } catch (e2) { continue; }
        if (typeof value !== 'function' || !value.prototype) continue;
        var matches = REQUIRED.every(function (m) {
          return typeof value.prototype[m] === 'function';
        });
        if (matches) return value;
      }
    }
    return null;
  }

  function patch(Klass) {
    var P = Klass.prototype;
    if (P.__cdpaPatched) return;
    P.__cdpaPatched = true;

    // --- the pills themselves -----------------------------------------------
    var origCategories = P.getRuntimeCategories;
    P.getRuntimeCategories = function () {
      var base = origCategories.apply(this, arguments) || [];
      // Empty means the host has not supplied its localised strings yet and the
      // UI is about to fall back to its own defaults, so there is nothing here
      // worth appending to.
      if (!base.length) return base;
      return base.concat(currentViews().map(function (view) {
        return { key: keyFor(view), text: view.label };
      }));
    };

    // --- browsing, with no search text --------------------------------------
    var origFilterConnector = P.filterConnector;
    P.filterConnector = function (connector, category) {
      var view = ours(category);
      if (!view) return origFilterConnector.apply(this, arguments);
      try {
        return !!matchConnector(view, connector);
      } catch (e) {
        log.warn('matching', category, 'against a connector threw:', e.message);
        return false;
      }
    };

    // --- searching ------------------------------------------------------------
    // A category the service does not know falls through its tag mapper to "no
    // tag filter", so asking for it directly would quietly return everything.
    // Ask for ALL instead and narrow the answer here.
    var origSearch = P.searchOperations;
    P.searchOperations = function (term, actionType, category) {
      var view = ours(category);
      if (!view) return origSearch.apply(this, arguments);

      var self = this;
      var rest = Array.prototype.slice.call(arguments, 3);
      return Promise.resolve(
        origSearch.apply(self, [term, actionType, ALL].concat(rest))
      ).then(function (all) {
        var kept = (all || []).filter(function (operation) {
          try {
            return !!matchOperation(view, operation);
          } catch (e) { return false; }
        });
        log.debug('search in', category + ':', (all || []).length, '->', kept.length);
        // getOperationById() reads lastSearchResults, so leaving it holding the
        // unfiltered list makes clicking a result fail to resolve.
        self.lastSearchResults = kept;
        return kept;
      });
    };

    log.info('added the custom filters:', Object.keys(byKey).join(', '));
  }

  var patched = false;
  var scanTimer = null;

  function tryPatch() {
    if (patched || !wreq) return;
    var Klass = findServiceClass(wreq);
    if (!Klass) return;
    patched = true;
    clearInterval(timer);
    patch(Klass);
  }

  // Modules execute in bursts; one scan after each burst is plenty.
  function scheduleScan() {
    if (patched || scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      tryPatch();
    }, POLL_MS);
  }

  // The startup poll covers modules that ran before anything scheduled a scan.
  var tries = 0;
  var timer = setInterval(function () {
    if (++tries > POLL_LIMIT) {
      clearInterval(timer);
      log.debug('startup poll found no search service after', tries, 'attempts',
        wreq ? '- will look again as later chunks load' : '- the bundle was never seen');
      return;
    }
    tryPatch();
  }, POLL_MS);

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'config') return;
    settings = msg.settings || {};
    log.debug('filters now:', rebuild().join(', '));
  });
})();
