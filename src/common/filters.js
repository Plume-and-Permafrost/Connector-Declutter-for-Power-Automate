'use strict';
// Category filters: the rules that hide whole classes of connector regardless of
// DLP. Unlike the DLP filter these are explicit user choices, so they apply even
// when no policy data has been imported - the extension declutters usefully the
// moment it is installed.
//
// A rule matches an operation group if its name is listed in `ids`, or the group
// carries one of `tags`, or `pattern` matches the group's name or display name.
// Rules are plain JSON so they round-trip through storage and the config export,
// and can be edited in the options page without a new build.
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

__cdpa.filters = (function () {
  var log = __cdpa.log.create('filters');

  var DEFAULT_RULES = [
    {
      id: 'desktop',
      label: 'Desktop connectors',
      description: 'Desktop flows, plus any Power Automate Desktop action group.',
      enabled: true,
      ids: ['shared_uiflow'],
      tags: ['DesktopFlow'],
      pattern: ''
    },
    {
      id: 'agentic',
      label: 'MCP, agent and Copilot connectors',
      description: 'MCP servers, agent authoring connectors and Copilot extensions.',
      enabled: true,
      ids: [
        'shared_agentsdk',
        'shared_agentnode',
        'shared_copilotflow',
        'shared_microsoftcopilotstudio',
        'shared_powervirtualagents',
        'shared_azureagentservice',
        'VirtualAgent',
        'Skills',
        'aibuilder'
      ],
      tags: [],
      pattern: 'mcp|copilot'
    }
  ];

  function defaultRules() {
    return JSON.parse(JSON.stringify(DEFAULT_RULES));
  }

  function compile(rules) {
    var all = Array.isArray(rules) ? rules : [];
    log.debug('compiling', all.length, 'rules,',
      all.filter(function (r) { return r && r.enabled !== false; }).length, 'enabled');
    return all.filter(function (r) {
      return r && r.enabled !== false;
    }).map(function (r) {
      var re = null;
      if (r.pattern) {
        try {
          re = new RegExp(r.pattern, 'i');
        } catch (e) {
          // A rule the user has half-typed must not take the whole filter down.
          log.warn('rule', r.id, 'has an invalid pattern', JSON.stringify(r.pattern),
            '- ignoring the pattern,', e.message);
          re = null;
        }
      }
      return {
        id: r.id,
        label: r.label || r.id,
        ids: new Set(r.ids || []),
        // The designer's own names vary in case (Control, dateTime, VirtualAgent),
        // and the DOM only ever exposes them lowercased, so ids match either way.
        lowerIds: new Set((r.ids || []).map(function (i) { return String(i).toLowerCase(); })),
        tags: new Set((r.tags || []).map(function (t) { return String(t).toLowerCase(); })),
        re: re
      };
    });
  }

  // Accepts either an operationGroups item or a plain {name, displayName, tags}.
  function describe(group) {
    if (!group) return { name: '', displayName: '', tags: [] };
    var props = group.properties || group;
    return {
      name: String(group.name || props.name || ''),
      displayName: String(props.displayName || ''),
      tags: Array.isArray(props.tags) ? props.tags : []
    };
  }

  function ruleMatches(rule, info) {
    if (rule.ids.has(info.name)) return true;
    if (rule.lowerIds && rule.lowerIds.has(info.name.toLowerCase())) return true;
    for (var i = 0; i < info.tags.length; i++) {
      if (rule.tags.has(String(info.tags[i]).toLowerCase())) return true;
    }
    if (rule.re && (rule.re.test(info.name) || rule.re.test(info.displayName))) return true;
    return false;
  }

  // Returns the id of the first rule that hides this group, or null.
  function hiddenBy(group, compiledRules) {
    var info = describe(group);
    if (!info.name && !info.displayName) return null;
    for (var i = 0; i < compiledRules.length; i++) {
      if (ruleMatches(compiledRules[i], info)) return compiledRules[i].id;
    }
    return null;
  }

  // Rules arrive from config files that admins hand to makers, and a rule id
  // ends up in CSS the decorator writes into the designer. So an id is kept to
  // a plain token, every field is given the type the rest of the code expects,
  // and anything that is not a rule at all is dropped.
  var SAFE_ID_RE = /[^A-Za-z0-9_-]/g;

  function strings(list) {
    return (Array.isArray(list) ? list : []).filter(function (v) {
      return typeof v === 'string' && v.trim();
    }).map(function (v) { return v.trim(); });
  }

  function sanitiseRules(rules) {
    var seen = Object.create(null);
    var out = [];
    (Array.isArray(rules) ? rules : []).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var id = String(r.id == null ? '' : r.id).replace(SAFE_ID_RE, '_').slice(0, 100);
      if (!id || seen[id]) {
        log.warn('dropping a category rule with a missing or duplicate id', JSON.stringify(r.id));
        return;
      }
      seen[id] = true;
      out.push({
        id: id,
        label: typeof r.label === 'string' ? r.label : id,
        description: typeof r.description === 'string' ? r.description : '',
        enabled: r.enabled !== false,
        ids: strings(r.ids),
        tags: strings(r.tags),
        pattern: typeof r.pattern === 'string' ? r.pattern : ''
      });
    });
    return out;
  }

  return {
    DEFAULT_RULES: DEFAULT_RULES,
    defaultRules: defaultRules,
    sanitiseRules: sanitiseRules,
    compile: compile,
    describe: describe,
    hiddenBy: hiddenBy
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.filters;
