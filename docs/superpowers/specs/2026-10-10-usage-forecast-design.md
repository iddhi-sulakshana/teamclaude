# Usage forecast — design

Date: 2026-10-10
Branch: `feat/usage-forecast`
Status: approved in conversation, awaiting written-spec review

## Purpose

The dashboard shows how much quota each account has used, but not where the
fleet is heading. The operator wants to know, at the current rate:

1. **Fleet runway (overuse)** — will the pool run dry before the weekly
   windows refill, and when?
2. **Wasted capacity (underuse)** — how much weekly capacity will reset unused,
   i.e. are we paying for seats we do not need?
3. **Per-account timing** — when each account drains, or how much of it resets
   unused.
4. **Per-user pacing** — which users drive the burn, and by how much.

An optional, on-demand AI explanation (Claude via the proxy's own pool) turns
the forecast into a few sentences of advice.

### Success criteria

- The hero's right-hand chart shows the fleet's weekly forecast: the last 24h
  of actual fleet utilization and a projection until every account has reset
  once, with the dry line and a verdict.
- A `?` button on the chart opens a breakdown covering all four questions.
- Each account card carries a one-line forecast.
- Every number is deterministic and unit-tested; the AI explanation never
  produces numbers of its own.
- An operator can click Explain and get a short paragraph from Haiku, routed
  through the proxy via the genuine `claude` CLI.

### Decisions taken in conversation

| Question | Decision |
| --- | --- |
| Which of the four forecasts? | All four. |
| Use Claude? | Deterministic math for every number, plus an on-demand, operator-only Explain button. |
| Where on the dashboard? | Replace the hero's client bar chart with the forecast chart; `?` opens the breakdown popup; one line per account card. |
| Approach | B — sampled quota history, fleet rotation simulation, per-user attribution from quota deltas. |
| Underuse cut-off | Projected unused > 30% of weekly fleet capacity. |
| History retention | 48h. |
| Burn-rate window | Trailing 24h. |
| Per-user counterfactual | Yes, when overusing. |

## Context (what exists today)

- Each account holds only its **current** `utilization` and reset instant per
  bucket (`unified5h`, `unified7d`, `unified7dSonnet`, `unified7dFable`, with
  `…Reset`), in `account.quota` (`src/account-manager.js`). No history.
- `buildQuotaSummary` (`src/quota-summary.js`) weights accounts by tier (Pro 1,
  Max 5x 5, Max 20x 20) via `quotaTier()`, and lists `unknownTiers`.
- `ClientUsageTracker` (`src/client-usage.js`) keeps per-client counters in
  15-minute slots (24h retention) and per-day tallies (current month), with
  rolled-up `5h` / `24h` / `month` windows, persisted to
  `teamclaude.state.json` every 60s (`persistQuotaState` in `src/index.js`).
- `BurnRateLearner` (`src/adaptive-distribution.js`) is a per-account EWMA over
  5-minute windows (~15-minute memory) used for routing. It cannot answer a
  24h fleet question and is not reused here.
- The server never calls Claude for itself. The keep-warm feature
  (`src/warmer.js`) spawns `claude -p --bare` against this proxy; that is the
  precedent for Explain. `docs/compliance.md` requires the genuine Claude Code
  CLI for OAuth subscriptions, so a hand-built `/v1/messages` call is ruled out.
- Upstream utilization headers are reported at ~1% precision (`0.56`).

## Design

### Unit: Pro-weeks

One Pro account's full weekly bucket = 1 Pro-week. A Max 20x account's weekly
bucket = 20. Fleet weekly capacity = Σ tier weight over **enabled Claude OAuth
accounts with a known tier**. Codex, API-key and third-party backend accounts
are not forecast. Accounts with an unknown tier are listed as "not forecast"
in the breakdown, mirroring `unknownTiers`.

### 1. Recording

#### 1a. `src/quota-history.js` — `QuotaHistory` (new)

- `sample(accounts, now)` runs every 15 minutes (`USAGE_SLOT_MS`) from
  `src/index.js`, next to the state-save interval. For every Claude OAuth
  account it records `{ t, u7d, reset7d, u7dSonnet, reset7dSonnet, u7dFable,
  reset7dFable, u5h, reset5h }` from `account.quota` (nulls kept as null).
- Samples are keyed by the identity the state file already uses for quota
  (`accountUuid` + `orgUuid`, falling back to `name`). Accounts no longer
  present are dropped at the next sample. Disabled accounts are still sampled
  but excluded from capacity by the forecast.
- Retention: 48h. Samples older than that are pruned on every `sample()`.
- Persistence: `exportState()` / `restore(saved)`, written alongside `quota`,
  `clients` and `usageDimensions` in `persistQuotaState`. Restore refuses
  samples with `t > now` (a clock that moved backwards), as
  `ClientUsageTracker` does.
- `burnRate(bucket, now, spanMs, weightOf)` returns Pro-weeks per hour over
  the span:
  - per account, sum the **increases** between consecutive samples × weight;
  - if the reset instant changed between two samples (or utilization dropped),
    the later value counts as burn from zero (`u_after`), never negative;
  - gaps (proxy down) stay in the elapsed time; the delta across a gap counts.
- `confidence(now)`:
  - **high** — ≥ 24h of samples; rate over the trailing 24h;
  - **medium** — 6–24h; rate over the span available;
  - **low** — < 6h; fall back to each account's since-reset average
    `u / (now − (reset − 7d))` × weight, summed.
- `pastSeries(now, capacity)` returns the fleet used % per sample time over
  the last 24h, for the chart's solid line.

#### 1b. Per-user attribution (hook next to `updateQuota`)

At `src/server.js` where `accountManager.updateQuota(account.index,
rateLimitHeaders, ctx.model)` runs:

- before the call, read the account's `quota.unified7d` and
  `quota.unified7dReset`;
- after it, compare with the new values:
  - same reset instant and both values known → credit
    `max(0, new − old) × weight`;
  - reset instant changed → credit `new × weight` (burn since the reset);
  - no previous value → credit nothing;
- the credit goes to the request's client through a `recordQuotaUse(client,
  proWeeks)` hook; spend sent without a client key (the shared key, or a
  key-less loopback caller) is booked as `(no client key)`.

Because the delta is between consecutive observations, concurrent requests on
one account never double-count. At 1% precision a single request usually
credits 0 and occasionally 0.01 × weight; in expectation the attribution is
proportional to cost, and it reflects model cost (a Fable request moves the
bucket more than a Haiku one).

The spend lives in its own small tracker, `ClientQuotaTracker`
(`src/quota-attribution.js`): per client, 15-minute slots kept for a day,
exported to and restored from the state file. It is deliberately not a new
counter inside `ClientUsageTracker`: that tracker's counter fields are
spelled out in about eight places and asserted by exact shape in some thirty
tests, and the forecast needs only the one-day window. Only the Anthropic
path (not Codex) is hooked.

In the per-user table, `(no client key)` is shown as a row but is left out of
the even split behind `fairShareX`, is never marked heavy, and gets no
counterfactual — it is nobody in particular.

### 2. Forecast engine — `src/forecast.js` (new, pure)

No I/O and no clock reads: everything comes in as arguments, so the server and
the tests drive it identically.

Inputs: accounts `[{ name, weight, priority, disabled, u, reset }]` for the
bucket, `threshold` (the auto-switch threshold as a fraction),
`burnRate` (Pro-weeks/h), `strategy`, `now`. The server fills `u` and
`reset` from the live `account.quota`, not from history; history supplies
only `burnRate` and the past series.

- **Pace** = `burnRate × 168 / fleetCapacity`. 1.0× means the fleet uses
  exactly its weekly capacity.
- **Simulation** in 15-minute steps from `now` until every account has reset
  once (capped at 7 days):
  - each step's burn (`burnRate × 0.25h`) drains eligible accounts —
    enabled, below `threshold` — within the best priority tier first, ordered
    by the configured strategy:
    - default rotation → soonest weekly reset first;
    - `distributeSessions: "adaptive"` → least remaining first;
    - `distributeSessions: true` → split across the tier in proportion to
      weight;
  - burn that one account cannot absorb carries over to the next eligible
    account in the same step;
  - at an account's reset, `max(0, threshold − u) × weight` is recorded as
    **unused**, then `u = 0` and `reset += 7d`;
  - the step where no eligible account remains starts a **dry** interval,
    which ends at the next reset.
- **Outputs**:
  - `pace`, `verdict`, `strategy`;
  - `poolDryAt` (first dry instant, or null) and `dryForMs` (until the next
    refill);
  - `unusedPct` — Σ unused / fleetCapacity, as a percentage;
  - per account: `drainsAt` (first instant it reaches the threshold, or null)
    and `unusedAtReset` (fraction of its bucket left at its reset, or null);
  - `projected` — fleet used % at each step, including the step-downs at
    resets, for the chart's dashed line.
- **Verdict**:
  - **overusing** — `poolDryAt` is set or `pace > 1.0`;
  - **underusing** — `unusedPct > 30`;
  - **on pace** — otherwise.
- **Per user** (input: each client's 24h `quotaUsed`):
  - `share` = user / total;
  - `fairShareX` = share ÷ (1 / active users), active = non-zero in 24h;
  - `heavy` when `fairShareX > 1.5`;
  - when overusing, `withoutThemDryAt` from one extra simulation at
    `burnRate × (1 − share)`.
- **Model caps**: the same simulation runs for the Fable and Sonnet weekly
  buckets where an account reports them; the result is a one-line verdict
  each (`scoped[]`), not a chart.
- **Session (5h)**: for accounts currently serving, `sessionHitsAt` from the
  last hour of that account's 5h samples (linear), or null when flat.

### 3. API — `src/server.js`

#### `GET /teamclaude/forecast`

Same key gate as `GET /teamclaude/status` (every role may read). Computed on
request; the work is at most ~672 steps × the account count. Not folded into
`/status`, so the TUI and status clients do not pay for it.

```jsonc
{
  "generatedAt": 0,           // ms
  "bucket": "weekly",
  "confidence": "high",       // high | medium | low
  "spanHours": 24,
  "burnRate": 0.0,            // Pro-weeks per hour
  "pace": 0.0,
  "verdict": "overusing",     // overusing | on-pace | underusing
  "strategy": "soonest-reset",// soonest-reset | least-remaining | proportional
  "threshold": 0.98,
  "fleetCapacity": 0,         // Pro-weeks
  "poolDryAt": null,
  "dryForMs": null,
  "unusedPct": 0,
  "accounts": [{ "name": "", "weight": 20, "u": 0.71, "reset": 0,
                 "drainsAt": null, "unusedAtReset": null, "sessionHitsAt": null }],
  "notForecast": [{ "name": "", "reason": "unknown tier" }],
  "users": [{ "name": "", "share": 0.48, "fairShareX": 2.1, "heavy": true,
              "withoutThemDryAt": null }],
  "scoped": [{ "bucket": "fable", "verdict": "on-pace", "poolDryAt": null, "unusedPct": 12 }],
  "series": { "past": [[0, 0.42]], "projected": [[0, 0.42]] }
}
```

#### `POST /teamclaude/forecast/explain`

Operator-only via `controlRole(req.tcClient, req.tcRole) === 'operator'`, the
same gate as switch and probe. See section 5.

### 4. Dashboard — `src/dashboard.js`

#### 4a. Hero chart

- **Removed**: `#clientChartWrap` (the groups, average line and pill, empty
  text, "All time → now" range), `GROUP_SLOTS`, the `clientGroups()` helper,
  its rendering code and its tests.
