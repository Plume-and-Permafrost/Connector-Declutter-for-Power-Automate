'use strict';
// in-flow.js reads the designer's own flow traffic, so the fixtures below are cut
// down from real captured responses rather than invented. What is pinned is which
// URLs it takes an interest in, that both response shapes yield the same answer,
// and that it never rewrites anything on the way past.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPTS = ['src/common/log.js', 'src/common/http-hook.js', 'src/maker/in-flow.js'];
const views = require('../src/common/views.js');

const FLOW = '11111111-2222-4333-8444-555555555555';
const BASE = 'https://0a1b2c3d4e5f60718293a4b5c6d7e8.f9.environment.api.powerplatform.com';
const FLOW_URL = BASE + '/powerautomate/flows/' + FLOW +
  '?api-version=1&$expand=properties.connectionreferences.apidefinition,' +
  'properties.definitionsummary.operations.apioperation,operationDefinition';
const CONNECTIONS_URL = BASE + '/powerautomate/flows/' + FLOW + '/connections?api-version=1';

// The expanded flow: connectionReferences keyed by connector name, and a
// definitionSummary whose built-in steps are a bare type and sometimes a kind,
// with no connector and no group on them. The shape and the step types are taken
// from a captured flow: a Button trigger, then InitializeVariable, Scope and
// Switch around the connector calls.
const FLOW_BODY = {
  name: FLOW,
  properties: {
    // Every flow carries this, and it is the flow's own api rather than anything
    // in it.
    apiId: '/providers/Microsoft.PowerApps/apis/shared_logicflows',
    installedConnectionReferences: { shared_sharepointonline: {} },
    connectionReferences: {
      shared_sharepointonline: {
        connectionReferenceLogicalName: 'cr000_Something.cr.abcdEFGH',
        apiDefinition: {
          name: 'shared_sharepointonline',
          id: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
          properties: { displayName: 'SharePoint' }
        }
      }
    },
    definitionSummary: {
      triggers: [{ type: 'Request', kind: 'Button' }],
      actions: [
        { type: 'InitializeVariable' },
        { type: 'Scope' },
        {
          type: 'OpenApiConnection',
          swaggerOperationId: 'ListFolder',
          apiOperation: {
            name: 'ListFolder',
            id: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline/apiOperations/ListFolder',
            properties: { api: { id: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' } }
          },
          api: { name: 'shared_sharepointonline', id: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' }
        },
        { type: 'Switch' },
        {
          type: 'OpenApiConnection',
          swaggerOperationId: 'SendEmailV2',
          api: { name: 'shared_office365', id: '/providers/Microsoft.PowerApps/apis/shared_office365' }
        }
      ]
    }
  }
};

// What …/flows/{id}/connections answers with: every connection the signed-in
// user holds, not the flow's - so a flow using one connector can get back
// connections for several others.
function connection(api, account) {
  return {
    name: api.replace('shared_', 'shared-') + '-0a1b2c3d',
    id: '/providers/Microsoft.PowerApps/apis/' + api + '/connections/' + api + '-0a1b2c3d',
    type: 'Microsoft.PowerApps/apis/connections',
    properties: { apiId: '/providers/Microsoft.PowerApps/apis/' + api, displayName: account }
  };
}

// What FLOW_BODY comes to: its two connectors, plus the groups its four built-in
// steps belong to. Request+Button is the "manually trigger a flow" trigger, which
// the panel files under Flow rather than under Request.
const FLOW_GROUPS = ['control', 'flow', 'shared_office365', 'shared_sharepointonline', 'variable'];

const NOT_THE_FLOWS_CONNECTIONS = [
  connection('shared_teams', 'someone@example.com'),
  connection('shared_office365', 'someone@example.com'),
  connection('shared_sharepointonline', 'someone@example.com'),
  connection('shared_excelonlinebusiness', 'someone@example.com'),
  connection('shared_commondataserviceforapps', 'MSFT Dynamics'),
  connection('shared_flowmanagement', 'Flow admin'),
  connection('shared_webcontents', 'Graph'),
  connection('shared_webcontents', 'Graph (admin)')
];

function load(pathname) {
  const registered = [];
  const page = pathname || '/environments/x/flows/' + FLOW;
  const sandbox = {
    console, Promise, Object, Array, String, JSON, Math, Date, RegExp, Error,
    setTimeout, clearTimeout,
    location: { href: 'https://make.powerautomate.com' + page, pathname: page },
    window: { addEventListener: () => {} },
    XMLHttpRequest: function () {},
    __registered: registered
  };
  sandbox.globalThis = sandbox;
  sandbox.window.fetch = null;
  sandbox.XMLHttpRequest.prototype = { open: function () {}, send: function () {} };
  vm.createContext(sandbox);
  for (const f of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
    if (f === 'src/common/http-hook.js') {
      // Keep hold of what in-flow.js registers, so a test can play a response.
      const register = sandbox.__cdpa.httpHook.register;
      sandbox.__cdpa.httpHook.register = (h) => { registered.push(h); return register(h); };
    }
  }
  // The handler in-flow.js registered with the hook, so the tests drive it the
  // way a response would.
  const hook = sandbox.__cdpa.httpHook;
  const inFlow = sandbox.__cdpa.inFlow;
  return { inFlow, hook, sandbox, handler: registered[0] };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('the flow itself is the request it wants', () => {
  const { inFlow } = load();
  assert.strictEqual(inFlow.flowIdIn(FLOW_URL), FLOW);
});

test('the flow\'s "connections" is not the flow\'s connections', () => {
  // It sits under the flow's own path and answers with every connection the
  // signed-in user holds. Reading it would make this filter mean "connectors I
  // have ever signed in to" - which is why the URL is not matched at all, and why
  // the body below is here to prove what it would have cost.
  const { inFlow } = load();
  assert.strictEqual(inFlow.flowIdIn(CONNECTIONS_URL), null);

  inFlow.read(FLOW, JSON.stringify(NOT_THE_FLOWS_CONNECTIONS), 'fetched');
  assert.strictEqual(inFlow.list().length, 7,
    'the eight-account list collapses to seven connectors - none of them the flow\'s doing');
});

test('everything else hanging off a flow is left alone', () => {
  const { inFlow } = load();
  for (const tail of ['/runs?api-version=1', '/diagnostics?api-version=1',
    '/triggers/manual?api-version=1', '/triggers/manual/histories?api-version=1']) {
    assert.strictEqual(inFlow.flowIdIn(BASE + '/powerautomate/flows/' + FLOW + tail), null,
      tail + ' should not be read');
  }
  // The list of flows is not a flow.
  assert.strictEqual(inFlow.flowIdIn(BASE + '/powerautomate/flows?api-version=1&$top=50'), null);
  // Nor is anything else on the host.
  assert.strictEqual(inFlow.flowIdIn(BASE + '/powerautomate/operationGroups?api-version=1'), null);
});

test('the expanded flow yields its connectors and its built-ins', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify(FLOW_BODY), 'fetched');
  // The connectors come off the ids; Scope and Switch resolve to Control,
  // InitializeVariable to Variable and the Button trigger to Flow.
  // shared_logicflows is the flow itself and is left out.
  assert.deepStrictEqual(inFlow.list(), FLOW_GROUPS);
});

test('a body it cannot read leaves the list as it was', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify(FLOW_BODY), 'fetched');
  inFlow.read(FLOW, '<html>not json</html>', 'fetched');
  inFlow.read(FLOW, '', 'fetched');
  inFlow.read(FLOW, 'null', 'fetched');
  assert.deepStrictEqual(inFlow.list(), FLOW_GROUPS);
});

