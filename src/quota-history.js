// Quota history for the usage forecast.
//
// An account's quota is a snapshot: the utilization and reset instant the last
// response reported. Nothing in it says how fast the fleet is spending, so this
// samples every Claude subscription's buckets on a timer (every minute, from
// index.js) and keeps four weeks of them: every sample for two days, then the
// last of each clock hour, which is enough to read a week's rhythm back from.
// From that come the fleet's burn rate over the last day, the curve the
// dashboard draws behind the forecast, and an account's recent session slope.
// It is saved in the state file with the rest of the quota, so a restart does
// not cost a day of history.
//
// The routing learner (BurnRateLearner, adaptive-distribution.js) answers a
// different question — how fast ONE account is burning over the last few
// minutes — and forgets in about a quarter of an hour: right for routing, of no
// use for a day-long forecast.

import { providerOf } from './provider.js';

export const HISTORY_RETAIN_MS = 28 * 24 * 3600_000;
/**
 * How often index.js takes a reading. A minute, so a change in pace shows in
 * the forecast about as soon as the dashboard asks for it again (it refetches
 * once a minute) rather than up to a quarter of an hour later. Readings only
 * move when a response or a probe brings a new figure, so most samples repeat
 * the last one; they cost the state file size for two days and nothing after
 * the hourly thinning.
 */
export const HISTORY_SAMPLE_MS = 60_000;
/**
 * How long every sample is kept. Older ones are thinned to the last of each
 * clock hour and the last of each window: a rise between two kept samples is
 * the sum of the rises between the ones dropped, and a window's last reading
 * holds all that was spent in it, so the spend read back is the same, at a
 * small fraction of the size.
 */
export const HISTORY_FINE_MS = 48 * 3600_000;
/** The span the fleet's burn rate is measured over once that much history exists. */
export const RATE_SPAN_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
const MEDIUM_MS = 6 * HOUR_MS;
/** A reset instant that moves on by more than this is a new window, not jitter. */
const RESET_JUMP_MS = HOUR_MS;

/** The quota fields sampled; each is paired with its `…Reset`. */
export const HISTORY_BUCKETS = ['unified7d', 'unified7dSonnet', 'unified7dFable', 'unified5h'];

/**
 * One sample of one account: when, and each bucket's utilization and reset
 * where known, under the quota's own field names.
 * @typedef {{ t: number } & Record<string, number>} Sample
 */

/**
 * Whether the forecast covers an account: a Claude subscription. API keys,
 * third-party backends and Codex have no weekly bucket of this kind.
 * @param {Record<string, any>|null|undefined} account
 */
export function isForecastAccount(account) {
  return !!account && account.type === 'oauth' && !account.upstream && providerOf(account) === 'anthropic';
}

/**
 * The identity samples are filed under: the one the state file matches quota
 * by, so it survives a rename and a restart. Before its first profile fetch an
 * account has only its name; the key changes once when the uuid arrives, and
 * the next sample drops the name-keyed rows with the other departed accounts.
 * @param {Record<string, any>} account
 */
export function accountKey(account) {
  if (account.accountUuid) return account.orgUuid ? `${account.accountUuid}/${account.orgUuid}` : String(account.accountUuid);
  return 'name:' + account.name;
}

/**
 * A bucket's utilization in a sample: 0 once its reset has passed by `at` (the
 * reading belongs to a window that is over), null when it was not reported.
 * @param {Sample} row
 * @param {string} bucket
 * @param {number} [at]
 * @returns {number|null}
 */
export function valueAt(row, bucket, at = row.t) {
  const u = row[bucket];
  if (!Number.isFinite(u)) return null;
  const reset = row[bucket + 'Reset'];
  return Number.isFinite(reset) && reset <= at ? 0 : u;
}

/**
 * Whether a bucket's reading in `row` belongs to a later window than the one in
 * `prev`. The reset instant moving on says so. A fall alone does not: the
 * response headers and the usage endpoint take turns updating the reading and
 * round differently, so it can step back a point inside one window and return.
 * Only with no reset to go by is a fall taken for a refill.
 * @param {Sample} prev
 * @param {Sample} row
 * @param {string} bucket
 */
function newWindow(prev, row, bucket) {
  const r0 = prev[bucket + 'Reset'];
  const r1 = row[bucket + 'Reset'];
  if (Number.isFinite(r0) && Number.isFinite(r1)) return r1 - r0 > RESET_JUMP_MS;
  return /** @type {number} */ (valueAt(row, bucket)) < /** @type {number} */ (valueAt(prev, bucket));
}

