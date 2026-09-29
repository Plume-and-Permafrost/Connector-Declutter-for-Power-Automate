'use strict';
// Bridges the two vocabularies.
//
// DLP policies name connectors as "/providers/Microsoft.PowerApps/apis/shared_x",
// which reduces to the designer's operation-group name "shared_x". The virtual
// connectors are the exception: their policy ids look nothing like the group
// names the designer uses, so they need a hand-written map.
//
// Some designer groups are covered by several policy entries (all five Power
// Virtual Agents channels map onto one "VirtualAgent" group). Those groups are
// only hidden when *every* policy entry mapping to them is blocked - the same
// fail-open rule applied everywhere else: never hide on partial evidence.
//
// DesktopFlow.* policy entries are deliberately absent. They are Power Automate
// Desktop action groups and never appear in the cloud designer; the "hide
// desktop connectors" category filter handles the one group that does
// (shared_uiflow).
var __cdpa = globalThis.__cdpa || (globalThis.__cdpa = {});

__cdpa.connectorMap = (function () {
  // policy connector name -> designer operation group name
  var VIRTUAL_TO_GROUP = {
    Http: 'Http',
    HttpWebhook: 'HttpWebhook',
    HttpRequestReceived: 'Request',
    TeamsWebhookRequestReceived: 'Teams',
    PvaSkills: 'Skills',
    PvaAuth: 'VirtualAgent',
    PvaCustomDemoMobile: 'VirtualAgent',
    PvaFacebook: 'VirtualAgent',
    PvaMicrosoftTeams: 'VirtualAgent',
    PvaOmniChannel: 'VirtualAgent'
  };

  // designer group name -> every policy connector that maps onto it. Keyed
  // lowercased: the catalogue spells these Http and VirtualAgent, but a row in
  // the DOM only ever says http and virtualagent, and both must find the entry.
  var GROUP_TO_POLICY = (function () {
    var out = Object.create(null);
    Object.keys(VIRTUAL_TO_GROUP).forEach(function (policyName) {
      var group = VIRTUAL_TO_GROUP[policyName].toLowerCase();
      (out[group] || (out[group] = [])).push(policyName);
    });
    return out;
  })();

  // The DOM's own spelling. A connector row carries the resource path lowercased
  // with every "/" and "." turned into "_", so the group name can be read off the
  // row without a display-name lookup:
  //
  //   "...operationgroups_shared_sharepointonline"           -> shared_sharepointonline
  //   "_providers_microsoft_powerapps_apis_shared_office365" -> shared_office365
  //   "...operationgroups_aibuilder_operations_predict_x"    -> aibuilder
  //
  // Lowercased, so callers compare case-insensitively. Shared by the decorator
  // and the view filter, which read the same rows for different reasons.
  var AUTOMATION_PREFIX = 'flow-op-search-result-';

  function groupFromAutomationId(automationId) {
    var id = String(automationId == null ? '' : automationId);
    if (id.indexOf(AUTOMATION_PREFIX) !== 0) return null;
    var rest = id.slice(AUTOMATION_PREFIX.length);
    var at = rest.lastIndexOf('operationgroups_');
    if (at !== -1) rest = rest.slice(at + 'operationgroups_'.length);
    else {
      at = rest.lastIndexOf('apis_');
      if (at !== -1) rest = rest.slice(at + 'apis_'.length);
    }
    // An operation hangs off its group; the group is the part in front.
    var ops = rest.indexOf('_operations_');
    if (ops !== -1) rest = rest.slice(0, ops);
    return rest || null;
  }

  // "/providers/Microsoft.PowerApps/apis/shared_x" -> "shared_x", "Http" -> "Http"
  function toConnectorName(id) {
    var s = String(id == null ? '' : id).trim();
    var slash = s.lastIndexOf('/');
    return slash === -1 ? s : s.slice(slash + 1);
  }

  // Which policy connector names decide the fate of this designer group?
  function policyNamesForGroup(groupName) {
    var name = String(groupName == null ? '' : groupName);
    var mapped = GROUP_TO_POLICY[name.toLowerCase()];
    return mapped ? mapped.slice() : [name];
  }

  return {
    AUTOMATION_PREFIX: AUTOMATION_PREFIX,
    groupFromAutomationId: groupFromAutomationId,
    toConnectorName: toConnectorName,
    policyNamesForGroup: policyNamesForGroup
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.connectorMap;
