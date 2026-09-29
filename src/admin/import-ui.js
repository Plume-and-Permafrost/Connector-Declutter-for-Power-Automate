'use strict';
// Admin-centre import (isolated world).
//
// Receives whatever the page-context capture saw and decides what to do with it:
// on a first run it offers an explicit Import button, and once the extension
// already holds policy data it just updates it quietly. Nothing is ever stored
// without either an explicit click or an existing store to refresh.

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
  var log = __cdpa.log.create('admin-ui');
  var CHANNEL = 'cdpa-admin-capture';

  __cdpa.log.watchStorage();
  var IMPORT_DEBOUNCE_MS = 600;
  // Signature of the payload last written, so an unchanged re-capture is a no-op.
  var lastImported = null;

  var pending = { policyList: null, listIsPartial: false, listFromStart: false, policy: null, unblockable: null, virtual: null,
    tenantId: null };
  var timer = null;
  var ui = null;

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

  // The admin SPA re-fetches the governance endpoints several times per visit,
  // seconds apart, so the debounce alone still let the same 1 MB payload be
  // stored over and over. A cheap structural signature settles whether anything
  // actually changed; policy edits move lastModifiedTime, which is what we key on.
  function signatureOf(payload) {
    var parts = [];
    var list = payload.policies;
    var policies = list && Array.isArray(list.value) ? list.value
      : Array.isArray(list) ? list : list ? [list] : [];
    policies.forEach(function (p) {
      parts.push((p && p.name) + '@' + (p && (p.lastModifiedTime || p.lastModified || '')));
    });
    parts.push('u' + ((payload.unblockable || []).length));
    parts.push('v' + ((payload.virtual || []).length));
    parts.push('t' + (payload.tenantId || ''));
    return parts.join('|');
  }

  function havePending() {
    return !!(pending.policyList || pending.policy || pending.unblockable || pending.virtual);
  }

  function buildPayload() {
    var payload = {};
    if (pending.policyList) {
      payload.policies = pending.policyList;
      // One page of a longer list must not stand in for the whole of it.
      payload.replaceAll = !pending.listIsPartial;
    } else if (pending.policy) {
      payload.policies = pending.policy;
      payload.replaceAll = false;
    }
    if (pending.unblockable) payload.unblockable = pending.unblockable;
    if (pending.virtual) payload.virtual = pending.virtual;
    if (pending.tenantId) payload.tenantId = pending.tenantId;
    return payload;
  }

  function policyCount() {
    if (pending.policyList && Array.isArray(pending.policyList.value)) return pending.policyList.value.length;
    if (pending.policy) return 1;
    return 0;
  }

  function doImport() {
    if (!havePending()) return Promise.resolve(null);
    var payload = buildPayload();
    var signature = signatureOf(payload);
    return send('importPolicies', { payload: payload, source: 'admin-capture' })
      .then(function (result) {
        // Only remember it once it is actually stored, so a failed write retries.
        if (result && result.ok) lastImported = signature;
        return result;
      });
  }

  // Once there is a stored copy, a visit to the admin centre refreshes it in
  // place - the payload is already in the page, so there is no request to save
  // and nothing to ask the user about.
  function onCapture() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      send('getStatus', {}).then(function (status) {
        // A different tenant's policies are never replaced quietly: someone who
        // administers several tenants would otherwise lose the one their makers
        // use just by looking at another.
        var otherTenant = !!(status && status.tenantId && pending.tenantId &&
          String(status.tenantId).toLowerCase() !== String(pending.tenantId).toLowerCase());
        if (otherTenant) {
          log.debug('stored policies are for tenant', status.tenantId, '- this is', pending.tenantId,
            '- asking before replacing them');
          showPrompt(true);
          return;
        }
        if (status && status.hasData) {
          var signature = signatureOf(buildPayload());
          if (signature === lastImported) {
            log.debug('capture matches what is already stored - nothing to do');
            return;
          }
          log.debug('already holding', status.policyCount,
            'policies - refreshing quietly rather than prompting');
          doImport().then(function (result) {
            if (result && result.ok) showToast('DLP policies updated (' + result.policyCount + ').');
            else log.warn('the quiet refresh did not store anything');
          });
        } else {
          log.debug('no stored policy data - prompting to import', policyCount(), 'policies');
          showPrompt();
        }
      });
    }, IMPORT_DEBOUNCE_MS);
  }

  // --- UI -------------------------------------------------------------------

  function ensureUi() {
    if (ui) return ui;
    var host = document.createElement('div');
    host.id = 'cdpa-admin-ui';
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.card{font:13px/1.45 "Segoe UI",system-ui,sans-serif;color:#1b1b1f;background:#fff;border:1px solid #d6d6d6;' +
      'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:14px 16px;max-width:320px}' +
      '.title{font-weight:600;margin:0 0 6px}' +
      '.body{margin:0 0 12px;color:#444}' +
      '.row{display:flex;gap:8px;justify-content:flex-end}' +
      'button{font:inherit;border-radius:4px;padding:5px 12px;cursor:pointer;border:1px solid #8a8886;background:#fff}' +
      'button.primary{background:#0f6cbd;border-color:#0f6cbd;color:#fff}' +
      '.toast{font:13px/1.45 "Segoe UI",system-ui,sans-serif;background:#1b1b1f;color:#fff;border-radius:6px;padding:9px 14px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.25)}' +
      '@media (prefers-color-scheme: dark){' +
      '.card{background:#292929;color:#f3f3f3;border-color:#3d3d3d}.body{color:#c8c8c8}' +
      'button{background:#333;color:#f3f3f3;border-color:#5c5c5c}button.primary{background:#115ea3;border-color:#115ea3}}' +
      '</style><div class="slot"></div>';
    (document.body || document.documentElement).appendChild(host);
    ui = { host: host, slot: root.querySelector('.slot') };
    return ui;
  }

  function clearUi() {
    if (ui) ui.slot.innerHTML = '';
  }

  function showPrompt(otherTenant) {
    var count = policyCount();
    if (!count) return;
    var single = !pending.policyList && pending.policy;
    var view = ensureUi();
    view.slot.innerHTML =
      '<div class="card">' +
      '<p class="title">Connector Declutter for Power Automate</p>' +
      '<p class="body"></p>' +
      '<div class="row"><button data-act="dismiss">Not now</button>' +
      '<button class="primary" data-act="import">Import</button></div></div>';

    view.slot.querySelector('.body').textContent = single
      ? 'Import this DLP policy so the Power Automate designer can hide the connectors it blocks?'
      : 'Import ' + count + ' DLP ' + (count === 1 ? 'policy' : 'policies') +
        ' so the Power Automate designer can hide the connectors they block?';
    if (otherTenant) {
      view.slot.querySelector('.body').textContent +=
        ' This replaces the policies stored for a different tenant.';
    }
    view.slot.querySelector('[data-act="dismiss"]').addEventListener('click', clearUi);
    view.slot.querySelector('[data-act="import"]').addEventListener('click', function () {
      doImport().then(function (result) {
        if (result && result.ok) {
          showToast('Imported ' + result.policyCount + ' DLP ' + (result.policyCount === 1 ? 'policy' : 'policies') + '.');
        } else {
          showToast('Import failed. Try the options page instead.');
        }
      });
    });
  }

  function showToast(text) {
    var view = ensureUi();
    view.slot.innerHTML = '<div class="toast"></div>';
    view.slot.querySelector('.toast').textContent = text;
    setTimeout(clearUi, 4000);
  }

  // The admin centre may page its policy list. Pages seen are merged, and the
  // import only replaces the stored set when no page says there is more.
  function takeListPage(data, url) {
    var value = data && Array.isArray(data.value) ? data.value : null;
    if (!value) {
      pending.policyList = data;
      pending.listIsPartial = false;
      return;
    }
    var continuation = /[?&]\$?skiptoken=/i.test(String(url || ''));
    var prior = continuation && pending.policyList && Array.isArray(pending.policyList.value)
      ? pending.policyList.value : null;
    pending.policyList = { value: prior ? prior.concat(value) : value };
    // Whole only once the last page has arrived and the first one was seen too.
    pending.listFromStart = continuation ? !!(prior && pending.listFromStart) : true;
    pending.listIsPartial = !!data.nextLink || !pending.listFromStart;
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;

    if (msg.type === 'tenant') {
      pending.tenantId = msg.tenantId;
      return;
    }
    if (msg.type !== 'captured') return;

    log.debug('received a', msg.kind, 'capture from page context');
    if (msg.kind === 'policyList') takeListPage(msg.data, msg.url);
    else if (msg.kind === 'policy') pending.policy = msg.data;
    else if (msg.kind === 'unblockable') pending.unblockable = msg.data;
    else if (msg.kind === 'virtual') pending.virtual = msg.data;
    else return;

    onCapture();
  });
})();
