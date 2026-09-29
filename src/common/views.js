'use strict';
// Views: our own pills beside the designer's All / Built-in / Shared / Custom.
//
// A view is an allow-list of operation group names. src/maker/search-service.js
// adds one pill per view to the designer's own filter and answers for it when
// browsing and searching; nothing here touches the network responses.
//
// Views are allow-lists, the opposite of the category rules in filters.js, which
// are block-lists. Only one view is ever active, like the designer's own filter.
var __cdpa = globalThis.__cdpa || (globalThis.__cdpa = {});

__cdpa.views = (function () {

  // The Microsoft view: connectors for Microsoft's own products and services.
  //
  // Not "published by Microsoft", which is the only flag the catalogue actually
  // carries and is not the same question - Microsoft publishes the Salesforce,
  // Dropbox, Gmail and Trello connectors too, and someone filtering to Microsoft
  // does not mean those. This is the publisher list narrowed by brand: Azure,
  // Dynamics, Microsoft 365, Power Platform, and the wholly-owned brands
  // (GitHub, LinkedIn, Skype). Protocol connectors Microsoft happens to publish -
  // FTP, SFTP, SMTP, RSS, File System - are left out; they are not a product.
  //
  // It is a snapshot of the connector catalogue at the time of writing, so
  // connectors released later will not be in it. That is what the editable view
  // below is for: anything missing can be ticked into it by hand.

  // Every built-in group. All seventeen are Microsoft's own, and a Microsoft view
  // that hid Control and Variable would surprise everyone.
  var BUILT_IN = [
    'Control', 'DataOperation', 'Datetime',
    'Flow', 'FlowsBuiltIn', 'Http',
    'NumberFunctions', 'PowerApps', 'PowerPages',
    'Request', 'Schedule', 'Skills',
    'Teams', 'TextFunctions', 'Variable',
    'VirtualAgent', 'aibuilder'
  ];

  var CONNECTORS = [
    'shared_a365adminmcp', 'shared_a365copilotchatmcp', 'shared_a365memcp',
    'shared_a365outlookcalendarmcp', 'shared_a365outlookmailmcp', 'shared_a365teamsmcp',
    'shared_a365wordmcp', 'shared_aadinvitationmanager', 'shared_aci',
    'shared_acl', 'shared_acschat', 'shared_acsemail',
    'shared_acsidentity', 'shared_acssmsevents', 'shared_agentsdk',
    'shared_alchemy', 'shared_applicationinsights', 'shared_approvals',
    'shared_arm', 'shared_assistantstudiov2', 'shared_azuread',
    'shared_azureadip', 'shared_azureagentservice', 'shared_azureaifoundryinference',
    'shared_azureaisearch', 'shared_azureaisearchfoundryiq', 'shared_azureappservice',
    'shared_azureautomation', 'shared_azureblob', 'shared_azurecommunicationservicessms',
    'shared_azuredatafactory', 'shared_azuredatalake', 'shared_azuredigitaltwins',
    'shared_azureeventgrid', 'shared_azureeventgridpublish', 'shared_azurefile',
    'shared_azureiotcentral', 'shared_azureloganalytics', 'shared_azureloganalyticsdatacollector',
    'shared_azuremaps', 'shared_azuremonitorlogs', 'shared_azuremonitorlogsingestion',
    'shared_azuremysql', 'shared_azureopenai', 'shared_azurequeues',
    'shared_azurespeechpronuncia', 'shared_azuretables', 'shared_azuretexttospeech',
    'shared_azurevm', 'shared_bingmaps', 'shared_bingsearch',
    'shared_biztalk', 'shared_businessassist', 'shared_cimcp',
    'shared_cloudappsecurity', 'shared_cognitiveservicescomputervision', 'shared_cognitiveservicescontentmoderator',
    'shared_cognitiveservicescustomvision', 'shared_cognitiveservicesqnamaker', 'shared_cognitiveservicesspe',
    'shared_cognitiveservicestextanalytics', 'shared_commercemerchandising', 'shared_commondataservice',
    'shared_commondataserviceforapps', 'shared_contentunderstanding', 'shared_contosohub',
    'shared_copilotflow', 'shared_copilotforfinance', 'shared_copilotforsales',
    'shared_copilotforservice', 'shared_customerinsights', 'shared_d365contactcenteradminmcpserver',
    'shared_d365contactcentermcpserver', 'shared_d365salesmcpserver', 'shared_dataactivator',
    'shared_dataactivatorpreview', 'shared_dataflows', 'shared_df_databricks',
    'shared_documentdb', 'shared_dynamics365ratingsre', 'shared_dynamicsax',
    'shared_dynamicscrmonline', 'shared_dynamicsfraudprotect', 'shared_dynamicsnavision',
    'shared_dynamicssmbonprem', 'shared_dynamicssmbsaas', 'shared_dynamicstranslations',
    'shared_eventhubs', 'shared_excel', 'shared_excelonline',
    'shared_excelonlinebusiness', 'shared_fabriciqmcpserver', 'shared_faceapi',
    'shared_flowmanagement', 'shared_flowpush', 'shared_formrecognizer',
    'shared_github', 'shared_intentionaldatasources', 'shared_iotcentral',
    'shared_jupyrest', 'shared_kaizala', 'shared_keyvault',
    'shared_kusto', 'shared_linkedin', 'shared_linkedinv2',
    'shared_luis', 'shared_m365messagecenter', 'shared_m365updatesapp',
    'shared_microsoft365compliance', 'shared_microsoftbookings', 'shared_microsoftcopilotstudio',
    'shared_microsoftflowforadmins', 'shared_microsoftforms', 'shared_microsoftformspro',
    'shared_microsoftgraphsecurity', 'shared_microsoftlearndocsmcpserver', 'shared_microsoftloop',
    'shared_microsoftpartnercent', 'shared_microsoftschooldatas', 'shared_microsoftsearch',
    'shared_microsofttranslator', 'shared_microsofttranslatorv', 'shared_msnweather',
    'shared_office365', 'shared_office365groups', 'shared_office365groupsmail',
    'shared_office365users', 'shared_office365video', 'shared_officeaiagent',
    'shared_onedrive', 'shared_onedriveforbusiness', 'shared_onenote',
    'shared_outlook', 'shared_outlooktasks', 'shared_partnercenterevents',
    'shared_partnercenterref', 'shared_planner', 'shared_powerappsforadmins',
    'shared_powerappsforappmakers', 'shared_powerappsnotification', 'shared_powerappsnotificationv2',
    'shared_powerbi', 'shared_powerplatformadminv2', 'shared_powerplatformforadmins',
    'shared_processmining', 'shared_projectonline', 'shared_projectroadmap',
    'shared_riskiqintelligence', 'shared_securitycopilot', 'shared_sendmail',
    'shared_sentinelmcp', 'shared_servicebus', 'shared_servicebus-1',
    'shared_sharepointembedded', 'shared_sharepointonline', 'shared_shifts',
    'shared_skypeforbiz', 'shared_sql', 'shared_sqldw',
    'shared_storeoperationsmcpserver', 'shared_teams', 'shared_teamsvirtualevents',
    'shared_todo', 'shared_todoconsumer', 'shared_translatorv2',
    'shared_uiflow', 'shared_videoindexer-v2', 'shared_visualstudioteamservices',
    'shared_wdatp', 'shared_webcontents', 'shared_webcontentsv2',
    'shared_windows365', 'shared_wordonlinebusiness', 'shared_workiqmcp',
    'shared_workiqonedrive', 'shared_workiqsharepoint', 'shared_yammer'
  ];

  var MICROSOFT_NAMES = BUILT_IN.concat(CONNECTORS);

  var MICROSOFT = 'microsoft';
  var PICKED = 'picked';
  var IN_FLOW = 'inflow';

  // What the three pills are called, beside the designer's All, Built-in, Shared
  // and Custom.
  //
  // `live` carries the views whose contents are not a setting. There is one:
  // "In Flow" is a property of the flow on screen, which only page context can
  // see - see src/maker/in-flow.js. Called without it, that view is empty, which
  // is the right answer anywhere the open flow is unknown.
  function list(settings, live) {
    var s = settings || {};
    var l = live || {};
    return [
      {
        id: MICROSOFT,
        label: 'Microsoft',
        names: MICROSOFT_NAMES
      },
      {
        id: PICKED,
        label: 'My Filter',
        names: Array.isArray(s.pickedConnectors) ? s.pickedConnectors : []
      },
      {
        id: IN_FLOW,
        label: 'In Flow',
        names: Array.isArray(l.inFlow) ? l.inFlow : []
      }
    ];
  }

  function find(settings, id, live) {
    if (!id) return null;
    var all = list(settings, live);
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  // Group names are matched case-insensitively throughout: the catalogue spells
  // them Control, dateTime and shared_sharepointonline, while the DOM only ever
  // exposes them lowercased.
  function compile(view) {
    if (!view) return null;
    var names = Object.create(null);
    (view.names || []).forEach(function (n) {
      names[String(n).toLowerCase()] = true;
    });
    return { id: view.id, label: view.label, names: names, size: (view.names || []).length };
  }

  function shows(compiled, name) {
    if (!compiled) return true;
    return !!compiled.names[String(name == null ? '' : name).toLowerCase()];
  }

  return {
    MICROSOFT: MICROSOFT,
    PICKED: PICKED,
    IN_FLOW: IN_FLOW,
    MICROSOFT_NAMES: MICROSOFT_NAMES,
    BUILT_IN: BUILT_IN,
    list: list,
    find: find,
    compile: compile,
    shows: shows
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.views;
