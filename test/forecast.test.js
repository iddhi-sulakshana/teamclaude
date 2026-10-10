import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUR_MS, WEEK_MS, strategyFor, paceOf, sinceResetRate, simulate, verdictOf, userShares,
} from '../src/forecast.js';
import { NO_CLIENT } from '../src/quota-attribution.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const DAY = 24 * HOUR_MS;
const acct = (name, extra = {}) => ({ name, weight: 1, priority: 0, u: 0, reset: NOW + 3 * DAY, threshold: 1, ...extra });

test('strategyFor follows the distributeSessions mode', () => {
  assert.equal(strategyFor('off'), 'soonest-reset');
  assert.equal(strategyFor('adaptive'), 'least-remaining');
  assert.equal(strategyFor('even'), 'proportional');
});

test('paceOf is weekly spend over weekly capacity', () => {
  assert.equal(paceOf(20 / 168, 20), 1);
  assert.equal(paceOf(1, 168), 1);
  assert.equal(paceOf(0.5, 0), 0, 'no capacity, no pace');
});

test('sinceResetRate averages each window over the time it has been open', () => {
  const rate = sinceResetRate([
    acct('a', { weight: 20, u: 0.5, reset: NOW + 3.5 * DAY }),   // opened 84h ago
    acct('b', { weight: 5, u: 0.9, reset: NOW - HOUR_MS }),        // window over: ignored
    acct('c', { weight: 5, u: 0.4, reset: null }),                 // never seen a reset: ignored
  ], NOW);
  assert.ok(Math.abs(rate - 20 * 0.5 / 84) < 1e-12);
});

test('an idle fleet resets with its headroom unused', () => {
  const sim = simulate({ accounts: [acct('a', { weight: 20, u: 0.4, reset: NOW + 2 * DAY, threshold: 0.98 })], burnRate: 0, strategy: 'soonest-reset', now: NOW });
  assert.equal(sim.capacity, 20);
  assert.equal(sim.poolDryAt, null);
  assert.equal(sim.unusedPct, 58);
  assert.deepEqual(sim.accounts, [{ index: 0, name: 'a', reset: NOW + 2 * DAY, drainsAt: null, unusedAtReset: 0.58 }]);
  assert.deepEqual(sim.projected[0], [NOW, 0.4]);
  assert.deepEqual(sim.projected.at(-2), [NOW + 2 * DAY, 0.4], 'flat until the reset');
  assert.deepEqual(sim.projected.at(-1), [NOW + 2 * DAY, 0], 'then a vertical drop');
});

test('a fast burn runs the pool dry and says for how long', () => {
  const sim = simulate({ accounts: [acct('a', { u: 0.5, reset: NOW + 4 * DAY })], burnRate: 0.5 / 24, strategy: 'soonest-reset', now: NOW });
  assert.equal(sim.poolDryAt, NOW + DAY);
  assert.equal(sim.dryForMs, 3 * DAY);
  assert.equal(sim.accounts[0].drainsAt, NOW + DAY);
  assert.equal(sim.unusedPct, 0);
  assert.equal(paceOf(0.5 / 24, sim.capacity), 3.5);
});

test('soonest-reset and least-remaining drain in different orders', () => {
  const accounts = [
    acct('a', { u: 0.6, reset: NOW + 3 * DAY }),
    acct('b', { u: 0.2, reset: NOW + 2 * DAY }),
  ];
  const opts = { accounts, burnRate: 0.1 / 24, now: NOW };
  const soonest = simulate({ ...opts, strategy: 'soonest-reset' });
  assert.deepEqual(soonest.accounts.map(a => a.unusedAtReset), [0.3, 0.6], 'b first, then a after b refills');
  const least = simulate({ ...opts, strategy: 'least-remaining' });
  assert.deepEqual(least.accounts.map(a => a.unusedAtReset), [0.1, 0.8], 'a has least left, so a takes it all');
});

test('proportional spreads by weight and tops up the rest as one fills', () => {
  const sim = simulate({
    accounts: [acct('a', { weight: 1, u: 0.5, reset: NOW + 7 * DAY }), acct('b', { weight: 3, u: 0, reset: NOW + 7 * DAY })],
    burnRate: 1 / 24, strategy: 'proportional', now: NOW,
  });
  assert.equal(sim.accounts[0].drainsAt, NOW + 2 * DAY);
  assert.equal(sim.accounts[1].drainsAt, NOW + 84 * HOUR_MS);
  assert.equal(sim.poolDryAt, NOW + 84 * HOUR_MS);
});

