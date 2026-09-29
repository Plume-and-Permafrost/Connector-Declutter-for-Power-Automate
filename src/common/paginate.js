'use strict';
// Topping up a filtered page.
//
// The catalogue endpoints hand back 250 entries at a time, and DLP can remove
// nearly all of them - a page of 250 routinely filters down to single figures.
// The designer's infinite scroll only asks for the next page once the current
// one has been scrolled through, so a near-empty page reads as "that's all there
// is". Following nextLink far enough to hand back something that still looks
// like a page keeps the panel behaving normally.
//
// The nextLink returned is always the one *after* the last page consumed, so the
// designer carries on from where this stopped rather than repeating pages.
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

__cdpa.paginate = (function () {
  var log = __cdpa.log.create('paginate');

  var DEFAULT_TARGET = 40;
  var DEFAULT_MAX_HOPS = 8;

  // options: { target, maxHops, fetchPage(url) -> Promise<payload|null> }
  function backfill(payload, keep, options) {
    var target = options.target || DEFAULT_TARGET;
    var maxHops = options.maxHops || DEFAULT_MAX_HOPS;
    var hops = 0;

    function step() {
      if (!payload.nextLink || payload.value.length >= target || hops >= maxHops) {
        if (hops) {
          log.debug('backfill finished after', hops, 'hop(s) -', payload.value.length,
            'entries', payload.nextLink ? '(more available)' : '(catalogue exhausted)');
        }
        return Promise.resolve(payload);
      }
      hops++;
      var from = payload.nextLink;
      return Promise.resolve()
        .then(function () { return options.fetchPage(from); })
        .then(function (next) {
          if (!next || !Array.isArray(next.value)) {
            // Leave nextLink as it was so the designer can retry the page we
            // could not read.
            log.warn('backfill hop', hops, 'returned nothing readable - stopping,',
              'leaving nextLink for the designer to retry');
            return payload;
          }
          var kept = next.value.filter(keep);
          log.debug('backfill hop', hops, '-', next.value.length, 'fetched,', kept.length,
            'kept, running total', payload.value.length + kept.length, 'of', target);
          payload.value = payload.value.concat(kept);
          payload.nextLink = next.nextLink || null;
          return step();
        })
        .catch(function (err) {
          log.warn('backfill hop', hops, 'failed:', (err && err.message) || err);
          return payload;
        });
    }

    return step();
  }

  return { DEFAULT_TARGET: DEFAULT_TARGET, DEFAULT_MAX_HOPS: DEFAULT_MAX_HOPS, backfill: backfill };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.paginate;