test('what a save adds shows up without waiting for a refetch', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify({
    properties: { connectionReferences: { shared_sharepointonline: {} } }
  }), 'fetched');
  assert.deepStrictEqual(inFlow.list(), ['shared_sharepointonline']);

  // A saved definition names its connectors on each action's host, and a save
  // carries the connection references alongside it.
  inFlow.read(FLOW, JSON.stringify({
    properties: {
      connectionReferences: { shared_sharepointonline: {}, shared_office365: {} },
      definition: {
        actions: {
          Send_an_email: {
            type: 'OpenApiConnection',
            inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_office365' } }
          }
        }
      }
    }
  }), 'saved');
  assert.deepStrictEqual(inFlow.list(), ['shared_office365', 'shared_sharepointonline']);
});

test('moving to another flow does not keep the last one\'s connectors', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify(FLOW_BODY), 'fetched');
  assert.strictEqual(inFlow.list().length, FLOW_GROUPS.length);

  inFlow.read('66666666-7777-4888-9999-000000000000', JSON.stringify([]), 'fetched');
  assert.deepStrictEqual(inFlow.list(), [], 'the previous flow\'s connectors came along');
});

test('a change is announced once, with the list', () => {
  const { inFlow } = load();
  const seen = [];
  inFlow.onChange((list) => seen.push(list));

  const one = JSON.stringify({ properties: { connectionReferences: { shared_sharepointonline: {} } } });
  inFlow.read(FLOW, one, 'fetched');
  assert.deepStrictEqual(seen, [['shared_sharepointonline']]);

  // The same body again is not news.
  inFlow.read(FLOW, one, 'fetched');
  assert.strictEqual(seen.length, 1, 'an unchanged flow was announced anyway');

  inFlow.read(FLOW, JSON.stringify(FLOW_BODY), 'fetched');
  assert.deepStrictEqual(seen[1], FLOW_GROUPS);
});

