'use strict';
// Debug logging, off unless switched on in settings.
//
// The extension runs in four places at once - the designer's page context, an
// isolated content-script world, the service worker and its own pages - and a
// problem usually spans two of them. Every channel prefixes its output with
// [declutter:<where>] so a single console filter follows one request across the
// boundary.
//
// Where the output lands:
//   maker, http, policy, filters, paginate, decorate, sections,
//   hover, in-flow, search-service, bridge  - the designer tab's console
//   admin, admin-ui                         - the admin centre tab's console
//   background, storage                     - the service worker console
//                                             (chrome://extensions -> Inspect)
//   options, popup                          - the extension page's own console
//
// storage and the pure common modules log wherever they happen to be loaded,
// so those channels can appear in more than one console.
//
// The isolated worlds load src/iso/log.js instead of this file - see the note
// there for why the two cannot be the same path.
//
// Page context cannot read chrome.storage, so the flag reaches it two ways: the
// bridge pushes it across with the rest of the settings, and it is mirrored into
// the page's localStorage so that logging is live from document_start on the
// next load - which is the only way to see the startup path itself.
var __cdpa = globalThis.__cdpa || (globalThis.__cdpa = {});

__cdpa.log = (function () {
  var PREFIX = 'declutter';
  var FLAG_KEY = 'cdpa:debug';
  var enabled = false;
  var channels = {};

  function readMirroredFlag() {
    try {
      return globalThis.localStorage && globalThis.localStorage.getItem(FLAG_KEY) === '1';
    } catch (e) {
      return false; // storage can be blocked; that is not worth a warning
    }
  }

  function isEnabled() {
    return enabled;
  }

  function setEnabled(value) {
    var next = !!value;
    if (next === enabled) return enabled;
    enabled = next;
    // Announced on both edges so a console that was open the whole time shows
    // where logging started and stopped.
    try {
      console.info('[' + PREFIX + '] debug logging ' + (enabled ? 'on' : 'off'));
    } catch (e) { /* ignore */ }
    return enabled;
  }

  // Copies the flag to the page's own storage so page context can pick it up at
  // document_start next time. Only called from a context with chrome access.
  function mirrorToPage(value) {
    try {
      if (!globalThis.localStorage) return;
      if (value) globalThis.localStorage.setItem(FLAG_KEY, '1');
      else globalThis.localStorage.removeItem(FLAG_KEY);
    } catch (e) { /* ignore */ }
  }

  // Said out loud whatever the flag is: a failure here is why nothing else speaks.
  function announce(message) {
    try {
      console.warn('[' + PREFIX + '] ' + message);
    } catch (e) { /* ignore */ }
  }

  function apply(value) {
    setEnabled(value);
    mirrorToPage(value);
  }

  // For contexts that can read chrome.storage: follow the setting live, and
  // keep the page-side mirror in step for the page context beside us.
  function watchStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      // Callback form on purpose. The promise form is not dependable in content
      // scripts, and when it is missing `.then` throws into the catch below -
      // which is how isolated-world logging silently stayed off everywhere.
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
      // Never silent: this is the switch that turns everything else on.
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
      // Returns a function that logs how long the labelled work took.
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

  enabled = readMirroredFlag();

  return {
    FLAG_KEY: FLAG_KEY,
    create: create,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    mirrorToPage: mirrorToPage,
    watchStorage: watchStorage
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.log;
