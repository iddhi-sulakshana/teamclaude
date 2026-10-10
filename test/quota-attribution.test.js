import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_CLIENT, quotaMark, quotaCredit, ClientQuotaTracker } from '../src/quota-attribution.js';
import { USAGE_SLOT_MS } from '../src/client-usage.js';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);

test('quotaMark reads the shared weekly bucket, null when unreported', () => {
  assert.deepEqual(quotaMark({ quota: { unified7d: 0.4, unified7dReset: 99 } }), { u: 0.4, reset: 99 });
  assert.deepEqual(quotaMark({ quota: {} }), { u: null, reset: null });
  assert.deepEqual(quotaMark(null), { u: null, reset: null });
});

test('quotaCredit books the rise times the weight', () => {
  near(quotaCredit({ u: 0.10, reset: 5 * HOUR }, { u: 0.12, reset: 5 * HOUR }, 20), 0.4);
  assert.equal(quotaCredit({ u: 0.12, reset: 5 * HOUR }, { u: 0.12, reset: 5 * HOUR }, 20), 0, 'no rise, no credit');
  assert.equal(quotaCredit({ u: 0.12, reset: 5 * HOUR }, { u: 0.11, reset: 5 * HOUR }, 20), 0, 'never negative');
});

test('quotaCredit treats a reset that moved on as a new window, and jitter as the same one', () => {
  near(quotaCredit({ u: 0.9, reset: 5 * HOUR }, { u: 0.03, reset: 5 * HOUR + 168 * HOUR }, 5), 0.15);
  near(quotaCredit({ u: 0.10, reset: 5 * HOUR }, { u: 0.12, reset: 5 * HOUR + 30_000 }, 1), 0.02);
});

test('quotaCredit books nothing without a weight or a first reading', () => {
  assert.equal(quotaCredit({ u: null, reset: null }, { u: 0.2, reset: 1 }, 20), 0);
  assert.equal(quotaCredit({ u: 0.1, reset: 1 }, { u: 0.2, reset: 1 }, null), 0);
  assert.equal(quotaCredit({ u: 0.1, reset: 1 }, { u: 0.2, reset: 1 }, 0), 0);
});

test('the tracker sums a day per client and books a missing name to NO_CLIENT', () => {
  let now = NOW;
  const t = new ClientQuotaTracker({ now: () => now });
  t.record('alice', 0.4);
  t.record('alice', 0.1);
  t.record(null, 0.2);
  t.record('bob', 0);          // nothing to book
  t.record('carol', -1);       // nonsense, ignored
  assert.deepEqual(t.window(), { alice: 0.5, [NO_CLIENT]: 0.2 });
  now += 25 * HOUR;
  t.record('bob', 0.3);
  assert.deepEqual(t.window(), { bob: 0.3 }, 'a day later the old spend is gone');
});

test('the tracker round-trips through the state file and refuses bad rows', () => {
  const now = NOW;
  const a = new ClientQuotaTracker({ now: () => now });
  a.record('alice', 0.4);
  const saved = JSON.parse(JSON.stringify(a.exportState()));
  const slot = Math.floor(now / USAGE_SLOT_MS);
  saved.bob = [[slot, 0.1], [slot + 10, 9], 'junk', [slot - 1000, 5], [1.5, 1]];
  saved.carol = 'not-an-array';
  const b = new ClientQuotaTracker({ now: () => now });
  b.restore(saved);
  b.restore(null);
  assert.deepEqual(b.window(), { alice: 0.4, bob: 0.1 }, 'future, stale, fractional-slot and malformed rows are skipped');
});