- **Unchanged**: the left side — `Tokens used`, the Total/5h/24h/month
  segment, the Tokens/Requests segment, the big number, split, routing line,
  buttons.
- **Added**: `#forecastWrap` in the same slot, an SVG plot styled like the
  Usage over time chart (`smoothPath`, same tokens and gradient):
  - Y: fleet used %, 0–100; a dashed line at the auto-switch threshold,
    labelled "dry";
  - X: now − 24h → now → the end of the projection, on one linear scale;
  - solid line + area for `series.past`; dashed line for `series.projected`,
    stepping down at resets; a small tick per reset;
  - header row: verdict chip (**Overusing 1.4×** in the bad tone, **On pace
    0.9×** neutral, **Underusing 0.5×** in the warn tone) and a `?` icon
    button at the top right;
  - tag where the projection meets the dry line: "Dry Thu 14:00 · 41h before
    refill"; when underusing, "~38% resets unused" instead;
  - low confidence adds a faint caption "Low confidence · 3h of data";
  - empty state: "No weekly quota seen yet — probe quotas".
- Fetched on load and every 60s, on the same timing as the usage series fetch
  rather than on every status poll.

#### 4b. The `?` popup

The existing `.dialog` pattern. Sections, top to bottom:

1. **Verdict** — pace, burn as "% of fleet per day", dry time or unused %,
   confidence and data span.
