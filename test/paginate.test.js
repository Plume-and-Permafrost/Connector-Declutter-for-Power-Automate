'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cdpa } = require('./helpers.js');
const { paginate } = cdpa;

// Builds pages of `size` entries where the first `dropped` of each page are
// removed by the filter, mimicking a heavily DLP-filtered catalogue.
function pager(pages) {
  const fetched = [];
  return {
    fetched,
    fetchPage(url) {
      fetched.push(url);
      const page = pages[url];
      return Promise.resolve(page === undefined ? null : page);
    }
  };
}

const keepNotBlocked = (item) => !item.blocked;

test('a short page is topped up from nextLink until it looks full', async () => {
  const pages = {
    p1: { value: Array.from({ length: 30 }, (_, i) => ({ id: 'b' + i })), nextLink: 'p2' },
    p2: { value: Array.from({ length: 30 }, (_, i) => ({ id: 'c' + i })), nextLink: 'p3' }
  };
  const p = pager(pages);
  const payload = { value: [{ id: 'a1' }, { id: 'a2' }], nextLink: 'p1' };

  const out = await paginate.backfill(payload, keepNotBlocked, { target: 40, maxHops: 8, fetchPage: p.fetchPage });
  assert.strictEqual(out.value.length, 62);
  // Stops as soon as the target is met - p3 is never requested.
  assert.deepStrictEqual(p.fetched, ['p1', 'p2']);
  // Hands back the link *after* the last page consumed, so nothing repeats.
  assert.strictEqual(out.nextLink, 'p3');
});

test('backfill stops at the end of the catalogue', async () => {
  const p = pager({ p1: { value: [{ id: 'b' }], nextLink: null } });
  const out = await paginate.backfill({ value: [], nextLink: 'p1' }, keepNotBlocked, { target: 40, fetchPage: p.fetchPage });
  assert.strictEqual(out.value.length, 1);
  assert.strictEqual(out.nextLink, null);
});

test('backfill respects the hop limit when almost everything is filtered out', async () => {
  const pages = {};
  for (let i = 1; i <= 20; i++) {
    pages['p' + i] = { value: [{ id: 'x', blocked: true }], nextLink: 'p' + (i + 1) };
  }
  const p = pager(pages);
  const out = await paginate.backfill({ value: [], nextLink: 'p1' }, keepNotBlocked, {
    target: 40, maxHops: 3, fetchPage: p.fetchPage
  });
  assert.strictEqual(p.fetched.length, 3);
  assert.strictEqual(out.value.length, 0);
  // The designer can still carry on from here.
  assert.strictEqual(out.nextLink, 'p4');
});

test('an already-full page is returned without any extra request', async () => {
  const p = pager({});
  const payload = { value: Array.from({ length: 50 }, (_, i) => ({ id: i })), nextLink: 'p1' };
  const out = await paginate.backfill(payload, keepNotBlocked, { target: 40, fetchPage: p.fetchPage });
  assert.strictEqual(p.fetched.length, 0);
  assert.strictEqual(out.nextLink, 'p1');
});

test('a failed page leaves nextLink alone so the designer can retry it', async () => {
  const p = {
    fetchPage() { return Promise.reject(new Error('offline')); }
  };
  const out = await paginate.backfill({ value: [{ id: 'a' }], nextLink: 'p1' }, keepNotBlocked, {
    target: 40, fetchPage: p.fetchPage
  });
  assert.strictEqual(out.value.length, 1);
  assert.strictEqual(out.nextLink, 'p1');
});

test('a page that comes back unreadable is treated as a failure, not as empty', async () => {
  const p = pager({ p1: null });
  const out = await paginate.backfill({ value: [], nextLink: 'p1' }, keepNotBlocked, { target: 40, fetchPage: p.fetchPage });
  assert.strictEqual(out.nextLink, 'p1');
});
