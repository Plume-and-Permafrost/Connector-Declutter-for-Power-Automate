'use strict';

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
  var log = __cdpa.log.create('popup');
  __cdpa.log.watchStorage();

  var env = __cdpa.env;

  function send(type, extra) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(Object.assign({ type: 'cdpa:' + type }, extra || {}), function (reply) {
        if (chrome.runtime.lastError) {
          log.warn(type, 'got no reply:', chrome.runtime.lastError.message);
          return resolve(null);
        }
        if (reply && !reply.ok) log.warn(type, 'failed:', reply.error);
        resolve(reply && reply.ok ? reply.result : null);
      });
    });
  }

  function currentEnvironment() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var url = tabs && tabs[0] && tabs[0].url;
      if (!url) {
        log.debug('no URL for the active tab - cannot name an environment');
        return null;
      }
      try {
        var parsed = new URL(url);
        if (parsed.hostname !== 'make.powerautomate.com') {
          log.debug('active tab is', parsed.hostname, '- not the designer');
          return null;
        }
        var canonical = env.canonicalFromPath(parsed.pathname);
        log.debug('active tab path', parsed.pathname, '-> environment',
          canonical ? env.toDisplay(canonical) : 'none found in the path');
        return canonical;
      } catch (e) {
        log.warn('could not read the active tab URL:', e.message);
        return null;
      }
    });
  }

  // Status values can come from imported policy data, so they go in as text
  // rather than markup. Each row is [term, value, optional muted note].
  function renderFacts(box, rows) {
    var dl = document.createElement('dl');
    dl.className = 'facts';
    rows.forEach(function (row) {
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      if (row[2]) {
        var note = document.createElement('span');
        note.className = 'muted';
        note.textContent = ' (' + row[2] + ')';
        dd.appendChild(note);
      }
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    box.replaceChildren(dl);
  }

  function when(ms) {
    if (!ms) return 'never';
    var days = Math.floor((Date.now() - ms) / 86400000);
    if (days > 1) return days + ' days ago';
    if (days === 1) return 'yesterday';
    var hours = Math.floor((Date.now() - ms) / 3600000);
    if (hours >= 1) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    return 'just now';
  }

  function render(status, canonicalEnv) {
    var envEl = document.getElementById('env');
    var box = document.getElementById('summary');

    if (!canonicalEnv) {
      envEl.textContent = 'Open a flow in the Power Automate designer to see what is hidden here.';
    } else {
      envEl.textContent = 'Environment ' + env.toDisplay(canonicalEnv);
    }

    if (!status) {
      box.innerHTML = '<p class="small">The extension could not be reached. Try reloading it.</p>';
      return;
    }

    document.getElementById('showEverything').checked = !!(status.settings && status.settings.showEverything);

    if (!status.hasData) {
      box.className = 'card notice';
      box.innerHTML =
        '<p class="small"><b>No DLP policy imported yet.</b></p>' +
        '<p class="small">Desktop and MCP/agent connectors are already being hidden. To also hide the ' +
        'connectors your tenant blocks, open the Power Platform admin centre&rsquo;s Policies page and ' +
        'click Import when the extension offers it.</p>' +
        '<p class="small">No admin access? Ask an admin to export a configuration from Settings, ' +
        'or paste the policy in Settings yourself.</p>';
      return;
    }

    box.className = 'card';
    var covered = canonicalEnv && status.covered;
    var rows = [['Policies', status.policyCount + ' stored, updated ' + when(status.importedAt)]];
    if (canonicalEnv) {
      rows.push(['This environment', covered
        ? status.policyNames.join(', ')
        : 'not covered by any stored policy']);
      if (covered) rows.push(['Blocked here', status.blockedCount + ' connectors']);
    }
    renderFacts(box, rows);
  }

  document.getElementById('options').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('showEverything').addEventListener('change', function (e) {
    log.debug('show everything ->', e.target.checked);
    send('setSettings', { patch: { showEverything: e.target.checked } });
  });

  currentEnvironment().then(function (canonicalEnv) {
    return send('getStatus', { environment: canonicalEnv }).then(function (status) {
      if (status) {
        log.debug('status:', status.policyCount, 'policies,',
          status.hasData ? 'data present' : 'no data',
          canonicalEnv ? (status.covered
            ? ', covered by [' + status.policyNames.join(', ') + '] blocking ' + status.blockedCount
            : ', no policy covers this environment') : '');
      }
      render(status, canonicalEnv);
    });
  });
})();