test('a listener that throws does not stop the others', () => {
  const { inFlow } = load();
  const seen = [];
  inFlow.onChange(() => { throw new Error('bad listener'); });
  inFlow.onChange((list) => seen.push(list));
  inFlow.read(FLOW, JSON.stringify(FLOW_BODY), 'fetched');
  assert.strictEqual(seen.length, 1);
});

test('the flow\'s own api is not a connector in it', () => {
  const { inFlow } = load();
  // Every flow response carries properties.apiId = shared_logicflows, which is
  // the flow itself. Collecting it would put an entry in the filter that is in
  // every flow ever made.
  inFlow.read(FLOW, JSON.stringify({
    properties: {
      apiId: '/providers/Microsoft.PowerApps/apis/shared_logicflows',
      connectionReferences: { shared_sharepointonline: {} }
    }
  }), 'fetched');
  assert.deepStrictEqual(inFlow.list(), ['shared_sharepointonline']);

  // The other two the designer excludes alongside it.
  const other = load().inFlow;
  other.read(FLOW, JSON.stringify({
    a: '/providers/Microsoft.PowerApps/apis/shared_powerflows',
    b: '/providers/Microsoft.PowerApps/apis/shared_pqogenericconnector'
  }), 'fetched');
  assert.deepStrictEqual(other.list(), []);
});

test('a name that is not one is not collected', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify({
    // A bare "/apis" with nothing after it, and a type field that only looks
    // like an id.
    type: '/providers/Microsoft.PowerApps/apis',
    properties: { apiId: '/providers/Microsoft.PowerApps/apis/' }
  }), 'fetched');
  assert.deepStrictEqual(inFlow.list(), []);
});

test('a deep or repetitive body is read without running away', () => {
  const { inFlow } = load();
  let deep = { properties: { apiId: '/providers/Microsoft.PowerApps/apis/shared_office365' } };
  for (let i = 0; i < 400; i++) deep = { nested: deep };
  inFlow.read(FLOW, JSON.stringify(deep), 'fetched');
  // Past the depth limit, so nothing is found - and nothing hangs or throws.
  assert.deepStrictEqual(inFlow.list(), []);
});

test('a built-in step is read from its type and its kind together', () => {
  // Four steps that share the type `Request` and land in four different groups.
  // Reading the type alone would put all four in one.
  const cases = [
    [{ type: 'Request', kind: 'Button' }, 'flow'],
    [{ type: 'Request', kind: 'Http' }, 'request'],
    [{ type: 'Request', kind: 'TeamsWebhook' }, 'teams'],
    [{ type: 'Request', kind: 'PowerAppV2' }, 'powerapps']
  ];
  for (const [trigger, group] of cases) {
    const { inFlow } = load();
    inFlow.read(FLOW, JSON.stringify({ properties: { definition: { triggers: { manual: trigger } } } }), 'fetched');
    assert.deepStrictEqual(inFlow.list(), [group], JSON.stringify(trigger));
  }
});

test('built-ins nested inside a scope and a switch are read too', () => {
  const { inFlow } = load();
  // The shape a saved flow arrives in: steps keyed by name, nested under the
  // step that contains them, and under `cases` for a switch.
  inFlow.read(FLOW, JSON.stringify({
    properties: {
      definition: {
        triggers: { Recurrence: { type: 'Recurrence' } },
        actions: {
          Notification: {
            type: 'Scope',
            actions: {
              Detect_button: {
                type: 'Switch',
                cases: {
                  Send: { actions: { Wait_a_bit: { type: 'Wait' } } },
                  Cancel: { actions: { Stop: { type: 'Terminate' } } }
                },
                default: { actions: { Log_it: { type: 'Compose' } } }
              }
            }
          }
        }
      }
    }
  }), 'fetched');
  assert.deepStrictEqual(inFlow.list(), ['control', 'dataoperation', 'schedule']);
});

