'use strict';
// Which operation groups the open flow already uses (page context).
//
// This is the third of the extension's filters, and the only one whose contents
// are not a setting: it is a property of the flow on screen, so it is discovered
// the same way everything else here is discovered - by reading what the designer
// is already asking for.
//
// One of its requests carries the answer. Opening a flow GETs it, expanded:
//
//   GET …/powerautomate/flows/{id}?api-version=1
//         &$expand=properties.connectionreferences.apidefinition,
//                  properties.definitionsummary.operations.apioperation,…
//
//   { properties: {
//       connectionReferences: { shared_sharepointonline: { apiDefinition: {…} } },
//       definitionSummary: {
//         triggers: [ { type: 'Recurrence' } ],
//         actions:  [ { type: 'OpenApiConnection', swaggerOperationId: 'ListFolder',
//                       api: { name: 'shared_sharepointonline', … } },
//                     { type: 'Select' } ] } } }
//
// Rather than reaching into that shape by path, the body is walked and every
// connector name in it collected, from connectionReferences' keys and from any
// string that names one. A saved flow's request body then works as well as a
// response, and a shape that shifts in a later release is still likely to be read
// correctly.
//
// There is an obvious-looking second endpoint, and it is a trap:
//
//   GET …/powerautomate/flows/{id}/connections?api-version=1
//
// Despite sitting under the flow's own path, that does not describe the flow. It
// answers with every connection the signed-in user holds in the environment -
// measured against a captured session, eight accounts across eight connectors for
// a flow that uses exactly one - so reading it would turn this filter into
// "connectors I have ever signed in to". It is deliberately not read.
//
// Built-in steps come along too, and they take a second step to read. A connector
// step names its connector; a built-in one names nothing, being a bare type and
// sometimes a kind:
//
//   { type: 'Scope' }        { type: 'Request', kind: 'Button' }
//
// with no group attached even in a response expanded to include each operation's
// definition. So the pair is looked up in a table taken from the operation
// catalogue. The pair, and not the type alone: `Request` is a step in eighteen
// different groups depending on its kind - Button is Flow, Http is Request,
// TeamsWebhook is Teams - while (type, kind) picks exactly one group for every
// built-in operation in the catalogue, with no collisions. A pair the table does
// not have is skipped, so a built-in released after it was taken costs its group
// in this filter and nothing else.
//
// The set is keyed on the flow id, so moving between flows without a reload does
// not leave the last one's connectors behind.

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

