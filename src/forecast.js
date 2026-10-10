// The usage forecast's arithmetic.
//
// Everything here is a pure function of its arguments — no clock, no account
// manager, no I/O — so the server and the tests drive it the same way. In: the
// fleet as it stands (each account's weight, utilization, reset and threshold)
// and how fast the fleet is spending. Out: when the pool runs dry, how much of
// each weekly window resets unused, and a curve for the chart.
//
// The unit throughout is the Pro-week: one Claude Pro account's whole weekly
// bucket. A Max 20x account's bucket is 20 of them, so percentages on different
// accounts add up once each is multiplied by its tier weight (quotaTier in
// quota-summary.js).

import { NO_CLIENT } from './quota-attribution.js';

export const HOUR_MS = 3600_000;
export const WEEK_MS = 7 * 24 * HOUR_MS;
/** The simulation's step: the history's sampling interval. */
export const STEP_MS = 15 * 60_000;
/** Projected unused capacity, % of one week, above which the fleet is underusing. */
export const UNDERUSE_PCT = 30;
/** A client spending more than this multiple of an even split is heavy. */
export const HEAVY_X = 1.5;

const EPS = 1e-9;

/**
 * @typedef {'soonest-reset'|'least-remaining'|'proportional'} Strategy
 */

/**
 * One account as the simulation sees one bucket.
 * @typedef {object} SimAccount
 * @property {string} name
 * @property {number} weight      tier weight: Pro-weeks per week
 * @property {number} priority    rotation preference, lower first
 * @property {number} u           utilization now, 0–1
 * @property {number|null} reset  when the window refills (ms); null when never seen
 * @property {number} threshold   the auto-switch threshold for this bucket, 0–1
 */

/**
 * An account mid-simulation.
 * @typedef {object} Live
 * @property {number} index
 * @property {string} name
 * @property {number} weight
 * @property {number} priority
 * @property {number} threshold
 * @property {number} u
 * @property {number} reset
 * @property {number} firstReset
 * @property {boolean} refilled
 * @property {number|null} drainsAt
 * @property {number|null} unusedAtReset
 */

/**
 * @typedef {object} SimResult
 * @property {number} capacity             Pro-weeks per week across the accounts simulated
 * @property {number|null} poolDryAt       first instant no account has room, or null
 * @property {number|null} dryForMs        how long that lasts, until the next refill
 * @property {number} unusedPct            capacity left at the resets, % of one week
 * @property {Array<[number, number]>} projected  fleet used fraction over time; a reset is a vertical drop
 * @property {Array<{ index: number, name: string, reset: number, drainsAt: number|null, unusedAtReset: number|null }>} accounts
 */

/** @param {number} v @param {number} [digits] */
export function round(v, digits = 4) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** @param {number} v */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Code-unit order, the same on every machine (localeCompare follows the
 * process locale, and a tie-break must not).
 * @param {string} x
 * @param {string} y
 */
