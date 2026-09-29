'use strict';
// Observing and rewriting responses from page context.
//
// The designer fetches its connector catalogue over XMLHttpRequest, so hooking
// window.fetch alone would miss everything. Rather than reimplement XHR (and
// with it auth, cookies, CORS and retries), this keeps the real request and
// intercepts only the terminal events:
//
//   * a subclass installs listeners in its constructor, so nothing the page does
//     later can register ahead of us;
//   * terminal events are swallowed with stopImmediatePropagation while the
//     (possibly async) transform runs;
//   * responseText/response are shadowed with own properties, then the original
//     event sequence is replayed so the page sees an ordinary completed request.
//
// Anything unexpected falls through untouched - a broken transform must never
// take the page's own networking down with it.
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

__cdpa.httpHook = (function () {
  var log = __cdpa.log.create('http');

  var TERMINAL = ['readystatechange', 'load', 'loadend', 'error', 'abort', 'timeout'];
  var handlers = [];
  var installed = false;
  // Captured before we patch anything, so the extension's own requests bypass
  // its own hooks instead of recursing through them.
  var originalFetch = typeof window !== 'undefined' && window.fetch
    ? window.fetch.bind(window)
    : null;

  // { match(url, method) -> bool, transform({url, method, requestBody, text}) -> Promise<string|undefined>,
  //   observeRequest({url, method, headers}) }
  function register(handler) {
    handlers.push(handler);
    install();
  }

  function matching(url, method) {
    for (var i = 0; i < handlers.length; i++) {
      try {
        if (handlers[i].match && handlers[i].match(url, method)) return handlers[i];
      } catch (e) {
        log.warn('a matcher threw, treating the request as unmatched:', e.message);
      }
    }
    return null;
  }

  function notifyRequest(info) {
    for (var i = 0; i < handlers.length; i++) {
      try {
        if (handlers[i].observeRequest) handlers[i].observeRequest(info);
      } catch (e) {
        log.warn('an observer threw:', e.message);
      }
    }
  }

  function absolute(url) {
    try {
      return new URL(String(url), location.href).href;
    } catch (e) {
      return String(url);
    }
  }

  function runTransform(handler, ctx) {
    return Promise.resolve()
      .then(function () { return handler.transform ? handler.transform(ctx) : undefined; })
      .catch(function (err) {
        log.warn('transform threw for', ctx.method, ctx.url, '- passing the original through:',
          (err && err.message) || err);
        return undefined;
      });
  }

  // --- XMLHttpRequest -------------------------------------------------------

  function installXhr() {
    var Original = window.XMLHttpRequest;
    if (!Original) return;
    var STATE = new WeakMap();

    function onTerminal(event) {
      var xhr = this;
      var state = STATE.get(xhr);
      if (!state || state.replaying) return;
      // A replay that ran synchronously inside the real error/abort/timeout (or
      // an unreadable load) has already delivered a loadend; the real one that
      // follows it would be a second.
      if (event.type === 'loadend' && state.swallowLoadend) {
        state.swallowLoadend = false;
        event.stopImmediatePropagation();
        return;
      }
      if (!state.handler) return;
      if (event.type === 'readystatechange' && xhr.readyState !== 4) return;

      event.stopImmediatePropagation();

      if (event.type === 'readystatechange') {
        state.sawReadyState = true;
        return; // wait for the event that says how this finished
      }

      if (event.type !== 'load') {
        // Failed or cancelled: replay exactly what happened, untransformed.
        if (event.type !== 'loadend') {
          log.debug('xhr', state.method, state.url, 'ended as', event.type, '- not transforming');
          replay(xhr, state, event.type);
          state.swallowLoadend = true;
        }
        return;
      }

      var text = readBody(xhr);
      if (text === null) {
        log.debug('xhr', state.method, state.url, 'responseType', JSON.stringify(xhr.responseType),
          'cannot be rewritten - passing through');
        replay(xhr, state, 'load');
        state.swallowLoadend = true;
        return;
      }

      runTransform(state.handler, {
        url: state.url,
        method: state.method,
        requestBody: state.body,
        requestHeaders: state.headers,
        status: xhr.status,
        text: text
      }).then(function (out) {
        var rewrote = out !== undefined && out !== null;
        if (rewrote) shadowBody(xhr, out);
        log.debug('xhr', state.method, state.url, '->', xhr.status,
          rewrote ? 'rewritten (' + text.length + ' -> ' + out.length + ' bytes)' : 'unchanged');
        replay(xhr, state, 'load');
      });
    }

    function readBody(xhr) {
      try {
        if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText;
        if (xhr.responseType === 'json') return JSON.stringify(xhr.response);
        return null; // arraybuffer/blob/document - not ours to rewrite
      } catch (e) {
        return null;
      }
    }

    function shadowBody(xhr, text) {
      try {
        var type = xhr.responseType;
        Object.defineProperty(xhr, 'responseText', { configurable: true, get: function () { return text; } });
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          get: function () {
            if (type === 'json') {
              try { return JSON.parse(text); } catch (e) { return null; }
            }
            return text;
          }
        });
      } catch (e) {
        log.warn('could not shadow the response body - leaving the original:', e.message);
      }
    }

    function replay(xhr, state, finalType) {
      state.replaying = true;
      try {
        if (state.sawReadyState) xhr.dispatchEvent(new Event('readystatechange'));
        xhr.dispatchEvent(new ProgressEvent(finalType));
        xhr.dispatchEvent(new ProgressEvent('loadend'));
      } catch (e) {
        log.warn('replaying events failed:', e.message);
      }
      state.replaying = false;
      state.handler = null; // done with this request
    }

    function HookedXHR() {
      var xhr = Reflect.construct(Original, arguments, new.target || HookedXHR);
      STATE.set(xhr, { url: '', method: '', body: null, headers: {}, handler: null, sawReadyState: false,
        replaying: false, swallowLoadend: false });
      TERMINAL.forEach(function (type) { xhr.addEventListener(type, onTerminal, false); });
      return xhr;
    }

    HookedXHR.prototype = Original.prototype;
    ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (k, i) {
      HookedXHR[k] = i;
    });

    var open = Original.prototype.open;
    var send = Original.prototype.send;
    var setRequestHeader = Original.prototype.setRequestHeader;

    Original.prototype.open = function (method, url) {
      var state = STATE.get(this);
      if (state) {
        state.method = String(method || 'GET').toUpperCase();
        state.url = absolute(url);
        state.headers = {};
        state.sawReadyState = false;
        state.swallowLoadend = false;
        state.handler = null;
      }
      return open.apply(this, arguments);
    };

    Original.prototype.setRequestHeader = function (name, value) {
      var state = STATE.get(this);
      if (state) state.headers[String(name).toLowerCase()] = value;
      return setRequestHeader.apply(this, arguments);
    };

    Original.prototype.send = function (body) {
      var state = STATE.get(this);
      if (state) {
        state.body = body;
        state.handler = matching(state.url, state.method);
        if (state.handler) log.debug('xhr matched', state.method, state.url);
        notifyRequest({ url: state.url, method: state.method, headers: state.headers });
      }
      return send.apply(this, arguments);
    };

    window.XMLHttpRequest = HookedXHR;
  }

  // --- fetch ----------------------------------------------------------------

  function installFetch() {
    var original = window.fetch;
    if (typeof original !== 'function') return;

    window.fetch = function (input, init) {
      var url, method, headers = {};
      try {
        var isRequest = typeof Request !== 'undefined' && input instanceof Request;
        url = absolute(isRequest ? input.url : input);
        method = String((init && init.method) || (isRequest && input.method) || 'GET').toUpperCase();
        var source = (init && init.headers) || (isRequest && input.headers);
        if (source) {
          if (typeof source.forEach === 'function' && typeof Headers !== 'undefined' && source instanceof Headers) {
            source.forEach(function (v, k) { headers[String(k).toLowerCase()] = v; });
          } else if (Array.isArray(source)) {
            source.forEach(function (pair) { headers[String(pair[0]).toLowerCase()] = pair[1]; });
          } else if (typeof source === 'object') {
            Object.keys(source).forEach(function (k) { headers[k.toLowerCase()] = source[k]; });
          }
        }
        notifyRequest({ url: url, method: method, headers: headers });
      } catch (e) {
        return original.apply(this, arguments);
      }

      var handler = matching(url, method);
      var call = original.apply(this, arguments);
      if (!handler) return call;
      log.debug('fetch matched', method, url);

      return call.then(function (response) {
        if (!response || !response.ok) return response;
        return response.clone().text().then(function (text) {
          return runTransform(handler, {
            url: url,
            method: method,
            requestBody: init && init.body,
            requestHeaders: headers,
            status: response.status,
            text: text
          }).then(function (out) {
            if (out === undefined || out === null) {
              log.debug('fetch', method, url, '-> unchanged');
              return response;
            }
            log.debug('fetch', method, url, '-> rewritten (' + text.length + ' -> ' + out.length + ' bytes)');
            return new Response(out, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          });
        }).catch(function (err) {
          log.warn('could not rewrite fetch response for', url, '-', (err && err.message) || err);
          return response;
        });
      });
    };
  }

  function install() {
    if (installed) return;
    installed = true;
    try {
      installXhr();
    } catch (e) {
      log.error('could not hook XMLHttpRequest - responses will not be filtered:', e.message);
    }
    try {
      installFetch();
    } catch (e) {
      log.error('could not hook fetch:', e.message);
    }
    log.debug('hooks installed on', location.href);
  }

  return { register: register, originalFetch: originalFetch };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = __cdpa.httpHook;