test('the best priority tier drains first, burn carries over, and a refill ends the dry spell', () => {
  const sim = simulate({
    accounts: [acct('a', { priority: 0, reset: NOW + 5 * DAY }), acct('b', { priority: 1, reset: NOW + DAY })],
    burnRate: 1 / 24, strategy: 'soonest-reset', now: NOW,
  });
  assert.equal(sim.accounts[0].drainsAt, NOW + DAY, 'a goes first despite resetting later');
  assert.equal(sim.accounts[1].unusedAtReset, 1, 'b refilled at 24h without being touched');
  assert.equal(sim.accounts[1].drainsAt, NOW + 2 * DAY, 'then b took the burn');
  assert.equal(sim.poolDryAt, NOW + 2 * DAY);
  assert.equal(sim.dryForMs, 3 * DAY, 'until a refills on day five');
  assert.equal(sim.unusedPct, 50);
});

test('a reset never seen or already passed is handled, not NaN', () => {
  const sim = simulate({
    accounts: [acct('fresh', { u: 0.3, reset: null }), acct('stale', { u: 0.9, reset: NOW - HOUR_MS })],
    burnRate: 0, strategy: 'soonest-reset', now: NOW,
  });
  assert.equal(sim.accounts[0].reset, NOW + WEEK_MS, 'never seen: refills a week from now');
  assert.equal(sim.accounts[1].reset, NOW + WEEK_MS - HOUR_MS, 'passed: rolled forward a week');
  assert.deepEqual(sim.projected[0], [NOW, 0.15], 'the passed window counts as empty');
  assert.ok(sim.projected.every(([t, v]) => Number.isFinite(t) && Number.isFinite(v)));
});

test('an empty fleet simulates to nothing', () => {
  const sim = simulate({ accounts: [], burnRate: 1, strategy: 'soonest-reset', now: NOW });
  assert.deepEqual(sim, { capacity: 0, poolDryAt: null, dryForMs: null, unusedPct: 0, projected: [], accounts: [] });
});

test('verdictOf: dry or above 1.0 is overusing, more than 30% unused is underusing', () => {
  assert.equal(verdictOf({ poolDryAt: null, pace: 1, unusedPct: 30 }), 'on-pace');
  assert.equal(verdictOf({ poolDryAt: null, pace: 1.001, unusedPct: 0 }), 'overusing');
  assert.equal(verdictOf({ poolDryAt: NOW, pace: 0.5, unusedPct: 50 }), 'overusing');
  assert.equal(verdictOf({ poolDryAt: null, pace: 0.5, unusedPct: 30.1 }), 'underusing');
  assert.equal(verdictOf({ poolDryAt: null, pace: 0, unusedPct: 90 }), 'underusing', 'an idle fleet');
});

test('userShares ranks spend, compares with an even split, and leaves NO_CLIENT out of it', () => {
  assert.deepEqual(userShares({ alice: 3, bob: 1, [NO_CLIENT]: 1, idle: 0 }), [
    { name: 'alice', spent: 3, share: 0.6, fairShareX: 1.2, heavy: false },
    { name: NO_CLIENT, spent: 1, share: 0.2, fairShareX: null, heavy: false },
    { name: 'bob', spent: 1, share: 0.2, fairShareX: 0.4, heavy: false },
  ]);
  const heavy = userShares({ alice: 8, bob: 1, carol: 1 });
  assert.equal(heavy[0].fairShareX, 2.4);
  assert.equal(heavy[0].heavy, true);
  assert.deepEqual(userShares({ alice: 2 }), [{ name: 'alice', spent: 2, share: 1, fairShareX: 1, heavy: false }], 'alone is never heavy');
  assert.deepEqual(userShares({}), []);
});

test('the projection stops at a week even when a reset claims to be later', () => {
  const sim = simulate({ accounts: [acct('far', { u: 0.2, reset: NOW + 30 * DAY })], burnRate: 0, strategy: 'soonest-reset', now: NOW });
  assert.equal(sim.projected.at(-1)[0], NOW + WEEK_MS, 'a week of projection, not a month');
  assert.equal(sim.projected.length, 7 * 96 + 1);
  assert.equal(sim.accounts[0].unusedAtReset, null, 'its reset is past the horizon');
});