__cdpa.inFlow = (function () {
  var log = __cdpa.log.create('in-flow');

  // The flow itself, and nothing else hanging off it - not runs, histories,
  // diagnostics or triggers, and in particular NOT …/flows/{id}/connections.
  // See the note at the top for why that one is a trap.
  var FLOW_RE = /\/powerautomate\/flows\/([^/?#]+)(?:[?#]|$)/i;
  // A connector id, wherever it turns up: /providers/…/apis/shared_sharepointonline,
  // with or without something after it (…/apiOperations/ListFolder). The provider
  // segment is part of the pattern rather than decoration: without it this also
  // matches type strings like "Microsoft.PowerApps/apis/connections", and starts
  // reporting a connector called "connections".
  var API_ID_RE = /\/providers\/[A-Za-z0-9._-]+\/apis\/([A-Za-z0-9._-]+)/g;
  // Names are lowercased everywhere else in the extension, so a name is only
  // believed if it looks like one rather than like a path fragment.
  var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  // A flow is itself a resource of an api, and says so: properties.apiId on the
  // response is /providers/Microsoft.PowerApps/apis/shared_logicflows, which is
  // the flow, not something in it. These three are the plumbing Power Automate is
  // built out of rather than connectors anyone adds, which is why the designer
  // excludes exactly this set from its own connection queries:
  //
  //   ?$filter=ApiId not in ('shared_logicflows','shared_powerflows',
  //                          'shared_pqogenericconnector')
  var INFRASTRUCTURE = {
    shared_logicflows: true,
    shared_powerflows: true,
    shared_pqogenericconnector: true
  };

  // (operationType, operationKind) -> the group the panel files that step under,
  // for every built-in operation in the catalogue this was built against. See the
  // note at the top for why the kind is part of the key. `NotSpecified` is what
  // the catalogue calls "no kind", and is what a step with no kind of its own is
  // read as.
  var NO_KIND = 'NotSpecified';
  var BUILT_IN_OPS = {
    // Control
    'Condition|NotSpecified': 'Control',
    'Foreach|NotSpecified': 'Control',
    'Scope|NotSpecified': 'Control',
    'Switch|NotSpecified': 'Control',
    'Terminate|NotSpecified': 'Control',
    'Until|NotSpecified': 'Control',
    // DataOperation
    'Compose|NotSpecified': 'DataOperation',
    'Join|NotSpecified': 'DataOperation',
    'ParseJson|NotSpecified': 'DataOperation',
    'Query|NotSpecified': 'DataOperation',
    'Select|NotSpecified': 'DataOperation',
    'Table|NotSpecified': 'DataOperation',
    // Datetime
    'Expression|AddToTime': 'Datetime',
    'Expression|ConvertTimeZone': 'Datetime',
    'Expression|CurrentTime': 'Datetime',
    'Expression|GetFutureTime': 'Datetime',
    'Expression|GetPastTime': 'Datetime',
    'Expression|SubtractFromTime': 'Datetime',
    // Flow
    'Request|Button': 'Flow',
    // FlowsBuiltIn
    'Workflow|NotSpecified': 'FlowsBuiltIn',
    // Http
    'HttpSwagger|NotSpecified': 'Http',
    'HttpWebhook|NotSpecified': 'Http',
    'Http|NotSpecified': 'Http',
    // NumberFunctions
    'Expression|FormatNumber': 'NumberFunctions',
    // PowerApps
    'Request|PowerApp': 'PowerApps',
    'Request|PowerAppV2': 'PowerApps',
    'Response|PowerApp': 'PowerApps',
    // PowerPages
    'Request|PowerPages': 'PowerPages',
    'Response|PowerPages': 'PowerPages',
    // Request
    'Request|Http': 'Request',
    'Response|Http': 'Request',
    // Schedule
    'Recurrence|NotSpecified': 'Schedule',
    'Wait|NotSpecified': 'Schedule',
    // Skills
    'Request|Skills': 'Skills',
    'Response|Skills': 'Skills',
    // Teams
    'Request|TeamsWebhook': 'Teams',
    // TextFunctions
    'Expression|IndexOf': 'TextFunctions',
    'Expression|Substring': 'TextFunctions',
    // Variable
    'AppendToArrayVariable|NotSpecified': 'Variable',
    'AppendToStringVariable|NotSpecified': 'Variable',
    'DecrementVariable|NotSpecified': 'Variable',
    'IncrementVariable|NotSpecified': 'Variable',
    'InitializeVariable|NotSpecified': 'Variable',
    'SetVariable|NotSpecified': 'Variable',
    // VirtualAgent
    'Request|VirtualAgent': 'VirtualAgent',
    'Response|VirtualAgent': 'VirtualAgent'
  };

  // A step out of a definition or a definitionSummary, or something that merely
  // sits under the same key. Returns the group it belongs to, or null for
  // anything that is not a built-in step.
  function groupForStep(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
    if (typeof step.type !== 'string') return null;
    // A connector step - OpenApiConnection and friends - names its connector, and
    // that is read from the id instead. None of their types are in the table
    // either, so this is belt and braces.
    if (step.api || step.apiOperation) return null;
    var kind = (typeof step.kind === 'string' && step.kind) ? step.kind : NO_KIND;
    var group = BUILT_IN_OPS[step.type + '|' + kind];
    // A known type with a kind the table has not got. Where the type has one
    // group regardless of kind, that group is still the right answer; where it
    // does not - Request, Response, Expression - there is no kindless entry to
    // find, and the step is skipped rather than guessed at.
    if (!group && kind !== NO_KIND) group = BUILT_IN_OPS[step.type + '|' + NO_KIND];
    return group || null;
  }

  // The walk is bounded, but not tightly: a flow is arbitrary user data, and the
  // caps are there to stop a pathological one costing anything, not to sample it.
  // Measured against a captured three-action flow - which expands to 12,867 nodes
  // and 15 levels, most of it the swagger for each connector - so a cap anywhere
  // near those numbers would quietly drop connectors from a real flow, which is
  // the one failure this must not have.
  var MAX_DEPTH = 64;
  var MAX_NODES = 1000000;

  var flowId = null;
  var names = Object.create(null);
  var listeners = [];

  function current() {
    return Object.keys(names).sort();
  }

  function announce() {
    var list = current();
    listeners.forEach(function (fn) {
      try {
        fn(list);
      } catch (e) {
        log.warn('a listener threw:', e.message);
      }
    });
  }

  function add(name, into) {
    var value = String(name == null ? '' : name);
    if (!NAME_RE.test(value)) return;
    var key = value.toLowerCase();
    if (INFRASTRUCTURE[key]) return;
    into[key] = true;
  }

  // Reset when the tab moves to a different flow. The designer is a single page,
  // so nothing else would clear it.
  function switchTo(id) {
    if (id === flowId) return false;
    log.debug(flowId ? 'moved to flow ' + id : 'watching flow ' + id);
    flowId = id;
    names = Object.create(null);
    return true;
  }

  // Every group named anywhere in the body, as a set.
  function harvest(value) {
    var found = Object.create(null);
    var nodes = 0;

    (function walk(node, depth) {
      if (node == null || depth > MAX_DEPTH || ++nodes > MAX_NODES) return;

      if (typeof node === 'string') {
        // A connector id can appear anywhere: apiId, api.id, the connection's own
        // id, an apiOperation's id.
        API_ID_RE.lastIndex = 0;
        var m;
        while ((m = API_ID_RE.exec(node)) !== null) add(m[1], found);
        return;
      }
      if (typeof node !== 'object') return;

      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }

      var keys = Object.keys(node);
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        // connectionReferences is keyed by connector name, so the keys are the
        // answer and the values only repeat it.
        if (k === 'connectionReferences' && node[k] && typeof node[k] === 'object'
            && !Array.isArray(node[k])) {
          Object.keys(node[k]).forEach(function (name) { add(name, found); });
        }
        // `api: { name: 'shared_…' }` on a definitionSummary entry.
        if (k === 'api' && node[k] && typeof node[k] === 'object') add(node[k].name, found);
        // The flow's steps live under `actions` and `triggers` - listed in a
        // definitionSummary, keyed by step name in a definition - and so do the
        // steps inside a Scope, a Foreach and each case of a Switch, at any
        // depth. Whatever is one level under either key is a step, which is why
        // this reads the container rather than the path to it.
        if ((k === 'actions' || k === 'triggers') && node[k] && typeof node[k] === 'object') {
          var steps = node[k];
          Object.keys(steps).forEach(function (name) {
            var group = groupForStep(steps[name]);
            if (group) add(group, found);
          });
        }
        walk(node[k], depth + 1);
      }
    })(value, 0);

    if (nodes > MAX_NODES) log.warn('stopped reading a flow after', MAX_NODES, 'nodes');
    return found;
  }

  // A body carrying the flow's definition describes the whole flow, so it
  // replaces what was known - that is how a step deleted and saved leaves the
  // filter. Anything less (a state change, a rename, connectionReferences on
  // their own) can only add.
  function isWholeFlow(parsed) {
    var props = parsed && parsed.properties;
    return !!(props && typeof props === 'object' &&
      (props.definition || props.definitionSummary));
  }

  function sameSet(a, b) {
    var ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    return ak.every(function (k) { return b[k]; });
  }

  // Reads one body. Called for the request and the response of anything matching
  // a flow, so a save updates the filter without waiting for the flow to be
  // fetched again.
  function read(id, body, what) {
    var changed = switchTo(id);
    var parsed = null;
    try {
      parsed = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (e) { /* not JSON: nothing to read, but the flow may still have changed */ }

    if (!parsed || typeof parsed !== 'object') {
      if (changed) announce();
      return;
    }

    var found = harvest(parsed);
    var next;
    if (isWholeFlow(parsed)) {
      next = found;
    } else {
      next = Object.assign(Object.create(null), names, found);
    }
    if (!sameSet(names, next)) {
      names = next;
      changed = true;
      log.debug('flow', id, what + ':', current().length, 'group(s) -', current().join(', '));
    }
    if (changed) announce();
  }

  function flowIdIn(url) {
    var m = FLOW_RE.exec(String(url || ''));
    return m ? m[1] : null;
  }

  // The flow the tab is showing, when its route names one. The designer also
  // fetches other flows - a child flow picked in a step, for one - and those
  // must not replace the open flow's set. A route without a GUID ("new", or no
  // flow at all) says nothing, and then any flow request is believed.
  var GUID_RE = /\/flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

  function pageFlowId() {
    try {
      var m = GUID_RE.exec(String(location.pathname || ''));
      return m ? m[1].toLowerCase() : null;
    } catch (e) {
      return null;
    }
  }

  if (__cdpa.httpHook) {
    __cdpa.httpHook.register({
      match: function (url) { return !!flowIdIn(url); },
      // Nothing is rewritten here. Returning undefined hands the designer its own
      // body back untouched; this only wants a look at it.
      //
      // And the look is deferred, because the hook holds the load event until the
      // transform settles: opening a flow is the slowest thing the designer does
      // and a reader with no opinion on the body has no business adding to it.
      // Reading a moment later is indistinguishable, since nothing downstream of
      // here is waiting on the answer.
      transform: function (ctx) {
        var id = flowIdIn(ctx.url);
        if (!id) return undefined;
        var onScreen = pageFlowId();
        if (onScreen && onScreen !== String(id).toLowerCase()) return undefined;
        var body = ctx.requestBody;
        var text = ctx.status === 200 ? ctx.text : null;
        setTimeout(function () {
          if (body) read(id, body, 'saved');
          if (text) read(id, text, 'fetched');
        }, 0);
        return undefined;
      }
    });
  }

  return {
    // The operation groups the open flow uses - connectors and built-ins alike,
    // lowercased and sorted.
    list: current,
    // Called with that list whenever it changes.
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    // For tests and for the debug log: pretend a body arrived.
    read: read,
    flowIdIn: flowIdIn,
    // For the test that keeps this table and the Microsoft view's list of
    // built-in groups from drifting apart.
    builtInOps: BUILT_IN_OPS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.inFlow;
