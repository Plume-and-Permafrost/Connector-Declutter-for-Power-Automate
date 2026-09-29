'use strict';
// Debug logging for the ISOLATED content-script worlds.
//
// This is deliberately a separate file from src/common/log.js, and the two must
// never appear in the same content_scripts entry pair. Chrome injects a given
// file into a document once: when the same path is listed in both the MAIN and
// the ISOLATED entry for one URL, the first entry claims it and the second
// silently gets nothing. That is what left every isolated-world script without
// its dependencies - see the manifest guard in test/manifest.test.js.
//
// The split is not pure duplication: the two worlds have opposite capabilities.
// This half owns chrome.storage (so it reads the setting directly and mirrors it
// into the page for the other half), and needs none of the page-context startup
// plumbing that src/common/log.js carries.
var __cdpa = globalThis.__cdpa || (globalThis.__cdpa = {});

__cdpa.log = __cdpa.log && __cdpa.log.isReal ? __cdpa.log : (function () {
  var PREFIX = 'declutter';
  var FLAG_KEY = 'cdpa:debug';
  var enabled = false;
  var channels = {};

  function setEnabled(value) {
    var next = !!value;
    if (next === enabled) return enabled;
    enabled = next;
    try {
      console.info('[' + PREFIX + '] debug logging ' + (enabled ? 'on' : 'off') + ' (isolated world)');
    } catch (e) { /* ignore */ }
    return enabled;
  }

  // The page context cannot read chrome.storage, so it picks the flag up from
  // here at document_start on the next load.
  function mirrorToPage(value) {
    try {
      if (!globalThis.localStorage) return;
      if (value) globalThis.localStorage.setItem(FLAG_KEY, '1');
      else globalThis.localStorage.removeItem(FLAG_KEY);
    } catch (e) { /* storage can be blocked; not worth a warning */ }
  }

  function apply(value) {
    setEnabled(value);
    mirrorToPage(value);
  }

  function announce(message) {
    try { console.warn('[' + PREFIX + '] ' + message); } catch (e) { /* ignore */ }
  }

  function watchStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      // Callback form: the promise form is not dependable in content scripts.
      chrome.storage.local.get('settings', function (r) {
        if (chrome.runtime && chrome.runtime.lastError) {
          announce('could not read the debug setting: ' + chrome.runtime.lastError.message);
          return;
        }
        apply(!!(r && r.settings && r.settings.debug));
      });
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.settings) return;
        apply(!!(changes.settings.newValue && changes.settings.newValue.debug));
      });
    } catch (e) {
      announce('could not follow the debug setting: ' + ((e && e.message) || e));
    }
  }

  function emit(method, name, args) {
    if (!enabled) return;
    try {
      var out = Array.prototype.slice.call(args);
      out.unshift('[' + PREFIX + ':' + name + ']');
      (console[method] || console.log).apply(console, out);
    } catch (e) { /* logging must never break anything */ }
  }

  function create(name) {
    if (channels[name]) return channels[name];
    channels[name] = {
      debug: function () { emit('debug', name, arguments); },
      info: function () { emit('info', name, arguments); },
      warn: function () { emit('warn', name, arguments); },
      error: function () { emit('error', name, arguments); },
      time: function (label) {
        if (!enabled) return function () {};
        var started = Date.now();
        return function (suffix) {
          emit('debug', name, [label, (Date.now() - started) + 'ms', suffix === undefined ? '' : suffix]);
        };
      },
      get enabled() { return enabled; }
    };
    return channels[name];
  }

  return {
    isReal: true,
    FLAG_KEY: FLAG_KEY,
    create: create,
    isEnabled: function () { return enabled; },
    setEnabled: setEnabled,
    mirrorToPage: mirrorToPage,
    watchStorage: watchStorage
  };
})();
