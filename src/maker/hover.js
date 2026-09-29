'use strict';
// Steady rows (page context). Off unless the setting is on.
//
// Hovering a connector card makes the row half a pixel taller, and the list is
// virtualised - Fluent's `ms-List` measures its cells and re-lays the page out
// when one changes - so the whole grid twitches as the pointer moves across it.
//
// The box shadow is the obvious suspect and is innocent: a shadow never takes
// part in layout. The real cause is two buttons inside the card that are only
// there while it is hovered. From the designer's own bundle:
//
//   recommendationPanelCard: {
//     ...
//     '&:focus, &:hover, &:focus-within': {
//       '& .favorite-button-visible-on-hover': { display: 'inline' },
//       '& .info-dot-visible-on-hover':       { display: 'inline' }
//     }
//   }
//   recommendationPanelCardVisibleOnHover: { display: 'none' }
//
// So the info dot - and the favourite star, when the designer has decided to
// hide that one too - go from `display: none` to `display: inline`, and the row
// grows by whatever the taller of them adds.
//
// The fix is the standard one for a control that appears on hover: reserve its
// box all the time and only toggle whether it is painted. `display: inline` is
// the same value the designer sets on hover, so the box reserved here and the
// box on hover are the same box, and hovering cannot change the row's size.
//
// Those two class names are hand-written rather than generated, which is why
// this can be pinned in CSS at all - everything else on the card is a Griffel
// atomic class with a name that changes between builds.
//
// This runs in the MAIN world beside decorate.js and sections.js: content
// scripts share the DOM either way, and the config already arrives here. Unlike
// those two it needs no pass over the DOM at all - it is one static stylesheet.

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
  var log = __cdpa.log.create('hover');
  var CHANNEL = 'cdpa-maker';
  var STYLE_ID = 'cdpa-steady-rows-style';

  // The card, on the same hook decorate.js tints.
  var ROW = '[data-automation-id^="flow-op-search-result-"]';
  var HOVER_ONLY = ['.info-dot-visible-on-hover', '.favorite-button-visible-on-hover'];
  // Exactly the states the designer reveals them on, so nothing is revealed that
  // the designer would have kept hidden, and nothing stays hidden that it shows.
  var STATES = [':hover', ':focus', ':focus-within'];

  function selectorsFor(state) {
    return HOVER_ONLY.map(function (cls) {
      return ROW + (state || '') + ' ' + cls;
    }).join(',');
  }

  // `display` is shouted, `visibility` is not. The designer's `display: none`
  // comes from a Griffel atomic class inserted at runtime, so it always lands
  // after this sheet; the selectors here are more specific and would win anyway,
  // but Griffel doubles up a class name to raise its own specificity often enough
  // that it is not worth relying on. Nothing anywhere sets `visibility` on these,
  // so that half needs no help.
  var CSS =
    selectorsFor('') + '{display:inline !important;visibility:hidden}' +
    STATES.map(selectorsFor).join(',') + '{visibility:visible}';

  function injectStyle() {
    var style = document.getElementById(STYLE_ID);
    if (style) return;
    style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
    log.debug('steady rows on -', CSS.length, 'bytes of CSS');
  }

  function removeStyle() {
    var style = document.getElementById(STYLE_ID);
    if (!style) return;
    if (style.parentNode) style.parentNode.removeChild(style);
    log.debug('steady rows off');
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'config') return;
    if ((msg.settings || {}).steadyRows) injectStyle(); else removeStyle();
  });
})();
