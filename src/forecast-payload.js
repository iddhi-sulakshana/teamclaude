// The forecast the dashboard reads (GET /teamclaude/forecast), assembled from
// the live fleet, the quota history and the per-client spend. The arithmetic is
// forecast.js; this file decides which accounts count and with what weight and
// threshold, which burn rate to trust, and the payload's shape.

import { quotaTier } from './quota-summary.js';
import { accountKey, isForecastAccount, RATE_SPAN_MS } from './quota-history.js';
import { simulate, paceOf, verdictOf, strategyFor, sinceResetRate, userShares, round, HOUR_MS } from './forecast.js';
import { NO_CLIENT } from './quota-attribution.js';

/** How far back an account's session slope is read. */
const SESSION_SLOPE_SPAN_MS = HOUR_MS;

/** The model-scoped weekly caps forecast beside the shared one, by quota field. */
const SCOPED = [{ field: 'unified7dFable', bucket: 'fable' }, { field: 'unified7dSonnet', bucket: 'sonnet' }];

/**
 * @typedef {import('./quota-history.js').QuotaHistory} QuotaHistory
 * @typedef {import('./quota-attribution.js').ClientQuotaTracker} ClientQuotaTracker
 * @typedef {import('./forecast.js').SimAccount} SimAccount
 * @typedef {(bucket: string, account: Record<string, any>) => number} ThresholdFor
 */

/**
 * @typedef {object} ForecastAccount
 * @property {string} name
 * @property {number} weight
 * @property {number} u
 * @property {number|null} reset
 * @property {number|null} drainsAt
 * @property {number|null} unusedAtReset
 * @property {number|null} sessionHitsAt
 */

/**
 * @typedef {object} ForecastUser
 * @property {string} name
 * @property {number} spent
 * @property {number} share
 * @property {number|null} fairShareX
 * @property {boolean} heavy
 * @property {number|null} [withoutThemDryAt]  present only when the pool runs dry; null = would not without them
 */

/**
 * @typedef {object} ForecastScoped
 * @property {string} bucket
 * @property {'overusing'|'underusing'|'on-pace'} verdict
 * @property {number} pace
 * @property {number|null} poolDryAt
 * @property {number} unusedPct
 */

/**
 * @typedef {object} ForecastPayload
 * @property {number} generatedAt
 * @property {string} bucket
 * @property {'high'|'medium'|'low'} confidence
 * @property {number} spanHours
 * @property {import('./forecast.js').Strategy} strategy
 * @property {Array<{ name: string, reason: string }>} notForecast
 * @property {'no-capacity'|'no-quota'|null} reason
 * @property {number} burnRate        Pro-weeks per hour
 * @property {number} pace
 * @property {'overusing'|'underusing'|'on-pace'|null} verdict
 * @property {number|null} threshold  the fleet's dry line, as a used fraction
 * @property {number} fleetCapacity   Pro-weeks per week
 * @property {number|null} poolDryAt
 * @property {number|null} dryForMs
 * @property {number} unusedPct
 * @property {ForecastAccount[]} accounts
 * @property {ForecastUser[]} users
 * @property {ForecastScoped[]} scoped
 * @property {{ past: Array<[number, number]>, projected: Array<[number, number]> }} series
 */

/**
 * The accounts as the simulation sees one bucket. A bucket never reported for
 * an account is taken as empty, the likeliest state of one nobody has used.
 * @param {Array<Record<string, any>>} accounts
 * @param {string} field
 * @param {ThresholdFor} thresholdFor
 * @param {number} now
 * @returns {Array<SimAccount & { key: string, seen: boolean }>}
 */
function simAccounts(accounts, field, thresholdFor, now) {
  return accounts.map(a => {
    const q = a.quota || {};
    const reset = Number.isFinite(q[field + 'Reset']) ? q[field + 'Reset'] : null;
    const seen = Number.isFinite(q[field]);
    const u = seen && !(reset != null && reset <= now) ? q[field] : 0;
    return {
      key: accountKey(a), name: a.name, weight: /** @type {number} */ (quotaTier(a).weight),
      priority: a.priority || 0, u, reset, threshold: thresholdFor(field, a), seen,
    };
  });
}

/**
 * The burn rate to project with, Pro-weeks per hour: the history's once there
 * is enough of it, else each account's since-reset average.
 * @param {string} field
 * @param {SimAccount[]} sims
 * @param {QuotaHistory} history
 * @param {(key: string) => number|null} weightOf
 * @param {{ spanMs: number, confidence: 'high'|'medium'|'low' }} coverage
 * @param {number} now
 */
function rateFor(field, sims, history, weightOf, coverage, now) {
  if (coverage.confidence === 'low' || !(coverage.spanMs > 0)) return sinceResetRate(sims, now);
  return history.burned(field, now, coverage.spanMs, weightOf) / (coverage.spanMs / HOUR_MS);
}