/**
 * Whether `row` is the last reading of a window in some bucket: `next` belongs
 * to a later one. Thinning keeps such a row: the next sample kept counts from
 * zero, so what this one saw since the last kept reading would be lost.
 * @param {Sample} row
 * @param {Sample} next
 */
function endsWindow(row, next) {
  return HISTORY_BUCKETS.some(bucket => valueAt(row, bucket) != null && valueAt(next, bucket) != null && newWindow(row, next, bucket));
}

/**
 * The newest sample at or before `t`, from a list oldest first.
 * @param {Sample[]} list
 * @param {number} t
 */
function lastAtOrBefore(list, t) {
  /** @type {Sample|null} */
  let found = null;
  for (const row of list) {
    if (row.t > t) break;
    found = row;
  }
  return found;
}

/**
 * A saved row with only the fields a sample has, or null when it has no time.
 * @param {unknown} row
 * @returns {Sample|null}
 */
function cleanRow(row) {
  if (!row || typeof row !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  if (typeof r.t !== 'number' || !Number.isFinite(r.t)) return null;
  /** @type {Sample} */
  const out = { t: r.t };
  for (const bucket of HISTORY_BUCKETS) {
    for (const field of [bucket, bucket + 'Reset']) {
      const v = r[field];
      if (typeof v === 'number' && Number.isFinite(v)) out[field] = v;
    }
  }
  return out;
}

export class QuotaHistory {
  /** @param {{ retainMs?: number }} [opts] */
  constructor({ retainMs = HISTORY_RETAIN_MS } = {}) {
    this.retainMs = retainMs;
    /** @type {Map<string, Sample[]>} account key → samples, oldest first */
    this.samples = new Map();
  }

  /**
   * Record every forecast account's buckets as they stand at `now`. An account
   * no longer in the list loses its history here, and samples past the
   * retention go.
   * @param {Array<Record<string, any>>} accounts
   * @param {number} now
   */
  sample(accounts, now) {
    /** @type {Set<string>} */
    const live = new Set();
    for (const account of accounts) {
      if (!isForecastAccount(account)) continue;
      const key = accountKey(account);
      live.add(key);
      const q = account.quota || {};
      /** @type {Sample} */
      const row = { t: now };
      for (const bucket of HISTORY_BUCKETS) {
        if (Number.isFinite(q[bucket])) row[bucket] = q[bucket];
        if (Number.isFinite(q[bucket + 'Reset'])) row[bucket + 'Reset'] = q[bucket + 'Reset'];
      }
      const list = this.samples.get(key);
      if (list) list.push(row);
      else this.samples.set(key, [row]);
    }
    for (const key of [...this.samples.keys()]) if (!live.has(key)) this.samples.delete(key);
    this._prune(now);
  }

  /** @param {number} now */
  _prune(now) {
    const cutoff = now - this.retainMs;
    const fine = now - HISTORY_FINE_MS;
    for (const [key, list] of this.samples) {
      /** @type {Sample[]} */
      const keep = [];
      list.forEach((row, i) => {
        if (row.t <= cutoff) return;
        const next = list[i + 1];
        if (row.t <= fine && next && Math.floor(next.t / HOUR_MS) === Math.floor(row.t / HOUR_MS) && !endsWindow(row, next)) return;
        keep.push(row);
      });
      if (keep.length) this.samples.set(key, keep);
      else this.samples.delete(key);
    }
  }

  /**
   * How much history there is, and so how far to trust a rate taken from it:
   * a full day is `high`, six hours `medium`, anything less `low` — too little
   * to span a day and a night, so the forecast falls back to each account's
   * since-reset average instead.
   * @param {number} now
   * @returns {{ spanMs: number, confidence: 'high'|'medium'|'low' }}
   */
  coverage(now) {
    let oldest = Infinity;
    for (const list of this.samples.values()) if (list.length && list[0].t < oldest) oldest = list[0].t;
    const have = Number.isFinite(oldest) ? Math.max(0, now - oldest) : 0;
    return {
      spanMs: Math.min(have, RATE_SPAN_MS),
      confidence: have >= RATE_SPAN_MS ? 'high' : have >= MEDIUM_MS ? 'medium' : 'low',
    };
  }

  /**
   * Pro-weeks spent on one bucket over the `spanMs` before `now`: each
   * account's rises inside the span, times its weight. A rise is measured from
   * the highest reading so far in the window, so a dip and its return are not
   * spent twice; a new window's first reading was all spent since its reset;
   * a bucket first seen mid-span has nothing to rise from. An account
   * `weightOf` gives no weight (unknown tier, disabled) is left out.
   * @param {string} bucket
   * @param {number} now
   * @param {number} spanMs
   * @param {(key: string) => number|null|undefined} weightOf
   */
  burned(bucket, now, spanMs, weightOf) {
    const from = now - spanMs;
    let total = 0;
    for (const [key, list] of this.samples) {
      const weight = weightOf(key);
      if (!weight) continue;
      /** @type {Sample|null} */
      let prev = null;
      let peak = 0;
      for (const row of list) {
        if (row.t < from || row.t > now) continue;
        const after = valueAt(row, bucket);
        if (after != null) {
          if (!prev || valueAt(prev, bucket) == null) peak = after;
          else if (newWindow(prev, row, bucket)) {
            total += weight * after;
            peak = after;
          } else if (after > peak) {
            total += weight * (after - peak);
            peak = after;
          }
          // A 0 is a window that is over or one untouched: the next rise
          // counts from there.
          if (after === 0) peak = 0;
        }
        prev = row;
      }
    }
    return total;
  }

  /**
   * The fleet's used fraction of one bucket at each sample time over the
   * `spanMs` before `now`, for the chart: every account's last reading at or
   * before that time, times its weight, over `capacity`.
   * @param {string} bucket
   * @param {number} now
   * @param {number} spanMs
   * @param {(key: string) => number|null|undefined} weightOf
   * @param {number} capacity  Pro-weeks
   * @returns {Array<[number, number]>}
   */
  pastSeries(bucket, now, spanMs, weightOf, capacity) {
    if (!(capacity > 0)) return [];
    const from = now - spanMs;
    /** @type {Set<number>} */
    const times = new Set();
    for (const list of this.samples.values()) for (const row of list) if (row.t >= from && row.t <= now) times.add(row.t);
    return [...times].sort((x, y) => x - y).map(t => {
      let used = 0;
      for (const [key, list] of this.samples) {
        const weight = weightOf(key);
        if (!weight) continue;
        const row = lastAtOrBefore(list, t);
        const v = row ? valueAt(row, bucket, t) : null;
        if (v != null) used += weight * Math.min(1, v);
      }
      return /** @type {[number, number]} */ ([t, Math.round(used / capacity * 1e4) / 1e4]);
    });
  }

  /**
   * How fast one account's bucket has been rising over the `spanMs` before
   * `now`, per millisecond: first and last samples of that span, if both are
   * in the same window. Null with fewer than two samples or no rise.
   * @param {string} key
   * @param {string} bucket
   * @param {number} now
   * @param {number} spanMs
   */
  recentSlope(key, bucket, now, spanMs) {
    const rows = (this.samples.get(key) || []).filter(row => row.t >= now - spanMs && row.t <= now && valueAt(row, bucket) != null);
    if (rows.length < 2) return null;
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (first[bucket + 'Reset'] !== last[bucket + 'Reset']) return null;
    const slope = (/** @type {number} */ (valueAt(last, bucket)) - /** @type {number} */ (valueAt(first, bucket))) / (last.t - first.t);
    return slope > 0 ? slope : null;
  }

  /**
   * The state-file form: the samples by account key.
   * @returns {Record<string, Sample[]>}
   */
  exportState() {
    return Object.fromEntries([...this.samples].map(([key, list]) => [key, list.map(row => ({ ...row }))]));
  }

  /**
   * Take back what exportState wrote. Additive and forgiving: a malformed row
   * is skipped, as is one past the retention or from the future — a clock that
   * stepped back, whose sample would read as current until the clock caught up.
   * @param {unknown} saved
   * @param {number} now
   */
  restore(saved, now) {
    if (!saved || typeof saved !== 'object') return;
    for (const [key, list] of Object.entries(saved)) {
      if (!key || !Array.isArray(list)) continue;
      /** @type {Sample[]} */
      const rows = [];
      for (const raw of list) {
        const row = cleanRow(raw);
        if (row && row.t <= now && row.t > now - this.retainMs) rows.push(row);
      }
      if (!rows.length) continue;
      const mine = this.samples.get(key) || [];
      this.samples.set(key, [...rows, ...mine].sort((x, y) => x.t - y.t));
    }
  }
}
