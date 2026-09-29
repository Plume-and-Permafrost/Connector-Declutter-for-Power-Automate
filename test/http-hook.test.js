'use strict';
// http-hook.js holds an XHR's terminal events while a transform runs and then
// replays them. What is pinned here is what the page sees: each event exactly
// once, in order, carrying the rewritten body when there is one.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeProgressEvent extends Event {}

// Just enough of XMLHttpRequest: the state the hook reads, and a way for the test
// to play the browser's part by firing the terminal events itself.
class FakeXHR extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.status = 0;
    this.responseType = '';
    this.responseText = '';
  }
  open() { this.readyState = 1; }
  send() {}
  setRequestHeader() {}
  finish(kind, text) {
    this.readyState = 4;
    if (kind === 'load') { this.status = 200; this.responseText = text || ''; }
    this.dispatchEvent(new Event('readystatechange'));
    this.dispatchEvent(new FakeProgressEvent(kind));
    this.dispatchEvent(new FakeProgressEvent('loadend'));
  }
}

function load(transform) {
  const sandbox = {
    console, Promise, setTimeout, clearTimeout, WeakMap, Reflect, URL,
    Event, ProgressEvent: FakeProgressEvent,
    location: { href: 'https://make.powerautomate.com/' }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.XMLHttpRequest = FakeXHR;
  vm.createContext(sandbox);
  for (const f of ['src/common/log.js', 'src/common/http-hook.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }
  sandbox.__cdpa.httpHook.register({ match: () => true, transform });
  return sandbox;
}

function watch(xhr) {
  const seen = [];
  for (const t of ['readystatechange', 'load', 'error', 'abort', 'timeout', 'loadend']) {
    xhr.addEventListener(t, () => seen.push(t));
  }
  return seen;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('a transformed load reaches the page once, rewritten', async () => {
  const sandbox = load(() => 'rewritten');
  const xhr = new sandbox.XMLHttpRequest();
  const seen = watch(xhr);
  xhr.open('GET', 'https://example.test/x');
  xhr.send();
  xhr.finish('load', 'original');
  await settle();
  assert.deepStrictEqual(seen, ['readystatechange', 'load', 'loadend']);
  assert.strictEqual(xhr.responseText, 'rewritten');
});

for (const kind of ['abort', 'error', 'timeout']) {
  test('an ' + kind + ' reaches the page with one loadend, not two', async () => {
    const sandbox = load(() => 'never used');
    const xhr = new sandbox.XMLHttpRequest();
    const seen = watch(xhr);
    xhr.open('GET', 'https://example.test/x');
    xhr.send();
    xhr.finish(kind);
    await settle();
    assert.deepStrictEqual(seen, ['readystatechange', kind, 'loadend']);
  });
}

test('an unreadable response type passes through with one loadend', async () => {
  const sandbox = load(() => 'never used');
  const xhr = new sandbox.XMLHttpRequest();
  const seen = watch(xhr);
  xhr.responseType = 'blob';
  xhr.open('GET', 'https://example.test/x');
  xhr.send();
  xhr.finish('load');
  await settle();
  assert.deepStrictEqual(seen, ['readystatechange', 'load', 'loadend']);
});

test('a reused request starts clean', async () => {
  const sandbox = load(() => undefined);
  const xhr = new sandbox.XMLHttpRequest();
  const seen = watch(xhr);
  xhr.open('GET', 'https://example.test/x');
  xhr.send();
  xhr.finish('abort');
  xhr.open('GET', 'https://example.test/y');
  xhr.send();
  xhr.finish('load', 'ok');
  await settle();
  assert.deepStrictEqual(seen, ['readystatechange', 'abort', 'loadend',
    'readystatechange', 'load', 'loadend']);
});