/**
 * @param {object} opts
 * @param {Array<Record<string, any>>} opts.accounts  AccountManager.accounts
 * @param {ThresholdFor} opts.thresholdFor
 * @param {string} opts.mode                         AccountManager.distributionMode
 * @param {QuotaHistory} opts.history
 * @param {ClientQuotaTracker} opts.attribution
 * @param {number} opts.now
 * @returns {ForecastPayload}
 */
export function buildForecast({ accounts, thresholdFor, mode, history, attribution, now }) {
  const strategy = strategyFor(mode);
  /** @type {Array<{ name: string, reason: string }>} */
  const notForecast = [];
  /** @type {Array<Record<string, any>>} */
  const counted = [];
  for (const account of accounts) {
    if (!isForecastAccount(account)) continue;
    if (account.disabled) notForecast.push({ name: account.name, reason: 'disabled' });
    else if (quotaTier(account).weight == null) notForecast.push({ name: account.name, reason: 'unknown tier' });
    else counted.push(account);
  }
  /** @type {Map<string, number>} */
  const weights = new Map(counted.map(a => [accountKey(a), /** @type {number} */ (quotaTier(a).weight)]));
  const weightOf = (/** @type {string} */ key) => weights.get(key) ?? null;
  const coverage = history.coverage(now);

  /** @type {ForecastPayload} */
  const payload = {
    generatedAt: now, bucket: 'weekly', confidence: coverage.confidence, spanHours: round(coverage.spanMs / HOUR_MS, 1),
    strategy, notForecast, reason: null, burnRate: 0, pace: 0, verdict: null, threshold: null, fleetCapacity: 0,
    poolDryAt: null, dryForMs: null, unusedPct: 0, accounts: [], users: [], scoped: [], series: { past: [], projected: [] },
  };
  const weekly = simAccounts(counted, 'unified7d', thresholdFor, now);
  if (!weekly.length) return { ...payload, reason: 'no-capacity' };
  if (!weekly.some(a => a.seen)) return { ...payload, reason: 'no-quota' };

  const burnRate = rateFor('unified7d', weekly, history, weightOf, coverage, now);
  const sim = simulate({ accounts: weekly, burnRate, strategy, now });
  const pace = paceOf(burnRate, sim.capacity);
  const verdict = verdictOf({ poolDryAt: sim.poolDryAt, pace, unusedPct: sim.unusedPct });

  /** @type {ForecastUser[]} */
  const users = userShares(attribution.window()).map(u => {
    // Only a dry spell has a time for one client's absence to move.
    if (sim.poolDryAt == null || u.name === NO_CLIENT) return u;
    const without = simulate({ accounts: weekly, burnRate: burnRate * (1 - u.share), strategy, now });
    return { ...u, withoutThemDryAt: without.poolDryAt };
  });

  /** @type {ForecastAccount[]} */
  const accountRows = sim.accounts.map(row => {
    const a = weekly[row.index];
    const account = counted[row.index];
    const q = account.quota || {};
    const r5h = Number.isFinite(q.unified5hReset) ? q.unified5hReset : null;
    const u5h = Number.isFinite(q.unified5h) && !(r5h != null && r5h <= now) ? q.unified5h : null;
    const t5h = thresholdFor('unified5h', account);
    const slope = history.recentSlope(a.key, 'unified5h', now, SESSION_SLOPE_SPAN_MS);
    let sessionHitsAt = slope != null && u5h != null && u5h < t5h ? Math.round(now + (t5h - u5h) / slope) : null;
    // Past the session's reset it is a new session, so there is nothing to hit.
    if (sessionHitsAt != null && r5h != null && sessionHitsAt > r5h) sessionHitsAt = null;
    return { name: a.name, weight: a.weight, u: round(a.u), reset: a.reset, drainsAt: row.drainsAt, unusedAtReset: row.unusedAtReset, sessionHitsAt };
  });

  /** @type {ForecastScoped[]} */
  const scoped = [];
  for (const { field, bucket } of SCOPED) {
    const sims = simAccounts(counted.filter(a => Number.isFinite(a.quota?.[field])), field, thresholdFor, now);
    if (!sims.length) continue;
    const rate = rateFor(field, sims, history, weightOf, coverage, now);
    const s = simulate({ accounts: sims, burnRate: rate, strategy, now });
    const p = paceOf(rate, s.capacity);
    scoped.push({ bucket, verdict: verdictOf({ poolDryAt: s.poolDryAt, pace: p, unusedPct: s.unusedPct }), pace: p, poolDryAt: s.poolDryAt, unusedPct: s.unusedPct });
  }

  return {
    ...payload,
    burnRate: round(burnRate, 6),
    pace,
    verdict,
    // Where the fleet's used fraction stands once every account is at its own
    // threshold: the chart's dry line.
    threshold: round(weekly.reduce((sum, a) => sum + a.weight * a.threshold, 0) / sim.capacity, 4),
    fleetCapacity: sim.capacity,
    poolDryAt: sim.poolDryAt,
    dryForMs: sim.dryForMs,
    unusedPct: sim.unusedPct,
    accounts: accountRows,
    users,
    scoped,
    series: { past: history.pastSeries('unified7d', now, RATE_SPAN_MS, weightOf, sim.capacity), projected: sim.projected },
  };
}