2. **How this is worked out** — three short sentences: the 24h burn rate;
   the drain order assumed (named from `strategy`); refills at each reset.
3. **Accounts** — table: name, tier, weekly %, resets, "drains Wed 09:00" or
   "38% unused at reset"; then `notForecast` rows.
4. **Users** — table: name, share of burn (24h) with a bar, × fair share,
   heavy badge, and "without them: dry Sat 10:00" when overusing.
5. **Model caps** — the Fable and Sonnet lines.
6. **Explain ✦** — shown only when `viewerCan(viewer, 'explain')` (operator);
   the answer renders inline in the popup.

#### 4c. Account cards

One line under the Weekly meter: "↳ drains ~Wed 09:00" or "↳ resets with 38%
unused". Accounts currently serving also get "↳ session hits in ~47m" when
`sessionHitsAt` is set. Hallway and 3D views unchanged.

#### 4d. Code shape

New pure helpers — `forecastPaths`, `forecastTag`, `verdictChip`,
`cardForecastLine`, `forecastPopupRows` — go into `SHARED_HELPERS`, exported
and unit-tested like the existing ones. `viewerCan` gains `'explain'`
(operator only). All rendering uses `textContent`. CSP hashes are derived from
the page by `dashboardCsp`, so they follow the change automatically.

