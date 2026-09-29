'use strict';
// Designer bridge (isolated world).
//
// The interceptor runs in page context and so has no chrome.* access. This half
// owns that access: it pushes settings and policy data across, answers the
// questions the interceptor cannot answer itself, and re-pushes whenever
// anything changes so a settings edit takes effect without a reload.

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
  var log = __cdpa.log.create('bridge');
  var CHANNEL = 'cdpa-maker';

  __cdpa.log.watchStorage();

  function send(type, extra) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(Object.assign({ type: 'cdpa:' + type }, extra || {}), function (reply) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(reply && reply.ok ? reply.result : null);
        });
      } catch (e) {
        log.warn('could not reach the service worker for', type,
          '- the extension was probably reloaded; this tab needs a refresh');
        resolve(null);
      }
    });
  }

  function post(message) {
    try {
      message.channel = CHANNEL;
      window.postMessage(message, location.origin);
    } catch (e) { /* ignore */ }
  }

  // Anything on the page can post to this channel, not only our own page-context
  // half. So the messages that write to storage are only believed when they are
  // what the bridge is waiting for, and are checked for shape before they go on.
  //
  // An auto-fetch result is expected only after this bridge has itself said a
  // refresh may go ahead, with auto-fetch switched on, and not long ago.
  var AUTO_FETCH_WINDOW_MS = 2 * 60 * 1000;
  var MAX_CONNECTORS_PER_REPORT = 2000;
  var autoFetchSettings = false;
  var expectingResultUntil = 0;

  function expectingResult() {
    return autoFetchSettings && Date.now() < expectingResultUntil;
  }

  function validImport(payload) {
    if (!payload || typeof payload !== 'object') return false;
    var p = payload.policies;
    return !!(p && typeof p === 'object' && Array.isArray(p.value) && p.value.length);
  }

  function cleanConnectors(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, MAX_CONNECTORS_PER_REPORT).filter(function (c) {
      return c && typeof c.name === 'string' && c.name.length <= 256 &&
        (c.displayName === undefined || (typeof c.displayName === 'string' && c.displayName.length <= 256));
    }).map(function (c) { return { name: c.name, displayName: c.displayName }; });
  }

  function pushConfig() {
    return Promise.all([send('getSettings'), send('getPolicyStore')]).then(function (r) {
      if (r[0]) autoFetchSettings = !!r[0].autoFetch;
      if (!r[0] || !r[1]) {
        log.warn('no settings or policy store came back - page context will not be configured');
        return;
      }
      log.debug('pushing config to page context:',
        Object.keys(r[1].policies || {}).length, 'policies,',
        (r[0].categoryRules || []).length, 'category rules');
      post({ type: 'config', settings: r[0], store: r[1] });
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;

    if (msg.type === 'ask' && msg.ask === 'shouldRefresh') {
      if (!autoFetchSettings) {
        post({ type: 'answer', id: msg.id, result: { should: false } });
        return;
      }
      send('shouldRefresh').then(function (result) {
        if (result && result.should) expectingResultUntil = Date.now() + AUTO_FETCH_WINDOW_MS;
        post({ type: 'answer', id: msg.id, result: result });
      });
      return;
    }

    if (msg.type === 'importPolicies') {
      if (!expectingResult() || !validImport(msg.payload)) {
        log.warn('ignored a policy import from page context that was not expected or not well formed');
        return;
      }
      expectingResultUntil = 0;
      log.debug('page context auto-fetched policies; storing them');
      send('importPolicies', { payload: msg.payload, source: 'auto' }).then(function (result) {
        log.debug('auto-fetch stored', result && result.policyCount, 'policies');
        return pushConfig();
      });
      return;
    }

    if (msg.type === 'connectorsSeen') {
      var connectors = cleanConnectors(msg.connectors);
      if (connectors.length) send('rememberConnectors', { connectors: connectors });
      return;
    }

    if (msg.type === 'refreshFailed') {
      if (!expectingResult()) return;
      expectingResultUntil = 0;
      log.debug('page context reported a failed refresh; recording a backoff');
      send('recordRefreshFailure');
    }
  });

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.settings || changes.policyStore) {
        log.debug('storage changed (' + Object.keys(changes).join(', ') + ') - re-pushing config');
        pushConfig();
      }
    });
  } catch (e) { /* ignore */ }

  pushConfig();
})();
