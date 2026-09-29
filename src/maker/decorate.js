'use strict';
// Classification colour coding (page context). Off unless the setting is on.
//
// This runs in the MAIN world alongside the interceptor, not in the isolated
// world: content scripts share the DOM either way, and page context is where
// policy.js and env.js already live. Keeping it here also keeps the two
// content_scripts entries for this origin file-disjoint, which they must be -
// Chrome injects a given path into a document once, so anything listed in both
// entries reaches only the first of them.
//
// The designer is Fluent UI v9, so its class names are generated and useless to
// match on. Each connector row does carry a stable hook:
//
//   <div role="listitem" class="ms-List-cell">
//     <div><div role="group" class="fui-Card ..."
//          data-automation-id="flow-op-search-result-providers_microsoft_processsimple_operationgroups_shared_sharepointonline">
//
// The automation id is the connector's resource path, lowercased with every "/"
// and "." turned into "_", so the group name can be read straight off the DOM -
// no display-name lookup, no dependence on the catalogue responses.
//
// Nothing here can affect what is hidden; the worst case is an absent tint.

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
  var log = __cdpa.log.create('decorate');
  var CHANNEL = 'cdpa-maker';
  var MARKER = 'data-cdpa-classification';
  var STYLE_ID = 'cdpa-classification-style';
  var KEY_ID = 'cdpa-classification-key';
  var TIP_ID = 'cdpa-classification-tip';

  // The row itself is the fui-Card carrying the automation id - which is the
  // whole box, so the tint covers the row rather than an edge of it.
  var ROW_SELECTOR = '[data-automation-id^="flow-op-search-result-"]';
  var COALESCE_MS = 50;

  // The panel header holds the breadcrumb ("Add an action") and the close button;
  // the key goes between them, so it sits beside the close button whatever the
  // breadcrumb says. Both hooks are automation ids, so neither depends on the
  // generated class names.
  var HEADER_SELECTOR = '[data-automation-id="flow-app-action-header"]';
  var CLOSE_SELECTOR = '[data-automation-id="flow-panel-header-close"]';
  var KEY_MARKER = 'data-cdpa-key';
  var TIP_ATTR = 'data-cdpa-tip';

  // The two DLP classifications are always meaningful. The hide reasons only ever
  // appear with "show everything" on - with it off those rows are not in the panel
  // at all - so the key grows and shrinks with the setting rather than listing
  // colours the user cannot see.
  var DLP_LEGEND = [
    { value: 'Confidential', colour: 'business', label: 'Business (Confidential)' },
    { value: 'General', colour: 'nonBusiness', label: 'Non-business (General)' }
  ];
  var BLOCKED_LEGEND =
    { value: 'Blocked', colour: 'blocked', label: 'Blocked by your DLP policy' };

  // Category rules are user-editable, so their entries are built from settings:
  // the rule's own id picks the colour and its own label names it.
  var RULE_PREFIX = 'rule:';

  function legend() {
    var entries = DLP_LEGEND.slice();
    if (!showEverything) return entries;
    entries.push(BLOCKED_LEGEND); // first, because it outranks every rule below it
    (compiledRules || []).forEach(function (rule) {
      entries.push({ value: RULE_PREFIX + rule.id, colour: rule.id, label: rule.label });
    });
    return entries;
  }

  // How far the tint goes. Dark mode gets a little more of a lighter mix, because
  // a translucent dark colour over a dark panel reads as nothing at all.
  var LIGHT_ALPHA = 0.13;
  var DARK_ALPHA = 0.20;
  var DARK_LIGHTEN = 0.35;

  // Only used when a stored colour is missing or unparseable. storage.js owns the
  // real defaults, but it is not loaded in page context, so these are a copy -
  // test/settings.test.js asserts the two stay in step.
  var DEFAULT_COLOURS = {
    business: '#7a5ea8', nonBusiness: '#4c8c4a',
    blocked: '#c4314b', desktop: '#0f6cbd', agentic: '#c2610a'
  };
  var UNNAMED_RULE_COLOUR = '#6b6b6b';

  var enabled = false;
  var colours = null;
  var store = null;
  var compiledRules = null;
  var showEverything = false;
  var resolvedByEnv = new Map();
  var observer = null;
  var scheduled = false;
  var warnedNoMatches = false;

  function parseHex(hex) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function lighten(rgb, amount) {
    return {
      r: Math.round(rgb.r + (255 - rgb.r) * amount),
      g: Math.round(rgb.g + (255 - rgb.g) * amount),
      b: Math.round(rgb.b + (255 - rgb.b) * amount)
    };
  }

  function rgba(rgb, alpha) {
    return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
  }

  // `which` is a colour key: one of the two DLP names, 'blocked', or a category
  // rule id. A colour typed by hand can be nonsense, and a rule the user invented
  // has no colour at all, so both fall back rather than emit broken CSS.
  function colourFor(which) {
    return parseHex(colours && colours[which]) ||
      parseHex(DEFAULT_COLOURS[which]) ||
      parseHex(UNNAMED_RULE_COLOUR);
  }

  // A flat gradient rather than a background-color, which is not a style choice.
  // The designer's card sets its own background-color from an atomic Fluent class
  // (.fxugw4r{background-color:var(--colorNeutralBackground1)}), and Griffel adds
  // that rule at runtime with insertRule - so it always lands after our sheet, and
  // at equal specificity later wins. Raising specificity is a race we cannot win
  // against generated class names, and !important would kill the card's hover
  // feedback. background-image is a different longhand: Fluent never touches it
  // (Griffel forbids shorthands, so nothing resets it), it paints over whatever
  // background-color is underneath, and hover still shifts that base beneath an
  // unchanged tint.
  // A legend value carries a rule id, and rule ids come from settings a config
  // file can supply. Settings sanitise ids already; this makes sure that, whatever
  // arrives, the value cannot close the attribute selector and start CSS of its own.
  function attr(value) {
    return '"' + String(value).replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, ' ') + '"';
  }

  function rulesFor(value, which) {
    var base = colourFor(which);
    function rule(rgb, alpha) {
      var c = rgba(rgb, alpha);
      return '[' + MARKER + '=' + attr(value) + ']{background-image:linear-gradient(' +
        c + ',' + c + ')}';
    }
    return {
      light: rule(base, LIGHT_ALPHA),
      dark: rule(lighten(base, DARK_LIGHTEN), DARK_ALPHA)
    };
  }

  // A wash of colour over the whole box rather than a stripe. Translucent so it
  // tints whatever the designer paints underneath and works in either theme, and
  // kept faint so it reads as a hint rather than a status.
  // The key's dot. Solid rather than the row's 13% wash: at that alpha a 12px dot
  // is invisible, and the solid colour is the one the settings page shows in its
  // picker, so the two read as the same colour.
  function keyRuleFor(value, which, dark) {
    var base = colourFor(which);
    return '[' + KEY_MARKER + '=' + attr(value) + ']{background-color:' +
      rgba(dark ? lighten(base, DARK_LIGHTEN) : base, 1) + '}';
  }

  // The tooltip is a popover, which the browser paints in the top layer. A
  // positioned pseudo-element does not work here: z-index only orders siblings
  // within a stacking context, and the panel's search bar sits in one that paints
  // above the header's - so the tooltip went behind it however high the z-index
  // went. The top layer is outside all of that, and outside any overflow clipping.
  //
  // UA styles give a popover `position:fixed;inset:0;margin:auto`, so inset and
  // margin are reset before left/top are set from the dot's own rectangle.
  var KEY_CSS =
    '#' + KEY_ID + '{display:inline-flex;align-items:center;gap:6px;' +
      'margin-inline-start:auto;margin-inline-end:8px}' +
    '[' + KEY_MARKER + ']{width:12px;height:12px;border-radius:50%;' +
      'display:inline-block;flex:0 0 auto;box-sizing:border-box;' +
      'border:1px solid rgba(0,0,0,.25);outline-offset:2px}' +
    '#' + TIP_ID + '{position:fixed;inset:auto;margin:0;border:0;overflow:visible;' +
      'width:max-content;max-width:280px;white-space:nowrap;' +
      'background:#323130;color:#fff;padding:4px 8px;border-radius:4px;' +
      'font:400 12px/1.35 "Segoe UI",system-ui,sans-serif;pointer-events:none}';

  function injectStyle() {
    // Rules are emitted for every legend entry, including the hide reasons that only
    // show up under "show everything" - the tint and the key then always agree.
    var entries = legend();
    var light = '', dark = '';
    entries.forEach(function (e) {
      var r = rulesFor(e.value, e.colour);
      light += r.light + keyRuleFor(e.value, e.colour, false);
      dark += r.dark + keyRuleFor(e.value, e.colour, true);
    });
    var css =
      '[' + MARKER + ']{border-radius:4px}' + KEY_CSS + light +
      '@media (prefers-color-scheme:dark){' + dark + '}';

    var style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    // Rewritten rather than recreated, so a colour change lands without a reload.
    if (style.textContent !== css) {
      style.textContent = css;
      log.debug('classification colours applied:', css.length, 'bytes of CSS');
    }
  }

  // The panel is per-environment, and so is the policy that governs it. Reading
  // the environment from the URL each pass keeps an in-app environment switch
  // honest without a reload.
  function resolvedNow() {
    if (!store) return null;
    var canonicalEnv = __cdpa.env.canonicalFromPath(location.pathname);
    if (!canonicalEnv) return null;
    if (!resolvedByEnv.has(canonicalEnv)) {
      resolvedByEnv.set(canonicalEnv, __cdpa.policy.resolveForEnvironment(store, canonicalEnv));
    }
    return resolvedByEnv.get(canonicalEnv);
  }

  // A dot per classification beside the panel's close button, naming what the
  // tints mean. Re-checked on every pass rather than built once: React re-renders
  // the panel header, and an element it has thrown away is no longer in the
  // header even though we still hold a reference to it.
  var keySignature = null;
  var tip = null;

  // Chrome has had popovers since 114 and this is a Chrome extension, but a
  // tooltip is not worth a hard dependency: without them the browser's own
  // title tooltip stands in.
  function popoverSupported() {
    return typeof HTMLElement !== 'undefined' &&
      typeof HTMLElement.prototype.showPopover === 'function';
  }

  function tipElement() {
    if (tip && tip.parentNode) return tip;
    tip = document.createElement('div');
    tip.id = TIP_ID;
    // "manual" rather than "auto": an auto popover closes on any outside click and
    // shuts every other one, which would interfere with the designer's own menus.
    tip.setAttribute('popover', 'manual');
    document.body.appendChild(tip);
    return tip;
  }

  function showTip(dot) {
    if (!popoverSupported()) return;
    var el = tipElement();
    el.textContent = dot.getAttribute(TIP_ATTR) || '';
    try {
      el.hidePopover();  // re-showing an open popover throws
    } catch (e) { /* it was not open */ }
    try {
      el.showPopover();
    } catch (e) {
      return;
    }
    // Measured only once it is laid out, so it can be right-aligned to the dot -
    // the key sits at the right-hand end of the header, so it opens leftwards.
    var box = dot.getBoundingClientRect();
    var own = el.getBoundingClientRect();
    var left = Math.max(8, Math.min(box.right - own.width, document.documentElement.clientWidth - own.width - 8));
    el.style.left = left + 'px';
    el.style.top = (box.bottom + 6) + 'px';
  }

  function hideTip() {
    if (!tip || !popoverSupported()) return;
    try {
      tip.hidePopover();
    } catch (e) { /* already closed */ }
  }

  function removeTip() {
    hideTip();
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
    tip = null;
  }

  function ensureKey() {
    var header = document.querySelector(HEADER_SELECTOR);
    if (!header) return;
    // Rebuild when the legend itself changes - toggling "show everything" or editing
    // a rule adds and removes dots - not only when React has thrown the key away.
    var signature = legend().map(function (e) { return e.value + '|' + e.label; }).join(',');
    var existing = document.getElementById(KEY_ID);
    if (existing && existing.parentNode === header && signature === keySignature) return;
    keySignature = signature;
    hideTip(); // the dot it was describing is about to be thrown away
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var key = document.createElement('div');
    key.id = KEY_ID;
    // Not a live region and not interactive: it is a caption for the colours.
    key.setAttribute('role', 'group');
    key.setAttribute('aria-label', 'Connector classification key');
    legend().forEach(function (entry) {
      var dot = document.createElement('span');
      dot.setAttribute(KEY_MARKER, entry.value);
      dot.setAttribute(TIP_ATTR, entry.label);
      // The dot carries no text, so it needs both a role and a name of its own -
      // and a tab stop, or the tooltip is mouse-only.
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', entry.label);
      dot.setAttribute('tabindex', '0');
      if (popoverSupported()) {
        // Focus as well as hover, or the tooltip is mouse-only.
        dot.addEventListener('mouseenter', function () { showTip(dot); });
        dot.addEventListener('focus', function () { showTip(dot); });
        dot.addEventListener('mouseleave', hideTip);
        dot.addEventListener('blur', hideTip);
      } else {
        dot.setAttribute('title', entry.label);
      }
      key.appendChild(dot);
    });

    var close = header.querySelector(CLOSE_SELECTOR);
    if (close) header.insertBefore(key, close);
    else header.appendChild(key);
    log.debug('classification key placed in the panel header');
  }

  function removeKey() {
    keySignature = null;
    removeTip();
    var key = document.getElementById(KEY_ID);
    if (key && key.parentNode) key.parentNode.removeChild(key);
  }

  // What the catalogue said about this group. The interceptor records it as the
  // designer fetches it; the DOM is the fallback, and gives up only the name and
  // the display name - a group matched purely by tag is why the stash exists.
  function groupInfo(name, node) {
    var stashed = __cdpa.catalogue && __cdpa.catalogue.get(name);
    if (stashed) return stashed;
    return { name: name, displayName: node.getAttribute('aria-label') || '', tags: [] };
  }

  // Why this row is the colour it is, most decisive reason first. Blocked wins over
  // everything: DLP is the one constraint the user cannot lift from here, so a row
  // that is blocked reads as blocked even when a category rule also catches it.
  //
  // The practical cost is that the category colours are rarer than they look - under
  // a strict policy most desktop and agent connectors are blocked as well, so those
  // show as Blocked. The category colours are then
  // specifically "hidden by a rule of yours, and otherwise allowed".
  //
  // Both outrank the Business/Non-business split, which is moot for a row that
  // would not be on screen at all.
  //
  // Hide reasons are only assigned under "show everything": with it off, a row that
  // would be hidden is not in the panel, so anything still matching a rule is there
  // because the user turned that rule off - and colouring it would be noise.
  function valueFor(name, node, resolved) {
    // The automation id is lowercased. The virtual groups (Http, VirtualAgent…)
    // are matched case-insensitively by connectorMap; ordinary connector names
    // are lowercase in the policies already.
    if (showEverything) {
      if (__cdpa.policy.isGroupBlocked(resolved, name)) return 'Blocked';
      var ruleId = compiledRules && compiledRules.length
        ? __cdpa.filters.hiddenBy(groupInfo(name, node), compiledRules)
        : null;
      if (ruleId) return RULE_PREFIX + ruleId;
    }
    return __cdpa.policy.groupClassification(resolved, name);
  }

  function decorate() {
    scheduled = false; // cleared first, so no early return below can wedge it
    if (!enabled) return;
    var resolved = resolvedNow();
    if (!resolved || !resolved.covered) return;

    ensureKey();

    var nodes = document.querySelectorAll(ROW_SELECTOR);
    if (!nodes.length) {
      if (!warnedNoMatches) {
        warnedNoMatches = true;
        log.debug('no connector rows matched', ROW_SELECTOR, 'yet - this is normal',
          'until the "Add an action" panel is opened');
      }
      return;
    }

    var marked = 0;
    var unmatched = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.hasAttribute(MARKER)) continue;
      var group = __cdpa.connectorMap.groupFromAutomationId(
        node.getAttribute('data-automation-id') || '');
      if (!group) continue;
      var value = valueFor(group, node, resolved);
      if (value) {
        node.setAttribute(MARKER, value);
        marked++;
      } else if (unmatched.length < 5) {
        unmatched.push(group);
      }
    }
    if (marked || unmatched.length) {
      log.debug('tinted', marked, 'of', nodes.length, 'rows' +
        (unmatched.length ? '; no classification for e.g. ' + unmatched.join(', ') : ''));
    }
  }

  // Coalesce bursts of mutations into one pass. Deliberately a timer rather than
  // requestAnimationFrame: rAF does not fire while the tab is not painting, and
  // because the pending flag latches, one dropped frame stopped every later pass.
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(decorate, COALESCE_MS);
  }

  function start() {
    if (observer) return;
    injectStyle();
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    schedule();
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    removeKey();
    clearMarks();
  }

  function clearMarks() {
    var marked = document.querySelectorAll('[' + MARKER + ']');
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(MARKER);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'config') return;

    var settings = msg.settings || {};
    store = msg.store || null;
    resolvedByEnv = new Map();
    colours = settings.colours || null;
    showEverything = !!settings.showEverything;
    compiledRules = __cdpa.filters.compile(settings.categoryRules);
    var wanted = !!settings.colourCode;
    if (wanted !== enabled) {
      enabled = wanted;
      log.debug('colour coding', enabled ? 'on' : 'off');
      if (enabled) start(); else stop();
    } else if (enabled) {
      injectStyle(); // pick up a colour change without waiting for a reload
      // Toggling "show everything" or editing a rule changes what a row should be,
      // not just what that value looks like, so already-marked rows are re-judged.
      clearMarks();
      schedule();
    }
  });
})();
