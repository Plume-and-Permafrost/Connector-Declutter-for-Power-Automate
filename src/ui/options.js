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
  var log = __cdpa.log.create('options');
  __cdpa.log.watchStorage();

  var filters = __cdpa.filters;
  var settings = null;

  function send(type, extra) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(Object.assign({ type: 'cdpa:' + type }, extra || {}), function (reply) {
        if (chrome.runtime.lastError) {
          log.warn(type, 'got no reply:', chrome.runtime.lastError.message);
          return resolve(null);
        }
        if (reply && !reply.ok) log.warn(type, 'failed:', reply.error);
        resolve(reply && reply.ok ? reply.result : { __error: reply && reply.error });
      });
    });
  }

  function $(id) { return document.getElementById(id); }

  function note(el, message, ok) {
    el.textContent = message;
    el.className = 'status ' + (ok ? 'ok' : 'err');
  }

  function save(patch) {
    log.debug('saving', JSON.stringify(patch));
    return send('setSettings', { patch: patch }).then(function (next) {
      if (next) settings = next;
      return next;
    });
  }

  // --- status ---------------------------------------------------------------

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

  function renderStatus() {
    return send('getStatus', {}).then(function (status) {
      var box = $('status');
      if (!status) {
        box.innerHTML = '<p class="small">The extension could not be reached.</p>';
        return;
      }
      if (!status.hasData) {
        box.className = 'card notice';
        box.innerHTML =
          '<p class="small"><b>No DLP policy data.</b> Category filters below still apply. ' +
          'Open the Power Platform admin centre&rsquo;s Policies page and click Import when prompted, ' +
          'or paste a policy below.</p>';
        return;
      }
      box.className = 'card';
      var refresh = status.refresh || {};
      renderFacts(box, [
        ['Policies stored', String(status.policyCount)],
        ['Last updated', status.importedAt ? new Date(status.importedAt).toLocaleString() : 'never',
          status.source],
        ['Next refresh', refresh.nextAttemptAfter && refresh.nextAttemptAfter > Date.now()
          ? 'not before ' + new Date(refresh.nextAttemptAfter).toLocaleString()
          : 'next time the data is available',
          refresh.failureCount ? refresh.failureCount + ' failed attempts' : '']
      ]);
    });
  }

  // --- category filters -----------------------------------------------------

  // Connector IDs are edited as a table of rows rather than one comma-separated
  // field: they are exact identifiers, often long, and a stray comma silently
  // produced a rule that matched nothing.
  function renderIdTable(host, rule, onChange) {
    var ids = rule.ids || [];
    var table = document.createElement('table');
    table.className = 'ids';
    var body = document.createElement('tbody');

    if (!ids.length) {
      var empty = document.createElement('tr');
      empty.innerHTML = '<td class="empty" colspan="2">No connector IDs &mdash; ' +
        'this filter matches on tags or the name pattern only.</td>';
      body.appendChild(empty);
    }

    ids.forEach(function (id, i) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><input type="text" spellcheck="false"></td>' +
        '<td class="actions"><button data-act="remove-id">Remove</button></td>';
      var input = tr.querySelector('input');
      input.value = id;
      input.setAttribute('aria-label', 'Connector ID ' + (i + 1));

      // Saved on blur, not per keystroke, so the row does not re-render underneath
      // the cursor. An emptied row is a removal.
      input.addEventListener('change', function () {
        var next = ids.slice();
        var value = input.value.trim();
        if (value) next[i] = value; else next.splice(i, 1);
        onChange(next, !value);
      });

      tr.querySelector('[data-act="remove-id"]').addEventListener('click', function () {
        var next = ids.slice();
        next.splice(i, 1);
        onChange(next, true);
      });

      body.appendChild(tr);
    });

    table.appendChild(body);
    host.appendChild(table);

    var adder = document.createElement('div');
    adder.className = 'row';
    adder.innerHTML = '<input type="text" spellcheck="false" placeholder="shared_dropbox" ' +
      'aria-label="New connector ID" style="flex:1 1 180px;width:auto">' +
      '<button data-act="add-id">Add ID</button>';
    var field = adder.querySelector('input');

    function add() {
      // One paste can carry a whole list; split it rather than making one bad row.
      var values = field.value.split(/[\s,;]+/).map(function (v) { return v.trim(); }).filter(Boolean);
      if (!values.length) return;
      var next = ids.slice();
      values.forEach(function (v) { if (next.indexOf(v) === -1) next.push(v); });
      field.value = '';
      onChange(next, true);
    }

    adder.querySelector('[data-act="add-id"]').addEventListener('click', add);
    field.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
    });
    host.appendChild(adder);
  }

  function renderRules() {
    var host = $('rules');
    host.innerHTML = '';
    (settings.categoryRules || []).forEach(function (rule, index) {
      var el = document.createElement('div');
      el.className = 'rule';
      el.innerHTML =
        '<label class="check" style="margin:0">' +
        '<input type="checkbox" data-field="enabled">' +
        '<span class="check-text"><b></b><span></span></span></label>' +
        '<div class="field" data-ids></div>' +
        '<div class="row">' +
        '<div class="field" style="flex:1 1 140px"><label>Tags</label><input type="text" data-field="tags"></div>' +
        '<div class="field" style="flex:1 1 140px"><label>Name matches</label>' +
        '<input type="text" data-field="pattern"></div>' +
        '</div><div class="row"><button data-act="remove">Remove filter</button></div>';

      el.querySelector('[data-field="enabled"]').checked = rule.enabled !== false;
      el.querySelector('.check-text b').textContent = rule.label || rule.id;
      el.querySelector('.check-text span').textContent = rule.description || '';
      el.querySelector('[data-field="tags"]').value = (rule.tags || []).join(', ');
      el.querySelector('[data-field="pattern"]').value = rule.pattern || '';

      var idsHost = el.querySelector('[data-ids]');
      var idsLabel = document.createElement('label');
      idsLabel.textContent = 'Connector IDs';
      idsHost.appendChild(idsLabel);
      renderIdTable(idsHost, rule, function (nextIds, rerender) {
        var rules = settings.categoryRules.slice();
        rules[index] = Object.assign({}, rules[index], { ids: nextIds });
        save({ categoryRules: rules }).then(function () { if (rerender) renderRulesAndColours(); });
      });

      el.addEventListener('change', function (e) {
        var field = e.target.getAttribute('data-field');
        if (!field) return;
        var rules = settings.categoryRules.slice();
        var updated = Object.assign({}, rules[index]);
        if (field === 'enabled') updated.enabled = e.target.checked;
        else if (field === 'pattern') updated.pattern = e.target.value.trim();
        else updated[field] = e.target.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        rules[index] = updated;
        // Not a full re-render: that would blow away the field being typed in.
        // The swatches do need refreshing - enabling a rule adds its colour, and
        // renaming one renames its swatch.
        save({ categoryRules: rules }).then(renderColours);
      });

      el.querySelector('[data-act="remove"]').addEventListener('click', function () {
        var rules = settings.categoryRules.slice();
        rules.splice(index, 1);
        save({ categoryRules: rules }).then(renderRulesAndColours);
      });

      host.appendChild(el);
    });
  }

  $('addRule').addEventListener('click', function () {
    var rules = (settings.categoryRules || []).concat([{
      id: 'custom-' + Date.now(),
      label: 'Custom filter',
      description: 'Hides connectors matching the rules below.',
      enabled: true,
      ids: [],
      tags: [],
      pattern: ''
    }]);
    save({ categoryRules: rules }).then(renderRulesAndColours);
  });

  $('resetRules').addEventListener('click', function () {
    save({ categoryRules: filters.defaultRules() }).then(renderRulesAndColours);
  });

  // --- classification colours -----------------------------------------------

  function currentColours() {
    return Object.assign({}, __cdpa.storage.defaultColours(), settings.colours || {});
  }

  // Editing the rules changes which swatches belong here, so the two render together.
  function renderRulesAndColours() {
    renderRules();
    renderColours();
  }

  // Mirrors what decorate.js does, so the swatches show the real thing rather
  // than an approximation of it.
  function parseHex(hex) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function tintFor(hex) {
    var rgb = parseHex(hex) || { r: 0, g: 0, b: 0 };
    var dark = matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) {
      rgb = { r: Math.round(rgb.r + (255 - rgb.r) * 0.35),
        g: Math.round(rgb.g + (255 - rgb.g) * 0.35),
        b: Math.round(rgb.b + (255 - rgb.b) * 0.35) };
    }
    return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (dark ? 0.2 : 0.13) + ')';
  }

  // The two DLP classifications, the DLP blocklist, then one per category rule -
  // whose colour key is the rule's own id, so a rule the user adds gets a swatch
  // without anything here knowing about it in advance.
  function colourEntries() {
    var entries = [
      { key: 'business', title: 'Business', sub: 'Confidential',
        example: 'e.g. SharePoint, Dataverse' },
      { key: 'nonBusiness', title: 'Non-business', sub: 'General',
        example: 'e.g. RSS, Bitly' },
      { key: 'blocked', title: 'Blocked', sub: 'Hidden by DLP',
        example: 'e.g. Dropbox, Salesforce' }
    ];
    // After Blocked, which outranks them: a connector DLP blocks shows as Blocked
    // even when one of these rules catches it too.
    (settings.categoryRules || []).forEach(function (rule) {
      if (rule.enabled === false) return; // a rule that hides nothing colours nothing
      entries.push({
        key: rule.id,
        title: rule.label || rule.id,
        sub: 'Hidden by a rule',
        example: rule.description || ''
      });
    });
    return entries;
  }

  function renderColours() {
    var colours = currentColours();
    var swatches = $('colourSwatches');
    var preview = $('colourPreview');
    swatches.textContent = '';
    preview.textContent = '';

    colourEntries().forEach(function (entry) {
      var value = colours[entry.key] || __cdpa.storage.UNNAMED_RULE_COLOUR;

      var label = document.createElement('label');
      label.className = 'swatch';
      var input = document.createElement('input');
      input.type = 'color';
      input.value = value;
      var text = document.createElement('span');
      var strong = document.createElement('b');
      strong.textContent = entry.title;
      var sub = document.createElement('span');
      sub.className = 'muted';
      sub.textContent = entry.sub;
      text.appendChild(strong);
      text.appendChild(sub);
      label.appendChild(input);
      label.appendChild(text);
      swatches.appendChild(label);

      var row = document.createElement('div');
      row.style.backgroundColor = tintFor(value);
      var rowName = document.createElement('b');
      rowName.textContent = entry.title;
      row.appendChild(rowName);
      if (entry.example) row.appendChild(document.createTextNode(' \u2014 ' + entry.example));
      preview.appendChild(row);

      // Live feedback while dragging in the picker; the change event does the saving.
      input.addEventListener('input', function (e) {
        row.style.backgroundColor = tintFor(e.target.value);
      });
      input.addEventListener('change', function (e) {
        setColour(entry.key, e.target.value);
      });
    });
  }

  function setColour(which, value) {
    var colours = Object.assign(currentColours(), {});
    colours[which] = value;
    save({ colours: colours }).then(renderColours);
  }

  $('resetColours').addEventListener('click', function () {
    save({ colours: __cdpa.storage.defaultColours() }).then(renderColours);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderColours);

  // --- manual import --------------------------------------------------------

  // Accepts the raw governance payload, a single policy, or a bare list of
  // connector IDs - whichever the user happens to have to hand.
  function parseImport(text) {
    var trimmed = text.trim();
    if (!trimmed) throw new Error('Nothing to import.');
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      var data = JSON.parse(trimmed);
      if (data && data.format) return { config: data };
      if (Array.isArray(data) && data.length && data[0] && data[0].metadata) {
        return { payload: { unblockable: data } };
      }
      return { payload: { policies: data, replaceAll: !(data && data.name && !data.value) } };
    }
    // A plain list of connector ids becomes a policy that blocks exactly those.
    var ids = trimmed.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!ids.length) throw new Error('No connector IDs found.');
    return {
      payload: {
        replaceAll: false,
        policies: {
          value: [{
            name: 'manual-blocklist',
            displayName: 'Manual blocklist',
            environmentType: 'AllEnvironments',
            environments: [],
            defaultConnectorsClassification: 'General',
            connectorGroups: [{
              classification: 'Blocked',
              connectors: ids.map(function (id) { return { id: id }; })
            }]
          }]
        }
      }
    };
  }

  function runImport(text) {
    var status = $('importStatus');
    var parsed;
    try {
      parsed = parseImport(text);
    } catch (e) {
      log.warn('could not parse a manual import of', text.length, 'characters:', e.message);
      return note(status, 'Could not read that: ' + e.message, false);
    }
    log.debug('manual import parsed as', parsed.config ? 'a configuration file'
      : parsed.payload.unblockable ? 'unblockable metadata'
        : parsed.payload.replaceAll === false ? 'a partial policy set' : 'a full policy set');
    if (parsed.config) {
      return send('importConfig', { data: parsed.config }).then(function (result) {
        if (result && result.ok) {
          note(status, 'Configuration imported.', true);
          load();
        } else {
          note(status, (result && result.error) || 'Import failed.', false);
        }
      });
    }
    send('importPolicies', { payload: parsed.payload, source: 'manual' }).then(function (result) {
      if (result && result.ok) {
        note(status, 'Imported ' + result.policyCount + ' ' + (result.policyCount === 1 ? 'policy' : 'policies') + '.', true);
        $('importText').value = '';
        renderStatus();
      } else {
        note(status, (result && result.__error) || 'Import failed.', false);
      }
    });
  }

  $('importPaste').addEventListener('click', function () { runImport($('importText').value); });
  $('importFileBtn').addEventListener('click', function () { $('importFile').click(); });
  $('importFile').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then(runImport);
    e.target.value = '';
  });

  // --- configuration export / import ---------------------------------------

  $('exportConfig').addEventListener('click', function () {
    send('exportConfig').then(function (data) {
      if (!data) return note($('configStatus'), 'Export failed.', false);
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'connector-declutter-for-power-automate-config.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      note($('configStatus'), 'Exported.', true);
    });
  });

  $('importConfigBtn').addEventListener('click', function () { $('configFile').click(); });
  $('configFile').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    file.text().then(function (text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        return note($('configStatus'), 'That file is not valid JSON.', false);
      }
      send('importConfig', { data: data }).then(function (result) {
        if (result && result.ok) {
          note($('configStatus'), 'Configuration imported.', true);
          load();
        } else {
          note($('configStatus'), (result && result.error) || 'Import failed.', false);
        }
      });
    });
  });

  // --- my connectors --------------------------------------------------------

  // The catalogue is learned, not fetched: there is no endpoint this page could
  // call for the list, so the interceptor reports every operation group the
  // designer hands it and the service worker keeps the union. It is therefore
  // empty until the user has opened a connector panel at least once.
  var catalogue = {};

  function pickedNames() {
    return Array.isArray(settings.pickedConnectors) ? settings.pickedConnectors : [];
  }

  // Everything known, plus anything already ticked that the catalogue has since
  // lost - a connector that cannot be listed could not be unticked either.
  function connectorRows() {
    var picked = Object.create(null);
    pickedNames().forEach(function (n) { picked[n] = true; });

    var names = Object.keys(catalogue);
    Object.keys(picked).forEach(function (n) {
      if (!Object.prototype.hasOwnProperty.call(catalogue, n)) names.push(n);
    });

    return names.map(function (name) {
      return { name: name, label: catalogue[name] || name, picked: !!picked[name] };
    }).sort(function (a, b) {
      return a.label.localeCompare(b.label) || a.name.localeCompare(b.name);
    });
  }

  function renderCount(total) {
    var n = pickedNames().length;
    $('pickedCount').textContent = total
      ? n + ' of ' + total + ' ticked'
      : 'No connectors seen yet.';
    $('clearPicked').disabled = !n;
  }

  function renderConnectors() {
    var host = $('connectorPicker');
    var rows = connectorRows();
    host.textContent = '';

    if (!rows.length) {
      var empty = document.createElement('p');
      empty.className = 'none';
      empty.textContent = 'Nothing here yet. Open a connector panel in the designer ' +
        'and this list fills itself in.';
      host.appendChild(empty);
      renderCount(0);
      return;
    }

    rows.forEach(function (row) {
      var label = document.createElement('label');
      // Lower-cased once here rather than on every keystroke of the search box.
      label.setAttribute('data-search', (row.label + ' ' + row.name).toLowerCase());

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = row.picked;
      box.setAttribute('data-name', row.name);

      var text = document.createElement('span');
      text.textContent = row.label;

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.name;

      label.appendChild(box);
      label.appendChild(text);
      label.appendChild(name);
      host.appendChild(label);
    });

    renderCount(rows.length);
    applySearch();
  }

  function applySearch() {
    var term = $('connectorSearch').value.trim().toLowerCase();
    var labels = $('connectorPicker').querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      var hay = labels[i].getAttribute('data-search') || '';
      labels[i].hidden = !!term && hay.indexOf(term) === -1;
    }
  }

  // One listener for the whole list rather than one per row: there can be well
  // over a thousand of these, and only the count needs redrawing after a tick.
  $('connectorPicker').addEventListener('change', function (e) {
    var name = e.target && e.target.getAttribute && e.target.getAttribute('data-name');
    if (!name) return;
    var next = pickedNames().filter(function (n) { return n !== name; });
    if (e.target.checked) next.push(name);
    // Saved without re-rendering: rebuilding the list would scroll the row the
    // user just ticked out from under them.
    save({ pickedConnectors: next }).then(function () {
      renderCount($('connectorPicker').querySelectorAll('label').length);
    });
  });

  $('connectorSearch').addEventListener('input', applySearch);

  $('clearPicked').addEventListener('click', function () {
    var n = pickedNames().length;
    if (!n) return;
    var detail = 'Unticking ' + n + ' connector' + (n === 1 ? '' : 's') + '.';
    var dialog = $('clearDialog');
    $('clearDialogDetail').textContent = detail;
    // A modal, not confirm(): this page is opened as a tab, so both would work,
    // but the dialog can say how many are about to go.
    if (dialog.showModal) dialog.showModal();
    else if (confirm(detail + ' This cannot be undone.')) clearPicked();
  });

  $('clearCancel').addEventListener('click', function () { $('clearDialog').close(); });
  $('clearConfirm').addEventListener('click', function () {
    $('clearDialog').close();
    clearPicked();
  });

  function clearPicked() {
    log.debug('clearing', pickedNames().length, 'picked connectors');
    save({ pickedConnectors: [] }).then(renderConnectors);
  }

  function loadConnectors() {
    return send('getConnectors').then(function (known) {
      catalogue = (known && !known.__error) ? known : {};
      log.debug('connector catalogue:', Object.keys(catalogue).length, 'known');
      renderConnectors();
    });
  }

  // --- wiring ---------------------------------------------------------------

  var SECTION_KEYS = ['hideFavourites', 'hideAiCapabilities', 'hideBuiltInTools',
    'expandFavourites'];
  var CHECKBOXES = ['hideBlocked', 'autoFetch', 'colourCode', 'steadyRows', 'debug']
    .concat(SECTION_KEYS);

  CHECKBOXES.forEach(function (key) {
    $(key).addEventListener('change', function (e) {
      var patch = {};
      patch[key] = e.target.checked;
      save(patch).then(syncSections);
    });
  });

  // Auto-expanding a section that is not there means nothing, so the two settings
  // are shown as what they are: one depends on the other.
  function syncSections() {
    $('expandFavourites').disabled = !!settings.hideFavourites;
  }

  function load() {
    return send('getSettings').then(function (current) {
      settings = current || {};
      $('hideBlocked').checked = settings.hideBlocked !== false;
      CHECKBOXES.forEach(function (key) {
        if (key !== 'hideBlocked') $(key).checked = !!settings[key];
      });
      syncSections();
      renderColours();
      log.debug('settings loaded:', JSON.stringify({
        hideBlocked: settings.hideBlocked !== false,
        autoFetch: !!settings.autoFetch,
        colourCode: !!settings.colourCode,
        steadyRows: !!settings.steadyRows,
        showEverything: !!settings.showEverything,
        sections: SECTION_KEYS.filter(function (k) { return !!settings[k]; }),
        rules: (settings.categoryRules || []).length,
        picked: pickedNames().length
      }));
      renderRules();
      return Promise.all([renderStatus(), loadConnectors()]);
    });
  }

  load();
})();