### 5. Explain — `src/forecast-explain.js` (new)

- On `POST /teamclaude/forecast/explain`: build the current forecast, then
  spawn `claude -p --bare --model haiku --output-format text "<instruction>"`
  with the forecast JSON on stdin and:
  - `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (not pinned; normal routing);
  - `ANTHROPIC_API_KEY` = the caller's own key, so the quota is credited to
    whoever clicked; falls back to `proxy.apiKey`.
- Instruction: 3–5 sentences — what is happening, the main driver, one or two
  concrete actions; use only numbers present in the JSON and compute none.
  The JSON includes account and client names, the same data every request
  already sends through those accounts.
- Single-flight: concurrent clicks share one run. The result is cached for 15
  minutes and returned as `{ text, generatedAt, cached }`; the popup shows
  "Haiku · 3m ago" and offers "Ask again" once the cache has expired.
- Output passes through `sanitizeText`, is capped at 2,000 characters, and is
  rendered with `textContent`.
- Its own small spawn helper capturing stdout (the warmer's ignores stdio),
  with a 90s timeout; injectable for tests.
- Compliance: genuine CLI, triggered by a human click, nothing in the
  background — consistent with `docs/compliance.md`.

### 6. Errors and edge cases

- `claude` not on the server's PATH (`ENOENT`) → 503 "Claude Code CLI not
  found on the server — install it there to use Explain"; timeout or non-zero
  exit → 502 with the last stderr line, sanitized. Both render inline in the
  popup.
- No account has weekly utilization → chart empty state; the endpoint returns
  `verdict: null` and empty series.
- History present but no burn in 24h → pace 0×, underusing, caption "no burn
  in the last 24h".
- Fleet capacity 0 (every account disabled, or every tier unknown) → empty
  state naming the reason.
- Removed or renamed accounts drop out of history at the next sample; samples
  from the future are refused on restore.

### 7. Testing

`node --test`, test-first for each unit.

- `test/forecast.test.js` — pace; the three drain strategies; priority tiers;
  carry-over within a step; refill at reset; `poolDryAt` and `dryForMs`;
  `unusedPct`; verdict boundaries (1.0×, 30%); per-user share, fair share,
  heavy, counterfactual; scoped buckets; empty and zero-capacity fleets.
- `test/quota-history.test.js` — sampling; 48h retention; reset between
  samples; gap handling; confidence levels and the since-reset fallback;
  `pastSeries`; export/restore round-trip; future samples refused.
- `test/quota-attribution.test.js` — `quotaMark`, `quotaCredit` (rise, reset,
  jitter, no weight), the tracker's day window, `(no client key)`, export and
  restore.
- Server tests — `/teamclaude/forecast` gate and payload shape; attribution
  next to `updateQuota` (same window, reset in between, no previous value);
  `/teamclaude/forecast/explain` operator gate; Explain with a stubbed spawn
  (success, `ENOENT`, timeout, single-flight, cache hit).
- `test/dashboard.test.js` — the new pure helpers; `viewerCan('explain')`;
  `clientGroups` tests removed.

### 8. Documentation

A "Forecast" subsection under the browser dashboard in `docs/usage.md`: what
the chart shows, how pace and the verdict are computed, the confidence
levels, and that Explain needs the `claude` CLI on the server and spends a
little quota per click.

## Out of scope

- Forecasting Codex, API-key or third-party backend accounts.
- Weekly seasonality (weekday/weekend patterns); the 24h window already spans
  one day/night cycle.
- Charting the Fable/Sonnet caps (they appear as lines in the popup only).
- Automatic or scheduled AI summaries.
- Alerts or notifications when the verdict changes.
