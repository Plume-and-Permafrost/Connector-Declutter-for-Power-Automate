'use strict';
// A DOM small enough to read and large enough for decorate.js. Only the handful of
// selector forms that file actually uses are supported - anything else throws
// rather than quietly returning nothing, so a new selector cannot pass untested.

function El(tagName) {
  this.tagName = tagName || 'div';
  this.attrs = {};
  this.children = [];
  this.parentNode = null;
  this.id = '';
  this.className = '';
  this.ownText = '';
  this.style = {};
  this.listeners = {};
  // Overridable per element; decorate.js positions the tooltip from these.
  this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  this.popoverOpen = false;
}

El.prototype.addEventListener = function (type, fn) {
  (this.listeners[type] || (this.listeners[type] = [])).push(fn);
};
El.prototype.dispatch = function (type) {
  (this.listeners[type] || []).forEach(function (fn) { fn({ type: type }); });
};
El.prototype.getBoundingClientRect = function () { return this.rect; };
El.prototype.click = function () { this.dispatch('click'); };

// Real textContent is the concatenation of everything underneath, which is how
// sections.js reads an accordion heading - the label sits in a span beside the
// expand icon, not on the button itself. Assigning it replaces the children,
// which is how decorate.js empties a node.
Object.defineProperty(El.prototype, 'textContent', {
  get: function () {
    return this.children.reduce(function (acc, c) { return acc + c.textContent; }, this.ownText);
  },
  set: function (value) {
    this.children.forEach(function (c) { c.parentNode = null; });
    this.children.length = 0;
    this.ownText = value == null ? '' : String(value);
  }
});

// The popover API, to the extent decorate.js uses it: showing an open popover and
// hiding a closed one both throw, which is why the calls there are wrapped.
El.prototype.showPopover = function () {
  if (this.popoverOpen) throw new Error('popover already open');
  this.popoverOpen = true;
};
El.prototype.hidePopover = function () {
  if (!this.popoverOpen) throw new Error('popover not open');
  this.popoverOpen = false;
};

El.prototype.getAttribute = function (k) { return k in this.attrs ? this.attrs[k] : null; };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.hasAttribute = function (k) { return k in this.attrs; };
El.prototype.removeAttribute = function (k) { delete this.attrs[k]; };

El.prototype.appendChild = function (child) {
  if (child.parentNode) child.parentNode.removeChild(child);
  child.parentNode = this;
  this.children.push(child);
  return child;
};

El.prototype.insertBefore = function (child, ref) {
  if (child.parentNode) child.parentNode.removeChild(child);
  var at = this.children.indexOf(ref);
  child.parentNode = this;
  this.children.splice(at === -1 ? this.children.length : at, 0, child);
  return child;
};

El.prototype.removeChild = function (child) {
  var at = this.children.indexOf(child);
  if (at !== -1) this.children.splice(at, 1);
  child.parentNode = null;
  return child;
};

function matches(el, selector) {
  var m = /^\.([A-Za-z][\w-]*)$/.exec(selector);
  if (m) return String(el.className || '').split(/\s+/).indexOf(m[1]) !== -1;
  m = /^\[([a-z-]+)\^="(.*)"\]$/.exec(selector);
  if (m) { var v = el.getAttribute(m[1]); return v !== null && v.indexOf(m[2]) === 0; }
  m = /^\[([a-z-]+)="(.*)"\]$/.exec(selector);
  if (m) return el.getAttribute(m[1]) === m[2];
  m = /^\[([a-z-]+)\]$/.exec(selector);
  if (m) return el.hasAttribute(m[1]);
  throw new Error('dom-shim cannot match selector: ' + selector);
}

function descendants(root, out) {
  out = out || [];
  root.children.forEach(function (c) { out.push(c); descendants(c, out); });
  return out;
}

El.prototype.querySelectorAll = function (sel) {
  return descendants(this).filter(function (el) { return matches(el, sel); });
};
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };

// Builds the sandbox decorate.js expects, plus handles onto the bits tests poke at.
function makeDocument() {
  var root = new El('html');
  var head = new El('head');
  var body = new El('body');
  root.appendChild(head);
  root.appendChild(body);

  root.clientWidth = 1280;
  var document = {
    head: head,
    body: body,
    documentElement: root,
    createElement: function (tag) { return new El(tag); },
    getElementById: function (id) {
      return descendants(root).find(function (el) { return el.id === id; }) || null;
    },
    querySelectorAll: function (sel) { return root.querySelectorAll(sel); },
    querySelector: function (sel) { return root.querySelector(sel); }
  };
  return { document: document, root: root, head: head, body: body };
}

module.exports = { El, makeDocument, matches, descendants };