test('a type that is not a step is not a group', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify({
    properties: {
      definition: {
        actions: {
          Parse_it: {
            // `Table` and `Http` are both real built-in step types. Here they are
            // a schema and a request, sitting inside a step rather than being one.
            type: 'ParseJson',
            inputs: {
              schema: { type: 'Table', properties: { host: { type: 'Http' } } }
            }
          }
        }
      },
      // And a type outside any step at all.
      resourceType: { type: 'Scope' }
    }
  }), 'fetched');
  assert.deepStrictEqual(inFlow.list(), ['dataoperation']);
});

test('a connector step is not read as a built-in', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify({
    properties: {
      definitionSummary: {
        actions: [{
          type: 'OpenApiConnection',
          api: { name: 'shared_office365' }
        }]
      }
    }
  }), 'fetched');
  assert.deepStrictEqual(inFlow.list(), ['shared_office365']);
});

test('a built-in the table has not got is skipped, not guessed at', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify({
    properties: {
      definition: {
        actions: {
          // A type nobody has seen, a known type with an unknown kind whose type
          // means nothing without one, and a step that is not an object.
          Brand_new: { type: 'Holodeck' },
          Newish: { type: 'Request', kind: 'Holodeck' },
          Not_a_step: 'Scope'
        }
      }
    }
  }), 'fetched');
  assert.deepStrictEqual(inFlow.list(), []);

  // A known type whose group does not depend on its kind still resolves.
  const other = load().inFlow;
  other.read(FLOW, JSON.stringify({
    properties: { definition: { actions: { Loop: { type: 'Until', kind: 'Holodeck' } } } }
  }), 'fetched');
  assert.deepStrictEqual(other.list(), ['control']);
});

test('every group the table names is one the Microsoft view knows', () => {
  // Both are read off the same catalogue. If a regenerated table names a group
  // the Microsoft view has not got, that group is missing from that filter too.
  const { inFlow } = load();
  const known = new Set(views.BUILT_IN);
  for (const [pair, group] of Object.entries(inFlow.builtInOps)) {
    assert.ok(known.has(group), pair + ' -> ' + group + ' is not in views.BUILT_IN');
  }
});

test('a step deleted and saved leaves the filter', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify(FLOW_BODY), 'fetched');
  assert.ok(inFlow.list().includes('shared_office365'));

  // The same flow saved again without the email step or its connection.
  const trimmed = JSON.parse(JSON.stringify(FLOW_BODY));
  trimmed.properties.definitionSummary.actions =
    trimmed.properties.definitionSummary.actions.filter((a) => !a.api || a.api.name !== 'shared_office365');
  inFlow.read(FLOW, JSON.stringify(trimmed), 'saved');
  assert.deepStrictEqual(inFlow.list(), FLOW_GROUPS.filter((g) => g !== 'shared_office365'));
});

test('a partial body only adds', () => {
  const { inFlow } = load();
  inFlow.read(FLOW, JSON.stringify(FLOW_BODY), 'fetched');
  // A rename or state change carries no definition, so it cannot say what left.
  inFlow.read(FLOW, JSON.stringify({ properties: { state: 'Stopped' } }), 'saved');
  assert.deepStrictEqual(inFlow.list(), FLOW_GROUPS);
});

test('another flow fetched from the open one does not replace it', async () => {
  const { inFlow, handler } = load();
  handler.transform({ url: FLOW_URL, status: 200, text: JSON.stringify(FLOW_BODY) });
  await settle();
  assert.deepStrictEqual(inFlow.list(), FLOW_GROUPS);

  // A child flow the designer looks up while this one is open.
  const child = BASE + '/powerautomate/flows/66666666-7777-4888-9999-000000000000?api-version=1';
  handler.transform({ url: child, status: 200, text: JSON.stringify({ properties: { definition: {} } }) });
  await settle();
  assert.deepStrictEqual(inFlow.list(), FLOW_GROUPS, 'the child flow replaced the open one');
});

test('with no flow in the route, any flow request is believed', async () => {
  const { inFlow, handler } = load('/environments/x/flows/new');
  handler.transform({ url: FLOW_URL, status: 200, text: JSON.stringify(FLOW_BODY) });
  await settle();
  assert.deepStrictEqual(inFlow.list(), FLOW_GROUPS);
});
