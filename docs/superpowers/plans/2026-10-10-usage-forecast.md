# Usage Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard hero's client bar chart with a fleet weekly-quota forecast (overuse/underuse verdict, when the pool runs dry, per-account timing, per-user pacing), backed by sampled quota history and a rotation simulation, with an operator-only "Explain" that asks Haiku through the genuine `claude` CLI.

**Architecture:** Four new pure-ish modules — `quota-attribution.js` (per-client weekly-quota spend from response headers), `forecast.js` (the arithmetic: pace, simulation, verdict, user shares), `quota-history.js` (15-minute samples of every Claude subscription's buckets, 48h), `forecast-payload.js` (assembles the API payload) — plus `forecast-explain.js` (spawns `claude -p --bare` against this proxy). `server.js` gains `GET /teamclaude/forecast`, `POST /teamclaude/forecast/explain` and one attribution hook beside `updateQuota`; `index.js` wires sampling, persistence and hooks; `dashboard.js` gets new pure helpers and the hero chart, `?` popup and card lines.

**Tech Stack:** Node ≥ 20, ES modules, zero runtime dependencies (Node built-ins only), `node:test` + `node:assert/strict`, TypeScript checker over JSDoc (`tsc`, non-strict gate plus a per-file strict ratchet), ESLint. Scripts are run with `bun run …`.

**Spec:** `docs/superpowers/specs/2026-10-10-usage-forecast-design.md`

## Global Constraints

- No runtime dependencies: Node built-ins only (`package.json` has devDependencies only).
- Node ≥ 20 (CI runs 20, 22, 24): no `Array.prototype.findLast`/`toSorted` (tsconfig target es2022).
- New files under `src/` must carry **zero** strict-mode TypeScript diagnostics, and modified files must not gain any: `bun run typecheck:strict` must pass. Every new function parameter gets a JSDoc type (`any` is allowed when written explicitly; implicit `any` is not). `catch (err)` variables are `unknown` under strict — cast before reading properties.
- `bun run typecheck`, `bun run lint` and `bun run test` must pass at the end of every task.
- Dashboard: no new external resources; all rendering through `textContent` (never `innerHTML`); page helpers serialized via `toString()` must be self-contained (close over nothing) and written in the page's ES5 style (`var`, `function`).
- Units and constants (verbatim from the spec): Pro-week = one Pro account's weekly bucket (Pro 1, Max 5x 5, Max 20x 20); history retention **48h**; burn-rate window **24h**; confidence **high ≥ 24h, medium 6–24h, low < 6h** (low falls back to the since-reset average); simulation step **15 minutes**, horizon until every account has reset once (≤ 7 days); **overusing** = pool dry before refill or pace > 1.0; **underusing** = projected unused > **30%**; **heavy** user = fair-share multiple > **1.5×**; Explain: model **haiku**, cache **15 minutes**, timeout **90s**, output capped at **2,000** characters.
- Forecast scope: enabled Claude OAuth accounts (`type: 'oauth'`, no `upstream`, provider `anthropic`) with a known tier. Codex, API-key and third-party backends are not forecast.
- `POST /teamclaude/forecast/explain` is operator-only (shared `proxy.apiKey`, key-exempt loopback, or a client key with `role: "admin"`).
- Commits: Conventional Commits style (`feat(forecast): …`). **No `Co-Authored-By` or any Claude/AI attribution line** (the user's global rule).

## Review Focus

1. **An account that has never reported a weekly reset** (fresh login, quota `{ unified7d: 0.3 }` with no `unified7dReset`): expected to be treated as refilling a week from now — no `NaN`, no crash, the chart still draws. Pinned in Task 2 (`simulate` with `reset: null`) and Task 4.
2. **A hand-edited or older-version state file** (`quotaHistory` rows that are strings, missing `t`, `t` in the future; `clientQuota` rows that are not pairs): expected to be skipped row by row, keeping the good ones. Pinned in Tasks 1 and 3.
3. **A reset instant that jitters by a few seconds between responses**: expected not to count as a new window (no phantom burn). Pinned in Task 1 (`quotaCredit`) and Task 3 (`burned`).
4. **Explain clicked twice while the CLI is slow, or the CLI hanging**: expected one child process, both clicks get the same answer, and a hung CLI is killed at the timeout with a readable 502. Pinned in Task 6.
5. **An idle fleet** (burn rate 0 for the whole window): expected pace 0×, verdict underusing, a flat projection, caption "No burn in the last 24h" — no division by zero. Pinned in Task 2 and Task 8.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `src/quota-attribution.js` | create | `NO_CLIENT`, `quotaMark`, `quotaCredit`, `ClientQuotaTracker` (per-client Pro-weeks, 15-min slots, 24h) |
| `src/forecast.js` | create | constants, `strategyFor`, `paceOf`, `sinceResetRate`, `simulate`, `verdictOf`, `userShares`, `round` |
| `src/quota-history.js` | create | `isForecastAccount`, `accountKey`, `valueAt`, `QuotaHistory` (sample, coverage, burned, pastSeries, recentSlope, export/restore) |
| `src/forecast-payload.js` | create | `buildForecast` and the payload typedefs |
| `src/forecast-explain.js` | create | `explainDigest`, `explainSpawnSpec`, `runCapture`, `ExplainError`, `ForecastExplainer` |
| `src/server.js` | modify | attribution hook beside `updateQuota`; `GET /teamclaude/forecast`; `POST /teamclaude/forecast/explain`; tenant refusal entry |
| `src/index.js` | modify | construct/restore/persist history and attribution; sampling timer; forecast/explain/attribution hooks |
| `src/dashboard.js` | modify | new pure helpers; hero forecast chart replacing the client bar chart; `?` popup; Explain; card lines; remove `clientGroups` |
| `test/quota-attribution.test.js`, `test/forecast.test.js`, `test/quota-history.test.js`, `test/forecast-payload.test.js`, `test/forecast-server.test.js`, `test/forecast-explain.test.js`, `test/forecast-e2e.test.js` | create | unit, server and end-to-end tests |
| `test/dashboard.test.js` | modify | harness skips forecast requests; new helper and page tests; `clientGroups` tests removed |
| `docs/usage.md` | modify | Forecast subsection under the browser dashboard |
| `docs/superpowers/specs/2026-10-10-usage-forecast-design.md` | modify | 1b: attribution lives in its own tracker; spend without a client key is shown as `(no client key)` |

---

### Task 1: Per-client quota attribution (`src/quota-attribution.js`)

**Files:**
- Create: `src/quota-attribution.js`
- Test: `test/quota-attribution.test.js`

**Interfaces:**
- Consumes: `USAGE_SLOT_MS` (15 min) from `src/client-usage.js`.
- Produces:
  - `NO_CLIENT: '(no client key)'`
  - `ATTRIBUTION_SPAN_MS: 86400000`
  - `quotaMark(account) → { u: number|null, reset: number|null }`
  - `quotaCredit(before, after, weight: number|null) → number` (Pro-weeks)
  - `class ClientQuotaTracker { constructor({ now? }); record(name: string|null|undefined, amount: number): void; window(): Record<string, number>; exportState(): Record<string, Array<[number, number]>>; restore(saved: unknown): void }`

- [ ] **Step 0: Baseline**

Run: `bun run test && bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: all pass on the fresh branch. If anything fails before any change, stop and report it — do not start on a red baseline.

- [ ] **Step 1: Write the failing tests**

Create `test/quota-attribution.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/quota-attribution.test.js`
Expected: FAIL — `Cannot find module '.../src/quota-attribution.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/quota-attribution.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test test/quota-attribution.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: all pass (the new file has zero strict diagnostics).

- [ ] **Step 6: Commit**

```bash
git add src/quota-attribution.js test/quota-attribution.test.js
git commit -m "feat(forecast): book weekly quota spend to the client that sent it"
```

---

### Task 2: The forecast arithmetic (`src/forecast.js`)

**Files:**
- Create: `src/forecast.js`
- Test: `test/forecast.test.js`

**Interfaces:**
- Consumes: `NO_CLIENT` from `src/quota-attribution.js` (Task 1).
- Produces:
  - Constants `HOUR_MS`, `WEEK_MS`, `STEP_MS`, `UNDERUSE_PCT = 30`, `HEAVY_X = 1.5`
  - `round(v: number, digits = 4) → number`
  - `strategyFor(mode: string) → 'soonest-reset'|'least-remaining'|'proportional'` (`'adaptive'` → least-remaining, `'even'` → proportional, else soonest-reset)
  - `paceOf(burnRate: number, capacity: number) → number` (3 decimals)
  - `sinceResetRate(accounts: SimAccount[], now: number) → number` (Pro-weeks/h)
  - `simulate({ accounts: SimAccount[], burnRate, strategy, now, stepMs? }) → SimResult`
  - `verdictOf({ poolDryAt, pace, unusedPct }) → 'overusing'|'underusing'|'on-pace'`
  - `userShares(spend: Record<string, number>) → Array<{ name, spent, share, fairShareX: number|null, heavy: boolean }>`
  - `SimAccount = { name: string, weight: number, priority: number, u: number, reset: number|null, threshold: number }`
  - `SimResult = { capacity, poolDryAt: number|null, dryForMs: number|null, unusedPct, projected: Array<[t, usedFraction]>, accounts: Array<{ index, name, reset, drainsAt: number|null, unusedAtReset: number|null }> }` — `accounts[i].index` is the position in the input array.

- [ ] **Step 1: Write the failing tests**

Create `test/forecast.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/forecast.test.js`
Expected: FAIL — `Cannot find module '.../src/forecast.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/forecast.js`:

```js
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
  const horizon = Math.max(...live.map(a => a.reset));
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test test/forecast.test.js`
Expected: PASS (12 tests). If a timing assertion is off by one step, check that the 15-minute step boundaries divide the durations exactly (all fixtures above are whole multiples of 15 minutes).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/forecast.js test/forecast.test.js
git commit -m "feat(forecast): pace, rotation simulation, verdict and user shares"
```

---

### Task 3: Quota history (`src/quota-history.js`)

**Files:**
- Create: `src/quota-history.js`
- Test: `test/quota-history.test.js`

**Interfaces:**
- Consumes: `providerOf` from `src/provider.js`.
- Produces:
  - `HISTORY_RETAIN_MS = 48h`, `RATE_SPAN_MS = 24h`, `HISTORY_BUCKETS = ['unified7d','unified7dSonnet','unified7dFable','unified5h']`
  - `isForecastAccount(account) → boolean`
  - `accountKey(account) → string` (`uuid/org`, `uuid`, or `name:<name>`)
  - `valueAt(row: Sample, bucket: string, at = row.t) → number|null`
  - `class QuotaHistory { sample(accounts, now); coverage(now) → { spanMs, confidence: 'high'|'medium'|'low' }; burned(bucket, now, spanMs, weightOf) → number; pastSeries(bucket, now, spanMs, weightOf, capacity) → Array<[number, number]>; recentSlope(key, bucket, now, spanMs) → number|null; exportState() → Record<string, Sample[]>; restore(saved: unknown, now: number) }`
  - `weightOf: (key: string) => number|null|undefined`

- [ ] **Step 1: Write the failing tests**

Create `test/quota-history.test.js`:

```js
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
  near(j.burned('unified7d', NOW, 2 * HOUR, weights({ 'u-b': 1 })), 0.02, 'twenty seconds of jitter is the same window');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/quota-history.test.js`
Expected: FAIL — `Cannot find module '.../src/quota-history.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/quota-history.js`:

```js
// Quota history for the usage forecast.
//
// An account's quota is a snapshot: the utilization and reset instant the last
// response reported. Nothing in it says how fast the fleet is spending, so this
// samples every Claude subscription's buckets on a timer (every 15 minutes, from
// index.js) and keeps two days of them. From that come the fleet's burn rate
// over the last day, the curve the dashboard draws behind the forecast, and an
// account's recent session slope. It is saved in the state file with the rest
// of the quota, so a restart does not cost a day of history.
//
// The routing learner (BurnRateLearner, adaptive-distribution.js) answers a
// different question — how fast ONE account is burning over the last few
// minutes — and forgets in about a quarter of an hour: right for routing, of no
// use for a day-long forecast.

import { providerOf } from './provider.js';

export const HISTORY_RETAIN_MS = 48 * 3600_000;
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
 * How much a bucket rose from one sample to the next. A reset in between (the
 * instant moved on, or the reading fell) means the later reading was all spent
 * since; a bucket first seen in the later sample has nothing to rise from.
 * @param {Sample} prev
 * @param {Sample} row
 * @param {string} bucket
 */
function rise(prev, row, bucket) {
  const before = valueAt(prev, bucket);
  const after = valueAt(row, bucket);
  if (before == null || after == null) return 0;
  const r0 = prev[bucket + 'Reset'];
  const r1 = row[bucket + 'Reset'];
  if ((Number.isFinite(r0) && Number.isFinite(r1) && r1 - r0 > RESET_JUMP_MS) || after < before) return after;
  return after - before;
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
    for (const [key, list] of this.samples) {
      const keep = list.filter(row => row.t > cutoff);
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
   * account's rises between consecutive samples inside the span, times its
   * weight. An account `weightOf` gives no weight (unknown tier, disabled) is
   * left out.
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
      for (const row of list) {
        if (row.t < from || row.t > now) continue;
        if (prev) total += weight * rise(prev, row, bucket);
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test test/quota-history.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/quota-history.js test/quota-history.test.js
git commit -m "feat(forecast): sample each Claude subscription's quota for two days"
```

---

### Task 4: The forecast payload (`src/forecast-payload.js`)

**Files:**
- Create: `src/forecast-payload.js`
- Test: `test/forecast-payload.test.js`

**Interfaces:**
- Consumes: `quotaTier` (`src/quota-summary.js`); `accountKey`, `isForecastAccount`, `RATE_SPAN_MS`, `QuotaHistory` (Task 3); `simulate`, `paceOf`, `verdictOf`, `strategyFor`, `sinceResetRate`, `userShares`, `round`, `HOUR_MS` (Task 2); `NO_CLIENT`, `ClientQuotaTracker` (Task 1).
- Produces: `buildForecast({ accounts, thresholdFor, mode, history, attribution, now }) → ForecastPayload` with exactly the keys in the spec's §3 JSON (plus `reason: 'no-capacity'|'no-quota'|null`). `users[]` rows carry `withoutThemDryAt` **only** when the fleet verdict is `overusing` (value `null` = would not run dry). `thresholdFor: (bucket: string, account: Record<string, any>) => number`.

- [ ] **Step 1: Write the failing tests**

Create `test/forecast-payload.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/forecast-payload.test.js`
Expected: FAIL — `Cannot find module '.../src/forecast-payload.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/forecast-payload.js`:

```js
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
 * @property {number|null} [withoutThemDryAt]  present only when the fleet is overusing; null = would not run dry
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
    if (verdict !== 'overusing' || u.name === NO_CLIENT) return u;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test test/forecast-payload.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/forecast-payload.js test/forecast-payload.test.js
git commit -m "feat(forecast): assemble the forecast payload from fleet, history and spend"
```

---

### Task 5: Server routes and the attribution hook (`src/server.js`)

**Files:**
- Modify: `src/server.js` — imports (top of file, near line 24); `CLIENT_KEY_REFUSED_PATHS` (line ~404); after the `/teamclaude/usage/series` route (line ~693); the `updateQuota` call in `forwardRequest` (line ~3495)
- Test: `test/forecast-server.test.js`

**Interfaces:**
- Consumes: `quotaMark`, `quotaCredit` (Task 1); `isForecastAccount` (Task 3); `quotaTier` (`src/quota-summary.js`).
- Produces (hooks the server calls; Task 7 provides them):
  - `hooks.getForecast() → ForecastPayload` for `GET /teamclaude/forecast` (501 when absent)
  - `hooks.explainForecast({ key: string|null }) → Promise<{ text, generatedAt, cached }>` for `POST /teamclaude/forecast/explain` (501 when absent; an error with an integer `status` keeps that status and message; anything else → 500 `explain failed`)
  - `hooks.recordQuotaUse(client: string|null, proWeeks: number)` called after every Claude-subscription response whose weekly reading rose

- [ ] **Step 1: Write the failing tests**

Create `test/forecast-server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// trustLoopback off: the test client is on loopback, and the exemption would
// otherwise let a key-less request through and prove nothing about the gate.
const PROXY = {
  apiKey: 'shared-key',
  trustLoopback: false,
  clientKeys: [
    { name: 'alice', key: 'alice-key' },
    { name: 'ops', key: 'ops-key', role: 'admin' },
    { name: 'ro', key: 'ro-key', role: 'readonly' },
  ],
};
const apiFleet = () => new AccountManager([{ name: 'acct', type: 'api_key', apiKey: 'sk-a' }], 0.98);

async function withProxy(am, config, hooks, fn) {
  const proxy = createProxyServer(am, config, hooks);
  const port = await listen(proxy);
  try {
    await fn(port);
  } finally {
    proxy.close();
  }
}

const post = (port, path, key) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: key ? { 'x-api-key': key } : {} });

test('GET /teamclaude/forecast serves the hook behind the status gate', async () => {
  await withProxy(apiFleet(), { proxy: PROXY }, { getForecast: () => ({ verdict: 'on-pace' }) }, async port => {
    const url = `http://127.0.0.1:${port}/teamclaude/forecast`;
    assert.equal((await fetch(url)).status, 401);
    for (const key of ['shared-key', 'alice-key', 'ro-key']) {
      const res = await fetch(url, { headers: { 'x-api-key': key } });
      assert.equal(res.status, 200, key);
      assert.deepEqual(await res.json(), { verdict: 'on-pace' }, key);
    }
  });
});

