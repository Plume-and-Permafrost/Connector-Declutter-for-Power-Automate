'use strict';
// Admin-centre capture (page context).
//
// The DLP pages in the Power Platform admin centre already download every policy
// the signed-in admin can see. Rather than ask for a token and fetch them again,
// this watches those responses go past and hands them to the isolated-world half
// of the extension. Read-only: the transform always returns undefined, so the
// admin centre gets exactly the bytes it asked for.
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
  var log = __cdpa.log.create('admin');
  var CHANNEL = 'cdpa-admin-capture';

  var KINDS = [
    { kind: 'policyList', re: /\/PowerPlatform\.Governance\/v1\/policies(?:\?|$)/i },
    { kind: 'policy', re: /\/PowerPlatform\.Governance\/v1\/policies\/[^/?#]+(?:\?|$)/i },
    { kind: 'unblockable', re: /\/PowerPlatform\.Governance\/v1\/connectors\/metadata\/unblockable/i },
    { kind: 'virtual', re: /\/PowerPlatform\.Governance\/v1\/connectors\/metadata\/virtual/i }
  ];

  function kindFor(url) {
    // policy-detail is checked first because the list pattern also matches it
    for (var i = KINDS.length - 1; i >= 0; i--) {
      if (KINDS[i].re.test(url)) return KINDS[i].kind;
    }
    return null;
  }

  function tenantFrom(url) {
    var m = /\/PowerPlatform\.Governance\/v1\/tenants\/([^/?#]+)\//i.exec(url);
    return m ? m[1] : null;
  }

  function post(message) {
    try {
      message.channel = CHANNEL;
      window.postMessage(message, location.origin);
    } catch (e) {
      log.warn('could not hand the capture to the extension:', e.message);
    }
  }

  __cdpa.httpHook.register({
    match: function (url) {
      return kindFor(url) !== null;
    },
    observeRequest: function (info) {
      var tenantId = tenantFrom(info.url);
      if (tenantId) post({ type: 'tenant', tenantId: tenantId });
    },
    transform: function (ctx) {
      var kind = kindFor(ctx.url);
      if (ctx.status !== 200) {
        log.debug('ignoring', kind, 'response with status', ctx.status);
        return undefined;
      }
      var data;
      try {
        data = JSON.parse(ctx.text);
      } catch (e) {
        log.warn('could not parse the', kind, 'response:', e.message);
        return undefined;
      }
      log.debug('captured', kind, '-', ctx.text.length, 'bytes,',
        (data && Array.isArray(data.value) ? data.value.length + ' entries'
          : Array.isArray(data) ? data.length + ' entries' : 'single object'));
      post({ type: 'captured', kind: kind, url: ctx.url, data: data });
      return undefined; // observe only - never rewrite the admin centre
    }
  });
})();
