import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaHistory, isForecastAccount, accountKey, valueAt, HISTORY_RETAIN_MS } from '../src/quota-history.js';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);
const claude = (name, quota = {}, extra = {}) => ({ name, type: 'oauth', accountUuid: 'u-' + name, quota, ...extra });
const weights = map => key => map[key] ?? null;

test('isForecastAccount covers Claude subscriptions only', () => {
  assert.equal(isForecastAccount(claude('a')), true);
  assert.equal(isForecastAccount({ name: 'k', type: 'api_key' }), false);
  assert.equal(isForecastAccount(claude('d', {}, { upstream: 'https://api.deepseek.com' })), false);
  assert.equal(isForecastAccount(claude('x', {}, { provider: 'codex' })), false);
  assert.equal(isForecastAccount(null), false);
});

test('accountKey prefers the uuid pair, then the uuid, then the name', () => {
  assert.equal(accountKey({ name: 'a', accountUuid: 'u', orgUuid: 'o' }), 'u/o');
  assert.equal(accountKey({ name: 'a', accountUuid: 'u' }), 'u');
  assert.equal(accountKey({ name: 'a' }), 'name:a');
});

test('valueAt reads 0 for a window that is over, null for a bucket never reported', () => {
  assert.equal(valueAt({ t: 10, unified7d: 0.9, unified7dReset: 5 }, 'unified7d'), 0);
  assert.equal(valueAt({ t: 10, unified7d: 0.9, unified7dReset: 50 }, 'unified7d'), 0.9);
  assert.equal(valueAt({ t: 10, unified7d: 0.9, unified7dReset: 50 }, 'unified7d', 60), 0, 'at a later instant');
  assert.equal(valueAt({ t: 10 }, 'unified7d'), null);
});

test('sample keeps forecast accounts, drops removed ones and ages out old samples', () => {
  const h = new QuotaHistory();
  const a = claude('a', { unified7d: 0.1, unified7dReset: NOW + 100 * HOUR });
  const b = claude('b', { unified7d: 0.2 });
  h.sample([a, b, { name: 'k', type: 'api_key', quota: { unified7d: 0.5 } }], NOW);
  assert.deepEqual([...h.samples.keys()], ['u-a', 'u-b']);
  assert.deepEqual(h.samples.get('u-a'), [{ t: NOW, unified7d: 0.1, unified7dReset: NOW + 100 * HOUR }]);
  h.sample([a], NOW + HOUR);
  assert.deepEqual([...h.samples.keys()], ['u-a'], 'b left the fleet');
  h.sample([a], NOW + HISTORY_RETAIN_MS + 2 * HOUR);
  assert.equal(h.samples.get('u-a').length, 1, 'the first two samples aged out');
});

test('burned sums each account\'s rises inside the span, weighted', () => {
  const h = new QuotaHistory();
  const a = claude('a', { unified7d: 0.10, unified7dReset: NOW + 100 * HOUR });
  h.sample([a], NOW - 2 * HOUR);
  a.quota.unified7d = 0.12;
  h.sample([a], NOW - HOUR);
  a.quota.unified7d = 0.15;
  h.sample([a], NOW);
  near(h.burned('unified7d', NOW, 2 * HOUR, weights({ 'u-a': 20 })), 1.0);
  near(h.burned('unified7d', NOW, HOUR, weights({ 'u-a': 20 })), 0.6);
  assert.equal(h.burned('unified7d', NOW, 2 * HOUR, weights({})), 0, 'no weight, not counted');
});

test('burned counts a reset as spend from zero, and ignores jitter in the reset', () => {
  const h = new QuotaHistory();
  const a = claude('a', { unified7d: 0.90, unified7dReset: NOW });
  h.sample([a], NOW - HOUR);
  Object.assign(a.quota, { unified7d: 0.05, unified7dReset: NOW + 168 * HOUR });
  h.sample([a], NOW);
  near(h.burned('unified7d', NOW, 2 * HOUR, weights({ 'u-a': 1 })), 0.05);

  const j = new QuotaHistory();
  const b = claude('b', { unified7d: 0.10, unified7dReset: NOW + 50 * HOUR });
  j.sample([b], NOW - HOUR);
  Object.assign(b.quota, { unified7d: 0.12, unified7dReset: NOW + 50 * HOUR + 20_000 });
  j.sample([b], NOW);
  // Twenty seconds of jitter in the reset is the same window.
  near(j.burned('unified7d', NOW, 2 * HOUR, weights({ 'u-b': 1 })), 0.02);
});

test('coverage grades the history', () => {
  const h = new QuotaHistory();
  assert.deepEqual(h.coverage(NOW), { spanMs: 0, confidence: 'low' });
  h.sample([claude('a')], NOW - 7 * HOUR);
  assert.deepEqual(h.coverage(NOW), { spanMs: 7 * HOUR, confidence: 'medium' });
  const old = new QuotaHistory();
  old.sample([claude('a')], NOW - 30 * HOUR);
  assert.deepEqual(old.coverage(NOW), { spanMs: 24 * HOUR, confidence: 'high' });
});

test('pastSeries is the fleet used fraction at each sample time', () => {
  const h = new QuotaHistory();
  const a = claude('a', { unified7d: 0.5, unified7dReset: NOW + 50 * HOUR });
  const b = claude('b', { unified7d: 0.1, unified7dReset: NOW + 50 * HOUR });
  h.sample([a, b], NOW - HOUR);
  b.quota.unified7d = 0.3;
  h.sample([a, b], NOW);
  assert.deepEqual(h.pastSeries('unified7d', NOW, 24 * HOUR, weights({ 'u-a': 1, 'u-b': 3 }), 4), [
    [NOW - HOUR, 0.2],
    [NOW, 0.35],
  ]);
  assert.deepEqual(h.pastSeries('unified7d', NOW, 24 * HOUR, weights({}), 0), [], 'no capacity, no series');
});

test('recentSlope is the rise per ms inside one window', () => {
  const h = new QuotaHistory();
  const a = claude('a', { unified5h: 0.2, unified5hReset: NOW + 3 * HOUR });
  h.sample([a], NOW - HOUR);
  a.quota.unified5h = 0.3;
  h.sample([a], NOW - HOUR / 2);
  a.quota.unified5h = 0.4;
  h.sample([a], NOW);
  near(h.recentSlope('u-a', 'unified5h', NOW, HOUR), 0.2 / HOUR, 1e-15);
  assert.equal(h.recentSlope('u-a', 'unified5h', NOW, HOUR / 4), null, 'one sample is not a slope');
  assert.equal(h.recentSlope('nobody', 'unified5h', NOW, HOUR), null);
});

test('history round-trips through the state file and skips bad rows', () => {
  const h = new QuotaHistory();
  h.sample([claude('a', { unified7d: 0.1 })], NOW - HOUR);
  const saved = JSON.parse(JSON.stringify(h.exportState()));
  saved['u-a'].push('junk', { t: 'soon' }, { t: NOW + HOUR, unified7d: 1 }, { t: NOW - 3 * 24 * HOUR, unified7d: 1 }, { t: NOW - HOUR / 2, unified7d: 0.2, extra: 'dropped' });
  saved['u-b'] = 'not-a-list';
  const back = new QuotaHistory();
  back.restore(saved, NOW);
  back.restore(null, NOW);
  assert.deepEqual(back.samples.get('u-a'), [
    { t: NOW - HOUR, unified7d: 0.1 },
    { t: NOW - HOUR / 2, unified7d: 0.2 },
  ]);
  assert.equal(back.samples.has('u-b'), false);
});