test('GET /teamclaude/forecast answers 501 when no forecast is wired', async () => {
  await withProxy(apiFleet(), { proxy: PROXY }, {}, async port => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/forecast`, { headers: { 'x-api-key': 'shared-key' } });
    assert.equal(res.status, 501);
  });
});

test('POST /teamclaude/forecast/explain is the operator\'s, and hands over the caller\'s key', async () => {
  const keys = [];
  const hooks = { explainForecast: async ({ key }) => { keys.push(key); return { text: 'Because.', generatedAt: 5, cached: false }; } };
  await withProxy(apiFleet(), { proxy: PROXY }, hooks, async port => {
    assert.equal((await post(port, '/teamclaude/forecast/explain', 'alice-key')).status, 403, 'a tenant');
    assert.equal((await post(port, '/teamclaude/forecast/explain', 'ro-key')).status, 403, 'read-only');
    const res = await post(port, '/teamclaude/forecast/explain', 'shared-key');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, text: 'Because.', generatedAt: 5, cached: false });
    assert.equal((await post(port, '/teamclaude/forecast/explain', 'ops-key')).status, 200, 'an admin key');
  });
  assert.deepEqual(keys, ['shared-key', 'ops-key']);
});

test('an explain failure keeps its status and message; anything else is a bare 500', async () => {
  let failure = Object.assign(new Error('Claude Code CLI not found on the server'), { status: 503 });
  await withProxy(apiFleet(), { proxy: PROXY }, { explainForecast: async () => { throw failure; } }, async port => {
    let res = await post(port, '/teamclaude/forecast/explain', 'shared-key');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'Claude Code CLI not found on the server' });
    failure = new Error('ENOENT /root/secret');
    res = await post(port, '/teamclaude/forecast/explain', 'shared-key');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: 'explain failed' });
  });
  await withProxy(apiFleet(), { proxy: PROXY }, {}, async port => {
    assert.equal((await post(port, '/teamclaude/forecast/explain', 'shared-key')).status, 501);
  });
});

// An upstream that answers every request with the next weekly reading.
function quotaUpstream(readings) {
  const reset = String(Math.floor(Date.now() / 1000) + 86400);
  return http.createServer((_req, res) => {
    const u = readings.shift() ?? 0;
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-7d-utilization': String(u),
      'anthropic-ratelimit-unified-7d-reset': reset,
    });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}

async function postMessages(port, key) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  await res.text();
  return res.status;
}

test('a Claude response books the weekly quota it moved to the client that sent it', async () => {
  const upstream = quotaUpstream([0.10, 0.12, 0.15]);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'max', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
    rateLimitTier: 'default_claude_max_20x',
  }], 0.98);
  const booked = [];
  try {
    await withProxy(am, { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` },
      { recordQuotaUse: (client, amount) => booked.push([client, amount]) }, async port => {
        assert.equal(await postMessages(port, 'alice-key'), 200);   // first reading: nothing to rise from
        assert.equal(await postMessages(port, 'alice-key'), 200);   // 0.10 → 0.12
        assert.equal(await postMessages(port, 'shared-key'), 200);  // 0.12 → 0.15, no client key
      });
  } finally {
    upstream.close();
  }
  assert.equal(booked.length, 2);
  assert.equal(booked[0][0], 'alice');
  assert.ok(Math.abs(booked[0][1] - 0.4) < 1e-9, String(booked[0][1]));
  assert.equal(booked[1][0], null);
  assert.ok(Math.abs(booked[1][1] - 0.6) < 1e-9, String(booked[1][1]));
});

