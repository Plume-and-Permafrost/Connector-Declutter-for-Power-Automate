'use strict';
// Connector panel sections (page context). Off unless one of the four section
// settings is on.
//
// Above the connector list the designer stacks three collapsible sections:
//
//   <div class="fui-Accordion">
//     <div class="fui-AccordionItem">
//       <div>
//         <div class="fui-AccordionHeader">
//           <button class="fui-AccordionHeader__button" aria-expanded="true">
//             <span class="fui-AccordionHeader__expandIcon">…</span>
//             <span class="fui-Text">Favorites</span>
//         <button class="fui-Link">See all (9)</button>
//       <div class="fui-AccordionPanel">…the section's own rows…
//
// These are a presentation layer over the same catalogue the interceptor already
// filters, so nothing here can be done in the responses: the sections are built
// from data the panel has, and hiding one is a layout choice, not a filter. Every
// connector in a hidden section is still in the list below it and still turns up
// in search.
//
// Each section shows only its first few entries, with a "See all (9)" link beside
// the heading for the rest - so opening Favourites means pressing that, not
// expanding the accordion.
//
// Unlike the connector rows the sections carry no automation id, no id and no
// aria-label - the heading text is the only thing that tells them apart. So this
// matches on that text, which means it only recognises an English designer.
// Nothing is hidden until a heading is recognised, so a designer in another
// language keeps all three sections rather than losing the wrong one.
//
// This runs in the MAIN world beside decorate.js for the same reason: content
// scripts share the DOM either way, and the config already arrives here.

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
  var log = __cdpa.log.create('sections');
  var CHANNEL = 'cdpa-maker';
  var MARKER = 'data-cdpa-section';
  var STYLE_ID = 'cdpa-section-style';
  var COALESCE_MS = 50;

  var ITEM_SELECTOR = '.fui-AccordionItem';
  var HEADER_SELECTOR = '.fui-AccordionHeader__button';
  var HEADER_ROW_SELECTOR = '.fui-AccordionHeader';
  var SEE_ALL_CLASS = 'fui-Link';
  // The panel as a whole, on the same hook decorate.js uses for its key.
  var PANEL_SELECTOR = '[data-automation-id="flow-app-action-header"]';

  // Headings are compared with punctuation, spacing and case thrown away, so
  // "Built-in tools", "Built in tools" and "BUILT-IN TOOLS" all land in the same
  // place. Favourites is spelt the American way in the designer and the British
  // way everywhere in this extension, so both are accepted.
  var SECTIONS = [
    { key: 'favourites', setting: 'hideFavourites', match: /^favou?rites$/ },
    { key: 'ai', setting: 'hideAiCapabilities', match: /^aicapabilities$/ },
    { key: 'builtin', setting: 'hideBuiltInTools', match: /^builtintools$/ }
  ];

  // An accordion item whose heading matched nothing. Marked all the same, so it
  // is not re-read on every pass, and so the debug log can say what it saw.
  var UNKNOWN = 'other';

  var settings = {};
  var observer = null;
  var scheduled = false;
  // Latched once Favourites has been opened, and cleared when the *panel* leaves
  // the DOM - so closing and reopening the panel opens it again, but going back
  // to the sections within one panel session does not.
  var expandOffered = false;
  // Config is re-pushed on any storage change, most of which have nothing to do
  // with this. Only the setting turning on unlatches the above; otherwise an
  // unrelated save would reopen a list the user had just navigated out of.
  var expandWasOn = false;

  function hidesAnything() {
    return SECTIONS.some(function (s) { return !!settings[s.setting]; });
  }

  function wanted() {
    return hidesAnything() || !!settings.expandFavourites;
  }

  function normalise(text) {
    return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function keyFor(heading) {
    for (var i = 0; i < SECTIONS.length; i++) {
      if (SECTIONS[i].match.test(heading)) return SECTIONS[i].key;
    }
    return UNKNOWN;
  }

  // !important, unlike the row tints in decorate.js. The item's own display comes
  // from a Griffel atomic class inserted at runtime, so it always lands after this
  // sheet and wins at equal specificity. There is nothing to lose here by shouting:
  // a hidden section has no hover state left to preserve.
  function css() {
    return SECTIONS.filter(function (s) {
      return !!settings[s.setting];
    }).map(function (s) {
      return '[' + MARKER + '="' + s.key + '"]{display:none !important}';
    }).join('');
  }

  function injectStyle() {
    var text = css();
    var style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    // Rewritten rather than recreated, so toggling a section lands without a reload.
    if (style.textContent !== text) style.textContent = text;
  }

  function removeStyle() {
    var style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  function clearMarks() {
    var marked = document.querySelectorAll('[' + MARKER + ']');
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(MARKER);
  }

  // The section's own "See all (9)" link, which opens the full list. It is a
  // sibling of the heading rather than a child of the collapsible panel, so it
  // can be clicked whether the section is expanded or not - and looking for it
  // beside the heading rather than anywhere in the item keeps a link inside a
  // connector row from being mistaken for it.
  function seeAllFor(item) {
    var row = item.querySelector(HEADER_ROW_SELECTOR);
    var wrapper = row && row.parentNode;
    if (!wrapper) return null;
    var kids = wrapper.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === row) continue;
      if (String(kids[i].className || '').split(/\s+/).indexOf(SEE_ALL_CLASS) !== -1) return kids[i];
    }
    return null;
  }

  // Opening is a click, because both the accordion's open state and the list view
  // live in React and there is nothing to set from out here.
  //
  // "See all" is the one to press: the section itself only ever shows the first
  // few favourites, so expanding it is not the same as seeing them all. The link
  // is absent when nothing is truncated, and then there is only the accordion to
  // open.
  //
  // Done at most once per panel, so a user who navigates back out of the full
  // list is not thrown straight back into it.
  function offerExpansion(item) {
    if (expandOffered) return;
    if (!settings.expandFavourites) return;
    if (settings.hideFavourites) return; // nothing to open; the section is gone
    var button = item.querySelector(HEADER_SELECTOR);
    if (!button) return; // header not rendered yet - try again on the next pass
    expandOffered = true;

    var seeAll = seeAllFor(item);
    if (seeAll) {
      log.debug('opening the full Favourites list');
      seeAll.click();
      return;
    }
    if (button.getAttribute('aria-expanded') === 'false') {
      log.debug('Favourites has no "see all" link - expanding the section instead');
      button.click();
    } else {
      log.debug('Favourites is open and nothing is truncated - leaving it alone');
    }
  }

  function scan() {
    scheduled = false; // cleared first, so no early return below can wedge it
    if (!wanted()) return;

    // Keyed on the panel, not on the accordion: clicking "See all" replaces the
    // sections with the full favourites list, so a latch cleared when the accordion
    // goes away would fire again the moment the user navigated back to it.
    if (!document.querySelector(PANEL_SELECTOR)) expandOffered = false;

    var items = document.querySelectorAll(ITEM_SELECTOR);
    var favourites = null;
    var found = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var key = item.getAttribute(MARKER);
      if (key === null) {
        var button = item.querySelector(HEADER_SELECTOR);
        if (!button) continue; // the header lands with the item, but not always first
        var heading = normalise(button.textContent);
        key = keyFor(heading);
        item.setAttribute(MARKER, key);
        found.push(key === UNKNOWN ? 'unrecognised heading ' + JSON.stringify(heading) : key);
      }
      if (key === 'favourites') favourites = item;
    }

    if (found.length) log.debug('panel sections seen:', found.join(', '));

    if (favourites) offerExpansion(favourites);
  }

  // Coalesce bursts of mutations into one pass. Deliberately a timer rather than
  // requestAnimationFrame, for the reason decorate.js gives: rAF does not fire
  // while the tab is not painting, and the pending flag would latch forever.
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, COALESCE_MS);
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
    removeStyle();
    clearMarks();
    expandOffered = false;
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'config') return;

    settings = msg.settings || {};
    var justTurnedOn = !!settings.expandFavourites && !expandWasOn;
    expandWasOn = !!settings.expandFavourites;

    var on = wanted();
    if (on !== !!observer) {
      log.debug('panel section handling', on ? 'on' : 'off');
      if (on) start(); else stop();
      return;
    }
    if (!on) return;
    injectStyle();
    // Turning auto-expand on with the panel already open should expand it now,
    // rather than on the next time the panel is opened.
    if (justTurnedOn) expandOffered = false;
    schedule();
  });
})();
