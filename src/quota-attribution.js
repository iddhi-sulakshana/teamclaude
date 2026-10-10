// Who spent the fleet's weekly quota.
//
// Token counts say how much text a client moved, not what it cost: cache reads
// dwarf everything else in them, and a Fable request costs more than a Haiku
// one. The quota headers do say what it cost. Every response carries its
// account's weekly utilization, so the rise from the reading before a response
// to the reading it brought is booked to the client that sent it, in Pro-weeks
// (the rise times the account's tier weight — see quotaTier in quota-summary.js).
//
// Upstream reports utilization to the percent, so most responses move nothing
// and one in many moves a whole point. The response that crosses the line is no
// likelier to come from one client than its share of the spend, so the booking
// is right on average, and a day of it is plenty of averaging. Concurrent
// responses on one account cannot double-count: each is measured from the
// reading the previous one left.

import { USAGE_SLOT_MS } from './client-usage.js';

/** Spend sent without a client key: the shared key, or a key-less loopback caller. */
export const NO_CLIENT = '(no client key)';

/** How long per-client spend is kept: the forecast's one-day window. */
export const ATTRIBUTION_SPAN_MS = 24 * 3600_000;

// The day plus the slot it starts in, as client-usage.js retains its slots.
const RETAINED_SLOTS = Math.ceil(ATTRIBUTION_SPAN_MS / USAGE_SLOT_MS) + 1;

/** A reset instant that moves on by more than this is a new window, not jitter. */
const RESET_JUMP_MS = 3600_000;

/**
 * The weekly reading a credit is measured from.
 * @param {Record<string, any>|null|undefined} account
 * @returns {{ u: number|null, reset: number|null }}
 */
export function quotaMark(account) {
  const q = account?.quota || {};
  return {
    u: Number.isFinite(q.unified7d) ? q.unified7d : null,
    reset: Number.isFinite(q.unified7dReset) ? q.unified7dReset : null,
  };
}

/**
 * Pro-weeks one response spent: the rise between the readings around it, times
 * the account's weight. A reset instant that moved on is a new window, so all
 * of the later reading was spent since; a first reading has nothing to rise
 * from and books nothing.
 * @param {{ u: number|null, reset: number|null }} before
 * @param {{ u: number|null, reset: number|null }} after
 * @param {number|null} weight
 * @returns {number}
 */
export function quotaCredit(before, after, weight) {
  if (weight == null || !(weight > 0) || before.u == null || after.u == null) return 0;
  if (before.reset != null && after.reset != null && after.reset - before.reset > RESET_JUMP_MS) return after.u * weight;
  return Math.max(0, after.u - before.u) * weight;
}

/**
 * Each client's weekly-quota spend over the last day, in 15-minute slots.
 */
export class ClientQuotaTracker {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    /** @type {Map<string, Map<number, number>>} client → slot number → Pro-weeks */
    this.clients = new Map();
  }

  /**
   * Book `amount` Pro-weeks to a client; a missing name books to NO_CLIENT.
   * @param {string|null|undefined} name
   * @param {number} amount
   */
  record(name, amount) {
    if (!(amount > 0)) return;
    const key = name || NO_CLIENT;
    const slot = Math.floor(this._now() / USAGE_SLOT_MS);
    let slots = this.clients.get(key);
    if (!slots) this.clients.set(key, slots = new Map());
    slots.set(slot, (slots.get(slot) || 0) + amount);
  }

  /**
   * Each client's spend over the last day, Pro-weeks; a client with none is left out.
   * @returns {Record<string, number>}
   */
  window() {
    const now = this._now();
    this._evict(now);
    const from = Math.floor((now - ATTRIBUTION_SPAN_MS) / USAGE_SLOT_MS);
    /** @type {Array<[string, number]>} */
    const rows = [];
    for (const [name, slots] of this.clients) {
      let sum = 0;
      for (const [slot, v] of slots) if (slot >= from) sum += v;
      if (sum > 0) rows.push([name, Math.round(sum * 1e9) / 1e9]);
    }
    return Object.fromEntries(rows);
  }

  /** @param {number} now */
  _evict(now) {
    const cutoff = Math.floor(now / USAGE_SLOT_MS) - RETAINED_SLOTS;
    for (const [name, slots] of this.clients) {
      for (const slot of slots.keys()) if (slot <= cutoff) slots.delete(slot);
      if (!slots.size) this.clients.delete(name);
    }
  }

  /**
   * The state-file form: `{ client: [[slot, proWeeks], …] }`.
   * @returns {Record<string, Array<[number, number]>>}
   */
  exportState() {
    this._evict(this._now());
    return Object.fromEntries([...this.clients].map(([name, slots]) => [name, [...slots]]));
  }

  /**
   * Take back what exportState wrote. Additive and forgiving: a row that is not
   * a `[slot, amount]` pair, falls outside the day, or lies in the future (a
   * clock that stepped back) is skipped on its own.
   * @param {unknown} saved
   */
  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    const nowSlot = Math.floor(this._now() / USAGE_SLOT_MS);
    for (const [name, rows] of Object.entries(saved)) {
      if (!name || !Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const [slot, amount] = row;
        if (!Number.isInteger(slot) || !(amount > 0) || slot > nowSlot || slot <= nowSlot - RETAINED_SLOTS) continue;
        let slots = this.clients.get(name);
        if (!slots) this.clients.set(name, slots = new Map());
        slots.set(slot, (slots.get(slot) || 0) + amount);
      }
    }
  }
}