test('an API-key account books nothing', async () => {
  const upstream = quotaUpstream([0.10, 0.50]);
  const upstreamPort = await listen(upstream);
  const booked = [];
  try {
    await withProxy(apiFleet(), { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` },
      { recordQuotaUse: (client, amount) => booked.push([client, amount]) }, async port => {
        await postMessages(port, 'alice-key');
        await postMessages(port, 'alice-key');
      });
  } finally {
    upstream.close();
  }
  assert.deepEqual(booked, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/forecast-server.test.js`
Expected: FAIL — the forecast GET returns 404 (or falls through to forwarding), explain is not refused for tenants, and `booked` is empty.

- [ ] **Step 3: Add the imports**

In `src/server.js`, after the line `import { createUsageRecorder, resolveUsageDimensions, usageDimensionHeaderNames, usageMixKey, USAGE_SLOT_MS, USAGE_MONTH } from './client-usage.js';` add:

```js
import { quotaMark, quotaCredit } from './quota-attribution.js';
import { isForecastAccount } from './quota-history.js';
import { quotaTier } from './quota-summary.js';
```

(First run `grep -n "quotaTier\|quota-summary" src/server.js`; if `quotaTier` is already imported, skip that third line.)

- [ ] **Step 4: Refuse Explain to tenant keys**

In `CLIENT_KEY_REFUSED_PATHS`, after the `['/teamclaude/users/key', "a client key cannot see users' keys"],` entry add:

```js
  // Every answer spends the fleet's quota on the operator's behalf.
  ['/teamclaude/forecast/explain', 'a client key cannot ask for a forecast explanation'],
```

- [ ] **Step 5: Add the two routes**

Immediately after the `/teamclaude/usage/series` route's closing `}` (the block ending `return;\n      }` just before the `// Tier-weighted fleet quota for lightweight consumers` comment), add:

```js
      // The usage forecast: where the fleet's weekly quota is heading at the
      // current rate (forecast-payload.js). The same readers as status, behind
      // the same gate. Its own endpoint because it is computed on request — a
      // few hundred simulation steps — and the TUI and status line, which poll
      // status every second, have no use for it.
      if (req.method === 'GET' && req.url === '/teamclaude/forecast') {
        if (!hooks.getForecast) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'forecast not supported' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(hooks.getForecast()));
        return;
      }

      // The forecast in a few sentences: Haiku, through the genuine claude CLI
      // and this proxy (forecast-explain.js). The operator's alone — a client
      // key is refused above (CLIENT_KEY_REFUSED_PATHS), read-only by the POST
      // gate — because every answer spends quota. The caller's own key goes to
      // the CLI, so the spend is booked to whoever asked.
      if (req.method === 'POST' && req.url === '/teamclaude/forecast/explain') {
        if (!hooks.explainForecast) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'explain not supported' }));
          return;
        }
        try {
          const key = auth.ok && typeof clientKey === 'string' && clientKey ? clientKey : null;
          const result = await hooks.explainForecast({ key });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          // An ExplainError carries a status and a message written for the
          // page; anything else may name paths, so it is logged, not returned.
          const e = /** @type {any} */ (err);
          const known = e && Number.isInteger(e.status);
          if (!known) console.error(`[TeamClaude] Forecast explain failed: ${e && e.message ? e.message : String(err)}`);
          res.writeHead(known ? e.status : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: known ? String(e.message) : 'explain failed' }));
        }
        return;
      }
```

Check that `auth` and `clientKey` (declared near line 539: `const clientKey = req.headers['x-api-key'];` and `const auth = resolveClientAuth(...)`) are in scope at this point — the status route just above uses `who`, declared after them in the same block, so they are. If `bun run typecheck` reports either as undefined, move the two `const` reads into this route from `req.headers['x-api-key']` and `resolveClientAuth(config.proxy, …)`.

- [ ] **Step 6: Book attribution beside `updateQuota`**

In `forwardRequest`, replace:

```js
    accountManager.updateQuota(account.index, rateLimitHeaders, ctx.model);
```

with:

```js
    // Book the weekly quota this response spent to the client that sent it
    // (quota-attribution.js): the reading before updateQuota against the one
    // the response brought. Claude subscriptions only — the forecast's scope.
    const quotaBefore = quotaMark(account);
    accountManager.updateQuota(account.index, rateLimitHeaders, ctx.model);
    if (hooks.recordQuotaUse && isForecastAccount(account)) {
      const credit = quotaCredit(quotaBefore, quotaMark(account), quotaTier(account).weight);
      if (credit > 0) hooks.recordQuotaUse(ctx.client ?? null, credit);
    }
```

(`grep -n "accountManager.updateQuota(" src/server.js` — there must be exactly one call in `forwardRequest`; if there are others on other paths, leave them alone.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run test test/forecast-server.test.js`
Expected: PASS (6 tests).

- [ ] **Step 8: Run the neighbouring suites, lint and typecheck**

Run: `bun run test test/client-usage.test.js test/control-csrf.test.js test/client-key-roles.test.js test/control-route-404.test.js && bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: all pass; `src/server.js` has no more strict diagnostics than on master.

- [ ] **Step 9: Commit**

```bash
git add src/server.js test/forecast-server.test.js
git commit -m "feat(forecast): forecast and explain routes, quota spend booked per client"
```

---

### Task 6: Explain through the claude CLI (`src/forecast-explain.js`)

**Files:**
- Create: `src/forecast-explain.js`
- Test: `test/forecast-explain.test.js`

**Interfaces:**
- Consumes: `sanitizeText`, `safeLine` (`src/safe-text.js`); `ForecastPayload` type (Task 4).
- Produces:
  - `EXPLAIN_MODEL = 'haiku'`, `EXPLAIN_TTL_MS = 15 min`, `EXPLAIN_TIMEOUT_MS = 90s`, `EXPLAIN_MAX_CHARS = 2000`, `EXPLAIN_INSTRUCTION`
  - `explainDigest(f: ForecastPayload) → object` (times as hours from now, fractions as %)
  - `explainSpawnSpec({ port, apiKey, forecast }) → { command, args, env, input, timeoutMs }`
  - `runCapture(spec) → Promise<{ code, stdout, stderr }>` (rejects `ENOENT` / `ETIMEDOUT`)
  - `class ExplainError extends Error { status: number }`
  - `class ForecastExplainer { constructor({ port, fallbackKey?, run?, now?, ttlMs? }); explain(forecast, callerKey?) → Promise<{ text, generatedAt, cached }> }`

- [ ] **Step 1: Write the failing tests**

Create `test/forecast-explain.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  explainDigest, explainSpawnSpec, runCapture, ForecastExplainer, ExplainError,
  EXPLAIN_TTL_MS, EXPLAIN_MAX_CHARS,
} from '../src/forecast-explain.js';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const FORECAST = {
  generatedAt: NOW, bucket: 'weekly', confidence: 'high', spanHours: 24, strategy: 'soonest-reset', notForecast: [],
  reason: null, burnRate: 0.2, pace: 1.4, verdict: 'overusing', threshold: 0.98, fleetCapacity: 20,
  poolDryAt: NOW + 41 * HOUR, dryForMs: 30 * HOUR, unusedPct: 0,
  accounts: [{ name: 'a@x', weight: 20, u: 0.71, reset: NOW + 71 * HOUR, drainsAt: NOW + 31 * HOUR, unusedAtReset: null, sessionHitsAt: null }],
  users: [{ name: 'alice', spent: 1, share: 0.48, fairShareX: 2.1, heavy: true, withoutThemDryAt: null }],
  scoped: [{ bucket: 'fable', verdict: 'on-pace', pace: 0.6, poolDryAt: null, unusedPct: 12 }],
  series: { past: [[NOW, 0.5]], projected: [[NOW, 0.5]] },
};

test('the digest turns times into hours and fractions into percentages', () => {
  const d = explainDigest(FORECAST);
  assert.equal(d.verdict, 'overusing');
  assert.equal(d.poolDryInHours, 41);
  assert.equal(d.dryForHours, 30);
  assert.deepEqual(d.accounts[0], { name: 'a@x', tierWeight: 20, weeklyUsedPct: 71, resetsInHours: 71, drainsInHours: 31, unusedAtResetPct: null });
  assert.deepEqual(d.users[0], { name: 'alice', shareOfLast24hPct: 48, timesFairShare: 2.1, heavy: true, poolDryInHoursWithoutThem: null });
  assert.deepEqual(d.modelCaps[0], { model: 'fable', verdict: 'on-pace', pace: 0.6, poolDryInHours: null, unusedAtResetsPct: 12 });
  assert.equal('series' in d, false, 'the curves are for the chart, not the model');
});

test('the spawn spec runs bare claude -p on haiku against this proxy with the caller\'s key', () => {
  const spec = explainSpawnSpec({ port: 3456, apiKey: 'tc-alice', forecast: FORECAST });
  assert.equal(spec.command, 'claude');
  assert.deepEqual(spec.args.slice(0, 6), ['-p', '--bare', '--model', 'haiku', '--output-format', 'text']);
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
  assert.equal(spec.env.ANTHROPIC_API_KEY, 'tc-alice');
  assert.deepEqual(JSON.parse(spec.input), explainDigest(FORECAST));
});

function explainer(run, { now = () => NOW, fallbackKey = () => 'tc-shared' } = {}) {
  return new ForecastExplainer({ port: 3456, run, now, fallbackKey });
}

test('an answer is cleaned, capped and cached for fifteen minutes', async () => {
  let clock = NOW;
  const specs = [];
  const run = async spec => { specs.push(spec); return { code: 0, stdout: 'Overusing.\n\x1b[2JAct now.' + 'x'.repeat(3000), stderr: '' }; };
  const ex = explainer(run, { now: () => clock });
  const first = await ex.explain(FORECAST, 'tc-alice');
  assert.equal(first.cached, false);
  assert.equal(first.generatedAt, NOW);
  assert.ok(first.text.startsWith('Overusing. Act now.'), first.text.slice(0, 30));
  assert.equal(first.text.length, EXPLAIN_MAX_CHARS);
  assert.equal(specs[0].env.ANTHROPIC_API_KEY, 'tc-alice');
  clock += EXPLAIN_TTL_MS - 1;
  assert.equal((await ex.explain(FORECAST, 'tc-bob')).cached, true);
  assert.equal(specs.length, 1);
  clock += 2;
  assert.equal((await ex.explain(FORECAST, null)).cached, false, 'expired, asked again');
  assert.equal(specs[1].env.ANTHROPIC_API_KEY, 'tc-shared', 'no caller key: the fallback');
});

test('concurrent asks share one run', async () => {
  let runs = 0;
  let release;
  const run = () => { runs++; return new Promise(resolve => { release = () => resolve({ code: 0, stdout: 'Shared.', stderr: '' }); }); };
  const ex = explainer(run);
  const a = ex.explain(FORECAST, 'k1');
  const b = ex.explain(FORECAST, 'k2');
  release();
  assert.deepEqual(await a, await b);
  assert.equal(runs, 1);
});

test('failures become readable ExplainErrors and are not cached', async () => {
  const cases = [
    [async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); }, 503, /not found on the server/],
    [async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); }, 502, /did not answer within 90 seconds/],
    [async () => ({ code: 1, stdout: '', stderr: 'warming\nInvalid API key\n' }), 502, /^Claude Code CLI failed: Invalid API key$/],
    [async () => ({ code: 0, stdout: '  \n', stderr: '' }), 502, /answered with nothing/],
  ];
  for (const [run, status, message] of cases) {
    const ex = explainer(run);
    await assert.rejects(ex.explain(FORECAST), err => err instanceof ExplainError && err.status === status && message.test(err.message));
    await assert.rejects(ex.explain(FORECAST), ExplainError, 'a failure is asked again, not cached');
  }
});

test('runCapture feeds stdin, collects stdout and the exit code', async () => {
  const out = await runCapture({ command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], env: process.env, input: 'hello', timeoutMs: 10_000 });
  assert.deepEqual(out, { code: 0, stdout: 'hello', stderr: '' });
  const failed = await runCapture({ command: process.execPath, args: ['-e', 'console.error("bad"); process.exit(3)'], env: process.env, input: '', timeoutMs: 10_000 });
  assert.equal(failed.code, 3);
  assert.equal(failed.stderr.trim(), 'bad');
});

test('runCapture rejects a missing binary and kills a hung one', async () => {
  await assert.rejects(
    runCapture({ command: 'teamclaude-no-such-binary', args: [], env: process.env, input: '', timeoutMs: 10_000 }),
    err => err.code === 'ENOENT',
  );
  await assert.rejects(
    runCapture({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'], env: process.env, input: '', timeoutMs: 200 }),
    err => err.code === 'ETIMEDOUT',
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/forecast-explain.test.js`
Expected: FAIL — `Cannot find module '.../src/forecast-explain.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/forecast-explain.js`:

```js
// The forecast's "Explain": a few sentences from Haiku about what the numbers
// mean and what to do.
//
// It goes through the genuine Claude Code CLI pointed at THIS proxy — the same
// route the keep-warm feature takes (warmer.js) — because an OAuth subscription
// is for Claude Code, and a hand-built /v1/messages call would be the pattern
// docs/compliance.md warns against. It runs only when an operator clicks, so a
// human is in the loop, and the answer is cached for a quarter of an hour so a
// curious double-click does not spend twice.
//
// The model is shown a digest with times already turned into hours and
// fractions into percentages, and told to quote rather than calculate: every
// number on the page comes from forecast.js, never from the model.

import { spawn } from 'node:child_process';
import { sanitizeText, safeLine } from './safe-text.js';

export const EXPLAIN_MODEL = 'haiku';
export const EXPLAIN_TTL_MS = 15 * 60_000;
export const EXPLAIN_TIMEOUT_MS = 90_000;
export const EXPLAIN_MAX_CHARS = 2000;
/** More than any answer needs; a runaway child cannot grow the buffer past it. */
const MAX_CAPTURE = 64 * 1024;

export const EXPLAIN_INSTRUCTION = [
  'The JSON on stdin is a usage forecast for a team sharing a pool of Claude subscriptions through a proxy.',
  'Plan sizes are tier weights: Pro 1, Max 5x 5, Max 20x 20. pace 1.0 means spending exactly one week of capacity per week.',
  'A null time means it does not happen within the forecast (one week).',
  "In 3 to 5 plain sentences for the team's admin: say what is happening, name the main driver (an account or a user), and suggest one or two concrete actions.",
  'Quote only numbers that appear in the JSON; do not calculate new ones. No headings, no lists, no preamble.',
].join(' ');

/**
 * @typedef {import('./forecast-payload.js').ForecastPayload} ForecastPayload
 * @typedef {{ text: string, generatedAt: number, cached: boolean }} ExplainResult
 * @typedef {{ command: string, args: string[], env: NodeJS.ProcessEnv, input: string, timeoutMs: number }} SpawnSpec
 * @typedef {{ code: number, stdout: string, stderr: string }} Captured
 */

export class ExplainError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'ExplainError';
    this.status = status;
  }
}

/**
 * The forecast as the model is shown it: times as hours from now and fractions
 * as percentages, so the answer can quote figures instead of working them out.
 * The chart's curves are left out.
 * @param {ForecastPayload} f
 */
export function explainDigest(f) {
  const now = f.generatedAt;
  const hours = (/** @type {number|null|undefined} */ t) => (t == null ? null : Math.round((t - now) / 360_000) / 10);
  const pct = (/** @type {number|null|undefined} */ v) => (v == null ? null : Math.round(v * 1000) / 10);
  return {
    verdict: f.verdict,
    pace: f.pace,
    confidence: f.confidence,
    historyHours: f.spanHours,
    drainOrder: f.strategy,
    poolDryInHours: hours(f.poolDryAt),
    dryForHours: f.dryForMs == null ? null : Math.round(f.dryForMs / 360_000) / 10,
    unusedAtResetsPct: f.unusedPct,
    accounts: f.accounts.map(a => ({
      name: a.name, tierWeight: a.weight, weeklyUsedPct: pct(a.u), resetsInHours: hours(a.reset),
      drainsInHours: hours(a.drainsAt), unusedAtResetPct: pct(a.unusedAtReset),
    })),
    users: f.users.map(u => ({
      name: u.name, shareOfLast24hPct: pct(u.share), timesFairShare: u.fairShareX, heavy: u.heavy,
      ...('withoutThemDryAt' in u ? { poolDryInHoursWithoutThem: hours(u.withoutThemDryAt) } : {}),
    })),
    modelCaps: f.scoped.map(s => ({ model: s.bucket, verdict: s.verdict, pace: s.pace, poolDryInHours: hours(s.poolDryAt), unusedAtResetsPct: s.unusedPct })),
    notForecast: f.notForecast,
  };
}

/**
 * @param {{ port: number, apiKey: string|null, forecast: ForecastPayload }} opts
 * @returns {SpawnSpec}
 */
export function explainSpawnSpec({ port, apiKey, forecast }) {
  return {
    command: 'claude',
    // `--bare -p`: one non-interactive answer, authenticating strictly with
    // ANTHROPIC_API_KEY — which this proxy reads as the caller's key and swaps
    // for an account's token, as it does for every Claude Code request.
    args: ['-p', '--bare', '--model', EXPLAIN_MODEL, '--output-format', 'text', EXPLAIN_INSTRUCTION],
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: apiKey || 'tc-explain' },
    input: JSON.stringify(explainDigest(forecast)),
    timeoutMs: EXPLAIN_TIMEOUT_MS,
  };
}

/**
 * Run a command with `input` on its stdin and collect what it prints. Resolves
 * with the exit code and both streams; rejects when it cannot start (ENOENT for
 * a missing binary) or outlives `timeoutMs` (code ETIMEDOUT, after killing it).
 * @param {SpawnSpec} spec
 * @returns {Promise<Captured>}
 */
export function runCapture({ command, args, env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child;
    try {
      child = spawn(command, args, { env });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })));
    }, timeoutMs);
    timer.unref?.();
    /** @param {() => void} settle */
    const finish = settle => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (/** @type {string} */ chunk) => { if (stdout.length < MAX_CAPTURE) stdout += chunk; });
    child.stderr.on('data', (/** @type {string} */ chunk) => { if (stderr.length < MAX_CAPTURE) stderr += chunk; });
    child.once('error', err => finish(() => reject(err)));
    child.once('close', (code, signal) => finish(() => {
      if (signal) reject(new Error(`terminated by ${signal}`));
      else resolve({ code: code ?? 0, stdout, stderr });
    }));
    // A child that exits without reading closes the pipe under us; its exit
    // status is the report, not the EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** @param {string} text */
function lastLine(text) {
  const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length ? safeLine(lines[lines.length - 1], 200) : '';
}

export class ForecastExplainer {
  /**
   * @param {object} opts
   * @param {number} opts.port                       this proxy's port, which the CLI is pointed at
   * @param {() => string|null} [opts.fallbackKey]   the key when the caller presented none (proxy.apiKey)
   * @param {(spec: SpawnSpec) => Promise<Captured>} [opts.run]
   * @param {() => number} [opts.now]
   * @param {number} [opts.ttlMs]
   */
  constructor({ port, fallbackKey = () => null, run = runCapture, now = () => Date.now(), ttlMs = EXPLAIN_TTL_MS }) {
    this.port = port;
    this.fallbackKey = fallbackKey;
    this.run = run;
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {{ text: string, generatedAt: number }|null} */
    this.cached = null;
    /** @type {Promise<ExplainResult>|null} */
    this.inFlight = null;
  }

  /**
   * Explain `forecast`, or hand back the answer still fresh from the last ask.
   * Concurrent asks share one run.
   * @param {ForecastPayload} forecast
   * @param {string|null} [callerKey]
   * @returns {Promise<ExplainResult>}
   */
  explain(forecast, callerKey = null) {
    if (this.cached && this.now() - this.cached.generatedAt < this.ttlMs) return Promise.resolve({ ...this.cached, cached: true });
    if (!this.inFlight) this.inFlight = this._ask(forecast, callerKey).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * @param {ForecastPayload} forecast
   * @param {string|null} callerKey
   * @returns {Promise<ExplainResult>}
   */
  async _ask(forecast, callerKey) {
    /** @type {Captured} */
    let out;
    try {
      out = await this.run(explainSpawnSpec({ port: this.port, apiKey: callerKey || this.fallbackKey(), forecast }));
    } catch (err) {
      const e = /** @type {{ code?: string, message?: string }|null} */ (err);
      if (e && e.code === 'ENOENT') throw new ExplainError(503, 'Claude Code CLI not found on the server — install it there to use Explain');
      if (e && e.code === 'ETIMEDOUT') throw new ExplainError(502, `Claude did not answer within ${Math.round(EXPLAIN_TIMEOUT_MS / 1000)} seconds`);
      throw new ExplainError(502, 'Could not run the Claude Code CLI: ' + safeLine(e && e.message ? e.message : String(err), 200));
    }
    if (out.code !== 0) {
      throw new ExplainError(502, 'Claude Code CLI failed: ' + (lastLine(out.stderr) || lastLine(out.stdout) || `exit code ${out.code}`));
    }
    const text = sanitizeText(out.stdout).slice(0, EXPLAIN_MAX_CHARS);
    if (!text) throw new ExplainError(502, 'Claude Code CLI answered with nothing');
    this.cached = { text, generatedAt: this.now() };
    return { ...this.cached, cached: false };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test test/forecast-explain.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: all pass. If strict flags `child` as used before assignment inside the timer callback, initialise it as `/** @type {…|null} */ let child = null;` and guard `child?.kill('SIGKILL')`.

- [ ] **Step 6: Commit**

```bash
git add src/forecast-explain.js test/forecast-explain.test.js
git commit -m "feat(forecast): explain the forecast with Haiku through the claude CLI"
```

---

### Task 7: Wire it into the server process (`src/index.js`)

**Files:**
- Modify: `src/index.js` — imports (near line 45); after the `dimensionUsage.restore(...)` line (~336); `persistQuotaState` (~343); after `hooks.getQuotaExtra = …` (~819); after the `quotaSaveInterval` lines (~881); `shutdown()` (~937)
- Test: `test/forecast-e2e.test.js`

**Interfaces:**
- Consumes: `QuotaHistory` (Task 3), `ClientQuotaTracker` (Task 1), `buildForecast` (Task 4), `ForecastExplainer` (Task 6), `USAGE_SLOT_MS` (`src/client-usage.js`), `accountManager.thresholdFor(bucket, account)`, `accountManager.distributionMode`.
- Produces: `hooks.getForecast`, `hooks.explainForecast`, `hooks.recordQuotaUse` (consumed by Task 5's routes); state-file keys `quotaHistory` and `clientQuota`.

- [ ] **Step 1: Write the failing end-to-end test**

Create `test/forecast-e2e.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnServer, closedPort } from '../test-helpers/spawn-server.js';

test('the real server serves a forecast and saves its quota history', async () => {
  const deadPort = await closedPort();
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${deadPort}`,
      upstreamProxy: false,
      accounts: [{
        name: 'max@example.com', type: 'oauth', accessToken: 't', refreshToken: 'r',
        expiresAt: Date.now() + 86_400_000, rateLimitTier: 'default_claude_max_20x',
      }],
    }),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/teamclaude/forecast`, { headers: { 'x-api-key': 'tc-test' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verdict, null);
    assert.equal(body.reason, 'no-quota', 'one Claude subscription, no weekly reading yet');
  } finally {
    await server.stop();
  }
  const state = JSON.parse(await readFile(join(server.dir, 'config.state.json'), 'utf8'));
  const histories = Object.values(state.quotaHistory || {});
  assert.equal(histories.length, 1, 'the startup sample was saved on shutdown');
  assert.ok(histories[0].length >= 1);
  assert.ok('clientQuota' in state);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test test/forecast-e2e.test.js`
Expected: FAIL — the forecast route answers 501 (`forecast not supported`).

- [ ] **Step 3: Import the new modules**

In `src/index.js`, replace `import { ClientUsageTracker, UsageDimensionTracker } from './client-usage.js';` with:

```js
import { ClientUsageTracker, UsageDimensionTracker, USAGE_SLOT_MS } from './client-usage.js';
import { QuotaHistory } from './quota-history.js';
import { ClientQuotaTracker } from './quota-attribution.js';
import { buildForecast } from './forecast-payload.js';
import { ForecastExplainer } from './forecast-explain.js';
```

- [ ] **Step 4: Construct, restore and persist**

After `if (savedState?.usageDimensions) dimensionUsage.restore(savedState.usageDimensions);` add:

```js
  // The usage forecast's inputs (quota-history.js, quota-attribution.js): two
  // days of every Claude subscription's quota readings, and a day of each
  // client's weekly-quota spend. Restored like the rest, so a restart keeps the
  // burn rate already measured.
  const quotaHistory = new QuotaHistory();
  if (savedState?.quotaHistory) quotaHistory.restore(savedState.quotaHistory, Date.now());
  const clientQuota = new ClientQuotaTracker();
  if (savedState?.clientQuota) clientQuota.restore(savedState.clientQuota);
```

Replace the `persistQuotaState` definition with:

```js
  const persistQuotaState = () =>
    saveState({
      quota: accountManager.exportQuotaState(),
      clients: clientUsage.exportState(),
      usageDimensions: dimensionUsage.exportState(),
      quotaHistory: quotaHistory.exportState(),
      clientQuota: clientQuota.exportState(),
    })
      .catch(err => console.error(`[TeamClaude] Failed to save quota state: ${err.message}`));
  let quotaSaveInterval = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let historyInterval = null;
```

(The original block ends with `let quotaSaveInterval = null;` — keep exactly one declaration of it.)

- [ ] **Step 5: Add the hooks**

After `hooks.getQuotaExtra = () => ({ warmup: resolveWarmupConfig(config) });` add:

```js
  // The forecast (GET /teamclaude/forecast), its Explain, and the spend
  // attribution forwardRequest books after every Claude response.
  hooks.recordQuotaUse = (/** @type {string|null} */ client, /** @type {number} */ amount) => clientQuota.record(client, amount);
  hooks.getForecast = () => buildForecast({
    accounts: accountManager.accounts,
    thresholdFor: (bucket, account) => accountManager.thresholdFor(bucket, account),
    mode: accountManager.distributionMode,
    history: quotaHistory,
    attribution: clientQuota,
    now: Date.now(),
  });
  const explainer = new ForecastExplainer({ port, fallbackKey: () => config.proxy?.apiKey || null });
  hooks.explainForecast = (/** @type {{ key: string|null }} */ { key }) => explainer.explain(hooks.getForecast(), key);
```

(`port` is already in scope — `getStatusExtra` above reports it.)

- [ ] **Step 6: Start sampling and stop it on shutdown**

After `quotaSaveInterval.unref?.();` add:

```js
  // A quota reading per account every 15 minutes for the forecast, and one now
  // so a fresh start has a first point to measure from.
  quotaHistory.sample(accountManager.accounts, Date.now());
  historyInterval = setInterval(() => quotaHistory.sample(accountManager.accounts, Date.now()), USAGE_SLOT_MS);
  historyInterval.unref?.();
```

In `shutdown()`, after `if (quotaSaveInterval) clearInterval(quotaSaveInterval);` add:

```js
    if (historyInterval) clearInterval(historyInterval);
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun run test test/forecast-e2e.test.js`
Expected: PASS.

- [ ] **Step 8: Lint, typecheck and the full suite**

Run: `bun run lint && bun run typecheck && bun run typecheck:strict && bun run test`
Expected: all pass; `src/index.js` gains no strict diagnostics.

- [ ] **Step 9: Commit**

```bash
git add src/index.js test/forecast-e2e.test.js
git commit -m "feat(forecast): sample quota, persist history and serve the forecast"
```

---

### Task 8: Dashboard helpers (`src/dashboard.js`, pure functions only)

**Files:**
- Modify: `src/dashboard.js` — new exported helpers (place them after `smoothPath`, before the `heatGrid` comment block); `viewerCan` comment; `SHARED_HELPERS` list (line ~1250)
- Test: `test/dashboard.test.js` — import list (line 7–14), the serialization test's list (line ~892), new helper tests at the end of the file

**Interfaces:**
- Consumes: the `ForecastPayload` JSON shape (Task 4).
- Produces (all exported, serialized into the page, pure):
  - `forecastGeometry(f) → null | { start, end, now, past: string, pastArea: string, projected: string, nowPct, dryPct: number|null, resets: number[], tagPct: { left, top }|null }` — SVG box 400×190; used fraction 0 at y=182, 1 at y=12; x from `generatedAt − 24h` to the last projected time
  - `verdictChip(f) → { text, tone: 'bad'|'warn'|'' } | null`
  - `forecastTag(f, clock, span) → string`
  - `forecastCaption(f) → string`
  - `forecastEmptyText(f, error) → string`
  - `cardForecastLines(row, serving, now, clock, span) → string[]`
  - `forecastPopup(f, clock, span) → null | { verdict: string[], how: string[], accounts: Array<{ name, tier, weekly, resets, outlook }>, notForecast: string[], users: Array<{ name, share, shareText, fairText, heavy, without }>, scoped: string[] }`
  - `explainRequest(key) → { url, init }`; `explainOutcome({ ok, status, body }) → { text?, at?, cached?, error? }`
  - `viewerCan(viewer, 'explain')` → true for operator only (no code change needed; documented)

- [ ] **Step 1: Write the failing tests**

In `test/dashboard.test.js`, add to the import list from `'../src/dashboard.js'` (keep everything already there):

```js
  forecastGeometry, verdictChip, forecastTag, forecastCaption, forecastEmptyText, cardForecastLines, forecastPopup, explainRequest, explainOutcome,
```

Right after the `listen` helper near the top of the file (so the fixture is initialised before any test runs — Task 9's page tests use it too), add:

```js
// A forecast payload as GET /teamclaude/forecast serves it, for the forecast
// helper and page tests. tClock and tSpan stand in for the page's locale-
// dependent formatters.
const FC_NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const FC_HOUR = 3600_000;
const FORECAST = {
  generatedAt: FC_NOW, bucket: 'weekly', confidence: 'high', spanHours: 24, strategy: 'soonest-reset', notForecast: [{ name: 'k@x', reason: 'unknown tier' }],
  reason: null, burnRate: 1 / 6, pace: 1.4, verdict: 'overusing', threshold: 0.98, fleetCapacity: 20,
  poolDryAt: FC_NOW + 41 * FC_HOUR, dryForMs: 30 * FC_HOUR, unusedPct: 0,
  accounts: [
    { name: 'a@x', weight: 20, u: 0.71, reset: FC_NOW + 71 * FC_HOUR, drainsAt: FC_NOW + 31 * FC_HOUR, unusedAtReset: null, sessionHitsAt: FC_NOW + 47 * 60_000 },
    { name: 'b@x', weight: 5, u: 0.2, reset: FC_NOW + 20 * FC_HOUR, drainsAt: null, unusedAtReset: 0.38, sessionHitsAt: null },
  ],
  users: [
    { name: 'alice', spent: 1, share: 0.48, fairShareX: 2.1, heavy: true, withoutThemDryAt: null },
    { name: 'bob', spent: 0.5, share: 0.22, fairShareX: 0.9, heavy: false, withoutThemDryAt: FC_NOW + 50 * FC_HOUR },
  ],
  scoped: [{ bucket: 'fable', verdict: 'on-pace', pace: 0.6, poolDryAt: null, unusedPct: 12 }],
  series: {
    past: [[FC_NOW - 24 * FC_HOUR, 0.3], [FC_NOW, 0.5]],
    projected: [[FC_NOW, 0.5], [FC_NOW + 20 * FC_HOUR, 0.8], [FC_NOW + 20 * FC_HOUR, 0.65], [FC_NOW + 72 * FC_HOUR, 0.98]],
  },
};
const tClock = t => 'T+' + Math.round((t - FC_NOW) / FC_HOUR) + 'h';
const tSpan = ms => Math.round(ms / FC_HOUR) + 'h';
```

Append at the end of the file:

```js
// ── the usage forecast ───────────────────────────────────────

test('forecastGeometry lays both curves on one time axis', () => {
  const g = forecastGeometry(FORECAST);
  assert.equal(g.start, FC_NOW - 24 * FC_HOUR);
  assert.equal(g.end, FC_NOW + 72 * FC_HOUR);
  assert.equal(g.nowPct, 25, 'a day of past in a four-day chart');
  assert.equal(g.past, 'M0,131 L100,97');
  assert.equal(g.pastArea, 'M0,131 L100,97 L100,190 L0,190 Z');
  assert.ok(g.projected.startsWith('M100,97 '));
  assert.deepEqual(g.resets, [45.83], 'the vertical drop at hour 20');
  assert.equal(g.dryPct, 8.11);
  assert.deepEqual(g.tagPct, { left: 67.71, top: 8.11 });
  assert.equal(forecastGeometry({ ...FORECAST, series: { past: [], projected: [] } }), null);
  assert.equal(forecastGeometry(null), null);
});

test('verdictChip names the verdict and its pace', () => {
  assert.deepEqual(verdictChip(FORECAST), { text: 'Overusing 1.4×', tone: 'bad' });
  assert.deepEqual(verdictChip({ verdict: 'underusing', pace: 0.5 }), { text: 'Underusing 0.5×', tone: 'warn' });
  assert.deepEqual(verdictChip({ verdict: 'on-pace', pace: 0.94 }), { text: 'On pace 0.9×', tone: '' });
  assert.equal(verdictChip({ verdict: null }), null);
});

test('forecastTag says when the pool runs dry, or how much resets unused', () => {
  assert.equal(forecastTag(FORECAST, tClock, tSpan), 'Dry T+41h · 30h before refill');
  assert.equal(forecastTag({ ...FORECAST, poolDryAt: null, unusedPct: 38.4 }, tClock, tSpan), '~38% resets unused');
  assert.equal(forecastTag({ verdict: null }, tClock, tSpan), '');
});

test('forecastCaption flags thin history and an idle fleet', () => {
  assert.equal(forecastCaption(FORECAST), '');
  assert.equal(forecastCaption({ ...FORECAST, confidence: 'low', spanHours: 3 }), 'Low confidence · 3h of history');
  assert.equal(forecastCaption({ ...FORECAST, burnRate: 0, pace: 0 }), 'No burn in the last 24h');
});

test('forecastEmptyText says why there is no chart', () => {
  assert.equal(forecastEmptyText(null, null), 'Loading forecast…');
  assert.equal(forecastEmptyText(null, 'status 500'), 'Forecast unavailable: status 500');
  assert.equal(forecastEmptyText({ verdict: null, reason: 'no-quota' }, null), 'No weekly quota seen yet — probe quotas');
  assert.equal(forecastEmptyText({ verdict: null, reason: 'no-capacity' }, null), 'No Claude subscription to forecast');
});

test('cardForecastLines: drains, resets unused, and the session for a serving account', () => {
  assert.deepEqual(cardForecastLines(FORECAST.accounts[0], true, FC_NOW, tClock, tSpan), ['↳ drains ~T+31h', '↳ session hits in ~1h']);
  assert.deepEqual(cardForecastLines(FORECAST.accounts[0], false, FC_NOW, tClock, tSpan), ['↳ drains ~T+31h']);
  assert.deepEqual(cardForecastLines(FORECAST.accounts[1], true, FC_NOW, tClock, tSpan), ['↳ resets with 38% unused']);
  assert.deepEqual(cardForecastLines({ ...FORECAST.accounts[0], drainsAt: FC_NOW }, false, FC_NOW, tClock, tSpan), ['↳ spent until T+71h']);
  assert.deepEqual(cardForecastLines(null, true, FC_NOW, tClock, tSpan), []);
});

test('forecastPopup writes every section', () => {
  const p = forecastPopup(FORECAST, tClock, tSpan);
  assert.equal(p.verdict[0], 'Overusing at 1.4× — the fleet spends 20% of its weekly capacity a day (on pace is about 14%).');
  assert.equal(p.verdict[1], 'At this rate every account is spent by T+41h, 30h before the next refill.');
  assert.equal(p.verdict[2], 'Rate measured over the last 24h (high confidence).');
  assert.equal(p.how.length, 3);
  assert.ok(p.how[1].includes('resets soonest'));
  assert.deepEqual(p.accounts[0], { name: 'a@x', tier: 'Max 20x', weekly: '71%', resets: 'T+71h', outlook: 'drains T+31h' });
  assert.deepEqual(p.accounts[1], { name: 'b@x', tier: 'Max 5x', weekly: '20%', resets: 'T+20h', outlook: '38% unused at reset' });
  assert.deepEqual(p.notForecast, ['k@x — not forecast (unknown tier)']);
  assert.deepEqual(p.users[0], { name: 'alice', share: 0.48, shareText: '48%', fairText: '2.1×', heavy: true, without: 'Without alice: no dry spell this week' });
  assert.equal(p.users[1].without, 'Without bob: dry T+50h');
  assert.deepEqual(p.scoped, ['Fable weekly: On pace 0.6× — about 12% resets unused']);
  assert.equal(forecastPopup({ verdict: null }, tClock, tSpan), null);
});

test('explainRequest posts with the page key; explainOutcome reads the answer or the refusal', () => {
  assert.deepEqual(explainRequest('tc-k'), { url: '/teamclaude/forecast/explain', init: { method: 'POST', headers: { 'x-api-key': 'tc-k' } } });
  assert.deepEqual(explainOutcome({ ok: true, status: 200, body: { ok: true, text: 'Because.', generatedAt: 5, cached: true } }), { text: 'Because.', at: 5, cached: true });
  assert.deepEqual(explainOutcome({ ok: false, status: 403, body: { ok: false, error: 'a client key cannot ask for a forecast explanation' } }), { error: 'Only an operator can ask for an explanation.' });
  assert.deepEqual(explainOutcome({ ok: false, status: 503, body: { ok: false, error: 'Claude Code CLI not found on the server' } }), { error: 'Claude Code CLI not found on the server' });
  assert.deepEqual(explainOutcome({ ok: false, status: 502, body: null }), { error: 'Explain failed (status 502)' });
});

test('viewerCan offers Explain to the operator only', () => {
  assert.equal(viewerCan({ role: 'operator' }, 'explain'), true);
  assert.equal(viewerCan({ role: 'tenant' }, 'explain'), false);
  assert.equal(viewerCan({ role: 'readonly' }, 'explain'), false);
});
```

In the test `'the page ships the same helper implementations it is tested against'`, add to its array: `forecastGeometry, verdictChip, forecastTag, forecastCaption, forecastEmptyText, cardForecastLines, forecastPopup, explainRequest, explainOutcome`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/dashboard.test.js`
Expected: FAIL — `forecastGeometry` (and the others) are not exported.

- [ ] **Step 3: Write the helpers**

In `src/dashboard.js`, immediately after the closing `}` of `smoothPath`, add:

```js
// The usage forecast in the hero (GET /teamclaude/forecast): the fleet's weekly
// meter over the last day, then the projection until every account has
// refilled once, on one linear time axis across the chart's 400×190 box — used
// fraction 0 at the bottom (y 182), 1 at the top (y 12). Straight segments, not
// smoothPath: a reset is a vertical drop, and a curve would round it off.
/**
 * @param {any} f  the forecast payload
 * @returns {null|{ start: number, end: number, now: number, past: string, pastArea: string, projected: string, nowPct: number, dryPct: number|null, resets: number[], tagPct: { left: number, top: number }|null }}
 */
export function forecastGeometry(f) {
  if (!f || !f.series) return null;
  /** @type {Array<[number, number]>} */
  var past = f.series.past || [];
  /** @type {Array<[number, number]>} */
  var proj = f.series.projected || [];
  if (!past.length && !proj.length) return null;
  var now = f.generatedAt;
  var start = now - 86400000;
  var end = proj.length ? proj[proj.length - 1][0] : now;
  if (end <= start) end = start + 1;
  var r = function (/** @type {number} */ v) { return Math.round(v * 100) / 100; };
  var X = function (/** @type {number} */ t) { return (t - start) / (end - start) * 400; };
  var Y = function (/** @type {number} */ v) { return 182 - Math.max(0, Math.min(1, v)) * 170; };
  var line = function (/** @type {Array<[number, number]>} */ pts) {
    return pts.map(function (p, i) { return (i ? 'L' : 'M') + r(X(p[0])) + ',' + r(Y(p[1])); }).join(' ');
  };
  var pastD = line(past);
  /** @type {number[]} */
  var resets = [];
  for (var i = 1; i < proj.length; i++) {
    if (proj[i][0] === proj[i - 1][0] && proj[i][1] < proj[i - 1][1]) resets.push(r(X(proj[i][0]) / 4));
  }
  var dryPct = f.threshold != null ? r(Y(f.threshold) / 190 * 100) : null;
  return {
    start: start,
    end: end,
    now: now,
    past: pastD,
    pastArea: past.length > 1 ? pastD + ' L' + r(X(past[past.length - 1][0])) + ',190 L' + r(X(past[0][0])) + ',190 Z' : '',
    projected: line(proj),
    nowPct: r(X(now) / 4),
    dryPct: dryPct,
    resets: resets,
    tagPct: f.poolDryAt != null ? { left: r(X(f.poolDryAt) / 4), top: dryPct != null ? dryPct : 0 } : null,
  };
}

// The forecast's verdict as the chip above the chart: coral when the fleet is
// running out, amber when it is paying for capacity it leaves unused.
/** @param {any} f @returns {{ text: string, tone: string }|null} */
export function verdictChip(f) {
  if (!f || !f.verdict) return null;
  var pace = (f.pace || 0).toFixed(1) + '×';
  if (f.verdict === 'overusing') return { text: 'Overusing ' + pace, tone: 'bad' };
  if (f.verdict === 'underusing') return { text: 'Underusing ' + pace, tone: 'warn' };
  return { text: 'On pace ' + pace, tone: '' };
}

// The chart's one label. `clock` formats an instant and `span` a duration in
// ms — passed in, so the wording is tested without the browser's locale.
/**
 * @param {any} f
 * @param {(t: number) => string} clock
 * @param {(ms: number) => string} span
 */
export function forecastTag(f, clock, span) {
  if (!f || !f.verdict) return '';
  if (f.poolDryAt != null) return 'Dry ' + clock(f.poolDryAt) + (f.dryForMs != null ? ' · ' + span(f.dryForMs) + ' before refill' : '');
  return '~' + Math.round(f.unusedPct || 0) + '% resets unused';
}

// A line under the chip when the numbers deserve a caveat.
/** @param {any} f */
export function forecastCaption(f) {
  if (!f || !f.verdict) return '';
  if (f.confidence === 'low') return 'Low confidence · ' + f.spanHours + 'h of history';
  if (!(f.burnRate > 0)) return 'No burn in the last ' + f.spanHours + 'h';
  return '';
}

// Why the chart is empty.
/** @param {any} f @param {string|null} error */
export function forecastEmptyText(f, error) {
  if (error) return 'Forecast unavailable: ' + error;
  if (!f) return 'Loading forecast…';
  if (f.reason === 'no-capacity') return 'No Claude subscription to forecast';
  if (f.reason === 'no-quota') return 'No weekly quota seen yet — probe quotas';
  return '';
}

// The lines under an account card's Weekly meter, from its row in the
// forecast: when it drains, or what it leaves at its reset — and, for the
// account taking traffic now, when its session runs out.
/**
 * @param {any} row  a forecast.accounts entry
 * @param {boolean} serving
 * @param {number} now
 * @param {(t: number) => string} clock
 * @param {(ms: number) => string} span
 * @returns {string[]}
 */
export function cardForecastLines(row, serving, now, clock, span) {
  /** @type {string[]} */
  var out = [];
  if (!row) return out;
  if (row.drainsAt != null && (row.reset == null || row.drainsAt < row.reset)) {
    out.push(row.drainsAt <= now ? '↳ spent until ' + (row.reset != null ? clock(row.reset) : 'its reset') : '↳ drains ~' + clock(row.drainsAt));
  } else if (row.unusedAtReset != null && row.unusedAtReset >= 0.01) {
    out.push('↳ resets with ' + Math.round(row.unusedAtReset * 100) + '% unused');
  }
  if (serving && row.sessionHitsAt != null && row.sessionHitsAt > now) out.push('↳ session hits in ~' + span(row.sessionHitsAt - now));
  return out;
}

// The ? dialog's text, section by section, so the page only lays it out and
// the wording is tested here. Null when there is no forecast to break down.
/**
 * @param {any} f
 * @param {(t: number) => string} clock
 * @param {(ms: number) => string} span
 * @returns {null|{ verdict: string[], how: string[], accounts: Array<{ name: string, tier: string, weekly: string, resets: string, outlook: string }>, notForecast: string[], users: Array<{ name: string, share: number, shareText: string, fairText: string, heavy: boolean, without: string }>, scoped: string[] }}
 */
export function forecastPopup(f, clock, span) {
  if (!f || !f.verdict) return null;
  var pct = function (/** @type {number} */ v) { return Math.round(v * 100) + '%'; };
  var tier = function (/** @type {number} */ w) { return w >= 20 ? 'Max 20x' : w >= 5 ? 'Max 5x' : w === 1 ? 'Pro' : w + '×'; };
  var word = function (/** @type {string} */ v) { return v === 'overusing' ? 'Overusing' : v === 'underusing' ? 'Underusing' : 'On pace'; };
  /** @type {Record<string, string>} */
  var orders = {
    'soonest-reset': 'the account whose week resets soonest goes first, as the router picks',
    'least-remaining': 'the account with the least left goes first (adaptive distribution)',
    'proportional': 'accounts of one priority share it by plan size (distributed sessions)',
  };
  var perDay = f.fleetCapacity > 0 ? Math.round(f.burnRate * 24 / f.fleetCapacity * 1000) / 10 : 0;
  var verdict = [
    word(f.verdict) + ' at ' + (f.pace || 0).toFixed(1) + '× — the fleet spends ' + perDay + '% of its weekly capacity a day (on pace is about 14%).',
    f.poolDryAt != null
      ? 'At this rate every account is spent by ' + clock(f.poolDryAt) + (f.dryForMs != null ? ', ' + span(f.dryForMs) + ' before the next refill.' : '.')
      : 'About ' + Math.round(f.unusedPct || 0) + "% of a week's capacity resets unused.",
    f.confidence === 'low'
      ? 'Low confidence: ' + f.spanHours + "h of history, so the rate is each account's average since its last reset."
      : 'Rate measured over the last ' + f.spanHours + 'h (' + f.confidence + ' confidence).',
  ];
  var how = [
    "Burn rate: how far every account's weekly meter rose over that window, weighted by plan (Pro 1, Max 5x 5, Max 20x 20).",
    'Drain order: ' + (orders[f.strategy] || f.strategy) + '; an account at its auto-switch threshold is skipped.',
    'Each account refills at its weekly reset, and whatever it had left then counts as unused.',
  ];
  var accounts = (f.accounts || []).map(function (/** @type {any} */ a) {
    var outlook = '—';
    if (a.drainsAt != null && (a.reset == null || a.drainsAt < a.reset)) outlook = a.drainsAt <= f.generatedAt ? 'spent until reset' : 'drains ' + clock(a.drainsAt);
    else if (a.unusedAtReset != null) outlook = pct(a.unusedAtReset) + ' unused at reset';
    return { name: a.name, tier: tier(a.weight), weekly: pct(a.u || 0), resets: a.reset != null ? clock(a.reset) : '—', outlook: outlook };
  });
  var notForecast = (f.notForecast || []).map(function (/** @type {any} */ n) { return n.name + ' — not forecast (' + n.reason + ')'; });
  var users = (f.users || []).map(function (/** @type {any} */ u) {
    var without = '';
    if ('withoutThemDryAt' in u) without = 'Without ' + u.name + ': ' + (u.withoutThemDryAt == null ? 'no dry spell this week' : 'dry ' + clock(u.withoutThemDryAt));
    return { name: u.name, share: u.share, shareText: pct(u.share), fairText: u.fairShareX == null ? '—' : u.fairShareX.toFixed(1) + '×', heavy: !!u.heavy, without: without };
  });
  var scoped = (f.scoped || []).map(function (/** @type {any} */ s) {
    var name = String(s.bucket).charAt(0).toUpperCase() + String(s.bucket).slice(1);
    return name + ' weekly: ' + word(s.verdict) + ' ' + (s.pace || 0).toFixed(1) + '× — '
      + (s.poolDryAt != null ? 'dry ' + clock(s.poolDryAt) : 'about ' + Math.round(s.unusedPct || 0) + '% resets unused');
  });
  return { verdict: verdict, how: how, accounts: accounts, notForecast: notForecast, users: users, scoped: scoped };
}

// Explain's request: POST /teamclaude/forecast/explain with the page's key,
// which the server hands to the claude CLI so the spend is booked to whoever
// asked.
/** @param {string|null|undefined} key */
export function explainRequest(key) {
  return { url: '/teamclaude/forecast/explain', init: { method: 'POST', headers: { 'x-api-key': key || '' } } };
}

// What Explain shows: the answer, or why there is none.
/**
 * @param {{ ok: boolean, status: number, body: any }} res
 * @returns {{ text?: string, at?: number, cached?: boolean, error?: string }}
 */
export function explainOutcome(res) {
  var b = res && res.body;
  if (res && res.ok && b && b.ok && b.text) return { text: String(b.text), at: Number(b.generatedAt) || Date.now(), cached: !!b.cached };
  if (res && res.status === 403) return { error: 'Only an operator can ask for an explanation.' };
  return { error: b && b.error ? String(b.error) : 'Explain failed (status ' + (res ? res.status : '?') + ')' };
}
```

In the comment above `viewerCan`, change `'rotate'.` in the list of actions to `'rotate' or 'explain' (operator only: it spends quota).`

In `SHARED_HELPERS`, append to the array (after `dayTicks,`):

```js
  forecastGeometry, verdictChip, forecastTag, forecastCaption, forecastEmptyText, cardForecastLines, forecastPopup, explainRequest, explainOutcome,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test test/dashboard.test.js`
Expected: PASS. If `forecastGeometry`'s numbers differ, recompute: x = (t − start)/(96h)·400 and y = 182 − v·170 (e.g. v = 0.3 → 131, v = 0.5 → 97, 0.98 → 15.4, which is 8.11% of 190).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: all pass; `src/dashboard.js` gains no strict diagnostics (every new parameter is typed).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.js test/dashboard.test.js
git commit -m "feat(dashboard): forecast chart geometry, labels and breakdown helpers"
```

---

### Task 9: Dashboard page — hero chart, `?` popup, Explain, card lines (`src/dashboard.js`)

**Files:**
- Modify: `src/dashboard.js` — CSS (`.groups-wrap` … `.range` block at lines ~1517–1533, `.intro .grp-bars i` at ~1433, `.avg-pill` media rule at ~1909); `GROUP_SLOTS` constant (~1388); hero markup `#clientChartWrap` (~1979); dialogs (before `<div id="settingsWrap"`, ~2233); page state vars (~2303); `renderGroups`/`rangeStartText` (~3606, ~3717); `renderAccount` Weekly meter (~2657); `render()` (~4523); `poll()` (~4788); dialog close handlers (~4945); `clientGroups` export (~394) and its `SHARED_HELPERS` entry
- Test: `test/dashboard.test.js` — harness (`bootPage`), hero tests, new page tests

**Interfaces:**
- Consumes: the Task 8 helpers; `GET /teamclaude/forecast`, `POST /teamclaude/forecast/explain` (Task 5).
- Produces: element ids `forecastWrap`, `fcChip`, `fcCaption`, `fcHelp`, `fcPlot`, `fcPast`, `fcPastArea`, `fcProj`, `fcDry`, `fcNow`, `fcResets`, `fcTag`, `fcEmpty`, `fcStart`, `fcNowLbl`, `fcEnd`, `fcWrap`, `fcClose`, `fcBody`; card line class `fc-card`.

- [ ] **Step 1: Update the page-test harness and write the failing page tests**

In `test/dashboard.test.js`, inside `bootPage`, replace the block:

```js
  const isSeries = r => r.url.startsWith('/teamclaude/usage/series');
  const isMonth = r => r.url === '/teamclaude/usage/series?span=month';
```

with:

```js
  const isSeries = r => r.url.startsWith('/teamclaude/usage/series');
  const isMonth = r => r.url === '/teamclaude/usage/series?span=month';
  // The forecast is a fetch of its own too, sent after the first status.
  const isForecast = r => r.url === '/teamclaude/forecast';
  const isAux = r => isSeries(r) || isForecast(r);
```

Replace `const answer = (status, body = {}) => settle(requests.findIndex(r => !isSeries(r)), status, body);` with:

```js
  const answer = (status, body = {}) => settle(requests.findIndex(r => !isAux(r)), status, body);
  const answerForecast = (body, status = 200) => settle(requests.findIndex(isForecast), status, body);
```

Replace `const pending = () => requests.filter(r => !isSeries(r));` with `const pending = () => requests.filter(r => !isAux(r));`.

After the `valued` helper add:

```js
  // The text of what the page built with this class, since the last click.
  const classed = cls => built.slice(mark).filter(e => e.className === cls).map(e => e.textContent);
```

And add `answerForecast, classed` to the object `bootPage` returns.

Update the comment above `isSeries` to: `// The chart's history and the forecast are fetches of their own, sent after a status. `answer` resolves the oldest request that is NEITHER, so a test about the controls reads the same whether or not a chart is on the page; `answerSeries`, `answerMonth` and `answerForecast` resolve them.`

Now edit the existing hero tests:

1. In `'the overview draws a column per client and switches measure without polling'`: rename it `'the overview shows every client\'s traffic and switches measure without polling'`; delete the lines asserting `clientChartWrap`, `grp0Name`, `grp0Val`, `grp0Pct`, `grp1Name`, `grp2`, and `grp0.title`; change `assert.equal(page.labelled('alice'), 4);` and its comment to `// Named by its Clients row, and its Usage by user row and legend.` / `assert.equal(page.labelled('alice'), 3);`. Keep the `heroMain`, `heroLabel`, `heroSplit` and `pending()` assertions.
2. Delete the test `'the Most used chart stays hidden until a client key has been used'`.
3. In the test that asserts `rangeStart` is `'24 hours ago'` and `'All time'`, delete those two `rangeStart` assertions.
4. In the month test, delete `assert.equal(page.byId('rangeStart').textContent, 'The 1st');`.
5. In `'no client, no chart and no series fetch'`, delete `assert.equal(page.byId('clientChartWrap').style.display, 'none');`.
6. In `'the chart helpers run inside the serialized bundle'`, replace `clientGroups` in the returned names with `forecastGeometry`, and replace the line `assert.deepEqual(isolated.clientGroups([{ name: 'a', value: 2 }]), clientGroups([{ name: 'a', value: 2 }]));` with `assert.deepEqual(isolated.forecastGeometry(FORECAST), forecastGeometry(FORECAST));` (`FORECAST` is the fixture Task 8 put near the top of the file).
7. Delete the two `clientGroups` unit tests (`'clientGroups gives the two busiest a column each and folds the rest'`, `'clientGroups never folds a single client'`), remove `clientGroups` from the import list and from the `'the page ships…'` array.

Append these page tests:

```js
test('the hero asks for the forecast after the first status and draws it', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  const req = page.requests.find(r => r.url === '/teamclaude/forecast');
  assert.ok(req, 'the forecast is fetched');
  assert.equal(req.init.headers['x-api-key'], '', 'with the same key as the status poll');
  assert.equal(page.byId('fcEmpty').textContent, 'Loading forecast…');
  await page.answerForecast(FORECAST);
  assert.equal(page.byId('forecastWrap').style.display, '');
  assert.equal(page.byId('fcChip').textContent, 'Overusing 1.4×');
  assert.equal(page.byId('fcChip').className, 'fc-chip bad');
  assert.equal(page.byId('fcEmpty').style.display, 'none');
  assert.ok(page.byId('fcTag').textContent.startsWith('Dry '));
  assert.equal(page.byId('fcHelp').style.display, '');
});

test('the forecast says why it is empty', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  await page.answerForecast({ verdict: null, reason: 'no-quota', series: { past: [], projected: [] } });
  assert.equal(page.byId('fcEmpty').textContent, 'No weekly quota seen yet — probe quotas');
  assert.equal(page.byId('fcHelp').style.display, 'none', 'nothing to break down');

  const failed = bootPage();
  await failed.answer(200, { accounts: [] });
  await failed.answerForecast({}, 500);
  assert.equal(failed.byId('fcEmpty').textContent, 'Forecast unavailable: status 500');
});

test('the ? opens the breakdown, and Explain posts with the page key for an operator', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], viewer: { client: null, role: 'operator' } });
  await page.answerForecast(FORECAST);
  page.byId('fcHelp').fire('click');
  assert.equal(page.byId('fcWrap').style.display, '');
  assert.equal(page.labelled('How this is worked out'), 1);
  assert.equal(page.labelled('a@x'), 1, 'the accounts table');
  assert.equal(page.labelled('Without alice: no dry spell this week'), 1);
  page.click('Explain ✦');
  const req = page.pending().find(r => r.url === '/teamclaude/forecast/explain');
  assert.ok(req, 'Explain posts');
  assert.equal(req.init.method, 'POST');
  assert.equal(page.labelled('Asking Claude…'), 1);
  await page.answer(200, { ok: true, text: 'The pool runs out on Thursday.', generatedAt: Date.now(), cached: false });
  assert.equal(page.labelled('The pool runs out on Thursday.'), 1);
  page.keydown('Escape');
  assert.equal(page.byId('fcWrap').style.display, 'none');
});

test('a tenant sees the breakdown but no Explain', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], viewer: { client: 'alice', role: 'tenant' } });
  await page.answerForecast(FORECAST);
  page.byId('fcHelp').fire('click');
  assert.equal(page.labelled('How this is worked out'), 1);
  assert.equal(page.labelled('Explain ✦'), 0);
});

test('an account card says when it drains once the forecast lands', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'a@x', provider: 'anthropic', quota: { unified5h: 0.1, unified7d: 0.71, unified7dReset: FC_NOW + 71 * FC_HOUR } }] });
  await page.answerForecast({ ...FORECAST, generatedAt: Date.now(), accounts: [{ ...FORECAST.accounts[0], drainsAt: Date.now() + 31 * FC_HOUR, reset: Date.now() + 71 * FC_HOUR }] });
  const lines = page.classed('fc-card');
  assert.equal(lines.length, 1, String(lines));
  assert.ok(lines[0].startsWith('↳ drains ~'), lines[0]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/dashboard.test.js`
Expected: FAIL — no `/teamclaude/forecast` request is made, `fcChip` is empty, `fcHelp` has no click listener.

- [ ] **Step 3: Remove the client bar chart**

In `src/dashboard.js`:

- Delete the exported `clientGroups` function and the comment block directly above it (the function at `export function clientGroups(ranking) {`).
- Remove `clientGroups, ` from the `SHARED_HELPERS` array.
- Delete the `GROUP_SLOTS` constant (`const GROUP_SLOTS = [0, 1, 2].map(i => \`…\`).join('');`).
- Delete these CSS rules: `.intro .grp-bars i { … }`, `.groups-wrap { … }`, `.groups { … }`, `.avg-line { … }`, `.avg-pill { … }`, every `.grp…` rule, `.groups-empty { … }`, and in the mobile media query `.avg-pill { right: 8%; }`. Keep `.range { … }` only if another element still uses `class="range"` (`grep -n 'class="range"' src/dashboard.js`); otherwise delete it too.
- Replace the whole `<div class="groups-wrap" id="clientChartWrap" style="display:none"> … </div>` block (it ends after `<div class="range"><span id="rangeStart">All time</span><span>now</span></div>` and its closing `</div>`) with the forecast markup from Step 4.
- Delete the `rangeStartText()` function and the `renderGroups(s)` function (with its comment), and the `renderGroups(s);` call in `render()`.

- [ ] **Step 4: Add the hero chart markup and the dialog**

In place of the removed `#clientChartWrap` block:

```html
        <div class="fc-wrap" id="forecastWrap">
          <div class="fc-head">
            <span class="fc-chip" id="fcChip" style="display:none"></span>
            <span class="fc-cap" id="fcCaption"></span>
            <button id="fcHelp" class="icon-btn sm" type="button" title="How this forecast is worked out" aria-label="Forecast breakdown" style="display:none">?</button>
          </div>
          <div class="fc-plot" id="fcPlot">
            <svg viewBox="0 0 400 190" preserveAspectRatio="none" aria-hidden="true">
              <defs><linearGradient id="fcArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ga"></stop><stop offset="1" class="gb"></stop></linearGradient></defs>
              <path id="fcPastArea" fill="url(#fcArea)" d=""></path>
              <path id="fcPast" vector-effect="non-scaling-stroke" d=""></path>
              <path id="fcProj" vector-effect="non-scaling-stroke" d=""></path>
            </svg>
            <div class="fc-dry" id="fcDry" style="display:none"><span>dry</span></div>
            <div class="fc-now" id="fcNow" style="display:none"></div>
            <div class="fc-resets" id="fcResets" aria-hidden="true"></div>
            <div class="tag fc-tag" id="fcTag" style="display:none"></div>
            <div class="plot-empty" id="fcEmpty" style="display:flex">Loading forecast…</div>
          </div>
          <div class="fc-range"><span id="fcStart">24h ago</span><span id="fcNowLbl">now</span><span id="fcEnd"></span></div>
        </div>
```

Immediately before `<div id="settingsWrap" class="scrim" style="display:none">`, add the dialog:

```html
  <div id="fcWrap" class="scrim" style="display:none">
    <section class="dialog fc-dlg" role="dialog" aria-modal="true" aria-labelledby="fcTitle">
      <div class="dlg-head">
        <div class="dlg-title" id="fcTitle">Weekly forecast</div>
        <button id="fcClose" class="icon-btn sm" type="button" title="Close" aria-label="Close">×</button>
      </div>
      <div id="fcBody" class="fc-body"></div>
    </section>
  </div>
```

- [ ] **Step 5: Add the CSS**

Where the removed `.groups-wrap` rules were, add:

```css
  .fc-wrap { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .fc-head { display: flex; align-items: center; gap: 10px; min-height: 28px; }
  .fc-chip { height: 24px; padding: 0 10px; border-radius: 999px; background: var(--bg-pill); color: var(--text); font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; white-space: nowrap; }
  .fc-chip.bad { background: var(--coral-soft); color: var(--coral-text); }
  .fc-chip.warn { color: var(--amber); }
  .fc-cap { flex: 1; min-width: 0; font-size: 12px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fc-head .icon-btn { margin-left: auto; font-weight: 600; }
  .fc-plot { position: relative; height: 190px; }
  .fc-plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .fc-plot path { transition: d .6s cubic-bezier(.2,.8,.2,1); }
  #fcPast { fill: none; stroke: var(--area); stroke-width: 2; }
  #fcProj { fill: none; stroke: var(--area); stroke-width: 2; stroke-dasharray: 5 5; opacity: .75; }
  .fc-dry { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--coral); pointer-events: none; }
  .fc-dry span { position: absolute; right: 0; top: -18px; font-size: 11px; color: var(--coral-text); }
  .fc-now { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--col-line); pointer-events: none; }
  .fc-resets i { position: absolute; bottom: 0; width: 1px; height: 8px; background: var(--dash-2); }
  .fc-tag { position: absolute; transform: translate(8px, -50%); pointer-events: none; }
  .fc-tag.flip { transform: translate(calc(-100% - 8px), -50%); }
  .fc-range { position: relative; height: 18px; font-size: 12px; color: var(--muted); }
  .fc-range span { position: absolute; top: 0; white-space: nowrap; }
  #fcStart { left: 0; } #fcEnd { right: 0; } #fcNowLbl { transform: translateX(-50%); }
  .fc-card { font-size: 12px; color: var(--muted); margin-top: -6px; }
  .fc-dlg { max-width: 640px; }
  .fc-body { display: flex; flex-direction: column; gap: 18px; }
  .fc-sec { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .fc-sec-title { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .fc-lead { font-size: 15px; color: var(--text); }
  .fc-line { font-size: 13px; line-height: 1.5; color: var(--text-2); }
  .fc-line.dim { color: var(--dim); } .fc-line.err { color: var(--coral-text); }
  .fc-tbl { min-width: 0; font-size: 13px; }
  .fc-user { display: grid; grid-template-columns: minmax(0, 1fr) 90px 44px 44px auto; gap: 10px; align-items: center; font-size: 13px; }
  .fc-uname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fc-track { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
  .fc-track i { display: block; height: 100%; background: var(--area); }
  .fc-heavy { font-size: 11px; color: var(--coral-text); }
  .fc-explain { font-size: 14px; line-height: 1.6; color: var(--text); }
  @media (max-width: 520px) { .fc-user { grid-template-columns: minmax(0, 1fr) 44px 44px auto; } .fc-track { display: none; } }
```

- [ ] **Step 6: Add the page state and rendering**

Next to the other page state (`var keyDialogOpen = false;`), add:

```js
  // The forecast (GET /teamclaude/forecast): the last one fetched, why the last
  // fetch failed, whether one is in flight and when it was sent — it is asked
  // for at most once a minute, since it moves with quota readings taken every
  // 15 minutes, not with every status poll. And the ? dialog: whether it is
  // open, and Explain's state ({ busy } while asking, then { text, at, cached }
  // or { error }).
  var lastForecast = null;
  var forecastError = null;
  var forecastInFlight = false;
  var forecastAt = 0;
  var forecastOpen = false;
  var explainState = null;
```

Before the `// ── Charts ──` section comment (where `renderGroups` used to be), add:

```js
  // ── Forecast ─────────────────────────────────────────────────────────────

  function fcClock(t) { return fmtClock(t); }
  function fcSpan(ms) { return fmtIn(ms / 1000); }

  function pollForecast() {
    if (forecastInFlight || Date.now() - forecastAt < 60000) return;
    forecastInFlight = true;
    forecastAt = Date.now();
    fetch('/teamclaude/forecast', { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (json) { lastForecast = json; forecastError = null; })
      .catch(function (e) { forecastError = e.message; })
      .then(function () {
        forecastInFlight = false;
        // The account cards carry forecast lines too, so the whole page is
        // drawn again from the last status rather than only the chart.
        if (lastStatus) render(lastStatus);
        else renderForecast();
      });
  }

  function forecastRow(a) {
    var rows = lastForecast && lastForecast.accounts ? lastForecast.accounts : [];
    return rows.filter(function (r) { return r.name === a.name; })[0] || null;
  }

  // The hero's right-hand side: the verdict chip, the chart and its one label.
  function renderForecast() {
    var f = lastForecast;
    byId('forecastWrap').style.display = '';
    var chip = verdictChip(f);
    var chipEl = byId('fcChip');
    chipEl.textContent = chip ? chip.text : '';
    chipEl.className = 'fc-chip' + (chip && chip.tone ? ' ' + chip.tone : '');
    chipEl.style.display = chip ? '' : 'none';
    byId('fcCaption').textContent = forecastCaption(f);
    byId('fcHelp').style.display = f && f.verdict ? '' : 'none';
    var g = f && f.verdict ? forecastGeometry(f) : null;
    var empty = byId('fcEmpty');
    empty.textContent = g ? '' : forecastEmptyText(f, forecastError);
    empty.style.display = g ? 'none' : 'flex';
    byId('fcPast').setAttribute('d', g ? g.past : '');
    byId('fcPastArea').setAttribute('d', g ? g.pastArea : '');
    byId('fcProj').setAttribute('d', g ? g.projected : '');
    var dry = byId('fcDry');
    if (g && g.dryPct != null) { dry.style.top = g.dryPct + '%'; dry.style.display = ''; } else dry.style.display = 'none';
    var nowEl = byId('fcNow');
    if (g) { nowEl.style.left = g.nowPct + '%'; nowEl.style.display = ''; } else nowEl.style.display = 'none';
    var resets = byId('fcResets');
    resets.textContent = '';
    if (g) g.resets.forEach(function (x) { var tick = el('i'); tick.style.left = x + '%'; resets.appendChild(tick); });
    var tag = byId('fcTag');
    var text = g ? forecastTag(f, fcClock, fcSpan) : '';
    if (text) {
      var left = g.tagPct ? g.tagPct.left : 100;
      tag.textContent = text;
      tag.style.left = left + '%';
      tag.style.top = (g.tagPct ? g.tagPct.top : 12) + '%';
      tag.className = 'tag fc-tag' + (left > 60 ? ' flip' : '');
      tag.style.display = '';
    } else tag.style.display = 'none';
    byId('fcNowLbl').style.left = g ? g.nowPct + '%' : '0';
    byId('fcNowLbl').style.display = g ? '' : 'none';
    byId('fcEnd').textContent = g ? fcClock(g.end) : '';
    if (forecastOpen) buildForecastPopup();
  }

  function openForecast() {
    if (!lastForecast || !lastForecast.verdict) return;
    forecastOpen = true;
    buildForecastPopup();
    byId('fcWrap').style.display = '';
  }

  function closeForecast() {
    forecastOpen = false;
    byId('fcWrap').style.display = 'none';
  }

  // The ? dialog, laid out from forecastPopup's text.
  function buildForecastPopup() {
    var p = forecastPopup(lastForecast, fcClock, fcSpan);
    var body = byId('fcBody');
    body.textContent = '';
    if (!p) { closeForecast(); return; }
    var section = function (title) {
      var s = el('div', 'fc-sec');
      if (title) s.appendChild(el('div', 'fc-sec-title', title));
      body.appendChild(s);
      return s;
    };
    var head = section(null);
    p.verdict.forEach(function (line, i) { head.appendChild(el('p', i ? 'fc-line' : 'fc-lead', line)); });
    var how = section('How this is worked out');
    p.how.forEach(function (line) { how.appendChild(el('p', 'fc-line', line)); });
    if (p.accounts.length || p.notForecast.length) {
      var acc = section('Accounts');
      var table = el('table', 'fc-tbl');
      var hr = el('tr');
      ['Account', 'Plan', 'Weekly', 'Resets', 'Outlook'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
      table.appendChild(hr);
      p.accounts.forEach(function (r) {
        var tr = el('tr');
        [r.name, r.tier, r.weekly, r.resets, r.outlook].forEach(function (c) { tr.appendChild(el('td', '', c)); });
        table.appendChild(tr);
      });
      var wrap = el('div', 'tbl-wrap');
      wrap.appendChild(table);
      acc.appendChild(wrap);
      p.notForecast.forEach(function (line) { acc.appendChild(el('p', 'fc-line dim', line)); });
    }
    if (p.users.length) {
      var us = section('Users · last 24h');
      us.appendChild(el('p', 'fc-line dim', 'Each one\'s share of the weekly quota spent, and that share against an even split.'));
      p.users.forEach(function (u) {
        var row = el('div', 'fc-user');
        row.appendChild(el('span', 'fc-uname', u.name));
        var track = el('span', 'fc-track');
        var fill = el('i');
        fill.style.width = Math.round(u.share * 100) + '%';
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el('span', '', u.shareText));
        row.appendChild(el('span', '', u.fairText));
        row.appendChild(el('span', 'fc-heavy', u.heavy ? 'heavy' : ''));
        us.appendChild(row);
        if (u.without) us.appendChild(el('p', 'fc-line dim', u.without));
      });
    }
    if (p.scoped.length) {
      var sc = section('Model caps');
      p.scoped.forEach(function (line) { sc.appendChild(el('p', 'fc-line', line)); });
    }
    if (viewerCan(lastStatus && lastStatus.viewer, 'explain')) buildExplain(section('Explain'));
  }

  function buildExplain(sec) {
    var st = explainState || {};
    if (st.text) {
      sec.appendChild(el('p', 'fc-explain', st.text));
      sec.appendChild(el('p', 'fc-line dim', 'Claude Haiku · ' + fmtAgo(st.at) + (st.cached ? ' · cached' : '')));
    }
    if (st.error) sec.appendChild(el('p', 'fc-line err', st.error));
    var fresh = !!st.text && Date.now() - st.at < 15 * 60000;
    var btn = el('button', 'pill-btn md', st.busy ? 'Asking Claude…' : st.text ? 'Ask again' : 'Explain ✦');
    btn.type = 'button';
    btn.disabled = !!st.busy || fresh;
    if (fresh) btn.title = 'An answer is kept for 15 minutes';
    btn.addEventListener('click', askExplain);
    sec.appendChild(btn);
    if (!st.text && !st.busy) sec.appendChild(el('p', 'fc-line dim', 'Sends this forecast to Claude Haiku through the proxy. Each answer spends a little quota.'));
  }

  function askExplain() {
    if (explainState && explainState.busy) return;
    var prev = explainState || {};
    explainState = { busy: true, text: prev.text, at: prev.at, cached: prev.cached };
    buildForecastPopup();
    var r = explainRequest(localStorage.getItem(KEY) || '');
    fetch(r.url, r.init)
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      })
      .then(function (out) { explainState = explainOutcome(out); })
      .catch(function (e) { explainState = { error: 'Cannot reach the proxy: ' + e.message }; })
      .then(function () { if (forecastOpen) buildForecastPopup(); });
  }
```

In `renderAccount`, replace:

```js
      meters.appendChild(quotaMeter('Weekly', q.unified7d, q.unified7dReset));
```

with:

```js
      meters.appendChild(quotaMeter('Weekly', q.unified7d, q.unified7dReset));
      // Where the forecast has this account heading (forecastRow is by name).
      cardForecastLines(forecastRow(a), isCur, Date.now(), fcClock, fcSpan).forEach(function (line) {
        meters.appendChild(el('div', 'fc-card', line));
      });
```

In `render()`, where `renderGroups(s);` was, put `renderForecast();`.

In `poll()`, after `if (hasClients(s)) pollSeries();` add:

```js
        pollForecast();
```

Wire the dialog controls next to the other dialog listeners (by `byId('settingsWrap').addEventListener('click', …)`):

```js
  byId('fcHelp').addEventListener('click', openForecast);
  byId('fcClose').addEventListener('click', closeForecast);
  byId('fcWrap').addEventListener('click', function (e) { if (e && e.target === this) closeForecast(); });
```

And in the `keydown` Escape chain, add a final branch: `else if (forecastOpen) closeForecast();`.

- [ ] **Step 7: Run the dashboard tests**

Run: `bun run test test/dashboard.test.js`
Expected: PASS. If `'the page polls status before asking for a key…'` now sees 2 requests, the forecast fetch is firing before the first status — it must only be called from `poll()`'s success handler.

- [ ] **Step 8: Run the full suite, lint and typecheck**

Run: `bun run test && bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: all pass. The CSP hashes come from `dashboardCsp()` reading the page, so no manual hash update is needed; the `'dashboard page is self-contained'` test confirms nothing external was added.

- [ ] **Step 9: Look at it in a browser**

Start a throwaway server against the test fixtures or your local config: `bun run start -- server --headless` (or `node src/index.js server --headless`), open `http://127.0.0.1:3456/teamclaude/dashboard`, and check:
- the hero's right side shows the chart (or its empty-state text), no leftover client columns;
- `?` opens the dialog, Escape and the backdrop close it;
- at 375px wide (devtools device mode) nothing scrolls sideways; the dialog's user rows drop the bar;
- light and dark themes both read.
Stop the server by its PID (`kill <pid>`), never with a broad `pkill`.

- [ ] **Step 10: Commit**

```bash
git add src/dashboard.js test/dashboard.test.js
git commit -m "feat(dashboard): the weekly forecast in the hero, its breakdown and Explain"
```

---

### Task 10: Documentation and final verification

**Files:**
- Modify: `docs/usage.md` — the route list (line ~232), the dashboard overview paragraph (line ~236), a new `### Forecast` subsection at the end of `## Status dashboard (browser)` (before `## MCP endpoint`)

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing documentation.

- [ ] **Step 1: Update the route list**

In the `## Control routes under a second name` paragraph, change `` `status`, `quota`, `reload`, `switch`, `disable`, `priority`, `threshold`, `probe`, `dashboard` and `mcp` `` to `` `status`, `quota`, `forecast`, `reload`, `switch`, `disable`, `priority`, `threshold`, `probe`, `dashboard` and `mcp` ``.

- [ ] **Step 2: Update the overview paragraph**

In the first paragraph of `## Status dashboard (browser)`, replace `**Add account** and **Probe quotas**, and a column per client.` with `**Add account** and **Probe quotas**, and beside it the fleet's weekly **forecast** (see [Forecast](#forecast) below).`

- [ ] **Step 3: Add the Forecast subsection**

Before `## MCP endpoint`, add:

```markdown
### Forecast

The chart on the right of the overview answers "at this rate, when do we run out — or how much are we leaving unused?" for the shared weekly bucket of every enabled Claude subscription (Codex, API-key and third-party accounts are not forecast). The solid line is the fleet's weekly utilization over the last day; the dashed line is the projection until every account has refilled once, stepping down at each account's reset; the dashed coral line is the auto-switch threshold, where the pool is dry.

How it is worked out:

- **Unit.** Accounts are weighed by plan — Pro 1, Max 5x 5, Max 20x 20 — so 10% of a Max 20x account counts twice as much as 10% of a Max 5x one.
- **Burn rate.** The server samples every account's quota every 15 minutes and keeps two days, in the state file. The rate is how far the weighted meters rose over the last 24 hours. With 6–24 hours of samples it uses what it has (medium confidence); with less, each account's average since its last reset (low confidence, and the chart says so).
- **Pace** is the burn rate against the fleet's weekly capacity: 1.0× spends exactly a week's capacity per week.
- **Projection.** The fleet is run forward in 15-minute steps, draining accounts the way the router does — soonest weekly reset first by default, least remaining first under `distributeSessions: "adaptive"`, spread by plan size under `distributeSessions: true`, best `priority` first in every mode — and refilling each at its reset. What an account had left below its threshold at its reset is counted as unused.
- **Verdict.** *Overusing* when the pool runs dry before a refill or pace is above 1.0×; *underusing* when more than 30% of a week's capacity would reset unused; *on pace* otherwise.

The **?** button opens the breakdown: the verdict in words, the accounts with when each drains or how much it leaves, the model-scoped caps (Fable, Sonnet) where upstream reports them, and **Users** — each client key's share of the last day's weekly-quota spend. That share is measured from the quota headers (each response's rise in its account's weekly meter is booked to the client that sent it), so it reflects what requests cost, not how many tokens they moved. A client spending more than 1.5× an even split is marked *heavy*, and when the fleet is overusing each user gets the dry time the pool would have without them. Each account card also carries one line under its Weekly meter: when it drains, or how much it resets with.

`GET /teamclaude/forecast` returns the same data as JSON, behind the same key as `/teamclaude/status`.

**Explain** (operators only — the shared key, or a client key with `"role": "admin"`) sends the forecast to Claude Haiku and shows a few sentences of advice. It runs the genuine `claude` CLI on the server (`claude -p --bare --model haiku`) pointed at this proxy with the caller's own key, so it needs Claude Code installed on the server and spends a little quota per answer, booked to whoever asked. Answers are kept for 15 minutes. The numbers on the page always come from the forecast itself, never from the model. The same call is `POST /teamclaude/forecast/explain`.
```

- [ ] **Step 4: Final verification**

Run: `bun run test && bun run lint && bun run typecheck && bun run typecheck:strict`
Expected: every suite passes, lint is clean, both typechecks pass. Paste the summary lines (tests passed/failed counts) into the task report.

- [ ] **Step 5: Commit**

```bash
git add docs/usage.md
git commit -m "docs: the dashboard's weekly forecast"
```

---

## Self-review notes (for the plan author; executors may skip)

- **Spec coverage.** §1a → Task 3; §1b → Tasks 1 + 5 (spec amended: own tracker, `(no client key)` row); §2 → Task 2 (+ Task 4 for counterfactual, scoped, session); §3 → Tasks 4 + 5; §4a–d → Tasks 8 + 9; §5 → Task 6 (+ Task 7 wiring); §6 → Tasks 4, 5, 6, 8; §7 → every task's tests; §8 → Task 10.
- **Names checked across tasks:** `quotaMark`/`quotaCredit`/`ClientQuotaTracker.window()`/`NO_CLIENT`; `simulate` rows carry `index`; `QuotaHistory.coverage/burned/pastSeries/recentSlope`; `buildForecast({ accounts, thresholdFor, mode, history, attribution, now })`; hooks `getForecast`, `explainForecast({ key })`, `recordQuotaUse(client, amount)`; page helpers as listed in Task 8.
