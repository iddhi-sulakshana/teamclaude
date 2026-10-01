// The status dashboard: a single self-contained HTML page served at
// GET /teamclaude/dashboard, rendering /teamclaude/status for humans.
//
// The page itself contains NO data — it is a static asset whose script fetches
// /teamclaude/status (same origin) with the proxy key and re-renders every few
// seconds, and /teamclaude/usage/series, behind the same gate, for the usage-
// over-time chart. That split is what lets the asset be served without the key (a
// browser address bar cannot send x-api-key) while every byte of actual status
// stays behind the existing gate. The key is asked for only when the server
// refuses the page without one (401/403; loopback browsers are exempt), and is
// kept in localStorage; a later refusal (wrong or rotated key) asks again.
//
// Self-contained on purpose: no external scripts, styles, or fonts, so the
// page works on air-gapped deployments and adds no third-party surface. Its
// typefaces (DM Sans and DM Mono) are embedded rather than fetched, for the
// same reason. All
// rendering uses textContent — status fields (account names, client names) are
// operator/OAuth-derived, but they still never reach innerHTML.

import { createHash } from 'node:crypto';
import { UNAVAILABLE_TEXT, RESET_CREDIT_MAX_AGE_MS } from './status-renderer.js';
import { USAGE_WINDOWS } from './client-usage.js';
import { formatMoney } from './oauth.js';
import { resolveMaxSpendMinor, spendCapReached } from './model.js';
import { DM_SANS_WOFF2, DM_MONO_WOFF2 } from './dashboard-fonts.js';

export function renderDashboardHtml() {
  return PAGE;
}

/**
 * The body of every `<script>` in the page, in order. Attribute-free tags only,
 * which is all this page has and all the hash policy can admit anyway.
 *
 * @param {string} html
 */
export function inlineScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/**
 * Content-Security-Policy for the dashboard, sent by the server with the page.
 *
 * The page holds the proxy key in localStorage, so the policy is the backstop
 * for a script that should never run there: nothing loads from anywhere
 * (`default-src 'none'`), each inline script (the theme bootstrap in `<head>`
 * and the main script) is admitted by its hash rather than by
 * `'unsafe-inline'` — the page is static, so the hashes are stable — and the
 * only network the script may touch is this origin, for status and switch.
 * Styles need `'unsafe-inline'` because the layout uses `style=` attributes,
 * which hashes do not cover; CSSOM writes (`el.style.width = …`) are not
 * governed by CSP at all. `frame-ancestors 'none'` keeps the page out of
 * another site's iframe, where a click on "switch" could be overlaid.
 */
