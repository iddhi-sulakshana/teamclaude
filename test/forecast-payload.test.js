import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForecast } from '../src/forecast-payload.js';
import { QuotaHistory } from '../src/quota-history.js';
import { ClientQuotaTracker } from '../src/quota-attribution.js';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const max = (name, quota = {}, extra = {}) => ({ name, type: 'oauth', accountUuid: 'u-' + name, rateLimitTier: 'default_claude_max_20x', quota, ...extra });
const pro = (name, quota = {}, extra = {}) => ({ name, type: 'oauth', accountUuid: 'u-' + name, rateLimitTier: 'default_claude_ai', quota, ...extra });

function build(accounts, { history = new QuotaHistory(), attribution = new ClientQuotaTracker({ now: () => NOW }), mode = 'off', threshold = 0.98 } = {}) {
  return buildForecast({ accounts, thresholdFor: () => threshold, mode, history, attribution, now: NOW });
}

// An hour-by-hour day of one account's weekly meter rising by 0.01 an hour.
function risingDay(account) {
  const history = new QuotaHistory();
  for (let i = 0; i <= 24; i++) {
    account.quota.unified7d = 0.01 * i;
    history.sample([account], NOW - (24 - i) * HOUR);
  }
  return history;
}

test('no Claude subscription: nothing to forecast, and the shape is complete', () => {
  const f = build([{ name: 'k', type: 'api_key', quota: {} }]);
  assert.equal(f.verdict, null);
  assert.equal(f.reason, 'no-capacity');
  assert.deepEqual(f.series, { past: [], projected: [] });
  assert.deepEqual(f.accounts, []);
  assert.equal(f.generatedAt, NOW);
});

test('disabled and unknown-tier accounts are named as not forecast', () => {
  const f = build([max('a', {}, { disabled: true }), { name: 'b', type: 'oauth', quota: {} }]);
  assert.deepEqual(f.notForecast, [{ name: 'a', reason: 'disabled' }, { name: 'b', reason: 'unknown tier' }]);
  assert.equal(f.reason, 'no-capacity');
});

test('an account with no weekly reading yet is no-quota', () => {
  const f = build([max('a')]);
  assert.equal(f.reason, 'no-quota');
  assert.equal(f.verdict, null);
});

test('without history the rate is the since-reset average, at low confidence', () => {
  const f = build([max('a', { unified7d: 0.5, unified7dReset: NOW + 84 * HOUR })]);
  assert.equal(f.confidence, 'low');
  assert.equal(f.burnRate, Math.round(20 * 0.5 / 84 * 1e6) / 1e6);
  assert.equal(f.pace, 1);
  assert.equal(f.verdict, 'overusing', 'the pool runs dry before the reset');
  assert.ok(f.poolDryAt > NOW + 80 * HOUR && f.poolDryAt < NOW + 81 * HOUR, String(f.poolDryAt - NOW));
  assert.equal(f.fleetCapacity, 20);
  assert.equal(f.threshold, 0.98);
  assert.deepEqual(f.series.past, []);
  assert.deepEqual(f.series.projected[0], [NOW, 0.5]);
  assert.equal(f.strategy, 'soonest-reset');
});

test('a day of history gives a high-confidence rate and the past curve', () => {
  const p = pro('p', { unified7dReset: NOW + 120 * HOUR });
  const f = build([p], { history: risingDay(p) });
  assert.equal(f.confidence, 'high');
  assert.equal(f.spanHours, 24);
  assert.equal(f.burnRate, 0.01);
  assert.equal(f.pace, 1.68);
  assert.equal(f.verdict, 'overusing');
  assert.equal(f.poolDryAt, NOW + 74 * HOUR);
  assert.equal(f.dryForMs, 46 * HOUR);
  assert.equal(f.series.past.length, 25);
  assert.deepEqual(f.series.past[0], [NOW - 24 * HOUR, 0]);
  assert.deepEqual(f.series.past.at(-1), [NOW, 0.24]);
});

test('users get their share, and when overusing what the pool does without them', () => {
  const p = pro('p', { unified7dReset: NOW + 120 * HOUR });
  const attribution = new ClientQuotaTracker({ now: () => NOW });
  attribution.record('alice', 0.20);
  attribution.record('bob', 0.04);
  const f = build([p], { history: risingDay(p), attribution });
  const [alice, bob] = f.users;
  assert.equal(alice.name, 'alice');
  assert.equal(alice.heavy, true);
  assert.equal(alice.fairShareX, 1.67);
  assert.ok('withoutThemDryAt' in alice);
  assert.equal(alice.withoutThemDryAt, null, 'without alice the pool lasts the week');
  assert.ok(bob.withoutThemDryAt > NOW + 88 * HOUR && bob.withoutThemDryAt < NOW + 89 * HOUR);
});

test('an on-pace fleet carries no counterfactual', () => {
  const p = pro('p', { unified7d: 0.9, unified7dReset: NOW + 2 * HOUR });
  const attribution = new ClientQuotaTracker({ now: () => NOW });
  attribution.record('alice', 0.1);
  const f = build([p], { attribution });
  assert.notEqual(f.verdict, 'overusing');
  assert.equal('withoutThemDryAt' in f.users[0], false);
});

test('model caps are forecast where reported, and the mode picks the drain order', () => {
  const f = build([max('a', { unified7d: 0.2, unified7dReset: NOW + 48 * HOUR, unified7dFable: 0.3, unified7dFableReset: NOW + 48 * HOUR })], { mode: 'adaptive' });
  assert.equal(f.strategy, 'least-remaining');
  assert.deepEqual(f.scoped.map(s => s.bucket), ['fable']);
  assert.ok(['overusing', 'underusing', 'on-pace'].includes(f.scoped[0].verdict));
});

test('a serving account\'s session slope gives when it hits', () => {
  const p = pro('p', { unified7d: 0.1, unified7dReset: NOW + 100 * HOUR, unified5hReset: NOW + 3 * HOUR });
  const history = new QuotaHistory();
  for (const [t, u] of [[NOW - HOUR, 0.2], [NOW - HOUR / 2, 0.3], [NOW, 0.4]]) {
    p.quota.unified5h = u;
    history.sample([p], t);
  }
  const f = build([p], { history });
  assert.ok(Math.abs(f.accounts[0].sessionHitsAt - (NOW + 10_440_000)) < 1000, String(f.accounts[0].sessionHitsAt - NOW));
});

test('two accounts with one name stay two rows', () => {
  const f = build([
    max('same@example.com', { unified7d: 0.1, unified7dReset: NOW + 50 * HOUR }, { accountUuid: 'u1' }),
    max('same@example.com', { unified7d: 0.7, unified7dReset: NOW + 90 * HOUR }, { accountUuid: 'u2' }),
  ]);
  assert.deepEqual(f.accounts.map(a => a.u), [0.1, 0.7]);
});

test('a weekly reading without a reset still forecasts', () => {
  const f = build([max('a', { unified7d: 0.3 })]);
  assert.equal(f.reason, null);
  assert.ok(f.series.projected.every(([t, v]) => Number.isFinite(t) && Number.isFinite(v)));
});