function byName(x, y) {
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The drain order the router follows under a distributeSessions mode.
 * @param {string} mode  AccountManager.distributionMode: 'off' | 'even' | 'adaptive'
 * @returns {Strategy}
 */
export function strategyFor(mode) {
  if (mode === 'adaptive') return 'least-remaining';
  if (mode === 'even') return 'proportional';
  return 'soonest-reset';
}

/**
 * How fast the fleet spends against what it is given: 1 is exactly one week's
 * capacity per week.
 * @param {number} burnRate  Pro-weeks per hour
 * @param {number} capacity  Pro-weeks per week
 */
export function paceOf(burnRate, capacity) {
  return capacity > 0 ? round(burnRate * (WEEK_MS / HOUR_MS) / capacity, 3) : 0;
}

/**
 * The fallback burn rate when there is too little history: each account's
 * spend since its window opened, averaged over the time it has been open.
 * Rotation makes this rough — an account spent on Monday and idle since still
 * averages Monday's rate — which is why it is reported as low confidence.
 * @param {SimAccount[]} accounts
 * @param {number} now
 * @returns {number} Pro-weeks per hour
 */
export function sinceResetRate(accounts, now) {
  let rate = 0;
  for (const a of accounts) {
    if (a.reset == null || a.reset <= now || !(a.u > 0)) continue;
    const open = Math.max(HOUR_MS, now - (a.reset - WEEK_MS));
    rate += a.weight * clamp01(a.u) / (open / HOUR_MS);
  }
  return rate;
}

/**
 * Run the fleet forward at `burnRate` until every account has refilled once
 * (a week at most), draining accounts the way the router would.
 *
 * Each step's burn goes to the best priority tier first, ordered by the
 * strategy; what one account cannot absorb carries to the next in the same
 * step. An account refills at its reset, and what it had left below its
 * threshold then is unused — capacity paid for and never spent. When no
 * account has room the pool is dry until the next refill.
 *
 * @param {object} opts
 * @param {SimAccount[]} opts.accounts
 * @param {number} opts.burnRate  Pro-weeks per hour
 * @param {Strategy} opts.strategy
 * @param {number} opts.now
 * @param {number} [opts.stepMs]
 * @returns {SimResult}
 */
export function simulate({ accounts, burnRate, strategy, now, stepMs = STEP_MS }) {
  /** @type {Live[]} */
  const live = accounts
    .map((a, index) => {
      let reset = a.reset == null ? now + WEEK_MS : a.reset;
      let u = clamp01(a.u || 0);
      // A window that has already turned over is empty, whatever the last
      // reading said; it refills again a whole number of weeks on.
      if (reset <= now) {
        reset += (Math.floor((now - reset) / WEEK_MS) + 1) * WEEK_MS;
        u = 0;
      }
      return {
        index, name: a.name, weight: a.weight, priority: a.priority || 0, threshold: a.threshold,
        u, reset, firstReset: reset, refilled: false,
        drainsAt: u >= a.threshold - EPS ? now : null,
        unusedAtReset: /** @type {number|null} */ (null),
      };
    })
    .filter(a => a.weight > 0);
  const capacity = live.reduce((sum, a) => sum + a.weight, 0);
  /** @type {SimResult} */
  const result = { capacity, poolDryAt: null, dryForMs: null, unusedPct: 0, projected: [], accounts: [] };
  if (!live.length) return result;

  const used = () => round(live.reduce((sum, a) => sum + a.weight * a.u, 0) / capacity);
  // A week at most: every weekly window turns over within one, and a reset
  // reported further out would otherwise stretch the run, and the curve it
  // returns, without bound.
  const horizon = Math.min(now + WEEK_MS, Math.max(...live.map(a => a.reset)));
  let unused = 0;
  /** @param {number} at */
  const refill = at => {
    let any = false;
    for (const a of live) {
      if (a.refilled || a.reset > at) continue;
      a.unusedAtReset = round(Math.max(0, a.threshold - a.u));
      unused += a.weight * a.unusedAtReset;
      // A dry spell ends at the first refill after it began.
      if (result.poolDryAt != null && result.dryForMs == null) result.dryForMs = a.reset - result.poolDryAt;
      a.u = 0;
      // The new window resets a week on, which is what puts a refilled account
      // at the back of a soonest-reset queue.
      a.reset += WEEK_MS;
      a.refilled = true;
      any = true;
    }
    if (any) result.projected.push([at, used()]);
  };

  result.projected.push([now, used()]);
  let t = now;
  while (t < horizon) {
    refill(t);
    const next = Math.min(t + stepMs, horizon);
    const want = burnRate * (next - t) / HOUR_MS;
    const left = drain(live, want, strategy);
    for (const a of live) if (a.drainsAt == null && a.u >= a.threshold - EPS) a.drainsAt = next;
    if (left > EPS && result.poolDryAt == null) result.poolDryAt = Math.round(t + (1 - left / want) * (next - t));
    result.projected.push([next, used()]);
    t = next;
  }
  refill(horizon);

  result.unusedPct = round(unused / capacity * 100, 1);
  result.accounts = live.map(a => ({ index: a.index, name: a.name, reset: a.firstReset, drainsAt: a.drainsAt, unusedAtReset: a.unusedAtReset }));
  return result;
}

/**
 * Spend `burn` Pro-weeks across the accounts with room, best priority tier
 * first; returns what nothing could absorb.
 * @param {Live[]} live
 * @param {number} burn
 * @param {Strategy} strategy
 */
function drain(live, burn, strategy) {
  const open = live.filter(a => a.u < a.threshold - EPS);
  const tiers = [...new Set(open.map(a => a.priority))].sort((x, y) => x - y);
  for (const priority of tiers) {
    if (burn <= EPS) break;
    const tier = open.filter(a => a.priority === priority);
    if (strategy === 'proportional') {
      burn = fillEvenly(tier, burn);
      continue;
    }
    tier.sort(strategy === 'least-remaining'
      ? (x, y) => (x.threshold - x.u) - (y.threshold - y.u) || x.reset - y.reset || byName(x.name, y.name)
      : (x, y) => x.reset - y.reset || byName(x.name, y.name));
    for (const a of tier) {
      if (burn <= EPS) break;
      const take = Math.min(burn, a.weight * (a.threshold - a.u));
      a.u += take / a.weight;
      burn -= take;
    }
  }
  return Math.max(0, burn);
}

/**
 * Spread `burn` over a tier in proportion to weight — every account's bucket
 * rises by the same fraction — topping up the rest as each one fills.
 * @param {Live[]} tier
 * @param {number} burn
 */
function fillEvenly(tier, burn) {
  let open = tier.filter(a => a.u < a.threshold - EPS);
  while (burn > EPS && open.length) {
    const weight = open.reduce((sum, a) => sum + a.weight, 0);
    const rise = Math.min(burn / weight, ...open.map(a => a.threshold - a.u));
    for (const a of open) a.u += rise;
    burn -= rise * weight;
    open = open.filter(a => a.u < a.threshold - EPS);
  }
  return burn;
}

/**
 * @param {{ poolDryAt: number|null, pace: number, unusedPct: number }} f
 * @returns {'overusing'|'underusing'|'on-pace'}
 */
export function verdictOf({ poolDryAt, pace, unusedPct }) {
  if (poolDryAt != null || pace > 1) return 'overusing';
  if (unusedPct > UNDERUSE_PCT) return 'underusing';
  return 'on-pace';
}

/**
 * Each client's share of the fleet's recent spend, busiest first.
 * `fairShareX` compares a client with an even split among the clients that
 * spent anything. Spend booked without a client key is shown, but neither
 * counted in that split nor called heavy: it is nobody in particular.
 * @param {Record<string, number>} spend  Pro-weeks per client
 * @returns {Array<{ name: string, spent: number, share: number, fairShareX: number|null, heavy: boolean }>}
 */
export function userShares(spend) {
  const rows = Object.entries(spend || {}).filter(([, v]) => v > 0);
  const total = rows.reduce((sum, [, v]) => sum + v, 0);
  const named = rows.filter(([name]) => name !== NO_CLIENT).length;
  return rows
    .map(([name, spent]) => {
      const share = total > 0 ? spent / total : 0;
      const fairShareX = name === NO_CLIENT || !named ? null : round(share * named, 2);
      return { name, spent: round(spent, 6), share: round(share, 4), fairShareX, heavy: fairShareX != null && named > 1 && fairShareX > HEAVY_X };
    })
    .sort((x, y) => y.spent - x.spent || byName(x.name, y.name));
}