export function dashboardCsp(html = PAGE) {
  // Every inline script, not just the first: the theme is applied by a short
  // script in <head> so the page does not paint dark and then flip to light,
  // and a hash that covered only the main script would leave that one blocked.
  const hashes = inlineScripts(html)
    .map(script => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`)
    .join(' ');
  return [
    "default-src 'none'",
    `script-src ${hashes}`,
    "style-src 'unsafe-inline'",
    // The two DM faces, inlined into the page's own stylesheet as data:
    // URLs (dashboard-fonts.js). Nothing else can be a font source.
    "font-src data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// The page's pure logic lives here, not in the script string: these functions
// close over nothing and touch no DOM, so they are serialized into the page
// with toString() below AND exported for the test suite. One implementation,
// tested and served — a test against the string would only be a source grep.

// Model-scoped weekly buckets, one row per family upstream actually metered.
// `scopedWeekly` is learned from the usage payload's `limits` array, so it is
// the complete list when present; the two dedicated fields are the fallback for
// a payload that reported `seven_day_sonnet` without a `limits` array.
export function scopedWeeklyRows(quota) {
  var q = quota || {};
  var scoped = q.scopedWeekly || {};
  var rows = [];
  Object.keys(scoped).forEach(function (family) {
    var b = scoped[family] || {};
    rows.push({ family: family, label: family.charAt(0).toUpperCase() + family.slice(1), utilization: b.utilization, resetAt: b.resetAt });
  });
  [{ family: 'fable', label: 'Fable', u: q.unified7dFable, r: q.unified7dFableReset },
    { family: 'sonnet', label: 'Sonnet', u: q.unified7dSonnet, r: q.unified7dSonnetReset }].forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(scoped, f.family) || f.u == null) return;
    rows.push({ family: f.family, label: f.label, utilization: f.u, resetAt: f.r });
  });
  rows.sort(function (a, b) { return a.family < b.family ? -1 : a.family > b.family ? 1 : 0; });
  return rows;
}

// What an account has spent, cache included. `totalInputTokens` counts uncached
// input only, which on Claude Code traffic is ~0.05% of the input side — a
// total without the cache fields understates the account by orders of magnitude.
export function accountTokens(usage) {
  var u = usage || {};
  return (u.totalInputTokens || 0) + (u.totalOutputTokens || 0)
    + (u.totalCacheReadTokens || 0) + (u.totalCacheCreationTokens || 0);
}

// The same spend as accountTokens, as the two sides a card shows: input is the
// uncached figure and both cache fields, output what the account generated.
export function accountTokenSplit(usage) {
  var u = usage || {};
  return {
    input: (u.totalInputTokens || 0) + (u.totalCacheReadTokens || 0) + (u.totalCacheCreationTokens || 0),
    output: u.totalOutputTokens || 0,
  };
}

export function providerLabel(provider) {
  if (provider === 'codex') return 'Codex';
  if (provider === 'anthropic') return 'Claude';
  return provider || 'Unknown';
}

// Every bucket switchThreshold can be keyed by, plus the short names the
// threshold badge shows them under. Mirrors THRESHOLD_BUCKET_KEYS in model.js
// and THRESHOLD_BUCKET_LABELS in status-renderer.js — duplicated rather than
// imported, because the browser never runs an import. It does not see this
// module's scope either: a helper reaches the page as its own source text, so
// these two are written into the page by SHARED_CONSTS below. Without that the
// first table-form override throws a ReferenceError inside render() and takes
// the accounts pane with it.
export var THRESHOLD_BUCKET_KEYS = ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable', 'tokens', 'requests'];
/** @type {Object<string, string>} */
export var THRESHOLD_BUCKET_LABELS = {
  unified5h: '5h', unified7d: '7d', unified7dSonnet: 'sonnet', unified7dFable: 'fable',
  tokens: 'tokens', requests: 'requests',
};

/**
 * "switch at 100%" / "switch 7d 90%, fable 80%" — an account's OWN
 * switchThreshold (issue #409), or '' when it has none or every override it
 * carries merely repeats what the fleet already resolves to. `fleetThreshold`
 * and `fleetThresholds` are the status payload's own top-level fields
 * (`status.switchThreshold` / `status.switchThresholds`), so the comparison
 * uses the exact fleet value the live server is gating on.
 * @param {number|Object<string, number>|null|undefined} accountThreshold
 * @param {number|null|undefined} fleetThreshold
 * @param {Object<string, number>|null|undefined} fleetThresholds
 * @returns {string}
 */
export function thresholdBadgeText(accountThreshold, fleetThreshold, fleetThresholds) {
  /** @param {string} bucket */
  function fleetFor(bucket) {
    if (fleetThresholds && typeof fleetThresholds === 'object') {
      var v = fleetThresholds[bucket];
      if (v == null) v = fleetThresholds.default;
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return typeof fleetThreshold === 'number' && isFinite(fleetThreshold) ? fleetThreshold : 0.98;
  }
  /** @param {number} v */
  function pct(v) { return (Math.round(v * 1000) / 10) + '%'; }
  /** @param {unknown} v */
  function valid(v) { return typeof v === 'number' && isFinite(v); }
  /** @type {string[]} */
  var parts = [];
  /** @type {Object<string, any>} */
  var table = {};
  /** @type {any} */
  var ownDefault = null;
  if (typeof accountThreshold === 'number') {
    if (!valid(accountThreshold)) return '';
    ownDefault = accountThreshold;
    if (accountThreshold !== fleetFor('default')) parts.push('at ' + pct(accountThreshold));
  } else if (accountThreshold && typeof accountThreshold === 'object' && !Array.isArray(accountThreshold)) {
    table = accountThreshold;
    ownDefault = table.default;
    Object.keys(table).forEach(function (key) {
      var v = table[key];
      if (!valid(v)) return;
      if (key !== 'default' && THRESHOLD_BUCKET_KEYS.indexOf(key) === -1) return;
      if (v !== fleetFor(key)) parts.push((key === 'default' ? 'at' : (THRESHOLD_BUCKET_LABELS[key] || key)) + ' ' + pct(v));
    });
  }
  // As switchThresholdDiffs in model.js: the account's own default outranks a
  // bucket entry in the FLEET table, so a default equal to the fleet's can
  // still move a bucket the fleet names (fleet 7d at 85%, account 0.98 puts
  // that account's 7d at 98%). When the defaults differ, "at N%" already
  // covers every bucket the account does not list.
  if (valid(ownDefault) && ownDefault === fleetFor('default')) {
    THRESHOLD_BUCKET_KEYS.forEach(function (key) {
      if (valid(table[key])) return;
      if (ownDefault !== fleetFor(key)) parts.push(THRESHOLD_BUCKET_LABELS[key] + ' ' + pct(ownDefault));
    });
  }
  return parts.length ? 'switch ' + parts.join(', ') : '';
}

/**
 * `now` keeps the fourth slot master's reset-credit callers already use; the
 * fleet threshold pair (#409) follows it.
 * @param {Record<string, any>|null|undefined} account
 * @param {string|null} [current]
 * @param {Record<string, string>|null} [currentAccounts]
 * @param {number|null} [now]  ms epoch a reset-credit reading's age is measured from
 * @param {number|null|undefined} [fleetThreshold]
 * @param {Object<string, number>|null|undefined} [fleetThresholds]
 */
export function accountBadges(account, current, currentAccounts, now, fleetThreshold, fleetThresholds) {
  var a = account || {};
  var isCurrent = currentAccounts
    ? currentAccounts[a.provider] === a.name
    : a.name === current;
  var status = a.disabled ? 'disabled' : (a.status || 'unknown');
  var recent = Number.isFinite(a.sessions) ? a.sessions : 0;
  var known = Number.isFinite(a.knownSessions) ? a.knownSessions : 0;
  // What sets this account apart, and nothing every card would repeat: the
  // common case — a Claude OAuth account, active — earns no badge for any of
  // the three, so the ones that do show are the ones worth reading. Current
  // leads, as the card's accent border already says.
  var badges = [];
  if (isCurrent) badges.push({ cls: 'current', text: 'current' });
  badges.push({ cls: 'meta priority', text: 'prio ' + (a.priority || 0) });
  if (status !== 'active') badges.push({ cls: status, text: status });
  if (a.provider && a.provider !== 'anthropic') badges.push({ cls: 'provider ' + a.provider, text: providerLabel(a.provider) });
  if (a.type && a.type !== 'oauth') badges.push({ cls: 'meta', text: a.type });
  if (recent) badges.push({ cls: 'sessions', text: recent + ' recent' });
  if (known > recent) badges.push({ cls: 'sessions known', text: known + ' known' });
  // Free Codex rate-limit reset credits this account holds — what it could
  // spend to undo an exhausted window rather than wait one out. The count is
  // the account's holdings, not what upstream would apply this instant.
  // A reading past RESET_CREDIT_MAX_AGE_MS is dropped, as it is on the status
  // screen and the TUI row: only the usage probe refreshes the count, so an old
  // one may describe a credit that has since been redeemed or has expired.
  var reading = (a.quota || {}).resetCredits || {};
  var credits = reading.available;
  var stale = Number.isFinite(reading.seenAt) && (now == null ? Date.now() : now) - reading.seenAt > RESET_CREDIT_MAX_AGE_MS;
  if (Number.isFinite(credits) && credits > 0 && !stale) {
    badges.push({ cls: 'meta', text: credits + ' reset credit' + (credits === 1 ? '' : 's') });
  }
  // Arguments 5/6 are optional (the pre-#409 unit test above omits them): with
  // no account switchThreshold at all — the common case — thresholdBadgeText
  // returns '' regardless of what the fleet args are, so an old caller sees no
  // new badge. A caller that DOES set switchThreshold on the account is
  // expected to pass the fleet's own value too, the way `render()` does below,
  // or the comparison falls back to thresholdBadgeText's own 0.98 default.
  var thresholdText = thresholdBadgeText(a.switchThreshold, fleetThreshold, fleetThresholds);
  if (thresholdText) badges.push({ cls: 'meta threshold', text: thresholdText });
  // Extra-usage fallback: one badge, the louder state winning. Strict `true`
  // so a missing field on an older server's payload shows nothing.
  if (a.onExtraUsage === true) badges.push({ cls: 'extra-usage billing', text: 'on extra usage \u2014 billing' });
  else if (a.allowExtraUsage === true) badges.push({ cls: 'extra-usage', text: 'extra usage allowed' });
  // The account's own egress proxy, as the status payload carries it: already
  // password-masked (describeRouting), and absent for an account on the fleet
  // path, which is the default and earns no badge.
  if (typeof a.routing === 'string' && a.routing) badges.push({ cls: 'meta routing', text: 'via ' + a.routing });
  return badges;
}

// Extra usage (paid overage) in words: what it has cost this month, against
// upstream's monthly limit and the operator's `maxSpend`, and whether it can
// still bill. Null when the account cannot bill and has billed nothing — the
// same rule and the same figures as the `Spend` line of `teamclaude status`
// (spendLine). The card's Extra bar carries this as its tooltip, since the
// bar's own value column has room for the amount and nothing else.
/**
 * @param {Record<string, any>|null|undefined} account
 * @returns {string|null}
 */
export function extraUsageText(account) {
  var a = account || {};
  var spend = (a.quota || {}).spend;
  if (!spend) return null;
  var spent = (spend.usedMinor || 0) > 0;
  if (!spend.enabled && !spent) return null;
  var amount = formatMoney(spend);
  var capMinor = resolveMaxSpendMinor(a.maxSpend, spend);
  var cap = capMinor == null ? ''
    : ', cap ' + formatMoney({ currency: spend.currency, exponent: spend.exponent, usedMinor: capMinor, limitMinor: null });
  if (spend.enabled) {
    if (spendCapReached(a.maxSpend, spend)) return 'Extra usage: spend cap reached — ' + amount + ' used this month' + cap;
    if (spent) return 'Extra usage: billing — ' + amount + ' used this month' + cap;
    return 'Extra usage: can bill past plan limits — ' + amount + ' used this month' + cap;
  }
  // Off now, but money moved this month. Why it is off decides whether it can
  // come back: out of credits and the member switching it off differ.
  var why = spend.userDisabled ? 'now disabled by the account holder'
    : spend.disabledReason ? 'now off (' + String(spend.disabledReason).slice(0, 64) + ')'
    : 'now off';
  return 'Extra usage: ' + amount + ' spent this month, ' + why;
}

// The card's Extra meter, drawn beside Session and Weekly: this month's extra
// usage against the ceiling that binds first — the operator's `maxSpend` when
// it is below upstream's monthly limit, else that limit. `used` is the amount
// and `rest` what it is measured against ("of $20.00 cap"), apart so the card
// can set the amount the way it sets the other meters' percentages; naming the
// cap keeps a meter filling toward it from being read as one filling toward
// the limit. `ratio` is null with neither ceiling known (an empty meter behind
// the bare amount), and unclamped: upstream can report a month past its limit.
// `off` marks an account that billed this month and cannot now. Shown for
// exactly the accounts extraUsageText has words for.
/**
 * @param {Record<string, any>|null|undefined} account
 * @returns {{ ratio: number|null, used: string, rest: string, title: string, off: boolean }|null}
 */
export function extraUsageBar(account) {
  var title = extraUsageText(account);
  if (!title) return null;
  var a = account || {};
  var spend = a.quota.spend;
  var used = spend.usedMinor || 0;
  var limitMinor = spend.limitMinor == null ? null : spend.limitMinor;
  var capMinor = resolveMaxSpendMinor(a.maxSpend, spend);
  var capBinds = capMinor != null && (limitMinor == null || capMinor < limitMinor);
  var ceiling = capBinds ? capMinor : limitMinor;
  var ratio = ceiling == null ? null : ceiling > 0 ? used / ceiling : (used > 0 ? 1 : 0);
  var money = function (/** @type {number} */ minor) {
    return formatMoney({ currency: spend.currency, exponent: spend.exponent, usedMinor: minor, limitMinor: null });
  };
  var rest = (ceiling == null ? '' : ' of ' + money(ceiling) + (capBinds ? ' cap' : ''))
    + (spend.enabled ? '' : ' · off');
  return { ratio: ratio, used: money(used), rest: rest, title: title, off: !spend.enabled };
}

// A meter's colour band, on the thresholds the Accounts legend names: under
// 60% is fine, 60–90% is worth a look, 90% and over is nearly gone.
/** @param {number|null|undefined} ratio */
export function meterTone(ratio) {
  if (ratio == null || !isFinite(ratio)) return 'ok';
  return ratio >= 0.9 ? 'bad' : ratio >= 0.6 ? 'warn' : 'ok';
}

// The overview's columns: the two busiest clients on the shown window and
// measure, a column each, and everyone else folded into a third — what a glance
// takes in, where the Clients list further down carries every row. Three
// clients or fewer are each their own column, since a fold of one would only
// hide a name. `share` is of the whole; `lift` is how high a column's figure
// stands against the tallest column; `grow` is its width, square-rooted so a
// client with a sliver of the traffic still has room for its label.
// `averageLift` puts the dashed average-per-client line on the same scale as
// `lift`. A client with nothing on the window takes no column and does not
// pull the average down.
/** @param {Array<{ name: string, value: number }>|null|undefined} ranking */
export function clientGroups(ranking) {
  var active = (ranking || []).filter(function (r) { return r.value > 0; });
  var total = 0;
  active.forEach(function (r) { total += r.value; });
  /** @type {Array<{ name: string, value: number, members: string[], others: boolean, share: number, lift: number, grow: number }>} */
  var groups = (active.length <= 3 ? active : active.slice(0, 2)).map(function (r) {
    return { name: r.name, value: r.value, members: [r.name], others: false, share: 0, lift: 0, grow: 1 };
  });
  if (active.length > 3) {
    var rest = active.slice(2);
    var sum = 0;
    rest.forEach(function (r) { sum += r.value; });
    groups.push({ name: 'others', value: sum, members: rest.map(function (r) { return r.name; }), others: true, share: 0, lift: 0, grow: 1 });
  }
  var max = 0;
  groups.forEach(function (g) { if (g.value > max) max = g.value; });
  groups.forEach(function (g) {
    g.share = total ? g.value / total : 0;
    g.lift = max ? g.value / max : 0;
    g.grow = 1 + 2 * Math.sqrt(g.share);
  });
  var average = active.length ? total / active.length : 0;
  return { groups: groups, total: total, average: average, averageLift: max ? average / max : 0, clients: active.length };
}

// Usage over time, from GET /teamclaude/usage/series: one point per hour of
// the window shown — the last five for `5h`, the day for `24h` and for `total`,
// which has no series of its own (the tracker keeps a day, not a lifetime).
// Each point carries every client's traffic in that hour (`total`), which the
// overview's chart draws as one line. `lines` are Usage by user's: one per
// client in `names`, in that order — drawn flat when it spent nothing, since a
// name in the legend with no line would read as missing — and, beside them,
// every other client folded into one "others" line when any of them spent
// anything. With no names there are no lines, only the total.
// `peakAt` is the busiest hour overall, `linePeak` the highest point of any
// one line, and `last` the newest hour's whole traffic. The measure is
// `requests`, `input` or `output` tokens, or anything else for both sides.
/**
 * @param {any} series
 * @param {string} [view]
 * @param {string} [metric]
 * @param {string[]|null} [names]
 */
export function seriesLines(series, view, metric, names) {
  var s = series || {};
  var n = Number.isInteger(s.buckets) && s.buckets > 0 ? s.buckets : 0;
  var bucketMs = s.bucketMs || 0;
  var shown = view === '5h' && bucketMs ? Math.min(n, Math.max(1, Math.round(5 * 3600000 / bucketMs))) : n;
  var from = n - shown;
  var clients = s.clients || {};
  var at = function (/** @type {any} */ c, /** @type {number} */ i) {
    if (!c) return 0;
    if (metric === 'requests') return (c.requests || [])[i] || 0;
    if (metric === 'input') return (c.inputTokens || [])[i] || 0;
    if (metric === 'output') return (c.outputTokens || [])[i] || 0;
    return ((c.inputTokens || [])[i] || 0) + ((c.outputTokens || [])[i] || 0);
  };
  var all = Object.keys(clients).sort();
  var picked = names || [];
  /** @type {Array<{ name: string, members: string[], others: boolean, values: number[] }>} */
  var lines = picked.map(function (name) { return { name: name, members: [name], others: false, values: [] }; });
  var rest = all.filter(function (name) { return picked.indexOf(name) === -1; });
  var restSpent = false;
  rest.forEach(function (name) { for (var i = from; i < n; i++) if (at(clients[name], i) > 0) restSpent = true; });
  if (picked.length && restSpent) lines.push({ name: 'others', members: rest, others: true, values: [] });
  /** @type {Array<{ start: number, end: number, total: number }>} */
  var points = [];
  var peak = 0, linePeak = 0, total = 0;
  for (var i = from; i < n; i++) {
    var sum = 0;
    all.forEach(function (name) { sum += at(clients[name], i); });
    points.push({ start: s.end - (n - i) * bucketMs, end: s.end - (n - 1 - i) * bucketMs, total: sum });
    if (sum > peak) peak = sum;
    total += sum;
    lines.forEach(function (line) {
      var v = 0;
      line.members.forEach(function (name) { v += at(clients[name], i); });
      line.values.push(v);
      if (v > linePeak) linePeak = v;
    });
  }
  var peakAt = -1;
  points.forEach(function (p, idx) { if (p.total > 0 && (peakAt === -1 || p.total > points[peakAt].total)) peakAt = idx; });
  var tail = points[points.length - 1];
  return { points: points, lines: lines, peak: peak, linePeak: linePeak, peakAt: peakAt, total: total, last: tail ? tail.total : 0, spanMs: shown * bucketMs };
}

// The clients Usage by user draws a line each, in the section's ranking: every
// one of them up to the palette's eight colours, and past that the busiest
// eight, the rest sharing a grey "others" line.
/** @param {Array<{ name: string }>|null|undefined} ranking */
export function userLineNames(ranking) {
  return (ranking || []).slice(0, 8).map(function (r) { return r.name; });
}

// The colour each drawn client wears, as a palette slot: its place among the
// drawn names in alphabetical order rather than in the ranking, so a client
// keeps its colour when the window or the measure reorders the ranking.
/** @param {string[]|null|undefined} names */
export function userSlots(names) {
  /** @type {Record<string, number>} */
  var slots = {};
  (names || []).slice().sort().forEach(function (name, i) { slots[name] = i; });
  return slots;
}

// A smooth line through the points, as SVG path data: each span a cubic whose
// control points follow the neighbouring points (Catmull–Rom), so the curve
// passes through every hour's value instead of rounding it off. A control
// point is kept no lower than `floor`: a curve stays inside the hull of its
// control points, so a line of usage cannot dip below the zero it sits on and
// read as a negative hour. Two decimals are all a 400-wide viewBox shows.
/**
 * @param {Array<[number, number]>} pts
 * @param {number} [floor]
 */
export function smoothPath(pts, floor) {
  if (!pts || !pts.length) return '';
  var f = function (/** @type {number} */ v) { return String(Math.round(v * 100) / 100); };
  var y = function (/** @type {number} */ v) { return floor == null ? v : Math.min(floor, v); };
  var d = 'M' + f(pts[0][0]) + ',' + f(pts[0][1]);
  for (var i = 0; i < pts.length - 1; i++) {
    var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ' C' + f(p1[0] + (p2[0] - p0[0]) / 6) + ',' + f(y(p1[1] + (p2[1] - p0[1]) / 6))
      + ' ' + f(p2[0] - (p3[0] - p1[0]) / 6) + ',' + f(y(p2[1] - (p3[1] - p1[1]) / 6))
      + ' ' + f(p2[0]) + ',' + f(p2[1]);
  }
  return d;
}

// Traffic by time, for the heatmap: a row per client that spent anything on
// the span shown, busiest first —
// and a column per stretch of that span: four hours each across the day, one
// each across five hours. `level` is a cell's shade, 0 for nothing and 1–4 by
// quarters of the square root of its share of the busiest cell. Usage is
// heavy-tailed — one client often spends ten times the next — and on a linear
// scale every client but the busiest would sit in the faintest shade; the root
// keeps them apart while the busiest cell still takes the darkest. Each cell
// also carries its `input` and `output` tokens, whatever the measure, for the
// tooltip that splits them.
/**
 * @param {any} series
 * @param {string} [view]
 * @param {string} [metric]
 */
export function heatGrid(series, view, metric) {
  var s = series || {};
  var n = Number.isInteger(s.buckets) && s.buckets > 0 ? s.buckets : 0;
  var bucketMs = s.bucketMs || 0;
  var shown = view === '5h' && bucketMs ? Math.min(n, Math.max(1, Math.round(5 * 3600000 / bucketMs))) : n;
  var from = n - shown;
  var per = shown > 6 ? 4 : 1;
  var count = shown ? Math.ceil(shown / per) : 0;
  /** @type {Array<{ from: number, to: number }>} */
  var cols = [];
  for (var c = 0; c < count; c++) {
    var a = Math.max(from, n - (count - c) * per), b = n - (count - 1 - c) * per;
    cols.push({ from: a, to: b });
  }
  var clients = s.clients || {};
  var at = function (/** @type {any} */ cl, /** @type {number} */ i) {
    if (metric === 'requests') return (cl.requests || [])[i] || 0;
    return ((cl.inputTokens || [])[i] || 0) + ((cl.outputTokens || [])[i] || 0);
  };
  var side = function (/** @type {any} */ cl, /** @type {string} */ key, /** @type {number} */ i) { return (cl[key] || [])[i] || 0; };
  var ranked = Object.keys(clients).map(function (name) {
    var sum = 0;
    for (var i = from; i < n; i++) sum += at(clients[name], i);
    return { name: name, sum: sum };
  }).filter(function (r) { return r.sum > 0; });
  ranked.sort(function (x, y) { return (y.sum - x.sum) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0); });
  /** @type {Array<{ name: string, others: boolean, members: string[], cells: Array<{ value: number, input: number, output: number, level: number }> }>} */
  var rows = ranked.map(function (r) { return { name: r.name, others: false, members: [r.name], cells: [] }; });
  var max = 0;
  rows.forEach(function (row) {
    row.cells = cols.map(function (col) {
      var v = 0, inp = 0, out = 0;
      row.members.forEach(function (name) {
        for (var i = col.from; i < col.to; i++) {
          v += at(clients[name], i);
          inp += side(clients[name], 'inputTokens', i);
          out += side(clients[name], 'outputTokens', i);
        }
      });
      if (v > max) max = v;
      return { value: v, input: inp, output: out, level: 0 };
    });
  });
  rows.forEach(function (row) {
    row.cells.forEach(function (cell) { cell.level = cell.value > 0 ? 1 + Math.min(3, Math.floor(Math.sqrt(cell.value / max) * 4)) : 0; });
  });
  return {
    columns: cols.map(function (col) { return { start: s.end - (n - col.from) * bucketMs, end: s.end - (n - col.to) * bucketMs }; }),
    rows: rows, max: max, spanMs: shown * bucketMs,
  };
}

// The chart's axis ticks, as the instants the page labels with the clock,
// oldest first and ending at `end`: every hour for a span of six hours or
// less, every quarter of the span beyond that.
/**
 * @param {number} spanMs
 * @param {number} end
 */
export function seriesTicks(spanMs, end) {
  var hours = Math.round((spanMs || 0) / 3600000);
  if (hours <= 0) return [];
  var step = hours <= 6 ? 1 : Math.max(1, Math.round(hours / 4));
  var out = [];
  for (var h = hours; h >= 0; h -= step) out.push(end - h * 3600000);
  if (out[out.length - 1] !== end) out.push(end);
  return out;
}

// One row per CONVERSATION, from `sessions.items` (proxy.sessionDetail). A
// Claude Code session that fans out to nine subagents is nine rows, because a
// conversation is what holds a pin and a prompt cache.
//
// `id` is the pin key those rows are keyed by — a session id narrowed to one
// conversation — which is an identity for routing, not one to read: a composite
// nobody recognises, and identical between siblings but for its tail. So the
// visible identity is split in two, the session an operator knows and the
// conversation that tells its siblings apart. A record labelled by no request
// (touch() alone) has no session name, and falls back to the key it is under.
//
// The token columns are #192's numbers — what each response actually reported,
// cache included — summed across the weekly buckets the conversation touched.
// `pins` is a bucket→account map rather than one index, because a conversation
// spending two model families is served by two accounts at the same time.
export function sessionRows(sessions) {
  var items = (sessions && sessions.items) || [];
  return items.map(function (s) {
    var buckets = s.tokens || {};
    var row = {
      id: s.id,
      session: s.session || s.id || '',
      // Enough of the digest to separate one session's live conversations; the
      // whole of it is a column read to the end by nobody.
      conversation: String(s.conversation || '').slice(0, 8),
      client: s.client || '',
      project: (s.dimensions || {}).project || '',
      active: !!s.active,
      requests: s.requests || 0,
      starved: s.starved || 0,
      cacheRead: 0, cacheCreation: 0, input: 0, output: 0, context: 0,
      accounts: Object.keys(s.pins || {}).map(function (b) { return s.pins[b]; }).join(', '),
      lastSeen: s.lastSeen || 0,
    };
    Object.keys(buckets).forEach(function (b) {
      var t = buckets[b] || {};
      row.cacheRead += t.cacheRead || 0;
      row.cacheCreation += t.cacheCreation || 0;
      row.input += t.input || 0;
      row.output += t.output || 0;
      row.context += t.context || 0;
    });
    row.total = row.cacheRead + row.cacheCreation + row.input + row.output;
    return row;
  });
}

export function filterSessionRows(rows, filters) {
  var f = filters || {};
  return (rows || []).filter(function (r) {
    if (f.project && r.project !== f.project) return false;
    if (f.client && r.client !== f.client) return false;
    return true;
  });
}

// Text sorts alphabetically, numbers numerically. A missing value sorts as
// empty/zero rather than dropping the row.
export function sortRows(rows, key, dir) {
  var sign = dir === 'asc' ? 1 : -1;
  return (rows || []).slice().sort(function (a, b) {
    var x = a[key], y = b[key];
    if (typeof x === 'string' || typeof y === 'string') {
      return sign * String(x == null ? '' : x).localeCompare(String(y == null ? '' : y));
    }
    return sign * ((x || 0) - (y || 0));
  });
}

// The order the account grid draws in, as indices into `accounts`: the ones
// serving first, then the blocked ones (disabled, or out of rotation for any
// other reason), each group keeping the fleet's own order. Indices rather than
// the accounts themselves so a card keeps the avatar colour its place in the
// fleet gives it, the same one its settings dialog shows.
export function accountDisplayOrder(accounts) {
  var serving = [], blocked = [];
  (accounts || []).forEach(function (a, i) { (a.disabled || a.unavailable ? blocked : serving).push(i); });
  return serving.concat(blocked);
}

export function uniqSorted(values) {
  var seen = Object.create(null);
  (values || []).forEach(function (v) { if (v) seen[v] = true; });
  return Object.keys(seen).sort();
}

// The request the switch button sends: POST /teamclaude/switch with the same
// key the status poll uses. Pure, so the test suite can send exactly this
// through a real proxy and prove the same-origin CSRF gate lets the page in.
export function switchRequest(name, key) {
  return {
    url: '/teamclaude/switch',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ account: name }),
    },
  };
}

// The request the threshold control sends. The number goes as typed: what
// counts as a percentage is the server's rule (1–100, kept to tenths), and a
// second opinion here would only disagree with it on the edges.
/**
 * @param {number|string} percent
 * @param {string|null|undefined} key
 */
export function thresholdRequest(percent, key) {
  return {
    url: '/teamclaude/threshold',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ percent: percent }),
    },
  };
}

// The stored 0–1 ratio as the number the control shows. Tenths, and no trailing
// zero: the setting is quantised to tenths of a percent, so 0.98 must read back
// as "98" rather than "98.0" for a re-save to be a no-op the operator can see.
/** @param {unknown} value */
export function thresholdPercentText(value) {
  /** @type {any} */ var ratio = value;
  // A per-bucket table: the control sets one number for every bucket, so what it
  // shows is the default the table falls back to.
  if (ratio && typeof ratio === 'object' && !Array.isArray(ratio)) ratio = ratio.default;
  if (typeof ratio !== 'number' || !isFinite(ratio)) return '';
  return String(Math.round(ratio * 1000) / 10);
}

// What to tell the operator after a threshold change. `dropped` is the part a
// bare "saved" would hide: one number replaces a per-bucket table rather than
// hiding one behind it, and the operator who set those buckets should hear it.
/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function thresholdOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'threshold change failed' + (res && res.error ? ': ' + res.error : '') };
  var pct = thresholdPercentText(res.switchThreshold);
  var dropped = res.dropped || [];
  if (dropped.length) return { kind: 'warn', text: 'switch threshold set to ' + pct + '% — dropped the per-bucket thresholds (' + dropped.join(', ') + ')' };
  return { kind: 'ok', text: 'switch threshold set to ' + pct + '%' };
}

// What to tell the operator afterwards. The endpoint answers `ok` for the choice
// being recorded and `eligible` for whether traffic will actually follow it —
// two different things, and a bare "done" would be a lie for a spent target.
/**
 * POST for an account control. `spec` is {place}/{priority} for a priority
 * move, or {disabled} to take an account out of rotation or put it back.
 *
 * @param {any} name
 * @param {{ place?: string, priority?: number, disabled?: boolean }} spec
 * @param {string|null} key
 */
export function accountControlRequest(name, spec, key) {
  var isPriority = spec.disabled === undefined;
  /** @type {{ account: any, place?: any, priority?: any, disabled?: any }} */
  var body = { account: name };
  if (isPriority) {
    if (spec.place) body.place = spec.place;
    else body.priority = spec.priority;
  } else {
    body.disabled = spec.disabled;
  }
  return {
    url: isPriority ? '/teamclaude/priority' : '/teamclaude/disable',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/**
 * What to tell the operator afterwards. A priority move reports the number it
 * landed on, which is the part the caller did not choose when it asked for
 * 'first' or 'last'.
 *
 * @param {any} res
 * @param {{ place?: string, priority?: number, disabled?: boolean }} spec
 */
export function accountControlOutcome(res, spec) {
  if (!res || !res.ok) return { kind: 'error', text: 'change failed' + (res && res.error ? ': ' + res.error : '') };
  if (spec.disabled !== undefined) {
    return { kind: 'ok', text: (res.disabled ? 'disabled ' : 'enabled ') + res.name };
  }
  return { kind: 'ok', text: res.name + ' priority ' + res.priority };
}

export function switchOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'switch failed' + (res && res.error ? ': ' + res.error : '') };
  if (res.eligible === false) return { kind: 'warn', text: 'switched to ' + res.account + ', but rotation will not use it' + (res.reason ? ': ' + res.reason : '') };
  return { kind: 'ok', text: 'switched to ' + res.account };
}

// One row per route the server reports — each model family the fleet meters
// separately, autocreated or configured — plus a trailing row for everything
// else, which goes to the current account. `target` is the server's own answer
// to "where does a request for this family land right now", so the page does
// not re-derive routing from quota bars; the eligible split says why a family
// is where it is.
export function routeRows(status) {
  var s = status || {};
  var blockedModels = s.blockedModels || [];
  var rows = (s.routes || []).map(function (r) {
    var accounts = r.accounts || [];
    var name = r.name || '';
    var match = r.match || [];
    var target = r.target || null;
    var pinned = r.pinned || null;
    return {
      kind: 'route',
      name: name,
      provider: r.provider || 'anthropic',
      label: name.charAt(0).toUpperCase() + name.slice(1),
      match: match.join(', '),
      target: target,
      pinned: pinned,
      // A pin the server is not honouring (its account cannot serve the
      // family right now): routing went elsewhere, and the row must say so
      // rather than let "pinned" read as "this is the pin".
      pinMismatch: !!pinned && pinned !== target,
      // The blocklist answers 400 before selection, so a route whose every
      // glob is blocked has a target no request will reach. A literal glob
      // comparison covers the common case; the server's overlap logic is not
      // shipped to the page.
      blocked: match.length > 0 && match.every(function (g) { return blockedModels.indexOf(g) !== -1; }),
      autocreated: !!r.autocreated,
      eligible: accounts.filter(function (a) { return a.eligible; }).map(function (a) { return a.name; }),
      ineligible: accounts.filter(function (a) { return !a.eligible; }).map(function (a) { return a.name; }),
    };
  });
  if (rows.length) {
    // The server reports one default per provider. A mixed Claude/Codex fleet
    // has two independent cursors, so collapsing these into one global row is
    // the exact ambiguity this table exists to remove. Older servers retain
    // the original single-row fallback.
    var defaults = s.defaultTargets || null;
    var providers = defaults ? Object.keys(defaults).sort(function (a, b) {
      if (a === 'anthropic') return -1;
      if (b === 'anthropic') return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }) : [];
    if (!providers.length) providers = [rows[0].provider || 'anthropic'];
    providers.forEach(function (provider) {
      var current = (s.currentAccounts && s.currentAccounts[provider]) || s.currentAccount || null;
      var cur = (s.accounts || []).filter(function (a) { return a.name === current; })[0];
      rows.push({
        kind: 'default', name: '',
        label: defaults ? providerLabel(provider) + ' default' : 'Everything else',
        provider: provider, match: '',
        target: defaults ? defaults[provider] : (s.defaultTarget || current), current: current,
        currentUnavailable: (cur && cur.unavailable) || null,
        pinned: null, pinMismatch: false, blocked: false, autocreated: false, eligible: [], ineligible: [],
      });
    });
  }
  return rows;
}

// Consecutive client requests that ended with nothing usable. Claude Code has
// its own retry loop, so two or three in a row are ordinary during a seconds-long
// upstream wobble; five with no success in between is past any blip and past the
// client's own budget. No age floor is needed — unlike a token-based guess, a
// streak of five is true of no healthy session at any age, so a floor would only
// delay a true positive.
export var STARVED_MIN = 5;
// The failure that makes this fire is usually fleet-wide, so every active
// conversation starves at once — and one fan-out is a dozen of them under one
// session's name. Naming all of them would bury the dashboard at the moment it
// matters most; the count carries the scale, three names carry enough to go and
// ask someone.
export var STARVED_LIST_MAX = 3;

/**
 * What is wrong right now, worst first, or an empty list. Only states that are
 * actionable and not ordinary operation: a spent weekly bucket, a rate-limit
 * back-off and an upstream refusal are rotation and back-off working, and
 * saying so every day would teach the reader to ignore the banner on the day it
 * matters.
 */
export function problems(status) {
  var s = status || {};
  var out = [];

  // Named when proxy.sessionDetail is on; otherwise the aggregate still says
  // that something is starving, which is the half that must not be opt-in.
  // When nothing can serve, every session starves and "it is failing" sends the
  // operator hunting for a broken token. Say which, if the fleet agrees on why.
  var accounts = s.accounts || [];
  var stalled = accounts.filter(function (a) { return a.unavailable === 'quota' || a.unavailable === 'throttled'; });
  var reasons = {};
  stalled.forEach(function (a) { reasons[a.unavailable] = true; });
  var why = accounts.length && stalled.length === accounts.length
    ? ' — every account is ' + (reasons.quota && reasons.throttled ? 'over its quota threshold or in a rate-limit hold'
      : reasons.quota ? 'over its quota threshold' : 'in a rate-limit hold') + '.'
    : ' — it is failing, not idle.';

  var sessions = s.sessions || {};
  var named = (sessions.items ? sessionRows(sessions) : []).filter(function (r) {
    return r.active && r.starved >= STARVED_MIN;
  }).sort(function (a, b) { return b.starved - a.starved; });
  named.slice(0, STARVED_LIST_MAX).forEach(function (r) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      // The session first, since that is the name an operator can go and find,
      // and the conversation after it, because a streak belongs to one agent of
      // a fan-out: without it three lines of one session read as the same line
      // three times. Omitted when the record carries no conversation.
      text: (r.client ? r.client + "'s session " : 'Session ') + r.session.slice(0, 8)
        + (r.conversation ? ', conversation ' + r.conversation + ',' : '')
        + ' has had ' + r.starved + ' requests in a row come back with nothing'
        + (r.project ? ' (' + r.project + ')' : '') + why,
    });
  });
  if (named.length > STARVED_LIST_MAX) {
    out.push({
      severity: 'bad', kind: 'starved-more',
      text: 'and ' + (named.length - STARVED_LIST_MAX) + ' more conversations are getting nothing back.',
    });
  }
  if (!named.length && (sessions.starvedMax || 0) >= STARVED_MIN) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      // A conversation, not a session: the streak is counted per conversation,
      // and a session whose other agents are answering fine is not starving.
      text: 'A conversation has had ' + sessions.starvedMax + ' requests in a row come back with nothing.'
        + ' Turn on proxy.sessionDetail to see which.',
    });
  }

  // Only the two states that do not clear themselves. `entitlement` is a
  // five-minute cooldown and `upstream-rejected` is upstream's way of saying a
  // shared bucket is spent — both expire on their own, like `quota` and
  // `throttled`, and none of them wants a person.
  var ATTENTION = { error: 'needs a re-login', disabled: 'is disabled' };
  (s.accounts || []).forEach(function (a) {
    var why = ATTENTION[a.unavailable];
    if (why) out.push({ severity: 'warn', kind: 'account', text: 'Account ' + a.name + ' ' + why + '.' });
  });

  // Deliberately no spend line. `usedMinor` is month-to-date overage, so on a
  // fleet that has overage switched on it is non-zero for most of the month —
  // an always-lit banner, which is the thing this is trying not to be. The
  // account card and `teamclaude status` both carry it, with the amount.

  return out;
}

// The usage views the page offers, derived from the windows the tracker
// actually keeps rather than listed again here: a window added or renamed in
// client-usage.js must not leave a button behind that reads zero for everyone.
// `total` is first because it is the lifetime counter the status payload has
// always carried, and the view the page opens on.
export const USAGE_VIEWS = [{ key: 'total', label: 'Total' }].concat(
  Object.keys(USAGE_WINDOWS).map(key => ({ key, label: 'Last ' + key })));

// Which counters one usage row shows. Every usage table reads the selected
// window through this, rather than each renderer reaching into `windows`
// itself — the Clients table and the per-dimension tables carry the same shape
// and must not drift into answering the same question differently.
/** @param {any} entry @param {string} [view] */
export function usageFor(entry, view) {
  var e = entry || {};
  var src = !view || view === 'total' ? e : ((e.windows || {})[view] || {});
  return {
    requests: src.requests || 0,
    connections: src.connections || 0,
    inputTokens: src.inputTokens || 0,
    outputTokens: src.outputTokens || 0,
  };
}

// The Clients chart's bars: every client on the window and measure being
// shown, largest first. Read through usageFor so the chart and the table under
// it cannot disagree about a window. `share` is of the shown total and `ratio`
// of the largest bar, so a bar's length and the percentage beside it answer
// the same question. Ties fall back to the name, or two equal clients would
// trade places on every poll. Nothing spent yet shares nothing, rather than
// dividing by zero into NaN widths.
/** @param {Record<string, any>|null|undefined} clients @param {string} [view] @param {string} [metric] */
export function clientRanking(clients, view, metric) {
  var all = clients || {};
  var rows = Object.keys(all).map(function (name) {
    var u = usageFor(all[name], view);
    return {
      name: name,
      value: metric === 'requests' ? u.requests : u.inputTokens + u.outputTokens,
      usage: u,
      lastUsed: (all[name] || {}).lastUsed || null,
      share: 0,
      ratio: 0,
    };
  });
  var total = 0, max = 0;
  rows.forEach(function (r) { total += r.value; if (r.value > max) max = r.value; });
  rows.forEach(function (r) {
    r.share = total ? r.value / total : 0;
    r.ratio = max ? r.value / max : 0;
  });
  rows.sort(function (a, b) { return (b.value - a.value) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
  return rows;
}

// The two requests Add account sends: start answers a sign-in link and the
// state naming it, finish hands back that state with the code Claude showed.
// The code is trimmed here because it is pasted, and a trailing newline from a
// copy is not part of it.
/** @param {string|null} key */
export function loginStartRequest(key) {
  return {
    url: '/teamclaude/login/start',
    init: { method: 'POST', headers: { 'x-api-key': key || '' } },
  };
}
/** @param {string} state @param {string} code @param {string|null} key */
export function loginFinishRequest(state, code, key) {
  return {
    url: '/teamclaude/login/finish',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ state: state, code: String(code || '').trim() }),
    },
  };
}
/** @param {any} res */
export function loginOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'adding the account failed' + (res && res.error ? ': ' + res.error : '') };
  // An account already in the config signing in again gets fresh tokens, not
  // a second row, and the note should not claim a new account appeared.
  return { kind: 'ok', text: (res.action === 'updated' ? 'signed in again as ' : 'added account ') + res.name };
}

// The requests the Users card sends: add, remove, role, and key (Show key).
// Each carries only the fields its endpoint reads, so a remove never ships a
// role it would ignore. The name is trimmed here because it is typed.
/** @param {'add'|'remove'|'role'|'key'} op @param {{ name: string, role?: string }} spec @param {string|null} key */
export function userRequest(op, spec, key) {
  /** @type {Record<string, unknown>} */
  var body = { name: String(spec.name || '').trim() };
  if (op === 'add' || op === 'role') body.role = spec.role;
  return {
    url: '/teamclaude/users/' + op,
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}
// Rotating the key this page is signed in with: the key is the whole request,
// since the server rotates whichever key it was sent.
/** @param {string|null} key */
export function rotateKeyRequest(key) {
  return { url: '/teamclaude/me/rotate', init: { method: 'POST', headers: { 'x-api-key': key || '' } } };
}
// The note after a user change. Built from the name and role only: the
// replies to add, key and rotate carry keys, and the note must never repeat one.
/** @param {'add'|'remove'|'role'|'key'|'rotate'} op @param {any} res */
export function userOutcome(op, res) {
  var failed = {
    add: 'adding the user failed', remove: 'removing the user failed', role: 'changing the role failed',
    key: 'showing the key failed', rotate: 'rotating the key failed',
  };
  if (!res || !res.ok) return { kind: 'error', text: failed[op] + (res && res.error ? ': ' + res.error : '') };
  if (op === 'add') return { kind: 'ok', text: 'added user ' + res.name };
  if (op === 'remove') return { kind: 'ok', text: 'removed user ' + res.name };
  if (op === 'key') return { kind: 'ok', text: 'showing the key of ' + res.name };
  if (op === 'rotate') return { kind: 'ok', text: 'rotated your key' };
  /** @type {Record<string, string>} */
  var as = { tenant: 'a user', admin: 'an admin', readonly: 'read-only' };
  return { kind: 'ok', text: res.name + ' is now ' + (as[res.role] || res.role) };
}

// Whether the caller the status payload names may use one of the page's
// controls, mirroring the server's gates (controlRole in server.js) so a button
// is offered only where it would be honoured. `action` is 'switch', 'reload',
// 'probe', 'accounts' (enable/disable and priority), 'threshold', 'users' or
// 'rotate'. A server older than `viewer` sends none, and every control shows
// as it always did — the server's 403 still has the final word either way.
// Rotating is the exception: it is by name rather than role, since only a
// named client key has a key of its own, whatever its role.
/** @param {{ role?: string, client?: string|null }|null|undefined} viewer @param {string} action */
export function viewerCan(viewer, action) {
  if (action === 'rotate') return !!(viewer && viewer.client);
  var role = viewer && viewer.role;
  if (!role || role === 'operator') return true;
  if (role === 'readonly') return false;
  return action === 'switch' || action === 'reload' || action === 'probe';
}

// The money helpers come from oauth.js and model.js rather than being written
// again here: they close over nothing, so their source text runs in the page
// as it is, and the card cannot format or judge a cap differently from
// `teamclaude status` and the router.
const SHARED_HELPERS = [
  scopedWeeklyRows, accountTokens, accountTokenSplit, providerLabel, thresholdBadgeText, accountBadges, sessionRows, filterSessionRows, sortRows, uniqSorted, accountDisplayOrder,
  switchRequest, switchOutcome, accountControlRequest, accountControlOutcome, thresholdRequest, thresholdPercentText, thresholdOutcome, routeRows, problems, usageFor,
  clientRanking, viewerCan, loginStartRequest, loginFinishRequest, loginOutcome, userRequest, userOutcome, rotateKeyRequest,
  formatMoney, resolveMaxSpendMinor, spendCapReached, extraUsageText, extraUsageBar, meterTone, clientGroups, seriesLines, userLineNames, userSlots, smoothPath, heatGrid, seriesTicks,
].map(fn => fn.toString()).join('\n\n');

// The constants ride along: `problems` closes over the thresholds and
// `accountBadges` over the reset-credit cut-off, so a page without them would
// ReferenceError on first render. The same goes for the two tables
// `thresholdBadgeText` reads. They follow the STARVED pair so the page's
// constants stay in one block ahead of the helpers that use them.
const SHARED_CONSTS = [
  `var STARVED_MIN = ${STARVED_MIN};`,
  `var STARVED_LIST_MAX = ${STARVED_LIST_MAX};`,
  `var RESET_CREDIT_MAX_AGE_MS = ${RESET_CREDIT_MAX_AGE_MS};`,
  `var THRESHOLD_BUCKET_KEYS = ${JSON.stringify(THRESHOLD_BUCKET_KEYS)};`,
  `var THRESHOLD_BUCKET_LABELS = ${JSON.stringify(THRESHOLD_BUCKET_LABELS)};`,
  `var USAGE_VIEWS = ${JSON.stringify(USAGE_VIEWS)};`,
].join('\n');

// The dark palette is the design's own and the default: true black, graphite
// cards, violet for what is fine, lime for what is in use or worth a look,
// coral for what is nearly gone. The light one is the same system turned over.
// Both are defined twice for the same reason as before: once under the media
// query, for a viewer who has stored no choice, and once under the attribute,
// for one who has. The media rule excludes an explicit dark choice, so choosing
// dark on a light desktop is honoured rather than overridden by the system.
const DARK_TOKENS = `
    color-scheme: dark;
    --bg: #000000; --card: #1C1C1E; --card-hover: #202023; --card-lift: #212124;
    --raised: #2C2C2E; --raised-hover: #3A3A3C; --row-hover: #2A2A2D; --toggle-off: #48484A;
    --line: rgba(255,255,255,0.06); --col-line: rgba(255,255,255,0.18); --dash: rgba(255,255,255,0.22); --dash-2: rgba(255,255,255,0.3);
    --text: #F5F5F7; --text-strong: #FFFFFF; --text-2: #D1D1D6; --muted: #AEAEB2; --dim: #8E8E93; --faint: #636366;
    --primary: #F5F5F7; --primary-hover: #FFFFFF; --on-primary: #000000; --primary-glow: 0 8px 24px rgba(255,255,255,0.14);
    --violet: #7B4CF5; --violet-hover: #8D63FF; --lilac: #A98BFF; --lilac-hover: #C9B6FF; --on-violet: #FFFFFF;
    --lime: #D6FF4F; --lime-text: #D6FF4F; --coral: #FF7A66; --coral-text: #FF9A88; --coral-soft: rgba(255,122,102,0.1);
    --amber: #FFD66B; --amber-soft: rgba(255,214,107,0.1);
    --tick-off: #2C2C2E; --tick-dim: #636366; --seg-off: #3A3A3C; --bar-dark: #2E2350;
    --heat-0: #241C38; --heat-1: #2A2045; --heat-2: #4A33A0; --heat-3: #7B4CF5; --heat-4: #A98BFF;
    --area: #D6FF4F; --logo-a: #F5F5F7; --bg-pill: #2C2C2E; --grid-dash: rgba(255,255,255,0.1);
    --user-0: #3987E5; --user-1: #D95926; --user-2: #199E70; --user-3: #C98500;
    --user-4: #D55181; --user-5: #9A3FB4; --user-6: #9085E9; --user-7: #E66767; --user-o: #8E8E93;
    --av0: #D6FF4F; --av1: #A98BFF; --av2: #FFB38A; --av3: #F5F5F7; --av4: #8FE3C8; --av5: #FFD66B; --av6: #C9B6FF; --av7: #FF9A88;
    --scrim: rgba(0,0,0,0.7); --shadow: 0 30px 80px rgba(0,0,0,0.7);`;

const LIGHT_TOKENS = `
    color-scheme: light;
    --bg: #F2F2F7; --card: #FFFFFF; --card-hover: #FCFCFD; --card-lift: #FFFFFF;
    --raised: #F0F0F5; --raised-hover: #E3E3E8; --row-hover: #F4F4F8; --toggle-off: #D1D1D6;
    --line: rgba(0,0,0,0.07); --col-line: rgba(0,0,0,0.14); --dash: rgba(0,0,0,0.2); --dash-2: rgba(0,0,0,0.26);
    --text: #1C1C1E; --text-strong: #000000; --text-2: #3A3A3C; --muted: #636366; --dim: #8E8E93; --faint: #AEAEB2;
    --primary: #1C1C1E; --primary-hover: #000000; --on-primary: #FFFFFF; --primary-glow: 0 8px 24px rgba(0,0,0,0.16);
    --violet: #7B4CF5; --violet-hover: #6A3BE8; --lilac: #6A3BE8; --lilac-hover: #5A2DD6; --on-violet: #FFFFFF;
    --lime: #B5E61D; --lime-text: #587300; --coral: #F2553F; --coral-text: #C8382A; --coral-soft: rgba(242,85,63,0.1);
    --amber: #B07D00; --amber-soft: rgba(217,154,0,0.12);
    --tick-off: #E8E8ED; --tick-dim: #AEAEB2; --seg-off: #E3E3E8; --bar-dark: #DCD2FF;
    --heat-0: #F3F0FB; --heat-1: #E4DBFF; --heat-2: #BCA6FF; --heat-3: #8D63FF; --heat-4: #6A3BE8;
    --area: #9CCB00; --logo-a: #1C1C1E; --bg-pill: #FFFFFF; --grid-dash: rgba(0,0,0,0.1);
    --user-0: #2A78D6; --user-1: #EB6834; --user-2: #1BAF7A; --user-3: #EDA100;
    --user-4: #E87BA4; --user-5: #9A3FB4; --user-6: #4A3AA7; --user-7: #E34948; --user-o: #8E8E93;
    --av0: #D6FF4F; --av1: #C9B6FF; --av2: #FFC9A8; --av3: #E5E5EA; --av4: #A8EBD5; --av5: #FFE08F; --av6: #DCD0FF; --av7: #FFB3A6;
    --scrim: rgba(28,28,30,0.3); --shadow: 0 30px 80px rgba(0,0,0,0.18);`;

// The settings button's gear, as the design draws it (Feather's "settings").
const GEAR_PATH = 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z';

// A stroked line icon, the design's 24-unit grid. `inner` is the shapes.
/** @param {string} inner @param {number} [size] @param {string} [attrs] */
function icon(inner, size = 18, attrs = '') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${attrs}>${inner}</svg>`;
}

const ICONS = {
  reload: icon('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path>', 16, ' id="reloadIcon" stroke-width="1.8"'),
  dark: icon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>', 16, ' class="i-dark" stroke-width="1.8"'),
  light: icon('<circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"></path>', 16, ' class="i-light" stroke-width="1.8"'),
  system: icon('<circle cx="12" cy="12" r="9"></circle><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"></path>', 16, ' class="i-system" stroke-width="1.8"'),
  usage: icon('<circle cx="12" cy="12" r="9.5"></circle><path d="M7 14l3-3 2.5 2.5L17 9"></path>'),
  time: icon('<circle cx="12" cy="12" r="9.5"></circle><path d="M12 7v5l3 2"></path>'),
  status: icon('<circle cx="12" cy="12" r="9.5"></circle><path d="M12 8v4M12 15.5v.5"></path>'),
  routing: icon('<circle cx="6" cy="6" r="2.5"></circle><circle cx="18" cy="18" r="2.5"></circle><path d="M8.5 6H14a4 4 0 0 1 0 8H10a4 4 0 0 0 0 8"></path>'),
  clients: icon('<circle cx="12" cy="12" r="9.5"></circle><path d="M8 10l2-2 2 2M10 8v8M16 14l-2 2-2-2M14 16V8"></path>'),
  users: icon('<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.7.8 2.7 2.6 3 5.2"></path>'),
  table: icon('<rect x="3.5" y="4.5" width="17" height="15" rx="3"></rect><path d="M3.5 10h17M9.5 10v9.5"></path>'),
};

// The overview's three column slots. They are markup rather than built per
// poll, so a new window or measure moves the columns (their width and height
// transition) instead of replacing them.
const GROUP_SLOTS = [0, 1, 2].map(i => `
          <div class="grp" id="grp${i}" style="display:none">
            <div class="grp-val" id="grp${i}Val"></div>
            <div class="grp-foot">
              <div class="grp-lbl"><b id="grp${i}Pct"></b><span id="grp${i}Name"></span></div>
              <div class="grp-bars" id="grp${i}Bars" aria-hidden="true"></div>
            </div>
          </div>`).join('');

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeamClaude</title>
<style>
  @font-face { font-family: 'DM Sans'; src: url(data:font/woff2;base64,${DM_SANS_WOFF2}) format('woff2'); font-weight: 400 600; font-style: normal; font-display: swap; }
  @font-face { font-family: 'DM Mono'; src: url(data:font/woff2;base64,${DM_MONO_WOFF2}) format('woff2'); font-weight: 400; font-style: normal; font-display: swap; }
  :root {${DARK_TOKENS}
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {${LIGHT_TOKENS}
    }
  }
  :root[data-theme="light"] {${LIGHT_TOKENS}
  }
  * { box-sizing: border-box; margin: 0; }
  html { background: var(--bg); scroll-behavior: smooth; }
  body { min-height: 100vh; background: var(--bg); color: var(--text); font: 14px/1.5 'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
  .mono, #key, .code-row input { font-family: 'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--lilac); text-decoration: none; }
  a:hover { color: var(--lilac-hover); }
  button { font: inherit; color: inherit; }
  input::placeholder { color: var(--faint); }
  :focus-visible { outline: 2px solid var(--violet); outline-offset: 2px; }
  @keyframes tcFade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes tcPop { from { opacity: 0; transform: translateY(12px) scale(.97); } to { opacity: 1; transform: none; } }
  @keyframes tcUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
  @keyframes tcGrow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 28px 28px 56px; }
  #app { display: flex; flex-direction: column; gap: 36px; }
  #overview, #accountsSec, #routesWrap, #clientsWrap { scroll-margin-top: 20px; }
  /* The entrance plays once, on the first status: the poll rebuilds the cards
     every few seconds, and an animation keyed to the element would replay. */
  .intro .rise { animation: tcUp .6s cubic-bezier(.2,.8,.2,1) both; }
  .intro .grp-bars i { animation: tcGrow .7s cubic-bezier(.2,.8,.2,1) both; }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; display: inline-block; background: var(--dim); }
  .dot.lime { background: var(--lime); } .dot.violet { background: var(--violet); } .dot.lilac { background: var(--lilac); }
  .dot.coral { background: var(--coral); } .dot.amber { background: var(--amber); } .dot.gray { background: var(--faint); }

  /* Buttons */
  .pill-btn { height: 42px; padding: 0 18px; border-radius: 999px; border: none; background: var(--primary); color: var(--on-primary); font-size: 13px; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; flex: none; transition: background .2s ease, color .2s ease, transform .15s ease, box-shadow .2s ease, opacity .2s ease; }
  .pill-btn:hover { background: var(--primary-hover); color: var(--on-primary); transform: translateY(-1px); box-shadow: var(--primary-glow); }
  .pill-btn:active { transform: scale(.95); }
  .pill-btn:disabled { opacity: .5; cursor: default; transform: none; box-shadow: none; }
  .pill-btn .glyph { font-size: 15px; line-height: 1; }
  .pill-btn.md { height: 38px; padding: 0 16px; }
  .pill-btn.sm { height: 34px; padding: 0 16px; }
  .pill-btn.xs { height: 32px; padding: 0 14px; font-size: 12px; }
  .pill-btn.quiet { background: var(--raised); color: var(--text); font-weight: 400; }
  .pill-btn.quiet:hover { background: var(--raised-hover); color: var(--text); transform: none; box-shadow: none; }
  .pill-btn.violet { background: var(--violet); color: var(--on-violet); }
  .pill-btn.violet:hover { background: var(--violet-hover); color: var(--on-violet); transform: none; box-shadow: none; }
  .pill-btn.xs:hover, .pill-btn.sm:hover { transform: none; box-shadow: none; }
  .icon-btn { width: 40px; height: 40px; flex: none; border-radius: 50%; border: none; background: var(--card); color: var(--text); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; font-size: 16px; line-height: 1; transition: background .2s ease, color .2s ease, transform .15s ease, opacity .2s ease; }
  .icon-btn:hover { background: var(--raised); }
  .icon-btn:active { transform: scale(.95); }
  .icon-btn:disabled { opacity: .5; cursor: default; }
  .icon-btn.sm { width: 36px; height: 36px; background: var(--raised); color: var(--text-2); }
  .icon-btn.sm:hover { background: var(--raised-hover); color: var(--text-strong); }
  .icon-btn.gear:hover { transform: rotate(60deg); }
  #reloadIcon { transition: transform .7s cubic-bezier(.3,1.3,.5,1); }
  #theme svg { display: none; }
  #theme[data-mode="system"] .i-system, #theme[data-mode="light"] .i-light, #theme[data-mode="dark"] .i-dark { display: block; }

  /* Header */
  .top { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; }
  .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .logo { width: 38px; height: 38px; flex: none; border-radius: 50%; background: conic-gradient(from 200deg, var(--logo-a) 0 25%, #A98BFF 25% 60%, #7B4CF5 60%); }
  .title { font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
  .nav { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
  .nav a { height: 38px; padding: 0 18px; border-radius: 999px; background: var(--card); color: var(--muted); font-size: 13px; display: flex; align-items: center; transition: background .2s ease, color .2s ease, transform .15s ease; }
  .nav a:hover { color: var(--text-strong); background: var(--raised); }
  .nav a:active { transform: scale(.96); }
  .nav a.sel { background: var(--primary); color: var(--on-primary); font-weight: 500; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
  .me { width: 40px; height: 40px; flex: none; border-radius: 50%; background: var(--lime); color: #000000; font-weight: 600; font-size: 15px; display: flex; align-items: center; justify-content: center; }

  /* Messages */
  #msgs { display: none; flex-direction: column; gap: 8px; }
  #problems { display: none; flex-direction: column; gap: 8px; }
  .alert { border-radius: 16px; padding: 12px 16px; font-size: 13px; display: flex; gap: 10px; align-items: flex-start; }
  .alert::before { content: ''; width: 6px; height: 6px; border-radius: 50%; margin-top: 7px; flex: none; background: currentColor; }
  .alert.bad { background: var(--coral-soft); color: var(--coral-text); }
  .alert.warn { background: var(--amber-soft); color: var(--amber); }
  #err { display: none; }
  #note { display: none; align-self: flex-start; align-items: center; gap: 8px; font-size: 12px; padding: 8px 14px; border-radius: 999px; background: var(--card); color: var(--muted); }
  #note::before { content: ''; width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dim); }
  #note.ok::before { background: var(--lime); } #note.warn::before { background: var(--amber); } #note.error::before { background: var(--coral); }
  #note.error { color: var(--coral-text); }

  /* Overview */
  .overview { display: flex; flex-direction: column; gap: 28px; }
  .ov-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .welcome { font-size: 40px; font-weight: 500; letter-spacing: -0.025em; line-height: 1.15; min-width: 0; overflow-wrap: anywhere; }
  .welcome .who { color: var(--dim); }
  .welcome .role { display: inline-flex; vertical-align: middle; align-items: center; height: 26px; padding: 0 11px; margin-left: 14px; border-radius: 999px; background: var(--card); color: var(--muted); font-size: 12px; font-weight: 500; letter-spacing: 0; position: relative; top: -3px; }
  .seg { display: inline-flex; padding: 3px; border-radius: 999px; background: var(--card); gap: 2px; position: relative; flex: none; }
  .seg button { height: 26px; padding: 0 12px; border-radius: 999px; border: none; background: transparent; color: var(--dim); font-size: 12px; cursor: pointer; position: relative; white-space: nowrap; transition: background .2s ease, color .2s ease, transform .15s ease; }
  .seg button:hover { color: var(--text); }
  .seg button:active { transform: scale(.95); }
  .seg button.sel { background: var(--raised-hover); color: var(--text); }
  .seg.lg { padding: 4px; }
  .seg.lg button { height: 34px; padding: 0 18px; font-size: 13px; font-weight: 500; }
  .seg-pill { position: absolute; top: 4px; bottom: 4px; left: 4px; width: 0; border-radius: 999px; background: var(--raised-hover); transition: left .35s cubic-bezier(.2,.8,.2,1), width .35s cubic-bezier(.2,.8,.2,1); }
  .seg.measured button.sel { background: transparent; }
  .hero { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 32px; align-items: end; }
  .hero-main { display: flex; flex-direction: column; gap: 18px; max-width: 380px; min-width: 0; }
  .hero-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .hero-label { font-size: 15px; color: var(--muted); }
  .hero-num { display: flex; align-items: flex-end; gap: 10px; min-width: 0; }
  .big { font-size: 64px; font-weight: 600; letter-spacing: -0.04em; line-height: .9; white-space: nowrap; }
  .big .frac { color: var(--faint); }
  .delta { font-size: 12px; color: var(--lime-text); padding-bottom: 4px; white-space: nowrap; }
  .hero-split { font-size: 13px; color: var(--muted); margin-top: -8px; }
  .routing-to { font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
  .routing-to b { color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 100%; }
  .routing-to .prov { color: var(--dim); }
  .hero-btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .groups-wrap { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .groups { position: relative; display: flex; height: 190px; }
  .avg-line { position: absolute; left: 0; right: 0; top: 72px; border-top: 1px dashed var(--dash); pointer-events: none; transition: top .6s cubic-bezier(.2,.8,.2,1); }
  .avg-pill { position: absolute; right: 18%; top: 72px; height: 22px; padding: 0 10px; border-radius: 999px; background: var(--bg-pill); color: var(--text); font-size: 11px; display: flex; align-items: center; transform: translateY(-50%); transition: top .6s cubic-bezier(.2,.8,.2,1); }
  .grp { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; justify-content: space-between; border-left: 1px solid var(--col-line); padding: 6px 16px 0 14px; transition: flex-grow .6s cubic-bezier(.2,.8,.2,1), padding-top .6s cubic-bezier(.2,.8,.2,1); }
  .grp-val { font-size: 16px; font-weight: 500; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grp-foot { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .grp-lbl { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grp-lbl b { color: var(--text); font-weight: 500; margin-right: 7px; }
  .grp-bars { height: 44px; display: flex; gap: 6px; overflow: hidden; }
  .grp-bars i { display: block; height: 100%; border-radius: 4px; transform-origin: bottom; transition: filter .2s ease; }
  .grp-bars i:hover { filter: brightness(1.35); }
  .grp-bars i.solid { flex: 1; min-width: 40px; background: var(--violet); }
  .grp-bars i.thin { flex: none; width: 7px; }
  .grp-bars i.dark { background: var(--bar-dark); }
  .groups-empty { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; font-size: 13px; color: var(--dim); border-left: 1px solid var(--col-line); }
  .range { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }

  /* Cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 14px; }
  .card { border-radius: 22px; background: var(--card); padding: 20px; display: flex; flex-direction: column; gap: 16px; min-width: 0; transition: background .25s ease; }
  .card:hover { background: var(--card-hover); }
  .card.flush { padding: 20px 0 6px; gap: 12px; }
  .card.flush > .card-head { padding: 0 20px; }
  .card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .card-title { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 500; }
  .card-title svg { flex: none; }
  .card-cap { font-size: 12px; color: var(--dim); white-space: nowrap; }
  .card-foot { font-size: 11px; color: var(--dim); margin-top: auto; }
  .legend { display: flex; gap: 16px; font-size: 12px; color: var(--muted); flex-wrap: wrap; align-items: center; min-height: 18px; }
  .legend span { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .sw { width: 11px; height: 11px; border-radius: 3px; flex: none; display: inline-block; }
  .sw.main { background: var(--area); } .sw.out { background: var(--lilac); }
  .sw.u0, .dot.u0, .sp-track i.u0 { background: var(--user-0); } .sw.u1, .dot.u1, .sp-track i.u1 { background: var(--user-1); }
  .sw.u2, .dot.u2, .sp-track i.u2 { background: var(--user-2); } .sw.u3, .dot.u3, .sp-track i.u3 { background: var(--user-3); }
  .sw.u4, .dot.u4, .sp-track i.u4 { background: var(--user-4); } .sw.u5, .dot.u5, .sp-track i.u5 { background: var(--user-5); }
  .sw.u6, .dot.u6, .sp-track i.u6 { background: var(--user-6); } .sw.u7, .dot.u7, .sp-track i.u7 { background: var(--user-7); }
  .sw.uo, .dot.uo, .sp-track i.uo { background: var(--user-o); }
  .sw.ok { background: var(--violet); } .sw.warn { background: var(--lime); } .sw.bad { background: var(--coral); }
  .legend.sm { gap: 14px; }
  .legend.sm .sw { width: 10px; height: 10px; }

  /* Usage over time */
  .plot { position: relative; height: 170px; }
  .plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .plot path { transition: d .6s cubic-bezier(.2,.8,.2,1); }
  .ga { stop-color: var(--area); stop-opacity: .22; } .gb { stop-color: var(--area); stop-opacity: 0; }
  #seriesMain { fill: none; stroke: var(--area); stroke-width: 2; }
  .oa { stop-color: var(--lilac); stop-opacity: .22; } .ob { stop-color: var(--lilac); stop-opacity: 0; }
  #seriesOutMain { fill: none; stroke: var(--lilac); stroke-width: 2; }
  /* Tokens split into an input and an output panel, each on its own scale. */
  .plot.split { height: 110px; }
  .panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; color: var(--muted); }
  .panel-head span { display: flex; align-items: center; gap: 7px; }
  .panel-scale { color: var(--dim); }
  .hover-cols { position: absolute; inset: 0; display: flex; }
  .hover-cols div { flex: 1; border-radius: 6px; }
  .hover-cols div:hover { background: var(--line); }
  .peak { position: absolute; top: 0; bottom: 0; left: 0; border-left: 1px dashed var(--dash-2); pointer-events: none; transition: left .6s cubic-bezier(.2,.8,.2,1); }
  .peak-tags { position: absolute; top: 4px; left: 0; display: flex; flex-direction: column; gap: 6px; transform: translateX(8px); pointer-events: none; transition: left .6s cubic-bezier(.2,.8,.2,1); }
  .peak-tags.flip { transform: translateX(calc(-100% - 8px)); align-items: flex-end; }
  .tag { height: 24px; padding: 0 9px; border-radius: 999px; background: var(--raised); color: var(--text); font-size: 11px; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .tag i { width: 3px; height: 12px; border-radius: 2px; background: var(--area); flex: none; }
  .tag.out i { background: var(--lilac); }
  .plot-empty { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; font-size: 12px; color: var(--dim); text-align: center; padding: 0 12px; }
  .ticks { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }

  /* Usage by user */
  #usersSec { gap: 14px; }
  .sub-title { font-size: 20px; font-weight: 500; letter-spacing: -0.02em; }
  .seg-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .seg.on-bg { background: var(--bg-pill); }
  .cards.fit { grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); }
  #spendCard { gap: 4px; }
  #spendCard .card-head { padding-bottom: 10px; }
  .sp-row { display: grid; grid-template-columns: minmax(90px,160px) minmax(0,1fr) auto; gap: 16px; align-items: center; padding: 12px 10px; margin: 0 -10px; border-radius: 14px; font-size: 13px; transition: background .2s ease; }
  .sp-row:hover { background: var(--row-hover); }
  .sp-name { display: flex; align-items: center; gap: 8px; font-weight: 500; min-width: 0; }
  .sp-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-track { height: 6px; border-radius: 999px; background: var(--raised); overflow: hidden; display: flex; gap: 2px; }
  .sp-track i { display: block; height: 100%; border-radius: 999px; flex: none; transition: width .6s cubic-bezier(.2,.8,.2,1); }
  .sp-track i.out { opacity: .45; }
  .sp-val { text-align: right; white-space: nowrap; min-width: 110px; }
  .sp-val b { font-weight: 500; }
  .sp-val span { color: var(--dim); }
  .sp-sub { font-size: 11px; color: var(--dim); margin-top: 2px; }
  .ug { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--grid-dash); pointer-events: none; }
  .ug.top { top: 0; } .ug.mid { top: 50%; } .ug.base { bottom: 0; border-top-style: solid; }
  .umax { position: absolute; top: 4px; left: 0; font-size: 11px; color: var(--dim); pointer-events: none; }
  .uplot path { fill: none; stroke-width: 2; }
  .uplot.out path { stroke-dasharray: 5 3; }
  .uplot path.u0 { stroke: var(--user-0); } .uplot path.u1 { stroke: var(--user-1); }
  .uplot path.u2 { stroke: var(--user-2); } .uplot path.u3 { stroke: var(--user-3); }
  .uplot path.u4 { stroke: var(--user-4); } .uplot path.u5 { stroke: var(--user-5); }
  .uplot path.u6 { stroke: var(--user-6); } .uplot path.u7 { stroke: var(--user-7); }
  .uplot path.uo { stroke: var(--user-o); }

  /* By time */
  .heat { display: grid; gap: 5px; align-items: center; }
  .heat .hd { font-size: 11px; color: var(--muted); text-align: center; padding-bottom: 4px; white-space: nowrap; overflow: hidden; }
  .heat .rl { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 4px; }
  .heat .cell { height: 28px; border-radius: 7px; background: var(--heat-0); transition: background .45s ease, transform .2s cubic-bezier(.3,1.5,.5,1), box-shadow .2s ease; }
  .heat .cell:hover { transform: scale(1.12); box-shadow: 0 0 0 2px var(--heat-4); }
  .heat .l1 { background: var(--heat-1); } .heat .l2 { background: var(--heat-2); } .heat .l3 { background: var(--heat-3); } .heat .l4 { background: var(--heat-4); }
  .heat-empty { display: none; align-items: center; justify-content: center; min-height: 150px; font-size: 12px; color: var(--dim); text-align: center; }
  .heat-legend { display: flex; justify-content: flex-end; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); margin-top: auto; }
  .heat-legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .heat-legend .l1 { background: var(--heat-1); } .heat-legend .l2 { background: var(--heat-2); } .heat-legend .l3 { background: var(--heat-3); } .heat-legend .l4 { background: var(--heat-4); }

  /* Proxy status */
  #statusCard { gap: 6px; }
  #statusCard .card-head { padding-bottom: 8px; }
  .live { height: 26px; padding: 0 10px; border-radius: 999px; background: var(--raised); font-size: 11px; display: flex; align-items: center; gap: 6px; }
  .kv { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 13px; gap: 12px; min-width: 0; }
  .kv.tail { border-bottom: none; padding: 10px 0; }
  .kv .k { color: var(--muted); flex: none; }
  .kv .v { font-weight: 500; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kv .v.kv-segs { display: flex; align-items: center; gap: 10px; }
  .thr-row { display: flex; gap: 6px; align-items: center; }
  .field { display: flex; align-items: center; height: 32px; border-radius: 999px; background: var(--raised); padding: 0 12px; gap: 2px; }
  .field input { width: 38px; background: transparent; border: none; outline: none; color: var(--text); font: inherit; font-size: 13px; text-align: right; -moz-appearance: textfield; appearance: textfield; }
  .field input::-webkit-inner-spin-button, .field input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .field span { color: var(--muted); }

  /* Accounts */
  .sec { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .sec-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .sec-title-row { display: flex; align-items: baseline; gap: 12px; }
  .sec-title { font-size: 24px; font-weight: 500; letter-spacing: -0.02em; }
  .sec-count { font-size: 13px; color: var(--dim); }
  .acct-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: 14px; }
  .acct { border-radius: 22px; background: var(--card); padding: 20px; display: flex; flex-direction: column; gap: 16px; min-width: 0; transition: opacity .3s ease, transform .3s cubic-bezier(.2,.8,.2,1), background .25s ease, box-shadow .3s ease; }
  .acct:hover { transform: translateY(-3px); background: var(--card-lift); }
  .acct.current { box-shadow: inset 0 0 0 1.5px var(--violet); }
  .acct.off { opacity: .45; }
  .acct.off > :not(.blocked) { filter: grayscale(1); }
  .acct.off:hover { opacity: .8; }
  .acct-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .acct-id { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .avatar { width: 40px; height: 40px; flex: none; border-radius: 50%; background: var(--av0); color: #000000; font-size: 15px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
  .avatar.av1 { background: var(--av1); } .avatar.av2 { background: var(--av2); } .avatar.av3 { background: var(--av3); } .avatar.av4 { background: var(--av4); }
  .avatar.av5 { background: var(--av5); } .avatar.av6 { background: var(--av6); } .avatar.av7 { background: var(--av7); }
  .avatar.lg { width: 44px; height: 44px; font-size: 16px; }
  .acct-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .acct-name { font-size: 15px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { height: 22px; padding: 0 9px; border-radius: 999px; background: var(--raised); color: var(--text-2); font-size: 11px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .blocked { font-size: 12px; color: var(--coral-text); background: var(--coral-soft); border-radius: 999px; padding: 7px 12px; display: flex; align-items: center; gap: 8px; align-self: flex-start; }
  .blocked::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--coral); flex: none; }
  .meters { display: flex; flex-direction: column; gap: 14px; }
  .meter { display: flex; flex-direction: column; gap: 8px; }
  .meter-top { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
  .meter-top .ml { color: var(--muted); white-space: nowrap; }
  .meter-top .ml b { color: var(--text); font-weight: 500; margin-right: 7px; }
  .meter-top .mv { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ticks-bar { display: flex; gap: 3px; height: 22px; }
  .ticks-bar i { flex: 1; border-radius: 3px; background: var(--tick-off); }
  .ticks-bar i.ok { background: var(--violet); } .ticks-bar i.warn { background: var(--lime); } .ticks-bar i.bad { background: var(--coral); } .ticks-bar i.off { background: var(--tick-dim); }
  .acct-note { font-size: 12px; color: var(--dim); }
  .acct-foot { font-size: 12px; color: var(--dim); border-top: 1px solid var(--line); padding-top: 12px; }

  /* Routing and clients */
  .duo { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 14px; align-items: start; }
  #routesWrap { gap: 10px; }
  #routesWrap .card-head { padding-bottom: 6px; }
  .rt-row { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr); gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--line); align-items: center; }
  .rt-row:last-child { border-bottom: none; }
  .rt-fam { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .rt-fam b { font-size: 14px; font-weight: 500; }
  .rt-glob { font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt-to { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; min-width: 0; }
  .target { height: 26px; padding: 0 10px; border-radius: 999px; background: var(--raised); font-size: 12px; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; overflow: hidden; white-space: nowrap; }
  .target .t { overflow: hidden; text-overflow: ellipsis; }
  .target.bad { color: var(--coral-text); }
  .rt-note { font-size: 11px; color: var(--dim); line-height: 1.4; }
  .rt-note.pin { color: var(--lilac); } .rt-note.warn { color: var(--amber); }
  .rt-can { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; text-align: right; min-width: 0; }
  .segs { display: flex; gap: 3px; }
  .segs i { width: 6px; height: 18px; border-radius: 2px; background: var(--seg-off); flex: none; }
  .segs i.on { background: var(--violet); }
  .segs.dense { width: 120px; } .segs.dense i { flex: 1; width: auto; min-width: 2px; }
  .rt-count, .rt-none { font-size: 11px; color: var(--dim); }
  .rt-none { font-size: 12px; }
  #routesFoot { display: none; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dim); }
  #clientsWrap { gap: 4px; }
  #clientsWrap .card-head { padding-bottom: 10px; }
  .cl-row { display: grid; grid-template-columns: minmax(0,1fr) auto minmax(90px,auto); gap: 12px; align-items: center; padding: 10px; margin: 0 -10px; border-radius: 14px; font-size: 13px; transition: background .2s ease, transform .2s ease; }
  .cl-row:hover { background: var(--row-hover); transform: translateX(3px); }
  .cl-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .last { height: 26px; padding: 0 10px; border-radius: 999px; background: var(--raised); font-size: 12px; color: var(--text-2); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .cl-val { text-align: right; white-space: nowrap; }
  .cl-val b { font-weight: 500; }
  .cl-val span { color: var(--dim); }
  /* Users (proxy.clientKeys) */
  .us-row { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 12px; align-items: center; padding: 8px 10px; margin: 0 -10px; border-radius: 14px; font-size: 13px; }
  .us-row:hover { background: var(--row-hover); }
  .us-row .you { color: var(--dim); font-weight: 400; margin-left: 6px; }
  #userRoleSeg { align-self: flex-start; }
  #userNote { font-size: 12px; color: var(--dim); line-height: 1.5; }
  #userNote.ok { color: var(--lime-text); } #userNote.error { color: var(--coral-text); }
  .us-acts { display: inline-flex; gap: 6px; justify-content: flex-end; }
  .us-keys { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 6px; }
  @media (max-width: 560px) { .us-row { grid-template-columns: minmax(0,1fr) auto; } .us-row .seg { grid-column: 1 / -1; justify-self: start; } }
  /* Your key (the header avatar) */
  button.me { border: none; padding: 0; cursor: pointer; }
  button.me:disabled { cursor: default; }
  #keyNote { font-size: 12px; color: var(--dim); line-height: 1.5; }
  #keyNote.ok { color: var(--lime-text); } #keyNote.error { color: var(--coral-text); }

  /* Tables */
  .tbl-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 440px; font-variant-numeric: tabular-nums; }
  table.wide { min-width: 980px; }
  th, td { text-align: left; padding: 12px; }
  th { font-size: 12px; font-weight: 400; color: var(--dim); border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child, td:first-child { padding-left: 20px; }
  th:last-child, td:last-child { padding-right: 20px; }
  td { font-size: 13px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--row-hover); }
  td.num, th.num { text-align: right; }
  td.dim { color: var(--faint); }
  td.soft { color: var(--dim); }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 0 20px 4px; }
  .filters label { color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .filters select { height: 30px; background: var(--raised); border: none; border-radius: 999px; color: var(--text); font: inherit; font-size: 12px; padding: 0 12px; }
  .hint { color: var(--dim); font-size: 12px; margin-left: auto; }

  /* Dialogs */
  .scrim { position: fixed; inset: 0; z-index: 50; background: var(--scrim); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 24px; animation: tcFade .25s ease both; }
  .dialog { width: 100%; max-width: 500px; max-height: calc(100vh - 48px); overflow: auto; border-radius: 26px; background: var(--card); box-shadow: var(--shadow); padding: 24px; display: flex; flex-direction: column; gap: 22px; animation: tcPop .35s cubic-bezier(.2,.9,.25,1.1) both; }
  .dialog.set { max-width: 440px; padding: 22px; gap: 16px; }
  .dlg-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .dlg-title { font-size: 20px; font-weight: 500; letter-spacing: -0.02em; }
  .step { display: flex; gap: 14px; align-items: flex-start; }
  .step-n { width: 28px; height: 28px; flex: none; border-radius: 50%; background: var(--violet); color: var(--on-violet); font-size: 13px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
  .step-body { display: flex; flex-direction: column; gap: 12px; flex: 1; min-width: 0; }
  .step-text { font-size: 14px; line-height: 1.5; color: var(--text-2); }
  .row-btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .code-row { display: flex; gap: 8px; }
  .code-row input { flex: 1; min-width: 0; height: 38px; border-radius: 999px; border: 1px solid transparent; background: var(--raised); color: var(--text); padding: 0 16px; font-size: 13px; outline: none; }
  .code-row input:focus { border-color: var(--violet); }
  #loginNote { font-size: 12px; color: var(--dim); line-height: 1.5; }
  #loginNote.ok { color: var(--lime-text); } #loginNote.error { color: var(--coral-text); }
  .set-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .set-id { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .set-id-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .set-name { font-size: 16px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .set-sub { font-size: 12px; color: var(--dim); }
  .set-rows { border-radius: 18px; background: var(--raised); display: flex; flex-direction: column; }
  .set-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 16px; }
  .set-row + .set-row { border-top: 1px solid var(--line); }
  .set-text { display: flex; flex-direction: column; gap: 3px; }
  .set-text .t { font-size: 14px; font-weight: 500; }
  .set-text .d { font-size: 12px; color: var(--muted); }
  .set-note { display: none; font-size: 12px; color: var(--dim); padding: 0 4px; }
  .set-note.ok { color: var(--lime-text); } .set-note.warn { color: var(--amber); } .set-note.error { color: var(--coral-text); }
  .inuse { height: 26px; padding: 0 10px; border-radius: 999px; background: var(--card); font-size: 12px; display: inline-flex; align-items: center; gap: 6px; flex: none; }
  .stepper { display: flex; align-items: center; gap: 4px; padding: 3px; border-radius: 999px; background: var(--card); flex: none; }
  .stepper button { width: 30px; height: 30px; border-radius: 50%; border: none; background: transparent; color: var(--text-2); font-size: 16px; cursor: pointer; transition: background .2s ease, color .2s ease, transform .15s ease; }
  .stepper button:hover { background: var(--raised-hover); color: var(--text-strong); }
  .stepper button:active { transform: scale(.95); }
  .stepper button:disabled { opacity: .5; cursor: default; }
  .stepper .val { min-width: 22px; text-align: center; font-size: 14px; font-weight: 500; }
  .toggle { width: 44px; height: 26px; flex: none; border-radius: 999px; border: none; padding: 3px; background: var(--toggle-off); cursor: pointer; display: flex; justify-content: flex-start; transition: background .15s ease, transform .15s ease; }
  .toggle:active { transform: scale(.95); }
  .toggle.on { background: var(--violet); }
  .toggle:disabled { opacity: .5; cursor: default; }
  .toggle span { width: 20px; height: 20px; border-radius: 50%; background: #FFFFFF; box-shadow: 0 1px 3px rgba(0,0,0,0.4); transition: transform .25s cubic-bezier(.3,1.4,.5,1); }
  .toggle.on span { transform: translateX(18px); }

  /* Key prompt */
  #keybox { display: none; max-width: 400px; margin: 12vh auto 0; }
  .keycard { border-radius: 26px; background: var(--card); box-shadow: var(--shadow); padding: 28px; display: flex; flex-direction: column; gap: 16px; animation: tcPop .35s cubic-bezier(.2,.9,.25,1.1) both; }
  .keycard p { color: var(--muted); font-size: 13px; }
  #key { width: 100%; height: 42px; border-radius: 999px; border: 1px solid transparent; background: var(--raised); color: var(--text); padding: 0 16px; font-size: 13px; outline: none; }
  #key:focus { border-color: var(--violet); }

  @media (max-width: 860px) {
    .top { grid-template-columns: 1fr auto; }
    .nav { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
  }
  @media (max-width: 560px) {
    .wrap { padding: 20px 16px 40px; }
    #app { gap: 28px; }
    .welcome { font-size: 30px; }
    .big { font-size: 52px; }
    .nav a { padding: 0 14px; }
    .rt-row { grid-template-columns: 1fr; gap: 8px; }
    .rt-can { align-items: flex-start; text-align: left; }
    .avg-pill { right: 8%; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
<script>
(function () {
  try {
    var t = localStorage.getItem('teamclaude-dashboard-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage disabled: the media query still decides */ }
})();
</script>
</head>
<body>
<main class="wrap">
  <div id="keybox">
    <div class="keycard">
      <div class="brand"><div class="logo" aria-hidden="true"></div><div class="title">TeamClaude</div></div>
      <p>Enter your proxy key to view status.</p>
      <input id="key" type="password" placeholder="tc-..." autocomplete="off">
      <button id="go" class="pill-btn" type="button">Connect</button>
    </div>
  </div>
  <div id="app" style="display:none">
    <header class="top">
      <div class="brand"><div class="logo" aria-hidden="true"></div><div class="title">TeamClaude</div></div>
      <nav class="nav" aria-label="Sections">
        <a id="navOverview" class="sel" href="#overview">Overview</a>
        <a id="navAccounts" href="#accountsSec">Accounts</a>
        <a id="navRouting" href="#routesWrap">Routing</a>
        <a id="navClients" href="#clientsWrap">Clients</a>
      </nav>
      <div class="actions">
        <button id="reload" class="icon-btn" type="button" title="Reload config" aria-label="Reload config">${ICONS.reload}</button>
        <button id="theme" class="icon-btn" type="button">${ICONS.system}${ICONS.light}${ICONS.dark}</button>
        <button id="me" class="me" type="button" style="display:none"></button>
      </div>
    </header>

    <div id="msgs">
      <div id="problems"></div>
      <div id="err" class="alert bad"></div>
      <div id="note"></div>
    </div>

    <section id="overview" class="overview rise">
      <div class="ov-head">
        <h1 class="welcome" id="welcome">Welcome back</h1>
        <div class="seg lg" id="usageViewWrap" role="group" aria-label="Usage window"><span class="seg-pill" id="viewPill" aria-hidden="true"></span></div>
      </div>
      <div class="hero">
        <div class="hero-main">
          <div class="hero-top">
            <div class="hero-label" id="heroLabel">Tokens used</div>
            <span class="seg" id="clientChartMetric" role="group" aria-label="Measure"></span>
          </div>
          <div class="hero-num">
            <div class="big" id="heroNum"><span id="heroMain">0</span><span class="frac" id="heroFrac"></span></div>
            <div class="delta" id="heroDelta" style="display:none"></div>
          </div>
          <div class="hero-split" id="heroSplit" style="display:none"></div>
          <div class="routing-to" id="statActive"></div>
          <div class="hero-btns">
            <button id="addAcct" class="pill-btn" type="button">Add account <span class="glyph" aria-hidden="true">+</span></button>
            <button id="probe" class="pill-btn" type="button"><span id="probeText">Probe quotas</span> <span class="glyph" aria-hidden="true">↻</span></button>
          </div>
        </div>
        <div class="groups-wrap" id="clientChartWrap" style="display:none">
          <div class="groups" id="clientChart">
            <div class="avg-line" id="avgLine" style="display:none"></div>
            <div class="avg-pill" id="avgPill" style="display:none">Average</div>
            <div class="groups-empty" id="groupsEmpty"></div>${GROUP_SLOTS}
          </div>
          <div class="range"><span id="rangeStart">All time</span><span>now</span></div>
        </div>
      </div>
    </section>

    <div class="cards fit" id="cardsRow">
      <section class="card rise" id="seriesWrap" style="display:none;animation-delay:.1s">
        <div class="card-head">
          <h2 class="card-title">${ICONS.usage}Usage over time</h2>
          <div class="card-cap" id="seriesCaption"></div>
        </div>
        <div class="legend"><span><i class="sw main"></i>All users</span></div>
        <div class="panel-head" id="seriesInHead" style="display:none"><span><i class="sw main"></i>Input</span><span class="panel-scale" id="seriesInMax"></span></div>
        <div class="plot" id="seriesPlot">
          <svg viewBox="0 0 400 170" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="tcArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ga"></stop><stop offset="1" class="gb"></stop></linearGradient></defs>
            <path id="seriesArea" fill="url(#tcArea)" d=""></path>
            <path id="seriesMain" vector-effect="non-scaling-stroke" d=""></path>
          </svg>
          <div class="peak" id="peakLine" style="display:none"></div>
          <div class="peak-tags" id="peakTags" style="display:none">
            <div class="tag"><i></i><span id="peakMain"></span></div>
          </div>
          <div class="hover-cols" id="seriesHover"></div>
          <div class="plot-empty" id="seriesEmpty"></div>
        </div>
        <div class="panel-head" id="seriesOutHead" style="display:none"><span><i class="sw out"></i>Output</span><span class="panel-scale" id="seriesOutMax"></span></div>
        <div class="plot split" id="seriesOutPlot" style="display:none">
          <svg viewBox="0 0 400 170" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="tcAreaOut" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="oa"></stop><stop offset="1" class="ob"></stop></linearGradient></defs>
            <path id="seriesOutArea" fill="url(#tcAreaOut)" d=""></path>
            <path id="seriesOutMain" vector-effect="non-scaling-stroke" d=""></path>
          </svg>
          <div class="peak" id="peakOutLine" style="display:none"></div>
          <div class="peak-tags" id="peakOutTags" style="display:none">
            <div class="tag out"><i></i><span id="peakOut"></span></div>
          </div>
          <div class="hover-cols" id="seriesOutHover"></div>
        </div>
        <div class="ticks" id="seriesTicks"></div>
      </section>

      <section class="card rise" id="statusCard" style="animation-delay:.26s">
        <div class="card-head">
          <h2 class="card-title">${ICONS.status}Proxy status</h2>
          <div class="live"><span class="dot lime" id="liveDot"></span><span id="liveText">Live</span></div>
        </div>
        <div class="kv"><span class="k">Conversations</span><span class="v" id="statConv">—</span></div>
        <div class="kv"><span class="k">Uptime</span><span class="v" id="statUp">—</span></div>
        <div class="kv"><span class="k">Accounts active</span><span class="v kv-segs" id="statServing">—</span></div>
        <div class="kv tail" id="thrWrap">
          <label class="k" for="thrVal">Auto-switch at</label>
          <div class="thr-row">
            <span class="field"><input id="thrVal" type="number" min="1" max="100" step="0.1" inputmode="decimal" aria-label="Auto-switch threshold"><span>%</span></span>
            <button id="thrSet" class="pill-btn xs" type="button">Set</button>
          </div>
        </div>
        <div class="card-foot" id="foot"></div>
      </section>
    </div>

    <section class="sec" id="accountsSec">
      <div class="sec-head">
        <div class="sec-title-row"><h2 class="sec-title">Accounts</h2><span class="sec-count" id="acctCount"></span></div>
        <div class="legend sm" aria-label="Meter colours">
          <span><i class="sw ok"></i>Under 60%</span>
          <span><i class="sw warn"></i>60–90%</span>
          <span><i class="sw bad"></i>Over 90%</span>
        </div>
      </div>
      <div class="acct-grid" id="accounts"></div>
    </section>

    <div class="duo" id="tablesRow" style="display:none">
      <section class="card rise" id="routesWrap" style="display:none;animation-delay:.3s">
        <div class="card-head"><h2 class="card-title">${ICONS.routing}Routing</h2></div>
        <div id="routes"></div>
        <div id="routesFoot"></div>
      </section>
      <section class="card rise" id="clientsWrap" style="display:none;animation-delay:.36s">
        <div class="card-head">
          <h2 class="card-title">${ICONS.clients}<span id="clientsHeading">Clients</span></h2>
          <span class="card-cap">Requests · tokens in / out</span>
        </div>
        <div id="clients"></div>
      </section>
    </div>

    <section class="sec rise" id="usersSec" style="display:none;animation-delay:.42s">
      <div class="sec-head">
        <h2 class="sub-title">Usage by user</h2>
        <div class="seg-row">
          <span class="seg on-bg" id="userViewSeg" role="group" aria-label="Usage by user: window"></span>
          <span class="seg on-bg" id="userMetricSeg" role="group" aria-label="Usage by user: measure"></span>
        </div>
      </div>
      <div class="cards fit">
        <section class="card" id="spendCard">
          <div class="card-head"><h3 class="card-title">${ICONS.users}Spend by user</h3></div>
          <div id="spendRows"></div>
        </section>
        <section class="card" id="heatWrap" style="display:none">
          <div class="card-head"><h3 class="card-title">${ICONS.time}<span id="heatTitle">Tokens by time</span></h3></div>
          <div class="heat" id="heat"></div>
          <div class="heat-empty" id="heatEmpty"></div>
          <div class="heat-legend" id="heatLegend"><span style="margin-right:3px">Less</span><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span style="margin-left:3px">More</span></div>
        </section>
      </div>
      <section class="card" id="userChartCard">
        <div class="card-head">
          <h3 class="card-title">${ICONS.usage}Usage over time</h3>
          <div class="card-cap" id="userCaption"></div>
        </div>
        <div class="legend" id="userLegend"></div>
        <div class="panel-head" id="userInHead" style="display:none"><span>Input</span></div>
        <div class="plot uplot" id="userPlot">
          <div class="ug top"></div><div class="ug mid"></div><div class="ug base"></div>
          <div class="umax" id="userMax"></div>
          <svg id="userLines" viewBox="0 0 400 170" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="hover-cols" id="userHover"></div>
          <div class="plot-empty" id="userEmpty"></div>
        </div>
        <div class="panel-head" id="userOutHead" style="display:none"><span>Output</span></div>
        <div class="plot uplot split out" id="userOutPlot" style="display:none">
          <div class="ug top"></div><div class="ug mid"></div><div class="ug base"></div>
          <div class="umax" id="userOutMax"></div>
          <svg id="userOutLines" viewBox="0 0 400 170" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="hover-cols" id="userOutHover"></div>
        </div>
        <div class="ticks" id="userTicks"></div>
      </section>
    </section>

    <section class="card rise" id="userAdminSec" style="display:none">
      <div class="card-head">
        <h2 class="card-title">${ICONS.users}Users</h2>
        <div class="seg-row">
          <span class="card-cap" id="userCount"></span>
          <button id="addUser" class="pill-btn sm" type="button">Add user <span class="glyph" aria-hidden="true">+</span></button>
        </div>
      </div>
      <div id="userRows"></div>
    </section>

    <div id="dimensionsWrap" class="duo" style="display:none"></div>

    <section class="card flush" id="sessionsWrap" style="display:none">
      <div class="card-head"><h2 class="card-title">${ICONS.table}Sessions</h2></div>
      <div class="filters">
        <label>Project <select id="fProject"></select></label>
        <label>Client <select id="fClient"></select></label>
        <span class="hint" id="sessionCount"></span>
      </div>
      <div class="tbl-wrap"><table id="sessions" class="wide"></table></div>
    </section>
  </div>

  <div id="loginWrap" class="scrim" style="display:none">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
      <div class="dlg-head">
        <div class="dlg-title" id="loginTitle">Add a Claude account</div>
        <button id="loginClose" class="icon-btn sm" type="button" title="Close" aria-label="Close">×</button>
      </div>
      <div class="step">
        <div class="step-n">1</div>
        <div class="step-body">
          <div class="step-text">Open the sign-in link and sign in as the account you want to add.</div>
          <div class="row-btns">
            <a id="loginLink" class="pill-btn md" target="_blank" rel="noopener noreferrer">Open sign-in link ↗</a>
            <button id="loginCopy" class="pill-btn md quiet" type="button">Copy link</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-n">2</div>
        <div class="step-body">
          <div class="step-text">Claude shows a code. Paste it here.</div>
          <div class="code-row">
            <input id="loginCode" type="text" placeholder="Code from the sign-in page" autocomplete="off" spellcheck="false">
            <button id="loginGo" class="pill-btn md violet" type="button">Add</button>
          </div>
        </div>
      </div>
      <div id="loginNote"></div>
    </section>
  </div>

  <div id="userWrap" class="scrim" style="display:none">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="userTitle">
      <div class="dlg-head">
        <div class="dlg-title" id="userTitle">Add a user</div>
        <button id="userClose" class="icon-btn sm" type="button" title="Close" aria-label="Close">×</button>
      </div>
      <div id="userForm" class="step-body">
        <div class="step-text">Each user gets a key of their own; what they spend is booked to their name.</div>
        <div class="code-row">
          <input id="userNameIn" type="text" placeholder="Name, e.g. alice or ci-nightly" autocomplete="off" spellcheck="false" maxlength="64">
        </div>
        <span class="seg on-bg" id="userRoleSeg" role="group" aria-label="New user role"></span>
        <div class="row-btns"><button id="userGo" class="pill-btn md violet" type="button">Add user</button></div>
      </div>
      <div id="userKeyWrap" class="step-body" style="display:none">
        <div class="step-text">Give this key to <b id="userKeyFor"></b>. They use it as the proxy key (<code>x-api-key</code>).</div>
        <div class="code-row">
          <input id="userKey" type="text" readonly autocomplete="off" spellcheck="false">
          <button id="userKeyCopy" class="pill-btn md quiet" type="button">Copy</button>
        </div>
        <div class="row-btns"><button id="userDone" class="pill-btn md" type="button">Done</button></div>
      </div>
      <div id="userNote"></div>
    </section>
  </div>

  <div id="keyWrap" class="scrim" style="display:none">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="keyTitle">
      <div class="dlg-head">
        <div class="dlg-title" id="keyTitle">Your key</div>
        <button id="keyClose" class="icon-btn sm" type="button" title="Close" aria-label="Close">×</button>
      </div>
      <div id="keyForm" class="step-body">
        <div class="step-text">Rotating gives <b id="keyFor"></b> a new key and stops the old one at once. Every Claude Code client still using the old key will need the new one.</div>
        <div class="row-btns"><button id="keyRotate" class="pill-btn md" type="button">Rotate key</button></div>
      </div>
      <div id="keyNewWrap" class="step-body" style="display:none">
        <div class="step-text">Your new key. This page has switched to it; give it to your Claude Code clients as the proxy key (<code>x-api-key</code>).</div>
        <div class="code-row">
          <input id="keyNew" type="text" readonly autocomplete="off" spellcheck="false">
          <button id="keyNewCopy" class="pill-btn md quiet" type="button">Copy</button>
        </div>
        <div class="row-btns"><button id="keyDone" class="pill-btn md" type="button">Done</button></div>
      </div>
      <div id="keyNote"></div>
    </section>
  </div>

  <div id="settingsWrap" class="scrim" style="display:none">
    <section class="dialog set" id="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="setName"></section>
  </div>
</main>
<script>
(function () {
  'use strict';
  var KEY = 'teamclaude-dashboard-key';
  var THEME_KEY = 'teamclaude-dashboard-theme';
  var POLL_MS = 5000;
  var timer = null;
  var lastStatus = null;
  var sessionFilters = { project: '', client: '' };
  var sortState = { sessions: { key: 'lastSeen', dir: 'desc' } };
  // The usage window applies to every view the usage trackers feed (the
  // overview, both charts, Clients and each configured dimension), so it is
  // page state rather than per-table: two controls left on different windows
  // would invite reading one number against the other. Like the sort, it
  // survives the poll.
  var usageView = 'total';
  var usageButtons = [];
  // The measure the overview and both charts show, page state like the window.
  var CHART_METRICS = [{ key: 'tokens', label: 'Tokens' }, { key: 'requests', label: 'Requests' }];
  var chartMetric = 'tokens';
  var chartButtons = [];
  // Usage by user has a window and measure of its own, as the design gives it
  // its own controls. They sit in its heading row, so what the section shows
  // is named beside it rather than inherited from the top of the page.
  var userView = 'total';
  var userMetric = 'tokens';
  var userViewButtons = [];
  var userMetricButtons = [];
  // The usage series behind the two charts, fetched on its own (GET
  // /teamclaude/usage/series) after each status poll that shows a client. One
  // fetch at a time: a slow answer is not stacked behind by the next poll's.
  var lastSeries = null;
  var seriesError = null;
  var seriesInFlight = false;
  // How the header names a signed-in client key's role.
  var VIEWER_ROLE_TEXT = { operator: 'admin', tenant: 'user', readonly: 'read-only' };
  // Add account: the state naming the sign-in link now open, or null. The
  // server holds everything else about that login; the link is only opened.
  var loginState = null;
  // The Users card: the roles in the order its buttons show them, and how each
  // is named in a "Make bob ..." title. A tenant is shown as a plain user, the
  // way the header already names a tenant viewer.
  var USER_ROLE_OPTIONS = [['tenant', 'User', 'a user'], ['admin', 'Admin', 'admin'], ['readonly', 'Read-only', 'read-only']];
  // The user whose Remove has been pressed once and now asks to be confirmed,
  // and what the rows were last built from: a poll that changes nothing leaves
  // them alone, so a pending Confirm is not rebuilt out from under the pointer.
  var userConfirm = null;
  var userRowsFrom = '';
  // Add user's dialog: whether it is open, and the role picked for the new user.
  var userDialogOpen = false;
  var newUserRole = 'tenant';
  var newUserRoleButtons = [];
  // The keys Show key fetched, as { name, keys }, until Hide: kept out of
  // userRowsFrom, which only needs to know whose they are.
  var userShown = null;
  // Your key's dialog: whether it is open, and whether Rotate has been pressed
  // once and now asks to be confirmed.
  var keyDialogOpen = false;
  var keyConfirm = false;
  // The account whose settings dialog is open, by name, and what its rows were
  // last built from: the poll rebuilds the dialog only when that changes, so a
  // focused control is not pulled out from under the keyboard every 5s.
  var settingsFor = null;
  var settingsBuiltFrom = '';
  var settingsNote = null;
  var AVATARS = 8;
  var TICKS = 30;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var GEAR_PATH = ${JSON.stringify(GEAR_PATH)};
  var UNAVAILABLE_TEXT = ${JSON.stringify(UNAVAILABLE_TEXT)};
  // Motion runs only where a browser draws frames; the figure is set outright
  // anywhere else (and under reduced motion the stylesheet stills the rest).
  var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  var win = typeof window !== 'undefined' ? window : null;
  var heroShown = null;
  var heroToken = 0;
  var introDone = false;
  var reloadTurns = 0;
  // The section nav: which section it marks, and the one last asked for, which
  // wins when two sections share a row (Routing and Clients sit side by side).
  var NAV = [['overview', 'navOverview'], ['accountsSec', 'navAccounts'], ['routesWrap', 'navRouting'], ['clientsWrap', 'navClients']];
  var navPicked = 'overview';
  var navHold = 0;
  var spyQueued = false;

${SHARED_CONSTS}

${SHARED_HELPERS}

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function byId(id) { return document.getElementById(id); }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // Status timestamps arrive in both shapes: epoch milliseconds (account
  // quota resets, account usage.lastUsed) and ISO strings (client lastUsed).
  // Date.parse() only handles strings, so numbers must pass through as-is —
  // feeding it a number silently yields NaN and the field just never renders.
  function parseTs(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    return Date.parse(v);
  }

  function fmtAgo(ts) {
    var t = parseTs(ts);
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function fmtIn(sec) {
    if (sec == null) return '';
    var s = Math.max(0, Math.round(sec));
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1) + 'h';
    return (s / 86400).toFixed(1) + 'd';
  }

  // Absolute wall-clock of a future timestamp: "17:30" today, "Wed 09:00"
  // beyond 24h — the countdown says how long, this says when.
  function fmtClock(ts) {
    var d = new Date(ts);
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (ts - Date.now() >= 86400000) {
      return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    }
    return time;
  }

  function fmtHM(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Where the charts' time axis ends: the history's own end once it has
  // loaded, and the clock until then.
  function seriesEnd() {
    return lastSeries && lastSeries.end ? lastSeries.end : Date.now();
  }

  // "3 pm", the way the heatmap heads its columns.
  function fmtHour(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric' }).toLowerCase();
  }

  function metricText(v, metric) {
    return fmtNum(v) + ((metric || chartMetric) === 'requests' ? ' req' : ' tok');
  }

  // A chart's scale label: a tenth is worth showing below ten, not above.
  function scaleText(v, metric) {
    return (v < 10 ? v.toFixed(1) : fmtNum(Math.round(v))) + ((metric || chartMetric) === 'requests' ? ' req' : ' tok');
  }

  // How many hours a chart spans, for its caption: what the series held, or the
  // window's length before it has landed.
  function spanHours(spanMs, view) {
    return (spanMs ? Math.round(spanMs / 3600000) : view === '5h' ? 5 : 24) + 'h';
  }

  // A share too small to round to 1% still says it is there.
  function fmtShare(share) {
    if (share > 0 && share < 0.005) return '<1%';
    return Math.round(share * 100) + '%';
  }

  function initialOf(name) {
    var m = String(name || '').match(/[A-Za-z0-9]/);
    return m ? m[0].toUpperCase() : '?';
  }

  // The part of an address before the @, where the list it is in has little
  // room; the full names go in the element's title.
  function shortName(name) {
    var s = String(name || '');
    var at = s.indexOf('@');
    return at > 0 ? s.slice(0, at) : s;
  }

  function isCurrentAccount(a, s) {
    return s.currentAccounts ? s.currentAccounts[a.provider] === a.name : a.name === s.currentAccount;
  }

  function providersOf(currentAccounts) {
    return currentAccounts ? Object.keys(currentAccounts).sort(function (a, b) {
      if (a === 'anthropic') return -1;
      if (b === 'anthropic') return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }) : [];
  }

  function hasClients(s) {
    return !!s && Object.keys(s.clients || {}).length > 0;
  }

  function avatar(name, index, cls) {
    var av = el('div', 'avatar av' + (index % AVATARS) + (cls ? ' ' + cls : ''), initialOf(name));
    av.setAttribute('aria-hidden', 'true');
    return av;
  }

  function gearIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    [['width', '16'], ['height', '16'], ['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '1.8'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]
      .forEach(function (p) { svg.setAttribute(p[0], p[1]); });
    var circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '3');
    svg.appendChild(circle);
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', GEAR_PATH);
    svg.appendChild(path);
    return svg;
  }

  // The dot a badge carries, by what it says: lime for the account in use and
  // for live traffic, coral for what stops it serving, amber for what is worth
  // a look, lilac for what sets it apart, grey for plain facts.
  function chipDot(cls) {
    var c = ' ' + cls + ' ';
    if (c.indexOf(' current ') !== -1) return 'lime';
    if (/ (disabled|error|exhausted|billing) /.test(c)) return 'coral';
    if (/ (throttled|extra-usage|entitlement|upstream-rejected|quota) /.test(c)) return 'amber';
    if (c.indexOf(' provider ') !== -1 || c.indexOf(' known ') !== -1) return 'lilac';
    if (c.indexOf(' sessions ') !== -1) return 'lime';
    return '';
  }

  // How recently a client was seen, as the dot on its Clients row: lime within
  // ten minutes, lilac within the hour, grey beyond.
  function recencyDot(ts) {
    var t = parseTs(ts);
    if (isNaN(t)) return 'gray';
    var age = Date.now() - t;
    return age < 600000 ? 'lime' : age < 3600000 ? 'lilac' : 'gray';
  }

  // One labelled meter: the figure set bright ahead of its label, what it is
  // measured against dim on the right, and a row of ticks lit to the figure,
  // coloured by meterTone unless a tone is given.
  function meter(label, ratio, figure, meta, tone, title) {
    var m = el('div', 'meter');
    if (title) m.title = title;
    var top = el('div', 'meter-top');
    var l = el('span', 'ml');
    l.appendChild(el('b', '', figure));
    l.appendChild(el('span', '', label));
    top.appendChild(l);
    if (meta) top.appendChild(el('span', 'mv', meta));
    m.appendChild(top);
    var bar = el('div', 'ticks-bar');
    bar.setAttribute('aria-hidden', 'true');
    var cls = tone || meterTone(ratio);
    var pct = ratio == null ? 0 : Math.max(0, Math.min(1, Number(ratio) || 0));
    // Anything above nothing lights a tick: an unlit row would read as the
    // zero it is not.
    var on = pct > 0 ? Math.max(1, Math.round(pct * TICKS)) : 0;
    for (var i = 0; i < TICKS; i++) bar.appendChild(el('i', i < on ? cls : ''));
    m.appendChild(bar);
    return m;
  }

  function quotaMeter(label, ratio, resetAt) {
    var pct = ratio == null ? null : Math.max(0, Math.min(1, Number(ratio)));
    var resetTs = parseTs(resetAt);
    var reset = !isNaN(resetTs) && resetTs > Date.now()
      ? fmtIn((resetTs - Date.now()) / 1000) + ' · ' + fmtClock(resetTs)
      : '';
    return meter(label, ratio, pct == null ? '?' : Math.round(pct * 100) + '%', reset);
  }

  function renderAccount(a, index, pos, s) {
    var viewer = s.viewer || null;
    var isCur = isCurrentAccount(a, s);
    // Blocked or disabled, it is greyed out (and sorted last by the caller).
    var card = el('div', 'acct rise' + (isCur ? ' current' : '') + (a.disabled || a.unavailable ? ' off' : ''));
    card.style.animationDelay = (0.35 + Math.min(pos, 10) * 0.05).toFixed(2) + 's';
    var head = el('div', 'acct-head');
    var id = el('div', 'acct-id');
    id.appendChild(avatar(a.name, index, ''));
    var text = el('div', 'acct-text');
    var name = el('div', 'acct-name', a.name);
    name.title = a.name;
    text.appendChild(name);
    var chips = el('div', 'chips');
    accountBadges(a, s.currentAccount, s.currentAccounts || null, null, s.switchThreshold, s.switchThresholds).forEach(function (badge) {
      var chip = el('span', 'chip ' + badge.cls);
      chip.appendChild(el('i', 'dot ' + chipDot(badge.cls)));
      chip.appendChild(el('span', '', badge.text));
      chips.appendChild(chip);
    });
    text.appendChild(chips);
    id.appendChild(text);
    head.appendChild(id);
    // Every control for the account lives in its settings dialog, offered to
    // whoever may use at least one of them (a tenant may switch, no more).
    if (viewerCan(viewer, 'switch') || viewerCan(viewer, 'accounts')) {
      var gear = el('button', 'icon-btn sm gear');
      gear.type = 'button';
      gear.title = 'Settings for ' + a.name;
      gear.setAttribute('aria-label', 'Settings for ' + a.name);
      gear.appendChild(gearIcon());
      gear.addEventListener('click', function () { openSettings(a.name); });
      head.appendChild(gear);
    }
    card.appendChild(head);
    // A disabled account says so by its dimmed card and its chip; the notice
    // is for an account that should be serving and is not.
    if (a.unavailable && a.unavailable !== 'disabled') {
      card.appendChild(el('div', 'blocked', 'Blocked — ' + (UNAVAILABLE_TEXT[a.unavailable] || a.unavailable)));
    }
    var meters = el('div', 'meters');
    var q = a.quota || {};
    if (q.unified5h != null || q.unified7d != null) {
      meters.appendChild(quotaMeter('Session', q.unified5h, q.unified5hReset));
      meters.appendChild(quotaMeter('Weekly', q.unified7d, q.unified7dReset));
      // Model-scoped weekly buckets are learned from the usage endpoint rather
      // than declared, so hard-coding the two families that have dedicated
      // fields drew an incomplete picture the moment upstream metered a third.
      scopedWeeklyRows(q).forEach(function (r) { meters.appendChild(quotaMeter(r.label, r.utilization, r.resetAt)); });
    } else if (q.tokensLimit != null && q.tokensRemaining != null) {
      meters.appendChild(quotaMeter('Tokens', 1 - q.tokensRemaining / q.tokensLimit, q.resetsAt));
    } else {
      meters.appendChild(el('div', 'acct-note', 'Quota unknown — no traffic observed yet'));
    }
    // Extra usage after the quota meters. The figure is money rather than a
    // percentage; the rest (billing now, switched off and why) is the tooltip.
    var xu = extraUsageBar(a);
    if (xu) meters.appendChild(meter('Extra', xu.ratio, xu.used, xu.rest, xu.off ? 'off' : null, xu.title));
    card.appendChild(meters);
    var u = a.usage || {};
    var last = u.lastUsed ? ' · last ' + fmtAgo(u.lastUsed) : '';
    // Input is the uncached figure and both cache fields, as accountTokens adds
    // them; the tooltip takes the three apart.
    var sides = accountTokenSplit(u);
    var foot = el('div', 'acct-foot', (u.totalRequests || 0) + ' req · ' + fmtNum(sides.input) + ' in · ' + fmtNum(sides.output) + ' out' + last);
    foot.title = 'Input: ' + fmtNum(u.totalInputTokens || 0) + ' uncached, ' + fmtNum(u.totalCacheReadTokens || 0) + ' cache reads, '
      + fmtNum(u.totalCacheCreationTokens || 0) + ' cache writes · ' + fmtNum(accountTokens(u)) + ' tokens in all';
    card.appendChild(foot);
    return card;
  }

  // ── Account settings dialog ──────────────────────────────────────────────

  function openSettings(name) {
    settingsFor = name;
    settingsBuiltFrom = '';
    settingsNote = null;
    renderSettings();
    if (settingsFor) byId('settingsWrap').style.display = '';
  }

  function closeSettings() {
    settingsFor = null;
    settingsNote = null;
    byId('settingsWrap').style.display = 'none';
  }

  function settingsRow(title, desc) {
    var row = el('div', 'set-row');
    var text = el('div', 'set-text');
    text.appendChild(el('div', 't', title));
    text.appendChild(el('div', 'd', desc));
    row.appendChild(text);
    return row;
  }

  function renderSettings() {
    if (!settingsFor || !lastStatus) return;
    var s = lastStatus;
    var accounts = s.accounts || [];
    var index = -1;
    for (var i = 0; i < accounts.length; i++) if (accounts[i].name === settingsFor) { index = i; break; }
    // Gone from the fleet (a reload dropped it): nothing left to set.
    if (index === -1) { closeSettings(); return; }
    var a = accounts[index];
    var viewer = s.viewer || null;
    var isCur = isCurrentAccount(a, s);
    var from = [a.priority || 0, !!a.disabled, isCur, viewer ? viewer.role : ''].join('|');
    if (from === settingsBuiltFrom) return;
    settingsBuiltFrom = from;

    var d = byId('settingsDialog');
    d.textContent = '';
    var head = el('div', 'set-head');
    var ident = el('div', 'set-id');
    ident.appendChild(avatar(a.name, index, 'lg'));
    var text = el('div', 'set-id-text');
    var nm = el('div', 'set-name', a.name);
    nm.id = 'setName';
    nm.title = a.name;
    text.appendChild(nm);
    text.appendChild(el('div', 'set-sub', 'Account settings'));
    ident.appendChild(text);
    head.appendChild(ident);
    var close = el('button', 'icon-btn sm', '×');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeSettings);
    head.appendChild(close);
    d.appendChild(head);

    var rows = el('div', 'set-rows');
    if (viewerCan(viewer, 'switch')) {
      var cur = settingsRow('Current account', isCur ? 'New requests go here'
        : a.disabled ? 'Enable it to switch' : 'Route new requests here');
      if (isCur) {
        var use = el('span', 'inuse');
        use.appendChild(el('i', 'dot lime'));
        use.appendChild(el('span', '', 'In use'));
        cur.appendChild(use);
      } else if (!a.disabled) {
        var sw = el('button', 'pill-btn sm', 'Switch');
        sw.type = 'button';
        sw.addEventListener('click', function () { doSwitch(a.name, sw); });
        cur.appendChild(sw);
      }
      rows.appendChild(cur);
    }
    if (viewerCan(viewer, 'accounts')) {
      // Rotation picks the LOWEST number first (prioritize puts an account
      // below every other), so the stepper names the number, not a rank.
      var prio = a.priority || 0;
      var pr = settingsRow('Priority', 'Lower numbers are picked first');
      var stepper = el('div', 'stepper');
      var down = el('button', '', '−');
      down.type = 'button';
      down.setAttribute('aria-label', 'Lower the number: picked sooner');
      down.addEventListener('click', function () { doControlAccount(a.name, { priority: prio - 1 }, down); });
      var up = el('button', '', '+');
      up.type = 'button';
      up.setAttribute('aria-label', 'Raise the number: picked later');
      up.addEventListener('click', function () { doControlAccount(a.name, { priority: prio + 1 }, up); });
      stepper.appendChild(down);
      stepper.appendChild(el('div', 'val', String(prio)));
      stepper.appendChild(up);
      pr.appendChild(stepper);
      rows.appendChild(pr);

      var en = settingsRow('Enabled', 'Disabled accounts are never routed to');
      var toggle = el('button', 'toggle' + (a.disabled ? '' : ' on'));
      toggle.type = 'button';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', a.disabled ? 'false' : 'true');
      toggle.setAttribute('aria-label', 'Enabled');
      toggle.title = (a.disabled ? 'Enable ' : 'Disable ') + a.name;
      toggle.appendChild(el('span'));
      toggle.addEventListener('click', function () { doControlAccount(a.name, { disabled: !a.disabled }, toggle); });
      en.appendChild(toggle);
      rows.appendChild(en);
    }
    d.appendChild(rows);
    var n = el('div', 'set-note');
    n.id = 'setNote';
    if (settingsNote) {
      n.className = 'set-note ' + settingsNote.kind;
      n.textContent = settingsNote.text;
      n.style.display = 'block';
    }
    d.appendChild(n);
  }

  // ── Users ────────────────────────────────────────────────────────────────

  // The configured users, for an operator: the server sends the list to no one
  // else, and the card checks the viewer as well rather than rely on that.
  // Your own row offers neither Remove nor a role below admin, which the
  // server would refuse: that key is the one this page is signed in with.
  function renderUserAdmin(s) {
    var viewer = s.viewer || null;
    var users = viewerCan(viewer, 'users') && Array.isArray(s.users) ? s.users : null;
    byId('userAdminSec').style.display = users ? '' : 'none';
    if (!users) {
      if (userDialogOpen) closeAddUser();
      userRowsFrom = '';
      userShown = null;
      return;
    }
    if (userShown && !users.some(function (u) { return u.name === userShown.name; })) userShown = null;
    var me = viewer && viewer.client;
    var from = JSON.stringify([users, me, userConfirm, userShown ? userShown.name : '']);
    if (from === userRowsFrom) return;
    userRowsFrom = from;
    byId('userCount').textContent = users.length === 1 ? '1 user' : users.length + ' users';
    var box = byId('userRows');
    box.textContent = '';
    if (!users.length) {
      box.appendChild(el('div', 'hint', 'No users yet: everyone shares the proxy key, and usage is not booked by name.'));
      return;
    }
    users.forEach(function (u) {
      var row = el('div', 'us-row');
      var nm = el('span', 'cl-name', u.name);
      nm.title = u.name;
      if (u.name === me) nm.appendChild(el('span', 'you', 'you'));
      row.appendChild(nm);
      var seg = el('span', 'seg on-bg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Role of ' + u.name);
      USER_ROLE_OPTIONS.forEach(function (o) {
        if (u.name === me && o[0] !== 'admin') return;
        var on = u.role === o[0];
        var b = el('button', on ? 'sel' : '', o[1]);
        b.type = 'button';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.title = on ? u.name + ' is ' + o[2] : 'Make ' + u.name + ' ' + o[2];
        if (!on) b.addEventListener('click', function () { doUserChange('role', { name: u.name, role: o[0] }, b); });
        seg.appendChild(b);
      });
      row.appendChild(seg);
      var acts = el('span', 'us-acts');
      var shown = userShown && userShown.name === u.name ? userShown : null;
      var sk = el('button', 'pill-btn xs quiet', shown ? 'Hide key' : 'Show key');
      sk.type = 'button';
      sk.title = (shown ? 'Hide key of ' : 'Show key of ') + u.name;
      sk.addEventListener('click', function () {
        if (!shown) { doShowKey(u.name, sk); return; }
        userShown = null;
        if (lastStatus) renderUserAdmin(lastStatus);
      });
      acts.appendChild(sk);
      if (u.name !== me) {
        var confirming = userConfirm === u.name;
        var rm = el('button', 'pill-btn xs ' + (confirming ? 'violet' : 'quiet'), confirming ? 'Confirm' : 'Remove');
        rm.type = 'button';
        rm.title = 'Remove ' + u.name;
        rm.addEventListener('click', function () {
          // The first press only asks: a removed key stops working at once,
          // and whoever holds it has to be given a new one.
          if (userConfirm !== u.name) { userConfirm = u.name; if (lastStatus) renderUserAdmin(lastStatus); return; }
          userConfirm = null;
          doUserChange('remove', { name: u.name }, rm);
        });
        acts.appendChild(rm);
      }
      row.appendChild(acts);
      if (shown) {
        // A name listed twice has a key per entry, and each one works.
        var keys = el('div', 'us-keys');
        shown.keys.forEach(function (k) {
          var line = el('div', 'code-row');
          var input = el('input');
          input.type = 'text';
          input.readOnly = true;
          input.value = k;
          input.setAttribute('aria-label', 'Key of ' + u.name);
          line.appendChild(input);
          var cp = el('button', 'pill-btn md quiet', 'Copy');
          cp.type = 'button';
          cp.title = 'Copy key of ' + u.name;
          cp.addEventListener('click', function () { copyKey(cp, k, function (t) { note('error', t); }); });
          line.appendChild(cp);
          keys.appendChild(line);
        });
        row.appendChild(keys);
      }
      box.appendChild(row);
    });
  }

  function buildUserRoleButtons() {
    var seg = byId('userRoleSeg');
    USER_ROLE_OPTIONS.forEach(function (o) {
      var b = el('button', '', o[1]);
      b.type = 'button';
      b.title = 'New user role: ' + o[1];
      b.addEventListener('click', function () {
        newUserRole = o[0];
        markSelected(newUserRoleButtons, newUserRole);
      });
      seg.appendChild(b);
      newUserRoleButtons.push({ key: o[0], btn: b });
    });
  }

  function userNote(kind, text) {
    var n = byId('userNote');
    n.className = kind || '';
    n.textContent = text;
  }

  function openAddUser() {
    newUserRole = 'tenant';
    markSelected(newUserRoleButtons, newUserRole);
    byId('userNameIn').value = '';
    byId('userKey').value = '';
    byId('userForm').style.display = '';
    byId('userKeyWrap').style.display = 'none';
    userNote('', '');
    userDialogOpen = true;
    byId('userWrap').style.display = '';
    byId('userNameIn').focus();
  }

  // The key leaves the page with the dialog: it was shown once, and a later
  // look at the DOM should not find it.
  function closeAddUser() {
    userDialogOpen = false;
    byId('userWrap').style.display = 'none';
    byId('userKey').value = '';
    byId('userKeyFor').textContent = '';
    byId('userNameIn').value = '';
  }

  // Whether the dialog is showing a key, which a stray Escape or a click on
  // the backdrop must not throw away: only Done or the close button do then.
  function showingUserKey() {
    return userDialogOpen && byId('userKeyWrap').style.display !== 'none';
  }

  function doAddUser(btn) {
    var name = byId('userNameIn').value.trim();
    if (!name) { userNote('error', 'give the user a name'); return; }
    btn.disabled = true;
    userNote('', 'adding…');
    var r = userRequest('add', { name: name, role: newUserRole }, localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = userOutcome('add', json);
        if (out.kind !== 'ok') { userNote('error', out.text); return; }
        byId('userForm').style.display = 'none';
        byId('userKeyFor').textContent = json.name;
        byId('userKey').value = json.key;
        byId('userKeyWrap').style.display = '';
        userNote('ok', 'Copy it now: it won’t be shown again. If it is lost, remove the user and add them again.');
        note('ok', out.text);
        poll();
      })
      .catch(function (e) { userNote('error', userOutcome('add', { ok: false, error: e.message }).text); })
      .finally(function () { btn.disabled = false; });
  }

  function doUserChange(op, spec, btn) {
    btn.disabled = true;
    var r = userRequest(op, spec, localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = userOutcome(op, json);
        note(out.kind, out.text);
        if (out.kind === 'ok') poll();
        else btn.disabled = false;
      })
      .catch(function (e) {
        note('error', userOutcome(op, { ok: false, error: e.message }).text);
        btn.disabled = false;
      });
  }

  // Show key: the keys go into userShown and the row, never into a note.
  function doShowKey(name, btn) {
    btn.disabled = true;
    var r = userRequest('key', { name: name }, localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = userOutcome('key', json);
        if (out.kind !== 'ok') { note('error', out.text); btn.disabled = false; return; }
        userShown = { name: json.name, keys: Array.isArray(json.keys) ? json.keys : [] };
        if (lastStatus) renderUserAdmin(lastStatus);
      })
      .catch(function (e) {
        note('error', userOutcome('key', { ok: false, error: e.message }).text);
        btn.disabled = false;
      });
  }

  // Copy a key, or say how to copy it by hand where the clipboard is refused.
  function copyKey(btn, value, failed) {
    var refused = function () { failed('could not copy; select the key and copy it by hand'); };
    try {
      navigator.clipboard.writeText(value).then(function () {
        btn.textContent = 'Copied ✓';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
      }, refused);
    } catch (e) { refused(); }
  }

  // ── Your key ─────────────────────────────────────────────────────────────

  // The header avatar opens it, for a page signed in with a named client key:
  // the shared key and a key-less loopback page have no key of their own.
  function openKey() {
    var viewer = lastStatus && lastStatus.viewer;
    if (!viewerCan(viewer, 'rotate')) return;
    keyConfirm = false;
    var btn = byId('keyRotate');
    btn.textContent = 'Rotate key';
    btn.className = 'pill-btn md';
    btn.disabled = false;
    byId('keyFor').textContent = viewer.client;
    byId('keyForm').style.display = '';
    byId('keyNewWrap').style.display = 'none';
    byId('keyNew').value = '';
    keyNote('', '');
    keyDialogOpen = true;
    byId('keyWrap').style.display = '';
  }

  // The new key leaves the page with the dialog, as an added user's does. The
  // page itself keeps signing in with it from localStorage.
  function closeKey() {
    keyDialogOpen = false;
    keyConfirm = false;
    byId('keyWrap').style.display = 'none';
    byId('keyNew').value = '';
  }

  function showingNewKey() {
    return keyDialogOpen && byId('keyNewWrap').style.display !== 'none';
  }

  function keyNote(kind, text) {
    var n = byId('keyNote');
    n.className = kind || '';
    n.textContent = text;
  }

  function doRotateKey(btn) {
    // The first press only asks: the old key stops working at once, for this
    // page and for every client still using it.
    if (!keyConfirm) {
      keyConfirm = true;
      btn.textContent = 'Confirm rotate';
      btn.className = 'pill-btn md violet';
      keyNote('', 'The old key stops working the moment you confirm.');
      return;
    }
    keyConfirm = false;
    btn.disabled = true;
    keyNote('', 'rotating…');
    var reset = function () {
      btn.textContent = 'Rotate key';
      btn.className = 'pill-btn md';
      btn.disabled = false;
    };
    var r = rotateKeyRequest(localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = userOutcome('rotate', json);
        if (out.kind !== 'ok' || !json.key) { keyNote('error', out.text); reset(); return; }
        // Stored before anything else: the old key is already refused, and the
        // next poll must not be the one that finds out.
        localStorage.setItem(KEY, json.key);
        byId('keyForm').style.display = 'none';
        byId('keyNew').value = json.key;
        byId('keyNewWrap').style.display = '';
        keyNote('ok', 'Copy it now: it won’t be shown again. If it is lost, an admin can show it from the Users card.');
        note('ok', out.text);
        reset();
        poll();
      })
      .catch(function (e) {
        keyNote('error', userOutcome('rotate', { ok: false, error: e.message }).text);
        reset();
      });
  }

  // ── Overview ─────────────────────────────────────────────────────────────

  // The window and measure buttons, and the overview columns' bars, built
  // once: the windows are fixed by the server that served this page, and the
  // bars are the columns' texture rather than data.
  function buildControls() {
    var views = byId('usageViewWrap');
    USAGE_VIEWS.forEach(function (v) {
      var btn = el('button', '', v.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        usageView = v.key;
        markSelected(usageButtons, usageView);
        movePill();
        if (lastStatus) render(lastStatus);
      });
      views.appendChild(btn);
      usageButtons.push({ key: v.key, btn: btn });
    });
    markSelected(usageButtons, usageView);
    var metrics = byId('clientChartMetric');
    CHART_METRICS.forEach(function (m) {
      var btn = el('button', '', m.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        chartMetric = m.key;
        markSelected(chartButtons, chartMetric);
        if (lastStatus) render(lastStatus);
      });
      metrics.appendChild(btn);
      chartButtons.push({ key: m.key, btn: btn });
    });
    markSelected(chartButtons, chartMetric);
    USAGE_VIEWS.forEach(function (v) {
      var btn = el('button', '', v.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        userView = v.key;
        markSelected(userViewButtons, userView);
        renderUsers();
        renderHeat();
      });
      byId('userViewSeg').appendChild(btn);
      userViewButtons.push({ key: v.key, btn: btn });
    });
    markSelected(userViewButtons, userView);
    CHART_METRICS.forEach(function (m) {
      var btn = el('button', '', m.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        userMetric = m.key;
        markSelected(userMetricButtons, userMetric);
        renderUsers();
        renderHeat();
      });
      byId('userMetricSeg').appendChild(btn);
      userMetricButtons.push({ key: m.key, btn: btn });
    });
    markSelected(userMetricButtons, userMetric);
    // The first column one solid block, the second a run of strokes shading
    // darker, the third fainter strokes: the columns tell clients apart by
    // their pattern as well as their place.
    byId('grp0Bars').appendChild(el('i', 'solid'));
    var i, bar;
    for (i = 0; i < 18; i++) {
      bar = el('i', 'thin');
      bar.style.background = 'oklch(' + (0.62 - i * 0.012).toFixed(3) + ' ' + (0.2 - i * 0.004).toFixed(3) + ' 290)';
      bar.style.animationDelay = (0.12 + i * 0.025).toFixed(3) + 's';
      byId('grp1Bars').appendChild(bar);
    }
    for (i = 0; i < 6; i++) {
      bar = el('i', 'thin dark');
      bar.style.animationDelay = (0.24 + i * 0.025).toFixed(3) + 's';
      byId('grp2Bars').appendChild(bar);
    }
  }

  function markSelected(buttons, key) {
    buttons.forEach(function (b) {
      b.btn.className = b.key === key ? 'sel' : '';
      b.btn.setAttribute('aria-pressed', b.key === key ? 'true' : 'false');
    });
  }

  // The window control's highlight slides to the chosen button. It is placed
  // by measuring that button, which a hidden page cannot do; until it has been
  // measured the button marks itself instead.
  function movePill() {
    var cur = usageButtons.filter(function (b) { return b.key === usageView; })[0];
    if (!cur) return;
    var left = cur.btn.offsetLeft, width = cur.btn.offsetWidth;
    if (typeof left !== 'number' || typeof width !== 'number' || !width) return;
    var pill = byId('viewPill');
    pill.style.left = left + 'px';
    pill.style.width = width + 'px';
    byId('usageViewWrap').className = 'seg lg measured';
  }

  function viewLabel() {
    var view = USAGE_VIEWS.filter(function (v) { return v.key === usageView; })[0];
    return view ? view.label : '';
  }

  // Where the overview's span starts, under its columns.
  function rangeStartText() {
    if (usageView === 'total') return 'All time';
    var n = parseInt(usageView, 10);
    var unit = usageView.slice(-1) === 'd' ? ' day' : ' hour';
    return n + unit + (n === 1 ? '' : 's') + ' ago';
  }

  // The overview's big figure: every client key's traffic on the shown window
  // and measure. A fleet with no client keys has nothing windowed to show, so
  // it gets what the accounts themselves have served since the proxy started,
  // cache included as on their cards, and the label says so.
  function heroFigure(s) {
    var requests = chartMetric === 'requests';
    if (hasClients(s)) {
      var total = 0, inTok = 0, outTok = 0;
      clientRanking(s.clients, usageView, chartMetric).forEach(function (r) {
        total += r.value;
        inTok += r.usage.inputTokens;
        outTok += r.usage.outputTokens;
      });
      return {
        value: total, label: requests ? 'Requests served' : 'Tokens used', input: inTok, output: outTok,
        title: 'Every client key\\'s ' + (requests ? 'requests' : 'input and output tokens, cache reads and writes included') + ', ' + (usageView === 'total' ? 'all time' : viewLabel().toLowerCase())
          + '. Traffic on the shared proxy key is not attributed to anyone.',
      };
    }
    var sum = 0, inAll = 0, outAll = 0;
    (s.accounts || []).forEach(function (a) {
      var u = a.usage || {};
      var sides = accountTokenSplit(u);
      sum += requests ? (u.totalRequests || 0) : accountTokens(u);
      inAll += sides.input;
      outAll += sides.output;
    });
    return {
      value: sum, label: (requests ? 'Requests served' : 'Tokens served') + ' since start', input: inAll, output: outAll,
      title: 'What every account has served since the proxy started' + (requests ? '' : ', cache reads and writes included'),
    };
  }

  function drawHero(v) {
    var str = fmtNum(Math.round(v));
    var cut = str.search(/[.km]/);
    byId('heroMain').textContent = cut < 0 ? str : str.slice(0, cut);
    byId('heroFrac').textContent = cut < 0 ? '' : str.slice(cut);
  }

  // A new figure counts up (or down) from the one on screen rather than
  // jumping, the first from zero.
  function setHero(value) {
    var token = ++heroToken;
    var from = heroShown == null ? 0 : heroShown;
    if (!raf || from === value) { heroShown = value; drawHero(value); return; }
    var t0 = null;
    raf(function step(now) {
      if (token !== heroToken) return;
      if (t0 == null) t0 = now;
      var p = Math.min(1, (now - t0) / 700);
      heroShown = from + (value - from) * (1 - Math.pow(1 - p, 3));
      drawHero(heroShown);
      if (p < 1) raf(step);
      else heroShown = value;
    });
  }

  function renderHero(s) {
    var fig = heroFigure(s);
    var label = byId('heroLabel');
    label.textContent = fig.label;
    label.title = fig.title;
    setHero(fig.value);
    // The big figure is both sides; under it, the two apart.
    var split = byId('heroSplit');
    split.textContent = chartMetric === 'requests' ? '' : fmtNum(fig.input) + ' in · ' + fmtNum(fig.output) + ' out';
    split.style.display = chartMetric === 'requests' ? 'none' : '';
    // Where a new request goes: one cursor per provider, since a mixed
    // Claude/Codex fleet has two current accounts and naming one of them "the"
    // current account would be wrong.
    var box = byId('statActive');
    box.textContent = '';
    box.appendChild(el('span', '', 'Routing to'));
    var ca = s.currentAccounts || null;
    var providers = providersOf(ca);
    var add = function (name, provider, first) {
      if (!first) box.appendChild(el('span', 'prov', '·'));
      var n = el('b', '', name || 'nothing — no account can serve');
      if (name) n.title = name;
      box.appendChild(n);
      if (provider) box.appendChild(el('span', 'prov', providerLabel(provider)));
    };
    if (providers.length > 1) providers.forEach(function (p, i) { add(ca[p], p, i === 0); });
    else add(providers.length ? ca[providers[0]] : s.currentAccount, null, true);
  }

  // The newest hour on top of the figure, once the series has landed.
  function renderDelta() {
    var d = byId('heroDelta');
    var lines = hasClients(lastStatus) && lastSeries ? seriesLines(lastSeries, usageView, chartMetric, null) : null;
    if (!lines || !lines.last) { d.style.display = 'none'; return; }
    d.textContent = '+' + fmtNum(lines.last) + ' last hour';
    d.title = metricText(lines.last) + ' in the hour to ' + fmtHM(lines.points[lines.points.length - 1].end);
    d.style.display = '';
  }

  // The overview's columns: the two busiest clients and everyone else, each
  // figure standing as high as its share against the tallest, read against a
  // dashed line at the average client.
  function renderGroups(s) {
    var wrap = byId('clientChartWrap');
    if (!hasClients(s)) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    byId('rangeStart').textContent = rangeStartText();
    var ranking = clientRanking(s.clients, usageView, chartMetric);
    var g = clientGroups(ranking);
    var usageOf = {};
    ranking.forEach(function (r) { usageOf[r.name] = r.usage; });
    var sidesText = function (members) {
      if (chartMetric === 'requests') return '';
      var a = 0, b = 0;
      members.forEach(function (name) { a += usageOf[name].inputTokens; b += usageOf[name].outputTokens; });
      return ' (' + fmtNum(a) + ' in · ' + fmtNum(b) + ' out)';
    };
    var empty = byId('groupsEmpty');
    if (g.groups.length) empty.style.display = 'none';
    else {
      empty.textContent = usageView === 'total' ? 'No client-key traffic yet' : 'No client-key traffic in the ' + viewLabel().toLowerCase();
      empty.style.display = 'flex';
    }
    var lift = function (x) { return Math.round(6 + (1 - x) * 90); };
    for (var i = 0; i < 3; i++) {
      var slot = byId('grp' + i), grp = g.groups[i];
      if (!grp) { slot.style.display = 'none'; continue; }
      slot.style.display = '';
      slot.style.flexGrow = String(grp.grow);
      slot.style.paddingTop = lift(grp.lift) + 'px';
      slot.title = (grp.others ? grp.members.join(', ') : grp.name) + ' · ' + metricText(grp.value) + sidesText(grp.members) + ' · ' + fmtShare(grp.share);
      byId('grp' + i + 'Val').textContent = metricText(grp.value);
      byId('grp' + i + 'Pct').textContent = fmtShare(grp.share);
      byId('grp' + i + 'Name').textContent = grp.others ? grp.members.length + ' others' : grp.name;
    }
    var line = byId('avgLine'), pill = byId('avgPill');
    if (g.clients > 1) {
      // Through the middle of a figure standing at the average client.
      var y = lift(g.averageLift) + 10;
      line.style.top = y + 'px';
      pill.style.top = y + 'px';
      pill.title = 'Average per client: ' + metricText(g.average);
      line.style.display = '';
      pill.style.display = '';
    } else {
      line.style.display = 'none';
      pill.style.display = 'none';
    }
  }

  // ── Charts ───────────────────────────────────────────────────────────────

  // Why a chart has nothing to draw: its history has not landed, could not be
  // fetched, or holds nothing for the span.
  function historyEmptyText(hours) {
    if (!lastSeries) return seriesError ? 'Usage history unavailable: ' + seriesError : 'Loading usage history…';
    return 'No client-key traffic in the last ' + hours;
  }

  // Usage over time, drawn from the last series fetched: every client key's
  // traffic, an hour a point, its busiest hour marked. Tokens are drawn as two
  // panels, input over output, each on its own scale: cache reads put input a
  // hundred times above output, and on one scale the output line would lie flat
  // on the axis. Requests are one panel. Total has no series of its own — the
  // tracker keeps a day of history, not a lifetime — so it shows the day, and
  // the caption says which span is on screen.
  function renderSeries() {
    var wrap = byId('seriesWrap');
    if (!hasClients(lastStatus)) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var split = chartMetric !== 'requests';
    var L = seriesLines(lastSeries, usageView, chartMetric, null);
    var hours = spanHours(L.spanMs, usageView);
    byId('seriesCaption').textContent = (split ? 'Tokens' : 'Requests') + ' / hour · last ' + hours;
    byId('seriesPlot').className = 'plot' + (split ? ' split' : '');
    byId('seriesInHead').style.display = split ? '' : 'none';
    byId('seriesOutHead').style.display = split ? '' : 'none';
    var drawn = !!lastSeries && L.total > 0;
    byId('seriesOutPlot').style.display = split && drawn ? '' : 'none';
    var empty = byId('seriesEmpty');
    empty.style.display = drawn ? 'none' : 'flex';
    if (!drawn) empty.textContent = historyEmptyText(hours);
    var IN = split ? seriesLines(lastSeries, usageView, 'input', null) : L;
    var OUT = split ? seriesLines(lastSeries, usageView, 'output', null) : null;
    var colTitle = function (i) {
      var p = L.points[i];
      var head = fmtHM(p.start) + '–' + fmtHM(p.end) + ' · ';
      return split ? head + fmtNum(IN.points[i].total) + ' in · ' + fmtNum(OUT.points[i].total) + ' out' : head + metricText(p.total);
    };
    drawSeriesPanel({ main: 'seriesMain', area: 'seriesArea', peak: 'peakLine', tags: 'peakTags', tag: 'peakMain', hover: 'seriesHover', max: split ? 'seriesInMax' : null },
      drawn ? IN : null, colTitle);
    drawSeriesPanel({ main: 'seriesOutMain', area: 'seriesOutArea', peak: 'peakOutLine', tags: 'peakOutTags', tag: 'peakOut', hover: 'seriesOutHover', max: 'seriesOutMax' },
      drawn && split ? OUT : null, colTitle);
    var ticks = byId('seriesTicks');
    ticks.textContent = '';
    seriesTicks(L.spanMs || (usageView === '5h' ? 5 : 24) * 3600000, seriesEnd()).forEach(function (t) { ticks.appendChild(el('span', '', fmtHM(t))); });
  }

  // One panel of Usage over time: the line and its area, the busiest hour
  // marked, and a tooltip column per hour. No lines clears it. A side that
  // spent nothing all day draws flat on its axis rather than dividing by a
  // zero peak.
  function drawSeriesPanel(ids, P, colTitle) {
    var hover = byId(ids.hover);
    hover.textContent = '';
    var peak = byId(ids.peak), tags = byId(ids.tags);
    if (ids.max) byId(ids.max).textContent = '';
    if (!P) {
      byId(ids.main).setAttribute('d', '');
      byId(ids.area).setAttribute('d', '');
      peak.style.display = 'none';
      tags.style.display = 'none';
      return;
    }
    var n = P.points.length;
    var top = (P.peak || 1) * 1.15;
    var X = function (i) { return n > 1 ? i / (n - 1) * 400 : 200; };
    var Y = function (v) { return 165 - v / top * 150; };
    var d = smoothPath(P.points.map(function (p, i) { return [X(i), Y(p.total)]; }), 165);
    byId(ids.main).setAttribute('d', d);
    byId(ids.area).setAttribute('d', d + ' L400,170 L0,170 Z');
    if (ids.max && P.peak) byId(ids.max).textContent = 'scale to ' + scaleText(top);
    if (P.peakAt < 0) {
      peak.style.display = 'none';
      tags.style.display = 'none';
    } else {
      var left = X(P.peakAt) / 4;
      peak.style.left = left + '%';
      peak.style.display = '';
      tags.style.left = left + '%';
      // Past the middle the tag sits left of the line, so it stays on the chart.
      tags.className = 'peak-tags' + (left > 62 ? ' flip' : '');
      tags.style.display = '';
      byId(ids.tag).textContent = 'Peak ' + metricText(P.points[P.peakAt].total);
    }
    P.points.forEach(function (p, i) {
      var col = el('div');
      col.title = colTitle(i);
      hover.appendChild(col);
    });
  }

  // Usage by user, on the section's own window and measure: every client's
  // share as a bar, and a line per client over the span the history covers.
  // A client keeps one colour in both (userSlots), grey for everyone past the
  // eighth when they share a line.
  function renderUsers() {
    var sec = byId('usersSec');
    var s = lastStatus;
    if (!hasClients(s)) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    var ranking = clientRanking(s.clients, userView, userMetric);
    var names = userLineNames(ranking);
    var slots = userSlots(names);
    var toneOf = function (line) { return line.others || !(line.name in slots) ? 'uo' : 'u' + slots[line.name]; };
    var rows = byId('spendRows');
    rows.textContent = '';
    var split = userMetric !== 'requests';
    ranking.forEach(function (r) {
      var tone = toneOf({ name: r.name, others: false });
      var row = el('div', 'sp-row');
      var sides = fmtNum(r.usage.inputTokens) + ' in · ' + fmtNum(r.usage.outputTokens) + ' out';
      row.title = r.name + ' · ' + metricText(r.value, userMetric) + (split ? ' (' + sides + ')' : '') + ' · ' + fmtShare(r.share);
      var name = el('span', 'sp-name');
      name.appendChild(el('i', 'dot ' + tone));
      name.appendChild(el('span', '', r.name));
      row.appendChild(name);
      // Tokens split the bar: input solid, output beside it in a lighter tint.
      var track = el('div', 'sp-track');
      var inShare = split && r.value ? r.share * r.usage.inputTokens / r.value : r.share;
      var fill = el('i', tone);
      fill.style.width = (inShare * 100).toFixed(1) + '%';
      track.appendChild(fill);
      if (split && r.usage.outputTokens) {
        var outFill = el('i', tone + ' out');
        outFill.style.width = ((r.share - inShare) * 100).toFixed(1) + '%';
        track.appendChild(outFill);
      }
      row.appendChild(track);
      var val = el('span', 'sp-val');
      val.appendChild(el('b', '', metricText(r.value, userMetric)));
      val.appendChild(el('span', '', ' · ' + fmtShare(r.share)));
      if (split) val.appendChild(el('div', 'sp-sub', sides));
      row.appendChild(val);
      rows.appendChild(row);
    });

    // Tokens are two panels, input over output, as Usage over time draws
    // them: each client a line in both, the output one dashed.
    var L = seriesLines(lastSeries, userView, userMetric, names);
    var lines = L.lines;
    var hours = spanHours(L.spanMs, userView);
    byId('userCaption').textContent = (split ? 'Tokens' : 'Requests') + ' / hour · last ' + hours;
    var label = function (line) { return line.others ? line.members.length + ' others' : line.name; };
    var legend = byId('userLegend');
    legend.textContent = '';
    lines.forEach(function (line) {
      var item = el('span');
      item.appendChild(el('i', 'sw ' + toneOf(line)));
      item.appendChild(el('span', '', label(line)));
      legend.appendChild(item);
    });
    var drawn = !!lastSeries && L.linePeak > 0;
    var empty = byId('userEmpty');
    empty.style.display = drawn ? 'none' : 'flex';
    if (!drawn) empty.textContent = historyEmptyText(hours);
    byId('userPlot').className = 'plot uplot' + (split ? ' split' : '');
    byId('userInHead').style.display = split ? '' : 'none';
    byId('userOutHead').style.display = split ? '' : 'none';
    byId('userOutPlot').style.display = split && drawn ? '' : 'none';
    // A panel draws the legend's lines, whatever its own side spent: the fold
    // into "others" is decided on both sides together, and a side where the
    // folded clients spent nothing still draws their line, flat.
    var align = function (P) {
      var byName = {};
      P.lines.forEach(function (line) { byName[line.name] = line; });
      P.lines = lines.map(function (line) {
        return byName[line.name] || { name: line.name, members: line.members, others: line.others, values: P.points.map(function () { return 0; }) };
      });
      return P;
    };
    var IN = split ? align(seriesLines(lastSeries, userView, 'input', names)) : L;
    var OUT = split ? align(seriesLines(lastSeries, userView, 'output', names)) : null;
    var colTitle = function (i) {
      var p = L.points[i];
      return fmtHM(p.start) + '–' + fmtHM(p.end) + ' · ' + lines.map(function (line, k) {
        return label(line) + ' ' + (split
          ? fmtNum(IN.lines[k].values[i]) + ' in / ' + fmtNum(OUT.lines[k].values[i]) + ' out'
          : metricText(line.values[i], userMetric));
      }).join(' · ');
    };
    drawUserPanel({ svg: 'userLines', max: 'userMax', hover: 'userHover' }, drawn ? IN : null, toneOf, colTitle);
    drawUserPanel({ svg: 'userOutLines', max: 'userOutMax', hover: 'userOutHover' }, drawn && split ? OUT : null, toneOf, colTitle);
    var ticks = byId('userTicks');
    ticks.textContent = '';
    seriesTicks(L.spanMs || (userView === '5h' ? 5 : 24) * 3600000, seriesEnd()).forEach(function (t) { ticks.appendChild(el('span', '', fmtHM(t))); });
  }

  // One panel of Usage by user: a line per client on the panel's own scale,
  // drawn last to first so the busiest client's line sits on top.
  function drawUserPanel(ids, P, toneOf, colTitle) {
    var svg = byId(ids.svg);
    svg.textContent = '';
    var hover = byId(ids.hover);
    hover.textContent = '';
    if (!P) { byId(ids.max).textContent = ''; return; }
    var n = P.points.length;
    var top = (P.linePeak || 1) * 1.15;
    byId(ids.max).textContent = P.linePeak ? scaleText(top, userMetric) : '';
    var X = function (i) { return n > 1 ? i / (n - 1) * 400 : 200; };
    P.lines.slice().reverse().forEach(function (line) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.setAttribute('class', toneOf(line));
      path.setAttribute('d', smoothPath(line.values.map(function (v, i) { return [X(i), 170 - v / top * 170]; }), 170));
      svg.appendChild(path);
    });
    P.points.forEach(function (p, i) {
      var col = el('div');
      col.title = colTitle(i);
      hover.appendChild(col);
    });
  }

  // Traffic by time, beside Spend by user and on that section's window and
  // measure: a row per active client, a column per stretch of the span, each
  // cell shaded by its share of the busiest.
  function renderHeat() {
    var wrap = byId('heatWrap');
    if (!hasClients(lastStatus)) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    byId('heatTitle').textContent = (userMetric === 'requests' ? 'Requests' : 'Tokens') + ' by time';
    var grid = byId('heat');
    grid.textContent = '';
    var G = heatGrid(lastSeries, userView, userMetric);
    var empty = byId('heatEmpty');
    if (!lastSeries || !G.rows.length) {
      // Short on purpose: the chart below it carries the whole reason.
      empty.textContent = !lastSeries ? (seriesError ? 'History unavailable' : 'Loading…') : 'Nothing in the last ' + (userView === '5h' ? 5 : 24) + 'h';
      empty.style.display = 'flex';
      grid.style.display = 'none';
      byId('heatLegend').style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    grid.style.display = 'grid';
    byId('heatLegend').style.display = '';
    grid.style.gridTemplateColumns = '64px repeat(' + G.columns.length + ', minmax(0, 1fr))';
    grid.appendChild(el('span'));
    G.columns.forEach(function (c) {
      var h = el('span', 'hd', fmtHour(c.start));
      h.title = fmtHM(c.start) + '–' + fmtHM(c.end);
      grid.appendChild(h);
    });
    G.rows.forEach(function (row) {
      var name = row.others ? row.members.length + ' others' : row.name;
      var label = el('span', 'rl', name);
      label.title = row.members.join(', ');
      grid.appendChild(label);
      row.cells.forEach(function (cell, c) {
        var d = el('div', 'cell' + (cell.level ? ' l' + cell.level : ''));
        d.title = name + ' · ' + fmtHM(G.columns[c].start) + '–' + fmtHM(G.columns[c].end) + ' · ' + metricText(cell.value, userMetric)
          + (userMetric === 'requests' ? '' : ' (' + fmtNum(cell.input) + ' in · ' + fmtNum(cell.output) + ' out)');
        grid.appendChild(d);
      });
    });
  }

  function renderHistory() {
    renderSeries();
    renderHeat();
    renderDelta();
    renderUsers();
  }

  function pollSeries() {
    if (seriesInFlight) return;
    seriesInFlight = true;
    fetch('/teamclaude/usage/series', { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (json) { lastSeries = json; seriesError = null; })
      .catch(function (e) { seriesError = e.message; })
      .then(function () { seriesInFlight = false; renderHistory(); });
  }

  // ── Tables ───────────────────────────────────────────────────────────────

  // Last used is a lifetime figure in a table whose heading may name a window.
  // Under Total that needs no saying; under a window it does, or it reads as
  // the one thing this control must never do — a number under the wrong label.
  function lastUsedLabel() {
    return usageView === 'total' ? 'Last used' : 'Last used (all time)';
  }

  // The window a usage table is showing, in its own heading: the control sits
  // at the top of the page, and the tables below can be scrolled clear of it.
  function usageHeading(base) {
    if (usageView === 'total') return base;
    var label = viewLabel();
    return label ? base + ' · ' + label.toLowerCase() : base;
  }

  function renderClients(clients) {
    var wrap = byId('clientsWrap');
    var names = Object.keys(clients || {});
    if (!names.length) { wrap.style.display = 'none'; return false; }
    wrap.style.display = '';
    byId('clientsHeading').textContent = usageHeading('Clients');
    // Sorted on the window being shown, not on the lifetime total: a list
    // ordered by all-time spend while displaying the last five hours would put
    // the quiet clients on top of the busy one.
    names.sort(function (a, b) {
      var ua = usageFor(clients[a], usageView), ub = usageFor(clients[b], usageView);
      return (ub.inputTokens + ub.outputTokens) - (ua.inputTokens + ua.outputTokens);
    });
    var box = byId('clients');
    box.textContent = '';
    names.forEach(function (n) {
      var c = clients[n];
      var u = usageFor(c, usageView);
      var row = el('div', 'cl-row');
      row.title = n + ' · ' + fmtNum(u.requests) + ' requests'
        + (u.connections ? ', ' + fmtNum(u.connections) + ' WebSockets' : '')
        + ' · ' + fmtNum(u.inputTokens) + ' tokens in, ' + fmtNum(u.outputTokens) + ' out';
      row.appendChild(el('span', 'cl-name', n));
      // Last used stays the lifetime figure under every window: it answers
      // when this client was last seen at all, which a window cannot.
      var last = el('span', 'last');
      last.title = lastUsedLabel();
      last.appendChild(el('i', 'dot ' + recencyDot(c.lastUsed)));
      last.appendChild(el('span', '', c.lastUsed ? fmtAgo(c.lastUsed) : 'never'));
      row.appendChild(last);
      var val = el('span', 'cl-val');
      val.appendChild(el('b', '', fmtNum(u.requests)));
      val.appendChild(el('span', '', ' · ' + fmtNum(u.inputTokens) + ' / ' + fmtNum(u.outputTokens)));
      row.appendChild(val);
      box.appendChild(row);
    });
    return true;
  }

  // Header cells that re-sort in place. The sort is state, not a re-fetch, so
  // it survives the 5s poll: re-rendering re-reads sortState below.
  function addSortableHeader(tr, table, label, key, numeric) {
    var th = el('th', (numeric ? 'num ' : '') + 'sortable', label + (sortState[table].key === key ? (sortState[table].dir === 'asc' ? ' ▲' : ' ▼') : ''));
    th.addEventListener('click', function () {
      var st = sortState[table];
      if (st.key === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      else { st.key = key; st.dir = numeric ? 'desc' : 'asc'; }
      if (lastStatus) render(lastStatus);
    });
    tr.appendChild(th);
  }

  // Session and conversation are two columns rather than one composite: sorting
  // by Session brings a fan-out's rows together (the sort is stable, so they
  // stay in recency order inside it) and Conv is the only column that differs
  // between them. Narrow on purpose — it is a digest, not a name.
  var SESSION_COLUMNS = [
    { key: 'session', label: 'Session' },
    { key: 'conversation', label: 'Conv' },
    { key: 'client', label: 'Client' },
    { key: 'project', label: 'Project' },
    { key: 'accounts', label: 'Accounts' },
    { key: 'requests', label: 'Req', num: true },
    { key: 'cacheRead', label: 'Cache read', num: true },
    { key: 'cacheCreation', label: 'Cache write', num: true },
    { key: 'input', label: 'Input', num: true },
    { key: 'output', label: 'Output', num: true },
    { key: 'context', label: 'Context', num: true },
    { key: 'lastSeen', label: 'Last seen', num: true },
  ];

  function renderSessions(sessions) {
    var wrap = byId('sessionsWrap');
    // Absent unless proxy.sessionDetail is on — the aggregate counts in the
    // status card stay either way.
    if (!sessions || !sessions.items) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    var all = sessionRows(sessions);
    var projectSel = byId('fProject');
    var clientSel = byId('fClient');
    fillFilter(projectSel, uniqSorted(all.map(function (r) { return r.project; })), sessionFilters.project);
    fillFilter(clientSel, uniqSorted(all.map(function (r) { return r.client; })), sessionFilters.client);
    sessionFilters.project = projectSel.value;
    sessionFilters.client = clientSel.value;

    var rows = sortRows(filterSessionRows(all, sessionFilters), sortState.sessions.key, sortState.sessions.dir);
    // Conversations, not sessions: one client session contributes a row per
    // agent it has in flight, and counting rows as sessions would report a
    // fleet carrying several times the clients it has.
    byId('sessionCount').textContent = rows.length + ' of ' + all.length + ' conversations';

    var table = byId('sessions');
    table.textContent = '';
    var hr = el('tr');
    SESSION_COLUMNS.forEach(function (c) { addSortableHeader(hr, 'sessions', c.label, c.key, !!c.num); });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', r.active ? '' : 'dim', r.session));
      tr.appendChild(el('td', r.active ? 'mono' : 'mono dim', r.conversation || '—'));
      tr.appendChild(el('td', '', r.client || '—'));
      tr.appendChild(el('td', '', r.project || '—'));
      tr.appendChild(el('td', 'soft', r.accounts || '—'));
      ['requests', 'cacheRead', 'cacheCreation', 'input', 'output', 'context'].forEach(function (k) {
        tr.appendChild(el('td', 'num', fmtNum(r[k])));
      });
      tr.appendChild(el('td', 'num soft', r.lastSeen ? fmtAgo(r.lastSeen) : '—'));
      table.appendChild(tr);
    });
  }

  function fillFilter(select, values, value) {
    select.textContent = '';
    var all = el('option', '', 'All');
    all.value = '';
    select.appendChild(all);
    values.forEach(function (v) {
      var option = el('option', '', v);
      option.value = v;
      select.appendChild(option);
    });
    select.value = values.indexOf(value) === -1 ? '' : value;
  }

  // One table per configured usage dimension (proxy.usageDimensions).
  function renderDimensions(dimensions) {
    var wrap = byId('dimensionsWrap');
    wrap.textContent = '';
    var any = false;
    Object.keys(dimensions || {}).forEach(function (name) {
      var entries = dimensions[name] || {};
      var rows = Object.keys(entries).map(function (key) {
        var e = entries[key] || {};
        var u = usageFor(e, usageView);
        return {
          name: key,
          requests: u.requests,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          lastUsed: e.lastUsed ? Date.parse(e.lastUsed) : 0,
        };
      });
      if (!rows.length) return;
      any = true;
      sortState[name] = sortState[name] || { key: 'inputTokens', dir: 'desc' };
      rows = sortRows(rows, sortState[name].key, sortState[name].dir);
      var title = name.charAt(0).toUpperCase() + name.slice(1);

      var sec = el('section', 'card flush');
      var head = el('div', 'card-head');
      head.appendChild(el('h2', 'card-title', usageHeading(title)));
      sec.appendChild(head);
      var box = el('div', 'tbl-wrap');
      var table = el('table');
      var hr = el('tr');
      [{ key: 'name', label: title },
        { key: 'requests', label: 'Req', num: true },
        { key: 'inputTokens', label: 'Input tok', num: true },
        { key: 'outputTokens', label: 'Output tok', num: true },
        { key: 'lastUsed', label: lastUsedLabel(), num: true }].forEach(function (c) {
        addSortableHeader(hr, name, c.label, c.key, !!c.num);
      });
      table.appendChild(hr);
      rows.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', '', r.name));
        tr.appendChild(el('td', 'num', fmtNum(r.requests)));
        tr.appendChild(el('td', 'num', fmtNum(r.inputTokens)));
        tr.appendChild(el('td', 'num', fmtNum(r.outputTokens)));
        tr.appendChild(el('td', 'num soft', r.lastUsed ? fmtAgo(r.lastUsed) : '—'));
        table.appendChild(tr);
      });
      box.appendChild(table);
      sec.appendChild(box);
      wrap.appendChild(sec);
    });
    wrap.style.display = any ? '' : 'none';
    return any;
  }

  // A segment per account, the first on of them lit: how many of the fleet
  // can do something, drawn the same in Routing and Proxy status.
  function segBar(on, total) {
    var segs = el('div', 'segs' + (total > 12 ? ' dense' : ''));
    segs.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < total; i++) segs.appendChild(el('i', i < on ? 'on' : ''));
    return segs;
  }

  // Where each metered family goes right now, and how many accounts could
  // take it. The last rows are the per-provider defaults: everything without a
  // route of its own lands on the current account. The accounts that cannot
  // serve a family are named under the table, which is why it is elsewhere.
  function renderRoutes(s) {
    var wrap = byId('routesWrap');
    var rows = routeRows(s);
    if (!rows.length) { wrap.style.display = 'none'; return false; }
    wrap.style.display = '';
    var box = byId('routes');
    box.textContent = '';
    var foot = byId('routesFoot');
    foot.textContent = '';
    var notes = 0;
    rows.forEach(function (r) {
      var row = el('div', 'rt-row');
      var fam = el('div', 'rt-fam');
      fam.appendChild(el('b', '', r.label));
      var glob = r.kind === 'default' ? '*' : r.match;
      var sub = [glob, r.provider && r.provider !== 'anthropic' ? providerLabel(r.provider) : ''].filter(Boolean).join(' · ');
      if (sub) fam.appendChild(el('span', 'rt-glob mono', sub));
      row.appendChild(fam);

      var to = el('div', 'rt-to');
      var pill = el('span', 'target' + (r.blocked ? ' bad' : ''));
      pill.appendChild(el('i', 'dot ' + (r.blocked ? 'coral' : r.target ? 'violet' : 'gray')));
      pill.appendChild(el('span', 't', r.blocked ? 'blocked' : (r.target || 'nothing can serve it')));
      if (r.target) pill.title = r.target;
      to.appendChild(pill);
      if (r.pinned) to.appendChild(el('span', 'rt-note pin', 'pinned to ' + r.pinned + (r.pinMismatch ? ' (not eligible)' : '')));
      if (r.kind === 'default' && r.target !== r.current) {
        to.appendChild(el('span', 'rt-note warn', r.currentUnavailable
          ? 'current account ' + r.current + ' is blocked: ' + (UNAVAILABLE_TEXT[r.currentUnavailable] || r.currentUnavailable)
          : 'outranks the current account ' + r.current));
      }
      row.appendChild(to);

      var can = el('div', 'rt-can');
      var total = r.eligible.length + r.ineligible.length;
      if (r.kind === 'default') can.appendChild(el('span', 'rt-none', 'No route of its own'));
      else if (r.blocked || !total) can.appendChild(el('span', 'rt-none', '—'));
      else {
        can.appendChild(segBar(r.eligible.length, total));
        can.appendChild(el('span', 'rt-count', r.eligible.length + ' of ' + total + ' can serve'));
        if (r.ineligible.length) {
          var un = el('div', '', 'Unavailable for ' + r.label + ': ' + r.ineligible.map(shortName).join(', '));
          un.title = r.ineligible.join(', ');
          foot.appendChild(un);
          notes++;
        }
      }
      row.appendChild(can);
      box.appendChild(row);
    });
    foot.style.display = notes ? 'flex' : 'none';
    return true;
  }

  // Top of the page and only when something is wrong: a banner that is always
  // on is a banner nobody reads.
  function renderProblems(s) {
    var wrap = byId('problems');
    var list = problems(s);
    wrap.textContent = '';
    if (!list.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    list.forEach(function (p) { wrap.appendChild(el('div', 'alert ' + p.severity, p.text)); });
  }

  // The message strip under the header takes no room while it has nothing to
  // say: the page's gaps would otherwise open around an empty box.
  function syncMsgs() {
    var any = ['problems', 'err', 'note'].some(function (id) { return byId(id).style.display === 'flex'; });
    byId('msgs').style.display = any ? 'flex' : 'none';
  }

  // ── Header and status card ───────────────────────────────────────────────

  function renderHeader(s) {
    var viewer = s.viewer || null;
    // Who this page is signed in as, and as what: the controls below appear or
    // not by that, and a missing button should not be a puzzle.
    var h = byId('welcome');
    h.textContent = '';
    h.appendChild(el('span', '', 'Welcome back'));
    if (viewer && viewer.client) {
      h.appendChild(el('span', '', ', '));
      h.appendChild(el('span', 'who', viewer.client));
    }
    var roleText = viewer && viewer.role ? (VIEWER_ROLE_TEXT[viewer.role] || viewer.role) : '';
    if (roleText) h.appendChild(el('span', 'role', roleText));
    var me = byId('me');
    // The avatar opens Your key, for a page signed in with a key of its own.
    var canRotate = viewerCan(viewer, 'rotate');
    me.disabled = !canRotate;
    if (!canRotate && keyDialogOpen && !showingNewKey()) closeKey();
    if (viewer) {
      me.textContent = initialOf(viewer.client || roleText);
      me.title = (viewer.client || 'Operator access') + (roleText ? ' · ' + roleText : '') + (canRotate ? ' · your key' : '');
      me.style.display = '';
    } else {
      me.style.display = 'none';
    }
    byId('reload').style.display = viewerCan(viewer, 'reload') ? '' : 'none';
    // Adding an account writes a credential into the config: an account
    // control, so it is offered to exactly those who may use the others.
    var canAdd = viewerCan(viewer, 'accounts');
    byId('addAcct').style.display = canAdd ? '' : 'none';
    if (!canAdd) byId('loginWrap').style.display = 'none';
    byId('thrWrap').style.display = viewerCan(viewer, 'threshold') ? '' : 'none';
    var probe = s.probe || {};
    var probeBtn = byId('probe');
    probeBtn.style.display = viewerCan(viewer, 'probe') ? '' : 'none';
    byId('probeText').textContent = probe.running ? 'Probe running…' : 'Probe quotas';
    probeBtn.disabled = !!probe.running;
  }

  function renderStatusCard(s) {
    // Conversations, like the Sessions table and its count: one page saying
    // "sessions" here and "conversations" there would read as two different
    // quantities rather than one counted twice.
    var sess = s.sessions || {};
    byId('statConv').textContent = (sess.active || 0) + ' active · ' + (sess.known || 0) + ' known';
    byId('statUp').textContent = s.server && s.server.uptimeSeconds != null ? fmtIn(s.server.uptimeSeconds) : '—';
    // Active is enabled and not blocked: an account a request could go to
    // right now, which "enabled" alone overstates while one is on a hold.
    var accounts = s.accounts || [];
    var blocked = accounts.filter(function (a) { return a.disabled || a.unavailable; });
    var active = accounts.length - blocked.length;
    var box = byId('statServing');
    box.textContent = '';
    if (!accounts.length) { box.textContent = '—'; box.title = ''; return; }
    box.appendChild(segBar(active, accounts.length));
    box.appendChild(el('span', '', active + ' of ' + accounts.length));
    box.title = blocked.length
      ? 'Blocked: ' + blocked.map(function (a) {
        var why = a.unavailable || 'disabled';
        return a.name + ' (' + (UNAVAILABLE_TEXT[why] || why) + ')';
      }).join(', ')
      : 'Every account can take a request';
  }

  function setLive(ok) {
    byId('liveDot').className = 'dot ' + (ok ? 'lime' : 'coral');
    byId('liveText').textContent = ok ? 'Live' : 'Offline';
  }

  function render(s) {
    lastStatus = s;
    // The poll owns the threshold field except while it is being typed into:
    // rewriting it every POLL_MS would delete the operator's half-entered
    // number under the cursor. It also means a change made from the CLI, the
    // TUI or another browser shows up here without a refresh.
    var thrInput = byId('thrVal');
    if (document.activeElement !== thrInput) thrInput.value = thresholdPercentText(s.switchThreshold);
    renderHeader(s);
    renderHero(s);
    renderStatusCard(s);
    var accounts = s.accounts || [];
    // Active as Proxy status counts it: enabled and not blocked.
    var active = accounts.filter(function (a) { return !a.disabled && !a.unavailable; }).length;
    byId('acctCount').textContent = accounts.length ? active + ' of ' + accounts.length + ' active' : '';
    var acc = byId('accounts');
    acc.textContent = '';
    accountDisplayOrder(accounts).forEach(function (i, pos) { acc.appendChild(renderAccount(accounts[i], i, pos, s)); });
    renderProblems(s);
    renderGroups(s);
    renderHistory();
    var hasRoutes = renderRoutes(s);
    var hasClientList = renderClients(s.clients);
    byId('tablesRow').style.display = hasRoutes || hasClientList ? '' : 'none';
    byId('navRouting').style.display = hasRoutes ? '' : 'none';
    byId('navClients').style.display = hasClientList ? '' : 'none';
    var hasDims = renderDimensions(s.usageDimensions);
    // The window control governs the client views and the dimension tables;
    // a fleet with neither has nothing for it to change.
    byId('usageViewWrap').style.display = hasClients(s) || hasDims ? '' : 'none';
    renderSessions(s.sessions);
    renderUserAdmin(s);
    if (settingsFor) renderSettings();
    byId('foot').textContent = 'Refreshes every ' + (POLL_MS / 1000) + 's · last update ' + new Date().toLocaleTimeString();
    syncMsgs();
    movePill();
  }

  // ── Section nav ──────────────────────────────────────────────────────────

  function markNav(id) {
    NAV.forEach(function (n) { byId(n[1]).className = n[0] === id ? 'sel' : ''; });
  }

  // The section nearest the top marks its pill as the page scrolls; the one
  // clicked last wins a tie, and holds while the scroll it started runs.
  function spy() {
    if (!win || Date.now() < navHold) return;
    var h = win.innerHeight || 800;
    var line = h * 0.35;
    var best = 'overview', bestTop = -Infinity, visible = [];
    NAV.forEach(function (n) {
      var e = byId(n[0]);
      if (e.style.display === 'none' || typeof e.getBoundingClientRect !== 'function') return;
      var r = e.getBoundingClientRect();
      if (r.top < h && r.bottom > 0) visible.push(n[0]);
      if (r.top > line) return;
      if (r.top > bestTop + 2) { best = n[0]; bestTop = r.top; }
      else if (Math.abs(r.top - bestTop) <= 2 && n[0] === navPicked) best = n[0];
    });
    // Scrolled as far as it goes, a short last section never reaches the line:
    // the one asked for stands if it is on screen at all.
    var doc = document.documentElement;
    if (win.scrollY + h >= (doc.scrollHeight || 0) - 4 && visible.indexOf(navPicked) !== -1) best = navPicked;
    markNav(best);
  }

  function onScroll() {
    if (spyQueued || !raf) return;
    spyQueued = true;
    raf(function () { spyQueued = false; spy(); });
  }

  // The first status plays the entrance, once. The class comes off before the
  // next poll rebuilds anything, so nothing replays it.
  function showApp() {
    var app = byId('app');
    if (app.style.display === '') return;
    app.style.display = '';
    if (introDone) return;
    introDone = true;
    app.className = 'intro';
    setTimeout(function () { app.className = ''; }, 1800);
  }

  // ── Controls ─────────────────────────────────────────────────────────────

  function note(kind, text) {
    var n = byId('note');
    n.className = kind;
    n.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + text;
    n.style.display = 'flex';
    syncMsgs();
    // An outcome of a change made from the settings dialog is shown in it too:
    // the page note is behind the dialog, where it would not be seen.
    if (settingsFor) {
      settingsNote = { kind: kind, text: text };
      var sn = byId('setNote');
      sn.className = 'set-note ' + kind;
      sn.textContent = text;
      sn.style.display = 'block';
    }
  }

  // One manual switch. The endpoint is a nudge, not a pin: it sets the current
  // account and normal rotation resumes from there (see the handler's comment
  // in server.js for what "eligible" means).
  function doSwitch(name, btn) {
    btn.disabled = true;
    var r = switchRequest(name, localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = switchOutcome(json);
        note(out.kind, out.text);
        // Re-enabled on any non-success, whether the server refused or the
        // fetch threw, so the two failure paths leave the button in one state.
        if (out.kind !== 'ok') btn.disabled = false;
        poll();
      })
      .catch(function (e) { note('error', 'switch failed: ' + e.message); btn.disabled = false; });
  }

  function loginNote(kind, text) {
    var n = byId('loginNote');
    n.className = kind || '';
    n.textContent = text;
  }

  // Asks the server for a sign-in link and opens the dialog on it. Asking
  // again replaces the link: the server keeps the old one until it lapses, but
  // the page only ever offers the newest.
  function doLoginStart(btn) {
    btn.disabled = true;
    var r = loginStartRequest(localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        if (!json.ok) { note('error', 'could not start a sign-in: ' + (json.error || 'unknown error')); return; }
        loginState = json.state;
        byId('loginLink').setAttribute('href', json.url);
        byId('loginCode').value = '';
        var mins = Math.max(1, Math.round((json.expiresAt - Date.now()) / 60000));
        loginNote('', 'The link works for ' + mins + ' minutes. If this browser is signed in to a different Claude account, open it in a private window.');
        byId('loginWrap').style.display = '';
        byId('loginCode').focus();
      })
      .catch(function (e) { note('error', 'could not start a sign-in: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function doLoginFinish(btn) {
    var code = byId('loginCode').value.trim();
    if (!loginState) { loginNote('error', 'there is no sign-in link open; press Add account again'); return; }
    if (!code) { loginNote('error', 'paste the code Claude showed after signing in'); return; }
    btn.disabled = true;
    loginNote('', 'adding…');
    var r = loginFinishRequest(loginState, code, localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = loginOutcome(json);
        if (out.kind !== 'ok') { loginNote('error', out.text); return; }
        closeLogin();
        note('ok', out.text);
        poll();
      })
      .catch(function (e) { loginNote('error', 'adding the account failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function closeLogin() {
    loginState = null;
    byId('loginWrap').style.display = 'none';
    byId('loginCode').value = '';
  }

  function doControlAccount(name, spec, btn) {
    btn.disabled = true;
    var r = accountControlRequest(name, spec, localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = accountControlOutcome(json, spec);
        note(out.kind, out.text);
        poll();
      })
      .catch(function (e) { note('error', 'change failed: ' + e.message); })
      // Unlike doSwitch, always re-enabled: a control that stayed dead after a
      // refused change would be the only one an operator could not retry.
      .finally(function () { btn.disabled = false; });
  }

  // The one control here that writes a setting rather than nudging the running
  // fleet: the server saves it to the config file and reloads, so it holds
  // across a restart. One number governs every quota bucket — a fleet using
  // per-bucket thresholds is told what the save dropped (thresholdOutcome).
  function doThreshold(btn) {
    var input = byId('thrVal');
    var raw = input.value.trim();
    // Left to the server otherwise: an empty field is the one case it would see
    // as a missing key rather than a bad number, and "invalid request body" is
    // not what an operator who cleared the box needs to read.
    if (!raw) { note('error', 'switch threshold: enter a percentage from 1 to 100'); return; }
    btn.disabled = true;
    var r = thresholdRequest(Number(raw), localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = thresholdOutcome(json);
        note(out.kind, out.text);
        // The stored number, not the typed one: the setting is quantised to
        // tenths, and a field left reading 97.55 after a save of 97.6 invites a
        // re-save that changes nothing.
        if (json.ok) input.value = thresholdPercentText(json.switchThreshold);
        poll();
      })
      .catch(function (e) { note('error', 'switch threshold change failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function doControl(path, label, btn) {
    btn.disabled = true;
    fetch(path, { method: 'POST', headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        if (json.ok !== true) { note('error', label + ' failed' + (json.error ? ': ' + json.error : '')); return; }
        note('ok', label + ' complete');
        poll();
      })
      .catch(function (e) { note('error', label + ' failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function showKeybox() {
    if (timer) { clearInterval(timer); timer = null; }
    byId('app').style.display = 'none';
    byId('keybox').style.display = 'block';
    byId('key').focus();
  }

  function poll() {
    fetch('/teamclaude/status', { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        // 403 is the loopback exemption refusing a key-less request (a Host
        // that does not name this machine, e.g. behind a local reverse proxy
        // that adds no forwarding headers). A valid key clears that gate too.
        if (res.status === 401 || res.status === 403) { localStorage.removeItem(KEY); showKeybox(); return null; }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (s) {
        if (!s) return;
        byId('keybox').style.display = 'none';
        showApp();
        byId('err').style.display = 'none';
        setLive(true);
        render(s);
        // The charts' history is only worth asking for when there is a client
        // to chart; the Clients list is what says so.
        if (hasClients(s)) pollSeries();
      })
      .catch(function (e) {
        var err = byId('err');
        err.style.display = 'flex';
        err.textContent = 'Cannot reach the proxy: ' + e.message;
        setLive(false);
        syncMsgs();
        // The banner lives inside #app, which stays hidden until a first
        // status lands; without this a first poll that fails is a blank page.
        if (byId('keybox').style.display !== 'block') showApp();
      });
  }

  function start() {
    poll();
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  byId('go').addEventListener('click', function () {
    var v = byId('key').value.trim();
    if (!v) return;
    localStorage.setItem(KEY, v);
    start();
  });
  byId('key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') byId('go').click();
  });
  // Theme: system → light → dark → system. "system" is the absence of a
  // stored choice, so a viewer who never touches this keeps following their
  // desktop, and one who does is not re-decided for by it later.
  var THEMES = ['system', 'light', 'dark'];
  function readTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch (e) { return 'system'; }
  }
  function applyTheme(theme) {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    // Name the state, not the action: an icon of a moon while the page is
    // light is the ambiguity every theme toggle has, and this one shows where
    // it is rather than where it would go.
    var label = theme === 'system' ? 'Theme: system' : theme === 'light' ? 'Theme: light' : 'Theme: dark';
    var btn = byId('theme');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('data-mode', theme);
  }
  function storeTheme(theme) {
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch (e) { /* storage disabled: the choice lasts for this page only */ }
  }
  // The current theme lives in a variable rather than being re-read from
  // storage on each click: with storage blocked, readTheme() would always say
  // 'system' and the button would be stuck on 'light' instead of cycling.
  var theme = readTheme();
  applyTheme(theme);
  byId('theme').addEventListener('click', function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    storeTheme(theme);
    applyTheme(theme);
  });

  byId('reload').addEventListener('click', function () {
    reloadTurns++;
    byId('reloadIcon').style.transform = 'rotate(' + reloadTurns * 360 + 'deg)';
    doControl('/teamclaude/reload', 'config reload', this);
  });
  byId('probe').addEventListener('click', function () { doControl('/teamclaude/probe', 'quota probe', this); });
  byId('thrSet').addEventListener('click', function () { doThreshold(this); });
  byId('thrVal').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') byId('thrSet').click();
  });
  buildControls();
  NAV.forEach(function (n) {
    byId(n[1]).addEventListener('click', function () {
      navPicked = n[0];
      navHold = Date.now() + 900;
      markNav(n[0]);
    });
  });
  if (win && win.addEventListener) {
    win.addEventListener('resize', movePill);
    win.addEventListener('scroll', onScroll, { passive: true });
  }
  // The pill is measured in the page's own font, which may land after the
  // first status does.
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') document.fonts.ready.then(movePill);
  byId('addAcct').addEventListener('click', function () { doLoginStart(this); });
  buildUserRoleButtons();
  byId('addUser').addEventListener('click', openAddUser);
  byId('userGo').addEventListener('click', function () { doAddUser(this); });
  byId('userNameIn').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') byId('userGo').click();
  });
  byId('userClose').addEventListener('click', closeAddUser);
  byId('userDone').addEventListener('click', closeAddUser);
  byId('userKeyCopy').addEventListener('click', function () {
    copyKey(this, byId('userKey').value, function (t) { userNote('error', t); });
  });
  byId('userWrap').addEventListener('click', function (e) { if (e && e.target === this && !showingUserKey()) closeAddUser(); });
  byId('me').addEventListener('click', openKey);
  byId('keyRotate').addEventListener('click', function () { doRotateKey(this); });
  byId('keyClose').addEventListener('click', closeKey);
  byId('keyDone').addEventListener('click', closeKey);
  byId('keyNewCopy').addEventListener('click', function () {
    copyKey(this, byId('keyNew').value, function (t) { keyNote('error', t); });
  });
  byId('keyWrap').addEventListener('click', function (e) { if (e && e.target === this && !showingNewKey()) closeKey(); });
  byId('loginGo').addEventListener('click', function () { doLoginFinish(this); });
  byId('loginCode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') byId('loginGo').click();
  });
  byId('loginClose').addEventListener('click', closeLogin);
  byId('loginCopy').addEventListener('click', function () {
    var btn = this;
    var href = byId('loginLink').getAttribute('href');
    var failed = function () { loginNote('error', 'could not copy; open the link instead'); };
    try {
      navigator.clipboard.writeText(href).then(function () {
        btn.textContent = 'Copied ✓';
        setTimeout(function () { btn.textContent = 'Copy link'; }, 1500);
      }, failed);
    } catch (e) { failed(); }
  });
  // A click on the dimmed backdrop closes a dialog; one inside it does not.
  byId('loginWrap').addEventListener('click', function (e) { if (e && e.target === this) closeLogin(); });
  byId('settingsWrap').addEventListener('click', function (e) { if (e && e.target === this) closeSettings(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (settingsFor) closeSettings();
    else if (loginState) closeLogin();
    else if (userDialogOpen && !showingUserKey()) closeAddUser();
    else if (keyDialogOpen && !showingNewKey()) closeKey();
  });

  ['fProject', 'fClient'].forEach(function (id) {
    byId(id).addEventListener('change', function () {
      sessionFilters[id === 'fProject' ? 'project' : 'client'] = this.value;
      if (lastStatus) render(lastStatus);
    });
  });

  // Poll before asking: a loopback browser is key-exempt, so the prompt is
  // shown only once the server refuses the request without a valid key.
  start();
})();
</script>
</body>
</html>
`;
